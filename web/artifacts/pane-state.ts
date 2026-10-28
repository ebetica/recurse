// Pure persisted selection for the Artifacts pane. Historical-version browsing
// remains transient; pane teardown already returns to the artifact's current
// version, while the stable artifact id is the operator-requested identity.
import type { ArtifactState } from "./artifact-state.js";

export interface ArtifactPaneViewState {
  artifactId: string | null;
}

export interface ArtifactViewSnapshot {
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

export function artifactViewIsStable(view: ArtifactViewSnapshot): boolean {
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
