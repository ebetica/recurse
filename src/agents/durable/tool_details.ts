// Cold tool inspection reads Durable task/entry identities, not a payload store
// or history scan. An artifact id names a tool task (its assistant input and
// result entry) or, as `r<entry>`, a result copied without its task, whose call
// entry the promotion recorded in CopiedCallsDoc.
import type { Context } from "@earendil-works/chord";
import {
  ToolTask,
  type Conversation,
  type EntryId,
  type EntryRecord,
  type Harness,
  type LiveState,
  type TaskId,
  type ToolTaskInput,
  type ToolTaskResult,
} from "@earendil-works/pi-durable";

import { ReportDoc } from "./report.ts";
import { CopiedCallsDoc } from "./side_conversations.ts";
import { displayToolContent } from "./display_content";

type Rec = Record<string, unknown>;
export async function toolDetails(
  harness: Harness,
  conversation: Conversation,
  live: Readonly<LiveState> | undefined,
  artifactId: string,
  context: Context,
): Promise<Rec | null> {
  const match = /^d-([a-f0-9]{8})-(r?)(0|[1-9][0-9]*)$/.exec(artifactId);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
  const generation = (
    await harness.snapshot(ReportDoc, conversation.id, context)
  )?.generation;
  if (generation !== match[1]) return null;
  const entry = async (id: EntryId) =>
    (
      await conversation.entries(
        { minEntryId: id, maxEntryId: id },
        1,
        undefined,
        context,
      )
    ).items[0];
  const found = await (match[2] ? copiedCall : taskCall)(
    harness,
    conversation,
    Number(match[3]),
    entry,
    context,
  );
  if (found === null) return null;
  const { assistant, callId, resultEntry, terminal, taskId } = found;
  const message = assistant?.model?.[0] as Rec | undefined;
  const call = (Array.isArray(message?.content) ? message.content : []).find(
    (part: Rec) => part.type === "toolCall" && part.id === callId,
  ) as Rec | undefined;
  if (!call) return null;
  const result = resultEntry?.model?.[0] as Rec | undefined;
  const slot =
    taskId === undefined
      ? undefined
      : live?.tools?.find((tool) => tool.taskId === taskId);
  const event = (
    kind: string,
    value: unknown,
    timestamp: unknown,
    isError = false,
  ) => ({
    version: 1,
    kind,
    timestamp: typeof timestamp === "number" ? timestamp / 1000 : 0,
    ...(isError ? { is_error: true } : {}),
    payload: {
      format: "json",
      value,
      bytes: Buffer.byteLength(JSON.stringify(value)),
      omitted_bytes: 0,
    },
  });
  const created =
    typeof message?.timestamp === "number" ? message.timestamp / 1000 : 0;
  const finished =
    typeof result?.timestamp === "number" ? result.timestamp / 1000 : undefined;
  return {
    version: 1,
    artifact_id: artifactId,
    message_id: String(assistant!.id),
    tool_name: call.name,
    status: result
      ? result.isError
        ? "error"
        : "finished"
      : terminal
        ? "stale"
        : "running",
    input_source: "tool_call_hook",
    created_at: created,
    updated_at: finished ?? created,
    ...(finished === undefined ? {} : { finished_at: finished }),
    input: event("input", call.arguments, message?.timestamp),
    latest_update:
      slot?.output === undefined
        ? null
        : event(
            "update",
            {
              content: [{ type: "text", text: slot.output }],
              details: slot.details ?? null,
            },
            message?.timestamp,
          ),
    result: result
      ? event(
          "result",
          {
            content: displayToolContent(result.content, resultEntry?.data),
            details: result.details ?? null,
          },
          result.timestamp,
          Boolean(result.isError),
        )
      : null,
    background_latest: null,
    update_count: slot?.output === undefined ? 0 : 1,
    background_count: 0,
    background_active: false,
    capture: {},
  };
}

interface FoundCall {
  assistant: EntryRecord | undefined;
  callId: string;
  resultEntry: EntryRecord | undefined;
  terminal: boolean;
  taskId?: TaskId;
}

type ReadEntry = (id: EntryId) => Promise<EntryRecord | undefined>;

/** A model tool call by its task. */
async function taskCall(
  harness: Harness,
  conversation: Conversation,
  id: number,
  entry: ReadEntry,
  context: Context,
): Promise<FoundCall | null> {
  const task = await harness.getTask(id as TaskId, context);
  if (
    !task ||
    task.kind !== ToolTask.definition.name ||
    task.conversationId !== conversation.id
  )
    return null;
  const input = task.input as ToolTaskInput;
  // Invariant: Terminal 1.1 tasks lack kind; nested tasks are not model calls.
  if (input.kind === "nested") return null;
  const outcome = task.state.outcome?.result as ToolTaskResult | undefined;
  if (outcome?.kind === "nested") return null;
  return {
    assistant: await entry(input.assistant),
    callId: input.callId,
    resultEntry:
      outcome?.entryId === undefined ? undefined : await entry(outcome.entryId),
    terminal: task.state.status === "terminal",
    taskId: task.id,
  };
}

/** A tool call whose result was copied without its task (promotion). */
async function copiedCall(
  harness: Harness,
  conversation: Conversation,
  id: number,
  entry: ReadEntry,
  context: Context,
): Promise<FoundCall | null> {
  const caller = (
    await harness.snapshot(CopiedCallsDoc, conversation.id, context)
  )?.calls[String(id)];
  const resultEntry = await entry(id as EntryId);
  const result = resultEntry?.model?.[0];
  if (caller === undefined || result?.role !== "toolResult") return null;
  return {
    assistant: await entry(caller as EntryId),
    callId: result.toolCallId,
    resultEntry,
    terminal: true,
  };
}
