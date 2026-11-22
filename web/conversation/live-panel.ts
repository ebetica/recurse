// Renders the live panel outside the thread; owns title/tool-label timers.
// A running turn keeps its latest thought beside long-running tools.
// Only readable prose expands the thought; the end of the turn clears it.
import { html, nothing, render, type TemplateResult } from "lit";
import {
  containsSecret,
  oneLine,
} from "../../src/tool_projection/redaction.js";
import { activeAgentSummary, activeDescendantCount } from "../active-agents.js";
import { liveBarEl } from "../dom.js";
import { rowThreads } from "../row-thread-state/index.js";
import { state } from "../state.js";
import { thinkingStore } from "./thinking.js";
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
  type LiveActivityRow,
  type LiveTitleState,
} from "../thread-render/tool_activity.js";
import type { Conversation } from "../types.js";
import { thinkingElapsedT } from "./live-elapsed.js";
import { activeShells, agentChipT, shellChipT } from "./shell-surface.js";
import { paint } from "../thread-render/index.js";

// Streaming, queued and waiting share one panel with the shell/agent chips.
function panelBoxT(
  conv: Conversation,
  mood: string,
  label: TemplateResult,
  ariaLabel: string,
  stopping = false,
  summary: TemplateResult | typeof nothing = nothing,
  toolControl: TemplateResult | typeof nothing = nothing,
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
          ${label}
          ${toolControl !== nothing || shellLabel || agentLabel
            ? html`<div class="live-panel-actions">
                ${toolControl}${shellChipT(
                  conv,
                  shellLabel,
                  paint,
                )}${agentChipT(conv, agentLabel, paint)}
              </div>`
            : nothing}
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
let lastThought:
  | {
      cid: string;
      generation: number | undefined;
      run: Conversation["active_run_start"];
      row: LiveActivityRow;
    }
  | undefined;

function liveActivityFor(conv: Conversation) {
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
  return liveActivityState(
    thread?.rows ?? [],
    conv.provider_starting == null,
    latest ? row : undefined,
    conv.active_run_start,
  );
}

// The bar owns running counts only while its delayed tool label is visible.
export function liveToolLabelVisible(
  conv: Conversation,
  elapsedMs: number,
): boolean {
  return (
    elapsedMs >= TOOL_LABEL_DELAY_MS &&
    conv.status === "running" &&
    state.stopPostInFlightId !== conv.id &&
    !conv.retry_notice
  );
}

// Long-running tools yield a stable label; quick calls keep the thinking line.
// Stop overlays and retry notices retain priority.
export function workingT(conv: Conversation): TemplateResult {
  const rows = rowThreads.get(conv.id)?.rows ?? [];
  const panel = liveActivityFor(conv);
  lastThought = panel.thinkingRow && {
    cid: conv.id,
    generation: conv.message_log_generation,
    run: conv.active_run_start,
    row: panel.thinkingRow,
  };
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
  const pill = thinkingStore.syncPill(conv, panel.thinkingRow, (text) =>
    thinkingSummaryBody(text, panel.title),
  );
  const toggleThinking =
    !overlay && !retryNotice && pill?.text
      ? () => thinkingStore.togglePill(pill.key)
      : null;
  const thinkingText = toggleThinking && pill?.expanded ? pill.text : "";
  const showTools = liveToolLabelVisible(conv, longest);
  const separateTools =
    showTools && !!panel.thinkingRow?.thinking_title?.trim();
  const mainShowsTools = showTools && !separateTools;
  const toolLabel = showTools ? runningToolsLabel(tools, !separateTools) : "";
  const title =
    overlay ?? retryNotice ?? (mainShowsTools ? toolLabel : panel.title);
  const label =
    overlay ?? retryNotice ?? (mainShowsTools ? toolLabel : panel.label);
  const toolsKey = `${conv.id}\0${conv.active_run ?? panel.key.split("\0", 1)[0]}`;
  if (!tools.length) expandedToolsKey = null;
  const toolsExpanded = showTools && expandedToolsKey === toolsKey;
  const titleState = (() => {
    if (title === "Waiting") return { title, changed: false };
    if (panel.kind !== "thinking" || overlay || retryNotice || mainShowsTools)
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
    (mainShowsTools || panel.thinkingElapsedMs !== undefined)
      ? thinkingElapsedT(
          mainShowsTools ? longest : panel.thinkingElapsedMs!,
          mainShowsTools || titleState.title !== "Thinking",
        )
      : nothing;
  const toggleTools = () => {
    expandedToolsKey = toolsExpanded ? null : toolsKey;
    paint(conv);
  };
  const thinkingPrefix =
    panel.kind === "thinking" &&
    !mainShowsTools &&
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
  const labelT =
    mainShowsTools || toggleThinking
      ? html`<button
          class="live-label${mainShowsTools
            ? ""
            : " live-thinking-copy"}${titleState.changed
            ? " live-title-changing"
            : ""}"
          type="button"
          title=${titleState.title}
          aria-expanded=${String(
            mainShowsTools ? toolsExpanded : !!thinkingText,
          )}
          @click=${mainShowsTools ? toggleTools : toggleThinking}
        >
          ${head}
        </button>`
      : html`<span
          class="live-label${titleState.changed ? " live-title-changing" : ""}"
          title=${titleState.title}
          >${head}</span
        >`;
  const toolControl = separateTools
    ? html`<button
        class="live-label live-tool-status"
        type="button"
        aria-expanded=${String(toolsExpanded)}
        @click=${toggleTools}
      >
        ${toolLabel}
      </button>`
    : nothing;
  const summary = html`${thinkingText
    ? html`<div
        class="live-thinking-summary"
        tabindex="0"
        role="region"
        aria-label="Live thinking"
        .textContent=${thinkingText}
      ></div>`
    : nothing}${toolsExpanded
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
    : nothing}`;
  const mood = overlay
    ? "is-overlay"
    : retryNotice
      ? "is-retrying"
      : panel.kind === "thinking"
        ? thinkingText
          ? "is-thinking has-thinking-summary is-expanded"
          : "is-thinking"
        : "";
  return panelBoxT(conv, mood, labelT, label, stopping, summary, toolControl);
}

/** Follow new thinking until the reader scrolls away from the bottom. */
export function renderLivePanel(panel: TemplateResult | null): void {
  const selector = ".live-thinking-summary";
  const previous = liveBarEl.querySelector<HTMLElement>(selector);
  const follow =
    !previous ||
    previous.scrollHeight - previous.clientHeight - previous.scrollTop <= 1;
  const previousText = previous?.textContent;
  render(panel ?? nothing, liveBarEl);
  liveBarEl.hidden = !panel;
  const summary = liveBarEl.querySelector<HTMLElement>(selector);
  if (
    summary &&
    follow &&
    (summary !== previous || summary.textContent !== previousText)
  )
    summary.scrollTop = summary.scrollHeight;
}

export function clearLivePanel(): void {
  lastThought = undefined;
  thinkingStore.clearPill();
  if (toolLabelTimer !== null) window.clearTimeout(toolLabelTimer);
  toolLabelTimer = null;
  expandedToolsKey = null;
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
