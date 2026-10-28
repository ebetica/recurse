// Artifact content loading. This module owns fetching an artifact's
// version history and revision content into the pane: version listing,
// request sequencing, and loading notices.
import { backendFor } from "../backends/backend.js";
import {
  artifactFileUrl,
  artifactVersionsUrl,
  normalizeArtifactVersions,
} from "./model.js";
import type { ArtifactInfo } from "./model.js";
import { renderShell } from "./pane.js";
import { setPaneLoading } from "../panes.js";
import {
  reanchor,
  cancelSelectionComment,
  pendingFor,
  currentCommentKey,
} from "./selection-comments.js";
import { errorText, refreshList, selectedInfo } from "./list-cache.js";
import { renderContent } from "./content-view.js";
import { renderComments } from "./comment-bar.js";
import { contentCache, type ArtifactEl } from "./artifact-state.js";

export async function loadVersions(
  pane: ArtifactEl,
  info: ArtifactInfo,
): Promise<void> {
  const rs = pane._rs;
  if (!info.version) {
    rs.versionsId = info.id;
    rs.versions = [];
    rs.versionsLoading = false;
    rs.versionsError = false;
    return;
  }
  if (
    rs.versionsId === info.id &&
    (rs.versionsLoading || rs.versions.length || rs.versionsError)
  )
    return;
  const requestedAgent = rs.agentId!,
    requestedId = info.id;
  const request = ++rs.versionsSeq;
  const current = () =>
    rs.versionsSeq === request &&
    rs.agentId === requestedAgent &&
    rs.versionsId === requestedId;
  rs.versionsId = requestedId;
  rs.versions = info.version
    ? [
        {
          version: info.version,
          created_at: info.updated_at,
          message: "",
          status: info.status,
        },
      ]
    : [];
  rs.versionsLoading = true;
  rs.versionsError = false;
  renderShell(pane);
  try {
    const response = await backendFor(requestedAgent).api(
      artifactVersionsUrl(requestedAgent, requestedId),
    );
    if (!response.ok) throw new Error();
    const versions = normalizeArtifactVersions(await response.json());
    if (!current()) return;
    rs.versions = versions.length ? versions : rs.versions;
  } catch {
    if (current()) rs.versionsError = true;
  } finally {
    if (current()) {
      rs.versionsLoading = false;
      renderShell(pane);
    }
  }
}

export function isCurrentArtifactRequest(
  pane: ArtifactEl,
  sequence: number,
  agentId: string,
  artifactId: string,
  version: string | null,
): boolean {
  const rs = pane._rs;
  return (
    rs.requestSeq === sequence &&
    rs.agentId === agentId &&
    rs.selId === artifactId &&
    rs.selectedVersion === version
  );
}

export async function refreshArtifact(pane: ArtifactEl): Promise<void> {
  const rs = pane._rs;
  if (!rs.agentId || !rs.selId) return;
  contentCache.invalidateArtifact(rs.agentId, rs.selId);
  rs.refreshKey = (rs.refreshKey || 0) + 1;
  rs.requestSeq++;
  rs.shownKey = rs.loadingKey = rs.failedKey = null;
  await refreshList(rs.agentId, true);
}

export async function showArtifact(pane: ArtifactEl): Promise<void> {
  const rs = pane._rs;
  if (rs.restoredArtifactId !== undefined) return;
  const info = selectedInfo(pane);
  if (rs.contentInfo && pendingFor(currentCommentKey(pane))) return;
  if (!info || !rs.agentId) {
    cancelSelectionComment();
    rs.imageAbort?.abort();
    rs.imageAbort = null;
    const documentBody = pane.querySelector<HTMLElement>(".report-doc")!;
    documentBody.innerHTML = "";
    setPaneLoading(pane, false);
    renderComments(pane);
    return;
  }
  if (!rs.selectedVersion) rs.selectedVersion = info.version;
  void loadVersions(pane, info);
  const revisionKey = rs.selectedVersion || `current:${info.updated_at}`;
  const key = `${rs.agentId}\n${info.id}\n${revisionKey}`;
  if (rs.loadingKey === key || rs.shownKey === key || rs.failedKey === key)
    return;
  rs.loadingKey = key;
  const seq = ++rs.requestSeq;
  const requestedAgent = rs.agentId,
    requestedId = info.id,
    requestedVersion = rs.selectedVersion;
  setNotice(pane, "Loading…", false);
  setPaneLoading(pane, true);
  try {
    const snapshot = await contentCache.getOrLoad(
      key,
      requestedAgent,
      requestedId,
      requestedVersion === null,
      async () => {
        const contentInfo = info;
        const entry = contentInfo.entry;
        if (!entry || contentInfo.format === "html") {
          return { info: contentInfo, content: null };
        }
        const response = await backendFor(requestedAgent).api(
          artifactFileUrl(requestedAgent, requestedId, entry, requestedVersion),
          { cache: "reload" },
        );
        if (!response.ok)
          throw new Error(
            errorText("Couldn’t display this artifact", response),
          );
        const content = await response.text();
        return { info: contentInfo, content };
      },
    );
    if (
      !isCurrentArtifactRequest(
        pane,
        seq,
        requestedAgent,
        requestedId,
        requestedVersion,
      )
    )
      return;
    // Invariant: A review may have started while this newer snapshot was
    // fetching.
    if (rs.contentInfo && pendingFor(currentCommentKey(pane))) {
      rs.selectedVersion = rs.contentInfo.version;
      rs.loadingKey = null;
      setPaneLoading(pane, false);
      return;
    }
    rs.contentInfo = snapshot.info;
    const displayed = await renderContent(
      pane,
      snapshot.info,
      snapshot.content,
    );
    if (
      !isCurrentArtifactRequest(
        pane,
        seq,
        requestedAgent,
        requestedId,
        requestedVersion,
      )
    )
      return;
    if (!displayed) {
      rs.failedKey = key;
      rs.shownKey = null;
      return;
    }
    rs.failedKey = null;
    rs.shownKey = key;
    renderShell(pane);
    reanchor(pane, snapshot.info.id);
    renderComments(pane);
    setNotice(pane, rs.justRestored ? "Published version restored" : "", false);
    rs.justRestored = false;
  } catch (err) {
    if (
      !isCurrentArtifactRequest(
        pane,
        seq,
        requestedAgent,
        requestedId,
        requestedVersion,
      )
    )
      return;
    rs.imageAbort?.abort();
    rs.imageAbort = null;
    const documentBody = pane.querySelector<HTMLElement>(".report-doc")!;
    documentBody.innerHTML = "";
    rs.contentInfo = null;
    // Invariant: A failed request must not become a hidden 1.5s retry loop. The
    // next explicit mutation or selection change clears this key and permits
    // retry.
    rs.failedKey = key;
    setNotice(
      pane,
      err instanceof Error && err.message
        ? err.message
        : "Couldn’t display this artifact",
      true,
    );
  } finally {
    if (
      isCurrentArtifactRequest(
        pane,
        seq,
        requestedAgent,
        requestedId,
        requestedVersion,
      )
    ) {
      rs.loadingKey = null;
      renderShell(pane);
    }
  }
}

export function setNotice(
  pane: ArtifactEl,
  text: string,
  error: boolean,
): void {
  // Invariant: artifact-shell is wholly owned by Lit. Mutating its rendered
  // notice node destroys Lit's ChildPart markers and makes the next poll crash
  // while patching missing siblings; update state and let the single owner
  // render.
  pane._rs.notice = text;
  pane._rs.noticeError = error;
  renderShell(pane);
}
