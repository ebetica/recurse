import { describe, expect, test } from "bun:test";
import { ConversationView } from "../../src/agents/view/conversation";
import { ViewEntry, window } from "../../src/agents/view/reader";
import {
  foldRowThread,
  rowsToTurns,
  type RowThread,
} from "../../web/row-thread-state/row-thread";
import type {
  ViewBlock,
  ViewPage,
} from "../../web/row-thread-state/view-blocks";
import warming from "./fixtures/row-thread/cache-warm.json";
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
    const warmed = rowsToTurns(warming.rows as unknown as ViewBlock[])[0]!
      .summary!.usage!;
    const warm = warming.rows.find((entry) => entry.role === "usage")!.usage!;
    expect(warmed.cacheRead).toBe(
      warming.priorUsage.cacheRead +
        (warm as { tokens: { cacheRead: number } }).tokens.cacheRead,
    );
    expect(warmed.replies).toBe(warming.priorUsage.replies);
    expect(warmed.calls).toBe(warming.priorUsage.calls + 1);
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

describe("text deltas", () => {
  // Regression: #2958 a late delta was spliced onto text rewritten after its base revision.
  test("a delta read from before a rewrite never splices onto the rewritten text", () => {
    const view = new ViewEntry(new ConversationView("c1", ""));
    const read = (text: string, since: number | null = null) =>
      window(
        view,
        {
          cid: "c1",
          sessionId: "pi",
          sessionFile: "",
          sessionCwd: "/work",
          live: JSON.stringify([
            {
              type: "message",
              id: "reply",
              message: { role: "assistant", content: [{ type: "text", text }] },
            },
          ]),
          envelope: "{}",
          files: "{}",
          maxSessionBytes: 1 << 20,
        },
        { caughtUp: true, since, instance: view.instanceId, textDeltas: true },
      ) as unknown as ViewPage;
    const textOf = (thread: RowThread | null | undefined) =>
      thread?.rows.find((row) => row.id === "reply")?.text;
    const first = read("AB");
    const held = foldRowThread(null, first).state!;
    const rewritten = foldRowThread(held, read("XY", first.revision)).state!;
    const late = read("ABc", first.revision);
    expect(late.blocks).toMatchObject([{ text: "c", text_from: 2 }]);
    expect(textOf(foldRowThread(held, late).state)).toBe("ABc");
    expect(textOf(rewritten)).toBe("XY");
    const fold = foldRowThread(rewritten, late);
    expect(fold.gap).toBe(true);
    expect(fold.state!.revision).toBe(-1);
    expect(textOf(foldRowThread(fold.state, read("ABc", -1)).state)).toBe(
      "ABc",
    );
  });
});
