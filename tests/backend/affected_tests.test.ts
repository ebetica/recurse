import { expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { retire } from "../../src/utils/trash";
import { captureFixture } from "./fixture_subprocess";

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(import.meta.dir, "fixtures/affected_tests");
setDefaultTimeout(60_000);

async function affected(
  fixture: string,
  map = "no-map.json",
): Promise<string[]> {
  const run = await captureFixture(
    [
      "bun",
      "tests/dev/affected_tests.ts",
      "--diff",
      join(FIXTURES, fixture),
      "--map",
      join(FIXTURES, map),
    ],
    { cwd: ROOT, timeoutMs: 50_000 },
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().trim().split("\n");
}

async function blame(group: string, fixtures: string[]): Promise<string[]> {
  const run = await captureFixture(
    [
      "bun",
      "tests/dev/affected_tests.ts",
      "blame",
      group,
      "--map",
      join(FIXTURES, "coverage_map.json"),
      ...fixtures.flatMap((fixture) => ["--diff", join(FIXTURES, fixture)]),
    ],
    { cwd: ROOT, timeoutMs: 50_000 },
  );
  expect(run.exitCode).toBe(0);
  return run.stdout
    .toString()
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split("  # ")[0]!);
}

function groups(lines: string[]): string[] | "all" {
  if (lines.includes("bun run test:browser")) return "all";
  const line = lines.find((entry) =>
    entry.startsWith("bun tests/mobile_browser/index.ts "),
  );
  return line ? line.split(" ").slice(2) : [];
}

test("recorded provider changes select the routine check group", async () => {
  const lines = await affected("provider-replay.diff");
  expect(lines).toContain("tests/check.sh provider");
  expect(lines.find((line) => line.startsWith("bun test --timeout"))).toContain(
    "./tests/backend/provider_e2e.test.ts",
  );
});

// Feature: #2370 dependency planning reaches tests through transitive theme imports.
test("a theme change reaches tests that import it through another module", async () => {
  const lines = await affected("pr2370.diff");
  const backend = lines.find((line) =>
    line.startsWith("bun test --timeout 30000 "),
  );
  expect(backend?.split(" ")).toContain(
    "./tests/backend/artifact_theme.test.ts",
  );
  expect(backend?.split(" ")).toContain("./tests/backend/themes.test.ts");
  expect(lines).toContain("bun run test:browser");
});

test("a change to one browser test file runs only its group", async () => {
  const lines = await affected("pr2363.diff");
  expect(lines.filter((line) => line.includes("mobile_browser"))).toEqual([
    "bun tests/mobile_browser/index.ts header",
  ]);
  expect(lines).not.toContain("bun run test:browser");
});

// Regression: #2273 changed src/pi_auth_worker.mjs, which src/auth/oauth.ts starts by joining its file name to a directory.
test("a worker a module starts by file name reaches that module's tests", async () => {
  const backend = (await affected("pr2273-worker.diff")).find((line) =>
    line.startsWith("bun test --timeout 30000 "),
  );
  expect(backend?.split(" ")).toContain("./tests/backend/oauth_auth.test.ts");
  expect(backend?.split(" ")).toContain(
    "./tests/backend/provider_auth.test.ts",
  );
});

// Feature: #2354 attachment touch-target changes select image-drawing browser coverage.
test("a changed close-button rule reaches the group that taps chip previews", async () => {
  const lines = await affected("pr2354.diff.gz", "coverage_map.json");
  expect(groups(lines)).toContain("image-drawing");
  expect(groups(lines)).not.toBe("all");
});

// Feature: #2377 font-size changes select selection-comment browser coverage.
test("a font-size change reaches the group that measures the selection offer", async () => {
  const lines = await affected("pr2377.diff.gz", "coverage_map.json");
  expect(groups(lines)).toContain("selection-comments");
});

// Regression: #2413 show server coverage alongside child-process uncertainty.
test("a theme function every group's server ran runs the whole suite", async () => {
  const lines = await affected("pr2370-full.diff.gz", "coverage_map.json");
  const note = lines.find((line) => line.startsWith("# src/themes.ts: "));
  expect(note?.split("-> ")[1]?.split(" ")).toContain("themes");
  expect(lines).toContain(
    "# browser: src/themes.ts may run in a worker or child process, which server coverage does not see",
  );
  expect(groups(lines)).toBe("all");
});

test("blame names only the commit whose changes the failing group ran", async () => {
  expect(
    await blame("artifact-check", [
      "pr2354.diff.gz",
      "pr2377.diff.gz",
      "pr2370-full.diff.gz",
    ]),
  ).toEqual([
    "pr2370-full",
    "# ruled out 2 of 3: artifact-check ran none of their changes",
  ]);
});

// Feature: #2406 dependency planning maps keyframes and modules through their recorded importers.
test("a changed keyframe reaches the groups that loaded its stylesheet", async () => {
  expect(
    groups(await affected("pr1686.diff.gz", "coverage_map.json")),
  ).toContain("active-agents");
});

// Feature: #2406 dependency planning maps keyframes and modules through their recorded importers.
test("a module the map recorded no code for reaches the groups that load its importers", async () => {
  expect(
    groups(await affected("pr2267-reparent.diff", "coverage_map.json")),
  ).toContain("sidebar");
  expect(await blame("sidebar", ["pr2267-reparent.diff"])).toEqual([
    "pr2267-reparent",
    "# ruled out 0 of 1: sidebar ran none of their changes",
  ]);
});

// Feature: #2562 dependency planning excludes untracked native build artifacts.
test("untracked build artifacts do not change the affected test plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "affected-checkout-"));
  try {
    for (const path of [
      ".gitignore",
      "tests/dev/affected_tests.ts",
      "tests/dev/affected_browser.ts",
      "tests/mobile_browser/index.ts",
      "web/app.css",
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(ROOT, path), join(root, path));
    }
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
    expect(
      (await captureFixture(["git", "init", "--quiet"], { cwd: root }))
        .exitCode,
    ).toBe(0);
    writeFileSync(join(root, ".git/info/exclude"), "node_modules\n");
    expect(
      (await captureFixture(["git", "add", "."], { cwd: root })).exitCode,
    ).toBe(0);
    const commit = [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ];
    expect((await captureFixture(commit, { cwd: root })).exitCode).toBe(0);
    const command = [
      process.execPath,
      "tests/dev/affected_tests.ts",
      "--diff",
      join(FIXTURES, "pr2354.diff.gz"),
      "--map",
      join(root, "no-map.json"),
    ];
    const before = await captureFixture(command, { cwd: root });
    expect(before.exitCode, before.stderr.toString()).toBe(0);
    symlinkSync(join(root, "web"), join(root, "web/.recurse-dist-untracked"));
    const after = await captureFixture(command, { cwd: root });
    expect(after.stderr.toString()).toBe("");
    expect(after.exitCode).toBe(0);
    expect(after.stdout.toString()).toBe(before.stdout.toString());
    unlinkSync(join(root, "web/.recurse-dist-untracked"));
    const source = "src/web/static.ts";
    mkdirSync(dirname(join(root, source)), { recursive: true });
    copyFileSync(join(ROOT, source), join(root, source));
    const workingTree = [
      process.execPath,
      "tests/dev/affected_tests.ts",
      "HEAD",
      "--map",
      join(root, "no-map.json"),
    ];
    const newSource = await captureFixture(workingTree, { cwd: root });
    expect(newSource.exitCode, newSource.stderr.toString()).toBe(0);
    expect(newSource.stdout.toString()).toContain("bun run test:backend");
    expect(newSource.stdout.toString()).toContain("bun run test:browser");
    unlinkSync(join(root, source));
    const testPath = "tests/backend/affected_tests.test.ts";
    mkdirSync(dirname(join(root, testPath)), { recursive: true });
    copyFileSync(join(ROOT, testPath), join(root, testPath));
    const newTest = await captureFixture(workingTree, { cwd: root });
    expect(newTest.exitCode, newTest.stderr.toString()).toBe(0);
    expect(newTest.stdout.toString()).toContain(
      `bun test --timeout 30000 ./${testPath}`,
    );
    expect(
      (await captureFixture(["git", "add", testPath], { cwd: root })).exitCode,
    ).toBe(0);
    expect((await captureFixture(commit, { cwd: root })).exitCode).toBe(0);
    unlinkSync(join(root, testPath));
    const deletedTest = await captureFixture(workingTree, { cwd: root });
    expect(deletedTest.exitCode, deletedTest.stderr.toString()).toBe(0);
    expect(deletedTest.stdout.toString()).toContain(
      "# no tests reach this change",
    );
  } finally {
    retire(root, join(tmpdir(), "affected-tests-trash"));
  }
});

test("without a map a frontend change runs the whole browser suite and says so", async () => {
  const lines = await affected("pr2354.diff.gz");
  expect(lines).toContain("bun run test:browser");
  expect(lines.some((line) => line.includes("no browser coverage map"))).toBe(
    true,
  );
});
