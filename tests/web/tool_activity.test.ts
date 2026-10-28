import { expect, test } from "bun:test";
import {
  liveActivityState,
  workingActivityView,
} from "../../web/thread-render/tool_activity";

// test-check-allow: T9 Safe tool-name labels and #2036 admission guard.
test("live panel keeps one line and the filename end", () => {
  const unsafe = liveActivityState([
    {
      id: "t4",
      kind: "tool_call",
      running: true,
      name: "sk-abcdefgh12345678",
      input: null,
    },
  ]);
  expect(unsafe.label).toBe("Thinking");
});

// prettier-ignore
// Regression: #2036 stale live pill during queued admission
test("live panel ignores the previous turn during prompt admission", () => { // test-check-allow: T9 Safe tool-name labels and #2036 admission guard.
  const oldRows = [
    { kind: "text", role: "user", text: "old", live: false },
    {
      id: "old-tool",
      kind: "tool_call",
      role: "tool",
      name: "compact",
      input: null,
      live: false,
    },
  ];
  expect(liveActivityState(oldRows, false)).toEqual({
    kind: "starting",
    label: "Starting agent…",
    title: "Starting agent…",
    key: "starting",
  });
  expect(liveActivityState(oldRows, true)).toEqual({
    kind: "thinking",
    label: "Thinking",
    title: "Thinking",
    key: "thinking",
  });
  expect(
    liveActivityState(
      [
        ...oldRows,
        { kind: "text", role: "user", text: "next", live: true },
        { kind: "text", role: "assistant", text: "working", live: true },
      ],
      true,
    ).label,
  ).toBe("Thinking");
  expect(
    liveActivityState(
      [
        ...oldRows,
        { kind: "text", role: "assistant", text: "working", live: true },
      ],
      true,
    ).label,
  ).toBe("Thinking");
  expect(
    liveActivityState(
      [
        ...oldRows,
        {
          kind: "text",
          role: "assistant",
          text: "old answer",
          thinking: "**Old heading**",
          live: false,
        },
        { kind: "text", role: "assistant", text: "working", live: true },
      ],
      true,
    ).label,
  ).toBe("Thinking");
});

// test-check-allow: T9 Safe tool-name labels and #2036 admission guard.
test("only bounded safe names enter the current-action label", () => {
  for (const name of [
    "sk-abcdefgh12345678",
    "github_pat_abcdefgh12345678",
    "bad\nname",
  ]) {
    expect(workingActivityView({ name, input: null }).text).toBe("tool");
  }
});
