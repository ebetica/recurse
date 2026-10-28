import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSafetyConfig,
  parseSafetyConfig,
} from "../../../../src/extensions/core/safety/config.ts";

describe("pi-safety config", () => {
  // test-check-allow: T9 Additive operator rules reject malformed configuration.
  test("invalid rules fail closed", () => {
    const result = parseSafetyConfig(
      { rules: "allow everything" },
      "/tmp/config.json",
    );
    expect(result.additionalRules).toEqual([]);
    expect(result.error).toContain("rules must be an array");
  });

  test("appends the Recurse-global Markdown prompt after JSON rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-safety-prompt-"));
    writeFileSync(
      join(dir, "pi-safety.json"),
      JSON.stringify({ rules: ["Deny X."] }),
    );
    expect(loadSafetyConfig(dir).additionalRules).toEqual(["Deny X."]);
    writeFileSync(join(dir, "pi-safety.md"), "\n# Notes\nSlurm jobs are OK.\n");
    expect(loadSafetyConfig(dir).additionalRules).toEqual([
      "Deny X.",
      "# Notes\nSlurm jobs are OK.",
    ]);
  });
});
