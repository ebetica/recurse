// Latest finalized provider prompt occupancy for the compact model footer.
// Output tokens and historical/aggregate billing are deliberately excluded.
import type { Conversation, TurnUsage } from "../types.js";

function compactNumber(value: number, divisor: number, suffix: string): string {
  const rounded = Math.round((value / divisor) * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
}

export function formatContextTokens(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  if (value < 1_000) return `${value} tokens`;
  if (value < 999_950) return `${compactNumber(value, 1_000, "k")} tokens`;
  return `${compactNumber(value, 1_000_000, "m")} tokens`;
}

function promptTokens(usage: TurnUsage | null | undefined): number | null {
  if (!usage) return null;
  const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0))
    return null;
  const total = counts.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

function currentUsage(conv: Conversation | null | undefined): TurnUsage | null {
  if (!conv) return null;
  return promptTokens(conv.latest_context_usage) === null
    ? null
    : conv.latest_context_usage!;
}

export function contextUsageKey(
  conv: Conversation,
): readonly [boolean, TurnUsage | null | undefined] {
  return [
    Object.prototype.hasOwnProperty.call(conv, "latest_context_usage"),
    conv.latest_context_usage,
  ];
}

export function conversationContextSelector(
  conv: Conversation | null | undefined,
): string | null {
  const usage = currentUsage(conv);
  return usage?.selectorPartial === false && usage?.selectors?.length === 1
    ? usage.selectors[0]
    : null;
}

export function conversationContextTokens(
  conv: Conversation | null | undefined,
): number | null {
  return promptTokens(currentUsage(conv));
}

export function conversationContextLabel(
  conv: Conversation | null | undefined,
): string | null {
  const tokens = conversationContextTokens(conv);
  return tokens === null ? null : formatContextTokens(tokens);
}
