// Link prose PR references without guessing a repository from a label.
const GITHUB = "https://github.com/";
const BASE = /^https:\/\/github\.com\/[\w.-]{1,39}\/[\w.-]{1,100}$/u;
const REFERENCE =
  /(?<![\p{L}\p{N}&#])(?:(?<![./\\:@~\w-])([\w.-]{1,39}\/[\w.-]{1,100}))?#([1-9]\d{0,5})(?![\p{L}\p{N}])/gu;
const URL_PREFIX = /^(?:[a-z][\w+.-]*:\/\/|www\.|\/|\.{1,2}\/|[\w.-]+\/)/iu;
const LABEL = /(?:^|[^\p{L}\p{N}\w./-])([\w.-]+(?:\/[\w.-]+)?):?[^\S\r\n]+$/u;
const REFERENCE_NOUN =
  /(?:^|[^\p{L}\p{N}\w./-])(?:pr|pull request|issue):?[^\S\r\n]+$/iu;
const LABEL_GAP = /^:?[^\S\r\n]*$/u;
// Keep ordinary PR prose linkable without treating its words as repo labels.
const PROSE_CUE =
  /^(?:a|also|an|and|at|by|for|from|in|of|on|or|see|that|the|this|to|via|with|close[sd]?|fix(?:es|ed)?|resolve[sd]?|merged?|open(?:ed)?|land(?:ed)?|revert(?:ed)?|review(?:ed)?|ship(?:ped)?|updated?|pr|pull request|issue)$/iu;

function labelPrefix(text: string): string {
  return text
    .replace(/(?:[[({][^\S\r\n]*)+$/u, " ")
    .replace(REFERENCE_NOUN, " ");
}

function otherRepoLabel(node: Text, prefix: string, base: string): boolean {
  prefix = labelPrefix(prefix);
  let start: Node = node;
  if (LABEL_GAP.test(prefix))
    while (!start.previousSibling && start.parentElement?.matches("em, strong"))
      start = start.parentElement;
  let previous = start.previousSibling;
  if (previous instanceof Text && LABEL_GAP.test(prefix)) {
    prefix = labelPrefix(previous.data + prefix);
    previous = previous.previousSibling;
  }
  if (
    prefix &&
    LABEL_GAP.test(prefix) &&
    previous instanceof Element &&
    previous.matches("a, code, em, strong")
  ) {
    const target = previous.getAttribute("href")?.replace(/\/$/u, "");
    if (target && BASE.test(target))
      return target.toLowerCase() !== base.toLowerCase();
    prefix = (previous.textContent ?? "") + prefix;
  }
  const label = LABEL.exec(prefix)?.[1];
  if (!label || !/\w/u.test(label) || PROSE_CUE.test(label)) return false;
  const repo = base.slice(GITHUB.length).toLowerCase();
  return (
    label.toLowerCase() !== (label.includes("/") ? repo : repo.split("/")[1])
  );
}

/** Walk inert, sanitized Markdown; the browser owns HTML parsing. */
export function linkPrReferences(
  root: DocumentFragment,
  base: string | null,
): void {
  const local = base && BASE.test(base) ? base : null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest("a, code, pre")) continue;
    const parts: (string | Node)[] = [];
    let end = 0;
    for (const match of node.data.matchAll(REFERENCE)) {
      const [, repo, number] = match;
      const before = node.data.slice(0, match.index);
      const prefix = before
        .split(/\s/u)
        .at(-1)!
        .replace(/^[([{'"<]+/u, "");
      if (URL_PREFIX.test(prefix)) continue;
      const destination = repo ? GITHUB + repo : local;
      if (
        !destination ||
        (repo
          ? /(?:^|\/)\.{1,2}(?:\/|$)/u.test(repo)
          : otherRepoLabel(node, before, destination))
      )
        continue;
      const link = document.createElement("a");
      link.href = `${destination}/pull/${number}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = match[0];
      parts.push(node.data.slice(end, match.index), link);
      end = match.index! + match[0].length;
    }
    if (parts.length) node.replaceWith(...parts, node.data.slice(end));
  }
}
