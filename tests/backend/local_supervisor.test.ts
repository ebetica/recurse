import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect, Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureFixture } from "./fixture_subprocess";
import * as buildStamp from "../../src/build_stamp";
import { STRICT_ISOLATED_PATH_ENV } from "../../src/local_roots";
import { buildFrontend } from "../../src/launcher/build";
import { buildApp, WebLogSink } from "../../src/web/app";
import { appWorld, PASSWORD } from "./web_app_support";
import {
  headSha,
  isRecurseCheckout,
  selfDeployEnabledByEnv,
} from "../../src/launcher/git";
import {
  acquireSupervisorLock,
  LOCK_FD_ENV,
  LOCK_NAME,
} from "../../src/launcher/lock";
import {
  execUpdatedSupervisor,
  spawnServer,
  terminate,
  type ServerChild,
  type TerminateDeps,
} from "../../src/launcher/server_process";
import {
  queryAppStatus,
  sleepInterruptible,
  Supervisor,
  finishSupervisorShutdown,
  type SupervisorDeps,
} from "../../src/launcher/supervisor";
import { closeOnExec, run, TimeoutExpired } from "../../src/launcher/system";
import { gitEnv } from "../../src/workdir_git";
import * as local from "../../src/local";

const ROOT = resolve(import.meta.dir, "../..");
const BUN = process.execPath;
const cleanup: string[] = [];
const previousHarnessEnv = Object.fromEntries(
  [
    "CHAT_DATA_DIR",
    "RECURSE_ISOLATED_DATA_DIR",
    "RECURSE_ISOLATED_ROOT",
    LOCK_FD_ENV,
  ].map((key) => [key, process.env[key]]),
);
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousHarnessEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

const TEST_DATA_DIR = temp("recurse-sup-test-");
process.env.CHAT_DATA_DIR = TEST_DATA_DIR;
process.env.RECURSE_ISOLATED_DATA_DIR = TEST_DATA_DIR;
delete process.env[LOCK_FD_ENV];

async function withEnv<T>(
  values: Record<string, string | undefined>,
  body: () => T | Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]]),
  );
  const apply = (settings: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(settings))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  };
  apply(values);
  try {
    return await body();
  } finally {
    apply(previous);
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await captureFixture(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function moduleEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== LOCK_FD_ENV) env[name] = value;
  return env;
}

const LOCK_MODULE = join(ROOT, "src/launcher/lock.ts");
const CONTEND = `
const { acquireSupervisorLock } = await import(${JSON.stringify(LOCK_MODULE)});
try { await acquireSupervisorLock(process.argv[1]); }
catch (error) { console.error(error.message); process.exit(1); }
`;

async function contend(data: string, env = moduleEnv()) {
  const result = await captureFixture([BUN, "--eval", CONTEND, data], { env });
  return { returncode: result.exitCode, stderr: result.stderr.toString() };
}

class Child implements ServerChild {
  pid = 4242;
  constructor(
    readonly number = 1,
    readonly crashed = false,
    readonly args: unknown[] = [],
  ) {}
  get browserVersion() {
    return this.args[4];
  }
  poll(): number | null {
    return this.crashed ? 7 : null;
  }
  async wait(): Promise<number | null> {
    return 0;
  }
}

test("test_isolated_data_dir_declaration_rejects_ambient_alias", async () => {
  expect(process.env.CHAT_DATA_DIR).toBe(TEST_DATA_DIR);
  const root = temp("recurse-sup-isolation-");
  const live = join(root, "live");
  const isolated = join(root, "isolated");
  mkdirSync(live);
  mkdirSync(isolated);
  writeFileSync(join(live, "marker"), "operator-live");
  await withEnv(
    { CHAT_DATA_DIR: live, RECURSE_ISOLATED_DATA_DIR: isolated },
    async () => {
      await expect(local.configureDataDir(null)).rejects.toThrow(
        "conflicts with RECURSE_ISOLATED_DATA_DIR",
      );
      expect(readdirSync(live)).toEqual(["marker"]);
      delete process.env.RECURSE_ISOLATED_DATA_DIR;
      expect(await local.configureDataDir(null)).toBe(resolve(live));
      delete process.env.CHAT_DATA_DIR;
      process.env.RECURSE_ISOLATED_DATA_DIR = isolated;
      expect(await local.configureDataDir(null)).toBe(resolve(isolated));
    },
  );
});

test("test_strict_cli_target_is_rejected_before_local_startup", async () => {
  const root = temp("recurse-strict-cli-");
  chmodSync(root, 0o700);
  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    RECURSE_ISOLATED_ROOT: root,
  };
  for (const [name, relative] of Object.entries(STRICT_ISOLATED_PATH_ENV)) {
    const path = join(root, relative);
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
    env[name] = path;
  }
  const outside = `${root}-outside`;
  cleanup.push(outside);
  mkdirSync(outside);
  writeFileSync(join(outside, "marker"), "outside");
  const result = await captureFixture(
    [BUN, join(ROOT, "src/local.ts"), "--once", outside],
    {
      cwd: ROOT,
      env,
    },
  );
  const stderr = result.stderr.toString();
  expect([result.exitCode, stderr]).toEqual([2, expect.any(String)]);
  expect(stderr).toContain("CHAT_REPO_URL escapes RECURSE_ISOLATED_ROOT");
  expect(readFileSync(join(outside, "marker"), "utf8")).toBe("outside");
});

test("test_supervisor_lock_rejects_live_owner_but_not_stale_file", async () => {
  await withEnv({ [LOCK_FD_ENV]: undefined }, async () => {
    const data = join(temp("recurse-supervisor-lock-"), "data");
    mkdirSync(data);
    writeFileSync(join(data, LOCK_NAME), "stale bytes from a dead owner");
    const first = await acquireSupervisorLock(data);
    try {
      expect(closeOnExec(first.fd)).toBe(false);
      const contender = await contend(data);
      expect(contender.returncode).not.toBe(0);
      expect(contender.stderr).toContain(
        `live Recurse server (pid ${process.pid})`,
      );
      expect(contender.stderr).toContain(resolve(data));
    } finally {
      first.close();
      delete process.env[LOCK_FD_ENV];
    }
    const replacement = await acquireSupervisorLock(data);
    replacement.close();
    delete process.env[LOCK_FD_ENV];
  });
});

test("test_server_orphan_retains_lock_until_it_exits", async () => {
  const root = temp("recurse-supervisor-orphan-");
  const data = join(root, "data");
  const fakeBun = join(root, "bun");
  writeFileSync(
    fakeBun,
    "#!/bin/sh\nexec sleep 60 </dev/null >/dev/null 2>&1\n",
  );
  chmodSync(fakeBun, 0o755);
  const probe = `
const { acquireSupervisorLock } = await import(${JSON.stringify(LOCK_MODULE)});
const { spawnServer } = await import(${JSON.stringify(join(ROOT, "src/launcher/server_process.ts"))});
const held = await acquireSupervisorLock(process.argv[1]);
const child = await spawnServer(process.cwd(), "127.0.0.1", 1, process.argv[1], null,
  { lockFd: held.fd, bun: process.argv[2] });
console.log(child.pid);
process.exit(0);
`;
  const launcher = await captureFixture([BUN, "--eval", probe, data, fakeBun], {
    cwd: root,
    env: moduleEnv(),
  });
  expect(launcher.exitCode).toBe(0);
  const orphan = Number(launcher.stdout.toString().trim());
  try {
    const contender = await contend(data);
    expect(contender.returncode).not.toBe(0);
    expect(contender.stderr).toContain(`live Recurse server (pid ${orphan})`);
  } finally {
    try {
      process.kill(orphan, "SIGKILL");
    } catch {}
  }
  const deadline = performance.now() + 5000;
  for (;;) {
    const attempt = await contend(data);
    if (attempt.returncode === 0) break;
    expect(performance.now()).toBeLessThan(deadline);
    await Bun.sleep(10);
  }
});

test("test_spawn_server_passes_the_data_dir_lock", async () => {
  const raw = temp("recurse-lock-spawn-");
  await withEnv(
    {
      [LOCK_FD_ENV]: undefined,
      RECURSE_ISOLATED_ROOT: raw,
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      NPM_TOKEN: "npm-secret",
      HF_TOKEN: "hf-secret",
      UNLISTED_PRIVATE_VALUE: "arbitrary-secret",
    },
    async () => {
      const data = join(raw, "data");
      const held = await acquireSupervisorLock(data);
      let captured: {
        argv: string[];
        options: Record<string, unknown>;
      } | null = null;
      const spawn = ((argv: string[], options: Record<string, unknown>) => {
        captured = { argv, options };
        return {
          pid: 777,
          exitCode: null,
          signalCode: null,
          exited: new Promise(() => {}),
        };
      }) as unknown as typeof Bun.spawn;
      await spawnServer(raw, "127.0.0.1", 8787, data, null, {
        lockFd: held.fd,
        bun: BUN,
        spawn,
      });
      const { options } = captured!;
      const env = options.env as Record<string, string>;
      expect(options.stdio).toEqual(["inherit", "inherit", "inherit", held.fd]);
      expect(env[LOCK_FD_ENV]).toBe("3");
      const secrets = [
        "AWS_SECRET_ACCESS_KEY",
        "NPM_TOKEN",
        "HF_TOKEN",
        "UNLISTED_PRIVATE_VALUE",
      ];
      expect(secrets.filter((name) => name in env)).toEqual([]);
      expect(secrets.filter((name) => name in gitEnv(process.env))).toEqual([]);
      expect(readFileSync(join(data, LOCK_NAME), "utf8")).toBe(
        `${process.pid} 777\n`,
      );
      held.close();
    },
  );
});

test("test_supervisor_lock_survives_reexec_without_reacquiring", async () => {
  const root = temp("recurse-supervisor-exec-");
  const data = join(root, "data");
  const script = join(root, "reexec_probe.ts");
  writeFileSync(
    script,
    `
const { acquireSupervisorLock } = await import(${JSON.stringify(LOCK_MODULE)});
const { closeOnExec, execReplacing } = await import(${JSON.stringify(join(ROOT, "src/launcher/system.ts"))});
const data = process.argv[2];
if (process.env.RECURSE_LOCK_REEXEC_STAGE !== "1") {
  const held = await acquireSupervisorLock(data);
  if (closeOnExec(held.fd)) throw new Error("lock is close-on-exec");
  const env = { ...process.env, RECURSE_LOCK_REEXEC_STAGE: "1", REEXEC_PID: String(process.pid) };
  await execReplacing(process.execPath, [process.execPath, import.meta.path, data], env, [held.fd]);
}
if (process.env.REEXEC_PID !== String(process.pid)) throw new Error("pid changed across exec");
const held = await acquireSupervisorLock(data);
try {
  const env = { ...process.env };
  delete env.RECURSE_DATA_DIR_LOCK_FD;
  const { captureFixture } = await import(${JSON.stringify(join(import.meta.dir, "fixture_subprocess.ts"))});
  const contender = await captureFixture([process.execPath, "--eval", ${JSON.stringify(CONTEND)}, data], { env });
  if (contender.exitCode === 0) throw new Error("contender acquired the lock");
  if (!contender.stderr.toString().includes("another live Recurse server")) throw new Error(contender.stderr.toString());
} finally {
  held.close();
}
`,
  );
  const env = moduleEnv();
  delete env.RECURSE_LOCK_REEXEC_STAGE;
  const result = await captureFixture([BUN, script, data], { env });
  expect([result.exitCode, result.stderr.toString()]).toEqual([0, ""]);
});

test("test_recurse_checkout_identity_is_not_src_web_alone", async () => {
  for (const [web, agents, launcher] of [
    ["src/web/app.ts", "src/agents/instance.ts", "src/local.ts"],
  ]) {
    const root = temp("recurse-identity-");
    mkdirSync(dirname(join(root, web!)), { recursive: true });
    writeFileSync(join(root, web!), "");
    expect(await isRecurseCheckout(root)).toBe(false);
    mkdirSync(dirname(join(root, agents!)), { recursive: true });
    writeFileSync(join(root, agents!), "");
    writeFileSync(join(root, "AGENTS.md"), "");
    writeFileSync(join(root, launcher!), "");
    expect(await isRecurseCheckout(root)).toBe(true);
  }
});

test("test_self_deploy_env_flag_spellings", () => {
  expect(selfDeployEnabledByEnv({})).toBe(true);
  for (const [value, expected] of [
    ["on", true],
    ["1", true],
    ["", true],
    ["0", false],
    ["false", false],
    ["no", false],
    ["OFF", false],
  ] as const)
    expect([
      value,
      selfDeployEnabledByEnv({ RECURSE_SELF_DEPLOY: value }),
    ]).toEqual([value, expected]);
});

// Feature: #2539 native frontend builds publish nested stylesheets.
test("native frontend build publishes all HTML and bundle assets", async () => {
  const dependencies = realpathSync(join(ROOT, "node_modules"));
  const sourceRoot = temp("native-assets-source-");
  const dependencyEntries = readdirSync(dependencies).sort();
  const packagePath = join(dependencies, "typescript/package.json");
  const packageMtime = statSync(packagePath).mtimeMs;
  const tracked = await captureFixture(["git", "ls-files", "-z"], {
    cwd: ROOT,
  });
  expect(tracked.exitCode, tracked.stderr.toString()).toBe(0);
  for (const path of tracked.stdout.toString().split("\0").filter(Boolean)) {
    const target = join(sourceRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, path), target);
  }
  symlinkSync(dependencies, join(sourceRoot, "node_modules"), "dir");
  expect(await buildFrontend(sourceRoot, { force: true })).toBe(true);
  expect(readdirSync(dependencies).sort()).toEqual(dependencyEntries);
  expect(statSync(packagePath).mtimeMs).toBe(packageMtime);
  const { root, env } = appWorld();
  const app = await buildApp({
    env,
    sourceRoot,
    sink: new WebLogSink(() => {}),
  });
  const running = await app.serve({ port: 0 });
  try {
    const page = await fetch(running.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    const versionResponse = await fetch(
      new URL("/api/version", running.url).href,
    );
    expect(versionResponse.status).toBe(200);
    const { version } = (await versionResponse.json()) as { version: string };
    const urls = new Set(
      [...html.matchAll(/(?:src|href)="(\/static\/[^\"]+)"/g)].map(
        (match) => match[1]!,
      ),
    );
    for (const name of readdirSync(join(sourceRoot, "web/dist"))) {
      if (!name.endsWith(".js")) continue;
      const bundleUrl = new URL(`/static/${name}`, running.url);
      bundleUrl.searchParams.set("v", version);
      const bundleResponse = await fetch(bundleUrl.href);
      expect(bundleResponse.status, name).toBe(200);
      const bundle = await bundleResponse.text();
      for (const match of bundle.matchAll(
        /["'`](\/static\/[^"'`\s]+\.(?:css|js|woff2?|ttf|svg|png|wasm|mjs))["'`]/g,
      ))
        urls.add(match[1]!);
    }
    for (const url of urls)
      expect((await fetch(new URL(url, running.url).href)).status, url).toBe(
        200,
      );
  } finally {
    await running.close();
    await app.instance.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

function fakeVendorAssets(root: string): void {
  cpSync(join(ROOT, "web/brand"), join(root, "web/brand"), { recursive: true });
  for (const name of new Bun.Glob("**/*.css").scanSync({
    cwd: join(ROOT, "web"),
    onlyFiles: true,
  })) {
    if (name.startsWith("dist/") || name.startsWith("vendor/")) continue;
    const target = join(root, "web", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(ROOT, "web", name), target);
  }
  const dist = join(root, "node_modules/katex/dist");
  mkdirSync(join(dist, "fonts"), { recursive: true });
  writeFileSync(join(dist, "katex.min.css"), ".katex {}");
  writeFileSync(join(dist, "fonts/KaTeX_Main-Regular.woff2"), "font");
  const pdfjs = join(root, "node_modules/pdfjs-dist");
  mkdirSync(join(pdfjs, "legacy/build"), { recursive: true });
  writeFileSync(join(pdfjs, "legacy/build/pdf.worker.min.mjs"), "worker");
  for (const name of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
    mkdirSync(join(pdfjs, name));
    writeFileSync(join(pdfjs, name, "LICENSE"), name);
  }
  writeFileSync(join(pdfjs, "wasm/quickjs-eval.wasm"), "scripting");
  const excalidraw = join(
    root,
    "node_modules/@excalidraw/excalidraw/dist/prod",
  );
  mkdirSync(join(excalidraw, "fonts/Excalifont"), { recursive: true });
  writeFileSync(join(excalidraw, "index.css"), ".excalidraw {}");
  writeFileSync(join(excalidraw, "fonts/Excalifont/Excalifont.woff2"), "ink");
}

test("test_frontend_build_failure_keeps_last_good_and_retries", async () => {
  const root = temp("recurse-build-stage-");
  fakeVendorAssets(root);
  mkdirSync(join(root, "web/dist"), { recursive: true });
  writeFileSync(join(root, "web/app.ts"), "source");
  const styles = ["theme.css", "panes/powerbar.css", "app.css"].map((name) => {
    const text = readFileSync(join(ROOT, "web", name), "utf8");
    writeFileSync(join(root, "web", name), text);
    return text;
  });
  const bundle = join(root, "web/dist/app.js");
  writeFileSync(bundle, "last-good");
  let fail = true;
  const deps = {
    bun: async () => "/fake/bun",
    run: async (argv: readonly string[]) => {
      if (argv[1] === "build") {
        if (fail) return { returncode: 1, stdout: "", stderr: "syntax error" };
        const out = argv[argv.indexOf("--outdir") + 1]!;
        writeFileSync(join(out, "app.js"), "new-good");
      }
      return { returncode: 0, stdout: "", stderr: "" };
    },
  };
  expect(await buildFrontend(root, { force: true, deps })).toBe(false);
  expect(readFileSync(bundle, "utf8")).toBe("last-good");
  fail = false;
  writeFileSync(join(root, "web/app.ts"), "fixed");
  expect(await buildFrontend(root, { force: true, deps })).toBe(true);
  expect(readFileSync(bundle, "utf8")).toBe("new-good");
  const builtCss = readFileSync(join(root, "web/dist/app.css"), "utf8");
  expect(builtCss).not.toContain("@import");
  expect(builtCss).toBe(styles.join(""));
  expect(readFileSync(join(root, "web/dist/katex.css"), "utf8")).toBe(
    ".katex {}",
  );
  expect(
    readFileSync(join(root, "web/dist/fonts/KaTeX_Main-Regular.woff2"), "utf8"),
  ).toBe("font");
  expect(readFileSync(join(root, "web/dist/pdfjs/pdf.worker.js"), "utf8")).toBe(
    "worker",
  );
  expect(readdirSync(join(root, "web/dist/pdfjs")).sort()).toEqual([
    "cmaps",
    "iccs",
    "pdf.worker.js",
    "standard_fonts",
    "wasm",
  ]);
  expect(readdirSync(join(root, "web/dist/pdfjs/wasm"))).toEqual(["LICENSE"]);
  expect(
    readFileSync(join(root, "web/dist/excalidraw/index.css"), "utf8"),
  ).toBe(".excalidraw {}");
  expect(
    readFileSync(
      join(root, "web/dist/excalidraw/fonts/Excalifont/Excalifont.woff2"),
      "utf8",
    ),
  ).toBe("ink");
  expect(
    readdirSync(join(root, "web")).filter((name) =>
      name.startsWith(".recurse-dist"),
    ),
  ).toEqual([]);
});

// Regression: #2901 local updates built by an older supervisor must repair missing brand assets.
test("local launch repairs a stamped frontend without brand assets", async () => {
  const checkout = temp("recurse-brand-checkout-");
  await git(checkout, "clone", "--shared", "--quiet", ROOT, ".");
  for (const name of ["src/build_stamp.ts", "src/launcher/server_process.ts"])
    copyFileSync(join(ROOT, name), join(checkout, name));
  symlinkSync(join(ROOT, "node_modules"), join(checkout, "node_modules"));
  await git(
    checkout,
    "add",
    "src/build_stamp.ts",
    "src/launcher/server_process.ts",
  );
  await git(checkout, "commit", "--allow-empty", "-qm", "test generation");
  for (const previousBuild of [false, true]) {
    if (previousBuild) {
      rmSync(join(checkout, "web/dist/brand"), { recursive: true });
      writeFileSync(
        join(checkout, "web/dist/app.js"),
        "last-good-before-brand",
      );
      expect(buildStamp.write(checkout)).toBe(true);
    }
    const { root, env } = appWorld({ password: true });
    cleanup.push(root);
    const probe = await listening("127.0.0.1");
    const port = portOf(probe);
    await closeServer(probe);
    Object.assign(env, {
      PORT: String(port),
      RECURSE_MANAGED_BUILD_READY: "1",
      RECURSE_ENV_FILE: join(root, "empty.env"),
    });
    writeFileSync(env.RECURSE_ENV_FILE!, "");
    let argv = [BUN, "src/local.ts", "--once"];
    if (previousBuild) {
      const copier = join(checkout, "src/launcher/frontend_assets.ts");
      const updatedCopier = join(root, "frontend_assets.ts");
      copyFileSync(copier, updatedCopier);
      writeFileSync(
        copier,
        `export async function copyFrontendAssets() {
        throw new Error("old supervisor asset copier must not build the updated checkout");
      }`,
      );
      const driver = `
        const runtime = await import("./src/launcher/server_process.ts");
        const { copyFileSync } = await import("node:fs");
        copyFileSync(${JSON.stringify(updatedCopier)}, ${JSON.stringify(copier)});
        if (!await runtime.prepareUpdateRuntime(process.cwd(), ${JSON.stringify(await headSha(checkout))}))
          process.exit(1);
        const local = await import("./src/local.ts");
        await local.main(["--once"]);
      `;
      argv = [BUN, "--eval", driver];
    }
    const child = Bun.spawn(argv, {
      cwd: checkout,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const url = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 60_000;
      while (true) {
        try {
          if ((await fetch(`${url}/`)).status === 401) break;
        } catch {}
        if (child.exitCode !== null || Date.now() >= deadline)
          throw new Error(
            child.exitCode === null
              ? "local launch did not become ready"
              : await errors,
          );
        await Bun.sleep(25);
      }
      const login = await fetch(`${url}/login`, {
        method: "POST",
        body: new URLSearchParams({ password: PASSWORD }),
        redirect: "manual",
      });
      expect(login.status).toBe(303);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      for (const [name, type] of [
        ["favicon.svg", "image/svg+xml"],
        ["favicon-32.png", "image/png"],
        ["apple-touch-icon.png", "image/png"],
        ["mark.svg", "image/svg+xml"],
      ]) {
        const response = await fetch(`${url}/static/brand/${name}`, {
          headers: { cookie },
        });
        expect([
          name,
          response.status,
          response.headers.get("content-type"),
        ]).toEqual([name, 200, type]);
        expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }
    } finally {
      child.kill("SIGINT");
      await child.exited;
      await output;
      await errors;
    }
  }
}, 90_000);

test("test_sleep_interruptible_honors_stop_flag_and_clamps_deadline", async () => {
  const stopping = { flag: false };
  expect(await sleepInterruptible(0.05, stopping)).toBe(false);
  stopping.flag = true;
  expect(await sleepInterruptible(5.0, stopping)).toBe(true);
});

async function listening(
  host: string,
  port = 0,
  onConnection?: (socket: Socket) => void,
) {
  const server = createServer(onConnection);
  await new Promise<void>((done) => server.listen(port, host, () => done()));
  return server;
}

const portOf = (server: Server) => (server.address() as { port: number }).port;
const closeServer = (server: Server) =>
  new Promise<void>((done) => server.close(() => done()));

test("test_resolve_port_reuses_a_freed_port_but_avoids_a_live_listener", async () => {
  const host = "127.0.0.1";
  const held = await listening(host, 0, (socket) => socket.end());
  const port = portOf(held);
  await new Promise<void>((done) => {
    const client = connect(port, host);
    client.on("end", () => {
      client.end();
      done();
    });
    client.resume();
  });
  const chosen = await local.resolvePort(host, port);
  expect(chosen).not.toBe(port);
  expect(chosen).toBeGreaterThan(0);
  await closeServer(held);
  expect(await local.resolvePort(host, port)).toBe(port);
});

test("test_strict_reexec_uses_filtered_environment", async () => {
  const root = temp("recurse-strict-reexec-");
  let captured: {
    executable: string;
    argv: readonly string[];
    env: Record<string, string>;
    keep: readonly number[];
  } | null = null;
  await withEnv(
    {
      RECURSE_ISOLATED_ROOT: root,
      UNLISTED_PRIVATE_VALUE: "must-not-cross-reexec",
      RECURSE_SELF_DEPLOY_REEXEC_SHA: "deadbeef",
      RECURSE_DATA_DIR_LOCK_FD: "17",
    },
    async () => {
      expect(
        await execUpdatedSupervisor(root, "deadbeef", {
          argv: ["--once"],
          execve: async (executable, argv, env, keep) => {
            captured = { executable, argv, env: { ...env }, keep };
            throw new Error("injected exec refusal");
          },
        }),
      ).toBe(false);
    },
  );
  const { env, argv, keep } = captured!;
  expect("UNLISTED_PRIVATE_VALUE" in env).toBe(false);
  expect(env.RECURSE_SELF_DEPLOY_REEXEC_SHA).toBe("deadbeef");
  expect(env.RECURSE_DATA_DIR_LOCK_FD).toBe("17");
  expect(keep).toEqual([17]);
  expect(argv.slice(1)).toEqual([join(root, "src/local.ts"), "--once"]);
});

test("test_resolved_port_survives_reexec_boundary", async () => {
  const host = "127.0.0.1";
  const live = await listening(host);
  const requested = portOf(live);
  await withEnv({ PORT: String(requested) }, async () => {
    try {
      expect(await local.resolveListenPort(host)).toBe(requested);
      expect(process.env.PORT).toBe(String(requested));
      expect(await local.resolveListenPort(host)).toBe(requested);
    } finally {
      await closeServer(live);
    }
  });
});

test("test_failed_final_cleanup_retains_supervisor_ownership", async () => {
  const reconciles = [false, false, true];
  const sleeps: number[] = [];
  await finishSupervisorShutdown(new Child(), "/served", {
    terminate: async () => false,
    reconcile: async () => reconciles.shift()!,
    sleep: async (seconds) => {
      sleeps.push(seconds);
    },
  });
  expect(sleeps).toEqual([1, 1]);
});

function recordingDeps(calls: unknown[], reconciled: boolean): TerminateDeps {
  return {
    getpgid: () => 456,
    killpg: (pgid, signal) => calls.push(["signal", pgid, signal]),
    reconcile: async (code) => {
      calls.push(["reconcile", code]);
      return reconciled;
    },
  };
}

test("test_terminate_live_process_is_graceful_and_reconciles", async () => {
  const calls: unknown[] = [];
  const live: ServerChild = {
    pid: 123,
    poll: () => null,
    wait: async (timeout) => {
      calls.push(["wait", timeout]);
      return 0;
    },
  };
  expect(
    await terminate(live, "/served", 0.5, recordingDeps(calls, true)),
  ).toBe(true);
  expect(calls).toEqual([
    ["signal", 456, "SIGINT"],
    ["wait", 0.5],
    ["reconcile", "/served"],
  ]);
});

test("test_terminate_refuses_overlap_when_registry_cleanup_is_pending", async () => {
  const exited: ServerChild = {
    pid: 123,
    poll: () => null,
    wait: async () => 0,
  };
  const alreadyGone: ServerChild = {
    pid: -1,
    poll: () => 0,
    wait: async () => 0,
  };
  const deps: TerminateDeps = {
    getpgid: () => 456,
    killpg: () => {},
    reconcile: async () => false,
  };
  expect(await terminate(exited, "/served", 0.1, deps)).toBe(false);
  expect(await terminate(alreadyGone, "/served", undefined, deps)).toBe(false);
});

test("test_terminate_refuses_overlap_when_sigkill_does_not_reap", async () => {
  const calls: unknown[] = [];
  const stubborn: ServerChild = {
    pid: 123,
    poll: () => null,
    wait: async (timeout) => {
      calls.push(["wait", timeout]);
      return null;
    },
  };
  const deps = recordingDeps(calls, false);
  expect(await terminate(stubborn, "/served", 0.5, deps)).toBe(false);
  expect(calls).toEqual([
    ["signal", 456, "SIGINT"],
    ["wait", 0.5],
    ["signal", 456, "SIGKILL"],
    ["wait", 0.5],
  ]);
});

function serveStatus(raw: unknown, token: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (
        url.pathname !== "/api/status" ||
        request.headers.get("x-loopback-token") !== token
      )
        return new Response("{}", { status: 401 });
      return new Response(typeof raw === "string" ? raw : JSON.stringify(raw));
    },
  });
}

function writeToken(dataDir: string, token: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "server.json"),
    JSON.stringify({ port: 0, token }),
  );
}

test("test_query_app_status_reports_snapshot_and_unknown", async () => {
  const token = `tok-${"s".repeat(8)}`;
  const data = temp("recurse-status-");
  writeToken(data, token);
  let server = serveStatus({ ready: true, active_agents: 2 }, token);
  try {
    expect(await queryAppStatus(server.port!, data)).toEqual([true, 2]);
  } finally {
    server.stop(true);
  }
  server = serveStatus({ ready: false, active_agents: null }, token);
  try {
    expect(await queryAppStatus(server.port!, data)).toEqual([false, null]);
  } finally {
    server.stop(true);
  }
});

test("test_query_app_status_unknown_is_never_idle", async () => {
  const token = `tok-${"u".repeat(8)}`;
  const data = temp("recurse-status-unknown-");
  writeToken(data, token);
  let server = serveStatus({ ready: true, active_agents: 0 }, "other-token");
  try {
    expect(await queryAppStatus(server.port!, data)).toEqual([null, null]);
  } finally {
    server.stop(true);
  }
  expect(await queryAppStatus(1, data)).toEqual([null, null]);
  expect(await queryAppStatus(1, join(data, "nope"))).toEqual([null, null]);
  server = serveStatus({ ready: true }, token);
  try {
    expect(await queryAppStatus(server.port!, data)).toEqual([true, null]);
  } finally {
    server.stop(true);
  }
  for (const raw of [
    "not json",
    [1, 2],
    { ready: "yes", active_agents: 1 },
    { ready: true, active_agents: true },
    { ready: true, active_agents: -1 },
  ]) {
    server = serveStatus(raw, token);
    try {
      expect([raw, await queryAppStatus(server.port!, data)]).toEqual([
        raw,
        [null, null],
      ]);
    } finally {
      server.stop(true);
    }
  }
});

test("test_query_app_status_redirect_is_unknown_and_token_stays", async () => {
  const token = `tok-${"r".repeat(8)}`;
  const data = temp("recurse-status-redirect-");
  writeToken(data, token);
  const hits: [string, string | null][] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/status")
        return new Response('{"ready": true, "active_agents": 0}', {
          status: 302,
          headers: { location: "/capture" },
        });
      hits.push([url.pathname, request.headers.get("x-loopback-token")]);
      return new Response("{}");
    },
  });
  try {
    expect(await queryAppStatus(server.port!, data)).toEqual([null, null]);
  } finally {
    server.stop(true);
  }
  expect(hits).toEqual([]);
});

test("test_query_app_status_ignores_proxy_environment", async () => {
  const token = `tok-${"p".repeat(8)}`;
  const data = temp("recurse-status-proxy-");
  writeToken(data, token);
  const server = serveStatus({ ready: true, active_agents: 0 }, token);
  const probe = await listening("127.0.0.1");
  const dead = portOf(probe);
  await closeServer(probe);
  const proxy = `http://127.0.0.1:${dead}`;
  try {
    await withEnv(
      {
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        NO_PROXY: undefined,
        no_proxy: "example.com",
      },
      async () => {
        expect(await queryAppStatus(server.port!, data)).toEqual([true, 0]);
      },
    );
  } finally {
    server.stop(true);
  }
});

test("test_build_stamp_clean_match_and_dirty_rebuild", async () => {
  const root = temp("recurse-build-stamp-");
  await git(root, "init", "-b", "main");
  mkdirSync(join(root, "web/dist"), { recursive: true });
  writeFileSync(join(root, "web/app.ts"), "clean\n");
  writeFileSync(join(root, "web/dist/app.js"), "built\n");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "./scripts/ensure-rtk.sh"), "#!/bin/sh\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  const build = join(root, ".recurse");
  expect(buildStamp.matches(root)).toBe(false);
  expect(buildStamp.write(root)).toBe(true);
  expect(buildStamp.matches(root)).toBe(true);
  expect(
    JSON.parse(readFileSync(join(build, ".build-stamp.json"), "utf8")),
  ).toEqual({
    dirty: false,
    frontend: "built",
    head: await headSha(root),
    pi_version: buildStamp.PI_VERSION,
    artifacts: {},
  });
  const artifact = join(root, "node_modules/@ff-labs/pi-fff/src/index.ts");
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, "managed\n");
  expect(buildStamp.write(root)).toBe(true);
  expect(buildStamp.matches(root)).toBe(true);
  writeFileSync(artifact, "tampered-longer\n");
  expect(buildStamp.matches(root)).toBe(false);
  writeFileSync(join(root, "web/app.ts"), "dirty\n");
  expect(buildStamp.matches(root)).toBe(false);
  expect(buildStamp.write(root)).toBe(true);
  expect(
    JSON.parse(readFileSync(join(build, ".build-stamp.json"), "utf8")).dirty,
  ).toBe(true);
  expect(buildStamp.matches(root)).toBe(false);
});

function bareSupervisor(deps: Partial<SupervisorDeps>): Supervisor {
  return new Supervisor("127.0.0.1", 8787, "/data", deps as SupervisorDeps);
}

test("test_ts_server_spawn_keeps_lock_session_and_env", async () => {
  const root = temp("recurse-ts-spawn-");
  const data = join(root, "data");
  await withEnv(
    { [LOCK_FD_ENV]: undefined, PATH: "/usr/bin:/bin" },
    async () => {
      const held = await acquireSupervisorLock(data);
      let captured: {
        argv: string[];
        options: Record<string, unknown>;
      } | null = null;
      const spawn = ((argv: string[], options: Record<string, unknown>) => {
        captured = { argv, options };
        return {
          pid: 778,
          exitCode: null,
          signalCode: null,
          exited: new Promise(() => {}),
        };
      }) as unknown as typeof Bun.spawn;
      await spawnServer(root, "127.0.0.1", 8787, data, "abc123", {
        lockFd: held.fd,
        bun: "/opt/bun-1.4.0/bin/bun",
        spawn,
      });
      const heldFd = held.fd;
      held.close();
      const { argv, options } = captured!;
      expect(argv).toEqual([
        "/opt/bun-1.4.0/bin/bun",
        "src/server.ts",
        "--host",
        "127.0.0.1",
        "--port",
        "8787",
      ]);
      expect(options.cwd).toBe(root);
      expect(options.detached).toBe(true);
      expect(options.stdio).toEqual(["inherit", "inherit", "inherit", heldFd]);
      const env = options.env as Record<string, string>;
      expect(env[LOCK_FD_ENV]).toBe("3");
      expect(env.CHAT_DATA_DIR).toBe(data);
      expect(env.RECURSE_FRONTEND_LIVE).toBe("1");
      expect(env.RECURSE_BROWSER_VERSION).toBe("abc123");
      expect(env.PATH).toBe("/usr/bin:/bin");
    },
  );
});

test("test_ts_server_requires_minimum_bun", async () => {
  expect(() => local.bunGate("1.4.0", "/opt/bun")).not.toThrow();
  expect(() => local.bunGate("1.3.13", "/opt/old-bun")).toThrow(
    /1\.4\.0 or newer.*1\.3\.13/,
  );
  expect(() => local.bunGate("", "/opt/none")).toThrow("reports no version");

  const root = temp("recurse-ts-bun-");
  const data = join(root, "data");
  const deps = local.mainDeps();
  deps.bunVersion = "1.3.13";
  let error: unknown;
  await withEnv(
    { CHAT_DATA_DIR: data, RECURSE_ISOLATED_DATA_DIR: data },
    async () => {
      try {
        await local.main(["--once"], deps);
      } catch (caught) {
        error = caught;
      }
    },
  );
  expect(error).toBeInstanceOf(local.LauncherExit);
  expect((error as local.LauncherExit).code).toBe(2);
  expect((error as Error).message).toContain("needs Bun 1.4.0 or newer");
  expect((error as Error).message).toContain("reports 1.3.13");
  expect(existsSync(join(data, LOCK_NAME))).toBe(false);
});

// Feature: #2502 exec coverage runs without a network clone.
test("test_serve_once_ts_replaces_this_process_with_bun", async () => {
  const root = temp("recurse-ts-once-");
  const data = join(root, "data");
  const probe = join(root, "probe");
  const home = join(root, "home");
  mkdirSync(home);
  const fakeBun = join(root, "bun");
  writeFileSync(
    fakeBun,
    '#!/bin/sh\necho "$$|$(readlink /proc/$$/fd/$RECURSE_DATA_DIR_LOCK_FD)|$PWD|$*" > "$BUN_PROBE_OUT"\n',
  );
  chmodSync(fakeBun, 0o755);
  const driver = `
const local = await import(${JSON.stringify(join(ROOT, "src/local.ts"))});
const { acquireSupervisorLock } = await import(${JSON.stringify(LOCK_MODULE)});
const { execReplacing } = await import(${JSON.stringify(join(ROOT, "src/launcher/system.ts"))});
await acquireSupervisorLock(process.argv[1]);
console.log(process.pid);
const deps = local.mainDeps();
deps.execve = (_bun, argv, env, keep) => execReplacing(process.argv[2], argv, env, keep);
await local.serveOnce("127.0.0.1", 0, true, deps);
`;
  const env = moduleEnv();
  delete env.PI_CODING_AGENT_DIR;
  Object.assign(env, {
    HOME: home,
    CHAT_REPO_URL: root,
    BUN_PROBE_OUT: probe,
    CHAT_DATA_DIR: data,
    RECURSE_ISOLATED_DATA_DIR: data,
  });
  const result = await captureFixture([BUN, "--eval", driver, data, fakeBun], {
    env,
    cwd: root,
  });
  expect([result.exitCode, result.stderr.toString()]).toEqual([
    0,
    expect.any(String),
  ]);
  const [pid, lock, cwd, args] = readFileSync(probe, "utf8").trim().split("|");
  expect(pid).toBe(result.stdout.toString().split(/\s+/)[0]);
  expect(lock).toBe(join(data, LOCK_NAME));
  expect(cwd).toBe(local.HERE);
  expect(args).toBe("src/server.ts --host 127.0.0.1 --port 0");
});

test("run_timeout_is_not_extended_by_a_grandchild_holding_the_pipes", async () => {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const started = performance.now();
  await expect(
    run(["sh", "-c", "sleep 5 & echo held"], { env, timeoutSeconds: 0.5 }),
  ).rejects.toBeInstanceOf(TimeoutExpired);
  console.log("run timeout elapsed ms", performance.now() - started);
  expect(
    await run(["sh", "-c", "echo out; echo err >&2; exit 3"], {
      env,
      timeoutSeconds: 5,
    }),
  ).toEqual({ returncode: 3, stdout: "out\n", stderr: "err\n" });
});

// Regression: #2901 an expired update build must not leave its nested installer running.
test("captured update command kills descendants on timeout", async () => {
  const root = temp("recurse-build-timeout-");
  const pidFile = join(root, "worker.pid");
  const driver = `
    const worker = Bun.spawn(["sleep", "600"], { stdout: "inherit", stderr: "inherit" });
    await Bun.write(${JSON.stringify(pidFile)}, String(worker.pid));
    await worker.exited;
  `;
  await expect(
    run([BUN, "--eval", driver], {
      env: moduleEnv(),
      timeoutSeconds: 1,
      killDescendants: true,
    }),
  ).rejects.toBeInstanceOf(TimeoutExpired);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(pid).toBeGreaterThan(0);
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      const status = await Bun.file(`/proc/${pid}/stat`)
        .text()
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
      if (!status || status.slice(status.lastIndexOf(")") + 2).startsWith("Z"))
        break;
      if (Date.now() >= deadline)
        throw new Error(`build worker ${pid} survived timeout`);
      await Bun.sleep(10);
    }
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
});

test("a generation restart starts the new server only after the old one exited", async () => {
  const actions: string[] = [];
  let exit!: (stopped: boolean) => void;
  const supervisor = bareSupervisor({
    reloadGate: async () => [true, 0],
    terminate: () =>
      new Promise<boolean>((resolve) => {
        actions.push("stop requested");
        exit = (stopped) => {
          actions.push("old server exited");
          resolve(stopped);
        };
      }),
    execUpdatedSupervisor: async () => {
      actions.push("exec");
      return true;
    },
  });
  const arm = () => {
    supervisor.pendingReexecSha = "b".repeat(40);
    supervisor.pendingSince = 1;
    supervisor.child = new Child();
    supervisor.codeDir = "/served";
  };
  arm();
  const refused = supervisor.fireUpdateIfReady(2);
  await Bun.sleep(10);
  expect(actions).toEqual(["stop requested"]);
  exit(false);
  await refused;
  expect(actions).toEqual(["stop requested", "old server exited"]);
  actions.length = 0;
  arm();
  const fired = supervisor.fireUpdateIfReady(3);
  await Bun.sleep(10);
  expect(actions).toEqual(["stop requested"]);
  exit(true);
  await fired;
  expect(actions).toEqual(["stop requested", "old server exited", "exec"]);
});
