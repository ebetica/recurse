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

const capsPath = "tests/checks/test_check_caps.json";
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

// Regression: #3361 positive visibility snapshots must wait for browser state
test("CLI ratchets positive browser visibility snapshots", async () => {
  await withRepo(async ({ put, read, run, git }) => {
    const reason =
      "positive visibility snapshot; wait with locator.waitFor() or browserExpect(locator).toBeVisible()";
    const rule = `T6 ${reason}`;
    const capped = "tests/mobile_browser/test_active_agents.ts";
    await put(capsPath, JSON.stringify({ [rule]: {} }));
    const positive = [
      "async function first() { expect(await page.locator('button').isVisible()).toBeTrue(); }",
      "async function second() { expect((await (locator.isVisible()))).toBe((true)); }",
    ].join("\n");
    const file = "tests/mobile_browser/case.ts";
    await put(file, positive);
    const added = await run("test_check", "--strict");
    expect(added.exitCode).toBe(1);
    expect(
      added.stdout
        .toString()
        .split("\n")
        .filter((line) => line.includes(" T6 ")),
    ).toEqual([
      `${file}:1 T6 ${reason} (cap 0 here)`,
      `${file}:2 T6 ${reason} (cap 0 here)`,
    ]);
    await put(
      file,
      [
        "await locator.waitFor();",
        "await browserExpect(locator).toBeVisible();",
        "expect(await locator.isVisible()).toBeFalse();",
        "expect(await locator.isVisible()).toBe(false);",
        "expect(await locator.isVisible()).not.toBeTrue();",
        "expect(await locator.isVisible()).not.toBe(true);",
        "if (await locator.isVisible()) await locator.click();",
      ]
        .map((line, i) => `async function allowed${i}() { ${line} }`)
        .join("\n"),
    );
    await put("tests/backend/case.ts", positive);
    expect((await run("test_check", "--strict")).exitCode).toBe(0);
    await put(capsPath, JSON.stringify({ [rule]: { [capped]: 1 } }));
    await put(capped, positive.split("\n")[0]!);
    const atCap = read(capsPath);
    expect((await run("test_check", "--strict")).exitCode).toBe(0);
    expect(read(capsPath)).toEqual(atCap);
    await put(capped, positive);
    const exceeded = await run("test_check", "--strict");
    expect(exceeded.exitCode).toBe(1);
    expect(
      exceeded.stdout
        .toString()
        .split("\n")
        .filter((line) => line.includes(" T6 ")),
    ).toEqual([
      `${capped}:1 T6 ${reason} (cap 1 here)`,
      `${capped}:2 T6 ${reason} (cap 1 here)`,
    ]);
    await put(capped, "await locator.waitFor();");
    const lowered = await run("test_check", "--strict");
    expect(lowered.exitCode).toBe(0);
    expect(lowered.stdout.toString()).toContain(
      `Shrank ${capsPath}; commit the updated baseline.`,
    );
    expect(await git("diff", "--", capsPath)).toContain(
      `+  ${JSON.stringify(rule)}: {}`,
    );
    await git("add", capsPath);
    await put(capped, positive.split("\n")[0]!);
    const restored = await run("test_check");
    expect(restored.exitCode).toBe(1);
    expect(restored.stdout.toString()).toContain(
      `${capped}:1 T6 ${reason} (cap 0 here)`,
    );
    expect(await git("diff", "--", capsPath)).toBe("");
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

// Regression: #3343 surviving tests must retain every prior tag id
test("CLI protects tag ids when tagged tests survive", async () => {
  await withRepo(async ({ put, run, baseline }) => {
    const file = "tests/mobile_browser/case.ts";
    const title = "test_sidebar_status_rows_desktop";
    const source = recorded("browser-regression").replace(
      "#2296 checker",
      "#2296 #3183 checker",
    );
    const other = "tests/mobile_browser/other.ts";
    const otherSource = source.replaceAll(title, "test_other");
    await put(file, source);
    await put(other, otherSource);
    const base = await baseline();
    await put("body.txt", "");
    const diff = () =>
      run("test_check", "--strict", "--diff", base, "--pr-body", "body.txt");
    await put(file, source.replace(/^  \/\/ Feature:.*\n/m, ""));
    const removed = await diff();
    expect(removed.exitCode).toBe(1);
    expect(removed.stdout.toString()).toContain(
      `T8 deleted feature #2296 ${title} needs Removes-feature`,
    );
    expect(removed.stdout.toString()).toContain(
      `T8 deleted feature #3183 ${title} needs Removes-feature`,
    );
    await put(
      "body.txt",
      `Removes-feature: #2296 ${file} ${title}\nRemoves-feature: #3183 ${file} ${title}`,
    );
    expect((await diff()).exitCode).toBe(0);
    await put("body.txt", "");
    await put(file, source.replace("#2296 #3183 checker", "#2296 checker"));
    const rewritten = await diff();
    expect(rewritten.exitCode).toBe(1);
    expect(rewritten.stdout.toString()).toContain(
      `T8 deleted feature #3183 ${title} needs Removes-feature`,
    );
    await put(
      file,
      source.replace(
        "#2296 #3183 checker",
        "#3343 #3183 #2296 revised checker",
      ),
    );
    await put(
      other,
      otherSource.replace(
        "#2296 #3183 checker",
        "#3343 #3183 #2296 revised checker",
      ),
    );
    expect((await diff()).exitCode).toBe(0);
    const tag = source.match(/^  \/\/ Feature:.*\n/m)![0];
    await put(
      file,
      source
        .replace(tag, "")
        .replace("    await mkdir", `${tag}    await mkdir`),
    );
    expect((await diff()).exitCode).toBe(1);
    await put(file, source.replace("Feature:", "Regression:"));
    expect((await diff()).exitCode).toBe(0);
    const regressionBase = await baseline();
    await put(file, source.replace(tag, ""));
    const regressionDiff = () =>
      run(
        "test_check",
        "--strict",
        "--diff",
        regressionBase,
        "--pr-body",
        "body.txt",
      );
    const regression = await regressionDiff();
    expect(regression.exitCode).toBe(1);
    expect(regression.stdout.toString()).toContain(
      `T8 deleted regression #3183 ${title} needs Removes-regression`,
    );
    await put(
      "body.txt",
      `Removes-regression: #2296 ${file} ${title}\nRemoves-regression: #3183 ${file} ${title}`,
    );
    expect((await regressionDiff()).exitCode).toBe(0);
  });
});

// Regression: #3352 moving tags must preserve each duplicate occurrence
test("CLI preserves moved tags without losing duplicate occurrences", async () => {
  await withRepo(async ({ put, remove, run, baseline }) => {
    const file = "tests/mobile_browser/case.ts";
    const moved = "tests/mobile_browser/moved.ts";
    const title = "test_sidebar_status_rows_desktop";
    const source = recorded("browser-regression").replace(
      "#2296 checker",
      "#2296 #3183 checker",
    );
    await put(file, source);
    const base = await baseline();
    await put("body.txt", "");
    const diff = (from = base) =>
      run("test_check", "--strict", "--diff", from, "--pr-body", "body.txt");
    remove(file);
    await put(moved, source);
    expect((await diff()).exitCode).toBe(0);
    await put(moved, source.replace("#2296 #3183 checker", "#2296 checker"));
    const lostId = await diff();
    expect(lostId.exitCode).toBe(1);
    expect(lostId.stdout.toString()).toContain(
      `T8 deleted feature #3183 ${title} needs Removes-feature`,
    );
    await put(moved, source.replaceAll(title, "test_renamed"));
    const renamed = await diff();
    expect(renamed.exitCode).toBe(1);
    expect(renamed.stdout.toString()).toContain(
      `T8 deleted feature #2296 ${title} needs Removes-feature`,
    );
    await put(moved, source);
    await put(file, source);
    const duplicateBase = await baseline();
    remove(file);
    await put(moved, source + "\n");
    const duplicate = await diff(duplicateBase);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stdout.toString()).toContain(
      `T8 deleted feature #2296 ${title} needs Removes-feature`,
    );
    expect(duplicate.stdout.toString()).toContain(
      `T8 deleted feature #3183 ${title} needs Removes-feature`,
    );
    await put(file, source);
    await put("tests/mobile_browser/extra.ts", source);
    expect((await diff(duplicateBase)).exitCode).toBe(0);
    await put("tests/mobile_browser/another.ts", source);
    const addedDuplicates = await diff(duplicateBase);
    expect(addedDuplicates.exitCode).toBe(1);
    expect(addedDuplicates.stdout.toString()).toContain(
      "a PR may add at most one new Feature tag",
    );
  });
  await withRepo(async ({ put, remove, run, baseline }) => {
    const source = recorded("browser-regression");
    const variants = [
      source,
      source.replace("#2296 checker", "#2296 #3183 checker"),
      source.replace("#2296 checker", "#3183 checker"),
    ];
    const files = ["a", "b", "c"].map(
      (name) => `tests/mobile_browser/${name}.ts`,
    );
    for (const [index, file] of files.entries())
      await put(file, variants[index]!);
    const base = await baseline();
    for (const file of files) remove(file);
    for (const [index, name] of ["d", "e", "f"].entries())
      await put(`tests/mobile_browser/${name}.ts`, variants[(index + 1) % 3]!);
    await put(
      "tests/mobile_browser/z.ts",
      source.replaceAll("test_sidebar_status_rows_desktop", "test_new"),
    );
    await put("body.txt", "");
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
  });
  await withRepo(async ({ put, remove, run, baseline }) => {
    const source = recorded("browser-regression");
    const removed = "tests/mobile_browser/a.ts";
    const survivor = "tests/mobile_browser/b.ts";
    await put(removed, source.replace("Feature:", "Regression:"));
    await put(survivor, source);
    const base = await baseline();
    remove(removed);
    await put(survivor, source + "\n");
    await put(
      "body.txt",
      `Removes-regression: #2296 ${removed} test_sidebar_status_rows_desktop`,
    );
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
  });
});

// Regression: #3359 base-branch advances must not look like PR deletions
test("CLI compares PR changes from the merge base unless exact is requested", async () => {
  await withRepo(async ({ put, run, baseline, git }) => {
    await put("README.md", "Base\n");
    const base = await baseline();
    await git("switch", "-qc", "pr");
    await put("README.md", "PR\n");
    await baseline();
    await git("switch", "-qc", "moved-base", base);
    await put("tests/mobile_browser/case.ts", recorded("browser-regression"));
    const moved = await baseline();
    await git("switch", "-q", "pr");
    await put("body.txt", "");
    const diff = (flag: string, ref: string) =>
      run("test_check", flag, ref, "--pr-body", "body.txt", "--strict");
    const merged = await diff("--diff", "moved-base");
    expect(
      merged.stdout
        .toString()
        .split("\n")
        .filter((line) => line.includes(" T8 ")),
    ).toEqual([]);
    expect(merged.exitCode).toBe(0);
    expect(merged.stdout.toString().split("\n")[0]).toBe(`Diff base: ${base}`);
    const exact = await diff("--diff-exact", "moved-base");
    expect(exact.exitCode).toBe(1);
    expect(exact.stdout.toString().split("\n")[0]).toBe(`Diff base: ${moved}`);
    expect(
      exact.stdout
        .toString()
        .split("\n")
        .filter((line) => line.includes(" T8 ")),
    ).toEqual([
      "tests/mobile_browser/case.ts:2 T8 deleted feature #2296 test_sidebar_status_rows_desktop needs Removes-feature",
    ]);
    const ancestor = await diff("--diff", base);
    expect(ancestor.exitCode).toBe(0);
    expect(ancestor.stdout.toString()).toBe(merged.stdout.toString());
    const exactAncestor = await diff("--diff-exact", base);
    expect(exactAncestor.exitCode).toBe(0);
    expect(exactAncestor.stdout.toString()).toBe(ancestor.stdout.toString());
    for (const flags of [
      ["--diff", base, "--diff-exact", moved, "--pr-body", "body.txt"],
      ["--diff-exact"],
      ["--diff-exact", "--pr-body", "body.txt"],
      ["--diff-exact", base],
    ]) {
      const invalid = await run("test_check", ...flags);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr.toString()).toContain("--diff");
    }
  });
});

// Feature: #3532 oversized source and Markdown require a recorded architecture sweep
test("CLI requires a recorded architecture sweep for oversized source and Markdown", async () => {
  await withRepo(async ({ put, run, baseline }) => {
    const file = "src/large.ts";
    const readme = "docs/example/README.md";
    const ledger = "tests/checks/architecture-sweeps.json";
    const source = (lines: number) => put(file, "export {};\n".repeat(lines));
    const docs = (count: number) => put(readme, "🐾".repeat(count));
    await put("docs/agents/repository-map.md", "# Code map\n");
    await put(ledger, "[]\n");
    await source(1499);
    await docs(14999);
    const base = await baseline();
    expect((await run("size_check")).exitCode).toBe(0);
    expect((await run("docs_check")).exitCode).toBe(0);

    await source(1500);
    await docs(15000);
    const head = await baseline();
    await put("body.txt", "");
    expect(
      (
        await run(
          "test_check",
          "--diff",
          base,
          "--pr-body",
          "body.txt",
          "--strict",
        )
      ).exitCode,
    ).toBe(0);
    const sourceFailure = await run("size_check");
    expect(sourceFailure.exitCode).toBe(1);
    expect(sourceFailure.stderr.toString()).toContain(
      `${file}: 1500 lines. Stop: do not trim or delete content to fit.`,
    );
    expect(sourceFailure.stderr.toString()).toContain(
      "Report this to the Coordinator for an effort-4 architecture sweep",
    );
    const docsFailure = await run("docs_check");
    expect(docsFailure.exitCode).toBe(1);
    expect(docsFailure.stderr.toString()).toContain(
      `${readme}: 15000 characters. Stop: do not trim or delete content to fit.`,
    );
    expect(docsFailure.stderr.toString()).toContain(
      "Report this to the Coordinator for an effort-4 architecture sweep of the folder docs/example/",
    );

    const records = [
      { path: file, head, size: 1500 },
      { path: readme, head, size: 15000 },
    ];
    await put(ledger, JSON.stringify(records));
    expect((await run("size_check")).exitCode).toBe(0);
    expect((await run("docs_check")).exitCode).toBe(0);

    await source(1502);
    await docs(15002);
    const largerHead = await baseline();
    await put(
      ledger,
      JSON.stringify([
        { path: file, head: largerHead, size: 1502 },
        { path: readme, head: largerHead, size: 15002 },
      ]),
    );
    await source(1501);
    await docs(15001);
    expect((await run("size_check")).exitCode).toBe(0);
    expect((await run("docs_check")).exitCode).toBe(0);
    await source(1503);
    await docs(15003);
    expect((await run("size_check")).exitCode).toBe(1);
    expect((await run("docs_check")).exitCode).toBe(1);

    await source(2500);
    const capHead = await baseline();
    await put(
      ledger,
      JSON.stringify([{ path: file, head: capHead, size: 2500 }]),
    );
    expect((await run("size_check")).exitCode).toBe(0);
    await source(2501);
    const newGrowth = await run("size_check");
    expect(newGrowth.exitCode).toBe(1);
    expect(newGrowth.stderr.toString()).toContain("architecture sweep");
    expect(newGrowth.stderr.toString()).toContain("2500-line hard cap");
    const overCapHead = await baseline();
    await put(
      ledger,
      JSON.stringify([{ path: file, head: overCapHead, size: 2501 }]),
    );
    const hardCap = await run("size_check");
    expect(hardCap.exitCode).toBe(1);
    expect(hardCap.stderr.toString()).toContain(
      "2501 lines exceeds the 2500-line hard cap",
    );
    expect(hardCap.stderr.toString()).not.toContain("architecture sweep");

    await put(ledger, JSON.stringify([...records, records[0]]));
    const duplicate = await run("docs_check");
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr.toString()).toContain(
      "invalid or duplicate record",
    );
  });
});

async function withRepo(
  body: (repo: {
    put: (file: string, text: string) => Promise<void>;
    read: (file: string) => Buffer;
    remove: (file: string) => void;
    baseline: () => Promise<string>;
    git: (...args: string[]) => Promise<string>;
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
    mkdirSync(join(cwd, "tests/checks"), { recursive: true });
    writeFileSync(join(cwd, capsPath), "{}\n");
    await body({
      git,
      async baseline() {
        await git("commit", "-qm", "checker baseline");
        return git("rev-parse", "HEAD");
      },
      remove(file) {
        rmSync(join(cwd, file));
      },
      read(file) {
        return readFileSync(join(cwd, file));
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
