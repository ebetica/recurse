// Reads of an open conversation for the inspector and turn views: the latest
// captured request, tool payloads, context usage, and stored entries by id.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import type { DurableHost } from "../host.ts";
import { modelResponse } from "../../view/model_response";
import { runtime } from "./load.ts";

type Rec = Record<string, unknown>;

/**
 * The inspector's view of a Durable conversation: the system messages and
 * the whole request of its latest model call, exactly as captured.
 */
export async function prompt(host: DurableHost, cid: string): Promise<Rec> {
  const conv = host.deps.load(cid);
  const view = {
    system: "",
    backend: "durable",
    model: conv === null ? null : host.deps.settings(conv)[0],
  };
  const opened = await host.open(cid);
  const { conversationTitleCapture } = await import("../conversation_title");
  const naming = await conversationTitleCapture(
    opened.harness,
    opened.conversation,
  );
  const capture = await opened.captures.latest(cid);
  if (capture === undefined)
    return {
      ...view,
      naming,
      capture_status: host.isRunning(cid) ? "pending" : "unavailable",
    };
  const request = JSON.parse(capture.json) as {
    context: { systemPrompt?: string; messages: Rec[] };
  };
  return {
    ...view,
    naming,
    system: request.context.systemPrompt ?? "",
    system_messages: request.context.messages.filter(
      (message) => message.role === "system",
    ),
    capture_status: "captured",
    request,
  };
}

/** Full payloads, addressed by their existing tool task identity. */
export async function toolDetails(
  host: DurableHost,
  cid: string,
  artifactId: string,
): Promise<Rec | null> {
  const { harness, conversation } = await host.open(cid);
  const { toolDetails } = await import("../tool_details.ts");
  const artifact = await toolDetails(
    harness,
    conversation,
    await host.live(cid),
    artifactId,
    context,
  );
  return artifact === null
    ? null
    : {
        ...artifact,
        raw_url: `/api/conversations/${encodeURIComponent(cid)}/tool-details/${artifactId}/raw`,
      };
}

/** One 64-entry usage page and the latest bounded request capture. */
export async function contextUsage(
  host: DurableHost,
  cid: string,
): Promise<Rec> {
  const { conversation, captures } = await host.open(cid);
  const page = await conversation.entries({}, 64, undefined, context);
  for (const entry of page.items) {
    if (entry.kind === "pi.compaction") break;
    if (entry.kind !== "pi.assistant") continue;
    const message = entry.model?.[0] as Rec | undefined;
    const usage = message?.usage as Rec | undefined;
    const { promptTokens, estimateRequestTokens } =
      await import("../../runtime/context_usage.ts");
    const used = promptTokens(usage);
    const capture = await captures.latest(cid);
    return {
      estimated_tokens:
        used !== null && capture !== undefined
          ? estimateRequestTokens(capture.json, used)
          : null,
      usage: usage
        ? {
            ...usage,
            selectors: [`${message?.provider}/${message?.model}`],
            selectorPartial: false,
          }
        : null,
    };
  }
  return { usage: null };
}

/** One entry of the conversation by id, or undefined. */
async function entry(host: DurableHost, cid: string, id: number) {
  if (!Number.isSafeInteger(id) || id < 0) return undefined;
  const { conversation } = await host.open(cid);
  const at = id as EntryId;
  const page = await conversation.entries(
    { minEntryId: at, maxEntryId: at },
    1,
    undefined,
    context,
  );
  return page.items[0];
}

/** Full thinking of the reply at entry `offset`, or the live answer at -1. */
export async function thinking(
  host: DurableHost,
  cid: string,
  offset: number,
): Promise<Rec | null> {
  const { thinkingText } = await runtime();
  const message =
    offset === -1
      ? (await host.live(cid))?.generation?.message
      : (await entry(host, cid, offset))?.model?.[0];
  const text =
    (message as Rec | undefined)?.role === "assistant"
      ? thinkingText(message)
      : null;
  return text === null ? null : { text, live: offset === -1 };
}

/** The stored model input or reply, addressed by Durable entry id. */
export async function turnPrompt(
  host: DurableHost,
  cid: string,
  offset: number,
): Promise<Rec | null> {
  const message = (await entry(host, cid, offset))?.model?.[0] as
    | Rec
    | undefined;
  if (message?.role !== "user" && message?.role !== "assistant") return null;
  const content = message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part: Rec) => part.type === "text")
            .map((part: Rec) => String(part.text ?? ""))
            .join("")
        : "";
  const { providerUsage } = await import("../../../tool_projection/__init__");
  return {
    driving: message.role === "user" ? text : "",
    message: text,
    system: "",
    role: message.role,
    input_source: "stored",
    steering: false,
    empty: !text,
    ...(message.role === "assistant"
      ? {
          usage: providerUsage(message),
          model_response: modelResponse(message),
        }
      : {}),
  };
}

/** The summary of the compaction entry at `offset`. */
export async function markerSummary(
  host: DurableHost,
  cid: string,
  offset: number,
): Promise<Rec | null> {
  const { compactionSummary } = await runtime();
  const found = await entry(host, cid, offset);
  if (found?.kind !== "pi.compaction") return null;
  const summary = compactionSummary(found);
  return summary.trim() ? { summary, marker: "compact" } : null;
}
