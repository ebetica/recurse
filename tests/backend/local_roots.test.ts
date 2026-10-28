import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ISOLATED_PATH_ENV,
  isolatedSubprocessEnvironment,
  preparePiAgentDir,
  resolveRoots,
  validateIsolatedPath,
} from "../../src/local_roots";
import fixture from "./fixtures/local_roots/cases.json";

interface Case {
  fn: string;
  env: Record<string, string>;
  value?: string;
  name?: string;
  repeat?: number;
}

const cases = fixture.cases as unknown as Case[];
const temp = mkdtempSync(
  join(realpathSync(process.env.TMPDIR ?? "/tmp"), "local-roots-ts-"),
);
const isolated = join(temp, "isolated");
const outside = join(temp, "outside");
const openRoot = join(temp, "isolated-open");
const isolatedLink = join(temp, "isolated-link");
const stateTarget = join(temp, "state-target");
const lockPath = join(isolated, "data", ".recurse-supervisor.lock");

mkdirSync(isolated, { mode: 0o700 });
chmodSync(isolated, 0o700);
mkdirSync(join(isolated, "data"));
writeFileSync(lockPath, "", { mode: 0o600 });
chmodSync(lockPath, 0o600);
mkdirSync(outside);
mkdirSync(join(outside, "agent"));
mkdirSync(join(outside, "nested"));
mkdirSync(openRoot, { mode: 0o755 });
chmodSync(openRoot, 0o755);
mkdirSync(stateTarget);
mkdirSync(join(stateTarget, "pi-agent"));
symlinkSync(join(outside, "agent"), join(stateTarget, "escaped-agent"), "dir");
symlinkSync(stateTarget, join(temp, "state-link"), "dir");
symlinkSync(outside, join(isolated, "data-link"), "dir");
symlinkSync(join(outside, "nested"), join(isolated, "link"), "dir");
symlinkSync(join(isolated, "loop"), join(isolated, "loop"));
mkdirSync(join(isolated, "nested"));
symlinkSync(join(isolated, "nested", "loop"), join(isolated, "nested", "loop"));
symlinkSync(isolated, isolatedLink, "dir");

function materialize(value: string): string {
  return value.replaceAll("$TMP", temp);
}

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(temp, "$TMP");
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, part]) => [key, normalize(part)]),
    );
  }
  return value;
}

async function outputFor(c: Case): Promise<unknown> {
  const env = Object.fromEntries(
    Object.entries(c.env).map(([name, raw]) => [name, materialize(raw)]),
  );
  if (
    c.fn === "validate_isolated_environment" ||
    c.fn === "validate_launch_environment"
  ) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/local_roots/validate.ts"),
        JSON.stringify({ ...c, env }),
        lockPath,
      ],
      { env: {}, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return normalize(JSON.parse(stdout));
  }
  try {
    switch (c.fn) {
      case "validate_isolated_path":
        validateIsolatedPath(materialize(c.value!), c.name!, env);
        return null;
      case "isolated_subprocess_environment":
        return normalize(isolatedSubprocessEnvironment(env));
      default:
        throw new Error(`unknown local_roots fixture function ${c.fn}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "RootError") {
      return normalize({ error: error.message });
    }
    if (error instanceof Error && error.name === "RuntimeError") {
      return normalize({ runtime_error: error.message });
    }
    throw error;
  }
}

afterAll(() => rmSync(temp, { recursive: true, force: true }));

for (const fn of [
  "validate_isolated_environment",
  "validate_isolated_path",
  "validate_launch_environment",
  "isolated_subprocess_environment",
]) {
  test(`${fn} enforces current launch isolation`, async () => {
    const accepted = new Set([
      cases[0],
      cases[1],
      cases[17],
      cases[19],
      cases[20],
      cases[21],
      cases[29],
      cases[39],
    ]);
    for (const c of cases.filter((c) => c.fn === fn)) {
      const got = (await outputFor(c)) as Record<string, unknown> | null;
      if (fn === "isolated_subprocess_environment") {
        if (c.env.RECURSE_ISOLATED_ROOT) {
          expect(got!.OPENAI_API_KEY).toBeUndefined();
          expect(got!.SECRET).toBeUndefined();
          expect(got!.CUSTOM_FD).toBeUndefined();
          for (const name of Object.keys(ISOLATED_PATH_ENV))
            expect(got![name]).toBe(c.env[name]);
        } else {
          expect(got!.HOME).toBe(c.env.HOME);
          expect(got!.PATH).toBe(c.env.PATH);
        }
      } else if (accepted.has(c)) {
        expect(got?.error ?? got?.runtime_error ?? null).toBeNull();
      } else {
        expect(typeof (got?.error ?? got?.runtime_error)).toBe("string");
      }
    }
  });
}

// Regression: #2585 launch fixtures must not inspect the test runner's descriptors.
test("launch fixtures ignore descriptors held by the test runner", async () => {
  const fd = openSync(lockPath, "r");
  try {
    const child = spawn(
      process.execPath,
      [
        "test",
        "--test-name-pattern",
        "validate_.*environment enforces",
        import.meta.path,
      ],
      { env: {}, stdio: ["ignore", "pipe", "pipe", fd] },
    );
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr!.on("data", (chunk) => {
      output += chunk.toString();
    });
    const [code] = await once(child, "close");
    expect({ code, output: code === 0 ? "" : output }).toEqual({
      code: 0,
      output: "",
    });
  } finally {
    closeSync(fd);
  }
});

// Feature: #2737 isolation names an inherited non-close-on-exec fd
test("isolated validation names an inherited descriptor without close-on-exec", async () => {
  const c = cases[1]!;
  const env = Object.fromEntries(
    Object.entries(c.env).map(([name, raw]) => [name, materialize(raw)]),
  );
  const fd = openSync(lockPath, "r");
  try {
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dir, "fixtures/local_roots/validate.ts"),
        JSON.stringify({ ...c, env }),
        lockPath,
      ],
      { env: {}, stdio: ["ignore", "pipe", "pipe", fd] },
    );
    let stdout = "";
    child.stdout!.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    const [code] = await once(child, "close");
    expect({ code, output: JSON.parse(stdout) }).toEqual({
      code: 0,
      output: {
        error:
          "isolated launch inherited credentials or file descriptors: fd:3",
      },
    });
  } finally {
    closeSync(fd);
  }
});

test("preparePiAgentDir makes fresh private leaves and wraps OS errors", async () => {
  const expectedRoots = new Map<Case, readonly [string, string]>([
    [cases[3]!, ["xdg/recurse", "xdg/recurse/pi-agent"]],
    [
      cases[4]!,
      ["fixture-home/.config/recurse", "fixture-home/.config/recurse/pi-agent"],
    ],
    [cases[5]!, ["state", "state/custom-agent"]],
    [cases[6]!, ["state", "state/..agent"]],
    [cases[7]!, ["state-target", "state-target/pi-agent"]],
    [
      cases[10]!,
      ["fixture-home/tilde-state", "fixture-home/tilde-state/pi-agent"],
    ],
  ]);
  for (const c of cases.filter((c) => c.fn === "resolve_roots")) {
    const env = Object.fromEntries(
      Object.entries(c.env).map(([name, value]) => [name, materialize(value)]),
    );
    const expected = expectedRoots.get(c);
    if (!expected) {
      expect(() => resolveRoots(env)).toThrow();
      continue;
    }
    const resolved = resolveRoots(env);
    expect(resolved).toEqual({
      state: join(temp, expected[0]),
      piAgent: join(temp, expected[1]),
    });
    await preparePiAgentDir(resolved);
    expect(statSync(resolved.state).isDirectory()).toBe(true);
    expect(statSync(resolved.piAgent).isDirectory()).toBe(true);
  }
  const base = join(temp, "prepare");
  const roots = {
    state: join(base, "state"),
    piAgent: join(base, "state", "pi"),
  };
  await preparePiAgentDir(roots);
  expect(statSync(roots.state).mode & 0o777).toBe(0o700);
  expect(statSync(roots.piAgent).mode & 0o777).toBe(0o700);
  chmodSync(roots.piAgent, 0o755);
  await preparePiAgentDir(roots);
  expect(statSync(roots.piAgent).mode & 0o777).toBe(0o755);
  const blocked = join(base, "file");
  writeFileSync(blocked, "");
  const error = await preparePiAgentDir({
    state: base,
    piAgent: join(blocked, "pi"),
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe("RootError");
  expect((error as Error).message).toStartWith(
    `unsafe PI_CODING_AGENT_DIR ${join(blocked, "pi")}: `,
  );
});
