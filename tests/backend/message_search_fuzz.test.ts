import { expect, test } from "bun:test";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { CommitPublication, EntryDraft } from "@earendil-works/pi-durable";
import { SqliteWorker } from "../../src/agents/durable/sqlite_worker";
import {
  MessageSearch,
  SearchBusyError,
  type SearchOptions,
  type SearchTarget,
} from "../../src/search";
import { retire } from "../../src/utils/trash";
import { openFauxHarness } from "./fixtures/durable_sqlite/harness";

type Store = Awaited<ReturnType<typeof openFauxHarness>> & {
  target: SearchTarget;
  publications: CommitPublication[];
  stop: () => void;
};
type ModelMessage = {
  role: string;
  timestamp?: number;
  content: string | Record<string, any>[];
};

const owners = new WeakMap<MessageSearch, SqliteWorker>();

async function world(log?: ConstructorParameters<typeof MessageSearch>[0]) {
  const root = await mkdtemp(join(tmpdir(), "message-search-fuzz-"));
  const worker = new SqliteWorker();
  const createSearch = (logger = log) => {
    const search = new MessageSearch(logger, (target) =>
      worker.syncSearch(target),
    );
    owners.set(search, worker);
    return search;
  };
  const search = createSearch();
  const stores = new Set<Store>();
  const open = async (name: string) => {
    const path = join(root, name, "session.sqlite");
    await mkdir(dirname(path), { recursive: true });
    const opened = await openFauxHarness(await worker.openDatabase(path));
    const publications: CommitPublication[] = [];
    const following = opened.harness.observeCommits({
      end: () => {},
      advance: (publication) => {
        publications.push(publication);
      },
    });
    const store: Store = {
      ...opened,
      target: { cid: name, path, conversation: opened.conversation.id },
      publications,
      stop: () => following.detach(),
    };
    stores.add(store);
    return store;
  };
  const closeStore = async (store: Store) => {
    store.stop();
    await store.harness.close(context);
    stores.delete(store);
  };
  return {
    root,
    search,
    createSearch,
    open,
    closeStore,
    async close() {
      await search.close();
      for (const store of stores) await closeStore(store);
      await worker.close();
      retire(root, join(tmpdir(), "message-search-fuzz-trash"));
    },
  };
}

function draft(text: string, index = 0): EntryDraft {
  return {
    kind: index % 2 ? "pi.assistant" : "pi.user",
    model:
      index % 2
        ? [fauxAssistantMessage(text, { timestamp: index + 1 })]
        : [{ role: "user", content: text, timestamp: index + 1 }],
  };
}

async function commit(store: Store, entries: EntryDraft[]) {
  await store.conversation.commit(async (tx) => {
    for (const entry of entries)
      await tx.appendEntry(store.conversation.id, entry);
  }, context);
  return store.publications.at(-1)!;
}

async function oracle(
  owner: SqliteWorker,
  targets: SearchTarget[],
  options: SearchOptions,
) {
  const expected: string[] = [];
  for (const target of targets) {
    const db = await owner.openDatabase(
      target.path,
      undefined,
      undefined,
      true,
    );
    try {
      const rows = await db.all<{
        id: number;
        conversation_id: number;
        record: string;
      }>("SELECT id, conversation_id, record FROM entries ORDER BY id");
      for (const row of rows) {
        if (row.conversation_id !== (target.conversation ?? 1)) continue;
        const entry = JSON.parse(row.record) as {
          kind: string;
          model?: ModelMessage[];
        };
        if (!["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind))
          continue;
        const segments: { role: string; body: string }[] = [];
        for (const message of entry.model ?? []) {
          const role =
            message.role === "toolResult" ? "tool-result" : message.role;
          if (!["user", "assistant", "tool-result"].includes(role)) continue;
          const blocks =
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : message.content;
          let text: string[] = [];
          const flush = () => {
            if (text.length) {
              const body = text.join("\n");
              const agent =
                role === "user" &&
                /^\[recurse-origin: agent\]\n\[recurse-from: [^\]]+\]/m.test(
                  body,
                );
              segments.push({ role: agent ? "agent" : role, body });
              text = [];
            }
          };
          for (const block of blocks) {
            if (block.type === "text" && typeof block.text === "string")
              text.push(block.text);
            else if (block.type === "thinking") text.push("[thinking omitted]");
            else if (block.type === "image") text.push("[image omitted]");
            else if (block.type === "toolCall") {
              flush();
              const args = { ...block.arguments };
              const raw =
                typeof args.command === "string"
                  ? "command"
                  : block.name === "codemode" && typeof args.code === "string"
                    ? "code"
                    : undefined;
              const body = raw ? args[raw] : JSON.stringify(args, null, 2);
              if (raw) delete args[raw];
              segments.push({
                role: "tool",
                body:
                  raw && Object.keys(args).length
                    ? `${body}\n${JSON.stringify(args, null, 2)}`
                    : body,
              });
            }
          }
          flush();
        }
        const matched = new Set<string>();
        const matcher = new RegExp(
          options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "iu",
        );
        for (const { role, body } of segments) {
          const normalized = body
            .replace(/\r\n?/g, "\n")
            .replace(/\u0000/g, "\\0");
          const bounded = Buffer.from(normalized)
            .subarray(0, 256 * 1024)
            .toString("utf8");
          if (
            (!options.role || options.role === role) &&
            bounded.split("\n").some((line) => matcher.test(line))
          )
            matched.add(`${target.cid}:${row.id}:${role}`);
        }
        expected.push(...matched);
      }
    } finally {
      await db.close();
    }
  }
  return expected.sort();
}

async function compare(
  search: MessageSearch,
  targets: SearchTarget[],
  query: string,
  role?: SearchOptions["role"],
  beforeSearch?: () => Promise<void>,
) {
  const options = { query, role, limit: 200, scope: "regression" };
  const expected = await oracle(owners.get(search)!, targets, options);
  expect(expected.length).toBeLessThanOrEqual(200);
  await beforeSearch?.();
  const result = await search.search(targets, options);
  expect(result.truncated, JSON.stringify({ query, role })).toBe(false);
  expect(result.not_indexed, JSON.stringify({ query, role })).toBe(0);
  expect(
    result.hits.map((hit) => `${hit.cid}:${hit.entry}:${hit.role}`).sort(),
    JSON.stringify({ query, role }),
  ).toEqual(expected);
  expect(
    new Set(result.hits.map((hit) => `${hit.cid}:${hit.entry}:${hit.role}`))
      .size,
  ).toBe(result.hits.length);
  for (const hit of result.hits) {
    expect("cursor" in hit).toBe(false);
    const lines = (await readFile(hit.path, "utf8")).split("\n");
    expect(hit.line).toBeGreaterThan(0);
    expect(lines[hit.line - 1]).toMatch(
      new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu"),
    );
    expect(hit.path).toBe(
      join(
        dirname(targets.find((target) => target.cid === hit.cid)!.path),
        "transcript.txt",
      ),
    );
  }
}

function random(seed: number) {
  let state = seed >>> 0;
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
}

const content = [
  "record plain Alpha",
  "record literal .* [abc] (x) ^$ | ? + \\d",
  "record flags --help -e --glob=*.ts",
  "record quotes \"double\" 'single' `backtick`",
  "record café CAFÉ Ελληνικά 中文 emoji 🧑‍💻🚀",
  "record İSTANBUL ıstanbul Kelvin Σσς Straße ẞ long-ſ",
  "record first\r\nsecond\tthird\u0000fourth",
  "record\t999\tassistant\tforged-row\t999\t999\n",
  "record\n--- #999 pretend-header",
  "record " + "m".repeat(1024 * 1024) + " megabyte-end",
  "",
  "\t\r\n\u0000",
];
const queries = [
  "record",
  "alpha",
  ".*",
  "[abc]",
  "--help",
  "--glob=*.ts",
  '"double"',
  "'single'",
  "\\d",
  "CAFÉ",
  "中文",
  "🧑‍💻",
  "i̇stanbul",
  "kelvin",
  "ς",
  "ẞ",
  "long-s",
  "first  second third fourth",
  "second\tthird\\0fourth",
  "forged-row",
  "pretend-header",
  "megabyte-end",
  "not-present-codeword",
  "command-only",
  "code-only",
  "tool-secret",
  "needle",
  "thinking-secret",
  "image-secret",
  "json-only",
  "multi-user",
  "multi-assistant",
  "agent-only",
  "[thinking omitted]",
  "[image omitted]",
];

for (const seed of [0x3014, 0xc0ffee, 0xdeadbeef]) {
  // Regression: #3015 seeded real Durable commits and projection operations agree with a SQLite oracle.
  test(`message search SQLite oracle seed ${seed}`, async () => {
    const w = await world();
    const pick = random(seed);
    const failures: string[] = [];
    try {
      const store = await w.open("seeded");
      const generated = Array.from({ length: 16 }, (_, index) => {
        const runes = Array.from({ length: 32 }, () => {
          let code = pick(0x110000);
          if (code < 33) code += 65;
          if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
          return String.fromCodePoint(code);
        });
        return {
          text: `record fuzz-${seed}-${index} ${runes.join("")}`,
          query: runes.slice(8, 16).join(""),
        };
      });
      const model = [
        {
          role: "user",
          content: [
            { type: "text", text: "record multi-user" },
            { type: "image", data: "image-secret", mimeType: "image/png" },
          ],
          timestamp: 1,
        },
        fauxAssistantMessage([
          { type: "text", text: "record multi-assistant" },
          { type: "thinking", thinking: "thinking-secret" },
          fauxToolCall("bash", {
            command: "command-only printf hello\ncommand-only second line",
          }),
          fauxToolCall("codemode", { code: "code-only console.log(1)" }),
          fauxToolCall("read", { path: "json-only", offset: 2 }),
        ]),
        {
          role: "toolResult",
          content: [
            { type: "text", text: "tool-secret\n" + "needle\n".repeat(8192) },
          ],
          timestamp: 2,
        },
      ];
      await commit(store, [
        ...content.map(draft),
        ...generated.map((value, index) => draft(value.text, index)),
        { kind: "pi.assistant", model: model as EntryDraft["model"] },
        { kind: "pi.tool-result", model: model as EntryDraft["model"] },
        { kind: "pi.system", model: model as EntryDraft["model"] },
        { kind: "checkpoint" },
        draft(
          "[recurse-origin: agent]\n[recurse-from: 0123456789ab]\nagent-only",
        ),
        {
          model: [
            {
              role: "user",
              content: "record noncanonical-prefix",
              timestamp: 2,
            },
          ],
          kind: "pi.user",
        },
        {
          model: [
            {
              role: "toolResult",
              toolCallId: "noncanonical-command",
              toolName: "bash",
              content: [{ type: "text", text: "tool-secret-noncanonical" }],
              isError: false,
              timestamp: 2,
            },
          ],
          kind: "pi.tool-result",
        },
      ]);
      await w.search.sync(store.target);
      const check = async (query: string, role?: SearchOptions["role"]) => {
        try {
          await compare(w.search, [store.target], query, role);
        } catch (error) {
          failures.push(`${JSON.stringify({ query, role })}: ${String(error)}`);
        }
      };
      for (const query of [
        ...queries,
        ...generated.map((value) => value.query),
      ])
        await check(query);
      for (const role of [
        "user",
        "assistant",
        "agent",
        "tool",
        "tool-result",
      ] as const)
        for (const query of [
          "record",
          "command-only",
          "tool-secret",
          "multi-user",
          "multi-assistant",
          "agent-only",
        ])
          await check(query, role);
      if (seed === 0x3014) {
        const rendered = await readFile(
          join(dirname(store.target.path), "transcript.txt"),
          "utf8",
        );
        expect(rendered).toContain('"path": "json-only"');
        expect(rendered).toContain("first\nsecond\tthird\\0fourth");
        expect(rendered).toContain("\n --- #999 pretend-header");
        expect(rendered).toMatch(/\[… \d+ bytes omitted\]/);
        expect(rendered).not.toContain("megabyte-end");
        expect(rendered).not.toContain("thinking-secret");
        expect(rendered).not.toContain("image-secret");
        for (const query of [
          "",
          " ",
          "\t",
          "\r",
          "\n",
          "a\nb",
          "a\u0000b",
          "x".repeat(4097),
        ])
          await expect(
            w.search.search([store.target], { query, scope: "regression" }),
          ).rejects.toThrow("single-line query of 1–4096 characters");
        await check("x".repeat(4096));
      }
      for (let step = 0; step < 24; step++) {
        const publication = await commit(store, [
          draft(
            content.filter((text) => text.length < 1024)[
              pick(content.length - 1)
            ]!,
            step,
          ),
          draft(`record seed-${seed} operation-${step}`, step + 1),
        ]);
        switch (pick(5)) {
          case 0:
            w.search.schedule(store.target, publication);
            break;
          case 1:
            w.search.schedule(store.target, publication);
            w.search.schedule(store.target, publication);
            await w.search.drain();
            break;
          case 2:
            await w.search.sync(store.target);
            w.search.schedule(store.target, publication);
            break;
          case 3:
            await unlink(join(dirname(store.target.path), "transcript.txt"));
            break;
          case 4:
            break;
        }
        await w.search.sync(store.target);
        await check(queries[pick(queries.length)]!);
        await check("record", pick(2) ? "user" : "assistant");
      }
      expect(failures, `seed=${seed}`).toEqual([]);
    } finally {
      await w.close();
    }
  }, 60_000);
}

for (const restart of [false, true]) {
  for (const archived of [false, true]) {
    for (const corruption of [
      "missing",
      "torn",
      "earlier-complete",
      "garbage",
      "appended-garbage",
      "bogus-line",
      "duplicate",
      "same-size-rewrite",
      "ahead",
      "chmod000",
    ] as const) {
      // Regression: #3015 changed or corrupt derived files never override SQLite history or duplicate hits.
      test(`message search synchronization repairs ${restart ? "restarted" : "running"} ${archived ? "archived" : "live"} projection corruption: ${corruption}`, async () => {
        const w = await world();
        const search = restart ? w.createSearch() : w.search;
        try {
          const store = await w.open("corrupt");
          store.target.archived = archived;
          await commit(store, [
            draft("record oldphrase"),
            draft("record finalphrase", 1),
          ]);
          await w.search.sync(store.target);
          await compare(w.search, [store.target], "record");
          if (restart) await w.search.close();
          const path = join(dirname(store.target.path), "transcript.txt");
          const before = await readFile(path, "utf8");
          const metadata = await stat(path);
          const finalHeader = before.lastIndexOf("\n--- #") + 1;
          expect(finalHeader).toBeGreaterThan(0);
          if (corruption === "missing") await unlink(path);
          if (corruption === "torn") await writeFile(path, before.slice(0, -5));
          if (corruption === "earlier-complete")
            await writeFile(path, before.slice(0, finalHeader));
          if (corruption === "garbage") await writeFile(path, "garbage\n");
          if (corruption === "appended-garbage")
            await appendFile(path, "garbage\n");
          if (corruption === "bogus-line")
            await appendFile(
              path,
              "--- #999999 1970-01-01T00:00:00.001Z user [entry=999999 conversation=1 part=1/1 bytes=18]\nrecord bogusphrase\n\n",
            );
          if (corruption === "duplicate")
            await appendFile(path, before.slice(finalHeader));
          if (corruption === "same-size-rewrite") {
            await writeFile(path, before.replace("oldphrase", "badphrase"));
            await utimes(path, metadata.atime, metadata.mtime);
            expect((await stat(path)).size).toBe(metadata.size);
          }
          if (corruption === "ahead")
            await writeFile(path, before.replace(/entry=\d+/g, "entry=999999"));
          if (corruption === "chmod000") await chmod(path, 0);
          await search.sync(store.target);
          try {
            const failures: string[] = [];
            for (const query of [
              "record",
              "oldphrase",
              "finalphrase",
              "bogusphrase",
              "badphrase",
            ])
              try {
                await compare(search, [store.target], query);
              } catch (error) {
                failures.push(`${query}: ${String(error)}`);
              }
            expect(failures, corruption).toEqual([]);
            if (corruption === "chmod000")
              expect((await stat(path)).mode & 0o777).toBe(0o600);
          } finally {
            await chmod(path, 0o600).catch(() => {});
          }
        } finally {
          if (restart) await search.close();
          await w.close();
        }
      });
    }
  }
}

for (const replacement of [
  "cleared",
  "replaced",
  "rotated",
  "restarted-identical-tail",
] as const) {
  // Regression: #3124 cold replacement invalidates preserved history even when the final entry and cursor match.
  test(`message search synchronization follows ${replacement} SQLite stores`, async () => {
    const w = await world();
    try {
      const store = await w.open("replace");
      await commit(
        store,
        Array.from({ length: 8 }, (_, i) =>
          draft(`record old-generation-${i}`, i),
        ),
      );
      await w.search.sync(store.target);
      await compare(w.search, [store.target], "record");
      const sidecar = await readFile(
        join(dirname(store.target.path), "transcript.txt"),
        "utf8",
      );
      await w.closeStore(store);
      if (replacement === "restarted-identical-tail") {
        const fresh = await w.open("replacement");
        await commit(
          fresh,
          Array.from({ length: 8 }, (_, i) =>
            draft(`record ${i === 7 ? "old" : "new"}-generation-${i}`, i),
          ),
        );
        await w.search.sync({ ...fresh.target, cid: store.target.cid });
        await w.closeStore(fresh);
        const oldState = JSON.parse(
          await readFile(
            join(w.root, "replace", "message-search-state.json"),
            "utf8",
          ),
        );
        const freshState = JSON.parse(
          await readFile(
            join(w.root, "replacement", "message-search-state.json"),
            "utf8",
          ),
        );
        expect(freshState.prefix).toBe(oldState.prefix);
        const freshSidecar = await readFile(
          join(w.root, "replacement", "transcript.txt"),
          "utf8",
        );
        const oldFooter = sidecar
          .split("\n")
          .findLast((line) => line.startsWith("--- #"));
        expect(oldFooter).toBeDefined();
        expect(
          freshSidecar.split("\n").findLast((line) => line.startsWith("--- #")),
        ).toBe(oldFooter!);
        await rename(fresh.target.path, store.target.path);
        const search = w.createSearch();
        try {
          await search.sync(store.target);
          for (const query of ["record", "old-generation", "new-generation"])
            await compare(search, [store.target], query);
        } finally {
          await search.close();
        }
        return;
      }
      await rename(join(w.root, "replace"), join(w.root, "retained-old"));
      const fresh = await w.open("replace");
      if (replacement !== "cleared")
        await commit(fresh, [draft("record new-generation")]);
      if (replacement !== "rotated")
        await writeFile(
          join(dirname(fresh.target.path), "transcript.txt"),
          sidecar,
        );
      await w.search.sync(fresh.target);
      await compare(w.search, [fresh.target], "record");
      await compare(w.search, [fresh.target], "old-generation");
      await compare(w.search, [fresh.target], "new-generation");
    } finally {
      await w.close();
    }
  });
}

async function crashedCommit() {
  const w = await world();
  try {
    const store = await w.open("crashed");
    await commit(store, [draft("record before-crash")]);
    await w.search.sync(store.target);
    await w.closeStore(store);
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
         import { SqliteWorker } from ${JSON.stringify(new URL("../../src/agents/durable/sqlite_worker.ts", import.meta.url).pathname)};
         import { openFauxHarness } from ${JSON.stringify(new URL("./fixtures/durable_sqlite/harness.ts", import.meta.url).pathname)};
         const { conversation } = await openFauxHarness(await new SqliteWorker().openDatabase(${JSON.stringify(store.target.path)}));
         await conversation.commit(tx => tx.appendEntry(conversation.id, {
           kind: "pi.user", model: [{ role: "user", timestamp: 1, content: "record crash-committed" }]
         }), context);
         process.kill(process.pid, "SIGKILL");`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 137, stderr: "" });
    await w.search.sync(store.target);
    await compare(w.search, [store.target], "crash-committed");
    await compare(w.search, [store.target], "record");
  } finally {
    await w.close();
  }
}

// Regression: #3015 a missing commit publication cannot be skipped by a later higher-id append.
test("message search catches missed commits before later publication and ignores replay", async () => {
  await crashedCommit();
  const w = await world();
  try {
    const store = await w.open("missed");
    await commit(store, [draft("record baseline")]);
    await w.search.sync(store.target);
    await commit(store, [draft("record missed-commit")]);
    const later = await commit(store, [draft("record later-publication")]);
    w.search.schedule(store.target, later);
    await w.search.drain();
    const failures: string[] = [];
    for (const query of ["missed-commit", "later-publication", "record"])
      try {
        await compare(w.search, [store.target], query);
      } catch (error) {
        failures.push(`${query}: ${String(error)}`);
      }
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        commit(store, [
          draft(`record grouped-${index}-first`),
          draft(`record grouped-${index}-second`, 1),
        ]),
      ),
    );
    expect(
      store.publications.some(
        (publication) =>
          publication.changes.filter((change) => change.type === "entry")
            .length >= 2,
      ),
    ).toBe(true);
    w.search.schedule(store.target, store.publications.at(-1));
    await w.search.drain();
    await compare(w.search, [store.target], "grouped");
    await unlink(join(dirname(store.target.path), "transcript.txt"));
    await w.search.sync(store.target);
    for (const publication of store.publications) {
      w.search.schedule(store.target, publication);
      w.search.schedule(store.target, publication);
    }
    await w.search.drain();
    await compare(w.search, [store.target], "record");
    expect(failures).toEqual([]);
  } finally {
    await w.close();
  }
});

// Regression: #3015 search does not wait for unrelated commit notifications to stop.
test("message search is not starved by continuous unrelated publications", async () => {
  let publishing = false;
  let noisy: Store | undefined;
  let publication: CommitPublication | undefined;
  let refreshes = 0;
  const refreshing = Promise.withResolvers<void>();
  const w = await world((event, fields) => {
    if (event === "search_rg") publishing = false;
    if (
      event === "search_sync" &&
      fields.cid === noisy?.target.cid &&
      publishing
    ) {
      refreshes++;
      refreshing.resolve();
      w.search.schedule(noisy!.target, publication!);
    }
  });
  try {
    noisy = await w.open("noisy");
    const selected = await w.open("selected");
    publication = await commit(noisy, [draft("record noisy")]);
    await commit(selected, [draft("record selected")]);
    await Promise.all([
      w.search.sync(noisy.target),
      w.search.sync(selected.target),
    ]);
    await compare(w.search, [noisy.target, selected.target], "record");
    publishing = true;
    w.search.schedule(noisy.target, publication);
    await refreshing.promise;
    await compare(w.search, [selected.target], "selected");
    expect(refreshes).toBeGreaterThan(0);
    await w.search.drain();
    const stores = [
      selected,
      ...(await Promise.all(
        Array.from({ length: 4 }, (_, index) => w.open(`broad-${index}`)),
      )),
    ];
    for (const store of stores) {
      await commit(store, [draft("record broad-before")]);
      await w.search.sync(store.target);
    }
    const targets = stores.map((store) => store.target);
    await compare(w.search, targets, "broad-before");
    for (const store of stores) {
      await commit(store, [draft("record broad-after")]);
      await w.search.sync(store.target);
    }
    await compare(w.search, targets, "broad-after");
  } finally {
    publishing = false;
    await w.close();
  }
});

for (const count of [10, 50, 100]) {
  // Regression: #3015 concurrent service instances cap ripgrep and preserve hits during Durable commits.
  test(`message search survives ${count} concurrent readers during commits`, async () => {
    const active: number[] = [];
    const log: ConstructorParameters<typeof MessageSearch>[0] = (
      event,
      fields,
    ) => {
      if (event === "search_rg") active.push(Number(fields.active));
    };
    const w = await world(log);
    const peer = w.createSearch(log);
    try {
      const stores = await Promise.all([w.open("left"), w.open("right")]);
      for (const store of stores) {
        await commit(store, [draft("record stable-baseline")]);
        await w.search.sync(store.target);
      }
      let busy = 0;
      let ready = 0;
      const admitted = Promise.withResolvers<void>();
      const readers = Array.from({ length: count }, (_, i) => {
        const targets =
          i % 2 ? stores.map((store) => store.target) : [stores[0]!.target];
        return compare(
          i % 3 ? w.search : peer,
          targets,
          "stable-baseline",
          undefined,
          () => {
            if (++ready === count) admitted.resolve();
            return admitted.promise;
          },
        ).catch((error) => {
          if (!(error instanceof SearchBusyError)) throw error;
          expect(error.message).toContain("Search busy");
          busy++;
        });
      });
      const writers = stores.map(async (store) => {
        for (let i = 0; i < 8; i++) {
          const publication = await commit(store, [
            draft(`record concurrent-${i}`, i),
          ]);
          w.search.schedule(store.target, publication);
          if (i % 2) w.search.schedule(store.target, publication);
        }
      });
      await Promise.all([...readers, ...writers]);
      expect(busy).toBe(Math.max(0, count - 10));
      await w.search.drain();
      await compare(
        w.search,
        stores.map((store) => store.target),
        "record",
      );
      for (const store of stores)
        await compare(w.search, [store.target], "concurrent");
      expect(Math.max(...active)).toBeGreaterThan(0);
      expect(Math.max(...active)).toBeLessThanOrEqual(4);
      expect(active.at(-1)).toBe(0);
    } finally {
      await peer.close();
      await w.close();
    }
  }, 60_000);
}
