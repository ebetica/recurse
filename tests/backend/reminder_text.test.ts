import { expect, test } from "bun:test";
import { escapeReminderMarkers } from "../../src/reminder_text";
import fixture from "./fixtures/reminder_text/cases.json";

test("escape_reminder_markers escapes untrusted reminder markers", () => {
  for (const c of fixture.cases) {
    const output = escapeReminderMarkers(c.input);
    expect(output).not.toMatch(/<\/?system[_-]reminder>/);
    expect(output).toEqual(c.out);
  }
});
