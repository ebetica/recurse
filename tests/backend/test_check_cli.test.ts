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
import { captureFixture } from "./fixture_subprocess";

const recorded = (name: string) =>
  readFileSync(
    new URL(`./fixtures/test-check/${name}.txt`, import.meta.url),
    "utf8",
  );

test("CLI enforces only the selected strict rules", async () => {
  await withRepo(async ({ put, run }) => {
    const rules = recorded("rules").split("\n");
    await put("tests/backend/case.ts", rules[8]!);
    expect((await run("test_check", "--strict=T8,T9")).exitCode).toBe(0);
    expect((await run("test_check", "--strict=T3")).exitCode).toBe(1);
    expect((await run("test_check", "--strict")).exitCode).toBe(1);
    await put("tests/backend/case.ts", rules[17]!);
    expect((await run("test_check", "--strict=T8,T9")).exitCode).toBe(1);
    expect((await run("test_check", "--strict=T9")).exitCode).toBe(0);
    const pure = JSON.parse(
      readFileSync(
        new URL(
          "./fixtures/test_check/recorded-t9-cases.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).sources["tests/web/active-agents.test.ts"] as string;
    await put("tests/backend/case.ts", pure);
    expect((await run("test_check", "--strict=T8,T9")).exitCode).toBe(1);
    expect((await run("test_check", "--strict=T8")).exitCode).toBe(0);
  });
});

test("CLI rejects malformed or repeated strict rule selections", async () => {
  await withRepo(async ({ run }) => {
    for (const flags of [
      ["--strict="],
      ["--strict=T0"],
      ["--strict=T11"],
      ["--strict=T8,"],
      ["--strict=T8,T8"],
      ["--strict=T8", "--strict"],
    ]) {
      const result = await run("test_check", ...flags);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("--strict");
    }
  });
});

// Regression: #2444 token usage and image bounds are not help copy or timing
test("CLI distinguishes recorded token/image assertions from help and timing", async () => {
  await withRepo(async ({ put, run }) => {
    await put("tests/backend/case.ts", recorded("precision"));
    const result = await run("test_check", "--strict");
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("By rule: T2=1 T6=2");
    expect(result.stdout.toString()).not.toContain("case.ts:1");
    expect(result.stdout.toString()).not.toContain("case.ts:2");
  });
});

test("CLI honors adjacent reasoned allowances except T5", async () => {
  await withRepo(async ({ put, run, baseline }) => {
    const rules = recorded("rules").split("\n");
    const rows = [
      [2, "T1"],
      [6, "T2"],
      [8, "T3"],
      [10, "T4"],
      [11, "T6"],
      [16, "T7"],
      [17, "T8"],
    ] as const;
    const source = rows
      .map(
        ([line, rule]) =>
          `// test-check-allow: ${rule} Recorded policy exception.\n${rules[line]}`,
      )
      .join("\n");
    await put("tests/live/provider.ts", source);
    expect((await run("test_check", "--strict")).exitCode).toBe(0);
    await put(
      "tests/live/provider.ts",
      source.replace("// Regression: missing-number", ""),
    );
    expect((await run("comment_check", "--strict")).exitCode).toBe(0);
    await put(
      "tests/live/provider.ts",
      source.replace("T2 Recorded", "T2\n// Recorded"),
    );
    expect((await run("test_check", "--strict")).exitCode).toBe(1);
    expect((await run("comment_check", "--strict")).exitCode).toBe(1);
    await put(
      "tests/live/provider.ts",
      "// test-check-allow: T5 Machine paths must be scrubbed.\n",
    );
    expect((await run("comment_check", "--strict")).exitCode).toBe(1);
    await put("tests/live/provider.ts", source);
    const base = await baseline();
    await put(".gitattributes", "tests/backend/*.ts binary\n");
    await put(
      "tests/backend/new.ts",
      `// test-check-allow: T3 Recorded policy exception.\n${rules[8]}`,
    );
    await put("body.txt", "");
    const diff = () =>
      run("test_check", "--diff", base, "--pr-body", "body.txt");
    const added = await diff();
    expect(added.exitCode).toBe(1);
    expect(added.stdout.toString()).toContain(
      "err on the side of not adding unit tests",
    );
    expect(added.stdout.toString()).toContain(
      "existing integration or browser test on a real path",
    );
    await put(
      "body.txt",
      "Operator-approved-test-allowance: tests/backend/new.ts:(file) — operator reason",
    );
    expect((await diff()).exitCode).toBe(1);
    const head = await baseline();
    for (const verdict of [
      `Test-review: PASS ${base}`,
      `Test-review: PASS ${head.slice(0, 12)}`,
      `Test-review: FLAG ${head}`,
      `Test-review: PASS ${head} extra`,
    ]) {
      await put("body.txt", verdict);
      expect((await diff()).exitCode).toBe(1);
    }
    await put("body.txt", `Test-review: PASS ${head}`);
    expect((await diff()).exitCode).toBe(0);
    await put(
      "tests/backend/new.ts",
      `// test-check-allow: T3 Changed policy exception.\n${rules[8]}`,
    );
    expect((await diff()).exitCode).toBe(1);
    const changedHead = await baseline();
    expect((await diff()).exitCode).toBe(1);
    await put("body.txt", `Test-review: PASS ${changedHead}`);
    expect((await diff()).exitCode).toBe(0);
    await put("tests/backend/new.ts", "");
    const file = "tests/fixtures/history.json";
    await put(file, recorded("provenance"));
    await put(
      "tests/test-check-allowances.json",
      JSON.stringify([
        {
          file,
          rule: "T4",
          reason: "Historical recorder provenance retained.",
        },
      ]),
    );
    await put("body.txt", "");
    const manifest = await diff();
    expect(manifest.exitCode).toBe(1);
    expect(manifest.stdout.toString()).toContain(
      `${file}:1 T8 new test allowance`,
    );
    await put(
      "body.txt",
      `Operator-approved-test-allowance: ${file}:T4 — operator reason`,
    );
    expect((await diff()).exitCode).toBe(1);
    const manifestHead = await baseline();
    await put("body.txt", `Test-review: PASS ${manifestHead}`);
    expect((await diff()).exitCode).toBe(0);
    await put(
      "tests/test-check-allowances.json",
      JSON.stringify([
        { file, rule: "T4", reason: "Changed recorder provenance reason." },
      ]),
    );
    expect((await diff()).exitCode).toBe(1);
    const changedManifestHead = await baseline();
    expect((await diff()).exitCode).toBe(1);
    await put("body.txt", `Test-review: PASS ${changedManifestHead}`);
    expect((await diff()).exitCode).toBe(0);
  });
});

test("CLI validates exact JSON provenance allowances and rejects stale entries", async () => {
  await withRepo(async ({ put, run, remove }) => {
    const file = "tests/fixtures/history.json";
    const allowance = {
      file,
      rule: "T4",
      reason: "Historical recorder provenance retained.",
    };
    const configure = (entries: unknown) =>
      put("tests/test-check-allowances.json", JSON.stringify(entries));
    await put(file, recorded("provenance"));
    expect((await run("test_check")).exitCode).toBe(0);
    expect((await run("test_check", "--strict")).exitCode).toBe(1);
    await configure([allowance]);
    expect((await run("test_check", "--strict")).exitCode).toBe(0);
    for (const entries of [
      {},
      [allowance, allowance],
      [{ ...allowance, reason: " " }],
      [{ ...allowance, rule: "T5" }],
      [{ ...allowance, file: "tests/fixtures/*.json" }],
      [{ ...allowance, file: "tests/../fixtures/history.json" }],
      [{ ...allowance, extra: true }],
    ]) {
      await configure(entries);
      expect((await run("test_check")).exitCode).toBe(1);
    }
    await configure([allowance]);
    await put(file, recorded("provenance").replace("record.py", "record.ts"));
    const stale = await run("test_check");
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.toString()).toContain(`stale or missing ${file}`);
    remove(file);
    expect((await run("test_check")).exitCode).toBe(1);
  });
});

// Regression: #2653 legacy tags inside bodies and stacks escaped deletion protection
test("CLI protects recorded interior and stacked regression tags", async () => {
  await withRepo(async ({ put, run, baseline }) => {
    const file = "tests/backend/case.ts";
    const source = [
      "./durable_host.test.ts",
      "../mobile_browser/parallel.test.ts",
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");
    await put(file, source);
    const base = await baseline();
    await put(file, "");
    await put("body.txt", "");
    const result = await run(
      "test_check",
      "--diff",
      base,
      "--pr-body",
      "body.txt",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("deleted regression #2519");
    expect(result.stdout.toString()).toContain("deleted feature #2538");
    expect(result.stdout.toString()).toContain("deleted regression #2591");
  });
});

// Feature: #2653 feature tags have syntax, comment, deletion and per-PR limits
test("CLI accepts one feature test and rejects undeclared deletion or multiple additions", async () => {
  await withRepo(async ({ put, run, baseline }) => {
    const file = "tests/mobile_browser/case.ts";
    const regression = recorded("browser-regression").replace(
      "Feature:",
      "Regression:",
    );
    const feature = regression.replace("Regression:", "Feature:");
    await put(file, regression);
    const base = await baseline();
    await put("body.txt", "");
    await put(file, feature);
    expect(
      (
        await run(
          "test_check",
          "--strict",
          "--diff",
          base,
          "--pr-body",
          "body.txt",
        )
      ).exitCode,
    ).toBe(0);
    expect((await run("comment_check", "--strict")).exitCode).toBe(0);
    await put(file, feature.replace("#2296", "missing"));
    expect((await run("test_check", "--strict")).exitCode).toBe(1);
    await put(file, feature);
    const featureBase = await baseline();
    await put(file, "const test_sidebar_status_rows_desktop = 1;");
    const deleted = await run(
      "test_check",
      "--diff",
      featureBase,
      "--pr-body",
      "body.txt",
    );
    expect(deleted.exitCode).toBe(1);
    expect(deleted.stdout.toString()).toContain("needs Removes-feature");
    await put(
      "body.txt",
      `Removes-feature: #2296 ${file} test_sidebar_status_rows_desktop`,
    );
    expect(
      (await run("test_check", "--diff", featureBase, "--pr-body", "body.txt"))
        .exitCode,
    ).toBe(0);
    await put(file, feature);
    await put(
      "tests/mobile_browser/one.ts",
      feature.replaceAll("test_sidebar_status_rows_desktop", "test_one"),
    );
    expect(
      (await run("test_check", "--diff", featureBase, "--pr-body", "body.txt"))
        .exitCode,
    ).toBe(0);
    await put(
      "tests/mobile_browser/two.ts",
      feature.replaceAll("test_sidebar_status_rows_desktop", "test_two"),
    );
    const multiple = await run(
      "test_check",
      "--diff",
      featureBase,
      "--pr-body",
      "body.txt",
    );
    expect(multiple.exitCode).toBe(1);
    expect(multiple.stdout.toString()).toContain("at most one new Feature tag");
  });
});

// Feature: #2871 growing large source files require an exact-head simplification review
test("CLI requires simplification review only when large source files grow", async () => {
  await withRepo(async ({ put, run, baseline }) => {
    const file = "src/large.ts";
    await put(".gitattributes", "src/*.ts binary\n");
    await put(file, "export {};\n".repeat(1499));
    const base = await baseline();
    await put(file, "export {};\n".repeat(1500));
    const head = await baseline();
    await put("body.txt", "");
    const diff = () =>
      run("test_check", "--diff", base, "--pr-body", "body.txt");
    const missing = await diff();
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.toString()).toContain(
      `${file}:1 T8 growing source file`,
    );
    expect(missing.stdout.toString()).toContain(
      "docs/agents/simplify-review.md",
    );
    for (const verdict of ["simplified", "none-found", "follow-up #123"]) {
      await put("body.txt", `Simplify-review: ${file} ${verdict} ${head}`);
      expect((await diff()).exitCode).toBe(0);
    }
    for (const declaration of [
      `Simplify-review: ${file} none-found ${base}`,
      `Simplify-review: ${file} none-found ${head.slice(0, 12)}`,
      `Simplify-review: ${file} follow-up ${head}`,
      `Simplify-review: ${file} none-found ${head} extra`,
    ]) {
      await put("body.txt", declaration);
      expect((await diff()).exitCode).toBe(1);
    }
    await put("body.txt", "");
    expect(
      (await run("test_check", "--diff", head, "--pr-body", "body.txt"))
        .exitCode,
    ).toBe(0);
    await put(file, "export {};\n".repeat(1600));
    const largeBase = await baseline();
    await put(file, "export {};\n".repeat(1500));
    expect(
      (await run("test_check", "--diff", largeBase, "--pr-body", "body.txt"))
        .exitCode,
    ).toBe(0);
  });
});

async function withRepo(
  body: (repo: {
    put: (file: string, text: string) => Promise<void>;
    remove: (file: string) => void;
    baseline: () => Promise<string>;
    run: (
      tool: string,
      ...flags: string[]
    ) => ReturnType<typeof captureFixture>;
  }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "test-check-cli-"));
  const git = async (...args: string[]) => {
    const result = await captureFixture(["git", ...args], { cwd });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    await git("init", "-q");
    await git("config", "user.name", "Checker");
    await git("config", "user.email", "checker@example.invalid");
    await body({
      async baseline() {
        await git("commit", "-qm", "checker baseline");
        return git("rev-parse", "HEAD");
      },
      remove(file) {
        rmSync(join(cwd, file));
      },
      async put(file, text) {
        mkdirSync(join(cwd, file, ".."), { recursive: true });
        writeFileSync(join(cwd, file), text);
        await git("add", file);
      },
      run(tool, ...flags) {
        return captureFixture(
          [
            process.execPath,
            new URL(`../checks/${tool}.ts`, import.meta.url).pathname,
            ...flags,
          ],
          { cwd },
        );
      },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
