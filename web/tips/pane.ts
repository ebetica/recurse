// Tips pane: one tip at a time from list.ts, with Previous/Next and All tips.
// After each hour a Recurse tab is visible it shows the attention dot, if a
// tip is unseen and the switch is on. State lives in this browser's storage.
// Desktop list keys leave the shown tip unchanged until opening a row.
import { html, nothing, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
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
import { paneItem } from "../panes/navigation.js";
import { copyText } from "../tool_details.js";
import { DRAFT, embedded, state as appState } from "../state.js";
import type { PaneContext, PaneNavigation } from "../types.js";
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
let filter = "";
let notice = "";
phone.addEventListener("change", () => {
  if (!openBody) return;
  for (const item of openBody.querySelectorAll(".tips-all-item")) {
    item.classList.remove("pane-item-cursor");
    item.removeAttribute("aria-current");
    item.removeAttribute("tabindex");
  }
  paint(openBody);
});

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
  const all = openBody?.querySelector<HTMLDetailsElement>(".tips-all");
  const leaveList = !phone.matches && !!all?.open;
  update((next) => {
    next.current = id;
    if (!next.seen.includes(id)) next.seen.push(id);
  }, false);
  notice = "";
  if (leaveList) all!.open = false;
  if (openBody) {
    paint(openBody);
    if (leaveList) openBody.querySelector<HTMLElement>(".tip-card")?.focus();
  }
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

function navigate(body: HTMLElement, command: PaneNavigation): boolean {
  if (phone.matches) return false;
  const all = body.querySelector<HTMLDetailsElement>(".tips-all")!;
  if (command === "back" || command === "filter") {
    notice = "";
    paint(body);
    all.open = true;
    [...body.querySelectorAll<HTMLElement>(".tips-all-item")]
      .find((item) => item.dataset.tip === saved.current)
      ?.focus({ preventScroll: true });
    paneItem(body, ".tips-all-item", "open");
    if (command === "filter")
      body.querySelector<HTMLInputElement>(".tips-filter")?.focus();
    return true;
  }
  if (command === "copy") {
    const tips = deviceTips();
    const id = all.open
      ? paneItem(body, ".tips-all-item", "open")?.dataset.tip
      : saved.current;
    const tip = tips.find((each) => each.id === id);
    const focus = document.activeElement;
    if (tip)
      void copyText(`${tip.title}\n\n${tip.text}`).then((ok) => {
        if (openBody !== body) return;
        notice = ok ? "Tip copied." : "Could not copy tip.";
        paint(body);
        if (
          focus instanceof HTMLElement &&
          focus.isConnected &&
          document.activeElement === document.body
        )
          focus.focus({ preventScroll: true });
      });
    return true;
  }
  if (
    all.open &&
    [
      "next",
      "previous",
      "top",
      "bottom",
      "next-section",
      "previous-section",
      "open",
    ].includes(command)
  ) {
    const item = paneItem(body, ".tips-all-item", command);
    if (command === "open") item?.click();
    return true;
  }
  if (
    !all.open &&
    (command === "next-section" || command === "previous-section")
  ) {
    step(command === "next-section" ? 1 : -1);
    return true;
  }
  return false;
}

function paint(body: HTMLElement): void {
  const tips = deviceTips();
  const index = Math.max(
    0,
    tips.findIndex((tip) => tip.id === saved.current),
  );
  const tip = tips[index];
  const matches = phone.matches
    ? tips
    : tips.filter((each) =>
        each.title.toLowerCase().includes(filter.trim().toLowerCase()),
      );
  const areas = [...new Set(matches.map((each) => each.area))];
  const askable = tip.ask && (tip.ask.where === "this" || sharedTrees === null);
  const control =
    tip.control && controlAvailable(tip.control) ? tip.control : null;
  render(
    html`<div class="tips-pane">
      <p class="tips-count">${index + 1} of ${tips.length}</p>
      <article class="tip-card" aria-live="polite" tabindex="-1">
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
        ${phone.matches
          ? nothing
          : html`<input
              class="text-field tips-filter"
              type="search"
              aria-label="Filter tips"
              placeholder="Filter tips"
              .value=${filter}
              @input=${(event: Event) => {
                filter = (event.target as HTMLInputElement).value;
                paint(body);
              }}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter" && !event.isComposing) {
                  event.preventDefault();
                  paneItem(body, ".tips-all-item", "open")?.click();
                }
              }}
            />`}
        ${repeat(
          areas,
          (area) => area,
          (area) =>
            html`<p class="tips-all-area">${area}</p>
              ${repeat(
                matches.filter((each) => each.area === area),
                (each) => each.id,
                (each) =>
                  html`<button
                    class="tips-all-item"
                    data-tip=${each.id}
                    aria-current=${phone.matches
                      ? live(each === tip ? "true" : "false")
                      : nothing}
                    @click=${() => show(each.id)}
                  >
                    ${each.title}
                  </button>`,
              )} `,
        )}
        ${matches.length ? nothing : html`<p role="status">No tips match.</p>`}
      </details>
      ${notice
        ? html`<p class="tips-notice" role="status">${notice}</p>`
        : nothing}
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
  navigate,
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
