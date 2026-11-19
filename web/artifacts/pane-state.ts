// Artifact selection persistence and browser-history snapshots. Saved layouts
// restore the current revision; linked-document history retains the visited
// revision and reading position. Phone scrolling belongs to the pane column.
import type { ArtifactEl, ArtifactState } from "./artifact-state.js";

export interface ArtifactHistory {
  agent: string;
  id: string;
  depth: number;
  visit: number;
  version: string | null;
  followCurrent: boolean;
  scrollTop: number;
}

/** The existing pane layout moves phone scrolling onto the column. */
export function artifactScroller(pane: ArtifactEl): HTMLElement {
  return matchMedia("(max-width: 700px)").matches ? pane.parentElement! : pane;
}

/** History belongs to a conversation, not the pane's cached DOM instance. */
export function readArtifactHistory(
  agent: string | null,
): ArtifactHistory | null {
  const saved = history.state?.artifactView;
  return saved &&
    saved.agent === agent &&
    typeof saved.id === "string" &&
    Number.isSafeInteger(saved.depth) &&
    saved.depth >= 0 &&
    (saved.version === null || typeof saved.version === "string") &&
    typeof saved.followCurrent === "boolean" &&
    Number.isFinite(saved.scrollTop) &&
    saved.scrollTop >= 0
    ? saved
    : null;
}

export interface ArtifactPaneViewState {
  artifactId: string | null;
}

interface ArtifactViewSnapshot {
  selectedId: string | null;
  selectedVersion: string | null;
  displayedId: string | null;
  displayedVersion: string | null;
  shown: boolean;
}

const MAX_ARTIFACT_ID_CHARS = 256;

export function parseArtifactPaneViewState(
  value: unknown,
): ArtifactPaneViewState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { artifactId: null };
  const id = (value as Record<string, unknown>).artifactId;
  return {
    artifactId:
      typeof id === "string" &&
      id.length > 0 &&
      id.length <= MAX_ARTIFACT_ID_CHARS
        ? id
        : null,
  };
}

export function artifactRestoreListReady(
  loaded: boolean,
  fetching: boolean,
  invalidated: boolean,
  error: string | null,
): boolean {
  return loaded && !fetching && !invalidated && !error;
}

export function restoreArtifactSelection(
  state: ArtifactPaneViewState,
  availableIds: readonly string[],
): string | null {
  if (state.artifactId && availableIds.includes(state.artifactId))
    return state.artifactId;
  return availableIds[0] || null;
}

function artifactViewIsStable(view: ArtifactViewSnapshot): boolean {
  return (
    view.shown &&
    !!view.selectedId &&
    !!view.selectedVersion &&
    view.displayedId === view.selectedId &&
    view.displayedVersion === view.selectedVersion
  );
}

// A refresh can briefly return a list from before the selected artifact was
// published. Keep the old list and rendered document until a later response
// includes the selected id; falling back to list[0] would replace the view.
export function shouldPreserveArtifactView(
  view: ArtifactViewSnapshot,
  nextIds: readonly string[],
): boolean {
  return artifactViewIsStable(view) && !nextIds.includes(view.selectedId!);
}

// A pane snapshot for freshness checks. The pane passes its selection state and
// the agent it belongs to; a mismatched agent yields an empty snapshot.
export function artifactViewSnapshot(
  rs: ArtifactState,
  agentId: string,
): ArtifactViewSnapshot {
  return {
    selectedId: rs.agentId === agentId ? rs.selId : null,
    selectedVersion: rs.agentId === agentId ? rs.selectedVersion : null,
    displayedId: rs.agentId === agentId ? rs.contentInfo?.id || null : null,
    displayedVersion:
      rs.agentId === agentId ? rs.contentInfo?.version || null : null,
    shown: rs.agentId === agentId && !!rs.shownKey,
  };
}

export function stableArtifactView(
  rs: ArtifactState | null,
  agentId: string,
): boolean {
  return !!rs && artifactViewIsStable(artifactViewSnapshot(rs, agentId));
}
