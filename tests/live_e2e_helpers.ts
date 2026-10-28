import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  readFileSync as readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { STRICT_ISOLATED_PATH_ENV } from "../src/local_roots.ts";
import { Config } from "../src/config.ts";

export function liveModel(provider: string, config = new Config()) {
  const levels = config.effortLevels();
  const order = [
    config.defaultEffortLevel(),
    ...Object.keys(levels).map(Number),
  ];
  for (const level of order) {
    const id = levels[level]!.model;
    const separator = id.indexOf("/");
    if (id.slice(0, separator) !== provider) continue;
    const unlisted = config.unlistedModelSentence(id, level);
    if (unlisted) throw new Error(unlisted);
    return { id, route: { provider, modelId: id.slice(separator + 1) } };
  }
  throw new Error(`Choose a ${provider} model in Settings > Effort ladder`);
}

export function liveSecondModel(models: LiveJson[], config = new Config()) {
  const provider = models
    .map((model) => String(model.id).split("/", 1)[0])
    .find((id) => id !== "anthropic");
  return provider ? liveModel(provider, config).id : undefined;
}

export type LiveJson = Record<string, any>;

export const LIVE_AUTH_SAFE_WINDOW_MS = 60 * 60 * 1000;

type AuthObject = Record<string, unknown>;

function parseAuth(raw: string): AuthObject {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as AuthObject;
  } catch {
    throw new Error("private auth.json must be a JSON object");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

export function authSnapshot(raw: string): string {
  return JSON.stringify(canonical(parseAuth(raw)));
}

export function assertOAuthCredentialsFresh(
  raw: string,
  now = Date.now(),
  safeWindowMs = LIVE_AUTH_SAFE_WINDOW_MS,
): void {
  for (const [provider, value] of Object.entries(parseAuth(raw))) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const credential = value as AuthObject;
    if (credential.type !== "oauth") continue;
    const expires = credential.expires;
    if (typeof expires !== "number" || !Number.isFinite(expires))
      throw new Error(`OAuth credential for ${provider} has no valid expiry`);
    if (expires < now + safeWindowMs) {
      const minutes = Math.floor((expires - now) / 60_000);
      throw new Error(
        `OAuth credential for ${provider} expires in ${minutes} minutes; live harness requires at least 60 minutes`,
      );
    }
  }
}

export function assertAuthUnchanged(before: string, after: string): void {
  if (before !== authSnapshot(after))
    throw new Error("private auth.json credential fields changed during run");
}

type LiveProcess = {
  pid: number;
  exitCode: number | null;
  exited: Promise<number>;
};
export const ROOT = resolve(import.meta.dir, "..");

export function validateSecondModelReplies(
  replies: LiveJson[],
  model: string,
): void {
  const [provider, modelId] = model.split("/", 2);
  const answered = replies.some((message) =>
    JSON.stringify(message.content).includes("SECOND_MODEL_OK"),
  );
  if (
    !answered ||
    replies.some(
      (message) =>
        message.provider !== provider ||
        message.model !== modelId ||
        message.stopReason === "error",
    )
  ) {
    throw new Error(`second model ${model} did not answer on that route`);
  }
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function killGroup(pid: number, signal: "TERM" | "KILL"): void {
  try {
    process.kill(-pid, `SIG${signal}`);
  } catch {}
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGroupGone(
  pid: number,
  milliseconds: number,
): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await sleep(100);
  }
  return !groupAlive(pid);
}

export async function stopServer(child: LiveProcess): Promise<void> {
  const pid = child.pid;
  if (child.exitCode === null) {
    killGroup(pid, "TERM");
    await Promise.race([child.exited, sleep(15_000)]);
  }
  if (groupAlive(pid)) {
    killGroup(pid, "KILL");
    await Promise.race([child.exited, sleep(10_000)]);
  }
  if (!(await waitGroupGone(pid, 10_000)))
    throw new Error("private server process group survived cleanup");
}

export function survivors(privateRoot: string): string[] {
  const found: string[] = [];
  const uid = process.getuid?.();
  if (uid === undefined) return found;
  const resolvedRoot = realpathSync(privateRoot);
  for (const entry of readdirSyncCompat("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (statSync(`/proc/${entry}`).uid !== uid) continue;
      const cwd = realpathSync(`/proc/${entry}/cwd`);
      const command = readSync(`/proc/${entry}/cmdline`)
        .toString()
        .replaceAll("\0", " ");
      if (cwd.startsWith(resolvedRoot + "/") || command.includes(resolvedRoot))
        found.push(entry);
    } catch {}
  }
  return found;
}
function readdirSyncCompat(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

export type Prepared = {
  env: Record<string, string>;
  auth: string;
  target: string;
  base: string;
  output: string;
  command: string[];
  privateRoot: string;
  authSnapshot: string;
};

export async function prepare(
  privateRoot: string,
  source: string,
  commandArg: string | undefined,
): Promise<Prepared> {
  await chmod(privateRoot, 0o700);
  const sourceAuth = await readFile(join(source, "auth.json"), "utf8");
  assertOAuthCredentialsFresh(sourceAuth);
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "TZ", "RECURSE_SERVER"])
    if (process.env[key]) env[key] = process.env[key]!;
  for (const [key, relative] of Object.entries(STRICT_ISOLATED_PATH_ENV)) {
    env[key] = join(privateRoot, relative);
    await mkdir(env[key], { recursive: true });
  }
  env.RECURSE_ISOLATED_ROOT = privateRoot;
  const auth = join(env.PI_CODING_AGENT_DIR, "auth.json");
  await cp(join(source, "auth.json"), auth);
  await chmod(auth, 0o600);
  const copiedAuthSnapshot = authSnapshot(await readFile(auth, "utf8"));
  const seed = env.CHAT_REPO_URL;
  const target = join(env.CHAT_DATA_DIR, "repo");
  const git = Bun.which("git");
  if (!git) throw new Error("git required for private worktree");
  const gitRun = (...parts: string[]) => {
    const result = Bun.spawnSync([git, ...parts], { env });
    if (result.exitCode !== 0) throw new Error(`git ${parts.join(" ")} failed`);
  };
  gitRun("init", "-q", seed);
  gitRun("-C", seed, "config", "user.name", "Live E2E");
  gitRun("-C", seed, "config", "user.email", "live@example.invalid");
  await writeFile(
    join(seed, "live-seed.txt"),
    "E2E_FINDABLE ALPHA_ORBITAL\nE2E_SECOND BETA\n",
  );
  await mkdir(join(seed, "e2e-subdir"));
  await writeFile(join(seed, "e2e-subdir", ".keep"), "");
  gitRun("-C", seed, "add", ".");
  gitRun("-C", seed, "commit", "-qm", "Synthetic E2E seed");
  const listener = createServer();
  const port = await new Promise<number>((resolvePort, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string")
        reject(new Error("could not select a port"));
      else resolvePort(address.port);
    });
  });
  await new Promise<void>((resolveClose) =>
    listener.close(() => resolveClose()),
  );
  env.PORT = String(port);
  const defaultCommand = [join(ROOT, "recurse"), "--once", seed];
  const parsed = commandArg ? JSON.parse(commandArg) : defaultCommand;
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((value) => typeof value !== "string")
  )
    throw new Error("--server-command must be a JSON argv array");
  const command = (parsed as string[]).map((part) =>
    part
      .replaceAll("{port}", String(port))
      .replaceAll("{root}", ROOT)
      .replaceAll("{target}", seed),
  );
  const base = `http://127.0.0.1:${port}/`;
  const output = join(
    process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(),
    `live-e2e-${privateRoot.split("/").pop()}`,
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);
  await mkdir(join(output, "screenshots"), {
    recursive: true,
    mode: 0o700,
  });
  return {
    env,
    auth,
    target,
    base,
    output,
    command,
    privateRoot,
    authSnapshot: copiedAuthSnapshot,
  };
}
