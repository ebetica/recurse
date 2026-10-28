// Durable context keeps installed extension names and snapshots the Settings
// cap at open; the model stays live. Only the host commits conversation
// documents. Detached compaction notices outlive the compact tool.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  LiveDoc,
  type Conversation,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  compactionPolicy,
  createDurableCompaction,
} from "./durable-compaction.ts";

export interface ContextOptions {
  models: Models;
  maximumContextWindow(): number;
  currentModel(): { provider: string; modelId: string };
  conversation(
    id: Conversation["id"],
  ): { conversation: Conversation; harness: Harness } | null;
  report(event: string, error: unknown): void;
}

/** Cap the registered window; the provider still serves its own window. */
export function withContextWindowCap(
  models: Models,
  maximum: () => number,
): Models {
  return new Proxy(models, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "getModel") return value.bind(target);
      return (provider: string, modelId: string) => {
        const model = target.getModel(provider, modelId);
        const cap = maximum();
        return model !== undefined && model.contextWindow > cap
          ? { ...model, contextWindow: cap }
          : model;
      };
    },
  });
}

export function createContext(options: ContextOptions) {
  const cap = options.maximumContextWindow();
  const models = withContextWindowCap(options.models, () => cap);
  const windowNow = (): number | undefined => {
    const ref = options.currentModel();
    return models.getModel(ref.provider, ref.modelId)?.contextWindow;
  };
  const admissions = new Map<Conversation["id"], Promise<unknown>>();
  const compact = (
    harness: Harness,
    conversation: Conversation,
    context: Context,
  ): Promise<string> => {
    const next = (admissions.get(conversation.id) ?? Promise.resolve()).then(
      async () => {
        const live = await harness.snapshot(LiveDoc, conversation.id, context);
        if (live?.compactions?.length)
          return "Compaction already running; continue.";
        const taskId = await conversation.compact(undefined, context);
        void harness
          .waitForTask(taskId, context)
          .then(async ({ state: { outcome } }) => {
            const text =
              outcome.status === "failed"
                ? `Compaction failed: ${outcome.error.message}. Retry with /compact after finishing the current step.`
                : outcome.status === "completed" &&
                    outcome.result.entryId === undefined &&
                    outcome.result.submissionId === undefined
                  ? "Nothing to compact yet."
                  : null;
            const current = options.conversation(conversation.id);
            if (text === null || current === null) return;
            await current.conversation.submit(
              {
                type: "write",
                requestId: `compact-result:${String(taskId)}`,
                entry: { kind: "recurse.compaction-notice", data: { text } },
              },
              context,
            );
          })
          .catch((error: unknown) =>
            options.report("durable_compaction_result_failed", String(error)),
          );
        return "Compaction running in the background; continue.";
      },
    );
    const tail = next.catch(() => undefined);
    admissions.set(conversation.id, tail);
    void tail.then(() => {
      if (admissions.get(conversation.id) === tail)
        admissions.delete(conversation.id);
    });
    return next;
  };
  const live = (id: Conversation["id"]) => {
    const current = options.conversation(id);
    if (current === null) throw new Error("conversation is closing");
    return current;
  };
  return {
    models,
    get compaction() {
      const window = windowNow();
      return window === undefined ? {} : compactionPolicy(window);
    },
    compact,
    extensions: [
      createDurableCompaction({
        models: options.models,
        conversation: async (_context, id) => live(id).conversation,
        contextWindow: async () => windowNow(),
        compact: (_context, id) => {
          const current = live(id);
          return compact(
            current.harness,
            current.conversation,
            BACKGROUND_CONTEXT,
          );
        },
        report: options.report,
      }),
    ],
  };
}
