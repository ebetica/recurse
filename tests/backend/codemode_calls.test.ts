import { expect, test } from "bun:test";
import { codemodeCalls } from "../../src/agents/view/conversation";

// test-check-allow: T9 Security: untrusted call fields strip controls
test("bounds and cleans untrusted nested-call fields", () => {
  const calls = codemodeCalls({
    calls: [
      {
        name: "mcp__gh__search",
        args: "a\u001b[31m\nb",
        status: "ok",
        durationMs: 12.4,
      },
      {
        name: "bash",
        args: "x".repeat(1000),
        status: "error",
        error: "Tool call blocked: [pi-safety] DENIED: not allowed here",
      },
      { name: 3, status: "weird" },
    ],
  })!;
  for (const call of calls)
    expect(call.args).not.toMatch(/[\u0000-\u001f\u007f]/);
  expect(calls[1]!.error).toBe("[pi-safety] DENIED: not allowed here");
});
