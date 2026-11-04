import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retire } from "../../src/utils/trash";
import { counters, delta, processTicks, quiet } from "./hotpath_cpu";
import {
  killDataDirGroups,
  privateEnv,
  scriptedModel,
  startPrivateServer,
  stopPrivateServer,
  type PrivateServer,
} from "./private_server";

const root = await mkdtemp(join(tmpdir(), "hotpath-"));
const data = join(root, "data");
const tracePath = join(root, "trace.json");
const logPath = join(root, "server.log");
console.log(`Hotpath gate scratch: ${root}`);
type Call = { name: string; arguments: Record<string, unknown> };
let calls: Call[] = [
  { name: "bash", arguments: { command: "printf foreground-ok" } },
  {
    name: "bash",
    arguments: { command: "sleep 38; printf heartbeat-ok", background: true },
  },
  {
    name: "bash",
    arguments: {
      command:
        "bun $RECURSE_SRC/tools/subagent.ts create --title gate-child 'Reply Done without tools.'",
    },
  },
];
let completed = false;
let results: string[] = [];
let searchDelay = false;
const provider = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: { role: string; content?: unknown; tool_calls?: unknown[] }[];
      tools?: unknown[];
    };
    const messages = body.messages;
    const safety = messages.some(
      (m) =>
        ["system", "developer"].includes(m.role) &&
        JSON.stringify(m.content).includes("You are pi-safety"),
    );
    const last = messages.findLastIndex(
      (m) =>
        m.role === "user" && JSON.stringify(m.content).includes("HOTPATH-GATE"),
    );
    const after = messages.slice(last + 1);
    const step = after.filter(
      (m) => m.role === "assistant" && m.tool_calls?.length,
    ).length;
    const call =
      !safety && last >= 0 && body.tools?.length ? calls[step] : undefined;
    if (last >= 0 && !safety)
      results = after
        .filter((m) => m.role === "tool")
        .map((m) => JSON.stringify(m.content));
    if (last >= 0 && !safety && !call) completed = true;
    if (call && searchDelay) await Bun.sleep(1100);
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${step}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            },
          ],
        }
      : { role: "assistant", content: safety ? "OK" : "Done." };
    const chunk = (value: object, finish: string | null) => ({
      id: "hotpath",
      object: "chat.completion.chunk",
      created: 0,
      model: "scripted",
      choices: [{ index: 0, delta: value, finish_reason: finish }],
    });
    return new Response(
      [chunk(delta, null), chunk({}, call ? "tool_calls" : "stop")]
        .map((part) => `data: ${JSON.stringify(part)}\n\n`)
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
let owned: { pid: number; exited: Promise<number> } | undefined;
let server: PrivateServer;
let tracing = false;
const stopping = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => stopping.abort(new Error(signal)));
const timeout = setTimeout(
  () => stopping.abort(new Error("gate timed out")),
  240_000,
);
const deadline = stopping.signal;
const SERVER_IDLE_ALLOWANCE = 120;
async function until(check: () => Promise<boolean>, label: string) {
  while (!(await check())) {
    deadline.throwIfAborted();
    await Bun.sleep(100);
  }
  console.log(`PASS ${label}`);
}
async function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const abort = () => child.kill();
  deadline.addEventListener("abort", abort, { once: true });
  try {
    deadline.throwIfAborted();
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (code) throw new Error(`${command.join(" ")}: ${stderr}`);
  } finally {
    deadline.removeEventListener("abort", abort);
    if (deadline.aborted) {
      child.kill();
      await child.exited;
    }
  }
}
async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<Record<string, unknown>> {
  const response = await fetch(server.base + path, {
    method,
    headers: { cookie: server.cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: deadline,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
async function turn(cid: string, planned: Call[], expected: string[]) {
  calls = planned;
  results = [];
  completed = false;
  await api(`/api/conversations/${cid}/deliver`, {
    content: "HOTPATH-GATE: run the planned tools.",
  });
  await until(
    async () =>
      completed && (await api(`/api/conversations/${cid}`)).status === "idle",
    "fake-provider turn",
  );
  if (
    results.length !== expected.length ||
    expected.some((text, i) => !results[i]?.includes(text))
  )
    throw new Error(`tool scenario failed: ${JSON.stringify(results)}`);
}

try {
  if (process.platform !== "linux")
    throw new Error("hotpath gates require Linux /proc thread counters");
  for (const dir of [
    "home",
    "settings/pi-agent",
    "scratch",
    "pi-bg",
    "repo/src",
    "data",
  ])
    await mkdir(join(root, dir), { recursive: true });
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port!;
  await probe.stop(true);
  const env = privateEnv(root, data, {
    PORT: String(port),
    RECURSE_HOTPATH_KEY: "loopback-only",
    RECURSE_BLOCKING_TRACE: tracePath,
    TMPDIR: join(root, "scratch"),
  });
  const repo = join(root, "repo");
  for (let directory = 0; directory < 100; directory++) {
    const path = join(repo, "src", `group_${directory}`);
    await mkdir(path);
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        writeFile(
          join(path, `module_${i}.ts`),
          `export const idle_gate_value_${i} = ${i};\n`,
        ),
      ),
    );
  }
  await run(["git", "init", "-q", "-b", "main"], repo, env);
  await run(["git", "add", "."], repo, env);
  await run(["git", "commit", "-qm", "fixture"], repo, env);
  await run(["git", "clone", "-q", repo, join(data, "repo")], root, env);
  await scriptedModel(data, "hotpath", provider.port!, "RECURSE_HOTPATH_KEY");
  const searchReport = join(root, "search-cpu.json");
  await run(
    [
      process.execPath,
      join(import.meta.dir, "hotpath_search_cpu.ts"),
      join(data, "repo"),
      searchReport,
    ],
    root,
    env,
  );
  const searchCpu = JSON.parse(await readFile(searchReport, "utf8")) as {
    singleTicks: number;
    burstTicks: number;
    burstAllowance: number;
  };
  const { singleTicks, burstTicks, burstAllowance } = searchCpu;
  console.log(JSON.stringify({ searchCpu }));
  const idleReport = join(root, "idle-cpu.json");
  await run(
    [
      process.execPath,
      join(import.meta.dir, "hotpath_idle_cpu.ts"),
      repo,
      idleReport,
    ],
    root,
    env,
  );
  const idleCpu = JSON.parse(await readFile(idleReport, "utf8"));
  server = await startPrivateServer({
    env,
    logFile: logPath,
    port,
    owned: (pid, exited) => {
      owned = { pid, exited };
    },
    signal: deadline,
    bunArgs: ["--preload", join(import.meta.dir, "blocking_trace_preload.ts")],
  });
  await api("/api/tree");
  await until(async () => {
    const log = await readFile(logPath, "utf8");
    return [
      "list_pi_models",
      "cleanup_retired_tool_details",
      "recover_artifact_deletions",
    ].every((step) => log.includes(`[startup] step=${step} `));
  }, "startup background work finished");
  const runtimeStart = (
    await readFile(join(data, "logs", "recurse.log"), "utf8")
  ).length;
  process.kill(server.pid, "SIGUSR2");
  await until(async () => {
    const status = await readFile(`${tracePath}.armed`, "utf8").catch(() => "");
    if (status && status !== "ready") throw new Error(status);
    return status === "ready";
  }, "trace probes passed and tracing armed after startup");
  tracing = true;
  const settings = await api("/api/settings/maximum-context-window", {
    maximum_context_window: 200_000,
  });
  if (settings.maximum_context_window !== 200_000)
    throw new Error("Settings write did not finish before its response");
  const storedSettings = JSON.parse(
    await readFile(join(data, "config", "maximum-context-window.json"), "utf8"),
  );
  if (storedSettings.maximum_context_window !== 200_000)
    throw new Error("Settings response did not persist its value");
  const cid = String((await api("/api/conversations", {})).id);
  const shellStarted = Date.now();
  await turn(cid, calls, ["foreground-ok", "shell", "Spawn accepted"]);
  const child = /Spawn accepted: subagent ([a-f0-9]+)/.exec(
    results.join(" "),
  )?.[1];
  if (!child) throw new Error("spawned agent id missing from tool result");
  const search: Call = { name: "find", arguments: { pattern: "module" } };
  const singleBefore = await processTicks(server.pid);
  await turn(cid, [search], ["module"]);
  const serverSingleTicks = (await processTicks(server.pid)) - singleBefore;
  searchDelay = true;
  const burst = Array.from(
    { length: 30 },
    (_, i): Call =>
      i % 2
        ? { name: "grep", arguments: { pattern: "idle_gate_value" } }
        : search,
  );
  const burstBefore = await processTicks(server.pid);
  await turn(
    cid,
    burst,
    burst.map((call) => (call.name === "find" ? "module" : "idle_gate_value")),
  );
  const serverBurstTicks = (await processTicks(server.pid)) - burstBefore;
  console.log(JSON.stringify({ serverSingleTicks, serverBurstTicks }));
  searchDelay = false;
  await writeFile(
    join(data, "repo", "src", "group_0", "module_0.ts"),
    "export const changed = true;\n",
  );
  for (const route of [
    "/api/tree",
    `/api/conversations/${cid}`,
    `/api/conversations/${cid}/view?limit=100`,
    `/api/conversations/${cid}/diff`,
    "/api/settings/effort-levels",
    "/api/settings/theme",
    "/api/settings/model-list",
    "/api/backends",
    "/api/settings/mcp-servers",
  ])
    await api(route);
  await until(
    async () => (await api(`/api/conversations/${child}`)).status === "idle",
    "spawned agent idle",
  );
  await api(`/api/conversations/${child}`, undefined, "DELETE");
  await Bun.sleep(Math.max(0, 40_000 - (Date.now() - shellStarted)));
  await until(async () => {
    const log = (
      await readFile(join(data, "logs", "recurse.log"), "utf8")
    ).slice(runtimeStart);
    return (
      log.includes("event=trash_drain") &&
      log.includes("event=reap_history_expiry")
    );
  }, "trash drain and history expiry");
  await api("/api/tree");
  await until(async () => {
    const state = await api(`/api/conversations/${cid}`);
    return state.status === "idle" && !state.active_run;
  }, "no running turn before request-free idle window");
  const serverQuiet = await quiet(deadline, "server idle", server.pid);
  const windows = [];
  const indexed = join(data, "repo");
  let churn = 0;
  let before = await counters(server.pid);
  for (let window = 0; window < 3; window++) {
    if (
      !Object.values(before.threads).some((thread) =>
        thread.name.startsWith("fff-bg-"),
      )
    )
      throw new Error("native search threads were not exercised");
    const idleEnd = Date.now() + 15_000;
    while (Date.now() < idleEnd) {
      deadline.throwIfAborted();
      await writeFile(
        join(indexed, "src", `churn_${churn++}.ts`),
        "export const churn = true;\n",
      );
      await writeFile(join(indexed, ".gitignore"), `absent-${churn}\n`);
      await Bun.sleep(50);
    }
    const after = await counters(server.pid);
    const used = delta(before, after);
    windows.push({ ticks: used.ticks, burning: used.threads });
    before = after;
  }
  const median = windows
    .map((window) => window.ticks)
    .sort((a, b) => a - b)[1]!;
  const serverIdle = {
    quiet: serverQuiet,
    windows,
    median,
    allowance: SERVER_IDLE_ALLOWANCE,
  };
  console.log(JSON.stringify({ serverIdle }, null, 2));
  process.kill(server.pid, "SIGUSR2");
  tracing = false;
  await until(async () => {
    try {
      JSON.parse(await readFile(tracePath, "utf8"));
      return true;
    } catch {
      return false;
    }
  }, "blocking trace flushed");
  const observed = JSON.parse(await readFile(tracePath, "utf8")) as {
    site: string;
    count: number;
    stack: string;
  }[];
  const allowed = JSON.parse(
    await readFile(join(import.meta.dir, "hotpath_allowed.json"), "utf8"),
  ) as { site: string; reason: string }[];
  const known = JSON.parse(
    await readFile(join(import.meta.dir, "hotpath_known.json"), "utf8"),
  ) as { site: string; reason: string }[];
  const entries = [...allowed, ...known];
  if (
    entries.some((entry) => !entry.reason.trim()) ||
    new Set(entries.map((entry) => entry.site)).size !== entries.length
  )
    throw new Error("trace lists require unique sites and reasons");
  const unexpected = observed.filter(
    (entry) => !entries.some((entry2) => entry2.site === entry.site),
  );
  const stale = known.filter(
    (entry) => !observed.some((entry2) => entry2.site === entry.site),
  );
  await writeFile(
    join(root, "report.json"),
    JSON.stringify(
      {
        observed,
        unexpected,
        stale,
        serverIdle,
        singleTicks,
        burstTicks,
        burstAllowance,
        searchCpu,
        idleCpu,
        serverSingleTicks,
        serverBurstTicks,
      },
      null,
      2,
    ),
  );
  console.log(
    `Trace: ${observed.length} sites; ${unexpected.length} unexpected; ${stale.length} stale known sites. Report: ${root}/report.json`,
  );
  if (unexpected.length)
    console.error(
      JSON.stringify(
        unexpected.map(({ site, count }) => ({ site, count })),
        null,
        2,
      ),
    );
  if (stale.length) console.error(JSON.stringify({ stale }, null, 2));
  if (
    unexpected.length ||
    stale.length ||
    burstTicks > burstAllowance ||
    median > SERVER_IDLE_ALLOWANCE
  )
    throw new Error("hotpath performance gate failed");
  console.log("PASS main-thread blocking trace and idle CPU gates");
} finally {
  clearTimeout(timeout);
  if (owned && tracing) {
    try {
      process.kill(owned.pid, "SIGUSR2");
      await Bun.sleep(200);
    } catch {}
  }
  try {
    if (owned) await stopPrivateServer(owned.pid, owned.exited);
  } finally {
    try {
      await killDataDirGroups(data);
    } finally {
      await provider.stop(true);
    }
  }
  await writeFile(
    join(root, "runtime.log"),
    await readFile(join(data, "logs", "recurse.log"), "utf8").catch(() => ""),
  );
  retire(data, join(root, "trash"));
  console.log(`Hotpath gate logs: ${root}`);
}
