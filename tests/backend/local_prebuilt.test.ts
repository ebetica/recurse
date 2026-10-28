import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RootError } from "../../src/local_roots";
import { acquireSupervisorLock, LOCK_FD_ENV } from "../../src/launcher/lock";
import * as local from "../../src/local";
import { captureFixture } from "./fixture_subprocess";

let root: string;
let source: string;
let state: string;
let data: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "recurse-prebuilt-"));
  source = join(root, "source");
  state = join(root, "state");
  data = join(root, "data");
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, {
    HOME: root,
    PATH: "/usr/bin:/bin",
    RECURSE_HOME: state,
    CHAT_DATA_DIR: data,
    CHAT_REPO_URL: root,
    RECURSE_BROWSER_VERSION: "image-build-123",
    RECURSE_ENV_FILE: join(root, "empty.env"),
  });
  writeFileSync(join(root, "empty.env"), "");
  for (const name of local.PREBUILT_ARTIFACTS) {
    const path = join(source, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "built artifact");
    chmodSync(path, 0o700);
  }
});

afterEach(() => {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

test("test_missing_artifact_fails_without_repair", async () => {
  await local.validatePrebuiltArtifacts(source);
  for (const name of [
    "src/auth/anthropic_oauth.ts",
    "node_modules/@ff-labs/pi-fff/src/index.ts",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
  ]) {
    const missing = join(source, name);
    unlinkSync(missing);
    const refused = local.validatePrebuiltArtifacts(source);
    await expect(refused).rejects.toThrow("missing prebuilt");
    await expect(refused).rejects.toBeInstanceOf(RootError);
    expect(existsSync(missing)).toBe(false);
    writeFileSync(missing, "built artifact");
  }
});

test("test_requires_explicit_state", async () => {
  delete process.env.RECURSE_HOME;
  await expect(local.validatePrebuiltArtifacts(source)).rejects.toThrow(
    "RECURSE_HOME",
  );
});

test("test_prebuilt_implies_once_and_preserves_admission", async () => {
  const deps = local.mainDeps();
  const forbidden = (name: string) => async () => {
    throw new Error(`AssertionError: ${name}`);
  };
  deps.validatePrebuiltArtifacts = () =>
    local.validatePrebuiltArtifacts(source);
  deps.resolveListenPort = async () => 8787;
  deps.buildCurrentGeneration = forbidden("buildCurrentGeneration");
  deps.supervise = forbidden("Supervisor");
  deps.execve = async () => {
    const inherited = process.env[LOCK_FD_ENV];
    delete process.env[LOCK_FD_ENV];
    try {
      await expect(acquireSupervisorLock(data)).rejects.toThrow("another live");
    } finally {
      process.env[LOCK_FD_ENV] = inherited;
    }
    return undefined as never;
  };
  const spawns = [
    // test-check-allow: T3 Fail-fast gate; zero calls prove no async subprocess.
    spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("AssertionError: subprocess");
    }),
    // test-check-allow: T3 Fail-fast gate; zero calls prove no sync subprocess.
    spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("AssertionError: subprocess");
    }),
  ];
  const cwd = process.cwd();
  try {
    await local.main(["--prebuilt"], deps);
    for (const spy of spawns) expect(spy).not.toHaveBeenCalled();
  } finally {
    process.chdir(cwd);
    for (const spy of spawns) spy.mockRestore();
  }
  delete process.env[LOCK_FD_ENV];
  (await acquireSupervisorLock(data)).close();
});

test("test_prebuilt_clones_a_missing_url_target_before_serving", async () => {
  const origin = join(root, "origin");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await captureFixture(["git", ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  mkdirSync(origin);
  await git(origin, "init", "-q");
  writeFileSync(join(origin, "README"), "target");
  await git(origin, "add", "README");
  await git(
    origin,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "x",
  );
  process.env.CHAT_REPO_URL = `file://${origin}`;
  const clone = join(data, "repo");
  let served = 0;
  const deps = local.mainDeps();
  deps.validatePrebuiltArtifacts = () =>
    local.validatePrebuiltArtifacts(source);
  deps.resolveListenPort = async () => 8787;
  deps.buildCurrentGeneration = async () => {
    throw new Error("AssertionError: buildCurrentGeneration");
  };
  deps.execve = async () => {
    served += 1;
    expect(existsSync(join(clone, ".git"))).toBe(true);
    expect(await git(clone, "remote", "get-url", "origin")).toBe(
      `file://${origin}`,
    );
    return undefined as never;
  };
  const cwd = process.cwd();
  try {
    await local.main(["--prebuilt"], deps);
  } finally {
    process.chdir(cwd);
  }
  expect(served).toBe(1);
  expect(existsSync(join(clone, "README"))).toBe(true);
});

test("test_isolation_denial_precedes_artifact_access", async () => {
  let artifacts = 0;
  const deps = local.mainDeps();
  deps.validateLaunchEnvironment = () => {
    throw new RootError("unsafe launch");
  };
  deps.validatePrebuiltArtifacts = async () => {
    artifacts += 1;
  };
  let raised: unknown;
  try {
    await local.main(["--prebuilt"], deps);
  } catch (error) {
    raised = error;
  }
  expect(raised).toBeInstanceOf(local.LauncherExit);
  expect((raised as local.LauncherExit).code).toBe(2);
  expect(artifacts).toBe(0);
});
