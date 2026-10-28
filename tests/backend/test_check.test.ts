import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTests, deletedRegressions } from "../checks/test_check";
import { checkComments } from "../checks/comment_check";
import { captureFixture } from "./fixture_subprocess";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/test-check/${name}.txt`, import.meta.url),
    "utf8",
  );

test("AST rules fire and their allowed counter-examples pass", () => {
  expect(
    checkTests("tests/mobile_browser/example.ts", fixture("rules")).map(
      (v) => `${v.line}:${v.rule}`,
    ),
  ).toEqual([
    "3:T1",
    "4:T1",
    "5:T2",
    "6:T2",
    "7:T2",
    "8:T3",
    "9:T3",
    "10:T3",
    "11:T4",
    "12:T6",
    "13:T6",
    "14:T6",
    "15:T6",
    "18:T8",
  ]);
  expect(
    checkTests("tests/live/example.ts", fixture("rules")).filter(
      (v) => v.rule === "T7",
    ),
  ).toMatchObject([{ line: 17 }]);
  expect(
    checkTests("tests/mobile_browser/example.ts", fixture("allowed")),
  ).toEqual([]);
  expect(
    checkTests("tests/backend/example.test.ts", fixture("rules"))
      .filter((v) => v.rule === "T10")
      .map((v) => v.line),
  ).toEqual([19, 20, 21]);
  expect(
    checkTests("tests/backend/example.test.ts", fixture("allowed")),
  ).toEqual([]);
  expect(
    checkTests("tests/backend/parser.test.ts", 'const model = "gpt-current";'),
  ).toEqual([]);
});

test("T9 scans current pure tests and preserves real-path tests", () => {
  const scan = (file: string) => {
    const recording = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/test_check/recorded-t9-cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const text: string =
      recording.sources[file] ??
      readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    return {
      text,
      hits: checkTests(file, text).filter((v) => v.rule === "T9"),
    };
  };
  const pure = scan("tests/web/active-agents.test.ts");
  expect(pure.hits).toHaveLength(1);
  expect(pure.text.split("\n")[pure.hits[0]!.line - 1]).toContain(
    'test("names singular and plural plainly"',
  );
  expect(scan("tests/web/fuzzy-match.test.ts").hits).toHaveLength(1);
  const table = scan("tests/web/deep-link.test.ts");
  expect(
    table.hits.some((hit) =>
      table.text.split("\n")[hit.line - 1]?.includes("test.each"),
    ),
  ).toBe(true);
  expect(scan("tests/backend/agent_store.test.ts").hits).toEqual([]);
  expect(scan("tests/backend/process_lifecycle.test.ts").hits).toEqual([]);
  const allowed = pure.text.replace(
    'test("names singular',
    '// test-check-allow: T9 Preserve a reviewed security predicate.\n  test("names singular',
  );
  expect(checkTests("tests/web/active-agents.test.ts", allowed)).toEqual([]);
  expect(checkComments("tests/web/active-agents.test.ts", allowed)).toEqual([]);
  expect(
    checkTests(
      "tests/web/active-agents.test.ts",
      allowed.replace("T9 Preserve", "T9\n// Preserve"),
    ),
  ).toMatchObject([{ rule: "T9" }]);
});

test("comment exemptions are one-line and regression tags directly precede cases", () => {
  expect(checkComments("tests/backend/example.ts", fixture("allowed"))).toEqual(
    [],
  );
  for (const source of [
    '// Regression: missing-number\ntest("case", () => {});',
    '// Regression: #123 reason\n\ntest("case", () => {});',
    "// Regression: #123 reason\nconst value = 1;",
    "// test-check-allow: T5 not supported",
    "/* test-check-allow: T3 block */",
  ])
    expect(checkComments("tests/backend/example.ts", source)).toMatchObject([
      { rule: "test-comment" },
    ]);
});

// Feature: #2296 checker tags attach to named browser tests and protect their deletion.
test("deleting a tagged browser function needs a removal declaration", () => {
  const file = "tests/mobile_browser/example.ts";
  const before = fixture("browser-regression").replace(
    "Feature:",
    "Regression:",
  );
  expect(deletedRegressions(file, before, "", "")).toMatchObject([
    {
      rule: "T8",
      reason:
        "deleted regression #2296 test_sidebar_status_rows_desktop needs Removes-regression",
    },
  ]);
  expect(deletedRegressions(file, before, before, "")).toEqual([]);
  expect(
    deletedRegressions(
      file,
      before,
      "",
      `Removes-regression: #2296 ${file} test_sidebar_status_rows_desktop`,
    ),
  ).toEqual([]);
});

test("CLI warning/strict exits and real git diff regression deletion gate", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "test-check-"));
  const git = async (...args: string[]) => {
    const result = await captureFixture(["git", ...args], { cwd });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  const put = (file: string, text: string) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), text);
  };
  const run = (...flags: string[]) =>
    captureFixture(
      [
        process.execPath,
        new URL("../checks/test_check.ts", import.meta.url).pathname,
        ...flags,
      ],
      { cwd },
    );
  try {
    await git("init", "-q");
    await git("config", "user.name", "Test Checker");
    await git("config", "user.email", "checker@example.invalid");
    put(
      "tests/backend/case.ts",
      '// Regression: #123 survives restart\ntest.each([1, 2])("restart", () => {});\n',
    );
    await git("add", ".");
    await git("commit", "-qm", "baseline");
    const base = await git("rev-parse", "HEAD");
    expect((await run("--strict")).exitCode).toBe(0);
    put("tests/backend/case.ts", 'spyOn(service, "call");\n');
    const warning = await run("--summary");
    expect(warning.exitCode).toBe(0);
    expect(warning.stdout.toString()).toContain(
      "By rule: T3=1\nBy area: backend=1",
    );
    expect((await run("--strict")).exitCode).toBe(1);
    put("body.txt", "No removal declaration.\n");
    expect((await run("--diff", base, "--pr-body", "body.txt")).exitCode).toBe(
      1,
    );
    expect(
      (await run("--strict=T9", "--diff", base, "--pr-body", "body.txt"))
        .exitCode,
    ).toBe(1);
    put(
      "body.txt",
      "Removes-regression: #123 tests/backend/case.ts restart — obsolete feature\n",
    );
    expect((await run("--diff", base, "--pr-body", "body.txt")).exitCode).toBe(
      0,
    );
    put(
      "body.txt",
      "Removes-regression: #123 tests/backend/case.ts restart-other\n",
    );
    expect((await run("--diff", base, "--pr-body", "body.txt")).exitCode).toBe(
      1,
    );
    put("tests/backend/case.ts", 'test("restart", () => {});\n');
    expect((await run("--diff", base, "--pr-body", "body.txt")).exitCode).toBe(
      0,
    );
    await git("rm", "-q", "-f", "tests/backend/case.ts");
    expect((await run("--diff", base, "--pr-body", "body.txt")).exitCode).toBe(
      1,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
