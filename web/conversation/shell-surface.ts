// Owns shell/agent overlay state and working-activity affordances. Both chips
// share one overlay slot, so at most one surface is open; thread paint renders
// it.

import { html, render, nothing, type TemplateResult } from "lit";
import { state } from "../state.js";
import { inputEl, msgsEl, scrollEl, shellOverlayEl, titleEl } from "../dom.js";
import {
  formatShellElapsed,
  formatShellStarted,
  liveBackgroundShells,
  pickShellCount,
  shellStatusSummary,
  shellStatusText,
  streamShellRows,
} from "../thread-render/background-shells.js";
import { rowThreads } from "../row-thread-state.js";
import { paint } from "./thread.js";
import { activeDescendants, activeAgentSummary } from "../active-agents.js";
import { guardLeaveComments } from "../comments.js";
import {
  activeAgentRowT,
  closeMobileSidebar,
  selectAgent,
} from "../sidebar.js";
import type { Conversation } from "../types.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { CLOSE_ICON } from "../icons.js";

export let shellSurfaceAgent: string | null = null;
let shellSurfaceReturnFocus: HTMLElement | null = null;

export let agentSurfaceAgent: string | null = null;
let agentSurfaceReturnFocus: HTMLElement | null = null;

const SURFACE_GAP_PX = 8;
const SURFACE_MARGIN_PX = 8;
/** Matches #shell-overlay's --space-5 side padding. */
const SURFACE_DESKTOP_MARGIN_PX = 16;

function activeSurfaceButton(): HTMLButtonElement | null {
  if (shellSurfaceAgent) return shellSurfaceButton(shellSurfaceAgent);
  if (agentSurfaceAgent) return agentSurfaceButton(agentSurfaceAgent);
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// Positions the overlay outside the thread to preserve scrollTop. Fits around
// the chip within the scroll viewport, never over the composer or topbar,
// preferring above when space allows.
function positionSurface(): void {
  const panel = shellOverlayEl.querySelector<HTMLElement>(".shell-surface");
  const button = activeSurfaceButton();
  if (!panel || !button) return;

  const anchor = button.closest<HTMLElement>(".live-panel-box") || button;
  const anchorRect = anchor.getBoundingClientRect();
  const scrollRect = scrollEl.getBoundingClientRect();
  const viewportWidth =
    document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight =
    document.documentElement.clientHeight || window.innerHeight;
  const phone = window.matchMedia("(max-width: 700px)").matches;
  const margin = phone ? SURFACE_MARGIN_PX : SURFACE_DESKTOP_MARGIN_PX;
  const topBound = Math.max(margin, scrollRect.top + SURFACE_MARGIN_PX);
  const bottomBound = Math.min(
    viewportHeight - margin,
    scrollRect.bottom - SURFACE_MARGIN_PX,
  );
  if (bottomBound <= topBound) return;

  const width = Math.min(
    phone ? viewportWidth - 2 * SURFACE_MARGIN_PX : 540,
    viewportWidth - 2 * margin,
  );
  const left = clamp(
    anchorRect.right - width,
    margin,
    Math.max(margin, viewportWidth - margin - width),
  );
  panel.style.position = "fixed";
  panel.style.left = `${Math.round(left)}px`;
  panel.style.width = `${Math.max(0, Math.round(width))}px`;
  panel.style.right = "auto";
  panel.style.top = "0px";
  panel.style.maxHeight = "none";
  const naturalHeight = Math.max(
    panel.scrollHeight,
    panel.getBoundingClientRect().height,
  );
  const above = Math.max(0, anchorRect.top - topBound - SURFACE_GAP_PX);
  const below = Math.max(0, bottomBound - anchorRect.bottom - SURFACE_GAP_PX);
  const placeAbove = above >= naturalHeight || above >= below;
  const available = placeAbove ? above : below;
  const height = Math.max(1, Math.min(naturalHeight, available));
  const top = placeAbove
    ? Math.max(topBound, anchorRect.top - SURFACE_GAP_PX - height)
    : Math.min(bottomBound - height, anchorRect.bottom + SURFACE_GAP_PX);
  panel.style.maxHeight = `${Math.round(height)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.dataset.placement = placeAbove ? "above" : "below";
}

function repositionSurface(): void {
  if (shellSurfaceAgent || agentSurfaceAgent) positionSurface();
}

function settleSurfacePosition(): void {
  positionSurface();
  requestAnimationFrame(() => {
    if (shellSurfaceAgent || agentSurfaceAgent) positionSurface();
  });
}

export function agentSurfaceOpen(): boolean {
  return agentSurfaceAgent !== null;
}

function agentSurfaceButton(cid: string): HTMLButtonElement | null {
  return msgsEl.querySelector<HTMLButtonElement>(
    `[data-agent-chip][data-agent-id="${CSS.escape(cid)}"]`,
  );
}

export function closeAgentSurface(restoreFocus = true): boolean {
  if (!agentSurfaceAgent) return false;
  const cid = agentSurfaceAgent;
  const previous = agentSurfaceReturnFocus;
  agentSurfaceButton(cid)?.setAttribute("aria-expanded", "false");
  agentSurfaceAgent = null;
  agentSurfaceReturnFocus = null;
  render(nothing, shellOverlayEl);
  if (restoreFocus && cid === state.selectedId) {
    queueMicrotask(() => {
      const target = previous?.isConnected
        ? previous
        : agentSurfaceButton(cid) ||
          (titleEl.hasAttribute("tabindex") ? titleEl : inputEl);
      target.focus();
    });
  }
  return true;
}

export function openAgentSurface(cid: string, button: HTMLButtonElement): void {
  const current = state.currentConv;
  if (!current || current.id !== cid) return;
  if (!activeDescendants(state.nodes, cid).length) return;
  if (agentSurfaceAgent === cid) {
    closeAgentSurface();
    return;
  }
  // Invariant: The two chips share the one overlay slot: opening one closes the
  // other.
  closeShellSurface(false);
  closeAgentSurface(false);
  agentSurfaceAgent = cid;
  agentSurfaceReturnFocus = button;
  paint(current);
  agentSurfaceButton(cid)?.setAttribute("aria-expanded", "true");
  focusShellSurface();
}

export function shellSurfaceOpen(): boolean {
  return shellSurfaceAgent !== null;
}

function shellSurfaceButton(cid: string): HTMLButtonElement | null {
  return msgsEl.querySelector<HTMLButtonElement>(
    `[data-shell-chip][data-agent-id="${CSS.escape(cid)}"]`,
  );
}

function focusShellSurface(): void {
  shellOverlayEl
    .querySelector<HTMLButtonElement>(
      ".shell-surface-close, .agent-surface-close",
    )
    ?.focus();
}

export function closeShellSurface(restoreFocus = true): boolean {
  if (!shellSurfaceAgent) return false;
  const cid = shellSurfaceAgent;
  const previous = shellSurfaceReturnFocus;
  shellSurfaceButton(cid)?.setAttribute("aria-expanded", "false");
  shellSurfaceAgent = null;
  shellSurfaceReturnFocus = null;
  render(nothing, shellOverlayEl);
  if (restoreFocus && cid === state.selectedId) {
    queueMicrotask(() => {
      const target = previous?.isConnected
        ? previous
        : shellSurfaceButton(cid) ||
          (titleEl.hasAttribute("tabindex") ? titleEl : inputEl);
      target.focus();
    });
  }
  return true;
}

function shellCardsT(
  shells: ReturnType<typeof activeShells>["shells"],
  shellView: ReturnType<typeof activeShells>["shellView"],
  shellCount: number,
): TemplateResult {
  if (!shells.length) {
    const note =
      shellView?.status === "unavailable"
        ? "Shell details are temporarily unavailable."
        : `${shellCount} active background shell${shellCount === 1 ? "" : "s"} reported.`;
    return html`<p class="shell-empty">${note}</p>`;
  }
  return html`<ul class="shell-list">
      ${shells.map((item) => {
        const elapsed = formatShellElapsed(item.elapsed_seconds);
        return html`<li class="shell-row">
          <div class="shell-meta">
            <span class="shell-state ${item.status}"
              >${shellStatusText(item)}</span
            >
            <span>${formatShellStarted(item.started_at)}</span>
            ${elapsed ? html`<span>Elapsed ${elapsed}</span>` : nothing}
          </div>
          <div class="shell-command">${item.command}</div>
        </li>`;
      })}
    </ul>
    ${shellCount > shells.length
      ? html`<p class="shell-limit">
          Showing ${shells.length} of ${shellCount} active background shells.
        </p>`
      : nothing}`;
}

function shellSurfaceT(conv: Conversation): TemplateResult | typeof nothing {
  const { shellView, shells, shellCount } = activeShells(conv);
  if (!shellCount) return nothing;
  const title = shellView?.agent_title || conv.title || conv.id;
  const summary = shellStatusSummary(shells, shellCount);
  return html`<section
    class="dialog shell-surface"
    role="dialog"
    aria-labelledby="shell-surface-title"
    aria-describedby="shell-surface-summary"
  >
    <header class="shell-surface-head">
      <div class="shell-surface-heading">
        <h2 id="shell-surface-title">Background shells for ${title}</h2>
        <p id="shell-surface-summary">${summary}</p>
      </div>
      <button
        class="icon-btn lg shell-surface-close"
        type="button"
        aria-label="Close background shell details"
        title="Close"
        @click=${() => closeShellSurface()}
      >
        ${unsafeHTML(CLOSE_ICON)}
      </button>
    </header>
    ${shellCardsT(shells, shellView, shellCount)}
  </section>`;
}

export function paintShellSurface(conv?: Conversation | null): void {
  // Invariant: The agent surface owns the shared slot while it is open; this
  // painter stays out of its way, and vice versa in paintAgentSurface below.
  if (agentSurfaceAgent) return;
  if (!shellSurfaceAgent) {
    render(nothing, shellOverlayEl);
    return;
  }
  if (
    !conv ||
    conv.id !== shellSurfaceAgent ||
    activeShells(conv).shellCount === 0
  ) {
    closeShellSurface();
    return;
  }
  render(shellSurfaceT(conv), shellOverlayEl);
  settleSurfacePosition();
}

// Sibling to the shell surface: the agents chip opens the same overlay card
// listing every active agent under this conversation, from the tree snapshot
// the sidebar already polls. A row navigates exactly like a sidebar row.
function agentSurfaceT(conv: Conversation): TemplateResult | typeof nothing {
  const agents = activeDescendants(state.nodes, conv.id);
  if (!agents.length) return nothing;
  const title = conv.title || conv.id;
  const open = (event: Event, id: string) => {
    event.preventDefault();
    if (id !== state.selectedId && !guardLeaveComments()) return;
    closeAgentSurface(false);
    state.cursorId = id;
    selectAgent(id);
    closeMobileSidebar();
  };
  return html`<section
    class="dialog shell-surface agent-surface"
    role="dialog"
    aria-labelledby="agent-surface-title"
    aria-describedby="agent-surface-summary"
  >
    <header class="shell-surface-head">
      <div class="shell-surface-heading">
        <h2 id="agent-surface-title">Active agents for ${title}</h2>
        <p id="agent-surface-summary">${activeAgentSummary(agents.length)}</p>
      </div>
      <button
        class="icon-btn lg agent-surface-close"
        type="button"
        aria-label="Close active agent details"
        title="Close"
        @click=${() => closeAgentSurface()}
      >
        ${unsafeHTML(CLOSE_ICON)}
      </button>
    </header>
    <ul class="active-agent-list">
      ${agents.map(
        ({ node, depth }) =>
          html`<li>${activeAgentRowT(node, depth - 1, open)}</li>`,
      )}
    </ul>
  </section>`;
}

export function paintAgentSurface(conv?: Conversation | null): void {
  if (shellSurfaceAgent) return;
  if (!agentSurfaceAgent) {
    render(nothing, shellOverlayEl);
    return;
  }
  if (
    !conv ||
    conv.id !== agentSurfaceAgent ||
    !activeDescendants(state.nodes, conv.id).length
  ) {
    closeAgentSurface();
    return;
  }
  render(agentSurfaceT(conv), shellOverlayEl);
  settleSurfacePosition();
}

export function openShellSurface(cid: string, button: HTMLButtonElement): void {
  const current = state.currentConv;
  if (!current || current.id !== cid || activeShells(current).shellCount === 0)
    return;
  if (shellSurfaceAgent === cid) {
    closeShellSurface();
    return;
  }
  if (shellSurfaceAgent) closeShellSurface(false);
  if (agentSurfaceAgent) closeAgentSurface(false);
  shellSurfaceAgent = cid;
  shellSurfaceReturnFocus = button;
  paint(current);
  shellSurfaceButton(cid)?.setAttribute("aria-expanded", "true");
  focusShellSurface();
}

function shellSurfaceKeydown(event: KeyboardEvent): void {
  if (!shellSurfaceAgent && !agentSurfaceAgent) return;
  const dialog = shellOverlayEl.querySelector<HTMLElement>(".shell-surface");
  if (!dialog?.contains(event.target as Node)) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!closeShellSurface()) closeAgentSurface();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.hasAttribute("disabled"));
  if (!focusable.length) return;
  const first = focusable[0],
    last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

document.addEventListener("keydown", shellSurfaceKeydown, true);
scrollEl.addEventListener("scroll", repositionSurface, { passive: true });
window.addEventListener("resize", repositionSurface);
window.visualViewport?.addEventListener("resize", repositionSurface);
document.addEventListener("click", (event) => {
  if (!shellSurfaceAgent && !agentSurfaceAgent) return;
  const target = event.target as Element | null;
  if (
    target?.closest(".shell-surface") ||
    target?.closest(".shell-chip, .agent-chip")
  )
    return;
  if (!closeShellSurface()) closeAgentSurface();
});

// The centralized keymap treats visible live tool rows as a local layer: one
// Escape folds them and returns to Normal, never interrupting the agent.
export function workingActivityOpen(): boolean {
  return Boolean(
    msgsEl.querySelector(
      ".activity-boundary.current .activity-body.open .work-activity",
    ),
  );
}
export function closeWorkingActivity(): boolean {
  if (!workingActivityOpen()) return false;
  const toggle = msgsEl.querySelector<HTMLButtonElement>(
    '.activity-boundary.current .turn-eye[aria-expanded="true"]',
  );
  if (!toggle) return false;
  toggle.click();
  return true;
}

export function activeShells(conv: Conversation) {
  const shellView = conv.shells;
  const { items: shells, count: polledCount } = liveBackgroundShells(
    shellView?.items || [],
    shellView?.active_count || 0,
    shellView?.background_count,
  );
  // Invariant: Stream rows drive the chip; the poll-fed record stands in when
  // the stream knows no open shell, and keeps owning the details/stop panel.
  const shellCount = pickShellCount(
    streamShellRows(rowThreads.get(conv.id)?.rows).length,
    polledCount,
  );
  return { shellView, shells, shellCount };
}
