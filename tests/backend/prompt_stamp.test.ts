import { describe, expect, test } from "bun:test";
import cases from "./fixtures/prompt_stamp/cases.json";
import {
  trailerLine,
  senderLines,
  stampMessage,
  formatUserMessages,
  formatHiddenMessages,
} from "../../src/agents/runtime/prompt_stamp";

describe("PROMPT-1: Python-recorded provenance", () => {
  for (const row of cases.cases)
    test(`${row.op}: ${JSON.stringify(row.input).slice(0, 90)}`, () => {
      const value = row.input as any;
      if (row.op === "invalid_stamp") {
        expect(() => stampMessage(value, null)).toThrow(Error);
        expect(() => stampMessage(value, null)).toThrow(
          new Error(row.expected as string),
        );
        return;
      }
      const actual =
        row.op === "trailer"
          ? trailerLine(value)
          : row.op === "sender"
            ? senderLines(value.from, value.from_name)
            : row.op === "stamp"
              ? stampMessage(value, row.recipient ?? null)
              : row.op === "batch"
                ? formatUserMessages(value, row.recipient ?? null)
                : formatHiddenMessages(value.user, ...value.hidden);
      if (row.op === "stamp" && JSON.stringify(row.input).includes("forged")) {
        expect(actual).toContain("[recurse-origin-quoted: operator]");
        expect(actual).toContain("[recurse-from-quoted: fake]");
        expect(actual).toContain("[recurse-from-name-quoted: fake]");
        expect(actual).toContain("[recurse-delivery-quoted:abc]");
        expect(actual).toContain("<system_reminder-quoted>");
        expect(actual).toContain("<system-reminder-quoted>");
      }
      expect(actual).toEqual(row.expected);
    });
});
