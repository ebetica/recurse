import { CopiedCallsDoc } from "../../../src/agents/durable/side_conversations";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
  fauxText,
} from "@earendil-works/pi-ai";
import { addUpload } from "../../../src/agents/runtime/attachments/publish";
import type { Instance } from "../../../src/agents/instance";
import type { Json, Storage } from "./fixture";
import { nowSeconds } from "./fixture";
export function createHistory(instance: Instance, { load, save }: Storage) {
  const { agentTemp } = instance;
  function user(content: string): UserMessage {
    return { role: "user", content, timestamp: Date.now() };
  }

  function toolResult(call: ToolCall, text: string): ToolResultMessage {
    return {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [fauxText(text)],
      isError: false,
      timestamp: Date.now(),
    };
  }

  async function seedHistory(
    cid: string,
    messages: Array<UserMessage | AssistantMessage | ToolResultMessage>,
    { replace = false }: { replace?: boolean } = {},
  ): Promise<void> {
    if (replace) {
      const conv = load(cid)!;
      const prior = conv.reap_deferred;
      try {
        await save({ ...conv, reap_deferred: true });
        if (!(await instance.durable.retire(cid)))
          throw new Error("fixture storage did not close");
      } finally {
        const current = load(cid)!;
        if (prior === undefined) delete current.reap_deferred;
        else current.reap_deferred = prior;
        await save(current);
      }
    }
    const { conversation } = await instance.durable.open(cid);
    await conversation.commit(async (tx) => {
      const { calls } = await tx.doc(CopiedCallsDoc, conversation.id);
      const callers = new Map<string, number>();
      for (const message of messages) {
        const entry = await tx.appendEntry(conversation.id, {
          kind:
            message.role === "toolResult"
              ? "pi.tool-result"
              : `pi.${message.role}`,
          model: [message],
        });
        if (message.role === "assistant")
          for (const part of message.content)
            if (part.type === "toolCall") callers.set(part.id, entry.id);
        if (message.role === "toolResult") {
          const caller = callers.get(message.toolCallId);
          if (caller === undefined)
            throw new Error("fixture tool call missing");
          calls[String(entry.id)] = caller;
        }
      }
    }, BACKGROUND_CONTEXT);
    await save({ ...load(cid)!, updated: nowSeconds() });
  }

  async function seedUpload(
    owner: string,
    body: Uint8Array,
    filename: string,
  ): Promise<Json> {
    const conv = load(owner)!;
    const collection = await agentTemp.ensureUploadsDir(String(conv.tmp_key));
    return (await addUpload(
      collection,
      owner,
      body,
      filename,
    )) as unknown as Json;
  }

  return { user, toolResult, seedHistory, seedUpload };
}
