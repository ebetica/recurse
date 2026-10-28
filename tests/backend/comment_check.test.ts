import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkComments } from "../checks/comment_check.ts";
import { captureFixture } from "./fixture_subprocess";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/comments/${name}.txt`, import.meta.url),
    "utf8",
  );

describe("comment policy", () => {
  test("correct docs, headers, body exceptions and non-comment tokens pass", () => {
    expect(checkComments("src/example.ts", fixture("correct"))).toEqual([]);
    expect(
      checkComments(
        "web/example.jsx",
        "export const View = () => <p>// text</p>;",
      ),
    ).toEqual([]);
    expect(
      checkComments("src/local.ts", "#!/usr/bin/env bun\nexport {};\n"),
    ).toEqual([]);
  });

  test("only extracted tool help is exempt", () => {
    const source = fixture("tool-help");
    expect(
      checkComments("tools/example.ts", source).map(
        (v) => `${v.line}:${v.rule}`,
      ),
    ).toEqual(["13:comment-lines", "21:unexpected-comment"]);
    expect(checkComments("src/example.ts", source).length).toBeGreaterThan(2);
    expect(
      checkComments(
        "tools/example.ts",
        source.replace("toolHelp(import.meta.url)", '"not extracted"'),
      ).some((v) => v.line === 2),
    ).toBe(true);
  });

  // Feature: #2296 checker tags attach to named browser tests and protect their deletion.
  test("regression tags attach to named browser test functions", () => {
    const source = readFileSync(
      new URL("./fixtures/test-check/browser-regression.txt", import.meta.url),
      "utf8",
    );
    expect(checkComments("tests/mobile_browser/example.ts", source)).toEqual(
      [],
    );
  });

  test("regression tags attach to non-exported browser test consts", () => {
    const source = readFileSync(
      new URL(
        "./fixtures/test-check/browser-const-regression.txt",
        import.meta.url,
      ),
      "utf8",
    );
    expect(checkComments("tests/mobile_browser/example.ts", source)).toEqual(
      [],
    );
  });

  test("regression tags may sit above test-check-allow lines before a test", () => {
    const source = readFileSync(
      new URL("./fixtures/test-check/tag-allowance-test.txt", import.meta.url),
      "utf8",
    );
    expect(checkComments("tests/backend/example.test.ts", source)).toEqual([]);
  });

  test("declarations can omit doc comments", () => {
    expect(checkComments("src/example.ts", fixture("undocumented"))).toEqual(
      [],
    );
  });

  test("reports each forbidden attachment, line limit and width", () => {
    const observed = checkComments("src/example.ts", fixture("violations"));
    expect(observed.map((v) => `${v.line}:${v.rule}`)).toEqual([
      "1:comment-lines",
      "8:comment-lines",
      "11:unexpected-comment",
      "21:comment-lines",
      "28:unexpected-comment",
      "29:unexpected-comment",
      "30:unexpected-comment",
      "31:comment-lines",
      "38:unexpected-comment",
      "40:unexpected-comment",
      "41:comment-width",
      "43:duplicate-doc",
      "46:duplicate-doc",
      "50:duplicate-doc",
      "54:duplicate-doc",
      "58:duplicate-doc",
      "62:unexpected-comment",
      "64:unexpected-comment",
      "67:unexpected-comment",
      "69:unexpected-comment",
      "70:unexpected-comment",
      "71:comment-width",
    ]);
  });

  test("all test comments are forbidden, but directives and licenses always pass", () => {
    expect(
      checkComments("tests/example.ts", fixture("tests")).map(
        (v) => `${v.line}:${v.rule}`,
      ),
    ).toEqual([
      "1:test-comment",
      "3:test-comment",
      "5:test-comment",
      "7:test-comment",
      "9:test-comment",
    ]);
    for (const file of ["src/example.ts", "tests/example.ts"])
      expect(checkComments(file, fixture("exempt"))).toEqual([]);
  });

  test("consecutive line comments form docs, headers and body exceptions", () => {
    expect(checkComments("src/a.ts", fixture("line-groups"))).toEqual([]);
    expect(
      checkComments("src/a.ts", fixture("line-group-violations")).map(
        (v) => `${v.line}:${v.rule}`,
      ),
    ).toEqual([
      "1:comment-lines",
      "8:comment-lines",
      "14:comment-lines",
      "21:comment-lines",
    ]);
  });

  // Feature: #2722 Python policy checks tracked fixtures independently of JS warnings.
  test("CLI checks recorded .py files, including tracked fixtures, independently of JS warnings", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "python-comment-check-"));
    const run = (...flags: string[]) =>
      captureFixture(
        [
          process.execPath,
          new URL("../checks/comment_check.ts", import.meta.url).pathname,
          ...flags,
        ],
        { cwd },
      );
    try {
      expect(
        (await captureFixture(["git", "init", "-q"], { cwd })).exitCode,
      ).toBe(0);
      mkdirSync(join(cwd, "tests/fixtures"), { recursive: true });
      const path = join(cwd, "tests/fixtures/wrapper.py");
      writeFileSync(path, fixture("python-recorded"));
      expect(
        (await captureFixture(["git", "add", "."], { cwd })).exitCode,
      ).toBe(0);
      const result = await run("--strict-python");
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toContain("wrapper.py:1 comment-lines");
      expect(result.stdout.toString()).toContain("wrapper.py:8 comment-width");
      expect(result.stdout.toString()).toContain("wrapper.py:15 comment-lines");
      expect(result.stdout.toString()).toContain(
        "wrapper.py:35 unexpected-comment",
      );
      expect((await run()).exitCode).toBe(0);
      writeFileSync(path, fixture("python-correct"));
      writeFileSync(join(cwd, "a.ts"), fixture("violations"));
      expect(
        (await captureFixture(["git", "add", "."], { cwd })).exitCode,
      ).toBe(0);
      expect((await run("--strict-python")).exitCode).toBe(0);
      const tsResult = await run("--strict");
      expect(tsResult.stdout.toString()).toContain("a.ts:1 comment-lines");
      expect(tsResult.exitCode).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("CLI tracks JS/TS, skips guard exclusions, and supports warnings/strict", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "comment-check-"));
    const run = (...flags: string[]) =>
      captureFixture(
        [
          process.execPath,
          new URL("../checks/comment_check.ts", import.meta.url).pathname,
          ...flags,
        ],
        { cwd },
      );
    const put = (file: string, text: string) => {
      const path = join(cwd, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    };
    try {
      expect(
        (await captureFixture(["git", "init", "-q"], { cwd })).exitCode,
      ).toBe(0);
      put("src/correct.ts", fixture("correct"));
      for (const file of [
        "web/vendor/a.js",
        "web/dist/a.js",
        "scripts/patches/a.ts",
        "tests/fixtures/a.ts",
        "ignored.ts.lock",
      ])
        put(file, "const undocumented = 1;");
      put("untracked.js", "const undocumented = 1;");
      symlinkSync("untracked.js", join(cwd, "linked.js"));
      expect(
        (
          await captureFixture(
            [
              "git",
              "add",
              "src",
              "web",
              "scripts/patches",
              "tests",
              "ignored.ts.lock",
              "linked.js",
            ],
            { cwd },
          )
        ).exitCode,
      ).toBe(0);
      expect((await run("--strict")).exitCode).toBe(0);
      expect((await run()).stdout.toString()).toContain("Comment warnings: 0");
      put(".prettierrc", '{"printWidth": 10}');
      expect((await run("--strict")).exitCode).toBe(1);
      expect((await run()).stdout.toString()).toContain("comment-width");
      put(".prettierrc", '{"printWidth": 80}');
      for (const file of [
        "src/local.ts",
        "tools/a.mjs",
        "src/extensions/a.cjs",
        "web/a.jsx",
        "src/a.tsx",
        "tests/a.js",
      ])
        put(
          file,
          file.startsWith("tests/")
            ? "// test comment\n"
            : "const undocumented = 1;",
        );
      expect(
        (
          await captureFixture(
            [
              "git",
              "add",
              "src/local.ts",
              "tools",
              "src/extensions",
              "web/a.jsx",
              "src/a.tsx",
              "tests/a.js",
            ],
            { cwd },
          )
        ).exitCode,
      ).toBe(0);
      for (const [flags, status] of [
        [[], 0],
        [["--strict"], 1],
      ] as const) {
        const result = await run("--summary", ...flags);
        expect(result.exitCode).toBe(status);
        expect(result.stdout.toString().trim().split("\n").slice(-3)).toEqual([
          "Comment warnings: 1",
          "By rule: test-comment=1",
          "By directory: tests=1",
        ]);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
