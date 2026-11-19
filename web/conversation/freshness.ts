// Tracks whether cached content is refreshing or a cold switch is loading.
// Failed reads end refreshing, but cold switches wait for a correct thread.
// Owns focused read state; chrome.ts paints its indicator and dimming.

export type FreshnessPhase = "fresh" | "refreshing" | "loading";

export interface FreshnessState {
  /** The conversation the phase describes; null once nothing is pending. */
  readonly id: string | null;
  readonly phase: FreshnessPhase;
}

export const FRESH: FreshnessState = { id: null, phase: "fresh" };

export const focusedRead: {
  freshness: FreshnessState;
  /** Stop stays detached until the focused read applies. */
  stopReadAuthoritativeId: string | null;
} = { freshness: FRESH, stopReadAuthoritativeId: null };

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

export function noteRefreshFailed(id: string): void {
  focusedRead.freshness = refreshFailed(focusedRead.freshness, id);
}

export function noteRefreshApplied(id: string): void {
  focusedRead.freshness = refreshApplied(focusedRead.freshness, id);
}

/** What to show for the conversation currently selected. */
export function phaseFor(
  current: FreshnessState,
  selectedId: string,
): FreshnessPhase {
  return current.id === selectedId ? current.phase : "fresh";
}
