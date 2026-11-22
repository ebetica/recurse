// Owns lazy patches, context expansion and persistent DOM for Changes files.
import { backendFor } from "../backends/index.js";
import { el } from "../dom.js";
import {
  commentable,
  createLineSelection,
  type CommentCtx,
} from "./comments.js";
import { gapBar } from "./expand.js";
import {
  diffContextMarker,
  targetFor,
  type ChangedFile,
  type CommentSide,
  type DiffSummary,
  type DiffTarget,
} from "./model.js";
import {
  buildDiffFile,
  collapseAll,
  expandAll as expandFile,
  expandHunk,
  EXPAND_STEP,
  isExpandEnabled,
  loadCore,
  MAX_RENDER_ROWS,
  splitView,
  unifiedView,
  type ExpandDir,
  type HunkExpand,
  type SplitRow,
  type ViewLine,
} from "./render.js";
import type { DiffFile as DiffFileType } from "@git-diff-view/core";

// Key suffix for views and patches of uncommitted changes, diffed against HEAD.
export const LOCAL = "\nlocal";

// Unified by default; the toggle re-renders whatever is open.
let viewMode: "unified" | "split" = "unified";
// Pane-wide expansion applies to open/new files when full contents arrive.
let expandAllOn = false;

export function layout(): "unified" | "split" {
  return viewMode;
}

export function setLayout(mode: "unified" | "split"): void {
  viewMode = mode;
}

export function expandAll(): boolean {
  return expandAllOn;
}

export function setExpandAll(on: boolean): void {
  expandAllOn = on;
}

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

export function clearPatches(agentId: string): void {
  patches.delete(agentId);
}

// One file's patch, fetched lazily on expand and cached for the summary
// version in force. Unknown or failing paths stay an inline error with a
// retry — never a pane-wide failure.
function loadPatch(
  agentId: string,
  path: string,
  version: string | null,
  source: PatchSource,
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
    source.owner +
    "/diff/files?path=" +
    encodeURIComponent(path) +
    source.query;
  void backendFor(source.owner)
    .api(url)
    .then(async (r) => {
      if (!r.ok) {
        st.status = "error";
        repaintView(agentId, path, source.onChange);
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
      repaintView(agentId, path, source.onChange);
    })
    .catch(() => {
      st.status = "error";
      repaintView(agentId, path, source.onChange);
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
  source: PatchSource,
  target: DiffTarget,
): void {
  const st = patchFor(agentId, path, version);
  if (!st || st.status !== "ready") return;
  if (target.kind === "pr") {
    st.contentsStatus = "unavailable";
    return;
  }
  if (st.contentsStatus !== "unknown") return;
  st.contentsStatus = "loading";
  const url =
    "/api/conversations/" +
    source.owner +
    "/diff/files?path=" +
    encodeURIComponent(path) +
    "&contents=1" +
    source.query;
  const done = () => {
    if (st.contentsStatus === "unavailable") {
      fileViews.get(agentId)?.get(path)?.showContentsUnavailable();
    } else repaintView(agentId, path, source.onChange);
  };
  void backendFor(source.owner)
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

// status mark for one file: once its patch loads, the patch headers say
// whether it is new (+), deleted (−), or renamed (→); before that the
// summary's coarse status only distinguishes untracked (+) from modified (~).
export function fileMark(
  agentId: string,
  file: ChangedFile,
  version: string | null,
): { mark: string; cls: string } {
  const st = patchFor(agentId, file.path, version);
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

function codeCell(
  host: HTMLElement,
  row: ViewLine,
  side: CommentSide,
  ctx: CommentCtx,
  sign?: string,
): void {
  const num = side === "old" ? row.oldNo : row.newNo;
  host.append(el("span", "diff-num", num == null ? "" : String(num)));
  const code = el("div", "diff-line");
  if (sign !== undefined) code.append(el("span", "diff-sign", sign));
  const src = el("span", "diff-src");
  src.innerHTML = row.html;
  code.append(src);
  host.append(code);
  if (num != null) {
    host.dataset["line"] = String(num);
    host.dataset["side"] = side;
    commentable(host, num, side, ctx, code);
  } else host.insertBefore(el("span", "diff-gutter"), code);
}

function unifiedRow(
  host: HTMLElement,
  row: ViewLine,
  ctx: CommentCtx,
  sign: string,
): void {
  const rowEl = el("div", "diff-row " + row.kind);
  codeCell(rowEl, row, row.kind === "del" ? "old" : "new", ctx, sign);
  host.append(rowEl);
}

// Each split cell takes the number and comments for its own side.
function splitRow(host: HTMLElement, srow: SplitRow, ctx: CommentCtx): void {
  const rowEl = el("div", "diff-split-row");
  for (const [side, cls] of [
    [srow.left, "old"],
    [srow.right, "new"],
  ] as const) {
    const cell = el("div", "diff-cell " + cls);
    if (side && side.kind !== "hunk") {
      cell.classList.add(side.kind);
      codeCell(cell, side, cls, ctx);
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
  refresh(
    target: DiffTarget,
    version: string | null,
    query: string,
    force?: boolean,
  ): void;
  redraw(): void;
  resetExpansion(): void;
  showContentsUnavailable(): void;
}

// Per-agent file DOM survives shell changes; clear/submit tears it down.
const fileViews = new Map<string, Map<string, FileView>>();

// A patch load finishing only repaints the shell (row marks, counts); the
// file's own body redraws here, by reference, without disturbing editors in
// other files.
function repaintView(
  agentId: string,
  path: string,
  onChange: () => void,
): void {
  onChange();
  const v = fileViews.get(agentId)?.get(path);
  // Invariant: A late contents fetch must not rebuild an editor being typed
  // into.
  if (v && !v.body.querySelector(".diff-line-comment")) v.redraw();
}

// Re-render open files after a new summary version lands. Files the user
// collapsed render lazily when reopened; dropped paths are forgotten.
export function refreshFileViews(
  agentId: string,
  summary: DiffSummary,
  query: string,
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
  for (const [path, view] of Array.from(views)) {
    if (!paths.has(path)) {
      views.delete(path);
      patches.get(agentId)?.delete(path);
    } else view.refresh(target, summary.version || null, query, force);
  }
}

type PatchSource = {
  owner: string;
  query: string;
  onChange: () => void;
};

interface FileViewOptions extends PatchSource {
  target: DiffTarget;
  version: string | null;
  openByDefault: boolean;
}

export function fileViewFor(
  agentId: string,
  file: ChangedFile,
  { owner, query, target, version, openByDefault, onChange }: FileViewOptions,
): FileView {
  let m = fileViews.get(agentId);
  if (!m) {
    m = new Map();
    fileViews.set(agentId, m);
  }
  const existing = m.get(file.path);
  if (existing) {
    existing.refresh(target, version, query);
    return existing;
  }

  const body = el("div", "diff-file-body");
  body.style.display = "none";
  const source = { owner, query, onChange };
  // Invariant: The selection reads the body and ctx lazily, so redraws rebuild
  // rows without orphans; open range editors re-anchor after every draw.
  const selection = createLineSelection({
    body: () => body,
    scope: () => ({
      agentId: ctx.agentId,
      group: ctx.group,
      path: ctx.path,
      target: ctx.target,
    }),
    notify: onChange,
  });
  const ctx: CommentCtx = {
    agentId: owner,
    group: target.id,
    path: file.path,
    target,
    onChange,
    selection,
  };
  let currentVersion = version;
  let drawGen = 0;
  let fileKey = "";

  // One gap-bar click. Bars only render once the full contents are in, so
  // the row's exact library index applies directly; the redraw re-derives
  // rows (and fresh bars) from the expanded file.
  function requestExpand(index: number, dir: ExpandDir): void {
    if (!v.file || !isExpandEnabled(v.file)) return;
    expandHunk(v.file, viewMode, dir, index);
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
      if (!st) loadPatch(agentId, file.path, currentVersion, source);
      return;
    }
    if (st.status === "error" || !st.patch) {
      const note = el("div", "diff-error");
      note.textContent = "Couldn’t load this file’s patch. ";
      const retry = el("button", "btn sm diff-retry", "Retry");
      retry.type = "button";
      retry.onclick = () => {
        loadPatch(agentId, file.path, currentVersion, source);
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
    let core: Awaited<ReturnType<typeof loadCore>>;
    try {
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
      loadContents(agentId, file.path, currentVersion, source, ctx.target);
    const contents =
      st.contentsStatus === "ready" &&
      st.oldContent != null &&
      st.newContent != null
        ? { oldContent: st.oldContent, newContent: st.newContent }
        : null;
    const key = (currentVersion ?? "") + "|" + (contents ? "C" : "-");
    if (!v.file || fileKey !== key) {
      v.file = buildDiffFile(core, st.patch, file.path, contents);
      fileKey = key;
      v.allExpandedMode = null;
    }
    const derive = (): ViewLine[] | SplitRow[] | null => {
      if (!v.file) return null;
      try {
        const rows =
          viewMode === "split"
            ? splitView(core, v.file)
            : unifiedView(core, v.file);
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
            gapBar(expand, EXPAND_STEP, (dir) =>
              requestExpand(expand.index, dir),
            ),
          );
        if (header) content.append(el("div", "diff-hunk", header));
      };
      if (viewMode === "split")
        for (const r of rows as SplitRow[]) {
          // The trailing gap renders alone; mid-file placeholders keep cells.
          if (
            r.hunk != null ||
            (r.left == null && r.right == null && r.expand?.last)
          )
            paint(r.expand ?? null, r.hunk);
          else splitRow(content, r, ctx);
        }
      else
        for (const r of rows as ViewLine[]) {
          if (r.kind === "hunk") {
            paint(r.expand ?? null, r.expand?.last ? null : r.html || null);
            continue;
          }
          unifiedRow(content, r, ctx, diffContextMarker(r.kind));
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
      isExpandEnabled(v.file) &&
      v.allExpandedMode !== viewMode
    ) {
      expandFile(v.file, viewMode);
      v.allExpandedMode = viewMode;
      const full = derive();
      if (full) {
        rows = full;
        renderAll(rows);
      }
    }
    if (rows.length >= MAX_RENDER_ROWS)
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
      query: string,
      force = false,
    ): void {
      ctx.target = nextTarget;
      source.query = query;
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

// The file views of the pane's target and of its uncommitted changes.
export function viewsOf(agentId: string | null): FileView[] {
  if (!agentId) return [];
  return [agentId, agentId + LOCAL].flatMap((key) => [
    ...(fileViews.get(key)?.values() || []),
  ]);
}

// Re-render every open file after the unified/split toggle. Patch text and
// full contents are cached, so this reuses them without refetching; the
// pane-wide expand-all re-applies in the new mode on the next draw.
export function redrawOpenViews(agentId: string | null): void {
  for (const view of viewsOf(agentId)) {
    view.allExpandedMode = null;
    view.redraw();
  }
}

// Open every listed file (patches load lazily as before; with expand-all on,
// each file's draw fetches full contents and expands on arrival).
export function openAllViews(agentId: string | null): void {
  for (const view of viewsOf(agentId)) if (!view.open) view.setOpen(true);
}

// Collapse every open file's context back to its patch hunks. File bodies
// stay open; only expansion (and its markers) resets.
export function collapseAllViews(agentId: string | null): void {
  for (const view of viewsOf(agentId)) {
    if (view.file) {
      // Invariant: Both modes: expansion state is per-mode in the library, so a
      // later layout toggle must not resurrect the other mode's lines.
      try {
        collapseAll(view.file, "unified");
        collapseAll(view.file, "split");
      } catch {}
    }
    view.resetExpansion();
    view.redraw();
  }
}

// Forgets the file views and patches of the target and uncommitted changes.
export function dropViews(agentId: string): void {
  for (const key of [agentId, agentId + LOCAL]) {
    fileViews.delete(key);
    patches.delete(key);
  }
}
