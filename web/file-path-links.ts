// File paths in replies become links that open the shared file viewer
// (Explorer handles the click). Paths are recognized by shape only; nothing
// is read until a click. Plain clicks open in Recurse; modified clicks
// download through the same operator-only file route.
import { parseConversationId } from "./backends/conversation-id/index.js";

const UNSAFE_PATH = /[\p{Cc}\p{Cf}]/u;
const SEGMENT = String.raw`[\w.@+-]+`;
const PROSE = new RegExp(
  String.raw`(?<![\w/.~:\\-])(?:~|/${SEGMENT})(?:/${SEGMENT})+`,
  "gu",
);
const CODE = new RegExp(
  [
    String.raw`~/.+`,
    String.raw`\.{1,2}/.+`,
    String.raw`/${SEGMENT}(?:/${SEGMENT})+/?`,
    String.raw`/${SEGMENT}\.\w+`,
    String.raw`${SEGMENT}(?:/${SEGMENT})*/${SEGMENT}\.\w+`,
    String.raw`\.\w[\w.-]*`,
  ]
    .map((shape) => `^(?:${shape})$`)
    .join("|"),
  "u",
);

/** A Markdown link target that names a file rather than a page. */
function hrefPath(href: string): string | null {
  if (
    !href ||
    UNSAFE_PATH.test(href) ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|[#?])/i.test(href) ||
    /^\/(?:api|static)\//.test(href)
  )
    return null;
  try {
    return decodeURIComponent(href.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
}

function fileLink(
  path: string,
  owner: string,
  link = document.createElement("a"),
) {
  link.href = `/api/conversations/${encodeURIComponent(parseConversationId(owner).cid)}/tree/raw?${new URLSearchParams({ path })}`;
  link.dataset.filePath = path;
  link.dataset.fileOwner = owner;
  link.classList.add("file-path-link");
  link.removeAttribute("target");
  return link;
}

/** Link file paths in sanitized reply Markdown before backend URL rewriting. */
export function linkFilePaths(root: DocumentFragment, owner: string): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const path = hrefPath(anchor.getAttribute("href")!);
    if (path && path.length <= 4096 && !UNSAFE_PATH.test(path))
      fileLink(path, owner, anchor);
  }
  for (const code of root.querySelectorAll("code")) {
    const text = code.textContent!.trim();
    if (
      text.length > 4096 ||
      UNSAFE_PATH.test(code.textContent!) ||
      code.closest("a, pre") ||
      /\s/.test(text) ||
      !CODE.test(text)
    )
      continue;
    const link = fileLink(text, owner);
    code.replaceWith(link);
    link.append(code);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest("a, code, pre")) continue;
    const parts: (string | Node)[] = [];
    let end = 0;
    for (const match of node.data.matchAll(PROSE)) {
      const start = node.data.lastIndexOf(" ", match.index) + 1;
      const tokenEnd = node.data.indexOf(" ", match.index! + match[0].length);
      if (
        UNSAFE_PATH.test(
          node.data.slice(start, tokenEnd < 0 ? undefined : tokenEnd),
        )
      )
        continue;
      const path = match[0].replace(/\.+$/, "");
      const link = fileLink(path, owner);
      link.textContent = path;
      parts.push(node.data.slice(end, match.index), link);
      end = match.index! + path.length;
    }
    if (parts.length) node.replaceWith(...parts, node.data.slice(end));
  }
}
