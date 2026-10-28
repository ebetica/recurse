import assert from "node:assert/strict";
import { test } from "node:test";
import { trimOutput } from "../../../../src/extensions/core/shells/trim.ts";

test("defaults are 2000 lines and 50KB", () => {
  const fits = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join("\n");
  assert.equal(trimOutput(fits).trimmed, false);
  const over = `${fits}\nline-2000`;
  const r = trimOutput(over, { logPath: "/tmp/x.log" });
  assert.equal(r.trimmed, true);
  assert.equal(r.omittedLines, 1);
});
