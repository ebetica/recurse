// Artifact comment bar and mutations. This module owns the comment
// list/cards, the message composer, submit, and the version restore and
// delete actions.
import { backendFor, parseConversationId } from "../backends/backend.js";
import { artifactWorkingPath } from "../../src/artifacts/working_path.js";
import { html, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { panePowerbar } from "../panes/powerbar.js";
import {
  artifactDeleteUrl,
  artifactRestoreUrl,
  isFullVersion,
} from "./model.js";
import { confirmDiscard } from "../comments.js";
import { renderShell } from "./pane.js";
import { showArtifact } from "./artifact-detail.js";
import { setNotice } from "./artifact-detail.js";
import { DRAFT, state } from "../state.js";
import { entry, errorText, refreshList, selectedInfo } from "./list-cache.js";
import {
  cancelSelectionComment,
  cmap,
  commentKey,
  commentRoot,
  commentRoots,
  comments,
  currentCommentKey,
  orderedComments,
  pendingFor,
  unmark,
  unmarkAll,
} from "./selection-comments.js";
import { contentCache } from "./artifact-state.js";
import { commentBoxCoordinates, uploadCommentCrop } from "./comment-crops.js";
import { artifactMount } from "./artifact-state.js";
import type {
  ArtifactEl,
  Comment,
  CommentDoc,
  CommentPane,
} from "./artifact-state.js";

function cardT(pane: CommentPane, comment: Comment): TemplateResult {
  const onInput = (event: Event) => {
    comment.text = (event.target as HTMLTextAreaElement).value;
    renderBar(pane);
  };
  const onRemove = () => {
    const key = currentCommentKey(pane);
    if (key) cmap(key).delete(comment.cid);
    for (const root of commentRoots(pane)) unmark(root, comment.cid);
    renderComments(pane);
  };
  const shortQuote =
    comment.quote.length > 80
      ? `${comment.quote.slice(0, 77)}…`
      : comment.quote;
  return html`<div class="report-comment" data-cid=${comment.cid}>
    <blockquote class="report-comment-quote">${comment.quote}</blockquote>
    <label class="sr-only" for=${`artifact-comment-${comment.cid}`}
      >Comment on “${shortQuote}”</label
    >
    <textarea
      id=${`artifact-comment-${comment.cid}`}
      class="report-comment-input text-field"
      rows="2"
      placeholder="Leave a comment…"
      .value=${live(comment.text)}
      @input=${onInput}
      ?disabled=${pane._rs.deleting}
    ></textarea>
    <div class="report-comment-foot">
      <button
        class="report-comment-del"
        @click=${onRemove}
        ?disabled=${pane._rs.deleting}
        aria-label=${`Remove comment on “${shortQuote}”`}
      >
        Remove
      </button>
    </div>
  </div>`;
}
export function renderComments(pane: CommentPane): void {
  const list = pane.querySelector<HTMLElement>(".report-comments");
  // Invariant: A send can settle after its pane left the document view.
  if (!list) return;
  const ordered = orderedComments(currentCommentKey(pane), commentRoot(pane));
  render(
    html`${repeat(
      ordered,
      (comment) => comment.cid,
      (comment) => cardT(pane, comment),
    )}`,
    list,
  );
  renderBar(pane);
  const artifact = artifactMount.current;
  if (
    artifact === pane &&
    !pendingFor(currentCommentKey(artifact)) &&
    artifact._rs.contentInfo &&
    artifact._rs.followCurrent &&
    artifact._rs.selectedVersion !== artifact._rs.headVersion
  ) {
    renderShell(artifact);
    void showArtifact(artifact);
  }
}
export function displayedInfo(pane: CommentPane): CommentDoc | null {
  const info = pane._rs.contentInfo;
  return info?.id === pane._rs.selId &&
    (info.noun === "file" || isFullVersion(info.version))
    ? info
    : null;
}
interface CommentLocation {
  start: number;
  end: number;
  line: number;
}

// Resolves live Range offsets and start line into concatenated document text.
// Detached/outside ranges stay quote-only; splitText remaps live endpoints.
function locateComment(root: Element, range: Range): CommentLocation | null {
  const owner = root.ownerDocument || document;
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes: Text[] = [];
  let full = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    full += node.textContent || "";
  }
  const toOffset = (container: Node, offset: number): number | null => {
    let base = 0;
    for (const node of nodes) {
      if (node === container) {
        const length = (node.textContent || "").length;
        if (offset < 0 || offset > length) return null;
        return base + offset;
      }
      base += (node.textContent || "").length;
    }
    return null;
  };
  const start = toOffset(range.startContainer, range.startOffset);
  const end = toOffset(range.endContainer, range.endOffset);
  if (start === null || end === null || end < start) return null;
  let line = 1;
  for (let i = 0; i < start; i++) if (full[i] === "\n") line++;
  return { start, end, line };
}
// Invariant: Wrapping text in marks collapses the stored Range onto the
// parent, so a marked comment is located by its marks' own text.
function markedRange(root: Element, cid: string): Range | null {
  const marks = root.querySelectorAll(`mark[data-cid="${cid}"]`);
  const first = marks[0]?.firstChild;
  const last = marks[marks.length - 1]?.lastChild;
  if (!first || !last) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.textContent?.length ?? 0);
  return range;
}
function composeMessage(
  pane: CommentPane,
  crops = new Map<string, { filename: string; url: string }>(),
  snapshot?: Comment[],
): string {
  const displayed = displayedInfo(pane);
  if (!displayed) return "";
  const notes =
    snapshot ??
    orderedComments(currentCommentKey(pane), commentRoot(pane)).filter(
      (comment) => comment.text.trim() && comment.version === displayed.version,
    );
  if (!notes.length) return "";
  const lines = [
    displayed.noun === "file"
      ? `Comments on file "${displayed.title}" (id: ${displayed.id}):`
      : `Comments on artifact "${displayed.title}" (id: ${displayed.id}, version: ${displayed.version}, path: ${artifactWorkingPath(displayed.owner_agent_id ?? parseConversationId(pane._rs.agentId!).cid, displayed.id)}):`,
    "",
  ];
  let boxNumber = 0;
  for (const note of notes) {
    const { box } = note;
    if (box) {
      boxNumber++;
      const crop = crops.get(note.cid);
      lines.push(
        `- box ${boxNumber}${box.page ? ` (page ${box.page})` : ""}, ${commentBoxCoordinates(pane, box)}${crop ? `, attached as ${crop.filename}` : snapshot ? " (crop unavailable; coordinates only)" : ""}:`,
        note.text.trim(),
        ...(crop ? [`![${crop.filename}](${crop.url})`] : []),
        "",
      );
      continue;
    }
    let prefix: string | null = null;
    try {
      const root = commentRoot(pane);
      const location = root
        ? locateComment(root, markedRange(root, note.cid) ?? note.range)
        : null;
      if (location)
        prefix = `- line ${location.line}, chars ${location.start}-${location.end}:`;
    } catch {
      prefix = null;
    }
    if (prefix) lines.push(prefix);
    lines.push(
      ...note.quote.split("\n").map((line) => `> ${line}`),
      note.text.trim(),
      "",
    );
  }
  return lines.join("\n").trim();
}
function commentTarget(): string | null {
  const id = state.selectedId;
  return id && id !== DRAFT && state.nodes[id] ? id : null;
}
export function renderBar(pane: CommentPane): void {
  const bar = pane.querySelector<HTMLElement>(".report-bar");
  if (!bar) return;
  const rs = pane._rs,
    total = pendingFor(currentCommentKey(pane)),
    target = commentTarget();
  const ready = !!composeMessage(pane);
  const sidebar = pane.querySelector(".image-comment-sidebar");
  if (!total) sidebar?.classList.remove("comments-open");
  const countLabel = total === 1 ? "1 comment" : `${total} comments`;
  const toggleList = () => {
    sidebar?.classList.toggle("comments-open");
    renderBar(pane);
  };
  const clear = () => {
    cancelSelectionComment();
    const key = currentCommentKey(pane);
    if (key) comments.delete(key);
    for (const root of commentRoots(pane)) unmarkAll(root);
    renderComments(pane);
  };
  const send = async () => {
    const recipient = commentTarget(),
      artifactId = rs.selId;
    const artifactKey = currentCommentKey(pane),
      displayed = displayedInfo(pane);
    const message = composeMessage(pane);
    const displayedVersion = displayed?.version;
    const submitted = orderedComments(artifactKey, commentRoot(pane))
      .filter(
        (comment) =>
          comment.text.trim() && comment.version === displayedVersion,
      )
      .map((comment) => ({ ...comment }));
    if (
      !recipient ||
      !artifactId ||
      !artifactKey ||
      !displayed ||
      !displayedVersion ||
      !message ||
      !submitted.length
    )
      return;
    const request = ++rs.sendSeq;
    // Invariant: `rs.selectedVersion === displayedVersion` is not required:
    // selection can advance while the old immutable snapshot remains on screen.
    const currentRequest = () =>
      rs.sendSeq === request &&
      rs.selId === artifactId &&
      rs.contentInfo?.id === artifactId &&
      rs.contentInfo.version === displayedVersion &&
      commentTarget() === recipient;
    rs.sending = true;
    rs.sendFailed = false;
    renderBar(pane);
    let ok = false;
    try {
      const crops = new Map<string, { filename: string; url: string }>();
      let boxNumber = 0;
      const stem =
        displayed.title
          .replace(/\.[^.]+$/, "")
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .slice(0, 100) || "file";
      for (const note of submitted) {
        if (!note.box) continue;
        const filename = `${stem}-box-${++boxNumber}.png`;
        try {
          const url = await uploadCommentCrop(
            pane,
            note.box,
            filename,
            recipient,
          );
          crops.set(note.cid, { filename, url });
        } catch {
          // Invariant: An unavailable crop never drops its comment.
        }
        if (!currentRequest()) break;
      }
      if (!currentRequest()) {
        for (const { url } of crops.values())
          void backendFor(recipient)
            .api(
              `${url}?owner=${encodeURIComponent(parseConversationId(recipient).cid)}`,
              {
                method: "DELETE",
              },
            )
            .catch(() => {});
        throw new Error("Comment document changed");
      }
      const response = await backendFor(recipient).jpost(
        `/api/conversations/${recipient}/deliver`,
        {
          content: composeMessage(pane, crops, submitted),
        },
      );
      ok = response.ok;
      if (!ok) {
        for (const { url } of crops.values())
          void backendFor(recipient)
            .api(
              `${url}?owner=${encodeURIComponent(parseConversationId(recipient).cid)}`,
              {
                method: "DELETE",
              },
            )
            .catch(() => {});
      }
      if (ok) {
        // Invariant: The conversation response is enough to clear the staged
        // comments. Do not request a global artifact refresh: its list response
        // can be a stale snapshot that would replace this pane's selected
        // document.
        await response.json();
      }
    } catch {
      ok = false;
    }
    if (!currentRequest()) {
      // Invariant: A refresh or navigation can stale this response without
      // starting a replacement send. Release only this request's spinner;
      // staged comments remain bound to their displayed version and are never
      // cleared here.
      if (rs.sendSeq === request) {
        rs.sending = false;
        renderBar(pane);
      }
      return;
    }
    rs.sending = false;
    if (ok) {
      const map = comments.get(artifactKey);
      for (const sent of submitted) {
        if (map?.get(sent.cid)?.text === sent.text) {
          map.delete(sent.cid);
          for (const root of commentRoots(pane)) unmark(root, sent.cid);
        }
      }
      renderComments(pane);
      pane.dispatchEvent(new Event("comments-sent"));
    } else {
      rs.sendFailed = true;
      renderBar(pane);
    }
  };
  const sendLabel = rs.sending
    ? "Submitting…"
    : rs.sendFailed
      ? "Failed — retry"
      : "Submit comments";
  render(
    html`<div class=${`report-sendbar ${total ? "on" : ""}`} aria-live="polite">
      <span class="report-sendbar-label">${countLabel}</span>
      ${sidebar
        ? html`<button
            class="btn report-sendbar-count"
            aria-expanded=${String(sidebar.classList.contains("comments-open"))}
            @click=${toggleList}
            ?disabled=${!total}
          >
            ${countLabel}
          </button>`
        : null}
      <span class="report-sendbar-note"
        >${target ? "" : "Open an agent to send"}</span
      >
      <span class="report-sendbar-spacer"></span>
      <button
        class="btn quiet report-sendbar-clear"
        @click=${clear}
        ?disabled=${!total || rs.sending || rs.deleting}
      >
        Clear comments
      </button>
      <button
        class="btn primary report-sendbar-send"
        aria-label=${sendLabel}
        @click=${send}
        ?disabled=${!ready || !target || rs.sending || rs.deleting}
      >
        ${sidebar
          ? html`<span class="image-compact-label"
                >${rs.sending
                  ? "Submitting…"
                  : rs.sendFailed
                    ? "Retry"
                    : "Submit"}</span
              ><span class="image-wide-label">${sendLabel}</span>`
          : sendLabel}
      </button>
    </div>`,
    bar,
  );
}

export function discardCurrent(pane: CommentPane): boolean {
  const id = currentCommentKey(pane);
  if (!confirmDiscard(pendingFor(id))) return false;
  cancelSelectionComment();
  if (id) comments.delete(id);
  for (const root of commentRoots(pane)) unmarkAll(root);
  return true;
}

export async function restoreSelected(pane: ArtifactEl): Promise<void> {
  const rs = pane._rs,
    info = selectedInfo(pane),
    version = rs.selectedVersion;
  if (
    !info ||
    !version ||
    !info.version ||
    version === info.version ||
    rs.restoring ||
    !rs.agentId
  )
    return;
  if (
    !confirm(
      `Restore version ${version.slice(0, 8)} of “${info.title}”?\n\nThis changes the published version; existing history remains available.`,
    )
  )
    return;
  const requestedAgent = rs.agentId,
    requestedId = info.id,
    expectedVersion = info.version;
  const request = ++rs.restoreSeq;
  const currentRequest = () =>
    rs.restoreSeq === request &&
    rs.agentId === requestedAgent &&
    rs.selId === requestedId;
  rs.restoring = true;
  renderShell(pane);
  setNotice(pane, "Restoring selected version…", false);
  try {
    const response = await backendFor(requestedAgent).jpost(
      artifactRestoreUrl(requestedId),
      {
        agent: parseConversationId(requestedAgent).cid,
        version,
        expected_version: expectedVersion,
      },
    );
    if (!currentRequest()) return;
    if (!response.ok)
      throw new Error(errorText("Couldn’t restore this version", response));
    rs.notice = "Published version restored";
    rs.noticeError = false;
    rs.versionMenuOpen = false;
    rs.versionsId = null;
    rs.versions = [];
    rs.selectedVersion = null;
    rs.followCurrent = true;
    rs.headVersion = null;
    rs.justRestored = true;
    rs.shownKey = null;
    rs.loadingKey = null;
    rs.failedKey = null;
    rs.contentInfo = null;
    await refreshList(requestedAgent, true);
    if (!currentRequest()) return;
    const current = selectedInfo(pane);
    rs.selectedVersion = current?.version || null;
    rs.headVersion = current?.version || null;
    renderShell(pane);
    void showArtifact(pane);
  } catch (err) {
    if (currentRequest())
      setNotice(
        pane,
        err instanceof Error && err.message
          ? err.message
          : "Couldn’t restore this version",
        true,
      );
  } finally {
    if (currentRequest()) {
      rs.restoring = false;
      renderShell(pane);
    }
  }
}

export async function deleteSelected(pane: ArtifactEl): Promise<void> {
  const rs = pane._rs,
    info = selectedInfo(pane),
    expectedVersion = info?.version;
  if (
    !info ||
    !isFullVersion(expectedVersion) ||
    rs.deleting ||
    rs.sending ||
    rs.restoring ||
    !rs.agentId
  )
    return;
  const pendingComments = pendingFor(currentCommentKey(pane));
  const commentWarning = pendingComments
    ? `\n\nThis also discards ${pendingComments} unsent ${pendingComments === 1 ? "comment" : "comments"}.`
    : "";
  if (
    !confirm(
      `Delete “${info.title}”?\n\nThis permanently deletes every version of this Artifact.${commentWarning}`,
    )
  )
    return;
  const requestedAgent = rs.agentId,
    requestedId = info.id;
  const request = ++rs.deleteSeq;
  const ownsRequest = () =>
    rs.deleteSeq === request && rs.agentId === requestedAgent;
  const currentRequest = () => ownsRequest() && rs.selId === requestedId;
  rs.imageAbort?.abort();
  rs.imageAbort = null;
  rs.deleting = true;
  rs.versionMenuOpen = false;
  cancelSelectionComment();
  setNotice(pane, `Deleting “${info.title}”…`, false);
  renderComments(pane);
  try {
    const response = await backendFor(requestedAgent).api(
      artifactDeleteUrl(requestedId),
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: parseConversationId(requestedAgent).cid,
          expected_version: expectedVersion,
        }),
      },
    );
    if (!response.ok) {
      if (!currentRequest()) return;
      let detail = "";
      try {
        const payload = (await response.json()) as { detail?: unknown };
        if (typeof payload.detail === "string") detail = payload.detail;
      } catch {}
      if (response.status === 409) {
        await refreshList(requestedAgent, true);
        if (!currentRequest()) return;
        rs.requestSeq++;
        rs.loadingKey = null;
        rs.shownKey = null;
        rs.failedKey = null;
        await showArtifact(pane);
        if (!currentRequest()) return;
      }
      throw new Error(
        detail || errorText("Couldn’t delete this Artifact", response),
      );
    }

    contentCache.invalidateArtifact(requestedAgent, requestedId);
    const cache = entry(requestedAgent);
    cache.list = cache.list.filter((item) => item.id !== requestedId);
    const artifactKey = commentKey(requestedAgent, requestedId);
    if (artifactKey) comments.delete(artifactKey);
    if (!currentRequest()) {
      await refreshList(requestedAgent, true);
      return;
    }
    for (const root of commentRoots(pane)) unmarkAll(root);
    rs.requestSeq++;
    rs.versionsSeq++;
    rs.restoreSeq++;
    rs.sendSeq++;
    rs.sending = false;
    rs.sendFailed = false;
    rs.selId = cache.list[0]?.id || null;
    const next = selectedInfo(pane);
    rs.selectedVersion = next?.version || null;
    rs.followCurrent = true;
    rs.headVersion = next?.version || null;
    rs.contentInfo = null;
    rs.shownKey = null;
    rs.loadingKey = null;
    rs.failedKey = null;
    rs.versionsId = null;
    rs.versions = [];
    rs.versionsLoading = false;
    rs.versionsError = false;
    pane.querySelector<HTMLElement>(".report-doc")!.innerHTML = "";
    renderComments(pane);
    await refreshList(requestedAgent, true);
    if (!ownsRequest()) return;
    rs.deleting = false;
    setNotice(pane, `Deleted “${info.title}”`, false);
    void showArtifact(pane);
    const picker =
      panePowerbar(pane).querySelector<HTMLSelectElement>("#artifact-picker");
    const target =
      picker && !picker.disabled
        ? picker
        : pane
            .closest<HTMLElement>(".pane-col")
            ?.querySelector<HTMLElement>(".pane-title");
    target?.focus();
  } catch (err) {
    if (currentRequest()) {
      setNotice(
        pane,
        err instanceof Error && err.message
          ? err.message
          : "Couldn’t delete this Artifact",
        true,
      );
      requestAnimationFrame(() =>
        panePowerbar(pane)
          .querySelector<HTMLElement>(".artifact-delete-btn")
          ?.focus(),
      );
    }
  } finally {
    if (ownsRequest()) {
      rs.deleting = false;
      renderShell(pane);
      renderComments(pane);
    }
  }
}
