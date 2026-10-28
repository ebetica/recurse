/** Bound a trailing paragraph break without changing native text selection. */
export function selectionCommentRange(
  selection: Selection,
  root: Element,
): Range {
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || root.contains(range.endContainer))
    return range;
  const bounded = range.cloneRange();
  bounded.setEnd(root, root.childNodes.length);
  return bounded.toString().trimEnd() === selection.toString().trimEnd()
    ? bounded
    : range;
}

/** Append a Markdown quote, leaving the next line for typing. */
export function appendSelectionQuote(draft: string, selection: string): string {
  const quote = selection
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const separator =
    !draft || draft.endsWith("\n\n")
      ? ""
      : draft.endsWith("\n")
        ? "\n"
        : "\n\n";
  return `${draft}${separator}${quote}\n`;
}
