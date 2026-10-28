// Shared state contains only cross-module mutable view state/constants. Private
// caches, retry counts and ranks stay with their owning module.
import type { TreeNode, Conversation, Draft } from "./types.js";
import { ConversationCache } from "./conversation/cache.js";
import type { PendingManualTitle } from "./title-actions.js";

export const DRAFT = "__draft__";
export const LAST_AGENT_KEY = "recurse.lastAgent";
/** Side frame: one conversation, no tree/panes/history/global shortcuts. */
export const embedded =
  typeof document !== "undefined" &&
  document.documentElement.hasAttribute("data-embed");

/** A parked embedded app keeps its cache but must not refresh it. */
export function embeddedFrameHidden(): boolean {
  const frame = embedded ? frameElement : null;
  return (
    !!frame &&
    (frame.clientWidth === 0 ||
      frame.clientHeight === 0 ||
      frame.checkVisibility?.() === false)
  );
}

export interface AppState {
  nodes: Record<string, TreeNode>;
  // Side conversations (tree rows with side_of), kept out of nodes.
  sides: TreeNode[];
  draft: Draft | null;
  selectedId: string;
  cursorId: string;
  openConvHash: string;
  selectedRunning: boolean;
  currentConv: Conversation | null;
  convCache: ConversationCache;
  pendingTitles: Record<string, PendingManualTitle>;
  pendingTakeovers: Record<string, boolean>;
  pendingSafety: Record<string, boolean>;
  pendingStops: Record<string, boolean>;
}

export const state: AppState = {
  nodes: {},
  sides: [],
  draft: null,
  selectedId: "",
  cursorId: "",
  openConvHash: "",
  selectedRunning: false,
  currentConv: null,
  convCache: new ConversationCache(),
  pendingTitles: {},
  pendingTakeovers: {},
  pendingSafety: {},
  pendingStops: {},
};

// Only own tree keys are selectable; inherited constructor/prototype keys from
// reader-controlled ids must never pass as real agents.
export function visibleAgent(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.nodes, id);
}

// A saved conversation's immutable id owns its browser UI state. The one live,
// not-yet-created draft gets a separate random namespace until promotion.
export function currentUiOwnerId(): string {
  return state.selectedId === DRAFT
    ? state.draft?.uiStateId || "draft:unowned"
    : state.selectedId;
}

// Detects platform modifier once for key dispatch and help symbols.
export const IS_MAC = /Mac|iP(hone|ad|od)/.test(
  navigator.platform || navigator.userAgent,
);
export const modDown = (e: KeyboardEvent): boolean =>
  IS_MAC ? e.metaKey : e.ctrlKey;
// Coarse primary pointer selects touch UI/native Enter behavior.
export const primaryPointerIsCoarse = (): boolean =>
  matchMedia("(pointer: coarse)").matches;
// Formats platform chords; mac uppercase implies Shift, Ctrl spells it out.
export const chordLabel = (k: string, shift = false, upper = false): string => {
  if (IS_MAC) {
    if (shift && upper) return "⌘" + k.toUpperCase();
    return "⌘" + (shift ? "⇧" : "") + k.toLowerCase();
  }
  return "Ctrl+" + (shift ? "Shift+" : "") + k.toLowerCase();
};
