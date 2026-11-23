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
  const route = lines.find((line) => / backend tests start with: /.test(line));
  expect(route?.split(": ")[1]).toBe(
    "src/themes.ts <- src/web/static.ts <- src/web/app.ts",
  );
});

test("a change to one browser test file runs only its group", async () => {
  const lines = await affected("pr2363.diff");
  expect(lines.filter((line) => line.includes("mobile_browser"))).toEqual([
    "bun tests/mobile_browser/index.ts header",
  ]);
  expect(lines).not.toContain("bun run test:browser");
});

// Regression: #2273 changed src/pi_auth.worker.mjs, which src/auth/oauth.ts starts by joining its file name to a directory.
test("a worker a module starts by file name reaches that module's tests", async () => {
  const backend = (await affected("pr2273-worker.diff")).find((line) =>
    line.startsWith("bun test --timeout 30000 "),
  );
  expect(backend?.split(" ")).toContain("./tests/backend/oauth_auth.test.ts");
  expect(backend?.split(" ")).toContain(
    "./tests/backend/provider_auth.test.ts",
  );
});

test("a historical shell change runs all browser groups even with old inline coverage", async () => {
  const lines = await affected("pr2354.diff.gz", "coverage_map.json");
  expect(lines).toContain(
    "# browser: web/index.html: frontend file the map does not cover",
  );
  expect(groups(lines)).toBe("all");
});

// Feature: #2377 font-size changes select selection-comment browser coverage.
test("a font-size change reaches the group that measures the selection offer", async () => {
  const lines = await affected("pr2377-app-css.diff.gz", "coverage_map.json");
  expect(groups(lines)).toContain("selection-comments");
  expect(groups(lines)).not.toBe("all");
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

test("blame rules out unrelated changes but retains changes that lack coverage", async () => {
  expect(
    await blame("artifact-check", [
      "pr2363.diff",
      "pr1686.diff.gz",
      "pr2370-full.diff.gz",
    ]),
  ).toEqual([
    "pr1686",
    "pr2370-full",
    "# ruled out 1 of 3: artifact-check ran none of their changes",
  ]);
});

// Regression: #3273 frontend READMEs and fixtures no test names planned every suite.
test("a frontend README runs no tests and an unnamed fixture runs the tests that name its directory", async () => {
  const readme = await affected("pr3269-readme.diff.gz", "coverage_map.json");
  expect(readme.slice(1)).toEqual(["# no tests reach this change"]);
  const revision = await affected(
    "pr3227-fixture.diff.gz",
    "coverage_map.json",
  );
  expect(revision.slice(1)).toEqual([
    "bun test --timeout 30000 ./tests/backend/affected_tests.test.ts ./tests/backend/api_v1.test.ts ./tests/backend/api_v1_messages.test.ts ./tests/backend/connected_backends.test.ts ./tests/backend/durable_reply_times.test.ts ./tests/backend/durable_uploads.test.ts ./tests/backend/http_static.test.ts ./tests/backend/remote_send.test.ts",
  ]);
  const image = await affected("pr2637-pixel.diff", "coverage_map.json");
  expect(image.slice(1)).toEqual([
    "bun test --timeout 30000 ./tests/backend/durable_tools.test.ts",
  ]);
});

// Feature: #2406 dependency planning maps keyframes and modules through their recorded importers.
test("a changed keyframe reaches the groups that loaded its stylesheet", async () => {
  const lines = await affected("files-keyframes.diff.gz", "coverage_map.json");
  const note = lines.find((line) =>
    line.startsWith("# web/files.css: groups that used the changed rules -> "),
  );
  const covered = note?.split(" -> ")[1]?.split(" ");
  expect(covered).toHaveLength(36);
  expect(covered).toContain("active-agents");
  expect(groups(lines)).not.toBe("all");
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

// Feature: #3290 TLA+ changes run the model checks; web edits skip server tests.
test("TLA+ changes run the model checks and a web module change skips unrelated server tests", async () => {
  expect(
    (await affected("pr3284-tla.diff.gz", "coverage_map.json")).slice(1),
  ).toEqual([
    "bun test --timeout 30000 ./tests/backend/affected_tests.test.ts",
    "specs/tla/check.sh",
  ]);
  expect(
    (await affected("pr3284-tla-v0.3.2.diff.gz", "coverage_map.json")).slice(1),
  ).toEqual([
    "# everything: package.json: a build input, or no test reaches it",
    "bun run test:backend",
    "bun run test",
    "bun run test:browser",
    "specs/tla/check.sh",
  ]);
  const files = await affected("pr3225-files.diff.gz", "coverage_map.json");
  expect(files.find((line) => line.startsWith("bun test --timeout"))).toBe(
    "bun test --timeout 30000 ./tests/backend/affected_tests.test.ts ./tests/backend/http_explorer.test.ts ./tests/backend/local_supervisor.test.ts ./tests/backend/supervisor_lifecycle.test.ts ./tests/backend/svg_check.test.ts ./tests/backend/test_check_cli.test.ts",
  );
});

// Feature: #3294 pane stylesheets map to the groups that used their rules.
test("a pane stylesheet change reaches the groups that used its rules", async () => {
  const lines = await affected("pr3240-dock.diff.gz", "coverage_map-css.json");
  expect(lines).toContain(
    "# web/dock/style.css: groups that used the changed rules -> pane-chrome panes-files",
  );
});
