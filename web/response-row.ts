// Compact provider request labels shared by usage and the downgrade popover.
import type { ModelResponse } from "./types.js";
import { formatTokenCount } from "./thread-render/turn-usage.js";

export function responseRow(
  response: ModelResponse,
  name: (id: string | undefined, provider?: string) => string,
) {
  const requested = name(response.model, response.provider);
  const served = name(
    response.responseModel ?? response.model,
    response.provider,
  );
  const modelChanged =
    !!response.model &&
    !!response.responseModel &&
    response.model !== response.responseModel;
  const effortChanged =
    !!response.thinkingLevel &&
    !!response.providerThinkingLevel &&
    response.thinkingLevel !== response.providerThinkingLevel;
  return {
    model: modelChanged ? `requested ${requested} → served ${served}` : served,
    modelChanged,
    effort: effortChanged
      ? `requested ${response.thinkingLevel} → served ${response.providerThinkingLevel}`
      : (response.providerThinkingLevel ?? response.thinkingLevel),
    effortChanged,
    time:
      response.timestamp === undefined
        ? undefined
        : new Date(response.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }),
    tokens:
      response.inputTokens === undefined && response.outputTokens === undefined
        ? undefined
        : [
            response.inputTokens === undefined
              ? undefined
              : `${formatTokenCount(response.inputTokens)} in`,
            response.outputTokens === undefined
              ? undefined
              : `${formatTokenCount(response.outputTokens)} out`,
          ]
            .filter(Boolean)
            .join(" / "),
  };
}
