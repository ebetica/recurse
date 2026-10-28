import assert from "node:assert/strict";
import { test } from "node:test";
import { redactMonitorLine } from "../../../../src/extensions/core/shells/monitor-notifications.ts";

test("injected output redacts common credentials but leaves the full log untouched", () => {
  assert.equal(
    redactMonitorLine(
      "Authorization: Bearer abc123 token=secret password=hunter2 ok",
    ),
    "Authorization: Bearer [REDACTED] token=[REDACTED] password=[REDACTED] ok",
  );
});
