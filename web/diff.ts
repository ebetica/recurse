// Changes shell uses keyed Lit rows and persistent imperative file bodies.
// Comments hold the reviewed snapshot; repaints preserve editors and focus.
// Lazy patches/contents expose truncation honestly; mutation-driven summary
// reads cache during ordinary UI polls. diff/comments.ts owns staged notes.
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
import { safeMarkdown } from "./thread-render.js";
import { fetchPaneData, openPane, registerPane, syncPanes } from "./panes.js";
import { renderPowerbarControls } from "./panes/powerbar.js";

import { state } from "./state.js";
import { confirmDiscard, registerCommentSource } from "./comments.js";
import { el } from "./dom.js";
import type { PaneContext } from "./types.js";
import {
  acknowledgeComments,
  baseErrorText,
  buildFileRows,
  diffContextMarker,
  filterBaseCandidates,
  flattenBaseCandidates,
  groupPrCandidates,
  isCurrentGeneration,
  moveFinderIndex,
  shortCwd,
  type BaseCandidate,
  type BaseCandidateLists,
  type ChangedFile,
  type DiffTarget,
} from "./diff/model.js";
import {
  commentable,
  comments,
  commentMap,
  composeMessage,
  createLineSelection,
  pendingCount,
  type LineSelection,
} from "./diff/comments.js";
import type {
  ExpandDir,
  HunkExpand,
  SplitRow,
  ViewLine,
} from "./diff/render.js";
import type { DiffFile as DiffFileType } from "@git-diff-view/core";
import { gapBar } from "./diff/expand.js";

type Core = typeof import("@git-diff-view/core");
let coreMod: Promise<Core> | null = null;
function loadCore(): Promise<Core> {
  coreMod ??= import("@git-diff-view/core");
  return coreMod;
}
import { UI_REFRESH_EVENT, requestUiRefresh } from "./ui-events.js";

const PANE_ID = "diff";

type RenderMod = typeof import("./diff/render.js");
let renderMod: Promise<RenderMod> | null = null;
function loadRenderer(): Promise<RenderMod> {
  renderMod ??= import("./diff/render.js");
  return renderMod;
}

interface CurrentPr {
  baseRefName?: string;
  state?: string | null;
  metadata?: string;
  number: number;
  title: string;
  body?: string | null;
  url: string;
}
interface DiffSummary {
  available?: boolean;
  reason?: string | null;
  base?: string | null;
  baseSha?: string | null;
  baseSource?: string | null;
  headSha?: string | null;
  branch?: string | null;
  cwd?: string | null;
  cwdSource?: string | null;
  stat?: string | null;
  truncated?: boolean;
  files?: ChangedFile[];
  moreFiles?: number;
  untracked?: string[];
  currentPr?: CurrentPr | null;
  version?: string | null;
  target?: DiffTarget;
}

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
  prTimer: ReturnType<typeof setTimeout> | null;
  prError: string | null;
}

interface DiffCtx {
  agentId: string;
  group: string;
  path: string;
  target: DiffTarget;
  onChange: () => void;
  selection: LineSelection;
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
const newerContent =
  "Newer content is available. It loads after comments are sent or discarded.";
function reviewing(id: string): boolean {
  return (
    pendingCount(id) > 0 ||
    [...(fileViews.get(id)?.values() || [])].some((view) =>
      view.body.querySelector(".diff-line-comment"),
    )
  );
}
let shownId: string | null = null;
// Unified by default; the toggle re-renders whatever is open.
let viewMode: "unified" | "split" = "unified";
// Pane-wide expansion applies to open/new files when full contents arrive.
let expandAllOn = false;

interface PatchState {
  version: string | null;
  status: "loading" | "ready" | "error";
  patch: string;
  truncated: boolean;
  binary: boolean;
  contentsStatus: "unknown" | "loading" | "ready" | "unavailable";
  oldContent: string | null;
  newContent: string | null;
  contentsTruncated: boolean;
}

// Per-agent lazy patches: id -> Map(path -> PatchState).
const patches = new Map<string, Map<string, PatchState>>();

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
      prTimer: null,
      prError: null,
    };
    cache.set(id, e);
  }
  return e;
}

function targetFor(summary: DiffSummary): DiffTarget {
  return (
    summary.target ?? {
      kind: "worktree",
      id: "worktree",
      branch: summary.branch || null,
      baseBranch: summary.base || null,
      baseSha: summary.baseSha || null,
      headSha: summary.headSha || null,
      includesUncommitted: true,
    }
  );
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
  const generation = ++e.generation;
  e.inflight = true;
  return backendFor(id)
    .api("/api/conversations/" + id + "/diff" + prQuery(id, "?"), {
      signal,
    })
    .then(async (r) => {
      if (!isCurrentGeneration(e.generation, generation)) return;
      if (!r.ok) {
        e.available = !!e.summary?.available;
        e.error = "Couldn’t refresh changes. Showing the last loaded version.";
        repaintShell();
        return;
      }
      const s = (await r.json()) as DiffSummary;
      if (!isCurrentGeneration(e.generation, generation)) return;
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
      if (e.summary && (forceViews || e.summary.version !== s.version))
        refreshFileViews(id, s, forceViews);
      e.summary = s;
      e.available = !!s.available || e.prs.length > 0;
      e.error = s.available
        ? null
        : e.selectedPr
          ? "Couldn’t load this pull request’s diff. Choose another target or refresh."
          : null;
    })
    .catch(() => {
      if (isCurrentGeneration(e.generation, generation)) {
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
      if (isCurrentGeneration(e.generation, generation)) {
        e.inflight = false;
        // Invariant: Coalesce any mutation that arrived during this request
        // into one follow-up snapshot; never overlap repository walks.
        if (e.invalidated && !signal?.aborted) maybeFetch(id, false, signal);
        repaintShell();
      }
    });
}

// One file's patch, fetched lazily on expand and cached for the summary
// version in force. Unknown or failing paths stay an inline error with a
// retry — never a pane-wide failure.
function loadPatch(
  agentId: string,
  path: string,
  version: string | null,
): void {
  let m = patches.get(agentId);
  if (!m) {
    m = new Map();
    patches.set(agentId, m);
  }
  const cur = m.get(path);
  if (cur && cur.version === version && cur.status !== "error") return;
  const st: PatchState = {
    version,
    status: "loading",
    patch: "",
    truncated: false,
    binary: false,
    contentsStatus: "unknown",
    oldContent: null,
    newContent: null,
    contentsTruncated: false,
  };
  m.set(path, st);
  const url =
    "/api/conversations/" +
    agentId +
    "/diff/files?path=" +
    encodeURIComponent(path) +
    prQuery(agentId, "&");
  void backendFor(agentId)
    .api(url)
    .then(async (r) => {
      if (!r.ok) {
        st.status = "error";
        repaintView(agentId, path);
        return;
      }
      const data = (await r.json()) as {
        available?: boolean;
        patch?: string;
        truncated?: boolean;
      };
      if (!data.available || typeof data.patch !== "string") {
        st.status = "error";
      } else {
        st.status = "ready";
        st.patch = data.patch;
        st.truncated = !!data.truncated;
        st.binary = /^(Binary files |GIT binary patch)/m.test(data.patch);
      }
      repaintView(agentId, path);
    })
    .catch(() => {
      st.status = "error";
      repaintView(agentId, path);
    });
}

function patchFor(
  agentId: string,
  path: string,
  version: string | null,
): PatchState | undefined {
  const st = patches.get(agentId)?.get(path);
  return st && st.version === version ? st : undefined;
}

interface ContentsPayload {
  available?: boolean;
  patch?: string;
  oldContent?: unknown;
  newContent?: unknown;
  contentsTruncated?: boolean;
}

// Fetch the file's full old/new contents for context expansion, once per
// summary version, when the file opens. Ready contents repaint the file;
// unavailable contents add a note without disturbing selection or row geometry.
// Stale responses (a newer summary version landed meanwhile) are dropped.
function loadContents(
  agentId: string,
  path: string,
  version: string | null,
): void {
  const st = patchFor(agentId, path, version);
  if (!st || st.status !== "ready") return;
  if (entry(agentId).selectedPr) {
    st.contentsStatus = "unavailable";
    return;
  }
  if (st.contentsStatus !== "unknown") return;
  st.contentsStatus = "loading";
  const url =
    "/api/conversations/" +
    agentId +
    "/diff/files?path=" +
    encodeURIComponent(path) +
    "&contents=1";
  const done = () => {
    if (st.contentsStatus === "unavailable") {
      fileViews.get(agentId)?.get(path)?.showContentsUnavailable();
    } else repaintView(agentId, path);
  };
  void backendFor(agentId)
    .api(url)
    .then(async (r) => {
      const cur = patchFor(agentId, path, version);
      if (!cur) return;
      if (r.ok) {
        let data: ContentsPayload | null = null;
        try {
          data = (await r.json()) as ContentsPayload;
        } catch {
          data = null;
        }
        if (
          data?.available === true &&
          typeof data.oldContent === "string" &&
          typeof data.newContent === "string"
        ) {
          cur.oldContent = data.oldContent;
          cur.newContent = data.newContent;
          cur.contentsStatus = "ready";
          done();
          return;
        }
        if (data?.available === true)
          cur.contentsTruncated = data.contentsTruncated === true;
      }
      cur.contentsStatus = "unavailable";
      done();
    })
    .catch(() => {
      const cur = patchFor(agentId, path, version);
      if (cur) cur.contentsStatus = "unavailable";
      done();
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
function available(ctx: PaneContext): boolean {
  const id = ctx.agentId;
  // Invariant: Selecting an agent buys one fresh snapshot, even when this
  // browser viewed it before. Repeated syncs for the same agent stay
  // cache-only.
  const selected = id !== lastAvailableId;
  lastAvailableId = id;
  scheduleFetch(id, selected);
  const e = cache.get(id);
  return e ? e.available : false;
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

// Pending metadata rereads are single-owner, with at most 60 bounded retries.
function loadPullRequests(id: string, remaining = 60): void {
  const e = entry(id);
  if (e.prInflight) return;
  e.prInflight = true;
  if (e.prTimer !== null) clearTimeout(e.prTimer);
  e.prTimer = null;
  const target = e.selectedPr?.url;
  void backendFor(id)
    .apiJson<{ prs: CurrentPr[]; refreshing?: boolean }>(
      "/api/conversations/" + id + "/prs",
      {},
      { timeoutMs: 5000 },
    )
    .then(({ response, data }) => {
      if (!response.ok) throw new Error("load failed");
      e.prs = data.prs;
      if (e.selectedPr)
        e.selectedPr =
          e.prs.find((pr) => pr.url === e.selectedPr!.url) || e.selectedPr;
      e.prError = null;
      if (
        (data.refreshing || e.prs.some((pr) => pr.metadata === "pending")) &&
        state.selectedId === id &&
        paneEl?.isConnected
      ) {
        if (remaining)
          e.prTimer = setTimeout(() => {
            e.prTimer = null;
            if (
              state.selectedId === id &&
              paneEl?.isConnected &&
              e.selectedPr?.url === target
            )
              loadPullRequests(id, remaining - 1);
          }, 1000);
        else
          e.prError =
            "Pull request details are still pending. Reopen the picker to retry.";
      }
      e.available = !!e.summary?.available || e.prs.length > 0;
      refilterFinder(id);
      repaintShell();
      syncPanes();
    })
    .catch(() => {
      e.prError = "Couldn’t load pull requests. Close and reopen to retry.";
      const ed = baseEditors.get(id);
      if (ed?.open) showBaseError(ed, e.prError);
      repaintShell();
    })
    .finally(() => {
      e.prInflight = false;
      if (
        state.selectedId === id &&
        paneEl?.isConnected &&
        e.selectedPr?.url !== target
      )
        loadPullRequests(id);
    });
}

export function openPullRequestFinder(): void {
  const id = state.selectedId;
  if (!id || !openPane(PANE_ID, { userInitiated: true, focusHeading: false }))
    return;
  openBaseEditor(id);
  const ed = baseEditorFor(id);
  ed.input.value = "";
  ed.dirty = true;
  refilterFinder(id);
  ed.input.focus();
}

function switchDiffTarget(
  id: string,
  pr: CurrentPr | null,
  confirmed = false,
): void {
  const e = entry(id);
  const n = pendingCount(id);
  if (!confirmed && n && !confirmDiscard(n)) return;
  comments.delete(id);
  fileViews.delete(id);
  patches.delete(id);
  heldSummaries.delete(id);
  e.selectedPr = pr;
  e.prExpanded = false;
  e.prOverflow = false;
  if (e.prTimer !== null) clearTimeout(e.prTimer);
  e.prTimer = null;
  e.summary = null;
  e.error = null;
  e.generation++;
  e.inflight = false;
  e.invalidated = true;
  closeBaseEditor(id);
  void maybeFetch(id, false);
}

function chooseCandidate(id: string, candidate: BaseCandidate): void {
  if (candidate.kind === "pr" || candidate.kind === "worktree")
    switchDiffTarget(
      id,
      entry(id).prs.find((pr) => pr.url === candidate.value) || null,
    );
  else {
    baseEditorFor(id).input.value = candidate.value;
    void applyBase(id);
  }
}

interface BaseEditor {
  root: HTMLElement;
  labelBtn: HTMLButtonElement;
  labelText: HTMLSpanElement;
  form: HTMLElement;
  input: HTMLInputElement;
  applyBtn: HTMLButtonElement;
  error: HTMLElement;
  finder: HTMLElement;
  open: boolean;
  busy: boolean;
  loadingCandidates: boolean;
  candidates: BaseCandidate[] | null;
  filtered: BaseCandidate[];
  active: number;
  dirty: boolean;
}

const baseEditors = new Map<string, BaseEditor>();
// Base-change redraws are owed even if the content hash is unchanged.
const forceViewRefresh = new Set<string>();

function showBaseError(ed: BaseEditor, message: string): void {
  ed.error.textContent = message;
  ed.error.style.display = message ? "block" : "none";
}

function renderFinder(agentId: string): void {
  const ed = baseEditors.get(agentId);
  if (!ed) return;
  ed.finder.textContent = "";
  const show = ed.open && !ed.busy && ed.filtered.length > 0;
  ed.finder.style.display = show ? "block" : "none";
  ed.input.setAttribute("aria-expanded", show ? "true" : "false");
  let previousSection = "";
  let previousRepo = "";
  ed.filtered.forEach((c, i) => {
    const section =
      c.kind === "pr"
        ? "Pull requests"
        : c.kind === "worktree"
          ? "Change target"
          : "Compare working directory against";
    if (section !== previousSection) {
      const heading = el("li", "menu-label diff-base-section", section);
      heading.setAttribute("role", "presentation");
      ed.finder.append(heading);
      previousSection = section;
    }
    if (c.kind === "pr" && c.repo !== previousRepo) {
      const heading = el("li", "diff-base-repo", c.repo || "");
      heading.setAttribute("role", "presentation");
      ed.finder.append(heading);
      previousRepo = c.repo || "";
    }
    const item = el(
      "li",
      "menu-item diff-base-item" + (i === ed.active ? " active" : ""),
    );
    item.setAttribute("role", "option");
    item.id = "diff-base-opt-" + agentId + "-" + i;
    item.setAttribute("aria-selected", i === ed.active ? "true" : "false");
    const kindLabel = c.kind === "worktree" || c.kind === "pr" ? "" : c.kind;
    const kind = el("span", "diff-base-kind", kindLabel);
    const label = el("span", "diff-base-label-text", c.label);
    label.title = c.label;
    if (c.kind !== "pr") item.append(kind);
    item.append(label);
    item.onclick = () => chooseCandidate(agentId, c);
    ed.finder.append(item);
  });
  ed.input.setAttribute(
    "aria-activedescendant",
    ed.active >= 0 && show ? "diff-base-opt-" + agentId + "-" + ed.active : "",
  );
  if (ed.active >= 0)
    document
      .getElementById("diff-base-opt-" + agentId + "-" + ed.active)
      ?.scrollIntoView({ block: "nearest" });
}

function refilterFinder(agentId: string): void {
  const ed = baseEditors.get(agentId);
  if (!ed) return;
  const e = entry(agentId);
  const targets: BaseCandidate[] = [
    { kind: "worktree", value: "", label: "Working directory" },
    ...e.prs.map((pr) => ({
      kind: "pr" as const,
      value: pr.url,
      repo: pr.url.split("/").slice(3, 5).join("/"),
      label:
        "#" +
        pr.number +
        " · " +
        (pr.title ||
          (pr.metadata === "unavailable"
            ? "Metadata unavailable"
            : "Metadata pending")) +
        (pr.state ? " · " + pr.state.toLowerCase() : ""),
    })),
  ];
  const query = ed.dirty ? ed.input.value : "";
  ed.filtered = groupPrCandidates([
    ...filterBaseCandidates(targets, query).slice(0, 5),
    ...filterBaseCandidates(ed.candidates || [], query).slice(0, 5),
  ]);
  // Invariant: Nothing highlighted until the arrow keys move: Enter applies the
  // typed text verbatim, so an exact ref the finder merely contains still wins.
  ed.active = query && ed.filtered[0]?.kind === "pr" ? 0 : -1;
  renderFinder(agentId);
}

// The candidates fetch starts when the editor opens and never blocks the
// pane: a failure (or a non-list payload) resolves to an empty list, leaving
// the box as free text.
function loadBaseCandidates(agentId: string): void {
  const ed = baseEditors.get(agentId);
  if (!ed || ed.candidates || ed.loadingCandidates) return;
  ed.loadingCandidates = true;
  void backendFor(agentId)
    .api("/api/conversations/" + agentId + "/diff/candidates")
    .then(async (r) => {
      let lists: BaseCandidateLists | null = null;
      try {
        if (r.ok) lists = (await r.json()) as BaseCandidateLists;
      } catch {
        lists = null;
      }
      const cur = baseEditors.get(agentId);
      if (!cur) return;
      cur.candidates = flattenBaseCandidates(lists);
      if (cur.open) refilterFinder(agentId);
    })
    .catch(() => {
      const cur = baseEditors.get(agentId);
      if (!cur) return;
      cur.candidates = [];
      if (cur.open) refilterFinder(agentId);
    })
    .finally(() => {
      const cur = baseEditors.get(agentId);
      if (cur) cur.loadingCandidates = false;
    });
}

function openBaseEditor(agentId: string): void {
  const ed = baseEditors.get(agentId);
  if (!ed || ed.open || ed.busy) return;
  ed.open = true;
  ed.dirty = false;
  ed.input.value = cache.get(agentId)?.summary?.base || "";
  showBaseError(ed, "");
  ed.root.classList.add("open");
  ed.labelBtn.style.display = "none";
  ed.form.style.display = "block";
  loadBaseCandidates(agentId);
  loadPullRequests(agentId);
  refilterFinder(agentId);
  ed.input.focus();
  ed.input.select();
}

function closeBaseEditor(agentId: string): void {
  const ed = baseEditors.get(agentId);
  if (!ed || !ed.open) return;
  ed.open = false;
  showBaseError(ed, "");
  ed.root.classList.remove("open");
  ed.labelBtn.style.display = "";
  ed.form.style.display = "none";
  renderFinder(agentId);
  ed.labelBtn.focus();
}

// Sync the collapsed label after each shell render. The form internals are
// never touched here, so an open editor keeps its draft, error, and focus.
function refreshBaseEditor(agentId: string, s: DiffSummary): void {
  const ed = baseEditors.get(agentId);
  if (!ed || ed.open) return;
  const e = entry(agentId);
  const baseLabel = s.base || "auto";
  ed.root.style.flex = e.selectedPr ? "1" : "";
  ed.labelText.textContent = e.selectedPr
    ? "PR #" +
      e.selectedPr.number +
      (e.selectedPr.title ? " · " + e.selectedPr.title : "") +
      (e.selectedPr.baseRefName ? " · vs " + e.selectedPr.baseRefName : "")
    : "vs " +
      baseLabel +
      (e.prs.length
        ? " · " + e.prs.length + (e.prs.length === 1 ? " PR" : " PRs")
        : "");
  ed.labelBtn.setAttribute(
    "aria-label",
    e.selectedPr
      ? "Change diff target: " + ed.labelText.textContent
      : "Change diff base: " + baseLabel,
  );
  ed.labelBtn.title = e.selectedPr
    ? ed.labelText.textContent + " — choose a change target"
    : s.base
      ? "Comparing against " +
        s.base +
        (s.baseSource ? " (" + s.baseSource + ")" : "") +
        " — click to change"
      : "Auto-detected base — click to set one";
}

// Enter/Apply previews the typed ref via ?base=, then persists it via PATCH.
// Either request failing shows the server error inline and leaves the pane
// (and its pending comments) untouched. An empty box clears the override.
async function applyBase(agentId: string): Promise<void> {
  const ed = baseEditors.get(agentId);
  if (!ed || !ed.open || ed.busy) return;
  const value = ed.input.value.trim();
  const switching = !!entry(agentId).selectedPr;
  const count = pendingCount(agentId);
  if (switching && count && !confirmDiscard(count)) return;
  ed.busy = true;
  ed.applyBtn.disabled = true;
  ed.applyBtn.textContent = "Applying\u2026";
  showBaseError(ed, "");
  renderFinder(agentId);
  try {
    if (value) {
      const preview = await backendFor(agentId).api(
        "/api/conversations/" +
          agentId +
          "/diff?base=" +
          encodeURIComponent(value),
      );
      if (!preview.ok) {
        showBaseError(ed, await baseErrorText(preview, value));
        return;
      }
    }
    const r = await backendFor(agentId).api(
      "/api/conversations/" + agentId + "/diff/base",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value ? { base: value } : { base: null }),
      },
    );
    if (!r.ok) {
      showBaseError(ed, await baseErrorText(r, value));
      return;
    }
    closeBaseEditor(agentId);
    // Invariant: Pending line comments live outside the git cache, so dropping
    // the cached patches and forcing open views to redraw is comment-safe.
    patches.delete(agentId);
    forceViewRefresh.add(agentId);
    if (switching) switchDiffTarget(agentId, null, true);
    else void maybeFetch(agentId, true);
  } catch {
    showBaseError(
      ed,
      "Couldn't reach the server. The current base is unchanged.",
    );
  } finally {
    const cur = baseEditors.get(agentId);
    if (cur) {
      cur.busy = false;
      cur.applyBtn.disabled = false;
      cur.applyBtn.textContent = "Apply";
      renderFinder(agentId);
    }
  }
}

function baseEditorFor(agentId: string): BaseEditor {
  let ed = baseEditors.get(agentId);
  if (ed) return ed;
  const root = el("div", "diff-base-edit");
  const labelBtn = el("button", "diff-base diff-base-btn");
  labelBtn.type = "button";
  const labelText = el("span", "diff-base-label");
  labelBtn.append(labelText);
  labelBtn.onclick = () => openBaseEditor(agentId);
  const form = el("div", "diff-base-form");
  form.style.display = "none";
  const row = el("div", "diff-base-row");
  const input = el("input", "diff-base-input text-field sm");
  input.type = "text";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", "Base ref to compare against");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "diff-base-finder-" + agentId);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.placeholder = "Find PR, branch, tag, or commit\u2026";
  const applyBtn = el("button", "btn sm primary diff-base-apply", "Apply");
  applyBtn.type = "button";
  const cancelBtn = el("button", "btn sm diff-base-cancel", "Cancel");
  cancelBtn.type = "button";
  row.append(input, applyBtn, cancelBtn);
  const error = el("div", "diff-base-error");
  error.style.display = "none";
  error.setAttribute("role", "status");
  const finder = el("ul", "menu diff-base-finder");
  finder.id = "diff-base-finder-" + agentId;
  finder.setAttribute("role", "listbox");
  finder.style.display = "none";
  form.append(row, finder, error);
  root.append(labelBtn, form);
  const created: BaseEditor = {
    root,
    labelBtn,
    labelText,
    form,
    input,
    applyBtn,
    error,
    finder,
    open: false,
    busy: false,
    loadingCandidates: false,
    candidates: null,
    filtered: [],
    active: -1,
    dirty: false,
  };
  baseEditors.set(agentId, created);
  ed = created;
  input.oninput = () => {
    const cur = baseEditors.get(agentId);
    if (cur) cur.dirty = true;
    refilterFinder(agentId);
  };
  input.onkeydown = (ev: KeyboardEvent) => {
    const cur = baseEditors.get(agentId);
    if (!cur) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!cur.filtered.length) return;
      ev.preventDefault();
      cur.active = moveFinderIndex(
        cur.active,
        ev.key === "ArrowDown" ? 1 : -1,
        cur.filtered.length,
      );
      renderFinder(agentId);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const pick = cur.active >= 0 ? cur.filtered[cur.active] : null;
      if (pick) chooseCandidate(agentId, pick);
      else void applyBase(agentId);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      // Invariant: A busy editor stays open: closing now would strand the
      // in-flight result as a silent no-op on a hidden form.
      if (!cur.busy) closeBaseEditor(agentId);
    }
  };
  applyBtn.onclick = () => {
    const cur = baseEditors.get(agentId);
    const pick = cur && cur.active >= 0 ? cur.filtered[cur.active] : null;
    if (pick) chooseCandidate(agentId, pick);
    else void applyBase(agentId);
  };
  cancelBtn.onclick = () => {
    if (!baseEditors.get(agentId)?.busy) closeBaseEditor(agentId);
  };
  return ed;
}

// ---- rendering ------------------------------------------------------------
// status mark for one file: once its patch loads, the patch headers say
// whether it is new (+), deleted (−), or renamed (→); before that the
// summary's coarse status only distinguishes untracked (+) from modified (~).
function markFor(
  file: ChangedFile,
  st: PatchState | undefined,
): { mark: string; cls: string } {
  if (st && st.status === "ready" && !st.binary) {
    if (/^(new file mode|new file)/m.test(st.patch))
      return { mark: "+", cls: "add" };
    if (/deleted file mode/m.test(st.patch)) return { mark: "−", cls: "del" };
    if (/^rename (from|to) /m.test(st.patch)) return { mark: "→", cls: "mod" };
    return { mark: "~", cls: "mod" };
  }
  if (file.status === "untracked") return { mark: "+", cls: "add" };
  return { mark: "~", cls: "mod" };
}

// Renders unified rows: escaped code HTML, plain-text hunk headers. Comments
// anchor by line/side; gap bars use current exact library indices.
function unifiedRow(host: HTMLElement, row: ViewLine, ctx: DiffCtx): void {
  if (row.kind === "hunk") return;
  const num = row.kind === "del" ? row.oldNo : row.newNo;
  const side = row.kind === "del" ? "old" : "new";
  const rowEl = el("div", "diff-row " + row.kind);
  rowEl.append(el("span", "diff-num", num == null ? "" : String(num)));
  const code = el("div", "diff-line");
  code.append(el("span", "diff-sign", diffContextMarker(row.kind)));
  const src = el("span", "diff-src");
  src.innerHTML = row.html;
  code.append(src);
  rowEl.append(code);
  if (num != null) {
    rowEl.dataset["line"] = String(num);
    rowEl.dataset["side"] = side;
    commentable(rowEl, num, side, ctx, code);
  } else rowEl.insertBefore(el("span", "diff-gutter"), code);
  host.append(rowEl);
}

// One split row: old side left, new side right. Each side's lines take
// comments anchored to that side (deletions and old-side context to old);
// hunk headers span both columns as plain text. Like unified hunk rows,
// headers and the trailing gap render in the file view.
function splitRow(host: HTMLElement, srow: SplitRow, ctx: DiffCtx): void {
  // Invariant: Headers render in the file view (gap bars close over expand
  // state); the trailing end-of-file gap renders as a bar alone. Mid-file
  // placeholder rows keep their blank cells as before.
  if (srow.hunk != null) return;
  if (srow.left == null && srow.right == null && srow.expand?.last) return;
  const rowEl = el("div", "diff-split-row");
  for (const [side, cls] of [
    [srow.left, "old"],
    [srow.right, "new"],
  ] as const) {
    const cell = el("div", "diff-cell " + cls);
    if (
      side &&
      (side.kind === "add" || side.kind === "del" || side.kind === "ctx")
    ) {
      // Invariant: The column's own number: old-side for the left cell,
      // new-side for the right. Added lines have no old number and live only on
      // the right, so a null here just means "not commentable on this side".
      const no = cls === "old" ? side.oldNo : side.newNo;
      cell.classList.add(side.kind);
      cell.append(el("span", "diff-num", no == null ? "" : String(no)));
      const code = el("div", "diff-line");
      const src = el("span", "diff-src");
      src.innerHTML = side.html;
      code.append(src);
      cell.append(code);
      if (no != null) {
        cell.dataset["line"] = String(no);
        cell.dataset["side"] = cls;
        commentable(cell, no, cls, ctx, code);
      } else cell.insertBefore(el("span", "diff-gutter"), code);
    } else {
      cell.classList.add("empty");
      cell.append(el("span", "diff-num"), el("span", "diff-gutter"));
    }
    rowEl.append(cell);
  }
  host.append(rowEl);
}

interface FileView {
  body: HTMLElement;
  open: boolean;
  file: DiffFileType | null;
  allExpandedMode: "unified" | "split" | null;
  setOpen(open: boolean): void;
  refresh(target: DiffTarget, version: string | null, force?: boolean): void;
  redraw(): void;
  resetExpansion(): void;
  showContentsUnavailable(): void;
}

// Per-agent file DOM survives shell changes; clear/submit tears it down.
const fileViews = new Map<string, Map<string, FileView>>();

// A patch load finishing only repaints the shell (row marks, counts); the
// file's own body redraws here, by reference, without disturbing editors in
// other files.
function repaintView(agentId: string, path: string): void {
  repaintShell();
  const v = fileViews.get(agentId)?.get(path);
  // Invariant: A late contents fetch must not rebuild an editor being typed
  // into.
  if (v && !v.body.querySelector(".diff-line-comment")) v.redraw();
}

// Re-render open files after a new summary version lands. Files the user
// collapsed render lazily when reopened; dropped paths are forgotten.
function refreshFileViews(
  agentId: string,
  summary: DiffSummary,
  force = false,
): void {
  const paths = new Set([
    ...(summary.files || []).map((f) => f.path),
    ...(summary.untracked || []),
  ]);
  const target = targetFor(summary);
  let views = fileViews.get(agentId);
  if (!views) {
    views = new Map();
    fileViews.set(agentId, views);
  }
  for (const [path, view] of [...views]) {
    if (!paths.has(path)) {
      views.delete(path);
      patches.get(agentId)?.delete(path);
    } else view.refresh(target, summary.version || null, force);
  }
}

// Diffs with at most this many changed files open every file on first paint.
export const OPEN_ALL_FILES_MAX = 20;

function fileViewFor(
  agentId: string,
  file: ChangedFile,
  target: DiffTarget,
  version: string | null,
  openByDefault = false,
): FileView {
  let m = fileViews.get(agentId);
  if (!m) {
    m = new Map();
    fileViews.set(agentId, m);
  }
  const existing = m.get(file.path);
  if (existing) {
    existing.refresh(target, version);
    return existing;
  }

  const body = el("div", "diff-file-body");
  body.style.display = "none";
  const ctx: DiffCtx = {
    agentId,
    group: target.id,
    path: file.path,
    target,
    onChange: repaintShell,
    selection: null as unknown as LineSelection,
  };
  // Invariant: The selection reads the body and ctx lazily, so redraws rebuild
  // rows without orphans; open range editors re-anchor after every draw.
  ctx.selection = createLineSelection({
    body: () => body,
    scope: () => ({
      agentId: ctx.agentId,
      group: ctx.group,
      path: ctx.path,
      target: ctx.target,
    }),
    notify: () => ctx.onChange(),
  });
  let currentVersion = version;
  let drawGen = 0;
  let fileKey = "";

  // One gap-bar click. Bars only render once the full contents are in, so
  // the row's exact library index applies directly; the redraw re-derives
  // rows (and fresh bars) from the expanded file.
  function requestExpand(mod: RenderMod, index: number, dir: ExpandDir): void {
    if (!v.file || !mod.isExpandEnabled(v.file)) return;
    mod.expandHunk(v.file, viewMode, dir, index);
    void draw();
  }

  function contentsUnavailableNote(st: PatchState): HTMLElement {
    return el(
      "div",
      "diff-expand-note",
      ctx.target.kind === "pr"
        ? "Pull request view shows patch hunks only."
        : st.contentsTruncated
          ? "Full-file context isn’t available — this file is over the ~1 MB expansion cap."
          : "Couldn’t load this file’s full contents — context expansion is unavailable.",
    );
  }

  async function draw(): Promise<void> {
    const gen = ++drawGen;
    body.textContent = "";
    const st = patchFor(agentId, file.path, currentVersion);
    if (!st || st.status === "loading") {
      body.append(el("div", "diff-loading", "Loading patch…"));
      if (!st) loadPatch(agentId, file.path, currentVersion);
      return;
    }
    if (st.status === "error" || !st.patch) {
      const note = el("div", "diff-error");
      note.textContent = "Couldn’t load this file’s patch. ";
      const retry = el("button", "btn sm diff-retry", "Retry");
      retry.type = "button";
      retry.onclick = () => {
        loadPatch(agentId, file.path, currentVersion);
        void draw();
      };
      note.append(retry);
      body.append(note);
      return;
    }
    if (st.binary) {
      body.append(el("div", "diff-empty", "Binary file — not shown."));
      return;
    }
    const host = el(
      "div",
      "diff-patch" + (viewMode === "split" ? " split" : ""),
    );
    host.setAttribute("role", "group");
    host.setAttribute(
      "aria-label",
      "Diff for " + file.path + " (" + viewMode + ")",
    );
    body.append(host);
    let mod: RenderMod;
    let core: Core;
    try {
      mod = await loadRenderer();
      core = await loadCore();
    } catch {
      if (gen !== drawGen) return;
      host.replaceChildren(
        el("div", "diff-error", "Couldn’t load the diff renderer."),
      );
      return;
    }
    if (gen !== drawGen) return;
    if (st.contentsStatus === "unknown")
      loadContents(agentId, file.path, currentVersion);
    const contents =
      st.contentsStatus === "ready" &&
      st.oldContent != null &&
      st.newContent != null
        ? { oldContent: st.oldContent, newContent: st.newContent }
        : null;
    const key = (currentVersion ?? "") + "|" + (contents ? "C" : "-");
    if (!v.file || fileKey !== key) {
      v.file = mod.buildDiffFile(core, st.patch, file.path, contents);
      fileKey = key;
      v.allExpandedMode = null;
    }
    const derive = (): ViewLine[] | SplitRow[] | null => {
      if (!v.file) return null;
      try {
        const rows =
          viewMode === "split"
            ? mod.splitView(core, v.file)
            : mod.unifiedView(core, v.file);
        return rows.length ? rows : null;
      } catch {
        return null;
      }
    };
    // Invariant: Render headers, gap bars, and code rows. Comment editors
    // reopen unfocused from saved text (see commentable), so expansion keeps
    // pending notes while dropping only focus.
    const renderAll = (rows: ViewLine[] | SplitRow[]): void => {
      const content = el("div", "diff-patch-content");
      host.replaceChildren(content);
      if (st.contentsStatus === "unavailable")
        content.append(contentsUnavailableNote(st));
      const paint = (
        expand: HunkExpand | null,
        header: string | null,
      ): void => {
        // Invariant: Bars render only with the contents in, so each bar closes
        // over its row's exact library index; every redraw rebuilds the bars.
        if (expand && st.contentsStatus !== "unavailable")
          content.append(
            gapBar(expand, mod.EXPAND_STEP, (dir) =>
              requestExpand(mod, expand.index, dir),
            ),
          );
        if (header) content.append(el("div", "diff-hunk", header));
      };
      if (viewMode === "split")
        for (const r of rows as SplitRow[]) {
          if (r.hunk != null) {
            paint(r.expand ?? null, r.hunk);
            continue;
          }
          if (r.left == null && r.right == null) {
            // Invariant: The trailing end-of-file gap renders as a bar alone;
            // mid-file placeholder pairs keep their blank cells.
            if (r.expand?.last) paint(r.expand, null);
            else splitRow(content, r, ctx);
            continue;
          }
          splitRow(content, r, ctx);
        }
      else
        for (const r of rows as ViewLine[]) {
          if (r.kind === "hunk") {
            paint(r.expand ?? null, r.expand?.last ? null : r.html || null);
            continue;
          }
          unifiedRow(content, r, ctx);
        }
    };
    let rows = derive();
    if (gen !== drawGen) return;
    if (!rows) {
      host.replaceChildren(el("div", "diff-empty", "No textual changes."));
      return;
    }
    renderAll(rows);
    if (
      expandAllOn &&
      v.file &&
      mod.isExpandEnabled(v.file) &&
      v.allExpandedMode !== viewMode
    ) {
      mod.expandAll(v.file, viewMode);
      v.allExpandedMode = viewMode;
      const full = derive();
      if (full) {
        rows = full;
        renderAll(rows);
      }
    }
    if (rows.length >= mod.MAX_RENDER_ROWS)
      host.append(
        el("div", "diff-trunc", "Diff too large to show in full — truncated."),
      );
    else if (st.truncated)
      host.append(
        el(
          "div",
          "diff-trunc",
          "File patch hit the server’s size cap — partial.",
        ),
      );
    // Invariant: Every redraw rebuilds rows (and drops boxes); re-anchor an
    // open range editor from its saved text, unfocused like the singles.
    ctx.selection.restore();
  }

  const v: FileView = {
    body,
    open: false,
    file: null,
    allExpandedMode: null,
    setOpen(open: boolean): void {
      v.open = open;
      body.style.display = open ? "block" : "none";
      if (open) void draw();
      else drawGen++;
    },
    resetExpansion(): void {
      v.allExpandedMode = null;
    },
    refresh(
      nextTarget: DiffTarget,
      nextVersion: string | null,
      force = false,
    ): void {
      ctx.target = nextTarget;
      if (force || nextVersion !== currentVersion) {
        currentVersion = nextVersion;
        v.resetExpansion();
        if (v.open) void draw();
      }
    },
    redraw(): void {
      if (v.open) void draw();
    },
    showContentsUnavailable(): void {
      const st = patchFor(agentId, file.path, currentVersion);
      const content = body.querySelector(".diff-patch-content");
      if (st && content && !content.querySelector(".diff-expand-note"))
        content.append(contentsUnavailableNote(st));
    },
  };
  m.set(file.path, v);
  // Invariant: Small diffs start with every file open so the pane shows the
  // changes without a click per file; each open file still loads its patch and
  // contents lazily, so larger lists stay collapsed to bound the requests.
  if (openByDefault) v.setOpen(true);
  return v;
}

// Re-render every open file after the unified/split toggle. Patch text and
// full contents are cached, so this reuses them without refetching; the
// pane-wide expand-all re-applies in the new mode on the next draw.
function redrawOpenViews(agentId: string | null): void {
  if (!agentId) return;
  for (const view of fileViews.get(agentId)?.values() || []) {
    view.allExpandedMode = null;
    view.redraw();
  }
}

// Open every listed file (patches load lazily as before; with expand-all on,
// each file's draw fetches full contents and expands on arrival).
function openAllViews(agentId: string | null): void {
  if (!agentId) return;
  for (const view of fileViews.get(agentId)?.values() || [])
    if (!view.open) view.setOpen(true);
}

// Collapse every open file's context back to its patch hunks. File bodies
// stay open; only expansion (and its markers) resets.
async function collapseAllViews(agentId: string | null): Promise<void> {
  if (!agentId) return;
  let mod: RenderMod;
  try {
    mod = await loadRenderer();
  } catch {
    return;
  }
  for (const view of fileViews.get(agentId)?.values() || []) {
    if (view.file) {
      // Invariant: Both modes: expansion state is per-mode in the library, so a
      // later layout toggle must not resurrect the other mode's lines.
      try {
        mod.collapseAll(view.file, "unified");
        mod.collapseAll(view.file, "split");
      } catch {}
    }
    view.resetExpansion();
    view.redraw();
  }
}

// One current pane target owns repaints from editor and submit interactions.
let paneEl: DiffEl | null = null;
let submitting = false;
let submitFailed = false;

// Repaints keyed shell rows; referenced file bodies preserve their DOM.
function repaintShell(): void {
  if (paneEl && shownId) renderShell(paneEl, shownId);
}

function prSummaryTemplate(agentId: string): TemplateResult | typeof nothing {
  const e = entry(agentId);
  const pr = e.selectedPr;
  if (!pr) return nothing;
  const bodyId = "diff-pr-description-" + agentId;
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
    ${pr.body?.trim()
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
              observer.observe(element);
            })}
          >
            ${unsafeHTML(safeMarkdown(pr.body))}
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
      : pr.metadata === "pending"
        ? html`<div class="diff-loading" role="status">
            ${e.prError || "Loading pull request description…"}
          </div>`
        : nothing}
  </section>`;
}

function headTemplate(agentId: string, s: DiffSummary): TemplateResult {
  const pr = entry(agentId).selectedPr ? null : s.currentPr;
  const prUrl = pr && pr.url.startsWith("https://") ? pr.url : null;
  const cwd = shortCwd(s.cwd);
  return html`<div class="diff-head">
    ${cwd
      ? html`<span class="diff-cwd" title=${s.cwd || ""}>${cwd}</span>`
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
    if (viewMode === mode) return;
    viewMode = mode;
    redrawOpenViews(agentId);
    repaintShell();
  };
  return html`<div class="diff-toggle" role="group" aria-label="Diff layout">
    <button
      class="diff-toggle-btn ${viewMode === "unified" ? "on" : ""}"
      aria-pressed=${viewMode === "unified"}
      @click=${() => set("unified")}
    >
      Unified
    </button>
    <button
      class="diff-toggle-btn ${viewMode === "split" ? "on" : ""}"
      aria-pressed=${viewMode === "split"}
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
    if (expandAllOn) {
      expandAllOn = false;
      repaintShell();
      void collapseAllViews(agentId);
    } else {
      expandAllOn = true;
      openAllViews(agentId);
      repaintShell();
    }
  };
  return html`<div class="diff-toolbar">
    ${viewToggleTemplate(agentId)}
    <button
      ?disabled=${!!entry(agentId).selectedPr}
      class="diff-expand-all"
      aria-pressed=${expandAllOn}
      title=${expandAllOn
        ? "Show only the patch hunks in every file"
        : "Open every file and show every hidden line"}
      @click=${toggleAll}
    >
      ${expandAllOn ? "Collapse all" : "Expand all"}
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
  const v = fileViewFor(agentId, file, target, version, openByDefault);
  const m = markFor(file, patchFor(agentId, file.path, version));
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
    fileViews.delete(agentId);
    patches.delete(agentId);
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
      const r = await backendFor(agentId).jpost(
        "/api/conversations/" + agentId + "/deliver",
        {
          content: msg,
        },
      );
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
        fileViews.delete(agentId);
        patches.delete(agentId);
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
  const version = s.version || null;
  const target = targetFor(s);
  const more = s.moreFiles || 0;
  const openByDefault = !more && changed.length <= OPEN_ALL_FILES_MAX;
  return html` <div class="diff-list" tabindex="-1">
      ${prSummaryTemplate(agentId)}
      ${error
        ? html`<div
            class=${error === newerContent ? "diff-expand-note" : "diff-error"}
            role="status"
            aria-live="polite"
          >
            ${error}
          </div>`
        : nothing}
      ${s.stat
        ? html`<details class="diff-stat" open>
            <summary>
              Diff
              stat${changed.length
                ? html` · ${changed.length}
                  file${changed.length === 1 ? "" : "s"}${more ? "+" : ""}`
                : nothing}
            </summary>
            <pre>${s.stat}</pre>
          </details>`
        : nothing}
      ${s.truncated
        ? html`<div class="diff-trunc" role="status">
            The diff hit the server’s size cap — some content below is partial.
          </div>`
        : nothing}
      ${changed.length
        ? html`<div class="diff-group">
            <div class="diff-group-head">
              <span class="diff-group-label">Changed files</span>
              <span class="badge diff-group-count"
                >${more ? `${changed.length}+` : changed.length}</span
              >
            </div>
            ${repeat(
              changed,
              (f) => f.path,
              (f) =>
                fileRowTemplate(agentId, f, target, version, openByDefault),
            )}
            ${more
              ? html`<div class="diff-more" aria-live="polite">
                  …and ${more} more file${more === 1 ? "" : "s"} (list capped).
                </div>`
              : nothing}
          </div>`
        : nothing}
      ${untracked.length
        ? html`<div class="diff-group">
            <div class="diff-group-head">
              <span class="diff-group-label">Untracked</span>
              <span class="badge diff-group-count">${untracked.length}</span>
            </div>
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
          </div>`
        : nothing}
      ${!s.available && !error
        ? html`<div class="diff-empty" role="status">
            Working directory diff unavailable. Choose a pull request above.
          </div>`
        : nothing}
      ${s.available && !changed.length && !untracked.length
        ? html`<div class="diff-empty" aria-live="polite">
            No changes to show.
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
  const held = heldSummaries.get(agentId);
  if (e && held && !reviewing(agentId)) {
    heldSummaries.delete(agentId);
    e.summary = held;
    e.error = null;
    refreshFileViews(agentId, held, forceViewRefresh.delete(agentId));
  }
  const s = e && e.summary;
  if (!s) {
    renderPowerbarControls(el0, baseEditorFor(agentId).root);
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
    html`${baseEditorFor(agentId).root}
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
  if (document.activeElement === el0) focusDiffList(el0);
  refreshBaseEditor(agentId, s);
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
  count: () => {
    const id = state.selectedId;
    let n = 0;
    for (const [scope, notes] of comments)
      if (scope === id || scope.startsWith(id + "\n")) n += notes.size;
    return n;
  },
  discard: () => {
    const id = state.selectedId;
    for (const scope of [...comments.keys()])
      if (scope === id || scope.startsWith(id + "\n")) comments.delete(scope);
    for (const scope of [...fileViews.keys()])
      if (scope === id || scope.startsWith(id + "\n")) fileViews.delete(scope);
    for (const scope of [...patches.keys()])
      if (scope === id || scope.startsWith(id + "\n")) patches.delete(scope);
  },
});

registerPane({
  id: PANE_ID,
  title: "Changes",
  icon: CHANGES_ICON,
  available,
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
    void maybeFetch(ctx.agentId, false);
    update(el0 as DiffEl, ctx);
  },
  refresh(el0: HTMLElement, ctx: PaneContext) {
    update(el0 as DiffEl, ctx);
  },
});
