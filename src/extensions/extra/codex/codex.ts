// Codex request inputs: replay cleanup after stamping; detailed summaries,
// saved checkpoints and cacheable instructions after the caller transform.
// Reviews opt into instruction placement only. Other providers keep Pi's
// defaults and never receive compaction items.
import type { Message, Models } from "@earendil-works/pi-ai";
import { filterCodexReplay } from "./codex-replay.ts";
import { sendCheckpointItems, withoutCheckpointItems } from "./compaction.ts";
import { cacheInstructions, usesInputInstructions } from "./instructions.ts";
import { detailedReasoningSummary } from "./reasoning-summary.ts";

interface CodexOptions {
  models: Models;
  reviewer?: boolean;
}

function codexRequestOptions(
  model: unknown,
  options: Record<string, unknown> | undefined,
  reviewer: boolean,
): Record<string, unknown> | undefined {
  const selected = model as { provider?: string; id: string };
  if (selected.provider !== "openai-codex") return options;
  const inline = usesInputInstructions(selected.id);
  if (reviewer && !inline) return options;
  const prior = options?.onPayload as
    | ((payload: unknown, model: unknown) => unknown | Promise<unknown>)
    | undefined;
  return {
    ...options,
    onPayload: async (payload: unknown, actual: { provider: string }) => {
      const changed = (await prior?.(payload, actual)) ?? payload;
      const prepared = reviewer
        ? changed
        : sendCheckpointItems(detailedReasoningSummary(changed, actual));
      return inline ? cacheInstructions(prepared) : prepared;
    },
  };
}

function withoutForeignItems(model: unknown, context: unknown): unknown {
  const messages = (context as { messages?: Message[] } | undefined)?.messages;
  if ((model as { provider?: string }).provider === "openai-codex" || !messages)
    return context;
  const kept = withoutCheckpointItems(messages);
  return kept === messages
    ? context
    : { ...(context as object), messages: kept };
}

/** Codex replay cleanup, a model-bound request transform. */
export const codexReplay = (messages: Message[], provider: string): Message[] =>
  (provider === "openai-codex"
    ? filterCodexReplay(messages)
    : messages) as Message[];

export function createCodex({ models, reviewer = false }: CodexOptions) {
  const methods = new Set([
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
    "streamDeferred",
    "fetchDeferred",
    "cancelDeferred",
    "generateImages",
    "classify",
  ]);
  return {
    models: new Proxy(models, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (!methods.has(String(key))) return value.bind(target);
        return (
          model: unknown,
          context: unknown,
          options?: Record<string, unknown>,
        ) =>
          value.call(
            target,
            model,
            reviewer ? context : withoutForeignItems(model, context),
            codexRequestOptions(model, options, reviewer),
          );
      },
    }),
  };
}
