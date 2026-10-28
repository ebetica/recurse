// Owns Artifact pane shell, selection and version controls. HTML uses an
// offline opaque-origin sandbox without session access; other formats preview
// only when safe. Immutable originals remain downloadable.
import { html, render, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  ARTIFACT_DELETE_ICON,
  ARTIFACT_DOWNLOAD_ICON,
  ARTIFACT_HISTORY_ICON,
  ARTIFACTS_ICON,
  REFRESH_ICON,
} from "../icons.js";
import { openPane, registerPane, setPaneLoading } from "../panes.js";
import { panePowerbar, renderPowerbarControls } from "../panes/powerbar.js";
import { readAgentLink, readArtifactLink } from "../deep-link.js";
import { artifactGeneration } from "../panes/autoopen.js";
import { DRAFT, state } from "../state.js";
import { registerCommentSource } from "../comments.js";
import { artifactFileUrl, isFullVersion, versionLabel } from "./model.js";
import type { PaneContext } from "../types.js";
import {
  artifactRestoreListReady,
  parseArtifactPaneViewState,
  restoreArtifactSelection,
  type ArtifactPaneViewState,
} from "./pane-state.js";
import {
  ARTIFACTS_PANE_ID,
  artifactMount,
  commentMount,
  type ArtifactEl,
} from "./artifact-state.js";
import {
  entry,
  listFor,
  refreshList,
  scheduleListRefresh,
  selectedInfo,
} from "./list-cache.js";
import { refreshArtifact, showArtifact } from "./artifact-detail.js";
import {
  deleteSelected,
  discardCurrent,
  renderBar,
  renderComments,
  restoreSelected,
} from "./comment-bar.js";
import {
  cancelSelectionComment,
  claimComments,
  commentRoots,
  comments,
  pendingTotal,
  pendingFor,
  currentCommentKey,
  unmarkAll,
} from "./selection-comments.js";

let linkedAgent: string | null = null;

export function openArtifactLink(hash = location.hash): void {
  const id = readArtifactLink(hash);
  if (!id || !state.selectedId || state.draft) return;
  if (artifactMount.current && !discardCurrent(artifactMount.current)) return;
  linkedAgent = state.selectedId;
  if (!openPane(ARTIFACTS_PANE_ID)) return;
  const pane = artifactMount.current;
  if (!pane) return;
  pane._rs.linkedArtifactId = id;
  pane._rs.restoredArtifactId = id;
  if (pane._rs.selId !== id || !pane._rs.followCurrent) {
    pane._rs.selectedVersion = null;
    pane._rs.followCurrent = true;
    pane._rs.shownKey = null;
    pane._rs.loadingKey = null;
    pane._rs.requestSeq++;
  }
  pane._rs.failedKey = null;
  void refreshList(state.selectedId, true);
  renderShell(pane);
  void showArtifact(pane);
}

document.addEventListener("click", (event) => {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  const href = link?.getAttribute("href");
  if (!href?.startsWith("#") || !readArtifactLink(href)) return;
  if (readAgentLink(href).present) return;
  event.preventDefault();
  openArtifactLink(href);
});

const HISTORY_ICON = unsafeHTML(ARTIFACT_HISTORY_ICON);
const DOWNLOAD_ICON = unsafeHTML(ARTIFACT_DOWNLOAD_ICON);
const TRASH_ICON = unsafeHTML(ARTIFACT_DELETE_ICON);
document.addEventListener("mousedown", (event) => {
  if (!artifactMount.current?._rs.versionMenuOpen) return;
  const bar = panePowerbar(artifactMount.current);
  const menu = bar.querySelector(".artifact-version-menu");
  const button = bar.querySelector(".artifact-version-btn");
  if (
    menu?.contains(event.target as Node) ||
    button?.contains(event.target as Node)
  )
    return;
  artifactMount.current._rs.versionMenuOpen = false;
  renderShell(artifactMount.current);
});
function openArtifactVersionMenuPane(): ArtifactEl | null {
  const menu = document.querySelector<HTMLElement>(".artifact-version-menu");
  const pane = menu ? artifactMount.current : null;
  return pane?._rs.versionMenuOpen ? pane : null;
}

export function artifactVersionMenuOpen(): boolean {
  return openArtifactVersionMenuPane() !== null;
}

export function closeArtifactVersionMenuKeyboardLayer(): boolean {
  const pane = openArtifactVersionMenuPane();
  if (!pane) return false;
  pane._rs.versionMenuOpen = false;
  renderShell(pane);
  panePowerbar(pane)
    .querySelector<HTMLElement>(".artifact-version-btn")
    ?.focus();
  return true;
}

function applyRestoredArtifactSelection(pane: ArtifactEl): boolean {
  const rs = pane._rs;
  if (rs.restoredArtifactId === undefined || !rs.agentId) return true;
  const cache = entry(rs.agentId);
  // Invariant: A cached list is not authoritative while an invalidation/fetch
  // is pending, and an error must retain the wanted id for the next explicit
  // retry.
  if (
    !artifactRestoreListReady(
      cache.loaded,
      cache.fetching,
      cache.invalidated,
      cache.error,
    )
  )
    return false;
  const nextId =
    rs.linkedArtifactId ||
    restoreArtifactSelection(
      { artifactId: rs.restoredArtifactId },
      cache.list.map((item) => item.id),
    );
  rs.restoredArtifactId = undefined;
  if (nextId === rs.selId) return true;
  rs.selId = nextId;
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
  rs.versionMenuOpen = false;
  return true;
}

export function renderShell(pane: ArtifactEl): void {
  const rs = pane._rs,
    cache = rs.agentId ? entry(rs.agentId) : null;
  const list = listFor(rs.agentId);
  const selectionReady = applyRestoredArtifactSelection(pane);
  if (
    selectionReady &&
    !rs.linkedArtifactId &&
    !list.some((item) => item.id === rs.selId)
  ) {
    rs.selId = list[0]?.id || null;
    rs.selectedVersion = list[0]?.version || null;
    rs.contentInfo = null;
    rs.shownKey = null;
  }
  const currentInfo = selectedInfo(pane);
  if (currentInfo && rs.headVersion !== currentInfo.version) {
    rs.headVersion = currentInfo.version;
    rs.versionsId = null;
    rs.versions = [];
    rs.versionsError = false;
  }
  const holding = pendingFor(currentCommentKey(pane)) > 0;
  if (
    currentInfo &&
    rs.followCurrent &&
    !holding &&
    rs.selectedVersion !== currentInfo.version
  ) {
    rs.selectedVersion = currentInfo.version;
    rs.contentInfo = null;
    rs.shownKey = null;
    rs.loadingKey = null;
  }
  const info =
    rs.contentInfo &&
    rs.contentInfo.id === currentInfo?.id &&
    rs.contentInfo.version === rs.selectedVersion
      ? rs.contentInfo
      : currentInfo;
  const versions = rs.versionsId === currentInfo?.id ? rs.versions : [];
  const onArtifact = (event: Event) => {
    if (!discardCurrent(pane)) {
      (event.target as HTMLSelectElement).value = rs.selId || "";
      return;
    }
    rs.imageAbort?.abort();
    rs.imageAbort = null;
    rs.sendSeq++;
    rs.restoreSeq++;
    rs.deleteSeq++;
    rs.sending = false;
    rs.restoring = false;
    rs.deleting = false;
    rs.linkedArtifactId = undefined;
    rs.selId = (event.target as HTMLSelectElement).value;
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
    rs.versionMenuOpen = false;
    renderShell(pane);
    void showArtifact(pane);
  };
  const versionAction = (action: () => void) => {
    closeArtifactVersionMenuKeyboardLayer();
    action();
  };
  const applyVersion = (version: string) => {
    if (version === rs.selectedVersion) return;
    if (!discardCurrent(pane)) return;
    rs.imageAbort?.abort();
    rs.imageAbort = null;
    rs.sendSeq++;
    rs.restoreSeq++;
    rs.deleteSeq++;
    rs.sending = false;
    rs.restoring = false;
    rs.deleting = false;
    rs.selectedVersion = version;
    rs.followCurrent = rs.selectedVersion === currentInfo?.version;
    rs.contentInfo = null;
    rs.shownKey = null;
    rs.loadingKey = null;
    rs.failedKey = null;
    renderShell(pane);
    void showArtifact(pane);
  };
  const toggleVersionMenu = () => {
    rs.versionMenuOpen = !rs.versionMenuOpen;
    renderShell(pane);
    if (rs.versionMenuOpen)
      requestAnimationFrame(() => {
        const menu = panePowerbar(pane).querySelector<HTMLElement>(
          ".artifact-version-menu",
        );
        (
          menu?.querySelector<HTMLElement>('[aria-checked="true"]') ||
          menu?.querySelector<HTMLElement>('[role^="menuitem"]')
        )?.focus();
      });
  };
  const onMenuKeydown = (event: KeyboardEvent) => {
    const items = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
        '[role^="menuitem"]',
      ),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeArtifactVersionMenuKeyboardLayer();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[at + 1] || items[0])?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[at - 1] || items[items.length - 1])?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };
  const hasVersions = !!currentInfo?.version;
  const offCurrent =
    !!rs.selectedVersion && rs.selectedVersion !== currentInfo?.version;
  const canRestore = offCurrent && hasVersions;
  const download =
    currentInfo && rs.agentId && currentInfo.entry
      ? artifactFileUrl(
          rs.agentId,
          currentInfo.id,
          currentInfo.entry,
          rs.selectedVersion,
          true,
        )
      : "";
  const downloadLabel = info
    ? `Download original ${info.filename}${rs.selectedVersion ? `, version ${rs.selectedVersion.slice(0, 8)}` : ""}`
    : "Download original";
  const coldList = !!cache?.fetching && !cache.loaded;
  const noticeText = coldList
    ? "Loading artifacts…"
    : cache?.error ||
      (rs.linkedArtifactId && cache?.loaded && !currentInfo
        ? "Artifact not found"
        : holding &&
            rs.followCurrent &&
            rs.selectedVersion !== currentInfo?.version
          ? "Newer content is available. It loads after comments are sent or discarded."
          : rs.notice);
  setPaneLoading(pane, coldList || !!rs.loadingKey);
  renderPowerbarControls(
    pane,
    html`${currentInfo
      ? html`<div class="artifact-header">
          <label class="sr-only" for="artifact-picker">Select artifact</label>
          <select
            id="artifact-picker"
            class="artifact-title-select"
            @change=${onArtifact}
            aria-label="Select artifact"
            ?disabled=${list.length < 2 ||
            rs.sending ||
            rs.restoring ||
            rs.deleting}
          >
            ${list.map(
              (item) =>
                html`<option value=${item.id} .selected=${item.id === rs.selId}>
                  ${item.title}
                </option>`,
            )}
          </select>
          ${info && info.status !== "ready"
            ? html`<span class=${`artifact-flag ${info.status}`} role="status"
                >${info.status === "draft" ? "Draft" : "Error"}</span
              >`
            : nothing}
          <div class="artifact-actions">
            <button
              type="button"
              class="artifact-icon-btn artifact-refresh-btn"
              aria-label="Refresh artifact"
              title="Refresh artifact"
              ?disabled=${!!rs.loadingKey ||
              rs.sending ||
              rs.restoring ||
              rs.deleting}
              @click=${() => {
                if (discardCurrent(pane)) void refreshArtifact(pane);
              }}
            >
              ${unsafeHTML(REFRESH_ICON)}
            </button>
            ${isFullVersion(currentInfo.version)
              ? html`<button
                  type="button"
                  class="artifact-icon-btn artifact-delete-btn"
                  @click=${() => void deleteSelected(pane)}
                  ?disabled=${rs.sending || rs.restoring || rs.deleting}
                  aria-label="Delete artifact"
                  title="Delete artifact"
                >
                  ${TRASH_ICON}
                </button>`
              : nothing}
            ${hasVersions
              ? html`<button
                  type="button"
                  class=${`artifact-icon-btn artifact-version-btn ${offCurrent ? "off-current" : ""}`}
                  @click=${toggleVersionMenu}
                  aria-haspopup="menu"
                  aria-expanded=${rs.versionMenuOpen ? "true" : "false"}
                  aria-label="Version history"
                  title="Version history"
                  ?disabled=${rs.sending || rs.restoring || rs.deleting}
                >
                  ${HISTORY_ICON}${offCurrent
                    ? html`<span class="artifact-version-dot"></span>`
                    : nothing}
                </button>`
              : nothing}
            <a
              class="artifact-icon-btn artifact-download"
              href=${download}
              download
              aria-label=${downloadLabel}
              title="Download original"
              >${DOWNLOAD_ICON}</a
            >
          </div>
          ${rs.versionMenuOpen && hasVersions
            ? html`<div
                class="menu artifact-version-menu"
                role="menu"
                aria-label="Version history"
                @keydown=${onMenuKeydown}
              >
                ${rs.versionsLoading
                  ? html`<div class="menu-note artifact-version-note">
                      Loading history…
                    </div>`
                  : nothing}
                ${rs.versionsError
                  ? html`<div class="menu-note artifact-version-note error">
                      Couldn’t load version history
                    </div>`
                  : nothing}
                ${versions.map(
                  (item) =>
                    html`<button
                      type="button"
                      role="menuitemradio"
                      class="menu-item artifact-version-item"
                      aria-checked=${item.version === rs.selectedVersion
                        ? "true"
                        : "false"}
                      @click=${() =>
                        versionAction(() => applyVersion(item.version))}
                    >
                      ${versionLabel(item, currentInfo.version)}
                    </button>`,
                )}
                ${canRestore
                  ? html`<button
                      type="button"
                      role="menuitem"
                      class="menu-item artifact-version-restore"
                      @click=${() =>
                        versionAction(() => void restoreSelected(pane))}
                      ?disabled=${rs.restoring || rs.deleting}
                      aria-label=${`Restore selected version ${rs.selectedVersion!.slice(0, 8)} of ${info!.title}`}
                    >
                      ${rs.restoring ? "Restoring…" : "Restore this version"}
                    </button>`
                  : nothing}
              </div>`
            : nothing}
        </div>`
      : nothing}`,
    !!currentInfo,
  );
  render(
    html`<h2 id="artifact-heading" class="sr-only">
        ${info ? info.title : "Artifacts"}
      </h2>
      <div
        class=${`artifact-notice ${noticeText ? "on" : ""} ${cache?.error || rs.noticeError ? "error" : ""}`}
        role="status"
        aria-live="polite"
      >
        ${noticeText}
      </div>`,
    pane.querySelector<HTMLElement>(".artifact-shell")!,
  );
}

function retarget(pane: ArtifactEl, agentId: string): boolean {
  const rs = pane._rs;
  if (rs.agentId === agentId) return false;
  cancelSelectionComment();
  rs.agentId = agentId;
  rs.selId = null;
  rs.restoredArtifactId = undefined;
  rs.linkedArtifactId = undefined;
  rs.selectedVersion = null;
  rs.shownKey = null;
  rs.loadingKey = null;
  rs.failedKey = null;
  rs.requestSeq++;
  rs.versionsSeq++;
  rs.versionsId = null;
  rs.versions = [];
  rs.versionsLoading = false;
  rs.versionsError = false;
  rs.sending = false;
  rs.sendFailed = false;
  rs.sendSeq++;
  rs.restoring = false;
  rs.restoreSeq++;
  rs.deleting = false;
  rs.deleteSeq++;
  rs.followCurrent = true;
  rs.headVersion = null;
  rs.justRestored = false;
  rs.notice = "";
  rs.noticeError = false;
  rs.contentInfo = null;
  rs.versionMenuOpen = false;
  rs.imageAbort?.abort();
  rs.imageAbort = null;
  const documentBody = pane.querySelector<HTMLElement>(".report-doc")!;
  documentBody.innerHTML = "";
  setPaneLoading(pane, false);
  return true;
}

registerCommentSource({
  count: pendingTotal,
  discard: () => {
    cancelSelectionComment();
    comments.clear();
    const pane = commentMount.current;
    if (pane) for (const root of commentRoots(pane)) unmarkAll(root);
    if (pane) renderComments(pane);
  },
});

registerPane({
  id: ARTIFACTS_PANE_ID,
  title: "Artifacts",
  icon: ARTIFACTS_ICON,
  available(ctx: PaneContext) {
    if (!ctx.agentId || ctx.agentId === DRAFT) return false;
    const cache = entry(ctx.agentId);
    // Invariant: First view loads the list. Later visits are pure cache hits
    // until a turn, steer, restore, or another explicit mutation invalidates
    // this agent.
    scheduleListRefresh(ctx.agentId);
    return (
      linkedAgent === ctx.agentId ||
      !cache.loaded ||
      !!cache.error ||
      cache.list.length > 0
    );
  },
  autoOpenGeneration(ctx: PaneContext) {
    if (!ctx.agentId || ctx.agentId === DRAFT) return null;
    const cache = entry(ctx.agentId);
    // Invariant: Never default-open a loading or failed list. The normal pane
    // availability still exposes those states when the operator opens Artifacts
    // explicitly.
    if (!cache.loaded || cache.error) return undefined;
    return artifactGeneration(cache.list);
  },
  cache: {
    version: 1,
    key: (ctx) => ctx.agentId,
    resume(element: HTMLElement, ctx: PaneContext) {
      const pane = element as ArtifactEl;
      if (pane._rs.agentId !== ctx.agentId) return;
      const cache = entry(ctx.agentId);
      if (cache.error) cache.invalidated = true;
      if (pane._rs.failedKey) pane._rs.failedKey = null;
      if (pane.querySelector(".artifact-failed-image"))
        pane._rs.shownKey = null;
      if (pane._rs.versionsError) {
        pane._rs.versionsId = null;
        pane._rs.versions = [];
        pane._rs.versionsError = false;
      }
    },
    dispose(element: HTMLElement) {
      const pane = element as ArtifactEl;
      pane._rs.requestSeq++;
      pane._rs.versionsSeq++;
      pane._rs.imageAbort?.abort();
      pane._rs.imageAbort = null;
      if (artifactMount.current === pane) {
        cancelSelectionComment();
        artifactMount.current = null;
      }
      if (commentMount.current === pane) commentMount.current = null;
    },
  },
  viewState: {
    key: "artifacts.selection",
    storageSlot: 0,
    version: 1,
    retention: "local",
    defaultValue: (): ArtifactPaneViewState => ({ artifactId: null }),
    parse: parseArtifactPaneViewState,
    serialize: parseArtifactPaneViewState,
    capture(element: HTMLElement): ArtifactPaneViewState {
      const rs = (element as ArtifactEl)._rs;
      return {
        artifactId:
          rs.restoredArtifactId === undefined
            ? rs.selId
            : rs.restoredArtifactId,
      };
    },
    restore(element: HTMLElement, _ctx: PaneContext, value: unknown): void {
      const pane = element as ArtifactEl;
      pane._rs.restoredArtifactId =
        parseArtifactPaneViewState(value).artifactId;
      renderShell(pane);
      void showArtifact(pane);
    },
  },
  render(element: HTMLElement, ctx: PaneContext) {
    const pane = element as ArtifactEl;
    pane.innerHTML = `<article class="artifact-view" aria-labelledby="artifact-heading"><div class="artifact-shell"></div><div class="report-doc artifact-doc" tabindex="-1"></div></article><div class="report-comments"></div><div class="report-bar"></div>`;
    pane._rs = {
      agentId: null,
      selId: null,
      selectedVersion: null,
      shownKey: null,
      loadingKey: null,
      failedKey: null,
      requestSeq: 0,
      versionsSeq: 0,
      versionsId: null,
      versions: [],
      versionsLoading: false,
      versionsError: false,
      sending: false,
      sendFailed: false,
      sendSeq: 0,
      restoring: false,
      restoreSeq: 0,
      deleting: false,
      deleteSeq: 0,
      followCurrent: true,
      headVersion: null,
      justRestored: false,
      notice: "",
      noticeError: false,
      contentInfo: null,
      versionMenuOpen: false,
      imageAbort: null,
    };
    artifactMount.current = pane;
    claimComments(pane);
    const changedAgent = retarget(pane, ctx.agentId);
    renderShell(pane);
    renderBar(pane);
    // Invariant: A cached success stays request-free across visits. A cached
    // failure gets one retry only on this explicit pane/agent view, never on
    // steady refresh.
    void refreshList(
      ctx.agentId,
      changedAgent && ctx.agentId !== DRAFT && !!entry(ctx.agentId).error,
    );
    // Invariant: The framework immediately applies the pane-declared selection
    // after render. That restore owns the first content request, avoiding a
    // transient request for list[0] when another artifact was remembered.
  },
  refresh(element: HTMLElement, ctx: PaneContext) {
    const pane = element as ArtifactEl;
    artifactMount.current = pane;
    claimComments(pane);
    const changedAgent = retarget(pane, ctx.agentId);
    void refreshList(
      ctx.agentId,
      changedAgent && ctx.agentId !== DRAFT && !!entry(ctx.agentId).error,
    );
    renderShell(pane);
    void showArtifact(pane);
    renderBar(pane);
  },
});
