// Codex-only summary:auto override; never add reasoning or change effort.
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function detailedReasoningSummary(
  payload: unknown,
  model: { provider: string } | undefined,
): unknown {
  if (
    model?.provider !== "openai-codex" ||
    !record(payload) ||
    !record(payload.reasoning) ||
    payload.reasoning.summary !== "auto"
  )
    return payload;
  const reasoning = payload.reasoning;
  return { ...payload, reasoning: { ...reasoning, summary: "detailed" } };
}
