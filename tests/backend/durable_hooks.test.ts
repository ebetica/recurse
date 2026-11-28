import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import { Config } from "../../src/config";
import { buildApp, WebLogSink } from "../../src/web/app";
import { fauxHost, idle, lifecycle, until } from "./fixtures/durable_host/host";
import { appWorld } from "./web_app_support";

const REWRITE = `
import { appendFile } from "node:fs/promises";
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    await appendFile(ctx.cwd + "/seen.jsonl", JSON.stringify({ agent: ctx.agentId, command: event.input.command, parent: event.parentToolCallId ?? null }) + "\\n");
    if (event.input.command === "touch original.txt") event.input.command = "touch rewritten.txt";
  });
  pi.on("tool_result", async (event) => ({ content: [...event.content, { type: "text", text: "patched by hook" }] }));
  pi.on("context", async (event) => ({ messages: [{ role: "user", content: "context hook ran", timestamp: 0 }, ...event.messages] }));
  pi.on("session_start", () => {});
  pi.registerCommand("ported", { handler: async () => {} });
}
export const timeout = 120_000;
`;
const BLOCK = `
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    const env = ["NODE_PATH", "BUN_PROBE", "HOOK_PROBE", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "RECURSE_AGENT_ID"].map((name) => process.env[name] ?? "-");
    if (event.input.command?.includes("blocked.txt")) return { block: true, reason: "not this file for " + ctx.agentId + " " + env.join(",") };
  });
}
`;
const LOCAL = `
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.input.command?.includes("fail-call")) throw new Error("local call failed");
    if (event.input.command === "touch start.txt") return { input: { ...event.input, command: "touch original.txt" } };
    if (event.input.command?.includes("local-blocked")) return { block: true, reason: "not here for " + ctx.agentId + " " + (process.env.HOOK_PROBE ?? "-") };
  });
  pi.on("tool_result", async (event) => {
    if (event.input.command?.includes("fail-result")) throw new Error("local result failed");
    if (event.toolName === "bash" && !event.parentToolCallId) return { content: [{ type: "text", text: "local result" }] };
  });
}
`;
const BROKEN = `
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
if (!existsSync(process.cwd() + "/fixed")) throw new Error("broken on load");
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    await appendFile(ctx.cwd + "/fixed-ran", event.toolName + ":" + (event.input.command ?? "") + "\\n");
  });
}
`;
const HANG = `
export const timeout = 200;
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (!event.input.command?.includes("hang.txt")) return;
    const sleeper = Bun.spawn(["sleep", "60"]);
    await Bun.write(ctx.cwd + "/sleeper.pid", String(sleeper.pid));
    await new Promise(() => {});
  });
}
`;

// Feature: #3721 global hook files run on tool calls and results in their own process groups
test("global hooks change, block and patch tool calls, including nested ones, and fail open", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-hooks-"));
  const started = fauxHost(root, undefined, true);
  const { faux, work } = started;
  let host = started.host;
  const config = new Config({
    env: {
      CHAT_DATA_DIR: join(root, "data"),
      HOME: join(root, "home"),
      RECURSE_HOME: join(root, "settings"),
    },
  });
  host.deps.config = config;
  const hookRows = () =>
    [...lifecycle.rows.values()].filter((row) => row.kind === "hook");
  const failures: unknown[] = [];
  host.deps.log = (event, fields) => {
    if (event === "hook_failed") failures.push(fields);
  };
  const reviewed: string[] = [];
  const contextSeen = { model: false, review: false };
  let next = fauxAssistantMessage("done");
  let result = "";
  let system = "";
  const respond: FauxResponseFactory = async (request) => {
    faux.appendResponses([respond]);
    const last = request.messages.findLast(
      (message) => message.role === "user" || message.role === "toolResult",
    );
    const plain =
      typeof last?.content === "string"
        ? last.content
        : (last?.content ?? [])
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n");
    const action = plain.match(
      />>> PROPOSED ACTION START\n([\s\S]+?)\n>>> PROPOSED ACTION END/,
    )?.[1];
    const hooked = JSON.stringify(request.messages).includes(
      "context hook ran",
    );
    if (last?.role === "user" && action) {
      contextSeen.review ||= hooked;
      reviewed.push(JSON.parse(action).input.command);
      return fauxAssistantMessage("OK");
    }
    contextSeen.model ||= hooked;
    system = request.messages
      .flatMap((message) =>
        Object.values((message as { sections?: object }).sections ?? {}),
      )
      .join("\n");
    if (last?.role === "toolResult") {
      result = JSON.stringify(
        request.messages
          .slice(
            request.messages.findLastIndex(
              (message) => message.role === "assistant",
            ) + 1,
          )
          .map((message) => message.content),
      );
      return fauxAssistantMessage("done");
    }
    return next;
  };
  faux.setResponses([respond]);
  const turn = async (name: string, tool: ReturnType<typeof fauxToolCall>) => {
    result = "";
    next = fauxAssistantMessage(tool, { stopReason: "toolUse" });
    await host.send("c1", name, `op:operator::${name}`);
    await until(idle(host));
  };
  const bash = (command: string) => fauxToolCall("bash", { command });
  const exists = (file: string) => Bun.file(join(work, file)).exists();
  try {
    await turn("none", bash("touch plain.txt"));
    expect(await exists("plain.txt")).toBe(true);
    expect(system).not.toContain("recurse_hooks");
    await writeFile(
      join(work, "probe.env"),
      "NODE_PATH=/agent\nBUN_PROBE=agent\nHOOK_PROBE=agent\n",
    );
    await turn(
      "env",
      fauxToolCall("env", { action: "load", path: "probe.env" }),
    );

    await mkdir(join(root, "hooks"));
    await writeFile(join(root, "hooks", "a-rewrite.ts"), REWRITE);
    await writeFile(join(root, "hooks", "b-block.ts"), BLOCK);
    await writeFile(join(root, "hooks", "c-hang.ts"), HANG);
    await writeFile(join(root, "hooks", "d-broken.ts"), BROKEN);
    const local = join(root, "hooks", "agents", "c1", "l-local.ts");
    await mkdir(join(root, "hooks", "agents", "c1"), { recursive: true });
    await writeFile(local, LOCAL);
    expect(await host.hooks.list()).toEqual(
      ["a-rewrite.ts", "b-block.ts", "c-hang.ts", "d-broken.ts"].map(
        (name) => ({
          name,
          path: join(root, "hooks", name),
          scope: "global",
          source: expect.any(String),
        }),
      ),
    );

    await turn("rewrite", bash("touch start.txt"));
    expect(await exists("rewritten.txt")).toBe(true);
    expect(await exists("original.txt")).toBe(false);
    expect(reviewed.at(-1)).toBe("touch rewritten.txt");
    const blocks = (await host.view("c1", { limit: 50 })).blocks as {
      name?: string;
      args?: string;
      ran_args?: string;
    }[];
    expect(
      blocks.find((block) => block.args === "touch start.txt"),
    ).toMatchObject({
      name: "bash",
      ran_args: "touch rewritten.txt",
    });
    expect(result).not.toContain("rewritten.txt");
    expect(result).toContain(
      '{"type":"text","text":"local result"},{"type":"text","text":"patched by hook"}',
    );
    expect(result).not.toContain("d-broken.ts");
    expect(contextSeen).toEqual({ model: true, review: false });
    expect((await host.hooks.list())[0]).toMatchObject({
      name: "a-rewrite.ts",
      events: ["tool_call", "tool_result", "context"],
      unsupported: [
        "session_start",
        "timeout 120 s (uses 60 s)",
        "pi.registerCommand",
      ],
    });

    expect(system).not.toContain(local);
    await host.close();
    host = new DurableHost(host.deps);
    failures.length = 0;
    await turn("local block", bash("touch local-blocked.txt"));
    expect(await exists("local-blocked.txt")).toBe(false);
    expect(result).toContain(
      'Hook \\"l-local.ts\\" (local): not here for c1 -',
    );
    expect(result).toContain("patched by hook");
    expect(await readFile(join(work, "seen.jsonl"), "utf8")).not.toContain(
      "local-blocked",
    );
    expect(system).toContain(
      "Hooks (as of session start; `tools/hooks.ts list` shows the current list): local l-local.ts; global a-rewrite.ts; global b-block.ts; global c-hang.ts; global d-broken.ts.",
    );

    await turn("block", bash('printf %s "$HOOK_PROBE" > blocked.txt'));
    expect(await exists("blocked.txt")).toBe(false);
    expect(result).toContain(
      'Hook \\"b-block.ts\\" (global): not this file for c1 -,-,-,0,c1',
    );
    expect(result).toContain("patched by hook");

    next = fauxAssistantMessage(
      [bash("touch fail-call-1.txt"), bash("touch fail-call-2.txt")],
      { stopReason: "toolUse" },
    );
    await host.send("c1", "failing calls", "op:operator::failing");
    await until(idle(host));
    expect(await exists("fail-call-2.txt")).toBe(true);
    expect(
      result.split(
        '{"type":"text","text":"Hook \\"l-local.ts\\" (local) failed: local call failed; call ran unchanged."}',
      ),
    ).toHaveLength(2);
    await turn("failing result", bash("touch fail-result.txt"));
    expect(result).toContain(
      '{"type":"text","text":"Hook \\"l-local.ts\\" (local) failed: local result failed; result unchanged."}',
    );
    expect((await host.hooks.listFor("c1")).at(-1)).toMatchObject({
      name: "d-broken.ts",
      events: [],
      failure: { error: "broken on load" },
    });
    expect(
      failures.filter(
        (fields) => (fields as { hook: string }).hook === "d-broken.ts",
      ),
    ).toHaveLength(1);

    await writeFile(join(work, "fixed"), "");
    await writeFile(join(root, "hooks", "d-broken.ts"), `${BROKEN}\n`);
    result = "";
    next = fauxAssistantMessage(
      fauxToolCall(
        "codemode",
        { code: 'text(await tools.bash({command:"touch hang.txt"}));' },
        { id: "nested-parent" },
      ),
      { stopReason: "toolUse" },
    );
    await host.send("c1", "nested", "op:operator::nested");
    await until(
      () =>
        host.metadata("c1").running_hooks?.[0]?.label === "c-hang.ts (global)",
    );
    const records = join(host.shellState("c1").stateDir, "hooks");
    const recorded = async () =>
      Promise.all(
        (await readdir(records).catch(() => []))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) =>
            JSON.parse(
              await readFile(join(records, name), "utf8").catch(() => "null"),
            ),
          ),
      ).then((all) => all.filter(Boolean));
    await until(async () =>
      (await recorded()).some(
        (record) => record.status === "running" && record.mode === "hook",
      ),
    );
    expect(hookRows().length).toBeGreaterThan(0);
    expect(hookRows().every((row) => row.pgid === row.pid)).toBe(true);
    await until(idle(host));
    expect(await recorded()).toEqual([]);
    expect(await exists("hang.txt")).toBe(true);
    expect(result).not.toContain("c-hang.ts");
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hook: "c-hang.ts", event: "tool_call" }),
      ]),
    );
    expect(await readFile(join(work, "fixed-ran"), "utf8")).toBe(
      "codemode:\nbash:touch hang.txt\n",
    );
    const sleeper = Number(await readFile(join(work, "sleeper.pid"), "utf8"));
    await until(() => {
      try {
        process.kill(sleeper, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(host.metadata("c1").running_hooks).toBeUndefined();
    const seen = (await readFile(join(work, "seen.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(seen.at(-1)).toEqual({
      agent: "c1",
      command: "touch hang.txt",
      parent: "nested-parent",
    });
    expect(hookRows()).toEqual([]);

    await config.setRunHooks(false);
    await turn("off", bash('printf %s "$HOOK_PROBE" > blocked.txt'));
    expect(await readFile(join(work, "blocked.txt"), "utf8")).toBe("agent");
  } finally {
    await host.close();
  }
});

// Feature: #3723 hook files add to new input, continue a finished run at most 8 times in a row and see each run end
test("run hooks add to messages, continue answered runs up to the limit and see runs end", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-run-hooks-"));
  const { faux, host, records, work } = fauxHost(root);
  const work2 = join(root, "work2");
  await mkdir(work2);
  records.c2 = { id: "c2", backend: "durable", workdir: work2 };
  const limits: unknown[] = [];
  host.deps.log = (event, fields) => {
    if (event === "hook_continuation_limit") limits.push(fields);
  };
  const requests: string[] = [];
  const second: boolean[] = [];
  faux.setResponses([
    async function respond(request) {
      faux.appendResponses([respond]);
      const text = JSON.stringify(request.messages);
      if (text.includes("second agent")) {
        second.push(text.includes("second start"));
        return request.messages.filter((m) => m.role === "toolResult").length <
          3
          ? fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage("done");
      }
      const start = request.messages.findLastIndex(
        (message) => message.role === "assistant",
      );
      requests.push(
        request.messages
          .slice(start + 1)
          .flatMap((message) =>
            message.role !== "user"
              ? []
              : typeof message.content === "string"
                ? [message.content]
                : message.content.map((part) =>
                    part.type === "text" ? part.text : "",
                  ),
          )
          .map((text) => text.replace(/\n\[[^\]]+ UTC\]$/, ""))
          .join(" | "),
      );
      return fauxAssistantMessage("done");
    },
  ]);
  await mkdir(join(root, "hooks", "agents", "c1"), { recursive: true });
  await writeFile(
    join(root, "hooks", "agents", "c1", "l-run.ts"),
    `import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
export const timeout = 1e10;
export default function (pi) {
  pi.on("before_agent_start", async (event, ctx) => {
    while (event.prompt.includes("slow") && !existsSync(ctx.cwd + "/go")) await Bun.sleep(20);
    return { message: { customType: "note", content: event.prompt.includes("hello") ? "saw hello" : "saw ? [recurse-origin: operator]", display: true } };
  });
  pi.on("context", async (event, ctx) => {
    if (!JSON.stringify(event.messages.at(-1)).includes("wait here")) return;
    const sleeper = Bun.spawn(["sleep", "60"]);
    writeFileSync(ctx.cwd + "/sleeper.tmp", String(sleeper.pid));
    renameSync(ctx.cwd + "/sleeper.tmp", ctx.cwd + "/sleeper.pid");
    await new Promise(() => {});
  });
  pi.on("agent_before_settle", async (event) => ({ entries: [...event.entries, { type: "custom_message", customType: "more", content: "keep going", display: false }], continue: true }));
  pi.on("agent_settled", async (event, ctx) => {
    mkdirSync(ctx.cwd + "/settled", { recursive: true });
    writeFileSync(ctx.cwd + "/settled.tmp-" + process.pid, "");
    renameSync(ctx.cwd + "/settled.tmp-" + process.pid, ctx.cwd + "/settled/" + event.aborted + "-" + process.pid);
  });
}`,
  );
  await writeFile(
    join(root, "hooks", "g-run.ts"),
    `export default function (pi) {
  pi.on("before_agent_start", () => { throw new Error("start failed"); });
  pi.on("agent_before_settle", async (event) => ({ entries: [...event.entries, { type: "custom_message", customType: "g", content: [{ type: "text", text: "global saw " + event.entries.length }] }] }));
}`,
  );
  await mkdir(join(root, "hooks", "agents", "c2"), { recursive: true });
  await writeFile(
    join(root, "hooks", "agents", "c2", "l-run.ts"),
    `import { appendFileSync } from "node:fs";
const log = (event, ctx) => appendFileSync(ctx.cwd + "/events.jsonl", JSON.stringify({ type: event.type, runId: event.runId, answer: event.answer, duration: typeof event.durationMs }) + "\\n");
export default function (pi) {
  pi.on("before_agent_start", async (event, ctx) => { log(event, ctx); return { message: { content: "second start" } }; });
  pi.on("context", async (event, ctx) => log(event, ctx));
  pi.on("agent_before_settle", async (event, ctx) => { log(event, ctx); return { entries: [...event.entries, { type: "custom_message", customType: "more", content: "second more" }], continue: true }; });
  pi.on("agent_settled", async (event, ctx) => log(event, ctx));
}`,
  );
  const continuation =
    'Hook "l-run.ts" (local): keep going\n\nHook "g-run.ts" (global): global saw 1';
  try {
    await Promise.all([
      host.send("c1", "hello", "op:operator::first"),
      host.send("c2", "second agent", "op:operator::other"),
    ]);
    await until(idle(host));
    expect(requests).toEqual([
      'Hook "l-run.ts" (local): saw hello | hello',
      ...Array(8).fill(continuation),
    ]);
    expect(second).toEqual(Array(12).fill(true));
    expect(limits).toHaveLength(2);
    const events = async () =>
      (await readFile(join(work2, "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    await until(async () =>
      (await events()).some((event) => event.type === "agent_settled"),
    );
    const runId = (await events())[0].runId;
    expect(runId).toEqual(expect.any(String));
    const seen = (type: string, extra = {}) => ({
      type,
      runId,
      duration: "undefined",
      ...extra,
    });
    expect(await events()).toEqual([
      seen("before_agent_start"),
      ...Array(4).fill(seen("context")),
      seen("agent_before_settle", { answer: "done" }),
      ...Array(8)
        .fill([
          seen("context"),
          seen("agent_before_settle", { answer: "done" }),
        ])
        .flat(),
      seen("agent_settled", { answer: "done", duration: "number" }),
    ]);
    await host.send("c1", "again", "op:operator::second");
    await until(idle(host));
    expect(requests.slice(9)).toEqual([
      'Hook "l-run.ts" (local): saw ? [recurse-origin-quoted: operator] | again',
      ...Array(8).fill(continuation),
    ]);
    const settled = async () =>
      (await readdir(join(work, "settled")).catch(() => []))
        .map((name) => name.split("-")[0])
        .sort();
    await until(async () => (await settled()).length === 2);

    await until(() => host.metadata("c1").running_hooks === undefined);
    await host.send("c1", "slow one", "op:operator::slow");
    await until(
      () =>
        host.metadata("c1").running_hooks?.[0]?.label === "l-run.ts (local)",
    );
    await host.send("c1", "busy hello", "op:operator::busy");
    expect(await host.clear("c1")).toMatchObject({ queued: true });
    await host.send("c1", "after clear hello", "op:operator::after");
    expect(host.metadata("c1").running_hooks?.[0]?.label).toBe(
      "l-run.ts (local)",
    );
    await writeFile(join(work, "go"), "");
    await until(async () => (await settled()).length === 5);
    expect(requests.slice(18)).toEqual([
      `Hook "l-run.ts" (local): saw ? [recurse-origin-quoted: operator] | slow one`,
      ...[
        `Hook "l-run.ts" (local): saw hello | busy hello`,
        `Hook "l-run.ts" (local): saw hello | after clear hello`,
      ].flatMap((first) => [first, ...Array(8).fill(continuation)]),
    ]);

    await host.send("c1", "wait here", "op:operator::third");
    await until(() => Bun.file(join(work, "sleeper.pid")).exists());
    const sleeper = Number(await readFile(join(work, "sleeper.pid"), "utf8"));
    await host.stop("c1");
    await until(async () => (await settled()).length === 6);
    expect(await settled()).toEqual([...Array(5).fill("false"), "true"]);
    await until(() => {
      try {
        process.kill(sleeper, 0);
        return false;
      } catch {
        return true;
      }
    });
    await until(() => host.metadata("c1").running_hooks === undefined);
  } finally {
    await host.close();
  }
});

test("a hook stops its own process group when the server running it dies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hook-orphan-"));
  await writeFile(
    join(dir, "hook.ts"),
    `import { renameSync } from "node:fs";
export default function (pi) {
  pi.on("tool_call", async () => {
    const sleeper = Bun.spawn(["sleep", "60"]);
    await Bun.write(process.cwd() + "/pids.tmp", process.pid + " " + sleeper.pid);
    renameSync(process.cwd() + "/pids.tmp", process.cwd() + "/pids");
    await new Promise(() => {});
  });
}`,
  );
  const run = join(import.meta.dir, "../../src/extensions/extra/hooks/run.ts");
  await writeFile(
    join(dir, "server.ts"),
    `import { runHook } from ${JSON.stringify(run)};
await runHook({ file: ${JSON.stringify(join(dir, "hook.ts"))}, event: "tool_call", payload: { input: {} }, cwd: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH }, agentId: "a", own: async () => {}, release: async () => true });`,
  );
  const server = Bun.spawn([process.execPath, join(dir, "server.ts")], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await until(() => Bun.file(join(dir, "pids")).exists());
  const pids = (await readFile(join(dir, "pids"), "utf8"))
    .split(" ")
    .map(Number);
  expect(pids).toHaveLength(2);
  expect(pids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
  server.kill("SIGKILL");
  await server.exited;
  const gone = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  await until(() => pids.every(gone));
});

// Feature: #3722 agents' local hook files run before global ones and are listed and run through tools/hooks.ts
test("agents list and run hooks with the hooks tool, for live agents only", async () => {
  const { root, env } = appWorld();
  const app = await buildApp({ env, sink: new WebLogSink(() => {}) });
  const running = await app.serve({ port: 0 });
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    const data = env.CHAT_DATA_DIR!;
    const { token } = await Bun.file(join(data, "server.json")).json();
    await writeFile(
      join(data, "server.json"),
      JSON.stringify({ token, port: Number(new URL(running.url).port) }),
    );
    const owner = String(
      (await app.instance.create.create({ title: "Hook owner", muted: true }))
        .id,
    );
    const gone = String(
      (await app.instance.create.create({ title: "Gone", muted: true })).id,
    );
    const global = join(app.instance.durable.deps.piAgentDir, "hooks");
    await mkdir(global, { recursive: true });
    await writeFile(join(global, "g.ts"), "export default function () {}");
    for (const agent of [owner, gone]) {
      await mkdir(join(data, "hooks", "agents", agent), { recursive: true });
      await writeFile(
        join(data, "hooks", "agents", agent, "a.ts"),
        `export default function (pi) {
  pi.on("tool_call", async (event, ctx) => ({ block: true, reason: event.toolName + " for " + ctx.agentId }));
}`,
      );
    }
    const call = async (...args: string[]) => {
      const cli = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../tools/hooks.ts"),
          ...args,
        ],
        {
          cwd: root,
          env: { ...env, RECURSE_AGENT_ID: owner },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(cli.stdout).text(),
        new Response(cli.stderr).text(),
        cli.exited,
      ]);
      return { out, err, code };
    };
    const tool = async (...args: string[]) => {
      const { out, err, code } = await call(...args);
      expect({ err, code }).toEqual({ err: "", code: 0 });
      return out;
    };
    const local = join(data, "hooks", "agents", owner, "a.ts");
    expect(await tool("list")).toBe(
      [
        `local  ${local}`,
        "  events: not loaded yet",
        `global  ${join(global, "g.ts")}`,
        "  events: not loaded yet",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "input.json"),
      JSON.stringify({ toolName: "bash", input: { command: "ls" } }),
    );
    expect(
      JSON.parse(
        await tool(
          "run",
          local,
          "--event",
          "tool_call",
          "--input",
          "input.json",
        ),
      ),
    ).toEqual({
      events: ["tool_call"],
      result: { block: true, reason: `bash for ${owner}` },
    });

    await writeFile(
      join(root, "broken.ts"),
      'export default function (pi) {\n  pi.on("tool_call", () => { let a = ; });\n}\n',
    );
    expect(
      await call(
        "run",
        join(root, "broken.ts"),
        "--event",
        "tool_call",
        "--input",
        "input.json",
      ),
    ).toMatchObject({
      code: 1,
      err: "Hook failed: Unexpected ; at 2:38\n",
    });

    await writeFile(
      join(data, "hooks", "agents", owner, "s.ts"),
      `import { existsSync } from "node:fs";
export default function (pi) {
  pi.on("agent_settled", async (event, ctx) => { while (!existsSync(ctx.cwd + "/go")) await Bun.sleep(20); });
}`,
    );
    const settling = app.instance.durable.hooks.settled(
      owner,
      async () => ({ cwd: root, env }),
      { aborted: false, conversation: "1" },
    );
    const status = async () => {
      const cli = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../tools/subagent.ts"),
          "status",
          owner,
          "--json",
        ],
        { cwd: root, env, stdout: "pipe", stderr: "pipe" },
      );
      return JSON.parse(await new Response(cli.stdout).text());
    };
    await until(async () => (await status()).running_hooks !== undefined);
    expect((await status()).running_hooks).toEqual([
      { label: "s.ts (local)", at: expect.any(Number) },
    ]);
    await writeFile(join(root, "go"), "");
    await settling;
    expect((await status()).running_hooks).toBeUndefined();
    await unlink(join(data, "hooks", "agents", owner, "s.ts"));

    expect((await tool("list", "--agent", gone)).split("\n")[0]).toBe(
      `local  ${join(data, "hooks", "agents", gone, "a.ts")}`,
    );
    const deleted = await fetch(`${running.url}/api/conversations/${gone}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(202);
    await until(() => !app.instance.durable.deps.liveIds().includes(gone));
    expect(await call("list", "--agent", gone)).toMatchObject({
      out: "",
      code: 1,
      err: expect.stringContaining("No such agent."),
    });
    expect(
      await Bun.file(join(data, "hooks", "agents", gone, "a.ts")).exists(),
    ).toBe(true);
    await unlink(local);
    expect(await tool("list")).toBe(
      [`global  ${join(global, "g.ts")}`, "  events: none", ""].join("\n"),
    );
  } finally {
    await running.close();
  }
});
