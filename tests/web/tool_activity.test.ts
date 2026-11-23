import { expect, test } from "bun:test";
import { workingActivityView } from "../../web/thread-render/tool_activity";

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
