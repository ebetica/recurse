import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ownSession, request, waitReady, waitSettled } from "../live_e2e.ts";
import {
  assertAuthUnchanged,
  assertOAuthCredentialsFresh,
  liveModel,
  prepare,
  ROOT,
  stopServer,
  survivors,
  type LiveJson as Json,
} from "../live_e2e_helpers.ts";

const bytes = (value: string) => Buffer.byteLength(value);
const text = (message: Json) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((block: Json) => block.type === "text")
        .map((block: Json) => block.text)
        .join("\n");
async function rows(path: string): Promise<Json[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function identity(
  root: string,
  cid: string,
  session?: string,
): Promise<string | null> {
  const found: string[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!command.includes("--mode\0rpc")) continue;
      const env = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
      if (!env.some((line) => line === `CHAT_DATA_DIR=${join(root, "data")}`))
        continue;
      let owner = env.includes(`RECURSE_AGENT_ID=${cid}`);
      if (!owner && session) {
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          try {
            const { readlink } = await import("node:fs/promises");
            if ((await readlink(`/proc/${pid}/fd/${fd}`)) === session)
              owner = true;
          } catch {}
        }
      }
      if (!owner) continue;
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      found.push(
        `${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`,
      );
    } catch {}
  }
  if (found.length > 1) throw new Error(`ambiguous Pi owner ${cid}`);
  return found[0] ?? null;
}

function contextBytes(message: Json): number {
  if (message.role !== "user") return 0;
  const value = text(message);
  const messageAt = value.indexOf("## Message\n");
  if (messageAt < 0) return 0;
  const prefix = value.slice(0, messageAt);
  return /Runtime context|Digest:|Agent context|Memory directories/.test(prefix)
    ? bytes(prefix)
    : 0;
}

async function run(): Promise<void> {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination)
    throw new Error("AUTH_DIRECTORY and OUTPUT_DIRECTORY required");
  const models = ["anthropic", "openai-codex"].map(
    (provider) => liveModel(provider).id,
  );
  const output = resolve(destination);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  const root = await mkdtemp(
    join(process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(), "system-messages-"),
  );
  const prepared = await prepare(root, resolve(source), undefined);
  const { env, base, command } = prepared;
  let authError: unknown = null;
  await chmod(env.PI_CODING_AGENT_DIR!, 0o700);
  await writeFile(
    join(env.CHAT_REPO_URL!, "AGENTS.md"),
    "PROJECT_ALPHA\nAnswer acceptance questions briefly. Do not create or change files unless explicitly requested.\n",
  );
  const repoB = join(root, "repo-b");
  await mkdir(repoB);
  await writeFile(
    join(repoB, "AGENTS.md"),
    "PROJECT_BETA\nAnswer acceptance questions briefly. Do not create or change files unless explicitly requested.\n",
  );
  for (const repo of [env.CHAT_REPO_URL!, repoB]) {
    for (const args of [
      ["init", "-q"],
      ["add", "AGENTS.md"],
      [
        "-c",
        "user.name=Acceptance",
        "-c",
        "user.email=acceptance@example.invalid",
        "commit",
        "-qm",
        "Acceptance instructions",
      ],
    ]) {
      if (Bun.spawnSync(["git", "-C", repo, ...args], { env }).exitCode)
        throw new Error("private git seed failed");
    }
  }
  assertOAuthCredentialsFresh(await readFile(prepared.auth, "utf8"));
  const log = openSync(join(output, "server.log"), "a", 0o600);
  const server = Bun.spawn(command, {
    cwd: ROOT,
    env,
    stdout: log,
    stderr: log,
    detached: true,
  });
  closeSync(log);
  const records: Json[] = [];
  await writeFile(join(output, "observations.jsonl"), "", { mode: 0o600 });
  await writeFile(
    join(output, "run.json"),
    JSON.stringify({
      root,
      models,
      commit: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT })
        .stdout.toString()
        .trim(),
    }),
    { mode: 0o600 },
  );
  try {
    await waitReady(base, server);
    console.log("private server ready");
    for (const model of models) {
      const ladder = Object.fromEntries(
        [1, 2, 3, 4, 5].map((level) => [
          level,
          { model, reasoning: level === 4 ? "high" : "medium" },
        ]),
      );
      await request(base, "api/settings/effort-levels", { levels: ladder });
      const cid = String(
        (
          await request(base, "api/conversations", {
            parent: null,
            model,
            effort: "medium",
            title: "System message acceptance",
          })
        ).id,
      );
      let priorPid: string | null = null;
      let session: string | undefined;
      let seen = new Set<string>();
      let priorReply: string | null = null;
      const turn = async (
        scenario: string,
        prompt: string,
        check: (reply: string) => boolean,
      ) => {
        console.log(`${model} ${scenario} started`);
        const before = seen;
        await request(base, `api/conversations/${cid}/deliver`, {
          content: prompt,
        });
        priorReply = await waitSettled(base, cid, priorReply, 900);
        const view = await request(base, `api/conversations/${cid}/view`);
        session = await ownSession(root, cid, String(view.session));
        const all = await rows(session);
        const messages = all.filter((row) => !before.has(String(row.id)));
        seen = new Set(all.map((row) => String(row.id)));
        const pid = await identity(root, cid, session);
        if (!pid) throw new Error(`${model} ${scenario} Pi PID not observable`);
        const assistant = messages
          .filter((row) => row.message?.role === "assistant")
          .map((row) => row.message as Json);
        if (assistant.some((message) => message.stopReason === "error"))
          throw new Error(`${model} provider error`);
        if (
          assistant.some(
            (message) => `${message.provider}/${message.model}` !== model,
          )
        )
          throw new Error("provider route mismatch");
        const reply = assistant.map(text).join("\n");
        const system = messages
          .filter((row) => row.message?.role === "system")
          .map((row) => row.message as Json);
        const usage = assistant.reduce(
          (sum, message) => {
            for (const key of ["input", "cacheRead", "cacheWrite"])
              sum[key] += Number(message.usage?.[key] ?? 0);
            return sum;
          },
          { input: 0, cacheRead: 0, cacheWrite: 0 } as Record<string, number>,
        );
        const total = usage.input! + usage.cacheRead! + usage.cacheWrite!;
        const record = {
          scenario,
          model,
          pi_pid: pid,
          pi_pid_changed: priorPid === null ? null : pid !== priorPid,
          system_messages: {
            count: system.length,
            messages: system.map((message) => ({
              sections: Object.keys(message.sections ?? {}),
              bytes: bytes(JSON.stringify(message)),
              replace: message.replace === true,
              toolsAdded:
                message.toolsAdded?.map((tool: Json) => tool.name) ?? [],
              toolsRemoved: message.toolsRemoved ?? [],
            })),
          },
          injected_context_bytes: messages.reduce(
            (sum, row) => sum + (row.message ? contextBytes(row.message) : 0),
            0,
          ),
          provider_usage: usage,
          cache_hit_ratio: total ? usage.cacheRead! / total : null,
          answer_reflects_change: check(reply),
          reply,
        };
        const inspection = await request(
          base,
          `api/conversations/${cid}/prompt`,
        );
        await writeFile(
          join(output, `${model.split("/")[0]}-${scenario}-prompt.json`),
          JSON.stringify(inspection),
          { mode: 0o600 },
        );
        priorPid = pid;
        records.push(record);
        await appendFile(
          join(output, "observations.jsonl"),
          JSON.stringify(record) + "\n",
        );
        await writeFile(
          join(output, `${model.split("/")[0]}-session.jsonl`),
          await readFile(session!, "utf8"),
          { mode: 0o600 },
        );
        console.log(
          `${model} ${scenario} complete: answer=${record.answer_reflects_change}`,
        );
      };
      await turn(
        "warmup",
        "Without tools, reply exactly PROJECT_ALPHA if that is the first line of your project instructions.",
        (reply) => reply.trim() === "PROJECT_ALPHA",
      );
      await turn(
        "S1-native-tools",
        "Use codemode searchTools to discover the deferred Artifact tool and effort levels and colour themes tool, then describeTool to inspect each. Reply exactly NATIVE_TOOLS_PRESENT if artifact and recurse_settings are available, otherwise NATIVE_TOOLS_MISSING.",
        (reply) => reply.trim() === "NATIVE_TOOLS_PRESENT",
      );
      await turn(
        "S2-chdir",
        `Use the chdir tool to change your working directory to ${repoB}. Do not run bash or read files. Then reply CHDIR_DONE.`,
        (reply) => reply.trim() === "CHDIR_DONE",
      );
      await turn(
        "S2",
        "Without tools, quote only the first line of your current project instructions.",
        (reply) => reply.trim() === "PROJECT_BETA",
      );
      await request(base, `api/conversations/${cid}/model`, { level: 4 });
      await turn(
        "S3",
        "Without tools, what effort level does your Runtime context specify? Reply only the integer.",
        (reply) => reply.trim() === "4",
      );
      const child = String(
        (
          await request(base, "api/conversations", {
            parent: cid,
            model,
            title: "ACCEPTANCE_CHILD",
          })
        ).id,
      );
      await turn(
        "S4",
        "Without tools, list your immediate child agent identifiers from the agent tree digest. Reply only the identifiers.",
        (reply) => reply.includes(child),
      );
      const memory = join(env.CHAT_DATA_DIR!, "memories/agents", cid);
      await mkdir(memory, { recursive: true });
      await writeFile(
        join(memory, "ACCEPTANCE_MEMORY.md"),
        "---\ntitle: Acceptance memory\ndate: 2026-10-02\n---\nAcceptance memory index marker.\n",
        { mode: 0o600 },
      );
      await turn(
        "S5",
        "Without tools, list memory filenames from your memory index. Reply only the filenames.",
        (reply) => reply.includes("ACCEPTANCE_MEMORY.md"),
      );
    }
  } finally {
    let cleanupError: unknown = null;
    try {
      await stopServer(server);
    } catch (error) {
      cleanupError = error;
    }
    try {
      assertAuthUnchanged(
        prepared.authSnapshot,
        await readFile(prepared.auth, "utf8"),
      );
    } catch (error) {
      authError = error;
    }
    const remaining = survivors(root);
    await writeFile(
      join(output, "cleanup.json"),
      JSON.stringify({ private_root: root, survivors: remaining }),
      { mode: 0o600 },
    );
    if (cleanupError) throw cleanupError;
    if (remaining.length) throw new Error("private server process survivors");
    if (authError) throw authError;
    await rm(root, { recursive: true, force: true });
    await writeFile(
      join(output, "summary.json"),
      JSON.stringify(records, null, 2),
      { mode: 0o600 },
    );
  }
}
if (import.meta.main)
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
