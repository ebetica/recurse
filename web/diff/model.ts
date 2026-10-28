// Pure helpers shared by the Changes pane and its DOM-free regressions.
import { normalizeSearchText, textRank, titleTokens } from "../fuzzy-match.js";

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

export function targetHeader(target: DiffTarget | null | undefined): string[] {
  if (!target) return ["Selected change target: current Changes view"];
  if (target.kind === "pr") {
    const number = target.number == null ? "unknown" : "#" + target.number;
    return [
      "Selected change target: GitHub pull request layer " + number,
      "PR: " + number + (target.url ? " (" + target.url + ")" : ""),
      "Head: " +
        (target.headRepo ? target.headRepo + ":" : "") +
        (target.headBranch || "unknown") +
        (target.headSha ? " @ " + target.headSha : ""),
      "Base: " +
        (target.baseRepo ? target.baseRepo + ":" : "") +
        (target.baseBranch || "unknown") +
        (target.baseSha ? " @ " + target.baseSha : ""),
      ...(target.range
        ? ["Diff: " + target.range + " (three-dot / merge-base)"]
        : []),
    ];
  }
  return [
    "Selected change target: current worktree",
    "Branch: " +
      (target.branch || "detached") +
      (target.headSha ? " @ " + target.headSha : ""),
    "Base: " +
      (target.baseBranch || "unknown") +
      (target.baseSha ? " @ " + target.baseSha : ""),
    ...(target.includesUncommitted
      ? ["This view also includes uncommitted changes."]
      : []),
  ];
}

export type CommentSide = "old" | "new";

// Keep the marker in every captured row identical to the unified diff view,
// including split-view rows that do not render a visible sign span.
export function diffContextMarker(kind: "add" | "del" | "ctx"): string {
  return kind === "add" ? "+" : kind === "del" ? "−" : " ";
}

export interface AnchoredComment {
  group: string;
  path: string;
  side: CommentSide;
  line: number;
  // Range end (new- or old-side number); null for a single line.
  endLine: number | null;
  text: string;
  // Exact visible diff rows and markers when the comment was written.
  context?: string[];
  target: DiffTarget;
}

// Storage key for one pending comment. Single lines and ranges are distinct
// keys, as are the two sides of the same number.
export function commentKey(
  group: string,
  path: string,
  side: CommentSide,
  line: number,
  endLine: number | null,
): string {
  return (
    group +
    "\n" +
    path +
    "\n" +
    side +
    "\n" +
    line +
    (endLine != null ? "-" + endLine : "")
  );
}

// Human location for the message posted to the agent: path:start-end plus
// the side, so a removed line's number is never mistaken for a current one.
// endLine equal to line (or null) reads as a single line.
export function commentLocation(
  path: string,
  side: CommentSide,
  line: number,
  endLine: number | null,
): string {
  const range =
    endLine != null && endLine !== line ? line + "-" + endLine : "" + line;
  return path + ":" + range + " (" + side + " side)";
}

export function commentMessage(comments: Iterable<AnchoredComment>): string {
  const targetKey = (c: AnchoredComment) => JSON.stringify(c.target);
  const cs = [...comments].sort(
    (a, b) =>
      targetKey(a).localeCompare(targetKey(b)) ||
      a.group.localeCompare(b.group) ||
      a.path.localeCompare(b.path) ||
      a.side.localeCompare(b.side) ||
      a.line - b.line ||
      (a.endLine ?? a.line) - (b.endLine ?? b.line),
  );
  if (!cs.length) return "";
  const out = ["Comments from user:"];
  let lastTarget = "";
  for (const c of cs) {
    const key = targetKey(c);
    if (key !== lastTarget) {
      if (lastTarget) out.push("");
      out.push(...targetHeader(c.target), "");
      lastTarget = key;
    }
    out.push(
      "> [" +
        c.group +
        "] " +
        commentLocation(c.path, c.side, c.line, c.endLine),
    );
    if (c.context?.length) {
      const rows =
        c.context.length > 20
          ? [
              ...c.context.slice(0, 10),
              "… " + (c.context.length - 15) + " more lines",
              ...c.context.slice(-5),
            ]
          : c.context;
      out.push("```diff", ...rows, "```");
    }
    out.push(c.text);
  }
  return out.join("\n").trim();
}

export function acknowledgeComments<T extends { text: string }>(
  live: Map<string, T>,
  submitted: Map<string, string>,
): void {
  for (const [key, text] of submitted)
    if (live.get(key)?.text === text) live.delete(key);
}

export function isCurrentGeneration(
  current: number,
  response: number,
): boolean {
  return current === response;
}

export interface ChangedFile {
  path: string;
  additions: number | null;
  deletions: number | null;
  status: string;
}

// Split the summary's file list into the two displayed groups. `files`
// already ends with the untracked names, so `untracked` (the authoritative,
// longer-capped list) only contributes names `files` does not carry — the
// pane never shows the same path twice.
export function buildFileRows(
  files: ChangedFile[],
  untracked: string[],
): { changed: ChangedFile[]; untracked: string[] } {
  const changed = files.filter((f) => f.status !== "untracked");
  const seen = new Set(files.map((f) => f.path));
  return {
    changed,
    // Invariant: Untracked names ride along at the end of `files` too; they
    // belong to this group, with `untracked` contributing only longer-capped
    // extras.
    untracked: [
      ...files.filter((f) => f.status === "untracked").map((f) => f.path),
      ...untracked.filter((p) => !seen.has(p)),
    ],
  };
}

export interface BaseCandidateLists {
  branches?: string[] | null;
  commits?: string[] | null;
  tags?: string[] | null;
}

export interface BaseCandidate {
  // The exact string sent as ?base=/PATCH base (a commit's short sha).
  value: string;
  kind: "branch" | "commit" | "tag" | "pr" | "worktree";
  // What the finder row shows; for commits the full "<sha> <subject>" line.
  label: string;
  repo?: string;
}

// Keep each repository contiguous after search ranking, preserving row order.
export function groupPrCandidates(
  candidates: BaseCandidate[],
): BaseCandidate[] {
  const groups = new Map<string, BaseCandidate[]>();
  for (const candidate of candidates.filter((c) => c.kind === "pr")) {
    const repo = candidate.repo || "";
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo)!.push(candidate);
  }
  return [
    ...candidates.filter((c) => c.kind === "worktree"),
    ...[...groups.values()].flat(),
    ...candidates.filter((c) => c.kind !== "pr" && c.kind !== "worktree"),
  ];
}

export const MAX_FINDER_RESULTS = 10;

export function flattenBaseCandidates(
  lists: BaseCandidateLists | null | undefined,
): BaseCandidate[] {
  if (!lists) return [];
  // Invariant: The endpoint never errors, but a non-list payload still resolves
  // — a truthy non-array field must not iterate into garbage candidates.
  const branches = Array.isArray(lists.branches) ? lists.branches : [];
  const commits = Array.isArray(lists.commits) ? lists.commits : [];
  const tags = Array.isArray(lists.tags) ? lists.tags : [];
  const out: BaseCandidate[] = [];
  for (const b of branches) {
    if (typeof b !== "string") continue;
    const name = b.trim();
    if (name) out.push({ value: name, kind: "branch", label: name });
  }
  for (const c of commits) {
    if (typeof c !== "string") continue;
    const line = c.trim();
    if (!line) continue;
    out.push({ value: line.split(/\s+/, 1)[0], kind: "commit", label: line });
  }
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const name = t.trim();
    if (name) out.push({ value: name, kind: "tag", label: name });
  }
  return out;
}

// Error copy for a rejected base change: the server's detail when it names
// one (422 carries "invalid base ref"), else the status. The pane shows
// the string inline and leaves the current base untouched.
export async function baseErrorText(
  r: Pick<Response, "status" | "json">,
  value: string,
): Promise<string> {
  let detail = "";
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === "string" && body.detail) detail = body.detail;
  } catch {
    detail = "";
  }
  const what = value ? `"${value}"` : "an empty base";
  if (r.status === 422)
    return `${what} isn't a usable base ref${detail ? ": " + detail : "."}`;
  return `Couldn't change the base${detail ? ": " + detail : " (HTTP " + r.status + ")."}`;
}

// Filter-as-you-type over labels. An empty query returns the head of the
// list (branches first) so the finder opens pre-populated.
export function filterBaseCandidates(
  cands: BaseCandidate[],
  query: string,
): BaseCandidate[] {
  const q = normalizeSearchText(query);
  if (!q) return cands.slice(0, MAX_FINDER_RESULTS);
  return cands
    .map((candidate) => {
      const title = normalizeSearchText(
        (candidate.repo || "") + " " + candidate.label,
      );
      return {
        candidate,
        rank: textRank(
          {
            normalizedTitle: title,
            normalizedId: normalizeSearchText(candidate.value),
            tokens: titleTokens(title),
          },
          q,
        ),
      };
    })
    .filter((row) => row.rank !== null)
    .sort(
      (a, b) => a.rank!.tier - b.rank!.tier || a.rank!.score - b.rank!.score,
    )
    .slice(0, MAX_FINDER_RESULTS)
    .map((row) => row.candidate);
}

// Wrap-around arrow-key navigation over the filtered rows. A negative
// current means nothing highlighted yet: down lands on the first row.
export function moveFinderIndex(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

// Shorten a workdir for the pane head: $HOME becomes ~. The full path stays
// in the element's title attribute.
export function shortCwd(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const home =
    typeof process !== "undefined" ? process.env?.["HOME"] : undefined;
  if (home && (cwd === home || cwd.startsWith(home + "/")))
    return "~" + cwd.slice(home.length);
  return cwd;
}
