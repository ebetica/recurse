import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  normalizeContext,
  type Message,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  createRegistry,
  Harness,
  UsageDoc,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import {
  importPiSession,
  type PiImportOptions,
} from "../../src/agents/durable/import_pi_session";
import { EnvironmentDoc } from "../../src/extensions/core/environment/managed_tools";
import { ReplyTimesDoc } from "../../src/agents/durable/reply_times";
import { WARNING } from "../../src/observability/runtime_logging";
const { safetyReviewOff } = (await import(
  new URL("../../src/extensions/core/safety/durable.ts", import.meta.url).href
)) as {
  safetyReviewOff: (
    harness: Harness,
    conversation: Awaited<ReturnType<Harness["root"]>>,
    ctx: typeof context,
  ) => Promise<boolean>;
};
import { DurableRows } from "../../src/agents/durable/durable_rows";
import {
  openWorkerSqliteStorage,
  SqliteWorker,
} from "../../src/agents/durable/sqlite_worker";
import { ConversationView } from "../../src/agents/view/conversation";
import {
  applyBatch,
  readBatch,
  ViewEntry,
  window,
} from "../../src/agents/view/reader";

type Rec = Record<string, any>;
const root = await mkdtemp(join(tmpdir(), "pi-import-"));
const models = createModels();
for (const provider of builtinProviders()) models.setProvider(provider);
const worker = new SqliteWorker();
afterAll(async () => {
  worker.close();
  await rm(root, { recursive: true, force: true });
});
const recorded = JSON.parse(
  await readFile(
    join(import.meta.dir, "fixtures/durable_rows/recorded.json"),
    "utf8",
  ),
) as { entries: EntryRecord[] };

function fixture(): SessionEntry[] {
  const out: Rec[] = [];
  let parentId: string | null = null;
  let tokens = 0;
  for (const entry of recorded.entries) {
    const id = `e${entry.id}`;
    const message = entry.model?.[0] as Rec | undefined;
    const timestamp = new Date(
      (message?.timestamp ?? 0) + (message?.role === "assistant" ? 8068 : 0),
    ).toISOString();
    if (entry.kind === "pi.compaction") {
      const text = message!.content[0].text as string;
      const pointId = `e${entry.head}`;
      out.push(
        {
          type: "compaction",
          id,
          parentId,
          timestamp,
          summary: text.slice(
            "The conversation history before this point was compacted into the following summary:\n\n<summary>\n"
              .length,
            -"\n</summary>".length,
          ),
          firstKeptEntryId: pointId,
          tokensBefore: tokens,
        },
        {
          type: "custom_message",
          id: `${id}n`,
          parentId: id,
          timestamp,
          customType: "recurse.compaction-notice",
          display: true,
          content: "Context compacted at 2k tokens.",
          details: { pointId },
        },
      );
      parentId = `${id}n`;
    } else if (message) {
      out.push({ type: "message", id, parentId, timestamp, message });
      parentId = id;
      if (message.role === "assistant") tokens = message.usage.totalTokens;
    }
  }
  return out as SessionEntry[];
}

async function setup(
  name: string,
  entries = fixture(),
): Promise<PiImportOptions> {
  const sessionFile = join(root, `${name}.jsonl`);
  await writeFile(
    sessionFile,
    [
      { type: "session", version: 3, id: "pi", cwd: root, timestamp: "" },
      ...entries,
    ]
      .map((entry) => JSON.stringify(entry) + "\n")
      .join(""),
  );
  return {
    conversationId: name,
    sessionId: "pi",
    sessionFile,
    destination: join(root, name, "durable"),
    trashDir: join(root, "trash"),
    models,
    worker,
    settings: {
      model: { provider: "anthropic", modelId: "claude-sonnet-5" },
      thinkingLevel: "high",
      cwd: root,
      environment: { IMPORT_TEST: "kept" },
      safetyOff: false,
    },
    state: () => ({ running: false, queued: 0 }),
    log: () => {},
  };
}

async function opened(options: PiImportOptions) {
  const harness = await Harness.open(
    await openWorkerSqliteStorage(
      worker,
      join(options.destination, "session.sqlite"),
    ),
    { models, registry: createRegistry() },
    context,
  );
  return { harness, conversation: await harness.root(context) };
}
const absent = (path: string) =>
  stat(path).then(
    () => false,
    (error) => {
      if (error.code === "ENOENT") return true;
      throw error;
    },
  );

function shape(rows: Rec[]): Rec[] {
  const at = new Map(rows.map((row, index) => [row.id, index]));
  return rows.map(
    ({
      id: _id,
      offset: _o,
      order: _r,
      call_id: _c,
      artifact_id: _a,
      ...row
    }) => {
      if (!row.meta) return row;
      const meta = { ...row.meta };
      for (const key of ["firstKeptEntryId", "summaryEntryId", "jumpEntryId"])
        if (key in meta) meta[key] = at.get(meta[key]) ?? "missing";
      return { ...row, meta };
    },
  );
}

function bound(messages: readonly Message[]) {
  return transformMessages(
    normalizeContext({ messages: [...messages] }).messages,
    models.getModel("anthropic", "claude-sonnet-5")!,
  ).map(({ timestamp: _timestamp, ...message }) => message);
}

test("recorded active branch preserves model context, /view rows, settings and usage", async () => {
  const source = fixture();
  const abandoned = { ...source[0]!, id: "abandoned", parentId: null };
  const options = await setup("parity", [
    ...source.slice(0, -1),
    abandoned,
    source.at(-1)!,
  ]);
  const bytes = await readFile(options.sessionFile);
  expect(await importPiSession(options)).toEqual({
    status: "imported",
    entries: source.length,
  });
  const { harness, conversation } = await opened(options);
  try {
    const expected = bound(convertToLlm(buildSessionContext(source).messages));
    const baseline = expected.findIndex((message) => message.role === "system");
    expect(baseline).toBeGreaterThan(0);
    const [system] = expected.splice(baseline, 1);
    expect(bound((await conversation.context(context)).messages)).toEqual([
      system,
      ...expected,
    ]);
    const agent = await conversation.agent(context);
    expect([agent.model, agent.thinkingLevel, agent.cwd]).toEqual([
      options.settings.model,
      "high",
      root,
    ]);
    expect(
      (await harness.snapshot(EnvironmentDoc, conversation.id, context))
        ?.overrides,
    ).toEqual({ IMPORT_TEST: "kept" });
    const usage = await harness.snapshot(UsageDoc, conversation.id, context);
    const spent = recorded.entries
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "assistant") as Rec[];
    const total = usage!.models["anthropic/claude-sonnet-5"]!;
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
      "reasoning",
      "cacheWrite1h",
    ])
      expect((total as Rec)[key]).toBe(
        spent.reduce((sum, message) => sum + (message.usage[key] ?? 0), 0),
      );
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"])
      expect((total.cost as Rec)[key]).toBe(
        spent.reduce((sum, message) => sum + message.usage.cost[key], 0),
      );
    expect(await safetyReviewOff(harness, conversation, context)).toBe(false);
    const times = await harness.snapshot(
      ReplyTimesDoc,
      conversation.id,
      context,
    );
    for (const message of spent)
      expect(times?.finished[String(message.timestamp)]).toBe(
        message.timestamp + 8068,
      );
    const inputs = {
      cid: "parity",
      sessionId: "pi",
      sessionFile: options.sessionFile,
      sessionCwd: root,
      live: "[]",
      envelope: "{}",
      files: "{}",
      maxSessionBytes: 1 << 30,
    };
    const pi = new ViewEntry(new ConversationView("parity", ""));
    const batch = await readBatch(inputs, pi.feed);
    applyBatch(pi, pi.instanceId, batch);
    const rows = await new DurableRows("parity").page(
      conversation,
      context,
      undefined,
      {},
      { limit: 100 },
    );
    expect(shape(rows.blocks as Rec[])).toEqual(
      shape(window(pi, inputs, { caughtUp: true, limit: 100 }).blocks as Rec[]),
    );
  } finally {
    await harness.close(context);
  }
  expect(await importPiSession(options)).toEqual({
    status: "already-imported",
    entries: source.length,
  });
  expect(await readFile(options.sessionFile)).toEqual(bytes);
});

test("a selected orphan-tool leaf stores Pi's synthesized result without adding a UI row", async () => {
  const source = fixture();
  const options = await setup("branch", source);
  options.leafId = source.find(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  )!.id;
  const bytes = await readFile(options.sessionFile);
  expect((await importPiSession(options)).status).toBe("imported");
  const { harness, conversation } = await opened(options);
  try {
    const selected = source.slice(
      0,
      source.findIndex((entry) => entry.id === options.leafId) + 1,
    );
    const [user, system, ...rest] = bound(
      convertToLlm(buildSessionContext(selected).messages),
    );
    expect([user?.role, system?.role]).toEqual(["user", "system"]);
    expect(bound((await conversation.context(context)).messages)).toEqual([
      system,
      user,
      ...rest,
    ]);
    const entries = await conversation.entries({}, 100, undefined, context);
    const synthetic = entries.items.find(
      (entry) => entry.kind === "recurse.pi-synthetic",
    );
    expect(synthetic?.model?.[0]).toMatchObject({
      role: "toolResult",
      isError: true,
      content: [{ type: "text", text: "No result provided" }],
    });
    const rows = await new DurableRows("branch").page(
      conversation,
      context,
      undefined,
      {},
      { limit: 100 },
    );
    expect(
      (rows.blocks as Rec[]).some(
        (row: Rec) => row.id === String(synthetic!.id),
      ),
    ).toBe(false);
  } finally {
    await harness.close(context);
  }
  expect(await readFile(options.sessionFile)).toEqual(bytes);
});

test("busy, queued and changed sources defer, leave Pi unchanged, and retry when idle", async () => {
  for (const kind of ["running", "queued", "changed", "rewritten"]) {
    const source = fixture();
    const options = await setup(kind, source);
    const before = await readFile(options.sessionFile, "utf8");
    const changed = kind === "changed" || kind === "rewritten";
    const after =
      kind === "rewritten" ? before.replace("alpha", "bravo") : before + "\n";
    if (kind === "rewritten") {
      expect(after.length).toBe(before.length);
      expect(after).not.toBe(before);
    }
    let calls = 0;
    options.state = async () => {
      if (changed && calls++ > 0) await writeFile(options.sessionFile, after);
      return { running: kind === "running", queued: kind === "queued" ? 1 : 0 };
    };
    expect((await importPiSession(options)).status).toBe("deferred");
    expect(await absent(options.destination)).toBe(true);
    expect(await absent(`${options.destination}.import`)).toBe(true);
    expect(await readFile(options.sessionFile, "utf8")).toEqual(
      changed ? after : before,
    );
    if (changed) await writeFile(options.sessionFile, before);
    options.state = () => ({ running: false, queued: 0 });
    expect((await importPiSession(options)).status).toBe("imported");
  }
});

test("LF-only large/image lines, system messages and context omissions retain SDK semantics", async () => {
  const timestamp = "2026-10-07T00:00:00.000Z";
  const source = [
    {
      type: "message",
      id: "system",
      parentId: null,
      timestamp,
      message: {
        role: "system",
        content: "Import system fixture",
        timestamp: 0,
      },
    },
    {
      type: "message",
      id: "image",
      parentId: "system",
      timestamp,
      message: {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "x".repeat(2706390) },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
          },
        ],
      },
    },
    {
      type: "message",
      id: "omit",
      parentId: "image",
      timestamp,
      message: { role: "user", content: "Omitted test content", timestamp: 0 },
    },
    {
      type: "context_edit",
      id: "edit",
      parentId: "omit",
      timestamp,
      targetId: "omit",
      replacement: null,
    },
  ] as SessionEntry[];
  const options = await setup("shapes", source);
  await writeFile(
    options.sessionFile,
    (await readFile(options.sessionFile, "utf8")).replaceAll(
      ',"parentId":',
      ',\r"parentId":',
    ),
  );
  const bytes = await readFile(options.sessionFile);
  options.settings.safetyOff = true;
  expect(await importPiSession(options)).toEqual({
    status: "imported",
    entries: 4,
  });
  const { harness, conversation } = await opened(options);
  try {
    expect(bound((await conversation.context(context)).messages)).toEqual(
      bound(convertToLlm(buildSessionContext(source).messages)),
    );
    expect(await safetyReviewOff(harness, conversation, context)).toBe(true);
    expect(
      (await conversation.entries({}, 100, undefined, context)).items,
    ).toHaveLength(4);
  } finally {
    await harness.close(context);
  }
  expect(await readFile(options.sessionFile)).toEqual(bytes);
});

function toolSession(results: Rec[], callIds = ["c"]): SessionEntry[] {
  const timestamp = "2026-10-07T00:00:00.000Z";
  const calls = callIds.map((id) => ({
    type: "toolCall",
    id,
    name: "read",
    arguments: {},
  }));
  const messages = [
    { role: "user", content: "Fix it", timestamp: 0 },
    { role: "assistant", content: calls, stopReason: "toolUse", timestamp: 0 },
    ...results.map((r) => ({ role: "toolResult", content: "read ok", ...r })),
    {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      stopReason: "stop",
      timestamp: 0,
    },
  ];
  return messages.map((message, index) => ({
    type: "message",
    id: `m${index}`,
    parentId: index ? `m${index - 1}` : null,
    timestamp,
    message,
  })) as unknown as SessionEntry[];
}

const matching = { toolCallId: "c", toolName: "read" };
const second = { toolCallId: "d", toolName: "read" };
for (const [name, results, counts, calls] of [
  ["a missing id", [{}], [1, 0, 0, false]],
  ["an unknown id", [{ toolCallId: "zz", toolName: "read" }], [0, 1, 0, false]],
  ["a duplicate", [matching, matching], [0, 0, 1, false]],
  ["a missing id before a match", [{}, matching], [1, 0, 0, false]],
  [
    "results out of call order",
    [second, matching],
    [0, 0, 0, true],
    ["c", "d"],
  ],
] as const)
  test(`a tool result with ${name} imports, warns, and keeps its row`, async () => {
    const source = toolSession([...results], calls ? [...calls] : undefined);
    const cid = `repair-${name.replaceAll(" ", "-")}`;
    const options = await setup(cid, source);
    const warnings: Rec[] = [];
    options.log = (event, fields, level) => {
      if (event === "durable_import_repaired_tool_results")
        warnings.push({ ...fields, level });
    };
    expect(await importPiSession(options)).toEqual({
      status: "imported",
      entries: source.length,
    });
    const [missing_id, unknown_id, duplicate, reordered] = counts;
    expect(warnings).toEqual([
      { cid, missing_id, unknown_id, duplicate, reordered, level: WARNING },
    ]);
    const { harness, conversation } = await opened(options);
    try {
      const roles = bound((await conversation.context(context)).messages).map(
        (m: Rec) => [m.role, m.toolCallId],
      );
      expect(roles).toEqual([
        ["user", undefined],
        ["assistant", undefined],
        ...(calls ?? ["c"]).map((id) => ["toolResult", id]),
        ["assistant", undefined],
      ]);
      const stored = (
        await conversation.entries({}, 100, undefined, context)
      ).items
        .filter((entry) => entry.kind === "pi.tool-result")
        .reverse();
      expect(stored.map((entry) => entry.model)).toEqual(
        source.slice(2, -1).map((entry: Rec) => [entry.message]),
      );
      const inputs = {
        cid,
        sessionId: "pi",
        sessionFile: options.sessionFile,
        sessionCwd: root,
        live: "[]",
        envelope: "{}",
        files: "{}",
        maxSessionBytes: 1 << 30,
      };
      const pi = new ViewEntry(new ConversationView(cid, ""));
      applyBatch(pi, pi.instanceId, await readBatch(inputs, pi.feed));
      const rows = await new DurableRows(cid).page(
        conversation,
        context,
        undefined,
        {},
        { limit: 100 },
      );
      expect(shape(rows.blocks as Rec[])).toEqual(
        shape(
          window(pi, inputs, { caughtUp: true, limit: 100 }).blocks as Rec[],
        ),
      );
    } finally {
      await harness.close(context);
    }
  });
