// Lazy per-file diff-library renderer; patch paints before full contents.
// Full contents preserve syntax state and enable hunk expansion. Patch-only
// highlighting resets at each hunk; missing opening quotes remain unknowable.
// Row models stay DOM-free; library/language packs never load at shell startup.
import type {
  DiffFile as DiffFileType,
  DiffUnifiedContentLineItem,
  DiffSplitContentLineItem,
} from "@git-diff-view/core";

export type ViewKind = "add" | "del" | "ctx" | "hunk";

export interface ViewLine {
  kind: ViewKind;
  oldNo: number | null;
  newNo: number | null;
  html: string;
  // Gap state needs full contents; an empty-header last gap renders only a bar.
  expand?: HunkExpand | null;
}

export interface SplitRow {
  hunk: string | null;
  left: ViewLine | null;
  right: ViewLine | null;
  expand?: HunkExpand | null;
}

// Library reveal step; smaller gaps expand wholly to keep hunk boundaries.
export const EXPAND_STEP = 40;

export interface HunkExpand {
  index: number;
  hidden: number;
  first: boolean;
  last: boolean;
}

// DOM row cap prevents pathological patches locking the browser.
export const MAX_RENDER_ROWS = 2000;

type Core = typeof import("@git-diff-view/core");

let library: Promise<Core> | null = null;
function loadCore(): Promise<Core> {
  library ??= import("@git-diff-view/core");
  return library;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function lineHtml(
  escapeHtml: (s: string) => string,
  value: unknown,
  diff:
    | {
        syntaxTemplate?: unknown;
        plainTemplate?: unknown;
      }
    | null
    | undefined,
  syntaxTemplate: unknown,
): string {
  const raw = typeof value === "string" ? value.replace(/\n$/, "") : "";
  if (diff) {
    // Invariant: Word-diff templates are complete line HTML: syntax-coloured
    // when the language registered, plain otherwise. Both already escape their
    // text.
    if (typeof diff.syntaxTemplate === "string") return diff.syntaxTemplate;
    if (typeof diff.plainTemplate === "string") return diff.plainTemplate;
  }
  if (typeof syntaxTemplate === "string") return syntaxTemplate;
  return escapeHtml(raw);
}

function kindOf(diffType: unknown): ViewKind {
  return diffType === 1 ? "add" : diffType === 2 ? "del" : "ctx";
}

interface HunkEntry {
  text?: unknown;
  isFirst?: unknown;
  isLast?: unknown;
  unifiedInfo?: {
    startHiddenIndex?: unknown;
    endHiddenIndex?: unknown;
    plainText?: unknown;
  } | null;
  splitInfo?: {
    startHiddenIndex?: unknown;
    endHiddenIndex?: unknown;
    plainText?: unknown;
  } | null;
}

function hunkEntryAt(
  map: Record<string, unknown> | undefined,
  index: number,
): HunkEntry | null {
  const hunk = map?.[String(index)] as HunkEntry | undefined;
  return hunk && typeof hunk === "object" ? hunk : null;
}

// Display text for a hunk header: the library's updated range once partial
// expansion rewrites it (its computed ranges omit the closing "@@", so
// restore it), else the raw patch header.
function hunkHeaderText(entry: HunkEntry, fallback: string): string {
  const info = entry.unifiedInfo ?? entry.splitInfo;
  const plain =
    info && typeof info.plainText === "string" ? info.plainText : null;
  if (plain === null) return fallback;
  if (!plain) return "";
  return plain.endsWith("@@") ? plain : plain + " @@";
}

function hiddenOf(info: {
  startHiddenIndex?: unknown;
  endHiddenIndex?: unknown;
}): number {
  return typeof info.startHiddenIndex === "number" &&
    typeof info.endHiddenIndex === "number"
    ? Math.max(0, info.endHiddenIndex - info.startHiddenIndex)
    : 0;
}

// Gap info for one hunk, read off the library's hidden-block bookkeeping
// (each hunk's hidden block before it, plus a trailing dummy hunk past the
// last line when the file continues). Null when there is no gap — including
// before the full contents load, when the library tracks nothing.
function gapExpand(
  entry: HunkEntry,
  index: number,
  first: boolean,
): HunkExpand | null {
  const info = entry.unifiedInfo ?? entry.splitInfo;
  if (!info) return null;
  const hidden = hiddenOf(info);
  if (hidden <= 0) return null;
  return {
    index,
    hidden,
    first,
    last: entry.isLast === true,
  };
}

// Parses unified diff rows and headers; contents add context-gap state.
// Unparseable patches throw for the caller's plain-text fallback.
export function unifiedView(core: Core, file: DiffFileType): ViewLine[] {
  file.buildUnifiedDiffLines();
  const items = core.getUnifiedContentLine(file) as
    | DiffUnifiedContentLineItem[]
    | undefined;
  const bundle = file.getBundle() as unknown as {
    unifiedHunkLines?: Record<string, unknown>;
  };
  const live = isExpandEnabled(file);
  const rows: ViewLine[] = [];
  for (const item of items || []) {
    if (rows.length >= MAX_RENDER_ROWS) break;
    const entry = hunkEntryAt(bundle.unifiedHunkLines, item.index);
    const raw = typeof entry?.text === "string" ? entry.text : null;
    if (raw != null && entry) {
      const text = hunkHeaderText(entry, raw);
      if (text) {
        rows.push({
          kind: "hunk",
          oldNo: null,
          newNo: null,
          html: text,
          expand: live
            ? gapExpand(entry, item.index, entry.isFirst === true)
            : null,
        });
      }
    }
    const line = item.unifiedLine || {};
    const diff = line.diff as
      | { syntaxTemplate?: unknown; plainTemplate?: unknown; type?: unknown }
      | undefined;
    const kind = kindOf(diff?.type);
    const oldNo = num(line.oldLineNumber);
    const newNo = num(line.newLineNumber);
    const syntax =
      kind === "del"
        ? oldNo != null && file.getOldSyntaxLine(oldNo)?.template
        : newNo != null && file.getNewSyntaxLine(newNo)?.template;
    rows.push({
      kind,
      oldNo,
      newNo,
      html: lineHtml(core.escapeHtml, line.value, diff, syntax),
    });
    if (rows.length >= MAX_RENDER_ROWS) break;
  }
  appendTrailingGap(rows, file, "unified");
  return rows;
}

// Trailing end-of-file gap from the library's dummy last hunk (present
// only when the file continues past the last hunk — otherwise no row, no
// bar, nothing to explain).
function appendTrailingGap(
  rows: ViewLine[] | SplitRow[],
  file: DiffFileType,
  mode: "unified" | "split",
): void {
  if (rows.length >= MAX_RENDER_ROWS) return;
  if (!isExpandEnabled(file)) return;
  const len = mode === "split" ? file.splitLineLength : file.unifiedLineLength;
  const dummy =
    mode === "split"
      ? file.getSplitHunkLine(len)
      : file.getUnifiedHunkLine(len);
  const info = dummy?.unifiedInfo ?? dummy?.splitInfo;
  if (!dummy || dummy.isLast !== true || !info) return;
  if (hiddenOf(info) <= 0) return;
  const expand: HunkExpand = {
    index: len,
    hidden: hiddenOf(info),
    first: false,
    last: true,
  };
  if (mode === "split")
    (rows as SplitRow[]).push({ hunk: null, left: null, right: null, expand });
  else
    (rows as ViewLine[]).push({
      kind: "hunk",
      oldNo: null,
      newNo: null,
      html: "",
      expand,
    });
}

// Parse one file's unified diff into side-by-side rows. A pure addition or
// deletion yields a row with one null side; context and paired changes yield
// both. Hunk headers attach to the first row of their section, carrying the
// same collapsible gap info as unified rows.
export function splitView(core: Core, file: DiffFileType): SplitRow[] {
  file.buildSplitDiffLines();
  const items = core.getSplitContentLines(file) as
    | DiffSplitContentLineItem[]
    | undefined;
  const bundle = file.getBundle() as unknown as {
    splitHunkLines?: Record<string, unknown>;
  };
  const live = isExpandEnabled(file);
  const rows: SplitRow[] = [];
  for (const item of items || []) {
    if (rows.length >= MAX_RENDER_ROWS) break;
    // Invariant: A column's number belongs to its own side: the left column's
    // number is old-side, the right's new-side. Old-side comment anchors read
    // oldNo; display and new-side anchors read newNo.
    const side = (entry: unknown, old: boolean): ViewLine | null => {
      const s = entry as {
        lineNumber?: unknown;
        value?: unknown;
        diff?: {
          syntaxTemplate?: unknown;
          plainTemplate?: unknown;
          type?: unknown;
        };
      } | null;
      if (!s || typeof s.value !== "string") return null;
      const no = num(s.lineNumber);
      return {
        kind: kindOf(s.diff?.type),
        oldNo: old ? no : null,
        newNo: old ? null : no,
        html: lineHtml(
          core.escapeHtml,
          s.value,
          s.diff,
          no != null &&
            (old
              ? file.getOldSyntaxLine(no)?.template
              : file.getNewSyntaxLine(no)?.template),
        ),
      };
    };
    const entry = hunkEntryAt(bundle.splitHunkLines, item.index);
    const raw = typeof entry?.text === "string" ? entry.text : null;
    let hunk: string | null = null;
    let expand: HunkExpand | null = null;
    if (raw != null && entry) {
      const text = hunkHeaderText(entry, raw);
      if (text) {
        hunk = text;
        if (live) expand = gapExpand(entry, item.index, entry.isFirst === true);
      }
    }
    const left = side(item.splitLine?.left, true);
    const right = side(item.splitLine?.right, false);
    // Invariant: The library attaches the hunk header to its first content row;
    // keep them as two rows — a header-only row carrying the gap state, then
    // the content row — or the first line of every hunk never renders.
    if (hunk != null && (left != null || right != null)) {
      rows.push({ hunk, left: null, right: null, expand });
      rows.push({ hunk: null, left, right, expand: null });
    } else rows.push({ hunk, left, right, expand });
  }
  appendTrailingGap(rows, file, "split");
  return rows;
}

export interface FileContents {
  oldContent: string;
  newContent: string;
}

// Retains per-file expansion state; full contents enable context expansion.
// Empty sides paint patch hunks only; invalid patches return null.
export function buildDiffFile(
  core: Core,
  patch: string,
  path: string,
  contents?: FileContents | null,
): DiffFileType | null {
  if (!patch || !/^@@ /m.test(patch)) return null;
  try {
    const lang = core.getLang(path || "txt");
    const file = new core.DiffFile(
      path,
      contents?.oldContent ?? "",
      path,
      contents?.newContent ?? "",
      [patch],
      lang,
      lang,
    );
    file.initTheme("dark");
    file.initRaw();
    if (contents) file.initSyntax();
    else {
      const starts = [
        ...patch.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm),
      ];
      file.initSyntax({
        registerHighlighter: {
          name:
            "patch-hunks:" +
            starts.map((match) => match[1] + "/" + match[2]).join(","),
          type: core.highlighter.type,
          maxLineToIgnoreSyntax: core.highlighter.maxLineToIgnoreSyntax,
          setMaxLineToIgnoreSyntax: core.highlighter.setMaxLineToIgnoreSyntax,
          ignoreSyntaxHighlightList: core.highlighter.ignoreSyntaxHighlightList,
          setIgnoreSyntaxHighlightList:
            core.highlighter.setIgnoreSyntaxHighlightList,
          getAST(raw, name, language, theme) {
            const side = raw === file._oldFileContent ? 1 : 2;
            const lines = raw.split("\n");
            const boundaries = [
              0,
              ...starts.map((match) => Math.max(0, Number(match[side]) - 1)),
              lines.length,
            ];
            const ast: ReturnType<Core["highlighter"]["getAST"]> = {
              type: "root",
              children: [],
            };
            for (let i = 0; i < boundaries.length - 1; i++) {
              const start = boundaries[i];
              const end = boundaries[i + 1];
              if (end <= start) continue;
              const chunk =
                lines.slice(start, end).join("\n") +
                (end < lines.length ? "\n" : "");
              const part = core.highlighter.getAST(
                chunk,
                name,
                language,
                theme,
              );
              if (!part) return part;
              ast.children.push(...part.children);
            }
            return ast;
          },
          processAST: core.highlighter.processAST,
          hasRegisteredCurrentLang: () => true,
        },
      });
    }
    return file;
  } catch {
    return null;
  }
}

export function isExpandEnabled(file: DiffFileType): boolean {
  try {
    return file.getExpandEnabled();
  } catch {
    return false;
  }
}

export type ExpandDir = "up" | "down" | "all";

// Expands one gap; indices come from current rows and change after steps.
// Up/down reveal a library step, all the whole gap; full contents required.
export function expandHunk(
  file: DiffFileType,
  mode: "unified" | "split",
  dir: ExpandDir,
  index: number,
): void {
  if (index < 0 || !isExpandEnabled(file)) return;
  try {
    if (mode === "split") file.onSplitHunkExpand(dir, index);
    else file.onUnifiedHunkExpand(dir, index);
  } catch {
    // Invariant: A stale index after concurrent collapse: rows re-derive
    // unchanged.
  }
}

// Whole-file expansion for the pane's Expand all / Collapse all toggle.
export function expandAll(file: DiffFileType, mode: "unified" | "split"): void {
  if (!isExpandEnabled(file)) return;
  try {
    file.onAllExpand(mode);
  } catch {
    // Invariant: Same stale-state tolerance as expandHunk.
  }
}

export function collapseAll(
  file: DiffFileType,
  mode: "unified" | "split",
): void {
  if (!isExpandEnabled(file)) return;
  try {
    file.onAllCollapse(mode);
  } catch {
    // Invariant: Same stale-state tolerance as expandHunk.
  }
}

// Render one file's patch in `mode`, loading the diff library on first use.
// Resolves to null when the patch is not a renderable diff (binary, empty,
// or unparsable) so the caller can show a plain note instead.
export async function renderPatch(
  patch: string,
  path: string,
  mode: "unified" | "split",
  contents?: FileContents | null,
): Promise<ViewLine[] | SplitRow[] | null> {
  try {
    const core = await loadCore();
    const file = buildDiffFile(core, patch, path, contents);
    if (!file) return null;
    const rows =
      mode === "split" ? splitView(core, file) : unifiedView(core, file);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

// The new-side line a comment anchors to, or null when the row is not
// commentable. Removed lines are gone from the current file, hunk headers
// and placeholders are not lines at all, and split old-side lines mirror
// the removed rule.
export function commentLineFor(row: {
  kind: ViewKind;
  newNo: number | null;
}): number | null {
  if (row.kind !== "add" && row.kind !== "ctx") return null;
  return row.newNo;
}
