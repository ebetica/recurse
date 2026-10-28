// Reply finish times commit before assistant entries, keyed by request start.
// The latest-only document retains MAX_REPLIES; older replies show no duration.
// Imported replies use Pi session entry timestamps as their finish times.
import type {
  Conversation,
  ConversationId,
  Tx,
} from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";

export const MAX_REPLIES = 500;

/** Finish time (epoch ms) by the reply message's start timestamp. */
export const ReplyTimesDoc = defineDoc<{ finished: Record<string, number> }>({
  kind: "recurse.reply-times",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ finished: {} }),
});

// Record replies' finish times in `tx`: `replies` pairs a reply message's start
// timestamp with when it finished (an importer passes each Pi assistant
// message's timestamp and its session entry's timestamp).
export async function recordReplyTimes(
  tx: Tx,
  conversationId: ConversationId,
  replies: Iterable<readonly [start: number, finished: number]>,
): Promise<void> {
  const doc = await tx.doc(ReplyTimesDoc, conversationId);
  for (const [start, finished] of replies)
    doc.finished[String(start)] = finished;
  const keys = Object.keys(doc.finished);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REPLIES)))
    delete doc.finished[key];
}

export function replyTimesExtension(
  conversation: (id: Conversation["id"]) => Promise<Conversation>,
  now = Date.now,
) {
  return defineExtension({
    name: "recurse-reply-times",
    hooks: [
      hook(GenerationTask, {
        afterResponse: async (message, api, context) => {
          const finished = now();
          const target = await conversation(api.conversationId);
          await target.commit(
            (tx) =>
              recordReplyTimes(tx, target.id, [[message.timestamp, finished]]),
            context,
          );
        },
      }),
    ],
  });
}
