import { expect, test } from "bun:test";
import { thinkingText } from "../../src/agents/view/reader";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("thinkingText reads one bounded assistant entry and fails closed", async () => {
  const path = join(
    tmpdir(),
    `thinking-${process.pid}-${Math.random().toString(16).slice(2)}.jsonl`,
  );
  const text = "A bounded thought. ".repeat(1000);
  writeFileSync(
    path,
    JSON.stringify({
      type: "message",
      id: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: text }],
      },
    }) + "\n",
  );
  try {
    const read = await thinkingText(path, 0);
    const value = read?.text;
    expect(typeof value).toBe("string");
    if (typeof value === "string") {
      expect(value.startsWith("A bounded thought.")).toBe(true);
      expect([...value].length).toBeLessThanOrEqual(8000);
    }
    expect(await thinkingText(path, -1)).toBeNull();
    expect(await thinkingText(path, 99_999)).toBeNull();
  } finally {
    rmSync(path, { force: true });
  }
});
