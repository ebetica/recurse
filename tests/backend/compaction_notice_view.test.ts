import { expect, test } from "bun:test";
import { ConversationView } from "../../src/agents/view/conversation";

import captured from "./fixtures/compaction/real-shapes.json";

test("recorded compact-tool continuation separates insertion from completion", () => {
  const view = new ConversationView("c", "s", "v");
  view.ingest(captured.manual);
  const blocks = view.window({ limit: 100 }).blocks;
  const ids = blocks.map((row) => row.id);
  expect(ids.indexOf("entry-31")).toBeLessThan(ids.indexOf("entry-25"));
  expect(ids.indexOf("entry-29")).toBeGreaterThan(ids.indexOf("entry-27"));
  const summary = blocks.find((row) => row.id === "entry-31");
  const notice = blocks.find((row) => row.id === "entry-29");
  expect(summary?.text).toBe("Captured compaction summary");
  expect(notice?.meta?.summaryEntryId).toBe("entry-31");
});
