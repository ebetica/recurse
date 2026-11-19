// Cacheable Codex instructions follow any leading compaction checkpoints.
export function usesInputInstructions(id: string): boolean {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?=[.-]|$)/.exec(id);
  const major = Number(version?.[1]);
  return major > 6 || (major === 6 && Number(version?.[2]) >= 2);
}

export function cacheInstructions(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const { instructions, input, ...rest } = payload as Record<string, unknown>;
  if (typeof instructions !== "string" || !Array.isArray(input)) return payload;

  // Pi can put tool declarations before the checkpoint; move only these
  // leading checkpoints in front of the system prompt and tool declarations.
  let end = 0;
  while (
    input[end]?.type === "compaction" ||
    input[end]?.type === "additional_tools"
  )
    end++;
  const preamble = input.slice(0, end);
  return {
    ...rest,
    input: [
      ...preamble.filter((item) => item.type === "compaction"),
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: instructions }],
      },
      ...preamble.filter((item) => item.type !== "compaction"),
      ...input.slice(end),
    ],
  };
}
