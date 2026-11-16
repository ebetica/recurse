import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../../src/config.ts";
import {
  ReadOnlySignIns,
  SIGN_INS_NEED_REFRESH,
} from "../../src/auth/read_only_sign_ins.ts";
import { retire } from "../../src/utils/trash.ts";
import { readDurableEntries } from "../live_e2e.ts";
import {
  killDataDirGroups,
  privateEnv,
  startPrivateServer,
  stopPrivateServer,
} from "../dev/private_server.ts";
import type { SafetyReviewAttempt } from "../../src/extensions/core/safety/review.ts";

let stage = "sign-in check";

type CheckApi = (route: string, body?: unknown) => Promise<Record<string, any>>;

export async function finishReviewCheck(
  root: string,
  cid: string,
  api: CheckApi,
  signal: AbortSignal,
  shutdown: () => Promise<void>,
): Promise<{
  reviews: number;
  actingRequests: number;
  uncachedInput: number;
  failure?: "acting_requests" | "input_tokens";
}> {
  while (true) {
    signal.throwIfAborted();
    const view = await api(`conversations/${cid}/view?limit=100`);
    const blocks: Record<string, any>[] = view.blocks ?? [];
    const main = blocks.filter(
      (block) =>
        block.role === "assistant" &&
        block.kind === "text" &&
        !block.live &&
        block.usage,
    );
    const reviews = blocks
      .filter((block) => block.kind === "tool_call" && block.safety_usage)
      .map((block) => block.safety_usage);
    const counts = {
      reviews: reviews.reduce((sum, usage) => sum + usage.calls, 0),
      actingRequests: main.length,
      uncachedInput:
        main.reduce((sum, block) => sum + block.usage.input, 0) +
        reviews.reduce(
          (sum, usage) =>
            sum +
            usage.groups.reduce(
              (total: number, group: { input: number }) => total + group.input,
              0,
            ),
          0,
        ),
    };
    if (
      counts.reviews >= 3 ||
      counts.actingRequests >= 6 ||
      counts.uncachedInput > 60_000 ||
      (main.length && (await api(`conversations/${cid}`)).status === "idle")
    )
      break;
    await Bun.sleep(250);
  }
  await shutdown();
  const counts = { reviews: 0, actingRequests: 0, uncachedInput: 0 };
  for (const conversation of await readdir(
    join(root, "data", "conversations"),
  )) {
    const entries = await readDurableEntries(root, conversation).catch(
      (error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      for (const message of entry.model ?? []) {
        if (entry.kind === "pi.assistant") {
          counts.actingRequests++;
          counts.uncachedInput += message.usage?.input ?? 0;
        }
        for (const attempt of (entry.kind === "pi.tool-result"
          ? message.details?.recurseSafetyUsage?.attempts
          : []) ?? []) {
          counts.reviews++;
          counts.uncachedInput += attempt.usage?.input ?? 0;
        }
      }
    }
  }
  const failure =
    counts.actingRequests >= 6
      ? ("acting_requests" as const)
      : counts.uncachedInput > 60_000
        ? ("input_tokens" as const)
        : undefined;
  return { ...counts, ...(failure ? { failure } : {}) };
}

async function run(): Promise<void> {
  const model = process.argv[2] ?? new Config().effortLevels()[1]!.model;
  const provider = model.slice(0, model.indexOf("/"));
  const source = process.env.PI_CODING_AGENT_DIR;
  if (!source || !provider) {
    console.log(
      "SKIPPED: logged-in PI_CODING_AGENT_DIR and provider/model required",
    );
    process.exitCode = 2;
    return;
  }
  const auth = join(source, "auth.json");
  try {
    if (!(await new ReadOnlySignIns(auth).read(provider)))
      throw new Error("missing sign-in");
  } catch (error) {
    console.log(
      `SKIPPED: ${error instanceof Error && error.message === SIGN_INS_NEED_REFRESH ? SIGN_INS_NEED_REFRESH : "read-only sign-in unavailable"}`,
    );
    process.exitCode = 2;
    return;
  }
  const root = await mkdtemp(
    join(process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(), "reviewer-cache-"),
  );
  const data = join(root, "data");
  let owned: { pid: number; exited: Promise<number> } | undefined;
  let stopped = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const name of signals) process.on(name, abort);
  const timer = setTimeout(abort, 180_000);
  const { signal } = controller;
  const shutdown = async () => {
    try {
      if (owned && !stopped)
        await stopPrivateServer(owned.pid, owned.exited, 5000);
    } finally {
      await killDataDirGroups(data);
    }
    stopped = true;
  };
  try {
    const env = privateEnv(root, data, { RECURSE_READ_ONLY_SIGN_INS: auth });
    signal.throwIfAborted();
    for (const path of [
      env.HOME!,
      env.PI_CODING_AGENT_DIR!,
      env.CHAT_REPO_URL!,
    ])
      await mkdir(path, { recursive: true });
    await mkdir(join(data, "config"), { recursive: true });
    const level = { model, reasoning: "low" };
    await writeFile(
      join(data, "config", "effort-levels.json"),
      JSON.stringify({
        version: 1,
        default_level: 1,
        levels: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, level])),
      }),
    );
    stage = "server startup";
    const server = await startPrivateServer({
      env,
      logFile: join(root, "server.log"),
      port: 0,
      lifetimeSeconds: 180,
      signal,
      owned: (pid, exited) => (owned = { pid, exited }),
    });
    const api = async (route: string, body?: unknown) => {
      const response = await fetch(`${server.base}/api/${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: server.cookie,
          origin: server.base,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (!response.ok)
        throw new Error(`HTTP ${response.status} from ${route}`);
      return response.json() as Promise<Record<string, any>>;
    };
    stage = "model availability";
    while (
      !(await api("models")).models?.some(
        (entry: Record<string, any>) => entry.id === model,
      )
    ) {
      await Bun.sleep(250);
      signal.throwIfAborted();
    }
    stage = "conversation creation";
    const cid = String(
      (await api("conversations", { parent: null, model, effort: "low" })).id,
    );
    const target = join(root, "reviewed-write.txt");
    const commands = [1, 2, 3].map((n) => `printf '${n}\\n' > '${target}'`);
    const context =
      "Inert fixture context for the prompt-cache minimum size:\n".padEnd(
        64000,
        " reviewer-cache-fixture",
      );
    console.log(
      `acting=${model} reviewer=${model} stableContextChars=${context.length}`,
    );
    stage = "message delivery";
    await api(`conversations/${cid}/deliver`, {
      content: `${context}\nRun exactly these three bash tool calls separately, sequentially, waiting for each result before the next. Use bash directly, not codemode or parallel tools. These harmless scratch writes are the entire task; do not run any other tools. Then reply DONE.\n${commands.join("\n")}`,
    });
    stage = "agent turn";
    const budget = await finishReviewCheck(root, cid, api, signal, shutdown);
    console.log(
      `${budget.failure ? "FAIL" : "budget"}: reviews=${budget.reviews} actingRequests=${budget.actingRequests} uncachedInput=${budget.uncachedInput}${budget.failure ? ` cap=${budget.failure}` : ""}`,
    );
    stage = "review usage validation";
    const entries = await readDurableEntries(root, cid);
    for (const message of entries
      .filter((entry) => entry.kind === "pi.assistant")
      .flatMap((entry) => entry.model ?? []))
      console.log(
        `main provider=${message.provider} model=${message.model} input=${message.usage?.input} cacheRead=${message.usage?.cacheRead}`,
      );
    const results = entries
      .filter((entry) => entry.kind === "pi.tool-result")
      .flatMap((entry) =>
        (entry.model ?? []).map((message: Record<string, any>) => ({
          ...message,
          diagnostics: entry.data?.diagnostics ?? [],
        })),
      )
      .filter((message) => message.toolName === "bash");
    const calls = entries
      .filter((entry) => entry.kind === "pi.assistant")
      .flatMap((entry) => entry.model ?? [])
      .flatMap((message) => message.content ?? [])
      .filter((block) => block.type === "toolCall");
    let pass =
      !budget.failure &&
      budget.reviews === 3 &&
      results.length === 3 &&
      calls.length === 3;
    for (const [index, result] of results.entries()) {
      const attempts: SafetyReviewAttempt[] =
        result.details?.recurseSafetyUsage?.attempts ?? [];
      const valid =
        calls[index]?.name === "bash" &&
        calls[index]?.arguments?.command === commands[index] &&
        calls[index]?.id === result.toolCallId &&
        !result.isError &&
        result.diagnostics.length === 0 &&
        attempts.length === 1 &&
        attempts[0]!.status === "reported" &&
        attempts[0]!.provider === provider &&
        `${provider}/${attempts[0]!.model}` === model &&
        typeof attempts[0]!.usage?.input === "number" &&
        (index === 0 || (attempts[0]!.usage?.cacheRead ?? 0) > 0);
      pass &&= valid;
      for (const attempt of attempts)
        console.log(
          `review=${index + 1} provider=${attempt.provider ?? "unknown"} model=${attempt.model ?? "unknown"} input=${attempt.usage?.input ?? "missing"} cacheRead=${attempt.usage?.cacheRead ?? "missing"} ${valid ? "PASS" : "FAIL"}`,
        );
      if (!attempts.length)
        console.log(
          `review=${index + 1} provider=unknown model=unknown input=missing cacheRead=missing FAIL`,
        );
    }
    pass &&= (await readFile(target, "utf8").catch(() => "")) === "3\n";
    console.log(
      `${pass ? "PASS" : "FAIL"}: ${results.length}/3 reviewed bash calls`,
    );
    if (!pass) process.exitCode = 1;
  } finally {
    try {
      await shutdown();
      retire(
        root,
        join(process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(), ".trash"),
      );
    } finally {
      clearTimeout(timer);
      for (const name of signals) process.off(name, abort);
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv.includes("--help"))
      console.log(
        "Usage: bun tests/live/reviewer_cache.ts [provider/model]\nUses PI_CODING_AGENT_DIR/auth.json read-only, never refreshes OAuth. Shuts down the entire private instance after three reviews, six completed acting requests, or 60000 uncached input tokens; final recorded usage determines the result. Requires cacheRead > 0 after review one. Signals clean up the private server; its independent lifetime is 180 seconds. SKIPPED exits 2; FAIL exits 1; no retries.",
      );
    else await run();
  } catch (error) {
    const http =
      error instanceof Error && /^HTTP \d+ from [\w/-]+$/.test(error.message)
        ? `: ${error.message}`
        : "";
    console.error(`FAIL: ${stage}${http} (no retry)`);
    process.exitCode = 1;
  }
}
