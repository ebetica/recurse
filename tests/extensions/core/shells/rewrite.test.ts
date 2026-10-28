import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HYGIENE_TEACHING,
  wrapSystemReminder,
} from "../../../../src/extensions/core/shells/rewrite.ts";

test("reminder wrapping is bounded and idempotent", () => {
  const note = wrapSystemReminder(HYGIENE_TEACHING);
  assert.match(note, /^<system_reminder>/);
  assert.match(note, /<\/system_reminder>$/);
  assert.equal(wrapSystemReminder(note), note, "wrapping is idempotent");
});
