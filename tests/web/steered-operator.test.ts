import { expect, test } from "bun:test";
import recorded from "./fixtures/steered-operator-rows.json";
import { rowsToTurns } from "../../web/row-thread-state/row-thread";
import { turnGroupBlocks } from "../../web/thread-render/turn-groups";
import {
  closedBoundaryView,
  boundarySummary,
} from "../../web/thread-render/activity-boundary";
import type { ViewBlock } from "../../web/row-thread-state/view-blocks";

test("recorded Coordinator steering stays inside the operator run until its final reply", () => {
  const blocks = turnGroupBlocks(rowsToTurns(recorded as ViewBlock[]), null);
  expect(blocks).toHaveLength(2);
  const operator = blocks[0];
  expect(operator.operatorAnchored).toBeTrue();
  expect(
    operator.slices.flatMap((slice) =>
      slice.segment.user.map((entry) => entry.offset),
    ),
  ).toEqual([13244, 13251]);
  expect(boundarySummary(operator).incomingAgentMessages).toBe(1);
  expect(boundarySummary(operator).summary).toMatchObject({
    shell: 1,
    read_files: 1,
  });
  expect(
    closedBoundaryView(operator)
      .filter((item) => item.kind === "assistant")
      .map((item) => item.kind === "assistant" && item.entry.id),
  ).toEqual(["row:recorded-6"]);
  expect(
    blocks[1].slices.flatMap((slice) =>
      slice.segment.user.map((entry) => entry.offset),
    ),
  ).toEqual([13258, 13266]);
});
