// Private Recurse servers for dev scripts: throwaway state, per-run password,
// one scripted model, explicit loopback port. Callers record the pid through
// `owned` before startup can fail; shutdown SIGKILLs the group until it is
// gone; killDataDirGroups ends detached groups under the data directory.
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const PASSWORD = randomBytes(18).toString("base64url");
const SALT = randomBytes(16).toString("hex");
const sleep = (ms: number) => Bun.sleep(ms);

export interface PrivateServer {
  pid: number;
  exited: Promise<number>;
  base: string;
  cookie: string;
  /** performance.now() at spawn. */
  started: number;
  listeningMs: number;
}

/**
 * The server's environment: HOME, settings, scratch and data under `root`
 * and `data`, the operator login, and a Git identity for agent commits.
 */
export function privateEnv(
  root: string,
  data: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "TERM", "USER", "TZ"])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  return Object.assign(env, {
    HOME: join(root, "home"),
    CHAT_DATA_DIR: data,
    CHAT_REPO_URL: join(root, "repo"),
    RECURSE_HOME: join(root, "settings"),
    PI_CODING_AGENT_DIR: join(root, "settings", "pi-agent"),
    RECURSE_TEMP_ROOT: join(root, "scratch"),
    PI_BG_SHELL_STATE_DIR: join(root, "pi-bg"),
    RECURSE_FRONTEND_LIVE: "0",
    CHAT_AUTH_SALT: SALT,
    CHAT_AUTH_HASH: pbkdf2Sync(
      PASSWORD,
      new Uint8Array(Buffer.from(SALT, "hex")),
      600_000,
      32,
      "sha256",
    ).toString("hex"),
    GIT_AUTHOR_NAME: "Recurse dev script",
    GIT_AUTHOR_EMAIL: "dev-script@example.invalid",
    GIT_COMMITTER_NAME: "Recurse dev script",
    GIT_COMMITTER_EMAIL: "dev-script@example.invalid",
    ...extra,
  });
}

/** Every effort level runs `<name>/scripted` at 127.0.0.1:`port`/v1. */
export async function scriptedModel(
  data: string,
  name: string,
  port: number,
  keyEnv: string,
): Promise<void> {
  await mkdir(join(data, "config"), { recursive: true });
  const level = { model: `${name}/scripted`, reasoning: "low" };
  await writeFile(
    join(data, "config", "effort-levels.json"),
    JSON.stringify({
      default_level: 3,
      levels: { 1: level, 2: level, 3: level, 4: level, 5: level },
      version: 1,
    }),
  );
  await writeFile(
    join(data, "config", "model-providers.json"),
    JSON.stringify({
      default: `${name}/scripted`,
      providers: {
        [name]: {
          base_url: `http://127.0.0.1:${port}/v1`,
          env_key: keyEnv,
          wire_api: "completions",
          models: [{ id: "scripted", context_window: 1_000_000 }],
        },
      },
    }),
  );
}

/**
 * Start `src/server.ts` on 127.0.0.1:`port` (0: any free port) and sign in;
 * `owned` gets the pid at spawn, and aborting `signal` ends wait and spawn.
 */
export async function startPrivateServer(options: {
  env: Record<string, string>;
  logFile: string;
  port: number;
  owned: (pid: number, exited: Promise<number>) => void;
  signal: AbortSignal;
  bunArgs?: readonly string[];
}): Promise<PrivateServer> {
  const { signal } = options;
  await writeFile(options.logFile, "");
  signal.throwIfAborted();
  const started = performance.now();
  const proc = Bun.spawn(
    [
      process.execPath,
      ...(options.bunArgs ?? []),
      join(ROOT, "src", "server.ts"),
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
    ],
    {
      cwd: ROOT,
      env: options.env,
      stdout: Bun.file(options.logFile),
      stderr: Bun.file(options.logFile),
      detached: true,
    },
  );
  options.owned(proc.pid, proc.exited);
  let base = "";
  while (!base) {
    signal.throwIfAborted();
    if (performance.now() - started > 120_000 || proc.exitCode !== null)
      throw new Error(`server did not listen; see ${options.logFile}`);
    base =
      (await readFile(options.logFile, "utf8").catch(() => "")).match(
        /listening on (http:\/\/127\.0\.0\.1:\d+)/,
      )?.[1] ?? "";
    if (!base) await sleep(20);
  }
  const listeningMs = performance.now() - started;
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(PASSWORD)}`,
    signal,
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (login.status !== 303 || !cookie)
    throw new Error(`login failed: ${login.status}`);
  return {
    pid: proc.pid,
    exited: proc.exited,
    base,
    cookie,
    started,
    listeningMs,
  };
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * SIGTERM the server, then SIGKILL its group (after `graceMs` at most) until
 * the group is gone. Returns the milliseconds until the server exited.
 */
export async function stopPrivateServer(
  pid: number,
  exited: Promise<number>,
  graceMs = 60_000,
): Promise<number> {
  const started = performance.now();
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exited,
    new Promise((done) => (timer = setTimeout(done, graceMs))),
  ]);
  clearTimeout(timer);
  const stoppedMs = performance.now() - started;
  for (let attempt = 0; groupAlive(pid); attempt++) {
    if (attempt === 250)
      throw new Error(`server process group ${pid} survived SIGKILL`);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    await sleep(20);
  }
  return stoppedMs;
}

async function dataDirGroups(data: string): Promise<Set<number>> {
  const needle = `CHAT_DATA_DIR=${data}\0`;
  const groups = new Set<number>();
  const pgidOf = (stat: string) =>
    Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  const own = pgidOf(await readFile("/proc/self/stat", "utf8"));
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (!(await readFile(`/proc/${name}/environ`, "latin1")).includes(needle))
        continue;
      groups.add(pgidOf(await readFile(`/proc/${name}/stat`, "utf8")));
    } catch {}
  }
  groups.delete(own);
  return groups;
}

/**
 * SIGKILL every process group with members under `data` until none is left;
 * throws if one survives. Returns how many groups were killed.
 */
export async function killDataDirGroups(data: string): Promise<number> {
  const killed = new Set<number>();
  for (let attempt = 0; ; attempt++) {
    const groups = await dataDirGroups(data);
    if (!groups.size) return killed.size;
    if (attempt === 250)
      throw new Error(`process groups survived SIGKILL: ${[...groups]}`);
    for (const group of groups) {
      killed.add(group);
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    await sleep(20);
  }
}
