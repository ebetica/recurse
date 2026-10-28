import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as auth from "../../src/web/request_auth";
import { Router } from "../../src/web/router";
import { registerTreeRoutes, type TreeRoutesDeps } from "../../src/web/tree";
import * as durable from "./fixtures/durable_host/host";
import { serveOpen } from "./http_open_app";
import { AgentStore } from "../../src/agents/agent_store";
import { ConversationStore } from "../../src/agents/conversation_store";
import { Config } from "../../src/config";
import { fixtureHooks, paths } from "./fixtures/conversation_store/spec";

const root = await mkdtemp(join(tmpdir(), "subagent-durable-"));
const data = join(root, "data");
const world = durable.fauxHost(data);
world.faux.setResponses([fauxAssistantMessage("hi there")]);
await world.host.send("c1", "hello", "r1");
await (await world.host.open("c1")).conversation.waitForIdle(context);
const agents = new AgentStore(join(data, "agents"));
const conversations = new ConversationStore(
  paths(data),
  agents,
  {
    ...fixtureHooks(data),
    liveStatus: (cid) => {
      const live = world.host.metadata(cid);
      return [live.status, live.active_run];
    },
  },
  new Config({ env: { CHAT_DATA_DIR: data, HOME: root, RECURSE_HOME: root } }),
);
await conversations.save({
  id: "parent",
  backend: "durable",
  workdir: world.work,
});
world.records.c1!.parent = "parent";
await conversations.save({ ...world.records.c1, status: "idle" });
const indexStatuses: unknown[] = [];
const router = new Router();
const served = await serveOpen(router, data);
registerTreeRoutes(router, {
  loopbackAuthenticated: (ex) =>
    auth.loopbackAuthenticated(ex, served.loopbackToken),
  projectionReady: () => true,
  nodeCids: () => [],
  cliIndex: async () => {
    const rows = conversations.cliIndex();
    indexStatuses.push(rows.find((row) => row.id === "c1")?.status);
    return rows;
  },
  transcript: (cid, query) => world.host.transcript(cid, query),
} as Partial<TreeRoutesDeps> as TreeRoutesDeps);
await auth.publishLoopbackToken(data, served.running.port);

afterAll(async () => {
  await served.running.close();
  await world.host.close();
  await agents.dispose();
  await rm(root, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const env = { ...process.env, CHAT_DATA_DIR: data, RECURSE_AGENT_ID: "" };
  const tool = resolve(import.meta.dir, "../../tools/subagent.ts");
  const proc = Bun.spawn(["bun", tool, ...args], { env, stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
  const lines = JSON.parse(`[${out.trim().split("\n").join(",")}]`);
  const rows = lines.filter((line: any) => line.role !== "meta");
  const said = rows.map((row: any) => [row.role, row.text]);
  return { lines, rows, err, said };
}

const exchange = [
  ["user", "hello"],
  ["assistant", "hi there"],
];

// Feature: #2502 reply coverage waits for the requested transcript to commit.
test("messages prints the exchange and pages by entry-id cursors", async () => {
  const all = await cli("messages", "c1");
  expect(all.said).toEqual(exchange);
  for (const row of all.rows) expect(row.ts).toBeString();
  const [user, reply] = all.rows.map((row: any) => row.off);
  expect(all.err).toBe(`prev: 0\nnext: ${reply + 1}\n`);
  for (const [cursor, said, err] of [
    ["--before", [exchange[0]], `prev: ${user}\nnext: ${reply}\n`],
    ["--after", [exchange[1]], `prev: ${reply}\nnext: ${reply + 1}\n`],
  ] as const) {
    const page = await cli("messages", "c1", "--limit=1", cursor, `${reply}`);
    expect([page.said, page.err]).toEqual([said, err]);
  }
});

// Regression: #2837 wait must not treat a held Durable turn as idle.
test("tail and wait print the latest exchange and wait for a running turn", async () => {
  for (const args of [["tail"], ["wait", "--timeout", "5"]]) {
    const got = await cli(...args, "c1");
    const want = ["", world.work, exchange];
    expect([got.err, got.lines[0].text, got.said]).toEqual(want);
  }
  const held = durable.held(fauxAssistantMessage("finished"));
  world.faux.setResponses([held.step]);
  await world.host.send("c1", "hold this turn", "r2");
  await held.started;
  expect(world.host.metadata("c1").status).toBe("running");
  const before = indexStatuses.length;
  let exited = false;
  const waiting = cli("wait", "c1", "--timeout", "15").then((got) => {
    exited = true;
    return got;
  });
  try {
    await durable.until(() => indexStatuses.length >= before + 2 || exited);
    expect(indexStatuses.slice(before)).toEqual(["running", "running"]);
    expect(exited).toBe(false);
  } finally {
    held.release();
    await (await world.host.open("c1")).conversation.waitForIdle(context);
  }
  const got = await waiting;
  expect(got.said.slice(-2)).toEqual([
    ["user", "hold this turn"],
    ["assistant", "finished"],
  ]);
});

// Regression: #2863 reaped history stays readable without truncation.
test("messages reads reaped history read-only with full entries and stable cursors", async () => {
  world.records.c1!.tmp_key = "archive-test";
  world.records.c1!.title = "Archived exchange";
  const answer = "long archived answer\n".repeat(1000);
  world.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "archive-note.txt", content: answer }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(answer),
  ]);
  await world.host.send("c1", "archive this", "r3");
  await (await world.host.open("c1")).conversation.waitForIdle(context);
  world.records.side = {
    id: "side",
    backend: "durable",
    side_of: "c1",
    workdir: world.work,
  };
  world.faux.setResponses([fauxAssistantMessage("side-only reply")]);
  await world.host.send("side", "side-only question", "r-side");
  await (await world.host.open("side")).conversation.waitForIdle(context);
  expect(
    JSON.stringify(await world.host.transcript("side", { limit: 20 })),
  ).toContain("side-only reply");
  const live = await cli("messages", "c1");
  expect(JSON.stringify(live)).not.toContain("side-only");
  const reply = live.rows.at(-1).off;
  const older = await cli(
    "messages",
    "c1",
    "--before",
    String(reply),
    "--limit",
    "1",
  );
  const tool = live.rows.find((row: any) => row.tool === "write" && row.args);
  expect(await readFile(join(world.work, "archive-note.txt"), "utf8")).toBe(
    answer,
  );
  expect(await world.host.retire("c1")).toBe(true);
  conversations.discardConvProjection("c1");
  const dir = join(
    data,
    "agent-archive",
    (await world.host.archive.get("c1"))!.archive_id,
  );
  const snapshot = async () =>
    Promise.all(
      (await readdir(dir)).sort().map(async (name) => {
        const path = join(dir, name);
        return [
          name,
          (await stat(path)).mtimeMs,
          (await readFile(path)).toString("base64"),
        ];
      }),
    );
  const before = await snapshot();
  const archived = await cli("messages", "c1");
  expect(archived).toEqual(live);
  expect(
    await cli("messages", "c1", "--before", String(reply), "--limit", "1"),
  ).toEqual(older);
  expect(await cli("messages", "Archived exchange")).toEqual(live);
  expect(await cli("messages", "1")).toEqual(live);
  expect(await cli("messages", "archexch")).toEqual(live);
  const fullTool = await cli(
    "messages",
    "c1",
    "--full",
    "--after",
    String(tool.off),
    "--limit",
    "1",
  );
  expect(JSON.parse(fullTool.rows[0].args)).toEqual({
    path: "archive-note.txt",
    content: answer,
  });
  const full = await cli(
    "messages",
    "c1",
    "--full",
    "--after",
    String(reply),
    "--limit",
    "1",
  );
  expect(full.said).toEqual([["assistant", answer]]);
  expect(full.err).toBe(`prev: ${reply}\nnext: ${reply + 1}\n`);
  expect(await snapshot()).toEqual(before);
});
