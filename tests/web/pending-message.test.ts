import { describe, expect, test } from "bun:test";
import {
  acceptedOptimisticEntries,
  pruneOptimisticEntries,
  visibleOptimisticEntries,
  type OptimisticEntry,
} from "../../web/pending-queue/pending-message.js";

describe("queued message removal control", () => {
  // Regression: #1845 admitted message handoff flicker
  test("an admitted receipt keeps the message visible until its view row arrives", () => {
    const send: OptimisticEntry = {
      content: "run the checks",
      id: "message-1",
      ts: 1_000,
      lastTrace: 1_000,
      sinceOffset: 90,
      seq: 1,
      echoed: false,
    };

    let kept = pruneOptimisticEntries(
      [send],
      [
        {
          id: "message-1",
          content: "run the checks",
          delivery_state: "accepted",
        },
      ],
      [],
      2_000,
      30_000,
    );
    expect(visibleOptimisticEntries(kept)).toEqual([]);
    expect(acceptedOptimisticEntries(kept)).toEqual(kept);

    kept = pruneOptimisticEntries(
      kept,
      [],
      [{ content: "run the checks", offset: 120 }],
      3_000,
      30_000,
    );
    expect(kept).toEqual([]);
  });
});
