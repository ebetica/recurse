// Shared pane headings and native fullscreen controls, including Chat.
// Features render into the controls slot; frames own loading and close.
import { render } from "lit";
import { CLOSE_ICON, PANE_COMPRESS_ICON, PANE_EXPAND_ICON } from "../icons.js";

const powerbars = new WeakMap<HTMLElement, HTMLElement>();
const fullscreenButtons = new WeakMap<HTMLElement, HTMLButtonElement>();

for (const type of ["click", "change"]) {
  document.addEventListener(
    type,
    (event) => {
      const control = (event.target as Element | null)?.closest(
        type === "click" ? "button:not(:disabled), a[href]" : "select",
      );
      if (control) closePowerbarOverflow(control);
    },
    true,
  );
}

export function retainPanePowerbar(
  body: HTMLElement,
  bar: HTMLElement,
): HTMLElement {
  const retained = powerbars.get(body) || bar;
  powerbars.set(body, retained);
  return retained;
}

export function updateFullscreenControl(
  button: HTMLButtonElement,
  on: boolean,
): void {
  button.innerHTML = on ? PANE_COMPRESS_ICON : PANE_EXPAND_ICON;
  button.title = on ? "Exit fullscreen" : "Fullscreen";
  button.setAttribute("aria-label", on ? "Exit fullscreen" : "Open fullscreen");
  button.setAttribute("aria-pressed", String(on));
}

export function createFullscreenControl(
  id: string,
  toggle: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "fs icon-btn";
  button.dataset.pane = id;
  button.type = "button";
  button.onclick = toggle;
  updateFullscreenControl(button, false);
  return button;
}

export function createPanePowerbar(
  id: string,
  title: string,
  fullscreen: () => void,
  close: () => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pane-head pane-powerbar";
  const heading = document.createElement("h2");
  heading.className = "pane-title";
  heading.id = `pane-title-${id}`;
  heading.tabIndex = -1;
  heading.textContent = title;
  const status = document.createElement("span");
  status.className = "pane-loading-status sr-only";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  const controls = document.createElement("div");
  controls.className = "pane-powerbar-controls";
  const fs = createFullscreenControl(id, fullscreen);
  fullscreenButtons.set(bar, fs);
  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.title = `Close ${title}`;
  x.setAttribute("aria-label", x.title);
  x.innerHTML = CLOSE_ICON;
  x.onclick = close;
  bar.append(heading, status, controls, fs, x);
  return bar;
}

export function closePowerbarOverflow(target: EventTarget | null): boolean {
  const menu = (target as Element | null)?.closest?.<HTMLDetailsElement>(
    ".pane-powerbar-overflow[open]",
  );
  if (!menu) return false;
  menu.open = false;
  menu.querySelector<HTMLElement>("summary")?.focus();
  return true;
}

document.addEventListener("pointerdown", (event) => {
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(
    ".pane-powerbar-overflow[open]",
  )) {
    if (!menu.contains(event.target as Node)) menu.open = false;
  }
});

export function panePowerbar(body: HTMLElement): HTMLElement {
  return powerbars.get(body)!;
}

/** The retained native control can live in a window header or its pane. */
export function paneFullscreenControl(body: HTMLElement): HTMLButtonElement {
  return fullscreenButtons.get(panePowerbar(body))!;
}

export function renderPowerbarControls(
  body: HTMLElement,
  controls: unknown,
  namesItem = false,
): void {
  const bar = panePowerbar(body);
  bar.classList.toggle("pane-powerbar-item", namesItem);
  render(controls, bar.querySelector<HTMLElement>(".pane-powerbar-controls")!);
}
