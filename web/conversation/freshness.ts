// Tracks whether cached content is refreshing or a cold switch is loading.
// Failed reads end refreshing, but cold switches wait for a correct thread.
// conversation.ts owns the indicator, dimming, and chrome.

export type FreshnessPhase = "fresh" | "refreshing" | "loading";

export interface FreshnessState {
  /** The conversation the phase describes; null once nothing is pending. */
  readonly id: string | null;
  readonly phase: FreshnessPhase;
}

export const FRESH: FreshnessState = { id: null, phase: "fresh" };

/** Opening `id`, having painted (or not) its cached thread. */
export function conversationSwitched(
  id: string,
  paintedFromCache: boolean,
): FreshnessState {
  return { id, phase: paintedFromCache ? "refreshing" : "loading" };
}

/** The authoritative read for `id` was applied. */
export function refreshApplied(
  current: FreshnessState,
  id: string,
): FreshnessState {
  return current.id === id ? FRESH : current;
}

/** The authoritative read for `id` failed; the poll loop retries. */
export function refreshFailed(
  current: FreshnessState,
  id: string,
): FreshnessState {
  return current.id === id && current.phase === "refreshing" ? FRESH : current;
}

/** What to show for the conversation currently selected. */
export function phaseFor(
  current: FreshnessState,
  selectedId: string,
): FreshnessPhase {
  return current.id === selectedId ? current.phase : "fresh";
}
