// Pure agent-reference search for the composer. The DOM adapter in
// agent-finder/ui.ts rebuilds this bounded, normalized index from each
// cached home/remote trees; no message text, prompts, paths or secrets enter.
import { presentAgentState } from "./agent-status.js";
import {
  lexical,
  normalizeSearchText,
  textRank,
  titleTokens,
  type TextRank,
} from "./fuzzy-match.js";
import type { TreeNode } from "./types.js";

export const AGENT_MENTION_LIMIT = 12;
export const AGENT_MENTION_MAX_INDEXED = 50_000;
const MAX_QUERY = 96;

export type MentionGroup = "related" | "siblings" | "other";
export type AgentFinderMode = "mention" | "navigate" | "revive";

export interface MentionAnchor {
  id: string;
  // Draft's eventual parent anchors unsaved-conversation search.
  parent?: string | null;
}

export interface MentionToken {
  start: number;
  end: number;
  query: string;
}

export type AgentFinderKeyAction =
  | "close"
  | "next"
  | "previous"
  | "choose"
  | null;

export function agentFinderKeyAction(
  mode: AgentFinderMode | null,
  hasMatches: boolean,
  key: string,
  shiftKey = false,
  composing = false,
): AgentFinderKeyAction {
  if (!mode || composing) return null;
  if (key === "Escape") return "close";
  if (!hasMatches) return null;
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if ((!shiftKey && key === "Enter") || (mode === "mention" && key === "Tab"))
    return "choose";
  return null;
}

export function agentFinderAnchor(
  selectedId: string,
  draftParent?: string | null,
): MentionAnchor {
  return selectedId === "__draft__"
    ? { id: "__draft__", parent: draftParent || null }
    : { id: selectedId };
}

export type MentionNode = TreeNode & { remote?: string; offline?: boolean };

interface IndexedAgent {
  remote?: string;
  offline?: boolean;
  // Search excludes message previews/descriptions; only tree metadata enters.
  id: string;
  parent: string | null;
  updated: number;
  title: string;
  normalizedTitle: string;
  normalizedId: string;
  tokens: string[];
  status: TreeNode["status"];
  takenOver: boolean;
}

interface RelationshipRank {
  group: MentionGroup;
  groupRank: number;
  sectionRank: number;
  distance: number;
  relationship: string;
}

export interface AgentMentionResult {
  remote?: string;
  offline?: boolean;
  id: string;
  title: string;
  group: MentionGroup;
  relationship: string;
  path: string;
  updated: number;
  status: TreeNode["status"];
  takenOver: boolean;
}

export const normalizeMentionText = normalizeSearchText;

function compareStable(a: IndexedAgent, b: IndexedAgent): number {
  // Invariant: Code-point order is deterministic across browser locales
  // (localeCompare is not), while normalization already gives the user-friendly
  // case/diacritic fold.
  return (
    lexical(a.normalizedTitle, b.normalizedTitle) ||
    lexical(a.normalizedId, b.normalizedId)
  );
}

function cleanPathTitle(title: string): string {
  const oneLine = title.replace(/\s+/gu, " ").trim();
  return oneLine.length > 30 ? oneLine.slice(0, 29) + "…" : oneLine;
}

export class AgentMentionIndex {
  readonly sourceKey: string;
  readonly revision: string;
  readonly size: number;
  private readonly entries = new Map<string, IndexedAgent>();
  private readonly children = new Map<string, string[]>();
  private relationshipAnchor = "";
  private relationshipCache = new Map<string, RelationshipRank>();

  constructor(sourceKey: string, revision: string, nodes: MentionNode[]) {
    this.sourceKey = sourceKey;
    this.revision = revision;
    // Invariant: Retain home first, then recency per source class.
    // Sort explicitly so the cap is independent of wire order.
    const bounded = [...nodes]
      .sort(
        (a, b) =>
          Number(!!a.remote) - Number(!!b.remote) ||
          (b.updated || 0) - (a.updated || 0) ||
          lexical(a.id, b.id),
      )
      .slice(0, AGENT_MENTION_MAX_INDEXED);
    for (const node of bounded) {
      if (!node || typeof node.id !== "string" || !node.id) continue;
      const title =
        (node.title || "New agent").replace(/\s+/gu, " ").trim() || "New agent";
      const indexed: IndexedAgent = {
        id: node.id,
        remote: node.remote,
        offline: node.offline,
        parent: node.parent,
        updated: node.updated || 0,
        title,
        normalizedTitle: normalizeMentionText(title),
        normalizedId: normalizeMentionText(node.id),
        tokens: titleTokens(normalizeMentionText(title)),
        status: node.status,
        takenOver: node.pinned === true,
      };
      this.entries.set(node.id, indexed);
    }
    for (const entry of this.entries.values()) {
      if (!entry.parent) continue;
      const list = this.children.get(entry.parent) || [];
      list.push(entry.id);
      this.children.set(entry.parent, list);
    }
    for (const list of this.children.values())
      list.sort((a, b) =>
        compareStable(this.entries.get(a)!, this.entries.get(b)!),
      );
    this.size = this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  search(
    anchor: MentionAnchor,
    query: string,
    limit = AGENT_MENTION_LIMIT,
  ): AgentMentionResult[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    // Invariant: Clamp before Unicode normalization, and normalize once per
    // search rather than once per indexed agent. A huge paste cannot multiply
    // work by 50k.
    const normalizedQuery = normalizeMentionText(
      query.slice(0, MAX_QUERY),
    ).slice(0, MAX_QUERY);
    const relationships = this.relationshipsFor(anchor);
    const ranked: {
      agent: IndexedAgent;
      text: TextRank;
      rel: RelationshipRank;
    }[] = [];
    for (const agent of this.entries.values()) {
      if (agent.id === anchor.id) continue;
      const text = textRank(agent, normalizedQuery);
      if (!text) continue;
      ranked.push({
        agent,
        text,
        rel: relationships.get(agent.id) || {
          group: "other",
          groupRank: 2,
          sectionRank: 0,
          distance: 0,
          relationship:
            agent.parent && !this.entries.has(agent.parent)
              ? "Orphaned agent"
              : "Agent",
        },
      });
    }
    ranked.sort(
      (a, b) =>
        a.rel.groupRank - b.rel.groupRank ||
        a.text.tier - b.text.tier ||
        a.text.score - b.text.score ||
        Number(!!a.agent.remote) - Number(!!b.agent.remote) ||
        // Invariant: Text relevance stays primary inside a relationship group.
        // These two fields make equal matches deterministic and preserve
        // nearest-first BFS descendants / nearest-parent-first lineage.
        a.rel.sectionRank - b.rel.sectionRank ||
        a.rel.distance - b.rel.distance ||
        b.agent.updated - a.agent.updated ||
        compareStable(a.agent, b.agent),
    );
    return ranked
      .slice(0, Math.min(Math.floor(limit), AGENT_MENTION_LIMIT))
      .map(({ agent, rel }) => ({
        id: agent.id,
        remote: agent.remote,
        offline: agent.offline,
        title: agent.title,
        group: rel.group,
        relationship: rel.relationship,
        path: this.pathFor(agent.id),
        updated: agent.updated,
        status: agent.status,
        takenOver: agent.takenOver,
      }));
  }

  private relationshipsFor(
    anchor: MentionAnchor,
  ): Map<string, RelationshipRank> {
    const actualParent =
      anchor.parent !== undefined
        ? anchor.parent
        : this.entries.get(anchor.id)?.parent;
    const key = `${anchor.id}\0${actualParent ?? ""}`;
    if (key === this.relationshipAnchor) return this.relationshipCache;
    const out = new Map<string, RelationshipRank>();
    const seen = new Set<string>([anchor.id]);

    // Invariant: "Subagents" deliberately means every descendant. Breadth-first
    // traversal gives stable nearest-first depth order and cannot recurse
    // through a cycle.
    let level = [...(this.children.get(anchor.id) || [])];
    let depth = 1;
    while (level.length) {
      const next: string[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.set(id, {
          group: "related",
          groupRank: 0,
          sectionRank: 0,
          distance: depth,
          relationship:
            depth === 1 ? "Subagent" : `Descendant · ${depth} levels`,
        });
        next.push(...(this.children.get(id) || []));
      }
      level = next;
      depth++;
    }

    // Invariant: Parent lineage is nearest parent first. Corrupt cycles stop at
    // the first repeated id, and descendants already seen remain deduplicated.
    let parent =
      anchor.parent !== undefined
        ? anchor.parent
        : this.entries.get(anchor.id)?.parent;
    let distance = 1;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (this.entries.has(parent)) {
        out.set(parent, {
          group: "related",
          groupRank: 0,
          sectionRank: 1,
          distance,
          relationship:
            distance === 1 ? "Parent" : `Ancestor · ${distance} levels`,
        });
        parent = this.entries.get(parent)!.parent;
      } else break;
      distance++;
    }

    // Invariant: Siblings share the actual parent id (including the same
    // missing parent for corrupt/orphaned records), not merely a visual/sidebar
    // relationship.
    if (actualParent) {
      for (const id of this.children.get(actualParent) || []) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.set(id, {
          group: "siblings",
          groupRank: 1,
          sectionRank: 0,
          distance: 1,
          relationship: "Sibling",
        });
      }
    }
    this.relationshipAnchor = key;
    this.relationshipCache = out;
    return out;
  }

  private pathFor(id: string): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: string | null | undefined = id;
    while (current && !seen.has(current) && parts.length < 6) {
      seen.add(current);
      const entry = this.entries.get(current);
      if (!entry) {
        parts.push(current);
        break;
      }
      parts.push(cleanPathTitle(entry.title));
      current = entry.parent;
    }
    const path = parts.reverse().slice(-3).join(" › ");
    return `${path} · ${id}`;
  }
}

// Small deterministic revision: enough to avoid rebuilding normalized strings
// for identical polls. The source key remains separate, so equal trees in two
// Recurse instances never share a cache identity.
export function agentMentionRevision(nodes: MentionNode[]): string {
  let hash = 0x811c9dc5;
  // Invariant: /api/tree has a deterministic recent-first order. Including that
  // order is useful (a recency move changes ranking) and keeps unchanged 1.5s
  // polls O(n) rather than sorting thousands of ids merely to discover nothing
  // changed.
  for (const node of nodes) {
    const value = `${node.id}\0${node.parent || ""}\0${node.title || ""}\0${node.updated || 0}\0${node.status || ""}\0${node.pinned ? 1 : 0}\0${node.remote || ""}\0${node.offline ? 1 : 0}\n`;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${nodes.length}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function finderResultLabel(result: AgentMentionResult): string {
  const stateWord =
    result.status && result.status !== "idle"
      ? presentAgentState(result.status).label
      : null;
  return [
    result.remote ? `Remote · ${result.remote}` : result.relationship,
    result.offline ? "Offline" : stateWord,
    result.takenOver ? "Taken over" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function agentFinderResultIsCurrent(
  id: string,
  liveNodes: Record<string, unknown>,
  index: AgentMentionIndex | null,
): boolean {
  return !!liveNodes[id] && !!index?.has(id);
}

export class AgentMentionCache {
  private current: AgentMentionIndex | null = null;

  refresh(sourceKey: string, nodes: MentionNode[]): AgentMentionIndex {
    const revision = agentMentionRevision(nodes);
    if (
      this.current?.sourceKey === sourceKey &&
      this.current.revision === revision
    )
      return this.current;
    // Invariant: Construct completely before publishing: a keystroke can
    // observe either old or new metadata, never a half-applied
    // rename/reparent/delete.
    const next = new AgentMentionIndex(sourceKey, revision, nodes);
    this.current = next;
    return next;
  }

  clear(): void {
    this.current = null;
  }
  index(): AgentMentionIndex | null {
    return this.current;
  }
}

function insideCode(value: string, at: number): boolean {
  const before = value.slice(0, at);
  const lines = before.split("\n");
  let fence: { char: "`" | "~"; length: number } | null = null;
  for (const line of lines.slice(0, -1)) {
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)\s*$/u)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length)
        fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (open) fence = { char: open[0] as "`" | "~", length: open.length };
  }
  if (fence) return true;

  const line = lines.at(-1) || "";
  if (/^( {4}|\t)/u.test(line)) return true;
  // Invariant: Treat the opening/info line itself as code-like too. Markdown
  // fences must begin at the line start (after at most three spaces).
  if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) return true;

  // Invariant: Inline code spans close only on a backtick run of the same
  // length. This handles legal ``double-backtick`` spans without miscounting
  // their runs.
  let openTicks = 0;
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`" || line[i - 1] === "\\") {
      i++;
      continue;
    }
    let end = i + 1;
    while (line[end] === "`") end++;
    const length = end - i;
    if (!openTicks) openTicks = length;
    else if (length === openTicks) openTicks = 0;
    i = end;
  }
  return openTicks > 0;
}

function validTrigger(value: string, at: number): boolean {
  if (at === 0) return true;
  // Invariant: Reject email/user@host, ssh git@host, path/@agent, @@decorators,
  // and similar identifier/path uses. Whitespace and ordinary opening
  // punctuation are safe.
  return !/[\p{L}\p{N}_@.+\-/\\]/u.test(value[at - 1]);
}

function validQuery(value: string): boolean {
  return (
    value.length <= MAX_QUERY &&
    !/^\s/u.test(value) &&
    !/\s{2,}/u.test(value) &&
    !/[\n\r\t@()[\]{}<>`/\\,;!?=]/u.test(value)
  );
}

export function activeAgentMentionToken(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  composing = false,
): MentionToken | null {
  if (composing || selectionStart !== selectionEnd) return null;
  const caret = Math.max(
    0,
    Math.min(value.length, selectionStart ?? value.length),
  );
  const floor = Math.max(0, caret - MAX_QUERY - 1);
  const at = value.lastIndexOf("@", caret - 1);
  if (at < floor || !validTrigger(value, at) || insideCode(value, at))
    return null;

  // Invariant: Clicking/editing inside an already-inserted reference replaces
  // the complete stable token, rather than leaving its old immutable-id suffix
  // behind.
  const existing = value
    .slice(at)
    .match(
      /^@(.{1,100}?) \(agent ([A-Za-z0-9_-]{1,96}(?:@[A-Za-z0-9._-]{1,32})?)\)/u,
    );
  if (existing && caret < at + existing[0].length) {
    // Invariant: This display text came from formatAgentMention(), which
    // already bounds and sanitizes it. Do not run raw-trigger punctuation rules
    // over it: legal titles can themselves contain @, parentheses, or commas.
    return { start: at, end: at + existing[0].length, query: existing[1] };
  }

  let end = caret;
  // Invariant: In a single-word edit include the suffix to the right of the
  // caret. Once a query contains spaces, preserving all right-hand prose is
  // safer than trying to guess where a multi-word title ends.
  const left = value.slice(at + 1, caret);
  if (!/\s/u.test(left)) {
    // Invariant: Scan whole code points: combining marks and astral symbols are
    // legal in a query too. Indexing value[end] would split emoji into lone
    // surrogates and strand the old suffix when replacing a token from its
    // middle.
    while (end < value.length) {
      const point = String.fromCodePoint(value.codePointAt(end)!);
      if (/[\s@()[\]{}<>`/\\,;!?=]/u.test(point)) break;
      end += point.length;
    }
  }
  const query = value.slice(at + 1, end);
  if (!validQuery(query)) return null;
  return { start: at, end, query };
}

export function formatAgentMention(title: string, id: string): string {
  // Invariant: Keep the visible title human-readable while making nested @
  // triggers and newlines impossible inside the reference. The full immutable
  // id is always present; selection is only text insertion and never routes a
  // message.
  const escaped = (title || "New agent")
    .replace(/\s+/gu, " ")
    .trim()
    // Invariant: Fullwidth glyphs remain readable and NFKC-searchable while
    // making the ASCII `(agent <id>)` delimiter unambiguous.
    .replace(/@/gu, "＠")
    .replace(/\(/gu, "（")
    .replace(/\)/gu, "）");
  const display = [...escaped].slice(0, 80).join("") || "New agent";
  return `@${display} (agent ${id})`;
}

export function insertAgentMention(
  value: string,
  token: MentionToken,
  title: string,
  id: string,
): { value: string; caret: number } {
  const reference = formatAgentMention(title, id);
  const after = value.slice(token.end);
  const space = !after || !/^[\s.,;:!?)]/u.test(after) ? " " : "";
  const inserted = reference + space;
  return {
    value: value.slice(0, token.start) + inserted + after,
    caret: token.start + inserted.length,
  };
}
