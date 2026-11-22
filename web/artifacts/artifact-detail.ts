// Artifact content loading. This module owns fetching an artifact's
// version history and revision content into the pane: version listing,
// request sequencing, and loading notices.
// App startup supplies content rendering through the shared contract.
import { backendFor } from "../backends/backend.js";
import {
  artifactFileUrl,
  artifactVersionsUrl,
  normalizeArtifactVersions,
} from "./model.js";
import type { ArtifactInfo } from "./model.js";
import { setPaneLoading } from "../panes.js";
import {
  reanchor,
  cancelSelectionComment,
  pendingFor,
  pendingCommentVersion,
  currentCommentKey,
  commentKey,
} from "./selection-comments.js";
import { errorText, refreshList, selectedInfo } from "./list-cache.js";
import { scrollDocumentFragment } from "../document-markdown.js";
import { artifactScroller } from "./pane-state.js";
import { renderComments } from "./comment-bar.js";
import {
  contentCache,
  renderArtifactContent,
  setNotice,
  type ArtifactEl,
} from "./artifact-state.js";
export { setNotice };
import { reviewedVersion, type DocumentChanges } from "../document-review.js";

async function loadVersions(
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
  pane.renderShell();
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
      pane.renderShell();
    }
  }
}

/** The reviewed version's text when the latest Markdown version is newer. */
async function changesFor(
  pane: ArtifactEl,
  info: ArtifactInfo,
  version: string | null,
): Promise<{ changes: DocumentChanges; previous: string } | null> {
  const rs = pane._rs,
    agentId = rs.agentId!,
    entry = info.entry;
  if (info.format !== "markdown" || !entry || !info.version) return null;
  const doc = commentKey(agentId, info.id)!;
  const since = reviewedVersion(doc, info.version);
  if (version !== info.version || since === info.version) return null;
  try {
    const snapshot = await contentCache.getOrLoad(
      `${agentId}\n${info.id}\n${since}\nreviewed`,
      agentId,
      info.id,
      false,
      async () => {
        const response = await backendFor(agentId).api(
          artifactFileUrl(agentId, info.id, entry, since),
        );
        if (!response.ok) throw new Error("reviewed version unavailable");
        return { info, content: await response.text() };
      },
    );
    const changes: DocumentChanges = {
      doc,
      version: info.version,
      since,
      onReviewed: () => {
        rs.changes = null;
        pane.renderShell();
      },
      onCompare: () => {
        rs.changes = null;
        rs.shownKey = null;
        pane.renderShell();
        void showArtifact(pane);
      },
    };
    return { changes, previous: snapshot.content ?? "" };
  } catch {
    return null;
  }
}

function isCurrentArtifactRequest(
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

function scrollLinkedSection(pane: ArtifactEl): void {
  const rs = pane._rs;
  const section = rs.linkedSection;
  if (section?.artifact === rs.selId) {
    const body = pane.querySelector<HTMLElement>(".report-doc");
    if (body) scrollDocumentFragment(body, section.fragment, true);
    rs.linkedSection = undefined;
  } else if (rs.linkedScrollTop !== undefined)
    artifactScroller(pane).scrollTop = rs.linkedScrollTop;
  rs.linkedScrollTop = undefined;
}

export async function showArtifact(pane: ArtifactEl): Promise<void> {
  const rs = pane._rs;
  if (
    rs.restoredArtifactId !== undefined ||
    rs.revalidating ||
    rs.awaitingHistory
  )
    return;
  const info = selectedInfo(pane);
  if (rs.contentInfo && pendingFor(currentCommentKey(pane))) return;
  if (!info || !rs.agentId) {
    cancelSelectionComment(pane);
    rs.contentAbort?.abort();
    rs.contentAbort = null;
    const documentBody = pane.querySelector<HTMLElement>(".report-doc")!;
    documentBody.innerHTML = "";
    setPaneLoading(pane, false);
    renderComments(pane);
    return;
  }
  rs.selectedVersion =
    pendingCommentVersion(pane) ?? rs.selectedVersion ?? info.version;
  void loadVersions(pane, info);
  const revisionKey = rs.selectedVersion || `current:${info.updated_at}`;
  const key = `${rs.agentId}\n${info.id}\n${revisionKey}`;
  if (rs.shownKey === key) {
    scrollLinkedSection(pane);
    return;
  }
  if (rs.loadingKey === key || rs.failedKey === key) return;
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
        );
        if (!response.ok)
          throw new Error(
            errorText("Couldn’t display this artifact", response),
          );
        const content = await response.text();
        return { info: contentInfo, content };
      },
    );
    const changes = await changesFor(pane, snapshot.info, requestedVersion);
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
    rs.contentInfo = {
      ...snapshot.info,
      version: requestedVersion ?? snapshot.info.version,
    };
    const displayed = await renderArtifactContent(
      pane,
      rs.contentInfo,
      snapshot.content,
      changes,
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
    pane.renderShell();
    reanchor(pane, snapshot.info.id);
    renderComments(pane);
    setNotice(pane, rs.justRestored ? "Published version restored" : "", false);
    rs.justRestored = false;
    scrollLinkedSection(pane);
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
    rs.contentAbort?.abort();
    rs.contentAbort = null;
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
      pane.renderShell();
    }
  }
}
