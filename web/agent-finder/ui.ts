// One agent finder, two entry modes, and one cache/listbox/result projection:
//   • mention mode follows an active @ token and inserts title + immutable id;
//   • navigate mode is opened by Normal-mode `f`, then opens the chosen agent.
// Neither mode fetches per key, sends, wakes, or otherwise routes to a result.
import { inputEl } from "../dom.js";
import { sharedTrees } from "../shared-trees.js";
import { DRAFT, state } from "../state.js";
import { requestKeyboardMode } from "../modal-mode.js";
import type { TreeNode } from "../types.js";
import {
  findBackend,
  parseConversationId,
  type Backend,
} from "../backends/backend.js";
import { treeOf } from "../backends/tree.js";
import {
  AGENT_MENTION_LIMIT,
  AgentMentionCache,
  activeAgentMentionToken,
  agentFinderAnchor,
  agentFinderKeyAction,
  agentFinderResultIsCurrent,
  insertAgentMention,
  type AgentFinderMode,
  type AgentMentionResult,
  type MentionGroup,
  type MentionNode,
} from "../agent-finder.js";
import {
  composerAutocompleteIs,
  hideComposerAutocomplete,
  showComposerAutocomplete,
  updateComposerAutocomplete,
} from "../composer/autocomplete.js";
import { finderResultLabel } from "../agent-finder.js";
import { api, jpost } from "../api.js";
import {
  archiveSearchPath,
  reviveFailure,
  reviveResult,
  type ArchivePage,
  type ArchivedAgentRow,
} from "./revive.js";

const LIST_ID = "agent-menu";
const shellFinderEl = document.querySelector<HTMLElement>("#agent-finder");
const shellMenuEl = document.querySelector<HTMLElement>(`#${LIST_ID}`);
const shellQueryEl = document.querySelector<HTMLInputElement>(
  "#agent-finder-query",
);
const shellStatusEl = document.querySelector<HTMLElement>(
  "#agent-finder-status",
);
// Mixed-generation shells keep optional finder chrome inert until reload.
const finderReady = !!(
  shellFinderEl &&
  shellMenuEl &&
  shellQueryEl &&
  shellStatusEl
);
const finderEl = shellFinderEl ?? document.createElement("div");
const menuEl = shellMenuEl ?? document.createElement("div");
const queryEl = shellQueryEl ?? document.createElement("input");
const statusEl = shellStatusEl ?? document.createElement("div");
const queryPlaceholder = queryEl.placeholder;
const cache = new AgentMentionCache();
// Latest snapshots by label (home: ""); replacing a backend drops its agents.
const slices = new Map<string, { backend?: Backend; nodes: TreeNode[] }>();
let mode: AgentFinderMode | null = null;
let matches: AgentMentionResult[] = [];
let active = 0;
let composing = false;
let menuPointerDown = false;
let focusOrigin: HTMLElement | null = null;
let navigate: (id: string) => boolean = () => false;
// Revive mode: the server's best page for the query; the latest query wins.
let archived: ArchivedAgentRow[] = [];
let archiveSeq = 0;
let archiveTimer = 0;
let reviving = false;
let onRevived: (result: RevivedAgent) => void = () => undefined;

export interface RevivedAgent {
  id: string;
  title: string | null;
  notes: string[];
}

const REVIVE_LABELS: Record<MentionGroup, string> = {
  related: "Top-level agents",
  siblings: "",
  other: "Subagents",
};
const GROUP_LABELS: Record<MentionGroup, string> = {
  related: "Subagents and parents",
  siblings: "Siblings",
  other: "Other agents",
};

export function configureAgentFinderNavigation(
  open: (id: string) => boolean,
): void {
  navigate = open;
}

function anchor() {
  return agentFinderAnchor(
    state.selectedId,
    state.selectedId === DRAFT ? state.draft?.parent : undefined,
  );
}

function currentQuery(): string | null {
  if (mode === "navigate" || mode === "revive") return queryEl.value;
  if (mode !== "mention") return null;
  return (
    activeAgentMentionToken(
      inputEl.value,
      inputEl.selectionStart,
      inputEl.selectionEnd,
      composing,
    )?.query ?? null
  );
}

function ownsKey(key: string, shiftKey: boolean): boolean {
  return (
    agentFinderKeyAction(mode, !!matches.length, key, shiftKey, composing) !==
    null
  );
}

export function closeAgentFinder(restoreFocus = true): boolean {
  const wasOpen = mode !== null;
  const wasMention = mode === "mention";
  const wasNavigate = mode === "navigate";
  mode = null;
  finderEl.classList.remove("on", "mention", "navigate", "revive");
  clearTimeout(archiveTimer);
  archiveSeq++;
  archived = [];
  menuEl.textContent = "";
  queryEl.hidden = true;
  statusEl.hidden = true;
  matches = [];
  active = 0;
  if (wasMention) hideComposerAutocomplete(LIST_ID);
  queryEl.setAttribute("aria-expanded", "false");
  queryEl.removeAttribute("aria-activedescendant");
  if (wasNavigate) requestKeyboardMode("normal");
  if (restoreFocus && focusOrigin?.isConnected) focusOrigin.focus();
  focusOrigin = null;
  return wasOpen;
}

// Compatibility name for the composer's top-layer clear path.
export function closeAgentAutocomplete(): boolean {
  return mode === "mention" && closeAgentFinder();
}

export function agentFinderOpen(): boolean {
  return mode !== null;
}
export function agentFinderMode(): AgentFinderMode | null {
  return mode;
}
export function agentAutocompleteOpen(): boolean {
  return mode === "mention" && composerAutocompleteIs(LIST_ID);
}
export function agentFinderOwnsKey(
  key: string,
  shiftKey: boolean,
  eventComposing = false,
): boolean {
  return (
    agentFinderOpen() &&
    agentFinderKeyAction(
      mode,
      !!matches.length,
      key,
      shiftKey,
      eventComposing || composing,
    ) !== null
  );
}
export function agentAutocompleteOwnsKey(
  key: string,
  shiftKey: boolean,
): boolean {
  return agentAutocompleteOpen() && ownsKey(key, shiftKey);
}

function publishActive(id?: string): void {
  if (mode === "mention") updateComposerAutocomplete(LIST_ID, id);
  else if (mode === "navigate" || mode === "revive") {
    if (id) queryEl.setAttribute("aria-activedescendant", id);
    else queryEl.removeAttribute("aria-activedescendant");
  }
}

function setActive(index: number): void {
  if (!matches.length) return;
  active = (index + matches.length) % matches.length;
  menuEl.querySelectorAll<HTMLElement>(".agent-option").forEach((row) => {
    const selected = Number(row.dataset.index) === active;
    row.classList.toggle("active", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) {
      publishActive(row.id);
      row.scrollIntoView({ block: "nearest" });
    }
  });
}

function choose(result: AgentMentionResult): void {
  if (mode === "revive") {
    const row = archived.find((item) => item.archive_id === result.id);
    if (row) void revive(row);
    return;
  }
  // Invariant: A deletion can land after pointerdown but before click/Enter.
  // Reconcile to the latest poll and leave the stale result inert in either
  // mode.
  if (!agentFinderResultIsCurrent(result.id, state.nodes, cache.index())) {
    refreshResults();
    return;
  }
  if (mode === "mention") {
    const token = activeAgentMentionToken(
      inputEl.value,
      inputEl.selectionStart,
      inputEl.selectionEnd,
      composing,
    );
    if (!token) {
      closeAgentFinder();
      return;
    }
    const insertion = insertAgentMention(
      inputEl.value,
      token,
      result.title,
      result.remote
        ? `${parseConversationId(result.id).cid}@${result.remote}`
        : result.id,
    );
    inputEl.value = insertion.value;
    inputEl.setSelectionRange(insertion.caret, insertion.caret);
    closeAgentFinder(false);
    inputEl.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
        data: null,
      }),
    );
    inputEl.focus();
    return;
  }
  if (mode === "navigate" && navigate(result.id)) {
    closeAgentFinder(false);
    queryEl.blur();
  }
}

function option(result: AgentMentionResult, index: number): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.id = `agent-option-${index}`;
  row.className = `menu-item agent-option${index === active ? " active" : ""}`;
  row.dataset.index = String(index);
  row.tabIndex = -1;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", index === active ? "true" : "false");

  const head = document.createElement("span");
  head.className = "agent-option-head";
  const name = document.createElement("span");
  name.className = "agent-option-name";
  name.textContent = result.title;
  head.appendChild(name);
  const relation = document.createElement("span");
  relation.className = "agent-option-relation";
  relation.textContent = finderResultLabel(result);
  head.appendChild(relation);

  const hint = document.createElement("span");
  hint.className = "agent-option-path";
  hint.textContent = result.path;
  row.append(head, hint);
  return row;
}

function renderResults(next: AgentMentionResult[], preferredId?: string): void {
  matches = next;
  const preferred = preferredId
    ? matches.findIndex((match) => match.id === preferredId)
    : -1;
  active = preferred >= 0 ? preferred : 0;
  menuEl.textContent = "";
  statusEl.hidden = !!matches.length;
  statusEl.textContent = matches.length
    ? ""
    : mode === "revive"
      ? "No matching archived agents"
      : "No matching agents";
  if (!matches.length) {
    publishActive();
    return;
  }

  let offset = 0;
  for (const group of ["related", "siblings", "other"] as MentionGroup[]) {
    const groupMatches = matches.filter((match) => match.group === group);
    if (!groupMatches.length) continue;
    const section = document.createElement("div");
    section.className = "agent-option-group";
    section.setAttribute("role", "group");
    const label = document.createElement("div");
    label.id = `agent-group-${group}`;
    label.className = "menu-label agent-option-group-label";
    label.textContent = (mode === "revive" ? REVIVE_LABELS : GROUP_LABELS)[
      group
    ];
    section.setAttribute("aria-labelledby", label.id);
    section.appendChild(label);
    for (const result of groupMatches)
      section.appendChild(option(result, offset++));
    menuEl.appendChild(section);
  }
  publishActive(`agent-option-${active}`);
}

/** Fetch the best page of archived agents for the current query. */
async function searchArchive(): Promise<void> {
  const seq = ++archiveSeq;
  if (!archived.length) {
    statusEl.hidden = false;
    statusEl.textContent = "Searching the archive…";
  }
  const page = await api(archiveSearchPath(queryEl.value))
    .then((r) => (r.ok ? (r.json() as Promise<ArchivePage>) : null))
    .catch(() => null);
  if (seq !== archiveSeq || mode !== "revive") return;
  if (page === null) {
    statusEl.hidden = false;
    statusEl.textContent = "Could not read the archive";
    return;
  }
  archived = page.agents;
  const now = Date.now() / 1000;
  renderResults(archived.map((row) => reviveResult(row, now)));
}

async function revive(row: ArchivedAgentRow): Promise<void> {
  if (reviving) return;
  reviving = true;
  statusEl.hidden = false;
  statusEl.textContent = `Reviving ${reviveResult(row, 0).title}…`;
  try {
    const response = await jpost(
      "/api/agent-archive/revive",
      { target: row.archive_id, parent: null },
      { availability: "core", timeoutMs: 0 },
    );
    const body = (await response.json().catch(() => null)) as
      | (RevivedAgent & { detail?: unknown })
      | null;
    if (!response.ok || !body) {
      statusEl.textContent = reviveFailure(body);
      return;
    }
    closeAgentFinder();
    onRevived({ id: body.id, title: body.title, notes: body.notes ?? [] });
  } catch {
    statusEl.textContent = "Revive status unknown; check the agent list";
  } finally {
    reviving = false;
  }
}

function refreshResults(preserveActive = false): void {
  if (mode === "revive") {
    clearTimeout(archiveTimer);
    archiveTimer = window.setTimeout(() => void searchArchive(), 150);
    return;
  }
  const query = currentQuery();
  const index = cache.index();
  if (!index && mode === "navigate") {
    matches = [];
    menuEl.textContent = "";
    statusEl.hidden = false;
    statusEl.textContent = "Loading agents…";
    return;
  }
  if (query == null || !index) {
    if (mode === "mention") closeAgentFinder(false);
    return;
  }
  const preferredId = preserveActive ? matches[active]?.id : undefined;
  renderResults(
    index.search(anchor(), query, AGENT_MENTION_LIMIT),
    preferredId,
  );
}

function open(nextMode: AgentFinderMode): void {
  if (!finderReady) return;
  if (mode && mode !== nextMode) closeAgentFinder(false);
  mode = nextMode;
  finderEl.classList.add("on", nextMode);
  finderEl.classList.toggle("mention", nextMode === "mention");
  finderEl.classList.toggle("navigate", nextMode === "navigate");
  finderEl.classList.toggle("revive", nextMode === "revive");
  statusEl.hidden = true;
  if (nextMode === "mention") {
    queryEl.hidden = true;
    showComposerAutocomplete(
      LIST_ID,
      () => {
        closeAgentFinder();
      },
      ownsKey,
    );
  } else {
    focusOrigin =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    queryEl.hidden = false;
    queryEl.setAttribute("aria-expanded", "true");
    queryEl.value = "";
  }
  if (nextMode === "revive") {
    queryEl.placeholder = "Revive an archived agent…";
    void searchArchive();
  } else {
    queryEl.placeholder = queryPlaceholder;
    refreshResults();
  }
  if (nextMode !== "mention") queryEl.focus();
}

/**
 * /revive: search every archived agent; choosing one revives it top level
 * and hands the result to `done` (the composer selects it once listed).
 */
export function openAgentFinderRevive(
  done: (result: RevivedAgent) => void,
): boolean {
  if (!finderReady) return false;
  if (sharedTrees !== null) return false;
  onRevived = done;
  open("revive");
  return true;
}

/** Open an agent the way a navigate-mode choice does. */
export function openFoundAgent(id: string): boolean {
  return navigate(id);
}

export function refreshAgentAutocomplete(): void {
  if (!finderReady || mode === "navigate" || mode === "revive") return;
  const token = activeAgentMentionToken(
    inputEl.value,
    inputEl.selectionStart,
    inputEl.selectionEnd,
    composing,
  );
  if (!token || !cache.index()) {
    if (mode === "mention") closeAgentFinder(false);
    return;
  }
  if (mode !== "mention") open("mention");
  else refreshResults();
}

export function openAgentFinderNavigate(): boolean {
  if (!finderReady) return false;
  requestKeyboardMode("finder");
  open("navigate");
  return true;
}

// Each backend's committed tree (or status change, without nodes) refreshes
// its slice of the shared cached snapshot. Build atomically only when
// metadata/revision/source changed.
export function refreshAgentMentionCache(
  label: string,
  nodes?: TreeNode[],
): void {
  if (nodes) slices.set(label, { backend: findBackend(label), nodes });
  const previous = cache.index();
  const all: MentionNode[] = [];
  for (const [sliceLabel, slice] of slices) {
    if (!sliceLabel) {
      all.push(...slice.nodes);
      continue;
    }
    const backend = findBackend(sliceLabel);
    if (!backend || backend !== slice.backend) {
      slices.delete(sliceLabel);
      continue;
    }
    const offline = treeOf(backend).status !== "connected";
    for (const node of slice.nodes)
      all.push({ ...node, remote: sliceLabel, offline });
  }
  const current = cache.refresh(location.origin, all);
  if (agentFinderOpen() && mode !== "revive" && current !== previous)
    refreshResults(true);
  // Invariant: A fast user can type @ before the boot tree request settles. The
  // poll itself should open the now-ready picker; requiring one more keystroke
  // would make the first trigger appear broken.
  else if (!agentFinderOpen() && document.activeElement === inputEl)
    refreshAgentAutocomplete();
}

export function clearAgentMentionCache(): void {
  slices.clear();
  cache.clear();
  closeAgentFinder(false);
}

function handleFinderKey(event: KeyboardEvent): void {
  const action = agentFinderKeyAction(
    mode,
    !!matches.length,
    event.key,
    event.shiftKey,
    event.isComposing || event.keyCode === 229 || composing,
  );
  if (!action) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === "close") closeAgentFinder();
  else if (action === "next") setActive(active + 1);
  else if (action === "previous") setActive(active - 1);
  else if (action === "choose" && matches[active]) choose(matches[active]);
}

menuEl.addEventListener("pointerdown", (event: PointerEvent) => {
  menuPointerDown = true;
  if (
    event.pointerType === "mouse" &&
    (event.target as Element).closest(".agent-option")
  )
    event.preventDefault();
});
menuEl.addEventListener("pointerup", () => {
  setTimeout(() => {
    menuPointerDown = false;
  }, 0);
});
menuEl.addEventListener("pointercancel", () => {
  menuPointerDown = false;
});
menuEl.addEventListener("click", (event: MouseEvent) => {
  const row = (event.target as Element).closest<HTMLButtonElement>(
    ".agent-option",
  );
  const index = Number(row?.dataset.index);
  if (row && Number.isInteger(index) && matches[index]) choose(matches[index]);
});
menuEl.addEventListener("pointermove", (event: PointerEvent) => {
  if (event.pointerType !== "mouse") return;
  const row = (event.target as Element).closest<HTMLButtonElement>(
    ".agent-option",
  );
  const index = Number(row?.dataset.index);
  if (row && Number.isInteger(index)) setActive(index);
});

inputEl.addEventListener("keydown", handleFinderKey);
queryEl.addEventListener("keydown", handleFinderKey);
queryEl.addEventListener("input", () => refreshResults());
queryEl.addEventListener("blur", () =>
  setTimeout(() => {
    if (
      (mode === "navigate" || mode === "revive") &&
      !menuPointerDown &&
      !reviving
    )
      closeAgentFinder(false);
  }, 0),
);
for (const element of [inputEl, queryEl]) {
  element.addEventListener("compositionstart", () => {
    composing = true;
    if (mode === "mention") closeAgentFinder(false);
  });
  element.addEventListener("compositionend", () => {
    composing = false;
    if (element === inputEl) refreshAgentAutocomplete();
    else refreshResults();
  });
}
inputEl.addEventListener("input", refreshAgentAutocomplete);
inputEl.addEventListener("focus", refreshAgentAutocomplete);
inputEl.addEventListener("click", refreshAgentAutocomplete);
inputEl.addEventListener("keyup", (event: KeyboardEvent) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
    refreshAgentAutocomplete();
});
inputEl.addEventListener("blur", () =>
  setTimeout(() => {
    if (mode === "mention" && !menuPointerDown) closeAgentFinder(false);
  }, 0),
);
document.addEventListener("pointerdown", (event: PointerEvent) => {
  const target = event.target as Node;
  if (target !== inputEl && !finderEl.contains(target)) closeAgentFinder(false);
});
