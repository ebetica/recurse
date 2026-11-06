import type { Subprocess } from "bun";
import { expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  appendFile,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication } from "@earendil-works/pi-durable";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import { buildApp, WebLogSink } from "../../src/web/app";
import { backfillMessageSearch } from "../../src/search/backfill";
import { MessageSearch } from "../../src/search";
import { selectSearchTargets } from "../../src/search/targets";
import { until } from "./fixtures/durable_host/host";
import { seedPiModelList } from "./pi_model_list_fixture";
import { appWorld } from "./web_app_support";

interface Results {
  hits: {
    agent: string;
    cid: string;
    role: string;
    entry: number;
    time: number;
    snippet: string;
    path: string;
    line: number;
  }[];
  truncated: boolean;
  not_indexed: number;
}

// Feature: #3014 search finds conversational text and commands across live trees and retained deletion.
test("message search follows commits and reads retained history without revival", async () => {
  const { root, env } = appWorld({ password: true });
  seedPiModelList(join(root, "data", "config"));
  const activity: number[] = [];
  const stalls: string[] = [];
  let blockNextSync = false;
  class SearchLog extends WebLogSink {
    override write(record: Parameters<WebLogSink["write"]>[0]): void {
      const active = /event=search_rg active=(\d+)/.exec(record.message);
      if (active) activity.push(Number(active[1]));
      if (record.message.startsWith("event=event_loop_stall "))
        stalls.push(record.message);
      if (blockNextSync && record.message.startsWith("event=search_sync ")) {
        blockNextSync = false;
        const until = performance.now() + 400;
        while (performance.now() < until) {}
      }
      super.write(record);
    }
  }
  const app = await buildApp({ env, sink: new SearchLog(() => {}) });
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  faux.setResponses([
    fauxAssistantMessage(
      [
        { type: "text", text: "search-preface\nsearch-preface second line" },
        fauxToolCall("bash", {
          command: "printf 'tool-%s\\n' 'output-only-unique'",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("needle-reply\nneedle-reply second line"),
    ...Array.from({ length: 6 }, (_, i) =>
      fauxAssistantMessage(`compaction-reply-${i}`),
    ),
    fauxAssistantMessage("COMPACTED SEARCH HISTORY"),
    fauxAssistantMessage("newest-only"),
    fauxAssistantMessage("live-priority"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  app.instance.durable.deps.models = models;
  app.instance.durable.deps.settings = () => ["faux/faux-1", "off"];
  const running = await app.serve({ port: 0 });
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    const parent = String(
      (await app.instance.create.create({ title: "Search root", muted: true }))
        .id,
    );
    const child = String(
      (
        await app.instance.create.create({
          title: "Search child",
          parent,
          muted: true,
        })
      ).id,
    );
    await app.instance.durable.open(parent);
    await app.instance.durable.messageSearch.sync(
      app.instance.durable.searchTarget(parent),
    );
    const opened = await app.instance.durable.open(child);
    await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
    let replyCommit: CommitPublication | undefined;
    const following = opened.harness.observeCommits({
      end: () => {},
      advance: (publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === "entry" && change.value.kind === "pi.assistant",
          )
        )
          replyCommit = publication;
      },
    });
    const { token } = await Bun.file(
      join(env.CHAT_DATA_DIR!, "server.json"),
    ).json();
    await writeFile(
      join(env.CHAT_DATA_DIR!, "server.json"),
      JSON.stringify({ token, port: Number(new URL(running.url).port) }),
    );
    const headers = {
      "x-loopback-token": String(token),
      "x-recurse-bundled-tool": "subagent",
      "x-recurse-agent": parent,
      "content-type": "application/json",
    };
    const search = async (q: string, options: Record<string, string> = {}) => {
      const response = await fetch(
        `${running.url}/api/subagent-tool/search?${new URLSearchParams({ q, ...options })}`,
        { headers },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return (await response.json()) as Results;
    };
    const sendPlainReply = async (cid: string, text: string) => {
      const calls = faux.state.callCount;
      const response = await fetch(
        `${running.url}/api/v1/agents/${cid}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ text }),
        },
      );
      expect(response.status).toBe(200);
      await until(
        () =>
          faux.state.callCount === calls + 1 &&
          app.instance.durable.metadata(cid).status === "idle",
      );
      await app.instance.durable.messageSearch.drain();
    };
    const sent = await fetch(`${running.url}/api/v1/agents/${child}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "needle-user" }),
    });
    expect(sent.status).toBe(200);
    await until(
      () =>
        faux.state.callCount === 2 &&
        app.instance.durable.metadata(child).status === "idle",
    );
    following.detach();
    expect(replyCommit).toBeDefined();
    const sidecar = join(
      root,
      "data",
      "conversations",
      child,
      "durable",
      "transcript.txt",
    );
    await until(async () =>
      (await readFile(sidecar, "utf8").catch(() => "")).includes(
        "needle-reply",
      ),
    );
    expect(
      (await search("needle-user", { target: child, role: "agent" })).hits,
    ).toHaveLength(1);
    const reply = (
      await search("NEEDLE-REPLY", { target: child, role: "assistant" })
    ).hits;
    expect(reply).toHaveLength(1);
    expect(reply[0]).toMatchObject({
      agent: child,
      cid: child,
      role: "assistant",
      path: sidecar,
    });
    expect(Object.keys(reply[0]!).sort()).toEqual([
      "agent",
      "cid",
      "entry",
      "line",
      "path",
      "role",
      "snippet",
      "time",
    ]);
    expect(reply[0]!.entry).toBeGreaterThan(0);
    expect(reply[0]!.time).toBeGreaterThan(0);
    const readHit = async (hit: Results["hits"][number]) => {
      const lines = (await readFile(hit.path, "utf8")).split("\n");
      expect(hit.line).toBeGreaterThan(0);
      return lines[hit.line - 1]!;
    };
    expect(await readHit(reply[0]!)).toContain("needle-reply");
    expect(await readFile(sidecar, "utf8")).toContain(
      "needle-reply\nneedle-reply second line",
    );
    await appendFile(sidecar, "torn-final-row");
    await app.instance.durable.messageSearch.sync(
      app.instance.durable.searchTarget(child),
    );
    expect((await search("needle-reply", { target: child })).hits).toHaveLength(
      1,
    );
    expect(await readFile(sidecar, "utf8")).not.toContain("torn-final-row");
    const committed = await readFile(sidecar, "utf8");
    const replyLine = committed
      .split("\n")
      .find((line) => line.includes("needle-reply"))!;
    const replyOffset = committed.indexOf(replyLine);
    await writeFile(
      sidecar,
      committed.slice(0, replyOffset + Math.floor(replyLine.length / 2)),
    );
    await app.instance.durable.messageSearch.sync(
      app.instance.durable.searchTarget(child),
    );
    expect((await search("needle-reply", { target: child })).hits).toHaveLength(
      1,
    );
    expect(await readFile(sidecar, "utf8")).toBe(committed);
    await writeFile(sidecar, committed.slice(0, replyOffset));
    const target = app.instance.durable.searchTarget(child);
    app.instance.durable.messageSearch.schedule(target, replyCommit);
    app.instance.durable.messageSearch.schedule(target, replyCommit);
    await app.instance.durable.messageSearch.drain();
    expect(await readFile(sidecar, "utf8")).toBe(committed);
    expect(
      (
        await app.instance.durable.messageSearch.sync(
          app.instance.durable.searchTarget(child),
        )
      ).entries,
    ).toBe(0);
    const command = (await search("printf", { target: child, role: "tool" }))
      .hits;
    expect(command).toHaveLength(1);
    expect(await readHit(command[0]!)).toContain("printf");
    expect(await readFile(sidecar, "utf8")).toContain(
      "printf 'tool-%s\\n' 'output-only-unique'",
    );
    const output = (
      await search("tool-output-only-unique", {
        target: child,
        role: "tool-result",
      })
    ).hits;
    expect(output).toHaveLength(1);
    expect(await readHit(output[0]!)).toContain("tool-output-only-unique");
    expect(
      (await search("needle-reply needle-reply second", { target: child }))
        .hits,
    ).toEqual([]);
    expect((await search("needle-reply")).hits).toEqual([]);
    expect(
      (await search("needle-reply", { target: parent, tree: "true" })).hits,
    ).toHaveLength(1);
    expect((await search("needle-reply", { all: "true" })).hits).toHaveLength(
      1,
    );
    expect(await readHit(reply[0]!)).toContain("needle-reply");
    const cli = Bun.spawn(
      [
        "bun",
        resolve(import.meta.dir, "../../tools/subagent.ts"),
        "search",
        "needle-reply",
        parent,
        "--tree",
      ],
      {
        env: { ...env, RECURSE_AGENT_ID: parent },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain(`${sidecar}:${reply[0]!.line}: needle-reply`);
    expect(stdout).toContain(
      `[${child} ${new Date(reply[0]!.time).toISOString()} assistant]`,
    );
    const denied = await fetch(
      `${running.url}/api/subagent-tool/search?q=needle`,
      {
        headers: {
          "x-loopback-token": String(token),
          "x-recurse-agent": parent,
        },
      },
    );
    expect(denied.status).toBe(403);
    const invalid = await fetch(
      `${running.url}/api/subagent-tool/search?q=needle&all=true&tree=true`,
      { headers },
    );
    expect(invalid.status).toBe(422);
    for (let i = 0; i < 6; i++) {
      const sent = await fetch(
        `${running.url}/api/v1/agents/${child}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: `compaction-input-${i} ${"word ".repeat(6_400)}`,
          }),
        },
      );
      expect(sent.status).toBe(200);
      await until(
        () =>
          faux.state.callCount === i + 3 &&
          app.instance.durable.metadata(child).status === "idle",
      );
    }
    let compacted = false;
    const compactions = opened.harness.observeCommits({
      end: () => {},
      advance: ({ changes }) => {
        if (
          changes.some(
            (change) =>
              change.type === "entry" && change.value.kind === "pi.compaction",
          )
        )
          compacted = true;
      },
    });
    try {
      await app.instance.durable.compact(child);
      await until(() => compacted);
    } finally {
      compactions.detach();
    }
    expect((await search("needle-reply", { target: child })).hits).toHaveLength(
      1,
    );
    expect((await search("needle-user", { target: child })).hits).toHaveLength(
      1,
    );
    expect(await readHit(reply[0]!)).toContain("needle-reply");
    await app.instance.durable.clear(child);
    await until(
      async () =>
        (await app.instance.durable.archive.get(child))?.reason === "clear",
    );
    await app.instance.durable.open(child);
    expect((await search("needle-reply", { target: child })).hits).toEqual([]);
    const cleared = (
      await search("needle-reply", { target: child, deleted: "true" })
    ).hits;
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.path).toContain(`${child}.clear-`);
    expect(await readHit(cleared[0]!)).toContain("needle-reply");
    await sendPlainReply(child, "create a newer retained transcript");
    await app.instance.reap.requestReap(child, null);
    await until(() => app.instance.conversations.load(child) === null);
    expect((await search("needle-reply", { all: "true" })).hits).toEqual([]);
    const deleted = await search("needle-reply", {
      all: "true",
      deleted: "true",
    });
    expect(deleted.hits).toHaveLength(1);
    expect(deleted.hits[0]!.agent).not.toBe(child);
    expect(await readHit(deleted.hits[0]!)).toContain("needle-reply");
    expect(
      (
        await search("needle-reply", {
          target: parent,
          tree: "true",
          deleted: "true",
        })
      ).hits,
    ).toHaveLength(1);
    expect(
      (await search("needle-reply", { target: deleted.hits[0]!.agent })).hits,
    ).toHaveLength(1);
    expect(app.instance.conversations.load(child)).toBeNull();
    const archiveSidecar = join(
      root,
      "data",
      "agent-archive",
      deleted.hits[0]!.agent,
      "transcript.txt",
    );
    expect(deleted.hits[0]!.path).toBe(archiveSidecar);
    await rm(archiveSidecar);
    const missing = await search("needle-reply", {
      all: "true",
      deleted: "true",
    });
    expect(missing.hits).toEqual([]);
    expect(missing.not_indexed).toBeGreaterThan(0);
    expect(await stat(archiveSidecar).catch(() => null)).toBeNull();
    const checkpoint = join(root, "data", "message-search-backfill.json");
    await Promise.all(app.detached);
    await writeFile(
      checkpoint,
      JSON.stringify({
        version: 1,
        live: "",
        archive: "",
        phase: "done",
        done: 0,
      }),
    );
    const legacySidecar = join(archiveSidecar, "..", "message-search.tsv");
    await writeFile(
      legacySidecar,
      `1\t${reply[0]!.time}\tassistant\tneedle-reply\t${replyCommit!.seq}\t${reply[0]!.entry}\n`,
    );
    const progress: Record<string, unknown>[] = [];
    const migration = {
      processes: app.instance.processes,
      search: app.instance.durable.messageSearch,
      archive: app.instance.durable.archive,
      live: () => [app.instance.durable.searchTarget(parent)],
      yieldToFocus: () => app.instance.durable.yieldToFocus(),
      signal: app.instance.shutdownController.signal,
      log: (_event: string, fields: Record<string, unknown>) => {
        progress.push(fields);
      },
    };
    const previousStalls = stalls.length;
    blockNextSync = true;
    await backfillMessageSearch(migration);
    await until(() => stalls.length > previousStalls);
    expect(stalls.slice(previousStalls).join("\n")).toContain(
      "search_sync_result:",
    );
    const migrated = JSON.parse(await readFile(checkpoint, "utf8"));
    expect(migrated).toMatchObject({ phase: "done", version: 1 });
    expect(await stat(legacySidecar).catch(() => null)).toBeNull();
    expect(await readFile(archiveSidecar, "utf8")).toContain("--- #");
    expect(progress.at(-1)).toMatchObject({ remaining: 0 });
    expect(progress.some((row) => Number(row.bytes) > 0)).toBe(true);
    expect(
      (await search("needle-reply", { all: "true", deleted: "true" })).hits,
    ).toHaveLength(1);
    const archiveTime = await stat(archiveSidecar);
    await utimes(archiveSidecar, 0, archiveTime.mtime);
    const before = await stat(archiveSidecar);
    const logged = progress.length;
    await backfillMessageSearch(migration);
    expect(progress.length).toBeGreaterThan(logged);
    const untouched = await stat(archiveSidecar);
    expect(untouched.atimeMs).toBe(before.atimeMs);
    expect(untouched.mtimeMs).toBe(before.mtimeMs);
    expect(
      [...app.instance.processes.rows.values()].some(
        (row) => row.kind === "message-search",
      ),
    ).toBe(false);
    const newestArchive = (await app.instance.durable.archive.get(child))!;
    expect(newestArchive.archive_id).not.toBe(deleted.hits[0]!.agent);
    const selected = await selectSearchTargets(
      {
        live: () =>
          app.instance.conversations
            .allConvs({ withPending: false })
            .filter(
              (row) =>
                app.instance.durable.owns(row) && row.service_principal == null,
            )
            .map((row) => ({
              id: String(row.id),
              parent: row.parent,
              side_of: row.side_of,
            })),
        target: (cid) => app.instance.durable.searchTarget(cid),
        archive: app.instance.durable.archive,
      },
      { target: parent, all: true, tree: false, deleted: true },
      new AbortController().signal,
    );
    expect(selected.map((target) => target.agent ?? target.cid)).toEqual([
      parent,
      newestArchive.archive_id,
      deleted.hits[0]!.agent,
    ]);
    await sendPlainReply(parent, "give the live scope a priority result");
    let phaseStart = activity.length;
    expect(
      (
        await search("compaction-reply-5", {
          all: "true",
          deleted: "true",
          limit: "1",
        })
      ).hits,
    ).toHaveLength(1);
    expect(activity.slice(phaseStart)).toEqual([1, 0, 1, 0]);
    phaseStart = activity.length;
    const priority = await search("live-priority", {
      all: "true",
      deleted: "true",
      limit: "1",
      role: "assistant",
    });
    expect(priority.hits).toMatchObject([{ cid: parent, role: "assistant" }]);
    expect(priority.truncated).toBe(true);
    expect(activity.slice(phaseStart)).toEqual([1, 0]);
    const heldTranscript = `${archiveSidecar}.held`;
    const database = join(archiveSidecar, "..", "session.sqlite");
    await rename(archiveSidecar, heldTranscript);
    await rename(database, `${database}.held`);
    let pending: Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let catchup: Promise<void> | undefined;
    let catchupError: unknown;
    let allowCatchup = true;
    try {
      expect(
        await Bun.spawn(["mkfifo", archiveSidecar], {
          stdout: "ignore",
          stderr: "pipe",
        }).exited,
      ).toBe(0);
      const previous = activity.length;
      pending = Bun.spawn(
        [
          "bun",
          resolve(import.meta.dir, "../../tools/subagent.ts"),
          "search",
          "needle-reply",
          "--all",
          "--deleted",
          "--limit",
          "100",
        ],
        {
          env: { ...env, RECURSE_AGENT_ID: parent },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      await until(() => activity.length > previous && activity.at(-1) === 1);
      expect(app.instance.durable.messageSearch.hasQueries).toBe(true);
      const beforeCatchup = progress.length;
      catchup = backfillMessageSearch({
        ...migration,
        yieldToFocus: () =>
          allowCatchup
            ? app.instance.durable.yieldToFocus()
            : Promise.resolve(false),
      }).catch((error) => {
        catchupError = error;
      });
      expect(
        await Promise.race([
          pending.exited.then((exit) => ({ exit })),
          Bun.sleep(21_000).then(() => ({ running: true })),
        ]),
      ).toEqual({ running: true });
      expect(progress.length).toBe(beforeCatchup);
      expect(catchupError).toBeUndefined();
      allowCatchup = false;
      pending.kill("SIGINT");
      await pending.exited;
      await until(() => activity.at(-1) === 0);
    } finally {
      allowCatchup = false;
      pending?.kill("SIGINT");
      await pending?.exited;
      await rm(archiveSidecar, { force: true });
      await rename(heldTranscript, archiveSidecar);
      await rename(`${database}.held`, database);
      allowCatchup = true;
      await catchup;
    }
    expect(catchupError).toBeUndefined();
    expect(progress.at(-1)).toMatchObject({ remaining: 0 });
    expect(app.instance.durable.messageSearch.hasQueries).toBe(false);
  } finally {
    await running.close();
    await app.instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// Regression: #3016 queries during backfill report omitted stores without waiting for or blocking indexing.
test("message search returns indexed results while backfill is waiting", async () => {
  const { root, env } = appWorld({ password: true });
  seedPiModelList(join(root, "data", "config"));
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("backfill-needle")]);
  const models = createModels();
  models.setProvider(faux.provider);
  app.instance.durable.deps.models = models;
  app.instance.durable.deps.settings = () => ["faux/faux-1", "off"];
  const running = await app.serve({ port: 0 });
  const release = Promise.withResolvers<void>();
  let migration: Promise<void> | undefined;
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    await Promise.all(app.detached);
    const cid = String((await app.instance.create.create({ muted: true })).id);
    const { token } = await Bun.file(
      join(env.CHAT_DATA_DIR!, "server.json"),
    ).json();
    const headers = {
      "x-loopback-token": String(token),
      "x-recurse-bundled-tool": "subagent",
      "x-recurse-agent": cid,
      "content-type": "application/json",
    };
    const sent = await fetch(`${running.url}/api/v1/agents/${cid}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "index me" }),
    });
    expect(sent.status).toBe(200);
    await until(
      () =>
        faux.state.callCount === 1 &&
        app.instance.durable.metadata(cid).status === "idle",
    );
    await app.instance.durable.messageSearch.drain();
    const target = app.instance.durable.searchTarget(cid);
    const sidecar = join(target.path, "..", "transcript.txt");
    await rm(sidecar);
    const entered = Promise.withResolvers<void>();
    const progress: Record<string, unknown>[] = [];
    migration = backfillMessageSearch({
      processes: app.instance.processes,
      search: app.instance.durable.messageSearch,
      archive: app.instance.durable.archive,
      live: () => [target],
      yieldToFocus: async () => {
        entered.resolve();
        await release.promise;
        return true;
      },
      signal: app.instance.shutdownController.signal,
      log: (_event, fields) => {
        progress.push(fields);
      },
    });
    await entered.promise;
    const query = async () => {
      const response = await fetch(
        `${running.url}/api/subagent-tool/search?q=backfill-needle&all=true&deleted=true`,
        { headers },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as Results;
    };
    expect(await query()).toMatchObject({ hits: [], not_indexed: 1 });
    await writeFile(
      join(env.CHAT_DATA_DIR!, "server.json"),
      JSON.stringify({ token, port: Number(new URL(running.url).port) }),
    );
    const cli = Bun.spawn(
      [
        "bun",
        resolve(import.meta.dir, "../../tools/subagent.ts"),
        "search",
        "backfill-needle",
        "--all",
        "--deleted",
      ],
      {
        env: { ...env, RECURSE_AGENT_ID: cid },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    expect({ stdout, stderr, exit }).toEqual({
      stdout: "",
      stderr: "1 agent is not indexed yet; results are incomplete.\n",
      exit: 0,
    });
    expect(await stat(sidecar).catch(() => null)).toBeNull();
    expect(progress).toEqual([]);
    release.resolve();
    await migration;
    expect(progress.at(-1)).toMatchObject({ done: 1, remaining: 0 });
    const complete = await query();
    expect(complete.not_indexed).toBe(0);
    expect(complete.hits).toHaveLength(1);
    await running.close();
    await app.instance.shutdown();
    const before = await stat(sidecar);
    const reopened = new MessageSearch();
    const finishRestart = reopened.backfillStarted();
    try {
      expect(
        await reopened.search([target], {
          query: "backfill-needle",
          scope: "restart",
        }),
      ).toMatchObject({
        not_indexed: 0,
        truncated: false,
        hits: [{ cid: target.cid, snippet: "backfill-needle" }],
      });
      expect(await reopened.sync(target)).toMatchObject({
        entries: 0,
        bytes: 0,
        profile: { verify_ms: 0 },
      });
      expect(await stat(sidecar)).toMatchObject({
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
      });
    } finally {
      finishRestart(false);
      await reopened.close();
    }
    const stateFile = join(target.path, "..", "message-search-state.json");
    const savedState = JSON.parse(await readFile(stateFile, "utf8"));
    await writeFile(stateFile, JSON.stringify({ ...savedState, database: "" }));
    const cold = new MessageSearch();
    const finishMissingState = cold.backfillStarted();
    try {
      expect(
        await cold.search([target], {
          query: "backfill-needle",
          scope: "stale-state",
        }),
      ).toMatchObject({ not_indexed: 1, truncated: false });
      await rm(stateFile);
      expect(
        await cold.search([target], {
          query: "backfill-needle",
          scope: "missing-state",
        }),
      ).toMatchObject({ not_indexed: 1, truncated: false });
      expect((await cold.sync(target)).bytes).toBe(0);
      expect(await stat(sidecar)).toMatchObject({
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
      });
    } finally {
      finishMissingState(false);
      await cold.close();
    }
    const aliases = await stat(target.path);
    const legacy = JSON.parse(await readFile(stateFile, "utf8"));
    legacy.inode = before.ino;
    legacy.file = `${aliases.dev}:${aliases.ino}:${legacy.file}`;
    legacy.database = legacy.database
      .split("/")
      .map((part: string) =>
        part ? `${before.dev}:${before.ino}:${part}` : "",
      )
      .join("/");
    await writeFile(stateFile, JSON.stringify(legacy));
    const saved = await stat(stateFile);
    const restarted = new MessageSearch();
    try {
      expect(await restarted.sync(target)).toMatchObject({
        entries: 0,
        bytes: 0,
      });
      expect(await stat(stateFile)).toMatchObject({
        ino: saved.ino,
        mtimeMs: saved.mtimeMs,
      });
    } finally {
      await restarted.close();
    }
  } finally {
    release.resolve();
    await migration;
    await running.close();
    await app.instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

// Regression: #3019 queries read available transcripts without consulting unreadable startup metadata.
test("message search skips unreadable unindexed metadata during backfill", async () => {
  const { root, env } = appWorld({ password: true });
  seedPiModelList(join(root, "data", "config"));
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage("fifo-backfill-needle"),
    fauxAssistantMessage("fifo-backfill-needle"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  app.instance.durable.deps.models = models;
  app.instance.durable.deps.settings = () => ["faux/faux-1", "off"];
  const running = await app.serve({ port: 0 });
  const release = Promise.withResolvers<void>();
  let migration: Promise<void> | undefined;
  let fifo = "",
    saved = "";
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    await Promise.all(app.detached);
    const { token } = await Bun.file(
      join(env.CHAT_DATA_DIR!, "server.json"),
    ).json();
    const headers = {
      "x-loopback-token": String(token),
      "x-recurse-bundled-tool": "subagent",
      "content-type": "application/json",
    };
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const cid = String(
        (await app.instance.create.create({ muted: true })).id,
      );
      ids.push(cid);
      const sent = await fetch(`${running.url}/api/v1/agents/${cid}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "index my reply" }),
      });
      expect(sent.status).toBe(200);
      await until(
        () =>
          faux.state.callCount === i + 1 &&
          app.instance.durable.metadata(cid).status === "idle",
      );
    }
    await app.instance.durable.messageSearch.drain();
    await app.instance.reap.requestReap(ids[1]!, null);
    await until(() => app.instance.conversations.load(ids[1]!) === null);
    const archived = await app.instance.durable.archive.get(ids[1]!);
    expect(archived).not.toBeNull();
    fifo = join(
      env.CHAT_DATA_DIR!,
      "agent-archive",
      archived!.archive_id,
      "message-search-state.json",
    );
    saved = await readFile(fifo, "utf8");
    await rm(fifo);
    expect(
      await Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "pipe" })
        .exited,
    ).toBe(0);
    const entered = Promise.withResolvers<void>();
    let phases = 0;
    migration = backfillMessageSearch({
      processes: app.instance.processes,
      search: app.instance.durable.messageSearch,
      archive: app.instance.durable.archive,
      live: () => [app.instance.durable.searchTarget(ids[0]!)],
      yieldToFocus: async () => {
        if (++phases === 3) {
          entered.resolve();
          await release.promise;
        }
        return true;
      },
      signal: app.instance.shutdownController.signal,
      log: () => {},
    });
    await entered.promise;
    const response = await fetch(
      `${running.url}/api/subagent-tool/search?q=fifo-backfill-needle&all=true&deleted=true&limit=100`,
      {
        headers,
        signal: AbortSignal.timeout(5000),
      },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as Results;
    expect(result.not_indexed).toBe(0);
    expect(result.hits.map((hit) => hit.cid).sort()).toEqual([...ids].sort());
  } finally {
    if (fifo) {
      const writer = await open(
        fifo,
        constants.O_WRONLY | constants.O_NONBLOCK,
      ).catch((error) => {
        if (error.code === "ENXIO" || error.code === "ENOENT") return null;
        throw error;
      });
      try {
        await writer?.writeFile(saved);
      } finally {
        await writer?.close();
      }
      await rm(fifo, { force: true });
      await writeFile(fifo, saved);
    }
    release.resolve();
    await migration;
    await running.close();
    await app.instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
