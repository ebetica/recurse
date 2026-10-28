// Remove empty Codex replay items only from model-bound request copies.
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function withoutEmptyAssistantItems(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant") return message;

  const isEmptyText = (block: (typeof message.content)[number]): boolean =>
    block.type === "text" && !/\S/u.test(block.text);
  if (!message.content.some(isEmptyText)) return message;
  if (
    !message.content.some(
      (block) => block.type !== "thinking" && !isEmptyText(block),
    )
  ) {
    return message;
  }

  const kept: typeof message.content = [];
  // Invariant: Buffer reasoning until output proves it is not part of an empty
  // item.
  let pendingReasoning: typeof message.content = [];
  let removedAssistantItem = false;
  let reasoningOnlyForRemovedItem = false;
  const flushReasoning = (): void => {
    kept.push(...pendingReasoning);
    pendingReasoning = [];
    reasoningOnlyForRemovedItem = false;
  };

  for (const block of message.content) {
    if (block.type === "thinking") {
      if (removedAssistantItem) pendingReasoning = [];
      removedAssistantItem = false;
      reasoningOnlyForRemovedItem = false;
      pendingReasoning.push(block);
    } else if (isEmptyText(block)) {
      removedAssistantItem = true;
      reasoningOnlyForRemovedItem = pendingReasoning.length > 0;
    } else {
      flushReasoning();
      removedAssistantItem = false;
      kept.push(block);
    }
  }
  if (!reasoningOnlyForRemovedItem) flushReasoning();
  return { ...message, content: kept };
}

export function filterCodexReplay(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const filtered = messages.map((message) => {
    const next = withoutEmptyAssistantItems(message);
    changed ||= next !== message;
    return next;
  });
  return changed ? filtered : messages;
}
