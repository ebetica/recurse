// Tips pane: one tip at a time from list.ts, with Previous/Next and All tips.
// After each hour a Recurse tab is visible it shows the attention dot, if a
// tip is unseen and the switch is on. State lives in this browser's storage.
import { html, nothing, render } from "lit";
import { openAgentFinderNavigate } from "../agent-finder/ui.js";
import { parseConversationId } from "../backends/backend.js";
import { startNewAgent } from "../composer.js";
import { $, inputEl } from "../dom.js";
import { TIPS_ICON } from "../icons.js";
import { openEffortMenu } from "../models.js";
import {
  closeOpenPane,
  openPane,
  paneAvailable,
  registerPane,
  syncPanes,
} from "../panes.js";
import { sharedTrees } from "../shared-trees.js";
import { DRAFT, embedded, state as appState } from "../state.js";
import type { PaneContext } from "../types.js";
import { TIPS, type Tip, type TipControl } from "./list.js";

const PANE_ID = "tips";
const STORAGE_KEY = "recurse.tips";
const HOUR_MS = 3_600_000;
const CREDIT_MS = 60_000;

interface Saved {
  off?: boolean;
  seen: string[];
  current?: string;
  usedMs: number;
  countedTo?: number;
  due?: boolean;
}

const CONTROL_LABELS: Record<TipControl, string> = {
  "find-agent": "Find an agent",
  effort: "Choose effort",
  btw: "Start /btw",
  skills: "Show skills",
  changes: "Open Changes",
  artifacts: "Open Artifacts",
  shortcuts: "Show shortcuts",
  "settings-appearance": "Open Settings",
  "settings-account": "Open Settings",
};

const phone = matchMedia("(max-width: 700px)");
let openBody: HTMLElement | null = null;

function load(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (value && Array.isArray(value.seen))
      return {
        ...value,
        seen: value.seen.filter((id: unknown) => typeof id === "string"),
        usedMs: Number(value.usedMs) || 0,
        countedTo: Number(value.countedTo) || 0,
      };
  } catch {}
  return { seen: [], usedMs: 0 };
}

let saved = load();

// Invariant: Opening the pane passes sync=false; openPane repaints the rail
// itself, and a nested syncPanes from inside its layout must not run.
function update(change: (next: Saved) => void, sync = true): void {
  const before = saved.due;
  saved = load();
  change(saved);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {}
  if (sync && before !== saved.due) syncPanes();
}

function deviceTips(): readonly Tip[] {
  const other = phone.matches ? "desktop" : "phone";
  return TIPS.filter((tip) => tip.device !== other);
}

function unseenAfter(tips: readonly Tip[], from: number): Tip | undefined {
  for (let step = 1; step <= tips.length; step++) {
    const tip = tips[(from + step) % tips.length];
    if (!saved.seen.includes(tip.id)) return tip;
  }
  return undefined;
}

// Spec: Only time with a tab visible and Tips closed counts toward the hour.
const visibleNow = (): number | null =>
  document.visibilityState === "visible" ? Date.now() : null;
let visibleSince = visibleNow();
function creditVisibleTime(): void {
  const now = Date.now();
  const from = visibleSince;
  visibleSince = visibleNow();
  if (from === null || openBody) return;
  update((next) => {
    // Invariant: Windows share countedTo, so time seen by two counts once.
    const counted =
      (next.countedTo ?? 0) <= now + CREDIT_MS ? (next.countedTo ?? 0) : 0;
    const start = Math.max(from, counted);
    next.countedTo = Math.max(now, counted);
    if (next.off || next.due || now <= start) return;
    next.usedMs += now - start;
    if (next.usedMs < HOUR_MS) return;
    next.usedMs = 0;
    next.due = !!unseenAfter(deviceTips(), -1);
  });
}

if (!embedded) {
  // Invariant: Embedded side-conversation frames share the page's visibility;
  // only the main app counts time, or each frame would add its own hour.
  document.addEventListener("visibilitychange", creditVisibleTime);
  setInterval(creditVisibleTime, CREDIT_MS);
}
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  const before = saved.due;
  saved = load();
  if (before !== saved.due) syncPanes();
  if (openBody) paint(openBody);
});

function show(id: string): void {
  update((next) => {
    next.current = id;
    if (!next.seen.includes(id)) next.seen.push(id);
  }, false);
  if (openBody) paint(openBody);
}

function step(delta: 1 | -1): void {
  const tips = deviceTips();
  const index = tips.findIndex((tip) => tip.id === saved.current);
  show(tips[(index + delta + tips.length) % tips.length].id);
}

function closeOnPhone(): void {
  if (phone.matches) closeOpenPane(PANE_ID);
}

/** Requests follow a draft on a new line; /btw prefixes it; / ends it. */
function typeIntoComposer(
  text: string,
  join: "line" | "prefix" | "word",
): void {
  const draft = inputEl.value.trim();
  inputEl.value = !draft
    ? text
    : join === "prefix"
      ? text + draft
      : `${draft}${join === "line" ? "\n" : " "}${text}`;
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function ask(tip: Tip): void {
  if (!tip.ask) return;
  if (tip.ask.where === "new") {
    startNewAgent(new DOMRect());
    if (appState.selectedId !== DRAFT) return;
  } else closeOnPhone();
  typeIntoComposer(tip.ask.request, "line");
}

function runControl(control: TipControl): void {
  switch (control) {
    case "find-agent":
      openAgentFinderNavigate();
      return;
    case "effort":
      closeOnPhone();
      openEffortMenu();
      return;
    case "btw":
      closeOnPhone();
      typeIntoComposer("/btw ", "prefix");
      return;
    case "skills":
      closeOnPhone();
      typeIntoComposer("/", "word");
      return;
    case "changes":
      openPane("diff");
      return;
    case "artifacts":
      openPane("report");
      return;
    case "shortcuts": {
      const shortcuts = $<HTMLDetailsElement>("#shortcut-pane");
      if (!shortcuts) return;
      shortcuts.open = true;
      shortcuts.querySelector("summary")?.focus();
      return;
    }
    default:
      window.dispatchEvent(
        new CustomEvent("recurse:open-settings", {
          detail: control === "settings-account" ? "account" : "appearance",
        }),
      );
  }
}

function controlAvailable(control: TipControl): boolean {
  if (control === "changes") return paneAvailable("diff");
  if (control === "artifacts") return paneAvailable("report");
  if (control === "btw") return !parseConversationId(appState.selectedId).label;
  if (control === "effort") return !!$("#model-row")?.classList.contains("on");
  return true;
}

function paint(body: HTMLElement): void {
  const tips = deviceTips();
  const index = Math.max(
    0,
    tips.findIndex((tip) => tip.id === saved.current),
  );
  const tip = tips[index];
  const areas = [...new Set(tips.map((each) => each.area))];
  const askable = tip.ask && (tip.ask.where === "this" || sharedTrees === null);
  const control =
    tip.control && controlAvailable(tip.control) ? tip.control : null;
  render(
    html`<div class="tips-pane">
      <p class="tips-count">${index + 1} of ${tips.length}</p>
      <article class="tip-card" aria-live="polite">
        <p class="tip-area">${tip.area}</p>
        <h3 class="tip-title">${tip.title}</h3>
        <p class="tip-text">${tip.text}</p>
        ${askable || control
          ? html`<div class="tip-actions">
              ${askable
                ? html`<button class="btn sm" @click=${() => ask(tip)}>
                    ${tip.ask!.where === "new"
                      ? "Ask a new agent"
                      : "Ask this agent"}
                  </button>`
                : nothing}
              ${control
                ? html`<button
                    class="btn sm"
                    @click=${() => runControl(control)}
                  >
                    ${CONTROL_LABELS[control]}
                  </button>`
                : nothing}
            </div>`
          : nothing}
      </article>
      <div class="tips-nav">
        <button class="btn sm" @click=${() => step(-1)}>Previous</button>
        <button class="btn sm primary" @click=${() => step(1)}>Next tip</button>
      </div>
      <details class="tips-all">
        <summary>All tips</summary>
        ${areas.map(
          (area) =>
            html`<p class="tips-all-area">${area}</p>
              ${tips
                .filter((each) => each.area === area)
                .map(
                  (each) =>
                    html`<button
                      class="tips-all-item"
                      aria-current=${each === tip ? "true" : "false"}
                      @click=${() => show(each.id)}
                    >
                      ${each.title}
                    </button>`,
                )}`,
        )}
      </details>
      <label class="tips-switch">
        <input
          type="checkbox"
          class="switch"
          role="switch"
          .checked=${!saved.off}
          @change=${(event: Event) =>
            update((next) => {
              next.off = !(event.target as HTMLInputElement).checked;
              if (next.off) next.due = false;
            })}
        />
        Show a tip every hour
      </label>
    </div>`,
    body,
  );
}

registerPane({
  id: PANE_ID,
  title: "Tips",
  icon: TIPS_ICON,
  available: (ctx: PaneContext) => !!ctx.node,
  attention: () => !!saved.due,
  render(body: HTMLElement) {
    // Spec: Opening after the dot moves to the next unseen tip; otherwise the
    // current tip stays, so a pane restored on navigation does not move on.
    openBody = body;
    visibleSince = visibleNow();
    const tips = deviceTips();
    const index = tips.findIndex((tip) => tip.id === saved.current);
    const next =
      saved.due || index < 0 ? (unseenAfter(tips, index) ?? tips[0]) : null;
    update((after) => {
      after.due = false;
      after.usedMs = 0;
    }, false);
    if (next) show(next.id);
    else paint(body);
  },
  refresh: (body: HTMLElement) => paint(body),
  leave(body: HTMLElement) {
    if (openBody !== body) return;
    openBody = null;
    visibleSince = visibleNow();
  },
});
