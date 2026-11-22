// Changes summaries, comparison targets and changed-file lists.

export interface DiffTarget {
  kind: "pr" | "worktree";
  id: string;
  number?: number | null;
  url?: string | null;
  title?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  headBranch?: string | null;
  baseRepo?: string | null;
  headRepo?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  range?: string | null;
  repoIdentity?: string | null;
  available?: boolean;
  includesUncommitted?: boolean;
}

export interface CurrentPr {
  baseRefName?: string;
  // When it was first linked, in epoch seconds.
  detected_at?: number;
  // The child conversation that linked it, in a parent's list.
  agent?: { id: string; title: string };
  state?: string | null;
  checks?: string | null;
  number: number;
  title: string;
  url: string;
}

export function prLabel(
  pr: CurrentPr,
  {
    titleSuffix = "",
    showStatus = false,
  }: { titleSuffix?: string; showStatus?: boolean } = {},
): string {
  return (
    "#" +
    pr.number +
    titleSuffix +
    (showStatus && pr.state ? " · " + pr.state.toLowerCase() : "") +
    (showStatus && pr.checks ? " · checks " + pr.checks : "")
  );
}

export interface DiffSummary {
  available?: boolean;
  // A pull request's description, with its diff.
  body?: string | null;
  reason?: string | null;
  base?: string | null;
  baseSha?: string | null;
  baseSource?: string | null;
  defaultBase?: string | null;
  selectedWork?: {
    ref: string;
    headSha: string;
    stop: string | null;
    commits: number;
  } | null;
  headSha?: string | null;
  branch?: string | null;
  cwd?: string | null;
  cwdSource?: string | null;
  stat?: string | null;
  truncated?: boolean;
  files?: ChangedFile[];
  moreFiles?: number;
  untracked?: string[];
  untrackedTruncated?: boolean;
  currentPr?: CurrentPr | null;
  version?: string | null;
  target?: DiffTarget;
}

export function targetFor(summary: DiffSummary): DiffTarget {
  return (
    summary.target ?? {
      kind: "worktree",
      id: "worktree",
      branch: summary.selectedWork?.ref || summary.branch || null,
      baseBranch: summary.selectedWork
        ? summary.selectedWork.stop || summary.baseSha || null
        : summary.base || null,
      baseSha: summary.baseSha || null,
      headSha: summary.headSha || null,
      includesUncommitted: !summary.selectedWork,
    }
  );
}

export type CommentSide = "old" | "new";

// Keep the marker in every captured row identical to the unified diff view,
// including split-view rows that do not render a visible sign span.
export function diffContextMarker(kind: "add" | "del" | "ctx"): string {
  return kind === "add" ? "+" : kind === "del" ? "−" : " ";
}

export interface ChangedFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  status: string;
}

// Split tracked files from legacy untracked rows and the bounded name list.
export function buildFileRows(
  files: ChangedFile[],
  untracked: string[],
): { changed: ChangedFile[]; untracked: string[] } {
  const changed = files.filter((f) => f.status !== "untracked");
  const seen = new Set(files.map((f) => f.path));
  return {
    changed,
    // Invariant: Older backends may also include untracked names in `files`.
    untracked: [
      ...files.filter((f) => f.status === "untracked").map((f) => f.path),
      ...untracked.filter((p) => !seen.has(p)),
    ],
  };
}

/** A base as the pane names it: "main" for origin/main, 7-digit commits. */
export function baseName(ref: string): string {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(ref)
    ? ref.slice(0, 7)
    : ref.replace(/^origin\//, "");
}
