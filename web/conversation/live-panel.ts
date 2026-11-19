// Renders the live panel outside the thread; owns title/tool-label timers.
// Invariant: the thread renders before the live bar, so its template marks
// thinking text already rendered there before workingT reads it.
import { html, nothing, type TemplateResult } from "lit";
import {
  containsSecret,
  oneLine,
} from "../../src/tool_projection/redaction.js";
import { activeAgentSummary, activeDescendantCount } from "../active-agents.js";
import { rowThreads } from "../row-thread-state/index.js";
import { state } from "../state.js";
import { thinkingStore } from "./thinking.js";
import { showsCommittedStep } from "./thinking-paint.js";
import type { ActivityBoundary } from "../thread-render/activity-boundary.js";
import {
  shellSummary,
  shouldShowShellUnavailable,
} from "../thread-render/background-shells.js";
import {
  runningToolLabel,
  runningTools,
  runningToolsLabel,
  TOOL_LABEL_DELAY_MS,
} from "../thread-render/running-tools.js";
import {
  holdLiveTitle,
  liveActivityState,
  thinkingSummaryBody,
  thinkingSummaryTail,
  type LiveTitleState,
} from "../thread-render/tool_activity.js";
import type { Conversation } from "../types.js";
import { thinkingElapsedT } from "./live-elapsed.js";
import { activeShells, agentChipT, shellChipT } from "./shell-surface.js";
import { paint } from "./thread.js";

// The one thinking banner's shared box: pulsing dot, label slot, and the
// shell/agent chips on the right. Streaming and waiting states render the
// same component in the same position and differ only in label and mood.
function panelBoxT(
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
      class="working live-panel${stopping ? " stopping" : ""}"
      role="group"
      aria-label=${groupLabel}
    >
      <div class="live-panel-box ${mood}" role="group">
        <div class="live-panel-head">
          <span class="live-dot" aria-hidden="true"></span>
          ${label}
          ${shellChipT(conv, shellLabel, paint)}${agentChipT(
            conv,
            agentLabel,
            paint,
          )}
        </div>
        ${summary}
      </div>
    </div>
  </div>`;
}

const liveTitleStates = new Map<string, LiveTitleState>();
const LIVE_TITLE_STATE_LIMIT = 128;
let toolLabelTimer: number | null = null;
let expandedToolsKey: string | null = null;

// The bar owns running counts only while its delayed tool label is visible.
export function liveToolLabelVisible(
  conv: Conversation,
  elapsedMs: number,
): boolean {
  return (
    elapsedMs >= TOOL_LABEL_DELAY_MS &&
    !liveActivityState(rowThreads.get(conv.id)?.rows ?? []).hasThinking &&
    conv.status === "running" &&
    state.stopPostInFlightId !== conv.id &&
    !conv.retry_notice
  );
}

// Long-running tools yield a stable label; quick calls keep the thinking line.
// Stop overlays and retry notices retain priority.
export function workingT(
  conv: Conversation,
  boundary?: ActivityBoundary,
): TemplateResult {
  const rows = rowThreads.get(conv.id)?.rows ?? [];
  const panel = liveActivityState(rows, conv.provider_starting == null);
  const retryNotice = conv.retry_notice;
  const tools = runningTools(rows, performance.now());
  const longest = Math.max(0, ...tools.map((tool) => tool.elapsedMs));
  const toolVisible = longest >= TOOL_LABEL_DELAY_MS;
  if (toolLabelTimer !== null) window.clearTimeout(toolLabelTimer);
  toolLabelTimer =
    tools.length && !toolVisible
      ? window.setTimeout(() => {
          toolLabelTimer = null;
          if (state.currentConv?.id === conv.id) paint(state.currentConv);
        }, TOOL_LABEL_DELAY_MS - longest)
      : null;
  const stopping =
    conv.status === "interrupting" || state.stopPostInFlightId === conv.id;
  const overlay = stopping ? "Interrupting this turn…" : null;
  const pillKey = thinkingStore.syncPill(
    conv,
    rows,
    overlay || retryNotice ? "" : panel.kind,
    boundary,
  );
  const thinkingEntry =
    pillKey === null ? undefined : thinkingStore.get(pillKey);
  const thinkingFull = thinkingEntry?.text;
  const thinkingExpanded = !!thinkingEntry?.open;
  const thinkingText =
    thinkingExpanded &&
    !showsCommittedStep(pillKey) &&
    typeof thinkingFull === "string"
      ? thinkingSummaryBody(thinkingFull, panel.title)
      : "";
  const label = overlay ?? retryNotice ?? panel.label;
  const showTools = liveToolLabelVisible(conv, longest);
  const title =
    overlay ??
    retryNotice ??
    (showTools ? runningToolsLabel(tools) : panel.title);
  const toolsKey = `${conv.id}\0${conv.active_run ?? panel.key.split("\0", 1)[0]}`;
  if (!tools.length) expandedToolsKey = null;
  const toolsExpanded = showTools && expandedToolsKey === toolsKey;
  const titleState = (() => {
    if (title === "Waiting") return { title, changed: false };
    if (panel.kind !== "thinking" || overlay || retryNotice || showTools)
      return { title, changed: false };
    const now = typeof performance === "undefined" ? 0 : performance.now();
    const turnKey = panel.key.split("\0", 1)[0] ?? panel.key;
    const previous = liveTitleStates.get(conv.id);
    if (!previous && liveTitleStates.size >= LIVE_TITLE_STATE_LIMIT) {
      const oldest = liveTitleStates.keys().next().value;
      if (typeof oldest === "string") liveTitleStates.delete(oldest);
    }
    const held = holdLiveTitle(previous, turnKey, panel.title, now);
    liveTitleStates.set(conv.id, held.state);
    return { title: held.state.title, changed: held.changed };
  })();
  const elapsed =
    overlay === null &&
    !retryNotice &&
    panel.kind === "thinking" &&
    (toolVisible || panel.thinkingElapsedMs !== undefined)
      ? thinkingElapsedT(
          toolVisible ? longest : panel.thinkingElapsedMs!,
          toolVisible || titleState.title !== "Thinking",
        )
      : nothing;
  const hasSummary =
    pillKey !== null &&
    typeof thinkingFull === "string" &&
    Boolean(thinkingSummaryTail(thinkingFull));
  const toggle = showTools
    ? () => {
        expandedToolsKey = toolsExpanded ? null : toolsKey;
        paint(conv);
      }
    : pillKey !== null
      ? () => thinkingStore.togglePill(pillKey)
      : null;
  const canToggle =
    showTools ||
    (panel.kind === "thinking" &&
      pillKey !== null &&
      (thinkingEntry?.text === undefined ||
        thinkingEntry.source !== thinkingStore.pill?.entry.offset ||
        hasSummary ||
        thinkingExpanded));
  const thinkingPrefix =
    panel.kind === "thinking" &&
    !showTools &&
    !overlay &&
    !retryNotice &&
    !["Thinking", "Waiting"].includes(titleState.title)
      ? `${panel.thinkingActive === false ? "Waiting" : "Thinking"} ·\u00a0`
      : nothing;
  const head = html`<span class="live-thinking-head"
    >${thinkingPrefix}<span class="live-thinking-title"
      >${titleState.title}</span
    >${elapsed}</span
  >`;
  const labelT = canToggle
    ? html`<button
        class="live-label live-thinking-copy${titleState.changed
          ? " live-title-changing"
          : ""}"
        type="button"
        title=${titleState.title}
        aria-expanded=${String(showTools ? toolsExpanded : thinkingExpanded)}
        @click=${() => toggle?.()}
      >
        ${head}
      </button>`
    : html`<span
        class="live-label${titleState.changed ? " live-title-changing" : ""}"
        title=${titleState.title}
        >${head}</span
      >`;
  const summary = toolsExpanded
    ? html`<div class="live-tool-body">
        ${tools.map(({ row, elapsedMs }) => {
          const command =
            containsSecret(row.args) || containsSecret(row.input || "")
              ? "Command withheld"
              : row.args || runningToolLabel(row);
          const output = row.tool_output_tail ?? row.result ?? "";
          const tail = containsSecret(output)
            ? "Output withheld"
            : output.split("\n").slice(-5).map(oneLine).join("\n");
          return html`<div class="live-tool-row">
            <div class="live-tool-head">
              <code>${command}</code>${thinkingElapsedT(elapsedMs, true)}
            </div>
            ${tail ? html`<pre>${tail}</pre>` : nothing}
          </div>`;
        })}
      </div>`
    : thinkingText
      ? html`<div class="live-thinking-summary">${thinkingText}</div>`
      : nothing;
  const mood = overlay
    ? "is-overlay"
    : retryNotice
      ? "is-retrying"
      : panel.kind === "thinking"
        ? thinkingText
          ? "is-thinking has-thinking-summary is-expanded"
          : "is-thinking"
        : "";
  return panelBoxT(conv, mood, labelT, label, stopping, summary);
}

// Renders admitted-but-undispatched input as queued, not dead or working. It
// replaces the live panel, never sits beside it; failures keep retry UI.
export function queuedT(conv: Conversation): TemplateResult {
  const label = "Queued…";
  return panelBoxT(
    conv,
    "is-queued",
    html`<span class="live-label" title=${label} aria-hidden="true"
      >${label}</span
    >`,
    label,
  );
}

// A stopped turn with continued background work keeps the same banner in the
// same position, reading Waiting… with the shell/agent chips on the right.
// Plain words for a continued state, never the backend status word.
export function waitingPanelT(conv: Conversation): TemplateResult {
  const label = "Waiting…";
  return panelBoxT(
    conv,
    "is-waiting",
    html`<span class="live-label" title=${label} aria-hidden="true"
      >${label}</span
    >`,
    label,
  );
}

// The poll-fed shell record reports when its details cannot load. That notice
// keeps its text row at the thread tail; the chips themselves live only in
// the panel, so they never render down here.
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
