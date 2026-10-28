// Bound model-facing search text without changing the original payload.
import type {
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { trimOutput } from "./search-trim.ts";

/** Search tools whose result text is allowed to consume the model's context. */
export const SEARCH_TOOL_NAMES = new Set(["grep", "find", "multi_grep"]);

function isTextBlock(
  block: ToolResultEvent["content"][number],
): block is Extract<ToolResultEvent["content"][number], { type: "text" }> {
  return block.type === "text" && typeof block.text === "string";
}

// Patch only oversized model-facing search content, preserving original tool
// metadata.
export function trimSearchResult(
  event: ToolResultEvent,
): ToolResultEventResult | undefined {
  if (!SEARCH_TOOL_NAMES.has(event.toolName)) return undefined;

  const textIndexes: number[] = [];
  const textParts: string[] = [];
  for (let index = 0; index < event.content.length; index++) {
    const block = event.content[index];
    if (!block || !isTextBlock(block)) continue;
    textIndexes.push(index);
    textParts.push(block.text);
  }
  if (textIndexes.length === 0) return undefined;

  const trimmed = trimOutput(textParts.join("\n"));
  if (!trimmed.trimmed) return undefined;

  // Invariant: Collapse text only when trimming; retain non-text blocks in
  // order.
  const firstText = textIndexes[0];
  const content = event.content.filter(
    (_block, index) => !textIndexes.includes(index),
  );
  const retainedBeforeFirst = event.content
    .slice(0, firstText)
    .filter((_block, index) => !textIndexes.includes(index)).length;
  content.splice(retainedBeforeFirst, 0, { type: "text", text: trimmed.text });
  return { content };
}
