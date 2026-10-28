import { expect, test } from "bun:test";
import { ConversationView } from "../../src/agents/view/conversation";
import thinkingFixture from "./fixtures/conversation/thinking-summaries.json";
import live from "./fixtures/conversation/live-snapshots.json";

test("persisted thinking headings reach the expanded activity projection", () => {
  const view = new ConversationView(
    "fixture-conversation",
    "fixture-session",
    "fixture-view",
  );
  view.ingest([thinkingFixture.headings_entry]);
  expect(view.window({ limit: 10 }).blocks[0]?.thinking).toBe(
    "Checking the sample",
  );
  expect(view.window({ limit: 10 }).blocks[0]?.has_thinking).toBe(true);

  const empty = new ConversationView(
    "fixture-conversation",
    "fixture-session",
    "fixture-view",
  );
  empty.ingest([thinkingFixture.empty_entry]);
  expect(empty.window({ limit: 10 }).blocks[0]?.thinking).toBeUndefined();
});

test("split thinking deltas expose only the latest bounded heading", () => {
  const view = new ConversationView(
    "fixture-conversation",
    "fixture-session",
    "fixture-view",
  );
  view.syncLive(live.split_thinking, false);
  const block = view.window({ limit: 10 }).blocks[0];
  expect(block?.thinking).toBe("Planning the fix");
  expect(block?.has_thinking).toBe(true);
});

test("recorded GPT thinking streams before a live tool over the persisted row", () => {
  const persistedUser = {
    type: "message",
    id: "recorded-user",
    parentId: null,
    timestamp: 1000,
    message: { role: "user", content: "Inspect the project responsibilities." },
  };
  const persistedAssistant = {
    type: "message",
    id: "recorded-assistant",
    parentId: "recorded-user",
    timestamp: 1001,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "durable response" }],
      stopReason: "toolUse",
    },
  };
  const view = new ConversationView(
    "fixture-conversation",
    "fixture-session",
    "fixture-view",
  );
  view.ingest([persistedUser, persistedAssistant]);
  view.syncLive(live.recorded_gpt, false);
  const blocks = view.window({ limit: 10 }).blocks;
  expect(blocks.find((block) => block.id === "recorded-assistant")?.text).toBe(
    "durable response",
  );
  expect(
    blocks.find((block) => block.id === "recorded-assistant")?.thinking,
  ).toBe("Reviewing the sample");
  expect(
    blocks.find((block) => block.id === "recorded-assistant")?.has_thinking,
  ).toBe(true);
  expect(
    blocks.find((block) => block.kind === "tool_call" && block.live)?.name,
  ).toBe("read");
  expect(
    blocks.find((block) => block.id === "recorded-assistant")?.live_thinking,
  ).toBe(true);
  view.syncLive([], true);
  const settled = view.window({ limit: 10 }).blocks;
  expect(settled).toHaveLength(2);
  expect(
    settled.find((block) => block.id === "recorded-assistant")?.thinking,
  ).toBeUndefined();
  expect(
    settled.find((block) => block.id === "recorded-assistant")?.live_thinking,
  ).toBeUndefined();
});

test("live thinking summary reaches the browser projection and clears at settle", () => {
  const view = new ConversationView(
    "fixture-conversation",
    "fixture-session",
    "fixture-view",
  );
  view.syncLive(live.run_thinking, false);
  expect(view.window({ limit: 10 }).blocks[0]?.thinking).toBe(
    "Planning the next step",
  );
  view.syncLive(live.run_settled, true);
  expect(view.window({ limit: 10 }).blocks[0]?.thinking).toBeUndefined();
});

test("projects recorded tool timings and Pi model gaps", () => {
  const view = new ConversationView("c", "session", "view");
  view.ingest([
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-09-30T07:00:00.000Z",
      message: { role: "user", content: "inspect" },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-09-30T07:00:02.500Z",
      message: {
        timestamp: Date.parse("2026-09-30T07:00:00.000Z"),
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "Bash",
            arguments: { command: "printf ok" },
          },
        ],
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-09-30T07:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "Bash",
        content: [{ type: "text", text: "ok" }],
        details: {
          recurseToolTiming: {
            version: 1,
            totalMs: 420,
            safetyWaitMs: 120,
            commandMs: 300,
          },
        },
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "r1",
      timestamp: "2026-09-30T07:00:04.800Z",
      message: {
        timestamp: Date.parse("2026-09-30T07:00:03.000Z"),
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    },
  ]);
  const blocks = view.window({ limit: 10 }).blocks;
  expect(blocks.find((block) => block.kind === "tool_call")).toMatchObject({
    timing: { total_ms: 420, safety_ms: 120, command_ms: 300 },
  });
  expect(blocks.find((block) => block.id === "a1")).toMatchObject({
    model_time_ms: 2500,
  });
  expect(blocks.find((block) => block.id === "a2")).toMatchObject({
    model_time_ms: 1800,
  });
});
