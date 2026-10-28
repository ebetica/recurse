// Place changed system sections before user input in Durable requests.
// Durable fronts the baseline itself; Anthropic later reorders updates, while
// OpenAI Responses preserves this hook's order.
import { GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";

/** Move system messages that directly follow a user message in front of it. */
export function systemBeforeUser(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    let j = i + 1;
    while (message.role === "user" && messages[j]?.role === "system") j++;
    out.push(...messages.slice(i + 1, j), message);
    i = j - 1;
  }
  return out;
}

/** Generation hook that applies systemBeforeUser to each model request. */
export const systemBeforeUserHook = hook(GenerationTask, {
  beforeRequest: ({ messages }) => ({ messages: systemBeforeUser(messages) }),
});
