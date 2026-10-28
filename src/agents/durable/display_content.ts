/** User-facing tool content replaces only Durable's exact appended diagnostics.
 * Stored/model-facing messages and tool-authored harness text remain unchanged.
 */
export function displayToolContent(content: unknown, data: unknown): unknown {
  if (!Array.isArray(content) || !data || typeof data !== "object")
    return content;
  const diagnostics = (data as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return content;
  if (
    !diagnostics.every(
      (item) =>
        item &&
        typeof item.severity === "string" &&
        typeof item.message === "string",
    )
  )
    return content;
  const suffix = `<harness>\n${diagnostics.map((item) => `[${item.severity}] ${item.message}`).join("\n")}\n</harness>`;
  const last = content.at(-1);
  if (last?.type !== "text" || last.text !== suffix) return content;
  return [
    ...content.slice(0, -1),
    {
      ...last,
      text: `${content.length > 1 ? "\n" : ""}${diagnostics.map((item) => item.message).join("\n")}`,
    },
  ];
}
