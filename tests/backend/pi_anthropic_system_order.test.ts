import { expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

async function wire(messages: Message[]) {
  const model = {
    ...fauxProvider({
      api: "anthropic-messages",
      provider: "anthropic",
    }).getModel(),
    api: "anthropic-messages" as const,
    id: "claude-sonnet-4-5",
    baseUrl: "http://127.0.0.1:9",
    compat: { supportsMidConvoSystemMessages: true },
  };
  let payload: { messages: { role: string; content: unknown }[] };
  const result = await streamSimple(model, normalizeContext({ messages }), {
    apiKey: "fixture",
    onPayload(value) {
      payload = value as typeof payload;
      throw new Error("captured before transport");
    },
  }).result();
  expect(result.errorMessage).toBe("captured before transport");
  return payload!.messages;
}
const user = (content: string): Message => ({
  role: "user",
  content,
  timestamp: 1,
});
const system = (content: string): SystemMessage => ({
  role: "system",
  content,
  timestamp: 1,
});

for (const stopReason of ["interrupted", "error", "aborted"] as const) {
  // Regression: #2289 system updates after empty interrupted assistants
  test(`system updates survive a skipped ${stopReason} assistant without preceding a user`, async () => {
    const messages = await wire([
      system("baseline"),
      user("first"),
      fauxAssistantMessage("reply"),
      system("update one"),
      user("second"),
      { ...fauxAssistantMessage(""), content: [], stopReason },
      system("update two"),
      user("retry"),
    ]);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
      "system",
    ]);
    expect(JSON.stringify(messages.at(-1))).toContain("update one");
    expect(JSON.stringify(messages.at(-1))).toContain("update two");
  });
}

// Regression: #2289 system updates after empty interrupted assistants
test("multiple pending updates form one system message before a real assistant", async () => {
  const messages = await wire([
    system("baseline"),
    user("first"),
    fauxAssistantMessage("reply"),
    system("update one"),
    user("second"),
    system("update two"),
    fauxAssistantMessage("continued"),
    user("third"),
  ]);
  expect(messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "system",
    "assistant",
    "user",
  ]);
  expect(JSON.stringify(messages[3])).toContain("update one");
  expect(JSON.stringify(messages[3])).toContain("update two");
});

// Regression: #2289 system updates after empty interrupted assistants
test("updates stay outside a tool-use/result pair and retain changed sections", async () => {
  const messages = await wire([
    system("baseline"),
    user("first"),
    fauxAssistantMessage(fauxToolCall("probe", {}, { id: "call_1" })),
    { ...system(""), sections: { recurse_tree: "tree two" } },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "probe",
      content: [{ type: "text", text: "finished" }],
      isError: false,
      timestamp: 1,
    },
    { ...system(""), sections: { recurse_tree: "tree three" } },
    fauxAssistantMessage("continued"),
  ]);
  expect(messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "system",
    "assistant",
  ]);
  expect(messages[2]!.content).toEqual([
    {
      type: "tool_result",
      tool_use_id: "call_1",
      content: "finished",
      is_error: false,
    },
  ]);
  expect(JSON.stringify(messages[3])).toContain("tree two");
  expect(JSON.stringify(messages[3])).toContain("tree three");
});
