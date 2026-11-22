import { afterAll, expect, test } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captureFixture } from "./fixture_subprocess";
import { linkDependencies } from "./linked_dependencies";

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
const PROMPT = "hello across the update";
const REPLY = "scripted reply";
const replyGate = Promise.withResolvers<void>();
let requests = 0;
const provider = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request) {
    const body = await request.text();
    const naming = body.includes("Name the conversation from the message.");
    if (!naming && body.includes(PROMPT)) {
      requests++;
      await replyGate.promise;
    }
    const text = naming ? "Update test" : REPLY;
    return new Response(
      chunk({ role: "assistant", content: text }) +
        chunk({}, "stop") +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  },
});
const root = mkdtempSync(join(tmpdir(), "recurse-update-"));
afterAll(() => {
  replyGate.resolve();
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

// Regression: #3548 (#2897) Update now restarts before a held reply finishes and startup resumes it.
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
  linkDependencies(install);

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
      body: JSON.stringify({ content: PROMPT }),
    });
    expect(sent.status).toBe(200);
    await until(async () => requests > 0);
    const view = async () =>
      (await json(await api(`/api/conversations/${cid}/view`))) as {
        turn_status: string;
        blocks: { role: string; origin: string; text: string }[];
      };
    expect((await view()).turn_status).toBe("running");

    await publish(dev, "0.0.2");
    expect(await updateStatus()).toMatchObject({
      checking: false,
      available: "v0.0.1",
      checked_at: checked.checked_at,
    });
    const checkCalls = join(root, "check-calls");
    const resume = join(root, "resume-check");
    const script = join(install, "install.sh");
    const savedScript = join(install, "install-check-fixture.sh");
    copyFileSync(script, savedScript);
    writeFileSync(
      script,
      `printf '%s\\n' "$@" >> '${checkCalls}'\n` +
        `while [ ! -f '${resume}' ]; do sleep 0.05; done\n` +
        `exec bash '${savedScript}' "$@"\n`,
    );
    try {
      const responses = await Promise.all(
        [1, 2].map(() => api("/api/settings/update/check", { method: "POST" })),
      );
      expect(responses.map((r) => r.status)).toEqual([202, 202]);
      for (const response of responses)
        expect(await json(response)).toMatchObject({
          checking: true,
          update: null,
        });
      writeFileSync(resume, "");
      const refreshed = await until(async () => {
        const status = await updateStatus();
        return status.checking ? null : status;
      });
      expect(refreshed).toMatchObject({
        installed: "v0.0.1",
        available: "v0.0.2",
        update: null,
      });
      expect(await readFile(checkCalls, "utf8")).toBe("--check\n");
    } finally {
      writeFileSync(resume, "");
      copyFileSync(savedScript, script);
      unlinkSync(savedScript);
    }
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
    const restart = await until(async () => {
      const output = await readFile(log, "utf8");
      return /re-executing supervisor|redeploy pending/.test(output)
        ? output
        : null;
    });
    expect(restart).toContain("re-executing supervisor");
    expect(restart).toContain("server exited with code 0");
    await until(async () => (await version()) === "0.0.2");
    expect(await git(install, "describe", "--tags")).toBe("v0.0.2");
    await until(async () => requests >= 2);
    replyGate.resolve();
    const settled = await until(async () => {
      const page = await view();
      return page.turn_status === "idle" &&
        page.blocks.some(
          (row) => row.role === "assistant" && row.text === REPLY,
        )
        ? page
        : null;
    });
    expect(
      settled.blocks
        .filter((row) => row.role === "user" || row.role === "assistant")
        .map(({ role, origin, text }) => ({ role, origin, text })),
    ).toEqual([
      {
        role: "user",
        origin: "operator",
        text: `[recurse-origin: operator]\n${PROMPT}`,
      },
      { role: "assistant", origin: "assistant", text: REPLY },
    ]);
    expect(requests).toBe(2);

    const current = await until(async () => {
      const status = await updateStatus();
      return !status.checking && status.installed ? status : null;
    });
    expect(current).toMatchObject({
      installed: "v0.0.2",
      release: { version: "0.0.2" },
      update: null,
    });
    const calls = join(root, "install-calls");
    writeFileSync(
      join(install, "install.sh"),
      `echo "$1" >> ${calls}\nsleep 600\n`,
    );
    expect(
      (await api("/api/settings/update/check", { method: "POST" })).status,
    ).toBe(202);
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
    replyGate.resolve();
    supervisor.kill("SIGTERM");
    expect(await supervisor.exited, await readFile(log, "utf8")).toBe(0);
  }
  await until(async () => (await dataDirGroups(data)).length === 0, 30_000);
}, 600_000);
