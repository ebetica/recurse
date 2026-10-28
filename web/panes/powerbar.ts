// Shared single-row pane heading and controls. Feature modules render into the
// controls slot; the frame owns heading, loading status and close action.
import { render } from "lit";
import { CLOSE_ICON } from "../icons.js";

const powerbars = new WeakMap<HTMLElement, HTMLElement>();

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
  const fs = document.createElement("button");
  fs.className = "fs";
  fs.type = "button";
  fs.onclick = fullscreen;
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

export function renderPowerbarControls(
  body: HTMLElement,
  controls: unknown,
  namesItem = false,
): void {
  const bar = panePowerbar(body);
  bar.classList.toggle("pane-powerbar-item", namesItem);
  render(controls, bar.querySelector<HTMLElement>(".pane-powerbar-controls")!);
}
