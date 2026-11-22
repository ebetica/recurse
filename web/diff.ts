// Changes shell uses keyed Lit rows and persistent imperative file bodies.
// Comments hold the reviewed snapshot; repaints preserve editors and focus.
// Lazy patches/contents expose truncation honestly; summary reads are cached.
// Default/HEAD list untracked names; folded lists report their own cap.
import { sendOperatorMessage } from "./conversation/operator-send.js";
import { backendFor } from "./backends/backend.js";
import { html, render, nothing, type TemplateResult } from "lit";
import {
  CHANGES_ICON,
  DISCLOSURE_ICON,
  EXTERNAL_LINK_ICON,
  MORE_ICON,
} from "./icons.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repeat } from "lit/directives/repeat.js";
import { ref } from "lit/directives/ref.js";
import { safeMarkdown } from "./thread-render/reply-html.js";
import {
  fetchPaneData,
  focusPaneControl,
  openPane,
  registerPane,
  syncPanes,
} from "./panes.js";
import { renderPowerbarControls } from "./panes/powerbar.js";

import { state } from "./state.js";
import { confirmDiscard, registerCommentSource } from "./comments.js";
import type { PaneContext } from "./types.js";
import {
  LOCAL,
  acknowledgeComments,
  baseName,
  buildFileRows,
  changesFilter,
  clearPatches,
  collapseAllViews,
  commentMap,
  comments,
  composeMessage,
  createTargetChooser,
  dropViews,
  expandAll,
  fileMark,
  fileViewFor,
  filterChanges,
  layout,
  navigateChanges,
  openAllViews,
  pendingCount,
  prLabel,
  redrawOpenViews,
  refreshFileViews,
  setExpandAll,
  setLayout,
  targetFor,
  viewsOf,
  type ChangedFile,
  type CurrentPr,
  type DiffSummary,
  type DiffTarget,
} from "./diff/index.js";
import {
  PRS_REFRESH_EVENT,
  UI_REFRESH_EVENT,
  requestUiRefresh,
} from "./ui-events.js";

const PANE_ID = "diff";

interface CacheEntry {
  available: boolean;
  summary: DiffSummary | null;
  inflight: boolean;
  invalidated: boolean;
  generation: number;
  error: string | null;
  prs: CurrentPr[];
  selectedPr: CurrentPr | null;
  prExpanded: boolean;
  prOverflow: boolean;
  prInflight: boolean;
  prAgain: boolean;
  prRefresh: boolean;
  prError: string | null;
  // Uncommitted working-directory changes, shown above a pull request's diff.
  local: DiffSummary | null;
  localGeneration: number;
  // The reader picked the target; the newest pull request no longer wins.
  chosen: boolean;
}

interface DiffEl extends HTMLElement {
  _diffHash?: string;
}

if (!document.getElementById("diff-pane-css")) {
  const l = document.createElement("link");
  l.id = "diff-pane-css";
  l.rel = "stylesheet";
  l.href = "/static/diff.css";
  document.head.appendChild(l);
}

// Mutation-invalidated per-agent summaries; ordinary polls reuse cache.
const cache = new Map<string, CacheEntry>();
const heldSummaries = new Map<string, DiffSummary>();
// Base-change redraws are owed even if the content hash is unchanged.
const forceViewRefresh = new Set<string>();
const newerContent =
  "Newer content is available. It loads after comments are sent or discarded.";
function reviewing(id: string): boolean {
  return (
    pendingCount(id) > 0 ||
    viewsOf(id).some((view) => view.body.querySelector(".diff-line-comment"))
  );
}
let shownId: string | null = null;
function entry(id: string): CacheEntry {
  let e = cache.get(id);
  if (!e) {
    e = {
      available: false,
      summary: null,
      inflight: false,
      invalidated: true,
      generation: 0,
      error: null,
      prs: [],
      selectedPr: null,
      prExpanded: false,
      prOverflow: false,
      prInflight: false,
      prAgain: false,
      prRefresh: false,
      prError: null,
      local: null,
      localGeneration: 0,
      chosen: false,
    };
    cache.set(id, e);
  }
  return e;
}

const ownerOf = (key: string) => key.split("\n")[0]!;
const isLocal = (key: string) => key.endsWith(LOCAL);
function fileQuery(key: string): string {
  if (isLocal(key)) return "&base=HEAD";
  const summary = entry(key).summary;
  return summary?.selectedWork && summary.baseSha
    ? "&snapshot=" + summary.baseSha + ".." + summary.selectedWork.headSha
    : prQuery(key, "&");
}

// Fetch one agent independently. Repeated pane syncs are cache reads, not
// timers: only a first visit or explicit invalidation reaches the server.
function maybeFetch(
  id: string,
  invalidate: boolean,
  signal?: AbortSignal,
): Promise<void> | void {
  if (!id || id === "__draft__") return;
  const e = entry(id);
  if (invalidate) e.invalidated = true;
  if (e.inflight || !e.invalidated) return;
  e.invalidated = false;
  loadPullRequests(id);
  if (e.selectedPr) loadLocal(id);
  const generation = ++e.generation;
  e.inflight = true;
  return backendFor(id)
    .api("/api/conversations/" + id + "/diff" + prQuery(id, "?"), {
      signal,
    })
    .then(async (r) => {
      if (e.generation !== generation) return;
      if (!r.ok) {
        e.available = !!e.summary?.available;
        e.error = "Couldn’t refresh changes. Showing the last loaded version.";
        repaintShell();
        return;
      }
      const s = (await r.json()) as DiffSummary;
      if (e.generation !== generation) return;
      if (e.summary && reviewing(id)) {
        heldSummaries.set(id, s);
        e.error =
          forceViewRefresh.has(id) || e.summary.version !== s.version
            ? newerContent
            : null;
        return;
      }
      const forceViews = forceViewRefresh.has(id);
      if (forceViews) forceViewRefresh.delete(id);
      const refreshViews =
        e.summary && (forceViews || e.summary.version !== s.version);
      e.summary = s;
      if (refreshViews) refreshFileViews(id, s, fileQuery(id), forceViews);
      e.available = !!s.available || e.prs.length > 0;
      e.error = s.available
        ? null
        : e.selectedPr
          ? "Couldn’t load this pull request’s diff. Choose another target or refresh."
          : null;
    })
    .catch(() => {
      if (e.generation === generation) {
        // Invariant: An abandoned background probe learned nothing. Leave this
        // agent re-fetchable instead of reporting a failure the reader never
        // hit.
        if (signal?.aborted) {
          e.invalidated = true;
          return;
        }
        // Invariant: A transient poll failure keeps the last good snapshot
        // visible.
        e.available = !!e.summary?.available;
        e.error = "Couldn’t refresh changes. Showing the last loaded version.";
        repaintShell();
      }
    })
    .finally(() => {
      if (e.generation === generation) {
        e.inflight = false;
        // Invariant: Coalesce any mutation that arrived during this request
        // into one follow-up snapshot; never overlap repository walks.
        if (e.invalidated && !signal?.aborted) maybeFetch(id, false, signal);
        repaintShell();
      }
    });
}

// The uncommitted changes shown above the selected pull request; a newer
// target or read drops an older answer.
function loadLocal(id: string): void {
  const e = entry(id);
  const generation = ++e.localGeneration;
  void backendFor(id)
    .api("/api/conversations/" + id + "/diff?base=HEAD&untracked=0")
    .then(async (r) => (r.ok ? ((await r.json()) as DiffSummary) : null))
    .catch(() => null)
    .then((s) => {
      if (!s || generation !== e.localGeneration || !e.selectedPr) return;
      heldSummaries.set(id + LOCAL, s);
      repaintShell();
    });
}

// Reads open panes immediately and closed panes through background priority.
// Record invalidation before queueing so dropped probes cannot lose it.
function scheduleFetch(id: string, invalidate: boolean): void {
  if (!id || id === "__draft__") return;
  if (invalidate) entry(id).invalidated = true;
  fetchPaneData(PANE_ID, id, (signal) => maybeFetch(id, false, signal));
}

let lastAvailableId: string | null = null;
function available(ctx: PaneContext): boolean | undefined {
  const id = ctx.agentId;
  // Invariant: Selecting an agent buys one fresh snapshot, even when this
  // browser viewed it before. Repeated syncs for the same agent stay
  // cache-only.
  const selected = id !== lastAvailableId;
  lastAvailableId = id;
  scheduleFetch(id, selected);
  const e = cache.get(id);
  return e?.available || (e?.invalidated || e?.inflight ? undefined : false);
}

window.addEventListener(UI_REFRESH_EVENT, (event: Event) => {
  const id = (event as CustomEvent<{ agentId?: unknown }>).detail?.agentId;
  if (typeof id !== "string" || !id) return;
  const e = cache.get(id);
  if (e) e.invalidated = true;
  if (state.selectedId === id) scheduleFetch(id, true);
});

function prQuery(id: string, separator: string): string {
  const pr = entry(id).selectedPr;
  return pr ? separator + "pr=" + encodeURIComponent(pr.url) : "";
}

// One read at a time; a change pushed during a read reads again. Opening the
// pane also asks the server for a background branch PR lookup.
function loadPullRequests(id: string, refresh = false): void {
  const e = entry(id);
  e.prRefresh ||= refresh;
  if (e.prInflight) return void (e.prAgain = true);
  e.prInflight = true;
  e.prAgain = false;
  const query = e.prRefresh ? "?refresh=1" : "";
  e.prRefresh = false;
  void backendFor(id)
    .apiJson<{ prs: CurrentPr[] }>(
      "/api/conversations/" + id + "/prs" + query,
      {},
      { timeoutMs: 5000 },
    )
    .then(({ response, data }) => {
      if (!response.ok) throw new Error("load failed");
      e.prs = data.prs;
      if (e.selectedPr)
        e.selectedPr =
          e.prs.find((pr) => pr.url === e.selectedPr!.url) || e.selectedPr;
      followNewestPr(id);
      e.prError = null;
      e.available = !!e.summary?.available || e.prs.length > 0;
      targetChooser.prsChanged(id);
      repaintShell();
      syncPanes();
    })
    .catch(() => {
      e.prError = "Couldn’t load pull requests. Close and reopen to retry.";
      targetChooser.showError(id, e.prError);
      repaintShell();
    })
    .finally(() => {
      e.prInflight = false;
      if (e.prAgain || e.prRefresh) loadPullRequests(id);
    });
}

window.addEventListener(PRS_REFRESH_EVENT, (event: Event) => {
  const id = (event as CustomEvent<{ agentId?: unknown }>).detail?.agentId;
  if (typeof id === "string" && state.selectedId === id && cache.has(id))
    loadPullRequests(id);
});

export function openPullRequestFinder(): void {
  const id = state.selectedId;
  if (!id || !openPane(PANE_ID, { userInitiated: true, focusHeading: false }))
    return;
  targetChooser.open(id, { clear: true });
}

// Until the reader picks a target, Changes shows the newest pull request
// linked in the conversation's subtree, switching only between reviews and
// never while a base is being applied.
function followNewestPr(id: string): void {
  const e = entry(id);
  const newest = e.prs.reduce<CurrentPr | null>(
    (a, pr) => (!a || (pr.detected_at ?? 0) > (a.detected_at ?? 0) ? pr : a),
    null,
  );
  if (
    !e.chosen &&
    newest?.url !== e.selectedPr?.url &&
    !reviewing(id) &&
    !targetChooser.busy(id)
  )
    switchDiffTarget(id, newest, true, true);
}

function switchDiffTarget(
  id: string,
  pr: CurrentPr | null,
  confirmed = false,
  automatic = false,
): void {
  const e = entry(id);
  const n = pendingCount(id);
  if (!confirmed && n && !confirmDiscard(n)) return;
  if (!automatic) e.chosen = true;
  comments.delete(id);
  dropViews(id);
  heldSummaries.delete(id);
  heldSummaries.delete(id + LOCAL);
  e.local = null;
  e.localGeneration++;
  e.selectedPr = pr;
  e.prExpanded = false;
  e.prOverflow = false;
  e.summary = null;
  e.error = null;
  e.generation++;
  e.inflight = false;
  e.invalidated = true;
  if (!automatic) targetChooser.close(id);
  void maybeFetch(id, false);
}

function applyTargetBase(agentId: string): void {
  entry(agentId).chosen = true;
  // Invariant: Pending line comments live outside the git cache, so dropping
  // the cached patches and forcing open views to redraw is comment-safe.
  clearPatches(agentId);
  forceViewRefresh.add(agentId);
  if (entry(agentId).selectedPr) switchDiffTarget(agentId, null, true);
  else void maybeFetch(agentId, true);
}

const targetChooser = createTargetChooser({
  summary: (id) => cache.get(id)?.summary ?? null,
  prs: (id) => entry(id).prs,
  selectedPr: (id) => entry(id).selectedPr,
  choose: switchDiffTarget,
  applied: applyTargetBase,
  settled: followNewestPr,
  loadPrs: loadPullRequests,
  focus: (input) => focusPaneControl(PANE_ID, input),
});

// Diffs with at most this many changed files open every file on first paint.
const OPEN_ALL_FILES_MAX = 20;

// One current pane target owns repaints from editor and submit interactions.
let paneEl: DiffEl | null = null;
let submitting = false;
let submitFailed = false;

// Repaints keyed shell rows; referenced file bodies preserve their DOM. They
// also follow a newer pull request once a review or editor closes.
function repaintShell(): void {
  if (!paneEl || !shownId) return;
  followNewestPr(shownId);
  renderShell(paneEl, shownId);
}

function prSummaryTemplate(agentId: string): TemplateResult | typeof nothing {
  const e = entry(agentId);
  const pr = e.selectedPr;
  if (!pr) return nothing;
  const body = e.summary?.body;
  const bodyId = "diff-pr-description-" + agentId;
  const meta = `\n      ${prLabel(pr, { showStatus: true })}\n    `;
  let observer: ResizeObserver | null = null;
  return html`<section class="diff-pr-summary" aria-label="Pull request">
    <h3 class="diff-pr-title">
      <a
        class="diff-pr"
        href=${pr.url.startsWith("https://") ? pr.url : nothing}
        target="_blank"
        rel="noopener"
        >${pr.title || "Pull request #" + pr.number}${unsafeHTML(
          EXTERNAL_LINK_ICON,
        )}</a
      >
    </h3>
    <p class="diff-pr-meta">${meta}</p>
    ${body?.trim()
      ? html`<div
            id=${bodyId}
            class="content diff-pr-body ${e.prExpanded
              ? ""
              : "clamped"} ${e.prOverflow ? "overflowing" : ""}"
            ${ref((element) => {
              observer?.disconnect();
              if (!element) return;
              observer = new ResizeObserver(() => {
                if (e.prExpanded || !element.isConnected) return;
                const overflow = element.scrollHeight > element.clientHeight;
                if (e.prOverflow !== overflow) {
                  e.prOverflow = overflow;
                  repaintShell();
                }
              });
              observer.observe(element, { box: "content-box" });
            })}
          >
            ${unsafeHTML(safeMarkdown(body))}
          </div>
          ${e.prOverflow || e.prExpanded
            ? html`<button
                class="btn quiet diff-pr-more"
                aria-expanded=${e.prExpanded}
                aria-controls=${bodyId}
                @click=${() => {
                  e.prExpanded = !e.prExpanded;
                  repaintShell();
                }}
              >
                ${unsafeHTML(DISCLOSURE_ICON)}${e.prExpanded
                  ? "Show less"
                  : "Show more"}
              </button>`
            : nothing}`
      : nothing}
  </section>`;
}

function headTemplate(agentId: string, s: DiffSummary): TemplateResult {
  const pr = entry(agentId).selectedPr ? null : s.currentPr;
  const prUrl = pr && pr.url.startsWith("https://") ? pr.url : null;
  return html`<div class="diff-head">
    ${s.cwd
      ? html`<span class="diff-cwd" title=${s.cwd}>${s.cwd}</span>`
      : nothing}
    ${pr && prUrl
      ? html`<a
          class="menu-item diff-pr"
          href=${prUrl}
          target="_blank"
          rel="noopener"
          title=${pr.title}
          >${unsafeHTML(EXTERNAL_LINK_ICON)}<span
            >Pull request #${pr.number}</span
          ></a
        >`
      : nothing}
  </div>`;
}

function viewToggleTemplate(agentId: string): TemplateResult {
  const set = (mode: "unified" | "split") => {
    if (layout() === mode) return;
    setLayout(mode);
    redrawOpenViews(agentId);
    repaintShell();
  };
  return html`<div class="diff-toggle" role="group" aria-label="Diff layout">
    <button
      class="diff-toggle-btn ${layout() === "unified" ? "on" : ""}"
      aria-pressed=${layout() === "unified"}
      @click=${() => set("unified")}
    >
      Unified
    </button>
    <button
      class="diff-toggle-btn ${layout() === "split" ? "on" : ""}"
      aria-pressed=${layout() === "split"}
      @click=${() => set("split")}
    >
      Split
    </button>
  </div>`;
}

// Pane toolbar: the layout toggle plus the pane-wide Expand all /
// Collapse all. Expand all opens every file and shows every hunk's full
// context (fetching contents per file as patches arrive); Collapse all
// restores every open file to its patch hunks, leaving bodies open.
function toolbarTemplate(agentId: string): TemplateResult {
  const toggleAll = () => {
    if (expandAll()) {
      setExpandAll(false);
      repaintShell();
      collapseAllViews(agentId);
    } else {
      setExpandAll(true);
      openAllViews(agentId);
      repaintShell();
    }
  };
  return html`<div class="diff-toolbar">
    ${viewToggleTemplate(agentId)}
    <button
      ?disabled=${!!entry(agentId).selectedPr}
      class="diff-expand-all"
      aria-pressed=${expandAll()}
      title=${expandAll()
        ? "Show only the patch hunks in every file"
        : "Open every file and show every hidden line"}
      @click=${toggleAll}
    >
      ${expandAll() ? "Collapse all" : "Expand all"}
    </button>
  </div>`;
}

function fileRowTemplate(
  agentId: string,
  file: ChangedFile,
  target: DiffTarget,
  version: string | null,
  openByDefault: boolean,
): TemplateResult {
  const v = fileViewFor(agentId, file, {
    owner: ownerOf(agentId),
    query: fileQuery(agentId),
    target,
    version,
    openByDefault,
    onChange: repaintShell,
  });
  const m = fileMark(agentId, file, version);
  const toggle = () => {
    v.setOpen(!v.open);
    repaintShell();
  };
  const counts =
    file.additions != null || file.deletions != null
      ? html`<span class="diff-counts"
          ><span class="add">+${file.additions ?? 0}</span>
          <span class="del">−${file.deletions ?? 0}</span></span
        >`
      : nothing;
  return html`<div class="diff-file">
    <div class="diff-file-head">
      <button
        class="diff-file-toggle ${v.open ? "open" : ""}"
        @click=${toggle}
        aria-expanded=${v.open}
      >
        <span class="diff-mark ${m.cls}" aria-hidden="true">${m.mark}</span>
        <span class="diff-path">${file.path}</span>
        ${counts}
      </button>
    </div>
    ${v.body}
  </div>`;
}

// Submits all staged notes; clear/submit drop notes and file views together.
// The action bar stays in flow and hides only while no notes are pending.
function submitBarTemplate(agentId: string): TemplateResult {
  const n = pendingCount(agentId);
  const disabled = n === 0 || submitting;
  const label = n === 1 ? "1 comment" : n + " comments";
  const sendText = submitting
    ? "Submitting…"
    : submitFailed
      ? "Failed — retry"
      : "Submit comment";

  const clear = () => {
    if (n > 0 && !confirmDiscard(n)) return;
    comments.delete(agentId);
    dropViews(agentId);
    submitFailed = false;
    repaintShell();
  };
  const send = async () => {
    const msg = composeMessage(agentId);
    if (!msg) return;
    const submitted = new Map(
      [...commentMap(agentId)].map(([key, c]) => [key, c.text]),
    );
    submitting = true;
    submitFailed = false;
    repaintShell();
    let ok = false;
    try {
      const r = await sendOperatorMessage(agentId, { content: msg });
      ok = r.ok;
      if (ok) {
        const result = (await r.json()) as { steer?: unknown };
        if (result.steer === true) requestUiRefresh(agentId);
      }
    } catch {
      ok = false;
    }
    submitting = false;
    if (ok) {
      // Invariant: Remove only the exact comments submitted. Notes edited or
      // added while the request was in flight stay pending instead of being
      // lost.
      const live = comments.get(agentId);
      if (live) acknowledgeComments(live, submitted);
      if (!live?.size) {
        comments.delete(agentId);
        dropViews(agentId);
      }
      submitFailed = false;
    } else submitFailed = true;
    repaintShell();
  };

  return html`<div class="diff-sendbar ${n > 0 ? "on" : ""}">
    <span class="diff-sendbar-label">${label}</span>
    <span class="diff-sendbar-spacer"></span>
    <button
      class="btn quiet diff-sendbar-clear"
      ?disabled=${disabled}
      @click=${clear}
    >
      Clear
    </button>
    <button
      class="btn primary diff-sendbar-send"
      ?disabled=${disabled}
      @click=${send}
    >
      ${sendText}
    </button>
  </div>`;
}

// One summary's changed files (patches load lazily) and untracked names.
function fileGroupsTemplate(
  agentId: string,
  s: DiffSummary,
  label: string,
): TemplateResult {
  const { changed, untracked } = buildFileRows(
    s.files || [],
    s.untracked || [],
  );
  const version = s.version || null;
  const target = targetFor(s);
  const more = s.moreFiles || 0;
  const openByDefault = !more && changed.length <= OPEN_ALL_FILES_MAX;
  return html`${changed.length
    ? html`<div class="diff-group">
        <div class="diff-group-head">
          <span class="diff-group-label">${label}</span>
          <span class="badge diff-group-count"
            >${more ? `${changed.length}+` : changed.length}</span
          >
        </div>
        ${repeat(
          changed,
          (f) => f.path,
          (f) => fileRowTemplate(agentId, f, target, version, openByDefault),
        )}
        ${more
          ? html`<div class="diff-more" aria-live="polite">
              …and ${more} more file${more === 1 ? "" : "s"} (list capped).
            </div>`
          : nothing}
      </div>`
    : nothing}
  ${!isLocal(agentId) &&
  target.kind === "worktree" &&
  !s.selectedWork &&
  untracked.length
    ? html`<details
        class="diff-group diff-untracked"
        ?open=${untracked.length <= 20}
      >
        <summary class="diff-group-head">
          ${unsafeHTML(DISCLOSURE_ICON)}
          <span class="diff-group-label">Untracked</span>
          <span class="badge diff-group-count">${untracked.length}</span>
        </summary>
        ${repeat(
          untracked,
          (p) => p,
          (p) =>
            html`<div class="diff-file">
              <div class="diff-file-head">
                <span class="diff-mark add" aria-hidden="true">+</span>
                <span class="diff-path">${p}</span>
                <span class="diff-untracked-note"
                  >untracked — content not shown</span
                >
              </div>
            </div>`,
        )}
      </details>`
    : nothing}`;
}

// The whole shell for one agent's summary: the head, the view toggle, the
// stat, the changed files from the summary's file list, the untracked names,
// and the submit bar. Per-file patches load lazily on expand.
function shellTemplate(
  agentId: string,
  s: DiffSummary,
  error: string | null,
): TemplateResult {
  const { changed, untracked } = buildFileRows(
    s.files || [],
    s.untracked || [],
  );
  const e = entry(agentId);
  const local = e.selectedPr && e.local?.available ? e.local : null;
  // Spec: Totals sum listed files, not localized --stat; complete diffs only.
  const files = s.stat && !s.truncated ? changed.length : 0;
  const total = (key: "additions" | "deletions") =>
    changed.reduce((sum, file) => sum + (file[key] ?? 0), 0);
  return html` <div class="diff-list" tabindex="-1">
      ${changesFilter()} ${prSummaryTemplate(agentId)}
      ${error
        ? html`<div
            class=${error === newerContent ? "diff-expand-note" : "diff-error"}
            role="status"
            aria-live="polite"
          >
            ${error}
          </div>`
        : nothing}
      ${files
        ? html`<p class="diff-stat">
            ${files} file${files === 1 ? "" : "s"} changed
            <span class="diff-counts"
              ><span class="add">+${total("additions")}</span>
              <span class="del">−${total("deletions")}</span></span
            >
          </p>`
        : nothing}
      ${s.truncated
        ? html`<div class="diff-trunc" role="status">
            The diff hit the server’s size cap — some content below is partial.
          </div>`
        : nothing}
      ${s.untrackedTruncated
        ? html`<div class="diff-trunc" role="status">
            The untracked file list is capped — showing
            ${s.untracked?.length || 0} names.
          </div>`
        : nothing}
      ${local
        ? fileGroupsTemplate(agentId + LOCAL, local, "Uncommitted changes")
        : nothing}
      ${fileGroupsTemplate(
        agentId,
        s,
        e.selectedPr ? "Pull request files" : "Changed files",
      )}
      ${!s.available && !error && s.reason !== "clean"
        ? html`<div class="diff-empty" role="status">
            Working directory diff unavailable. Choose a pull request above.
          </div>`
        : nothing}
      ${s.reason === "clean" ||
      (s.available && !changed.length && !untracked.length)
        ? html`<div class="diff-empty" aria-live="polite">
            ${e.selectedPr || !s.base
              ? "No changes to show."
              : s.selectedWork
                ? "No changes in " + baseName(s.selectedWork.ref) + "."
                : s.base === "HEAD"
                  ? "No uncommitted changes."
                  : "No changes since " + baseName(s.base) + "."}
          </div>`
        : nothing}
    </div>
    ${submitBarTemplate(agentId)}`;
}

function focusDiffList(body: HTMLElement): void {
  body.querySelector<HTMLElement>(".diff-list")?.focus({ preventScroll: true });
}

// Render the shell for `agentId` into the pane. With no summary yet, show the
// loading placeholder — the poll fills it in a beat later.
function renderShell(el0: DiffEl, agentId: string): void {
  const e = cache.get(agentId);
  const local = heldSummaries.get(agentId + LOCAL);
  // Invariant: New uncommitted changes wait, like the target's summary, until
  // no comment is being written.
  if (e && local && (!e.local || !reviewing(agentId))) {
    heldSummaries.delete(agentId + LOCAL);
    if (e.local?.version !== local.version)
      refreshFileViews(agentId + LOCAL, local, fileQuery(agentId + LOCAL));
    e.local = local;
  }
  const held = heldSummaries.get(agentId);
  if (e && held && !reviewing(agentId)) {
    heldSummaries.delete(agentId);
    e.summary = held;
    e.error = null;
    refreshFileViews(
      agentId,
      held,
      fileQuery(agentId),
      forceViewRefresh.delete(agentId),
    );
  }
  const s = e && e.summary;
  if (!s) {
    renderPowerbarControls(el0, targetChooser.root(agentId));
    render(
      html`<div class="diff-empty" aria-live="polite">
        ${e?.error || "Loading changes…"}
      </div>`,
      el0,
    );
    return;
  }
  renderPowerbarControls(
    el0,
    html`${targetChooser.root(agentId)}
      <details class="pane-powerbar-overflow">
        <summary aria-label="Changes options" title="Changes options">
          ${unsafeHTML(MORE_ICON)}
        </summary>
        <div class="menu form pane-powerbar-menu">
          ${headTemplate(agentId, s)} ${toolbarTemplate(agentId)}
        </div>
      </details>`,
  );
  render(shellTemplate(agentId, s, e.error), el0);
  filterChanges(el0);
  if (document.activeElement === el0) focusDiffList(el0);
  targetChooser.sync(agentId, s);
}

// Summary-key guards preserve expanded diffs and active comment editors. Direct
// expansion/comment interactions bypass the guard and repaint immediately.
function update(el0: DiffEl, ctx: { agentId: string }): void {
  const id = ctx.agentId;
  paneEl = el0;
  if (shownId !== id) {
    shownId = id;
    submitting = false;
    submitFailed = false;
  }
  void maybeFetch(id, false);
  const e = cache.get(id);
  const s = e && e.summary;
  const hash = id + "|" + (s ? s.version + "|" + (e?.error || "") : "…");
  if (el0._diffHash === hash && !(heldSummaries.has(id) && !reviewing(id)))
    return;
  el0._diffHash = hash;
  renderShell(el0, id);
}

registerCommentSource({
  count: () => pendingCount(state.selectedId),
  discard: () => {
    const id = state.selectedId;
    comments.delete(id);
    dropViews(id);
  },
});

// Opening Changes asks the server to look up the listed pull requests again,
// including the selected one's owner, which may be past the first few.
function paneOpened(id: string): void {
  loadPullRequests(id, true);
  const owner = cache.get(id)?.selectedPr?.agent?.id;
  if (owner)
    void backendFor(id)
      .api("/api/conversations/" + owner + "/prs?refresh=1")
      .catch(() => null);
}

registerPane({
  id: PANE_ID,
  title: "Changes",
  icon: CHANGES_ICON,
  finder: {
    kind: "changes",
    items() {
      const id = state.selectedId;
      return (cache.get(id)?.prs ?? []).map((pr) => ({
        key: pr.url,
        name: prLabel(pr, { titleSuffix: " " + pr.title }),
        open() {
          if (entry(id).selectedPr?.url !== pr.url) switchDiffTarget(id, pr);
          openPane(PANE_ID, { userInitiated: true });
        },
      }));
    },
  },
  available,
  navigate: navigateChanges,
  cache: {
    version: 1,
    key: (ctx) => ctx.agentId,
    dispose: (element) => {
      if (paneEl === element) paneEl = null;
    },
  },
  render(el0: HTMLElement, ctx: PaneContext) {
    // Invariant: The pane shell remains the keyboard entry point; arrows belong
    // to the list.
    el0.onfocus = () => focusDiffList(el0);
    paneOpened(ctx.agentId);
    void maybeFetch(ctx.agentId, false);
    update(el0 as DiffEl, ctx);
  },
  refresh(el0: HTMLElement, ctx: PaneContext) {
    // Invariant: Reopening a cached pane body asks for a PR lookup like a
    // fresh render and rereads the diff.
    if (el0.dataset.diffLeft) {
      delete el0.dataset.diffLeft;
      paneOpened(ctx.agentId);
      void maybeFetch(ctx.agentId, true);
    }
    update(el0 as DiffEl, ctx);
  },
  leave(el0: HTMLElement) {
    el0.dataset.diffLeft = "1";
  },
});
