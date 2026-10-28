import { describe, expect, test } from "bun:test";
import {
  activityBlocks,
  boundaryIsLive,
  closedBoundaryView,
  type ActivityBoundary,
} from "../../web/thread-render/activity-boundary";

import { activityStatusKind } from "../../web/thread-render/tool_activity";
import type {
  MessageEntry,
  ToolEntry,
  Turn,
  TurnSegment,
} from "../../web/types";

let offset = 0;
const msg = (
  kind: "user" | "assistant",
  content: string,
  over: Partial<MessageEntry> = {},
): MessageEntry => ({
  kind,
  role: kind,
  content,
  offset: ++offset,
  ...over,
});
const tool = (
  kind: ToolEntry["stat"]["kind"] = "shell",
  over: Partial<ToolEntry> = {},
): ToolEntry => ({
  kind: "tool",
  offset: ++offset,
  seq: 1,
  status: "ok",
  stat: { kind },
  ...over,
});
const segment = (over: Partial<TurnSegment> = {}): TurnSegment => ({
  user: [],
  tools: [],
  assistant: null,
  summary: null,
  ...over,
});
const turn = (
  id: string,
  segments: TurnSegment[],
  over: Partial<Turn> = {},
): Turn => ({
  turn_id: id,
  started_at: 1,
  ended_at: 2,
  open: false,
  status: "idle",
  summary: null,
  segments,
  partial: false,
  ...over,
});
const boundaries = (
  turns: Turn[],
  liveReplyTurnId: string | null = null,
  liveReplySegmentIndex: number | null = null,
): ActivityBoundary[] =>
  activityBlocks(turns, liveReplyTurnId, liveReplySegmentIndex).filter(
    (block): block is ActivityBoundary => block.kind === "boundary",
  );

describe("operator response boundaries", () => {
  test("replays three agent wakes from the recorded coordinator session separately", () => {
    const recorded = [
      turn("recorded-1", [
        segment({
          user: [
            msg("user", "The first reviewer stopped without a verdict.", {
              from: "worker-a",
              origin: "agent",
            }),
          ],
          assistant: null,
        }),
      ]),
      turn("recorded-2", [
        segment({
          user: [
            msg("user", "The replacement reviewer could not start.", {
              from: "worker-a",
              origin: "agent",
            }),
          ],
          assistant: null,
        }),
      ]),
      turn("recorded-3", [
        segment({
          user: [
            msg("user", "The final reviewer approved the change.", {
              from: "worker-a",
              origin: "agent",
            }),
          ],
          assistant: null,
        }),
      ]),
    ];
    const groups = boundaries(recorded);
    expect(groups).toHaveLength(3);
    expect(
      groups.map((group) => group.slices[0]?.segment.user[0]?.from),
    ).toEqual(["worker-a", "worker-a", "worker-a"]);
    expect(
      groups.map((group) => group.slices[0]?.segment.user[0]?.content),
    ).toEqual([
      "The first reviewer stopped without a verdict.",
      "The replacement reviewer could not start.",
      "The final reviewer approved the change.",
    ]);
  });
});

describe("visibility grouping anchors", () => {
  // Regression: #1729 only latest boundary owns live surface
  test("the live surface belongs to the latest boundary only", () => {
    const blocks = boundaries([
      turn(
        "steered",
        [
          segment({
            user: [msg("user", "go")],
            tools: [tool("read")],
          }),
          segment({ user: [msg("user", "steer again")] }),
        ],
        { open: true, status: "open" },
      ),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map(boundaryIsLive)).toEqual([true, true]);
    const statuses = blocks.map((boundary, index) =>
      activityStatusKind(
        boundaryIsLive(boundary),
        0,
        2,
        index === blocks.length - 1,
      ),
    );
    expect(statuses).toEqual(["summary", "panel"]);
    const settled = boundaries([
      turn("first", [
        segment({
          user: [msg("user", "go")],
          tools: [tool("read")],
          assistant: msg("assistant", "done"),
        }),
      ]),
      turn("second", [segment({ user: [msg("user", "again")] })], {
        open: true,
        status: "open",
      }),
    ]);
    expect(
      settled.map((boundary, index) =>
        activityStatusKind(
          boundaryIsLive(boundary),
          0,
          2,
          index === settled.length - 1,
        ),
      ),
    ).toEqual(["summary", "panel"]);
  });

  // Regression: #1729 only latest boundary owns live surface
  test("an earlier boundary never renders the live working item", () => {
    const [boundary] = boundaries([
      turn(
        "open",
        [segment({ user: [msg("user", "go")], tools: [tool("read")] })],
        { open: true, status: "open" },
      ),
    ]);
    const kinds = (isLast: boolean): string[] =>
      closedBoundaryView(boundary, isLast).map((item) => item.kind);
    expect(kinds(true)).toContain("working");
    expect(kinds(false)).not.toContain("working");
  });
});
