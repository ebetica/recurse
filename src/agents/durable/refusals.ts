// Omit refused runs from later requests, retaining stored entries for the view.
// Never omit system messages or compaction summaries, or edit in-flight input.
// If a crash precedes the refusal's commit, restore before the next request.
import type { Context } from "@earendil-works/chord/context";
import type {
  ContextEdit,
  EntryId,
  EntryRecord,
  TaskId,
} from "@earendil-works/pi-durable";
import {
  defineExtension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import type { Conversation } from "@earendil-works/pi-durable";
import { isRefusal } from "../view/failure_sentences.ts";

const PAGE = 64;

/**
 * Newest-first walk: stop at an earlier task's final reply, skip non-model,
 * system and compaction entries and failed attempts; omit the rest.
 */
function runEntry(
  entry: EntryRecord,
  seen: Set<TaskId | undefined>,
): "stop" | "omit" | "skip" {
  if (entry.head !== undefined) return "skip";
  const messages = entry.model ?? [];
  const assistant = messages.find((m) => m.role === "assistant");
  if (assistant) {
    const known = seen.has(entry.byTaskId);
    seen.add(entry.byTaskId);
    if (assistant.stopReason !== "toolUse") return known ? "skip" : "stop";
  }
  return messages.length && messages.every((m) => m.role !== "system")
    ? "omit"
    : "skip";
}

const KIND = "recurse.refusal";

/**
 * Find this task's unrestored omission after a crash before refusal commit.
 */
async function ownOmission(
  conversation: Conversation,
  taskId: TaskId,
  context: Context,
): Promise<EntryRecord | undefined> {
  const page = await conversation.entries({}, 8, undefined, context);
  for (const entry of page.items) {
    if ((entry.data as { task?: unknown } | undefined)?.task !== taskId)
      continue;
    return entry.kind === KIND ? entry : undefined;
  }
  return undefined;
}

/** Restore an omission whose refused assistant entry never committed. */
async function restoreOmission(
  conversation: Conversation,
  context: Context,
): Promise<boolean> {
  const page = await conversation.entries({}, 8, undefined, context);
  const marker = page.items.find((entry) => entry.kind.startsWith(KIND));
  if (marker?.kind !== KIND) return false;
  const task = (marker.data as { task?: unknown } | undefined)?.task;
  if (
    page.items.some(
      (entry) =>
        entry.id > marker.id &&
        entry.byTaskId === task &&
        entry.model?.some(
          (message) => message.role === "assistant" && isRefusal(message),
        ),
    )
  )
    return false;
  await conversation.commit(async (tx) => {
    const edits: ContextEdit[] = [];
    for (const { target: id } of marker.edits ?? []) {
      const original = await tx.entry(id);
      if (original?.model)
        edits.push({ target: id, action: "replace", messages: original.model });
    }
    await tx.appendEntry(conversation.id, {
      kind: `${KIND}-undone`,
      data: marker.data,
      edits,
    });
  }, context);
  return true;
}

export function refusalsExtension(
  conversation: (id: Conversation["id"]) => Promise<Conversation>,
) {
  return defineExtension({
    name: "recurse-refusals",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          const target = await conversation(api.conversationId);
          if (await restoreOmission(target, context))
            return { messages: (await target.context(context)).messages };
          return undefined;
        },
        afterResponse: async (message, api, context) => {
          if (!isRefusal(message)) return;
          const target = await conversation(api.conversationId);
          if (await ownOmission(target, api.taskId, context)) return;
          await target.commit(async (tx) => {
            const omit: EntryId[] = [];
            const marker = await tx.latestHeadMarker(target.id);
            const seen = new Set<TaskId | undefined>([api.taskId]);
            let cursor;
            scan: do {
              const page = await tx.scanEntries(
                { conversationId: target.id },
                PAGE,
                cursor,
              );
              for (const entry of page.items) {
                if (marker && Number(entry.id) < Number(marker.head))
                  break scan;
                const step = runEntry(entry, seen);
                if (step === "stop") break scan;
                if (step === "omit") omit.push(entry.id);
              }
              cursor = page.next;
            } while (cursor !== undefined);
            if (omit.length)
              await tx.appendEntry(target.id, {
                kind: KIND,
                data: { task: api.taskId },
                edits: omit.map((id) => ({ target: id, action: "omit" })),
              });
          }, context);
        },
      }),
    ],
  });
}
