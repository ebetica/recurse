// Schema vocabulary for bounded browser-only conversation view state: the two
// retention tiers, their versioned record shapes, defaults, and validation.
// This module parses nothing and touches no storage; it is the one place that
// names the tiers, keys, and bounds every other ui-state module builds on.
export type UiStateRetention = "local" | "session";

export const LOCAL_UI_STATE_PREFIX = "recurse.conversationUiState.local.v1.";
export const SESSION_UI_STATE_PREFIX =
  "recurse.conversationUiState.session.v1.";
export const LEGACY_PANE_PREFIX = "recurse.panePreference.";
export const LOCAL_OWNER_INDEX_KEY =
  "recurse.conversationUiState.localOwners.v1";
export const SESSION_OWNER_INDEX_KEY =
  "recurse.conversationUiState.sessionOwners.v1";
export const LOCAL_REPAIR_KEY = "recurse.conversationUiState.localRepair.v1";
export const SESSION_REPAIR_KEY =
  "recurse.conversationUiState.sessionRepair.v1";
export const MAX_COMPOSER_DRAFT_CHARS = 100_000;
// Plugin payloads plus metadata must fit the smaller local tier.
export const MAX_PLUGIN_STATE_CHARS = 3000;
export const MAX_LOCAL_RECORD_CHARS = 64_000;
export const MAX_SESSION_RECORD_CHARS = 256_000;
export const MAX_PANE_STATES = 16;
export const MAX_RETAINED_OWNERS = 200;
const MAX_ID_CHARS = 256;
const MAX_KEY_CHARS = 80;
export const FLUSH_DELAY_MS = 250;
export const LOCAL_PANE_VISIBILITY = "\0visibility";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export type PaneVisibility =
  | { kind: "default" }
  | { kind: "closed"; lastId?: string }
  | { kind: "open"; id: string; lastId: string };

export interface ComposerViewState {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface StoredPaneState {
  version: number;
  value: unknown;
}

export interface LocalState {
  pane: PaneVisibility;
  panes: Record<string, StoredPaneState>;
}

export interface SessionState {
  composer: ComposerViewState;
  panes: Record<string, StoredPaneState>;
}

export interface ConversationUiState {
  pane: PaneVisibility;
  composer: ComposerViewState;
  localPanes: Record<string, StoredPaneState>;
  sessionPanes: Record<string, StoredPaneState>;
}

export const defaultComposer = (): ComposerViewState => ({
  text: "",
  selectionStart: 0,
  selectionEnd: 0,
});
export const defaultLocalState = (): LocalState => ({
  pane: { kind: "default" },
  panes: {},
});
export const defaultSessionState = (): SessionState => ({
  composer: defaultComposer(),
  panes: {},
});

export const defaultConversationUiState = (): ConversationUiState => ({
  pane: { kind: "default" },
  composer: defaultComposer(),
  localPanes: {},
  sessionPanes: {},
});

export function validBoundedString(
  value: unknown,
  max = MAX_ID_CHARS,
): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function validOwnerId(value: string): boolean {
  return validBoundedString(value);
}

export function ephemeralOwner(value: string): boolean {
  return value.startsWith("draft:");
}

const RESERVED_STATE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export function validStateKey(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_KEY_CHARS &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    !RESERVED_STATE_KEYS.has(value)
  );
}

export function jsonClone(value: unknown): unknown | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > MAX_PLUGIN_STATE_CHARS)
      return undefined;
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}

// Physical key shapes for the fixed slot namespaces. Key construction lives
// here with the other vocabulary so every module addresses the same slots.
export function slotKeyFor(slot: number, retention: UiStateRetention): string {
  const prefix =
    retention === "local" ? LOCAL_UI_STATE_PREFIX : SESSION_UI_STATE_PREFIX;
  return `${prefix}slot.${slot}`;
}

export function fieldKeyFor(
  slot: number,
  retention: UiStateRetention,
  field: number,
): string {
  return `${slotKeyFor(slot, retention)}.field.${field}`;
}

export function repairKeyFor(retention: UiStateRetention): string {
  return retention === "local" ? LOCAL_REPAIR_KEY : SESSION_REPAIR_KEY;
}
