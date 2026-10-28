// Only plain prose references; a URL's fragment is not a PR reference.
export function prReferences(text: string): RegExpMatchArray[] {
  return [
    ...text.matchAll(/(?<![\p{L}\p{N}&#])#([1-9]\d{0,5})(?![\p{L}\p{N}])/gu),
  ].filter((match) => {
    const prefix = text.slice(0, match.index).split(/\s/u).at(-1)!;
    return !/^(?:[a-z][\w+.-]*:\/\/|www\.|\/|\.{1,2}\/|[\w.-]+\/)/iu.test(
      prefix.replace(/^[([{'"<]+/u, ""),
    );
  });
}

/** Walk inert, sanitized Markdown; the browser owns HTML parsing. */
export function linkPrReferences(root: DocumentFragment, base: string): void {
  if (!/^https:\/\/github\.com\/[\w.-]{1,39}\/[\w.-]{1,100}$/u.test(base))
    return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest("a, code, pre")) continue;
    const parts: (string | Node)[] = [];
    let end = 0;
    for (const match of prReferences(node.data)) {
      const link = document.createElement("a");
      link.href = `${base}/pull/${match[1]}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[0];
      parts.push(node.data.slice(end, match.index), link);
      end = match.index! + match[0].length;
    }
    if (parts.length) node.replaceWith(...parts, node.data.slice(end));
  }
}
