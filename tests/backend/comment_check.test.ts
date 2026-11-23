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
  test("correct docs, headers, ordinary body comments and wide lines pass", () => {
    expect(checkComments("src/example.ts", fixture("correct"))).toEqual([]);
    expect(
      checkComments("src/local.ts", "#!/usr/bin/env bun\nexport {};\n"),
    ).toEqual([]);
  });

  test("comments in code are distinct from slashes in literal tokens", () => {
    expect(
      checkComments(
        "tests/example.tsx",
        readFileSync(
          new URL("./fixtures/comments/literal-tokens.txt", import.meta.url),
          "utf8",
        ),
      ).map((v) => `${v.line}:${v.rule}`),
    ).toEqual([
      "3:test-comment",
      "4:test-comment",
      "6:test-comment",
      "10:test-comment",
    ]);
  });

  test("only extracted tool help is exempt", () => {
    const source = fixture("tool-help");
    expect(
      checkComments("tools/example.ts", source).map(
        (v) => `${v.line}:${v.rule}`,
      ),
    ).toEqual(["13:comment-lines", "21:comment-lines"]);
    expect(
      checkComments("src/example.ts", source).map((v) => `${v.line}:${v.rule}`),
    ).toEqual(["2:comment-lines", "13:comment-lines", "21:comment-lines"]);
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

  test("reports each forbidden attachment and line limit", () => {
    const observed = checkComments("src/example.ts", fixture("violations"));
    expect(observed.map((v) => `${v.line}:${v.rule}`)).toEqual([
      "1:comment-lines",
      "8:comment-lines",
      "11:unexpected-comment",
      "21:comment-lines",
      "31:comment-lines",
      "38:unexpected-comment",
      "40:unexpected-comment",
      "43:duplicate-doc",
      "46:duplicate-doc",
      "50:duplicate-doc",
      "54:duplicate-doc",
      "58:duplicate-doc",
      "70:unexpected-comment",
      "71:unexpected-comment",
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

  test("consecutive line comments form docs, headers and body comments", () => {
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
      put(
        "web/index.html",
        "<!doctype html>\n<!-- Browser entry. -->\n<html></html>\n",
      );
      put("scripts/check.sh", "#!/usr/bin/env bash\n# Run the check.\ntrue\n");
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
              "scripts",
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
      expect((await run("--strict")).exitCode).toBe(0);
      const headerBaseline = "tests/checks/source_header_baseline.json";
      const missingHeaders = [
        "src/a.tsx",
        "src/extensions/a.cjs",
        "src/local.ts",
        "tools/a.mjs",
        "web/a.css",
        "web/a.jsx",
      ];
      put(headerBaseline, JSON.stringify(missingHeaders));
      for (const file of missingHeaders)
        put(
          file,
          file.endsWith(".css") ? "body {}\n" : "const undocumented = 1;",
        );
      put("tests/a.js", "// test comment\n");
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
              "web/a.css",
              "src/a.tsx",
              "tests/a.js",
              headerBaseline,
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
      put("tests/a.js", "export {};\n");
      put("web/a.css", "/* Browser shell styles. */\nbody {}\n");
      const improved = await run("--strict");
      expect(improved.exitCode).toBe(0);
      expect(improved.stdout.toString()).toContain(`Shrank ${headerBaseline};`);
      expect(
        JSON.parse(readFileSync(join(cwd, headerBaseline), "utf8")),
      ).toEqual(missingHeaders.filter((file) => file !== "web/a.css"));

      const tree = await captureFixture(
        [
          process.execPath,
          new URL("../../tools/code_map.ts", import.meta.url).pathname,
          "web",
        ],
        { cwd },
      );
      expect(tree.exitCode).toBe(0);
      expect(tree.stdout.toString()).toBe(
        "web/\n  a.css — Browser shell styles.\n  a.jsx — Missing source header\n  index.html — Browser entry.\n",
      );

      put(
        "web/a.css",
        "/* Apache License\n * Version 2.0, January 2004\n */\nbody {}\n/* This is not a leading header. */\n",
      );
      const regressed = await run("--strict");
      expect(regressed.exitCode).toBe(1);
      expect(regressed.stdout.toString()).toContain(
        "web/a.css:1 missing-header add a leading comment describing this file's job",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
