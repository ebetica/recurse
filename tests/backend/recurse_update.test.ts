import { afterAll, expect, test } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureFixture } from "./fixture_subprocess";

const ROOT = join(import.meta.dir, "../..");
const PASSWORD = "update-test-password-1";
const SALT = "00112233445566778899aabbccddeeff";
const GIT_ID = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const TEXT =
  chunk({ role: "assistant", content: "scripted reply" }) +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

let hold = true;
let requests = 0;
let release: () => void = () => {};
const provider = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request) {
    await request.text();
    requests++;
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    return new Response(TEXT, {
      headers: { "Content-Type": "text/event-stream" },
    });
  },
});
const root = mkdtempSync(join(tmpdir(), "recurse-update-"));
afterAll(() => {
  release();
  provider.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await captureFixture(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH!, HOME: join(root, "home"), ...GIT_ID },
  });
  expect([args, result.exitCode, result.stderr.toString()]).toEqual([
    args,
    0,
    expect.any(String),
  ]);
  return result.stdout.toString().trim();
}

async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  ms = 240_000,
): Promise<T> {
  const deadline = performance.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (performance.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(100);
  }
}

async function publish(dev: string, version: string): Promise<void> {
  const manifest = join(dev, "package.json");
  writeFileSync(
    manifest,
    readFileSync(manifest, "utf8").replace(
      /"version": "[^"]+"/,
      `"version": "${version}"`,
    ),
  );
  await git(dev, "commit", "-q", "-am", `Recurse v${version}`);
  await git(dev, "tag", `v${version}`);
  await git(dev, "push", "-q", "origin", "main", `v${version}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (response: Response): Promise<any> => response.json();

async function dataDirGroups(dataDir: string): Promise<number[]> {
  const groups = new Set<number>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const environ = await readFile(`/proc/${name}/environ`, "latin1");
      if (!environ.includes(`CHAT_DATA_DIR=${dataDir}\0`)) continue;
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      groups.add(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]));
    } catch {}
  }
  return [...groups];
}

// Feature: #2897 Settings "Update now" restarts a supervised install into the newest release and keeps its run.
test("Update now moves a release install to the next tag, restarts it and keeps its run", async () => {
  const dev = join(root, "dev");
  const tracked = await captureFixture(
    ["git", "ls-files", "-z", "-co", "--exclude-standard"],
    { cwd: ROOT },
  );
  for (const path of tracked.stdout.toString().split("\0").filter(Boolean)) {
    const target = join(dev, path);
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(join(ROOT, path), target);
    } catch {}
  }
  await git(dev, "init", "-q", "-b", "main");
  await git(dev, "add", "-A");
  await git(dev, "commit", "-q", "-m", "seed");
  const origin = join(root, "origin.git");
  await git(root, "init", "-q", "--bare", origin);
  await git(dev, "remote", "add", "origin", origin);
  await publish(dev, "0.0.1");

  const home = join(root, "home");
  const install = join(root, "recurse");
  const installed = await captureFixture(["bash", join(ROOT, "install.sh")], {
    cwd: root,
    env: {
      PATH: process.env.PATH!,
      HOME: home,
      RECURSE_REPO: origin,
      RECURSE_INSTALL_DIR: install,
      RECURSE_BIN_DIR: join(home, "bin"),
      ...GIT_ID,
    },
  });
  expect([installed.exitCode, installed.stderr.toString()]).toEqual([
    0,
    expect.stringContaining("cloning recurse v0.0.1"),
  ]);
  symlinkSync(
    realpathSync(join(ROOT, "node_modules")),
    join(install, "node_modules"),
  );

  const data = join(root, "data");
  const target = join(root, "target");
  mkdirSync(join(data, "config"), { recursive: true });
  mkdirSync(target, { recursive: true });
  const level = { model: "recurse-test/scripted", reasoning: "low" };
  writeFileSync(
    join(data, "config", "effort-levels.json"),
    JSON.stringify({
      default_level: 3,
      levels: { 1: level, 2: level, 3: level, 4: level, 5: level },
      version: 1,
    }),
  );
  writeFileSync(
    join(data, "config", "model-providers.json"),
    JSON.stringify({
      default: "recurse-test/scripted",
      providers: {
        "recurse-test": {
          base_url: `http://127.0.0.1:${provider.port}/v1`,
          env_key: "RECURSE_TEST_KEY",
          wire_api: "completions",
          models: [{ id: "scripted", context_window: 100000 }],
        },
      },
    }),
  );
  const hash = pbkdf2Sync(
    PASSWORD,
    new Uint8Array(Buffer.from(SALT, "hex")),
    600_000,
    32,
    "sha256",
  ).toString("hex");
  const env: Record<string, string> = {
    PATH: process.env.PATH!,
    HOME: home,
    CHAT_DATA_DIR: data,
    RECURSE_HOME: join(root, "settings"),
    RECURSE_TEST_KEY: "loopback-only",
    PI_BG_SHELL: "0",
    CHAT_AUTH_SALT: SALT,
    CHAT_AUTH_HASH: hash,
    PORT: "0",
    RECURSE_UPDATE_POLL_SECONDS: "0.5",
    ...GIT_ID,
  };
  const log = join(root, "recurse.log");
  const supervisor = Bun.spawn([process.execPath, "src/local.ts", target], {
    cwd: install,
    env,
    stdout: Bun.file(log),
    stderr: Bun.file(log),
    detached: true,
  });
  try {
    const base = await until(
      async () =>
        (await readFile(log, "utf8")).match(
          /recurse server listening on (http:\/\/127\.0\.0\.1:\d+)/,
        )?.[1],
    );
    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { cookie, "content-type": "application/json" },
      });
    const updateStatus = async () => json(await api("/api/settings/update"));
    const version = async () =>
      (await json(await api("/api/version"))).release.version;

    const checked = await until(async () => {
      const status = await updateStatus();
      return !status.checking && status.installed ? status : null;
    });
    expect(checked).toMatchObject({
      skipped: null,
      error: null,
      channel: "release",
      installed: "v0.0.1",
      available: "v0.0.1",
      release: { version: "0.0.1" },
    });
    expect(
      (
        await fetch(`${base}/api/settings/update`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-recurse-agent": "a1",
            cookie,
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);

    await until(() =>
      api("/api/status").then(async (r) => (await json(r)).ready),
    );
    const cid = (
      await json(
        await api("/api/conversations", { method: "POST", body: "{}" }),
      )
    ).id as string;
    const sent = await api(`/api/conversations/${cid}/deliver`, {
      method: "POST",
      body: JSON.stringify({ content: "hello across the update" }),
    });
    expect(sent.status).toBe(200);
    await until(async () => requests > 0);

    await publish(dev, "0.0.2");
    writeFileSync(join(install, "package.json"), "{}\n");
    expect(
      (await api("/api/settings/update", { method: "POST", body: "{}" }))
        .status,
    ).toBe(202);
    const failed = await until(async () => {
      const status = await updateStatus();
      return status.update?.state === "failed" ? status.update : null;
    });
    expect(failed.detail).toContain("would be overwritten");
    expect(await version()).toBe("0.0.1");
    await git(install, "checkout", "--", "package.json");

    expect(
      (await api("/api/settings/update", { method: "POST", body: "{}" }))
        .status,
    ).toBe(202);
    const waiting = await until(async () => {
      const { update } = await updateStatus();
      return ["waiting", "failed"].includes(update?.state) ? update : null;
    });
    expect(waiting).toEqual({ state: "waiting", detail: "1" });
    expect(await version()).toBe("0.0.1");
    expect(await git(install, "describe", "--tags")).toBe("v0.0.2");

    const calls = join(root, "install-calls");
    writeFileSync(
      join(install, "install.sh"),
      `echo "$1" >> ${calls}\nsleep 600\n`,
    );
    hold = false;
    release();
    await until(async () => (await version()) === "0.0.2");
    expect(await updateStatus()).toMatchObject({
      checking: true,
      release: { version: "0.0.2" },
      update: null,
    });
    await until(() =>
      api(`/api/conversations/${cid}/view`).then(async (r) =>
        (await r.text()).includes("scripted reply"),
      ),
    );
    expect(
      (await api("/api/settings/update", { method: "POST", body: "{}" }))
        .status,
    ).toBe(202);
    await until(async () =>
      existsSync(calls)
        ? (await readFile(calls, "utf8")).split("\n").sort().join(" ") ===
          " --check --update"
        : false,
    );
  } finally {
    release();
    supervisor.kill("SIGTERM");
    expect(await supervisor.exited, await readFile(log, "utf8")).toBe(0);
  }
  await until(async () => (await dataDirGroups(data)).length === 0, 30_000);
}, 600_000);
