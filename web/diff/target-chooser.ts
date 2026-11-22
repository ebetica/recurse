// Owns the Changes comparison chooser, its focusable controls and base requests.
import { backendFor } from "../backends/index.js";
import { confirmDiscard } from "../comments.js";
import { el } from "../dom.js";
import { normalizeSearchText, textRank, titleTokens } from "../fuzzy-match.js";
import { pendingCount } from "./comments.js";
import {
  baseName,
  prLabel,
  type CurrentPr,
  type DiffSummary,
} from "./model.js";

interface BaseCandidateLists {
  branches?: string[] | null;
  commits?: string[] | null;
  tags?: string[] | null;
}

interface BaseCandidate {
  // The exact string sent as ?base=/PATCH base (a commit's short sha).
  value: string;
  kind: "branch" | "commit" | "tag" | "pr" | "worktree" | "default";
  // What the finder row shows; for commits the full "<sha> <subject>" line.
  label: string;
  repo?: string;
}

// Keep each repository contiguous after search ranking, preserving row order.
function groupPrCandidates(candidates: BaseCandidate[]): BaseCandidate[] {
  const groups = new Map<string, BaseCandidate[]>();
  for (const candidate of candidates.filter((c) => c.kind === "pr")) {
    const repo = candidate.repo || "";
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo)!.push(candidate);
  }
  return [
    ...candidates.filter((c) => c.kind === "default"),
    ...candidates.filter(
      (c) => c.kind !== "pr" && c.kind !== "worktree" && c.kind !== "default",
    ),
    ...candidates.filter((c) => c.kind === "worktree"),
    ...[...groups.values()].flat(),
  ];
}

const MAX_FINDER_RESULTS = 10;

function flattenBaseCandidates(
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
async function baseErrorText(
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
  if (r.status === 422) return `"${value}" isn't a branch, tag or commit.`;
  return `Couldn't change the comparison${detail ? ": " + detail : " (HTTP " + r.status + ")."}`;
}

// Filter-as-you-type over labels. An empty query returns the head of the
// list (branches first) so the finder opens pre-populated.
function filterBaseCandidates(
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
function moveFinderIndex(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

// What the worktree diff compares with, in words: "Changes since main".
function comparisonText(s: DiffSummary): string {
  if (s.selectedWork) {
    const { ref, stop } = s.selectedWork;
    return stop
      ? baseName(ref) + " since " + baseName(stop)
      : "Changes in " + baseName(ref);
  }
  if (s.base === "HEAD") return "Uncommitted changes";
  return s.base ? "Changes since " + baseName(s.base) : "Changes";
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

function showBaseError(ed: BaseEditor, message: string): void {
  ed.error.textContent = message;
  ed.error.style.display = message ? "block" : "none";
}

interface TargetChooserActions {
  summary(id: string): DiffSummary | null;
  prs(id: string): readonly CurrentPr[];
  selectedPr(id: string): CurrentPr | null;
  choose(id: string, pr: CurrentPr | null): void;
  applied(id: string): void;
  settled(id: string): void;
  loadPrs(id: string): void;
  focus(input: HTMLInputElement): void;
}

export function createTargetChooser(actions: TargetChooserActions) {
  function chooseCandidate(id: string, candidate: BaseCandidate): void {
    if (candidate.kind === "pr" || candidate.kind === "worktree")
      actions.choose(
        id,
        actions.prs(id).find((pr) => pr.url === candidate.value) || null,
      );
    else {
      baseEditorFor(id).input.value = candidate.value;
      void applyBase(id);
    }
  }

  const baseEditors = new Map<string, BaseEditor>();

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
            : "Show the changes of";
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
      const kind = el("span", "diff-base-kind", c.value ? c.kind : "");
      const label = el("span", "diff-base-label-text", c.label);
      label.title = c.label;
      if (c.kind !== "pr") item.append(kind);
      item.append(label);
      item.onclick = () => chooseCandidate(agentId, c);
      ed.finder.append(item);
    });
    ed.input.setAttribute(
      "aria-activedescendant",
      ed.active >= 0 && show
        ? "diff-base-opt-" + agentId + "-" + ed.active
        : "",
    );
    if (ed.active >= 0)
      document
        .getElementById("diff-base-opt-" + agentId + "-" + ed.active)
        ?.scrollIntoView({ block: "nearest" });
  }

  function refilterFinder(agentId: string): void {
    const ed = baseEditors.get(agentId);
    if (!ed) return;
    const targets: BaseCandidate[] = [
      { kind: "worktree", value: "", label: "Working directory" },
      ...actions.prs(agentId).map((pr) => ({
        kind: "pr" as const,
        value: pr.url,
        repo: pr.url.split("/").slice(3, 5).join("/"),
        label:
          prLabel(pr, { titleSuffix: " · " + pr.title, showStatus: true }) +
          (pr.agent ? " · " + (pr.agent.title || pr.agent.id) : ""),
      })),
    ];
    const s = actions.summary(agentId);
    const bases = [...(ed.candidates || [])];
    if (!actions.selectedPr(agentId) && s?.baseSource?.startsWith("override:"))
      bases.unshift({
        kind: "default",
        value: "",
        label: s.defaultBase
          ? "Changes since " + baseName(s.defaultBase) + " (default)"
          : "Changes on this branch (default)",
      });
    const query = ed.dirty ? ed.input.value : "";
    ed.filtered = groupPrCandidates([
      ...filterBaseCandidates(targets, query).slice(0, 5),
      ...filterBaseCandidates(bases, query).slice(0, 5),
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
      .then(async (r) =>
        r.ok ? ((await r.json()) as BaseCandidateLists) : null,
      )
      .catch(() => null)
      .then((lists) => {
        ed.candidates = flattenBaseCandidates(lists);
        ed.loadingCandidates = false;
        if (ed.open) refilterFinder(agentId);
      });
  }

  function openBaseEditor(agentId: string): void {
    const ed = baseEditors.get(agentId);
    if (!ed || ed.open || ed.busy) return;
    ed.open = true;
    ed.dirty = false;
    ed.input.value = actions.summary(agentId)?.base || "";
    showBaseError(ed, "");
    ed.root.classList.add("open");
    ed.labelBtn.style.display = "none";
    ed.form.style.display = "block";
    loadBaseCandidates(agentId);
    actions.loadPrs(agentId);
    refilterFinder(agentId);
    actions.focus(ed.input);
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
    const pr = actions.selectedPr(agentId);
    ed.root.style.flex = pr ? "1" : "";
    const prs = actions.prs(agentId);
    ed.labelText.textContent = pr
      ? "PR " +
        prLabel(pr, { titleSuffix: pr.title ? " · " + pr.title : "" }) +
        (pr.baseRefName ? " · into " + pr.baseRefName : "")
      : comparisonText(s) +
        (prs.length
          ? " · " + prs.length + (prs.length === 1 ? " PR" : " PRs")
          : "");
    ed.labelBtn.setAttribute(
      "aria-label",
      ed.labelText.textContent + " — choose what to compare",
    );
    ed.labelBtn.title = pr
      ? "Choose what to compare"
      : s.selectedWork
        ? s.selectedWork.stop
          ? "Commits after " +
            baseName(s.selectedWork.stop) +
            " up to " +
            baseName(s.selectedWork.ref) +
            " (" +
            s.selectedWork.commits +
            (s.selectedWork.commits === 1 ? " commit)." : " commits).")
          : "The changes made by commit " +
            s.selectedWork.headSha.slice(0, 7) +
            "."
        : s.base === "HEAD" || !s.base || !s.baseSha
          ? "Includes uncommitted changes."
          : "Compared with commit " +
            s.baseSha.slice(0, 7) +
            (s.baseSha.startsWith(s.base.toLowerCase())
              ? ""
              : ", where this branch meets " + baseName(s.base)) +
            ". Includes uncommitted changes.";
  }

  // Enter/Apply previews the typed ref via ?base=, then persists it via PATCH.
  // Either request failing shows the server error inline and leaves the pane
  // (and its pending comments) untouched. An empty box clears the override.
  async function applyBase(agentId: string): Promise<void> {
    const ed = baseEditors.get(agentId);
    if (!ed || !ed.open || ed.busy) return;
    const value = ed.input.value.trim();
    const count = pendingCount(agentId);
    if (actions.selectedPr(agentId) && count && !confirmDiscard(count)) return;
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
        const { baseSource } = (await preview.json()) as DiffSummary;
        if (baseSource && baseSource !== "override:" + value)
          return showBaseError(
            ed,
            `No branch, tag or commit named "${value}".`,
          );
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
      actions.applied(agentId);
    } catch {
      showBaseError(
        ed,
        "Couldn't reach the server. The current base is unchanged.",
      );
    } finally {
      ed.busy = false;
      ed.applyBtn.disabled = false;
      ed.applyBtn.textContent = "Apply";
      renderFinder(agentId);
      actions.settled(agentId);
    }
  }

  function baseEditorFor(agentId: string): BaseEditor {
    const existing = baseEditors.get(agentId);
    if (existing) return existing;
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
    input.setAttribute("aria-label", "Show the changes of");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", "diff-base-finder-" + agentId);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.placeholder = "Branch, tag, commit or pull request";
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
    const ed: BaseEditor = {
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
    baseEditors.set(agentId, ed);
    const applyOrPick = () => {
      const pick = ed.active >= 0 ? ed.filtered[ed.active] : null;
      if (pick) chooseCandidate(agentId, pick);
      else void applyBase(agentId);
    };
    input.oninput = () => {
      ed.dirty = true;
      refilterFinder(agentId);
    };
    input.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (!ed.filtered.length) return;
        ev.preventDefault();
        ed.active = moveFinderIndex(
          ed.active,
          ev.key === "ArrowDown" ? 1 : -1,
          ed.filtered.length,
        );
        renderFinder(agentId);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        applyOrPick();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        // Invariant: A busy editor stays open: closing now would strand the
        // in-flight result as a silent no-op on a hidden form.
        if (!ed.busy) closeBaseEditor(agentId);
      }
    };
    applyBtn.onclick = applyOrPick;
    cancelBtn.onclick = () => {
      if (!ed.busy) closeBaseEditor(agentId);
    };
    return ed;
  }

  return {
    root: (id: string) => baseEditorFor(id).root,
    sync: refreshBaseEditor,
    open(id: string, { clear = false } = {}): void {
      openBaseEditor(id);
      if (!clear) return;
      const ed = baseEditorFor(id);
      ed.input.value = "";
      ed.dirty = true;
      refilterFinder(id);
      actions.focus(ed.input);
    },
    close: closeBaseEditor,
    busy: (id: string) => baseEditors.get(id)?.busy ?? false,
    prsChanged: refilterFinder,
    showError(id: string, message: string): void {
      const ed = baseEditors.get(id);
      if (ed?.open) showBaseError(ed, message);
    },
  };
}
