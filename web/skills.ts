// Combines synchronous platform actions with Pi skill autocomplete. Actions
// never enter model prompts; skills insert canonical /skill:name.
// Real-conversation actions remain usable while registry discovery loads.

import { backendFor } from "./backends/backend.js";
import { $ } from "./dom.js";
import { DRAFT, state } from "./state.js";
import {
  PersistentSkillCache,
  SKILL_CACHE_KEY,
  SkillLoader,
} from "./skills/loader.js";
import { commandTokenToClear, skillMenuOwnsKey } from "./skills/keys.js";
import {
  type CommandContext,
  type ComposerCommand,
  matchingCommands,
} from "./composer/commands.js";
import {
  composerAutocompleteIs,
  hideComposerAutocomplete,
  showComposerAutocomplete,
  updateComposerAutocomplete,
} from "./composer/autocomplete.js";
import type { SkillChoice } from "./types.js";

interface SkillToken {
  start: number;
  end: number;
  query: string;
  canonicalSkill: boolean;
}
type MenuItem =
  | { kind: "command"; command: ComposerCommand }
  | { kind: "skill"; skill: SkillChoice };

const inputEl = $("#input") as HTMLTextAreaElement;
const skillMenuEl = $("#skill-menu")!;
const SKILL_MENU_ID = "skill-menu";
let menuItems: MenuItem[] = [];
let menuActive = 0;

let runCommand: ((name: string) => boolean) | null = null;
export function setComposerCommandRunner(fn: (name: string) => boolean): void {
  runCommand = fn;
}

interface SkillSource {
  agentId: string;
  context: string;
}
const contextOverrides = new Map<string, string>();

// A draft has no id yet, so ask its parent for the skill context.
function skillSource(): SkillSource | null {
  let agentId = state.selectedId;
  if (agentId === DRAFT) agentId = state.draft?.parent || "";
  const node = state.nodes[agentId];
  const context = node?.skill_context || contextOverrides.get(agentId);
  return context ? { agentId, context } : null;
}

// Which platform commands apply where the composer's "/" sits.
function commandContext(): CommandContext {
  const id = state.selectedId;
  if (!id || id === DRAFT) return { isDraft: true, hasParent: false };
  const node = state.nodes[id];
  return { isDraft: false, hasParent: !!node?.parent };
}

// Match at the caret (not merely at the end of the whole textarea), so the
// picker also works before text the user has already written.
function activeSkillToken(): SkillToken | null {
  if (inputEl.selectionStart !== inputEl.selectionEnd) return null;
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, caret);
  const match = before.match(/(^|\s)\/(?:skill:)?([A-Za-z0-9_.:-]*)$/i);
  if (!match) return null;
  const start = (match.index ?? 0) + match[1].length;
  // Invariant: Replace the whole token even when the caret sits in its middle.
  // Scanning again from the slash also includes a canonical `skill:` suffix to
  // the right of the caret (a tail-only name scan would strand `:name` in the
  // message).
  const whole =
    inputEl.value.slice(start).match(/^\/(?:skill:)?[A-Za-z0-9_.:-]*/i)?.[0] ||
    "/";
  // Invariant: Filter by the whole word, not only its left-of-caret fragment.
  // This makes inserting `/` immediately before an existing name (for example
  // `slack`) surface that skill at once as well as supporting ordinary forward
  // typing.
  const query = whole.replace(/^\/(?:skill:)?/i, "");
  return {
    start,
    end: start + whole.length,
    query,
    canonicalSkill: /^\/skill:/i.test(whole),
  };
}

export function skillAutocompleteOpen(): boolean {
  return (
    skillMenuEl.classList.contains("on") &&
    composerAutocompleteIs(SKILL_MENU_ID)
  );
}
export function skillAutocompleteOwnsKey(
  key: string,
  shiftKey: boolean,
): boolean {
  return skillMenuOwnsKey(
    skillAutocompleteOpen(),
    menuItems.length > 0,
    key,
    shiftKey,
  );
}

export function closeSkillAutocomplete(): void {
  skillMenuEl.classList.remove("on");
  skillMenuEl.textContent = "";
  menuItems = [];
  menuActive = 0;
  hideComposerAutocomplete(SKILL_MENU_ID);
}

function showStatus(text: string): void {
  skillMenuEl.textContent = "";
  const row = document.createElement("div");
  row.className = "menu-note skill-menu-status";
  row.textContent = text;
  skillMenuEl.appendChild(row);
  skillMenuEl.classList.add("on");
  menuItems = [];
  showComposerAutocomplete(
    SKILL_MENU_ID,
    closeSkillAutocomplete,
    skillAutocompleteOwnsKey,
  );
}

function setActiveItem(index: number): void {
  if (!menuItems.length) return;
  menuActive = (index + menuItems.length) % menuItems.length;
  skillMenuEl
    .querySelectorAll<HTMLElement>(".skill-option")
    .forEach((row, i) => {
      const active = i === menuActive;
      row.classList.toggle("active", active);
      row.setAttribute("aria-selected", active ? "true" : "false");
      if (active) {
        updateComposerAutocomplete(SKILL_MENU_ID, row.id);
        row.scrollIntoView({ block: "nearest" });
      }
    });
}

function completeMenuItem(item: MenuItem): void {
  const token = activeSkillToken();
  if (!token) {
    closeSkillAutocomplete();
    return;
  }
  if (item.kind === "command") {
    // Invariant: The runner can refuse synchronously (a cancelled /clear
    // confirmation or the same action already in flight). In that case retain
    // the token/menu so an explicit operator choice never turns into lost
    // composer text.
    const valueBefore = inputEl.value;
    const focused = document.activeElement;
    if (!runCommand?.(item.command.name)) return;
    // Invariant: Accepted platform actions remove their token, never prompt Pi.
    // Runners that rewrite the composer retain their new value.
    const clear = commandTokenToClear(valueBefore, inputEl.value, token);
    if (clear) inputEl.setRangeText("", clear.start, clear.end, "end");
    closeSkillAutocomplete();
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    // Invariant: A runner that moved focus (/revive opens its finder) keeps it
    // there.
    if (document.activeElement === focused) inputEl.focus();
    return;
  }
  inputEl.setRangeText(
    `/skill:${item.skill.name} `,
    token.start,
    token.end,
    "end",
  );
  closeSkillAutocomplete();
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.focus();
}

function filterSkills(skills: SkillChoice[], query: string): SkillChoice[] {
  const folded = query.toLowerCase();
  // Invariant: Prefix hits first, then other name substrings. The cap keeps a
  // large package collection navigable; narrowing the partial name reveals
  // further matches.
  return skills
    .filter((skill) => skill.name.toLowerCase().includes(folded))
    .sort((a, b) => {
      const an = a.name.toLowerCase(),
        bn = b.name.toLowerCase();
      const ar = an.startsWith(folded) ? 0 : 1,
        br = bn.startsWith(folded) ? 0 : 1;
      return ar - br || an.localeCompare(bn);
    })
    .slice(0, 10);
}

function groupLabel(text: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "menu-label skill-menu-group";
  label.setAttribute("role", "presentation");
  label.textContent = text;
  return label;
}

// A row's visible name reads as what the operator types.
function itemLabel(item: MenuItem): string {
  return item.kind === "command"
    ? `/${item.command.name}`
    : `/${item.skill.name}`;
}

function itemDescription(item: MenuItem): string {
  return item.kind === "command"
    ? item.command.description
    : item.skill.description;
}

function optionRow(item: MenuItem, index: number): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.id = `skill-option-${index}`;
  row.className =
    "menu-item skill-option" + (item.kind === "command" ? " action" : "");
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", index === menuActive ? "true" : "false");
  row.tabIndex = -1;
  row.dataset.index = String(index);
  const name = document.createElement("span");
  name.className = "skill-name";
  name.textContent = itemLabel(item);
  row.appendChild(name);
  const description = itemDescription(item);
  if (description) {
    const el = document.createElement("span");
    el.className = "skill-description";
    el.textContent = description;
    row.appendChild(el);
  }
  return row;
}

// Render the merged menu: platform commands first (Actions group), then pi
// skills (Skills group). `saved` marks a stale-cache skill list; `status` shows
// a trailing note (e.g. skills still loading) beneath the visible items.
function renderMenu(
  commands: ComposerCommand[],
  skills: SkillChoice[],
  saved = false,
  status = "",
): void {
  skillMenuEl.setAttribute("aria-label", "Commands and skills");
  menuItems = [
    ...commands.map((command): MenuItem => ({ kind: "command", command })),
    ...skills.map((skill): MenuItem => ({ kind: "skill", skill })),
  ];
  if (!menuItems.length) {
    if (status) {
      showStatus(status);
      return;
    }
    closeSkillAutocomplete();
    return;
  }
  menuActive = 0;
  skillMenuEl.textContent = "";
  if (commands.length) skillMenuEl.appendChild(groupLabel("Actions"));
  commands.forEach((_, i) =>
    skillMenuEl.appendChild(optionRow(menuItems[i], i)),
  );
  if (skills.length) {
    skillMenuEl.appendChild(groupLabel("Skills"));
    skills.forEach((_, i) => {
      const index = commands.length + i;
      skillMenuEl.appendChild(optionRow(menuItems[index], index));
    });
  }
  if (saved || status) {
    const note = document.createElement("div");
    note.className = "menu-note skill-menu-status";
    note.textContent = status || "Saved skills · refresh unavailable";
    skillMenuEl.appendChild(note);
  }
  skillMenuEl.classList.add("on");
  showComposerAutocomplete(
    SKILL_MENU_ID,
    closeSkillAutocomplete,
    skillAutocompleteOwnsKey,
    "skill-option-0",
  );
}

function parseSkills(data: unknown): SkillChoice[] {
  if (!data || typeof data !== "object") return [];
  const raw = (data as { skills?: unknown }).skills;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((skill): SkillChoice[] => {
    if (!skill || typeof skill !== "object") return [];
    const item = skill as { name?: unknown; description?: unknown };
    if (typeof item.name !== "string" || !item.name) return [];
    return [
      {
        name: item.name,
        description:
          typeof item.description === "string" ? item.description : "",
      },
    ];
  });
}

let browserStorage: Storage | null = null;
try {
  browserStorage = localStorage;
} catch {}
const persistentCache = new PersistentSkillCache(browserStorage);
const skillLoader = new SkillLoader(
  async (cid, expectedContext, etag) => {
    const headers: Record<string, string> = {};
    if (etag) headers["If-None-Match"] = etag;
    const response = await backendFor(cid).api(
      `/api/conversations/${encodeURIComponent(cid)}/skills`,
      { headers },
    );
    const context =
      response.headers.get("X-Recurse-Skill-Context") || expectedContext;
    const nextEtag = response.headers.get("ETag") || undefined;
    if (response.status === 304)
      return { status: "not-modified", context, etag: nextEtag };
    if (!response.ok) throw new Error("skills unavailable");
    const body = (await response.json()) as { context?: unknown };
    return {
      status: "ok",
      skills: parseSkills(body),
      context: typeof body.context === "string" ? body.context : context,
      etag: nextEtag,
    };
  },
  () => refreshSkillAutocomplete(),
  Date.now,
  5_000,
  persistentCache,
);

// Warm the registry for whichever real agent backs the current composer. This
// is intentionally fire-and-forget: opening an agent starts discovery without
// delaying its thread, and the same loader serves the picker if `/` is typed
// while the request is still in flight.
export function preloadSkills(force = false): void {
  const source = skillSource();
  if (source) void skillLoader.preload(source.agentId, source.context, force);
}

// Preserve the draft's already-visible registry across the instant ownership
// transition to its newly-created agent. The next tree poll supplies the same
// workdir context authoritatively and starts that agent's own revalidation.
export function adoptDraftSkills(agentId: string): void {
  const source = skillSource();
  if (!source) return;
  contextOverrides.set(agentId, source.context);
  skillLoader.adopt(agentId, source.context);
}

export function clearSkillsCache(): void {
  contextOverrides.clear();
  skillLoader.clear();
  closeSkillAutocomplete();
}

export function refreshSkillAutocomplete(): void {
  const token = activeSkillToken();
  if (!token) {
    closeSkillAutocomplete();
    return;
  }
  // Invariant: A canonical /skill:name token is an explicit request for pi's
  // skill. Never let a same-named platform action (for example /compact) shadow
  // it.
  const commands = matchingCommands(
    token.query,
    commandContext(),
    !token.canonicalSkill,
  );
  const source = skillSource();
  if (!source) {
    // Invariant: A draft with no resolvable source has no skill registry. Still
    // offer any matching platform command actions.
    renderMenu(commands, [], false);
    return;
  }
  const current = skillLoader.state(source.agentId, source.context);
  if (current.status === "ready") {
    if (!current.skills.length && current.refreshFailed) {
      if (commands.length)
        renderMenu(commands, [], false, "Skills unavailable");
      else showStatus("Skills unavailable");
      return;
    }
    renderMenu(
      commands,
      filterSkills(current.skills, token.query),
      current.refreshFailed,
    );
    return;
  }
  if (current.status === "error") {
    if (commands.length) renderMenu(commands, [], false, "Skills unavailable");
    else showStatus("Skills unavailable");
    return;
  }
  if (commands.length) renderMenu(commands, [], false, "Loading skills…");
  else showStatus("Loading skills…");
  if (current.status === "missing")
    void skillLoader.preload(source.agentId, source.context);
}

window.addEventListener("storage", (event: StorageEvent) => {
  if (event.key === SKILL_CACHE_KEY) skillLoader.sync(event.newValue);
});
window.addEventListener("online", () => preloadSkills(true));

let menuPointerDown = false;
skillMenuEl.addEventListener("pointerdown", (event: PointerEvent) => {
  menuPointerDown = true;
  // Invariant: A mouse click should leave the textarea caret stable. Touch must
  // keep its native gesture so a long skill list remains scrollable instead of
  // choosing the first row a finger lands on.
  if (
    event.pointerType === "mouse" &&
    (event.target as Element).closest(".skill-option")
  )
    event.preventDefault();
});
skillMenuEl.addEventListener("pointerup", () => {
  setTimeout(() => {
    menuPointerDown = false;
  }, 0);
});
skillMenuEl.addEventListener("pointercancel", () => {
  menuPointerDown = false;
});
skillMenuEl.addEventListener("click", (event: MouseEvent) => {
  const row = (event.target as Element).closest<HTMLButtonElement>(
    ".skill-option",
  );
  if (!row) return;
  const index = Number(row.dataset.index);
  if (Number.isInteger(index) && menuItems[index])
    completeMenuItem(menuItems[index]);
});
skillMenuEl.addEventListener("pointermove", (event: PointerEvent) => {
  if (event.pointerType !== "mouse") return;
  const row = (event.target as Element).closest<HTMLButtonElement>(
    ".skill-option",
  );
  if (!row) return;
  const index = Number(row.dataset.index);
  if (Number.isInteger(index)) setActiveItem(index);
});

inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
  if (!skillAutocompleteOpen()) return;
  // Invariant: Every IME key, including Escape/Enter, belongs to composition.
  // Checking before the popup's Escape handling keeps candidate cancellation
  // native.
  if (event.isComposing || event.keyCode === 229) return;
  // Invariant: The composer popup is above Insert: Escape dismisses it without
  // blurring the draft, and a later Escape can return to Normal.
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeSkillAutocomplete();
    return;
  }
  if (!menuItems.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    setActiveItem(menuActive + (event.key === "ArrowDown" ? 1 : -1));
  } else if (
    event.key === "Tab" ||
    (event.key === "Enter" && !event.shiftKey)
  ) {
    event.preventDefault();
    event.stopPropagation();
    completeMenuItem(menuItems[menuActive]);
  }
});
inputEl.addEventListener("focus", refreshSkillAutocomplete);
inputEl.addEventListener("click", refreshSkillAutocomplete);
inputEl.addEventListener("keyup", (event: KeyboardEvent) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
    refreshSkillAutocomplete();
});
inputEl.addEventListener("blur", () =>
  setTimeout(() => {
    if (!menuPointerDown) closeSkillAutocomplete();
  }, 0),
);
document.addEventListener("pointerdown", (event: PointerEvent) => {
  const target = event.target as Node;
  if (target !== inputEl && !skillMenuEl.contains(target))
    closeSkillAutocomplete();
});
