/** Codex request inputs: replay cleanup after stamping and detailed payload
 * summaries after any caller transform. Other providers retain Pi's defaults.
 * The Models boundary also covers compaction.
 */
import type { Message, Models } from "@earendil-works/pi-ai";
import { filterCodexReplay } from "./codex-replay.ts";
import { detailedReasoningSummary } from "./reasoning-summary.ts";

export interface CodexOptions {
  models: Models;
}

// Apply Codex defaults only after the caller's payload transform.
export function codexSummaryOptions(
  model: unknown,
  options?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const selected = model as { provider?: string };
  if (selected.provider !== "openai-codex") return options;
  const prior = options?.onPayload as
    | ((payload: unknown, model: unknown) => unknown | Promise<unknown>)
    | undefined;
  return {
    ...options,
    onPayload: async (payload: unknown, actual: { provider: string }) => {
      const changed = await prior?.(payload, actual);
      return detailedReasoningSummary(changed ?? payload, actual);
    },
  };
}

export function createCodex(options: CodexOptions) {
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
    replay: (messages: Message[], provider: string): Message[] =>
      (provider === "openai-codex"
        ? filterCodexReplay(messages)
        : messages) as Message[],
    models: new Proxy(options.models, {
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
            context,
            codexSummaryOptions(model, options),
          );
      },
    }),
  };
}
