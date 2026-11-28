// The status bar keeps the latest thought and background work above the composer.
// Only readable prose expands the thought; the end of the turn clears it.
import { html, nothing, render, type TemplateResult } from "lit";
import { activeAgentSummary, activeDescendantCount } from "../active-agents.js";
import { statusBarEl } from "../dom.js";
import { rowThreads } from "../row-thread-state/index.js";
import { state } from "../state.js";
import { thinkingStore } from "./thinking.js";
import {
  shellSummary,
  shouldShowShellUnavailable,
} from "../thread-render/background-shells.js";
import {
  holdStatusBarTitle,
  statusBarState,
  thinkingSummaryBody,
  type LiveActivityRow,
  type StatusBarTitleState,
} from "../thread-render/tool_activity.js";
import type { Conversation } from "../types.js";
import { thinkingElapsedT } from "./live-elapsed.js";
import { activeShells, agentChipT, shellChipT } from "./shell-surface.js";
import { paint } from "../thread-render/index.js";

function statusBarBoxT(
  conv: Conversation,
  mood: string,
  label: TemplateResult,
  ariaLabel: string,
  stopping = false,
  summary: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  const { shellCount } = activeShells(conv);
  const shellLabel = shellSummary(shellCount);
  const agentLabel = activeAgentSummary(
    activeDescendantCount(state.nodes, conv.id),
  );
  const groupLabel = agentLabel ? `${ariaLabel}, ${agentLabel}` : ariaLabel;
  return html`<div class="msg assistant">
    <div
      class="working status-bar${stopping ? " stopping" : ""}"
      role="group"
      aria-label=${groupLabel}
    >
      <div class="status-bar-box ${mood}" role="group">
        <div class="status-bar-head">
          ${label}
          ${shellLabel || agentLabel
            ? html`<div class="status-bar-actions">
                ${shellChipT(conv, shellLabel, paint)}${agentChipT(
                  conv,
                  agentLabel,
                  paint,
                )}
              </div>`
            : nothing}
        </div>
        ${summary}
      </div>
    </div>
  </div>`;
}

const titleStates = new Map<string, StatusBarTitleState>();
const TITLE_STATE_LIMIT = 128;
let lastThought:
  | {
      cid: string;
      generation: number | undefined;
      run: Conversation["active_run_start"];
      row: LiveActivityRow;
    }
  | undefined;

function statusBarFor(conv: Conversation) {
  const thread = rowThreads.get(conv.id);
  const latest = thread?.latestThinking;
  const sameRun = latest?.run_start === (conv.active_run_start ?? null);
  const held =
    lastThought?.cid === conv.id &&
    lastThought.generation === conv.message_log_generation &&
    lastThought.run === conv.active_run_start
      ? lastThought.row
      : null;
  const row = sameRun
    ? latest.recovering && held?.thinking_title
      ? held
      : latest.row
    : null;
  return statusBarState(
    thread?.rows ?? [],
    conv.provider_starting == null,
    latest ? row : undefined,
    conv.active_run_start,
  );
}

// Stop overlays and retry notices retain priority over the latest thought.
export function runningStatusBarT(conv: Conversation): TemplateResult {
  const bar = statusBarFor(conv);
  lastThought = bar.thinkingRow && {
    cid: conv.id,
    generation: conv.message_log_generation,
    run: conv.active_run_start,
    row: bar.thinkingRow,
  };
  const retryNotice = conv.retry_notice;
  const stopping =
    conv.status === "interrupting" || state.stopPostInFlightId === conv.id;
  const overlay = stopping ? "Interrupting this turn…" : null;
  const hook = conv.running_hooks?.[0];
  if (!overlay && !retryNotice && hook) {
    const more = (conv.running_hooks?.length ?? 0) - 1;
    const title = `Running hook: ${hook.label}${more ? ` (+${more})` : ""}`;
    return statusBarBoxT(
      conv,
      "",
      html`<span class="status-bar-label" title=${title}
        >${title}${thinkingElapsedT(
          Math.max(0, Date.now() - hook.at),
          false,
        )}</span
      >`,
      title,
    );
  }
  const thinking = thinkingStore.syncStatusBar(conv, bar.thinkingRow, (text) =>
    thinkingSummaryBody(text, bar.title),
  );
  const toggleThinking =
    !overlay && !retryNotice && thinking?.text
      ? () => thinkingStore.toggleStatusBar(thinking.key)
      : null;
  const thinkingText =
    toggleThinking && thinking?.expanded ? thinking.text : "";
  const title = overlay ?? retryNotice ?? bar.title;
  const label = overlay ?? retryNotice ?? bar.label;
  const titleState = (() => {
    if (
      title === "Waiting" ||
      bar.kind !== "thinking" ||
      overlay ||
      retryNotice
    )
      return { title, changed: false };
    const now = typeof performance === "undefined" ? 0 : performance.now();
    const turnKey = bar.key.split("\0", 1)[0] ?? bar.key;
    const previous = titleStates.get(conv.id);
    if (!previous && titleStates.size >= TITLE_STATE_LIMIT) {
      const oldest = titleStates.keys().next().value;
      if (typeof oldest === "string") titleStates.delete(oldest);
    }
    const held = holdStatusBarTitle(previous, turnKey, bar.title, now);
    titleStates.set(conv.id, held.state);
    return { title: held.state.title, changed: held.changed };
  })();
  const elapsed =
    overlay === null && !retryNotice && bar.thinkingElapsedMs !== undefined
      ? thinkingElapsedT(bar.thinkingElapsedMs, titleState.title !== "Thinking")
      : nothing;
  const thinkingPrefix =
    bar.kind === "thinking" &&
    !overlay &&
    !retryNotice &&
    !["Thinking", "Waiting"].includes(titleState.title)
      ? `${bar.thinkingActive === false ? "Waiting" : "Thinking"} ·\u00a0`
      : nothing;
  const head = html`<span class="status-bar-thinking-head"
    >${thinkingPrefix}<span class="status-bar-thinking-title"
      >${titleState.title}</span
    >${elapsed}</span
  >`;
  const labelT = toggleThinking
    ? html`<button
        class="status-bar-label status-bar-thinking-copy${titleState.changed
          ? " status-bar-title-changing"
          : ""}"
        type="button"
        title=${titleState.title}
        aria-expanded=${String(!!thinkingText)}
        @click=${toggleThinking}
      >
        ${head}
      </button>`
    : html`<span
        class="status-bar-label${titleState.changed
          ? " status-bar-title-changing"
          : ""}"
        title=${titleState.title}
        >${head}</span
      >`;
  const summary = thinkingText
    ? html`<div
        class="status-bar-thinking-summary"
        tabindex="0"
        role="region"
        aria-label="Status bar thinking"
        .textContent=${thinkingText}
      ></div>`
    : nothing;
  const mood = overlay
    ? "is-overlay"
    : retryNotice
      ? "is-retrying"
      : bar.kind === "thinking"
        ? thinkingText
          ? "is-thinking has-thinking-summary is-expanded"
          : "is-thinking"
        : "";
  return statusBarBoxT(conv, mood, labelT, label, stopping, summary);
}

/** Follow new thinking until the reader scrolls away from the bottom. */
export function renderStatusBar(bar: TemplateResult | null): void {
  const selector = ".status-bar-thinking-summary";
  const previous = statusBarEl.querySelector<HTMLElement>(selector);
  const follow =
    !previous ||
    previous.scrollHeight - previous.clientHeight - previous.scrollTop <= 1;
  const previousText = previous?.textContent;
  render(bar ?? nothing, statusBarEl);
  statusBarEl.hidden = !bar;
  const summary = statusBarEl.querySelector<HTMLElement>(selector);
  if (
    summary &&
    follow &&
    (summary !== previous || summary.textContent !== previousText)
  )
    summary.scrollTop = summary.scrollHeight;
}

export function clearStatusBar(): void {
  lastThought = undefined;
  thinkingStore.clearStatusBar();
}

// Queued input replaces the status bar; failures keep their own retry UI.
export function queuedStatusBarT(conv: Conversation): TemplateResult {
  const label = "Queued…";
  return statusBarBoxT(
    conv,
    "is-queued",
    html`<span class="status-bar-label" title=${label} aria-hidden="true"
      >${label}</span
    >`,
    label,
  );
}

// A settled turn with background work keeps the same bar and chips.
export function waitingStatusBarT(conv: Conversation): TemplateResult {
  const label = "Waiting…";
  return statusBarBoxT(
    conv,
    "is-waiting",
    html`<span class="status-bar-label" title=${label} aria-hidden="true"
      >${label}</span
    >`,
    label,
  );
}

// Shell loading failures have a text row in the thread, not a chip.
export function shellUnavailableT(
  conv: Conversation,
): TemplateResult | typeof nothing {
  const { shellView, shellCount } = activeShells(conv);
  if (!shouldShowShellUnavailable(shellView?.status, shellCount))
    return nothing;
  return html`<div class="msg system">
    <div class="notice-note" role="status">
      Background shell details are unavailable.
    </div>
  </div>`;
}
