// Bounded provider response metadata copied from Pi, never inferred.
import type { JsonObject } from "./session_entries";

export function modelResponse(message: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const key of [
    "model",
    "provider",
    "responseModel",
    "thinkingLevel",
    "providerThinkingLevel",
  ]) {
    const value = message[key];
    if (typeof value === "string" && value.length <= 256) result[key] = value;
  }
  if (
    typeof message.timestamp === "number" &&
    Number.isFinite(message.timestamp)
  )
    result.timestamp = message.timestamp;
  const rawUsage = message.usage;
  if (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
    const usage = rawUsage as JsonObject;
    const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
    if (
      counts.every(
        (count) =>
          typeof count === "number" && Number.isFinite(count) && count >= 0,
      )
    )
      result.inputTokens = (counts as number[]).reduce(
        (sum, count) => sum + count,
        0,
      );
    if (
      typeof usage.output === "number" &&
      Number.isFinite(usage.output) &&
      usage.output >= 0
    )
      result.outputTokens = usage.output;
  }
  return result;
}
