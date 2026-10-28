import { describe, expect, test } from "bun:test";
import { rowsToTurns } from "../../web/row-thread-state/row-thread";
import type { ViewBlock } from "../../web/row-thread-state/view-blocks";
import thinkingRows from "../mobile_browser/fixtures/activity-thinking.json";

const row = (over: Partial<ViewBlock> & { id: string }): ViewBlock => ({
  kind: "text",
  role: "user",
  text: "hello",
  origin: "operator",
  name: null,
  args: "",
  result: null,
  result_truncated: false,
  live: false,
  ...over,
});

describe("rowsToTurns", () => {
  test("recorded tool-only GPT requests collate without losing request metadata", () => {
    const [turn] = rowsToTurns(
      thinkingRows.map((entry) =>
        row(entry as Partial<ViewBlock> & { id: string }),
      ),
    );
    expect(turn?.segments).toHaveLength(1);
    const tools = turn?.segments[0]?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([
      "wait",
      "wait",
      "read",
      "grep",
      "edit",
    ]);
    expect(tools.map((tool) => tool.model_time_ms)).toEqual([
      5518, 6487, 7077, 7405, 10488,
    ]);
    expect(tools.map((tool) => tool.thinking)).toEqual([
      "Planning the sample task",
      undefined,
      undefined,
      "Checking the sample output",
      undefined,
    ]);
  });
});
