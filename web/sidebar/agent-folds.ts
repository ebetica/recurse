// Browser-local agent folds survive reloads and server restarts.
// l/Right keeps selected children open; opening another row is temporary.
// Restore drops unversioned opens once, keeping the saved h/Left fold.
// Saved ids are capped; authoritative home reads prune deleted agents.
import { parseConversationId } from "../backends/backend.js";
import { sharedTrees } from "../shared-trees.js";
import { embedded, state } from "../state.js";

const KEY = "recurse.sidebarAgentFolds";
const MAX_ENTRIES = 500;
const MAX_ID_LENGTH = 512;

function isId(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_ID_LENGTH)
    return false;
  try {
    parseConversationId(value);
    return true;
  } catch {
    return false;
  }
}

function load(): { open: string[]; collapsed: string | null } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") {
      const { version, open, collapsed } = saved as Record<string, unknown>;
      return {
        open:
          version === 2 && Array.isArray(open)
            ? [...new Set(open.filter(isId))]
                .filter((id) => id !== collapsed)
                .slice(-(MAX_ENTRIES - Number(isId(collapsed))))
            : [],
        collapsed: isId(collapsed) ? collapsed : null,
      };
    }
  } catch {}
  return { open: [], collapsed: null };
}

const saved = load();
/** Agents opened with l/Right, least recently opened first. */
export const keptOpen: ReadonlySet<string> = new Set(saved.open);
const kept = keptOpen as Set<string>;
let collapsed = saved.collapsed;
let restoring = true;

function save(): void {
  if (embedded) return;
  for (const old of kept) {
    if (kept.size + Number(collapsed !== null) <= MAX_ENTRIES) break;
    kept.delete(old);
  }
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 2, open: [...kept], collapsed }),
    );
  } catch {}
}
save();

/** The open agent folded with h/Left, if any. */
export const collapsedAgent = (): string | null => collapsed;

/** The folded open agent as a projection set. */
export function foldedAgents(): Set<string> | undefined {
  return collapsed ? new Set([collapsed]) : undefined;
}

export function keepSubagentsOpen(id: string): void {
  if (
    id !== state.selectedId ||
    !Object.values(state.nodes).some((node) => node.parent === id)
  )
    return;
  kept.delete(id);
  kept.add(id);
  save();
}

export function foldAgent(id: string): void {
  collapsed = id;
  kept.delete(id);
  save();
}

export function unfoldAgent(): void {
  if (collapsed === null) return;
  collapsed = null;
  save();
}

/** Unfold on selection changes, preserving the restored selection at boot. */
export function noteSelection(id: string): void {
  const keep = restoring && collapsed === id;
  restoring = false;
  if (!keep) unfoldAgent();
}

addEventListener("recurse:tree-authoritative", () => {
  // Invariant: Only an unfiltered home tree proves a home agent is gone.
  if (sharedTrees !== null || embedded) return;
  const gone = (id: string) =>
    !parseConversationId(id).label && !state.nodes[id];
  const before = kept.size + (collapsed ? 1 : 0);
  for (const id of kept) if (gone(id)) kept.delete(id);
  if (collapsed && gone(collapsed)) collapsed = null;
  if (kept.size + (collapsed ? 1 : 0) !== before) save();
});
