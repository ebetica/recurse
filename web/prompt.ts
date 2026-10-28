// Shows captured system prompts and role-aware input: stored Durable text
// before request hooks, or legacy delivered text. Each open refetches;
// banners refresh while assembling. Assistant inspection shows provider
// usage without duplicating visible replies; tools remain inline.
import { backendFor } from "./backends/backend.js";
import { html, render, nothing, type TemplateResult } from "lit";
import { responseDetails } from "./model-response.js";
import { $ } from "./dom.js";
import { copyText, toolDetailStore } from "./tool_details.js";
import { requestKeyboardMode } from "./modal-mode.js";
import {
  activityTotalCostLabel,
  activityUsageCaption,
  type ActivityUsage,
} from "./thread-render/activity-usage.js";
import {
  conversationModelUsage,
  formatCost,
  formatExactTokenCount,
  formatTokenCount,
  turnUsageCaption,
  turnUsageModel,
} from "./thread-render/turn-usage.js";
import type {
  ModelResponse,
  PromptView,
  TurnPromptView,
  TurnUsage,
} from "./types.js";

// The system prompt for the banner. A missing agent (404) -> null.
export function fetchPrompt(cid: string): Promise<PromptView | null> {
  return backendFor(cid)
    .api(`/api/conversations/${cid}/prompt`)
    .then((r) => (r.ok ? (r.json() as Promise<PromptView>) : null))
    .catch(() => null);
}

const overlay = $("#prompt-overlay")!;
const modal = $("#prompt-modal")!;
const closeButton = $("#prompt-close") as HTMLButtonElement;
const bodyEl = $("#prompt-body")!;
const titleEl = $("#prompt-title")!;

// A labelled prompt section: a header with a Copy control and the raw text in a
// scrollable <pre>, so the operator can read AND lift the exact bytes.
function block(label: string, text: string): TemplateResult {
  const copy = async (e: Event) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const copied = await copyText(text);
    btn.textContent = copied ? "Copied" : "Copy failed";
    btn.classList.toggle("copied", copied);
    btn.setAttribute(
      "aria-label",
      copied ? `${label} copied` : `Couldn't copy ${label.toLowerCase()}`,
    );
    setTimeout(() => {
      btn.textContent = "Copy";
      btn.classList.remove("copied");
      btn.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
    }, 1200);
  };
  return html`<section class="prompt-block">
    <div class="prompt-block-head">
      <span>${label}</span>
      <button
        class="prompt-copy"
        type="button"
        aria-live="polite"
        aria-label=${`Copy ${label.toLowerCase()}`}
        @click=${copy}
      >
        Copy
      </button>
    </div>
    <pre>${text}</pre>
  </section>`;
}

// Shows exact Pi prompt/cache composition, never estimated semantic splits.
// Caller captions distinguish answer usage from whole-turn recorded totals.
function usageHeader(
  usage: TurnUsage | null | undefined,
  options: {
    caption?: string;
    selectorLabel: string;
    selectors?: readonly string[];
    selectorPartial?: boolean;
    cost?: number;
    costPartial?: boolean;
    showCost?: boolean;
  },
): TemplateResult {
  const data = turnUsageModel(usage);
  if (!data)
    return html`<section
      class="turn-usage-unavailable"
      aria-label="Token usage unavailable"
    ></section>`;
  const prompt = formatTokenCount(data.promptTokens);
  const output = formatTokenCount(data.output);
  const cacheRead = formatTokenCount(data.cacheRead);
  const cacheWrite = formatTokenCount(data.cacheWrite);
  const uncached = formatTokenCount(data.input + data.cacheWrite);
  const exactPrompt = formatExactTokenCount(data.promptTokens);
  const exactOutput = formatExactTokenCount(data.output);
  const exactInput = formatExactTokenCount(data.input);
  const exactCacheRead = formatExactTokenCount(data.cacheRead);
  const exactCacheWrite = formatExactTokenCount(data.cacheWrite);
  const exactUncached = formatExactTokenCount(data.input + data.cacheWrite);
  const exactTotals =
    `${exactPrompt} input tokens (${exactCacheRead} cache read, ` +
    `${exactUncached} uncached; ${exactCacheWrite} cache write), ` +
    `${exactOutput} output tokens`;
  const exactBar =
    `${exactPrompt} input tokens: ${exactInput} uncached input, ` +
    `${exactCacheWrite} cache write, ${exactCacheRead} cache read`;
  const cost = formatCost(options.cost);
  const costLabel =
    cost === null
      ? "Cost unavailable"
      : `${cost}${options.costPartial ? "+" : ""} cost`;
  const selectors = Array.isArray(options.selectors)
    ? options.selectors
        .filter((value) => typeof value === "string" && value)
        .slice(0, 16)
    : [];
  return html`<section
    class="turn-usage"
    aria-label=${`${options.selectorLabel} usage`}
  >
    ${options.caption
      ? html`<p class="turn-usage-caption">${options.caption}</p>`
      : nothing}
    <p class="turn-usage-selector">
      ${options.selectorLabel} ·
      ${selectors.length ? selectors.join(", ") : "unavailable"}
      ${options.selectorPartial ? " (incomplete)" : ""}
    </p>
    ${data.promptTokens
      ? html`<div class="turn-usage-bar-line">
          <div class="turn-usage-bar" role="img" aria-label=${exactBar}>
            ${data.input
              ? html`<span
                  class="turn-usage-segment turn-usage-input"
                  style=${`width:${data.inputPercent}%`}
                ></span>`
              : nothing}
            ${data.cacheWrite
              ? html`<span
                  class="turn-usage-segment turn-usage-write"
                  style=${`width:${data.cacheWritePercent}%`}
                ></span>`
              : nothing}
            ${data.cacheRead
              ? html`<span
                  class="turn-usage-segment turn-usage-read"
                  style=${`width:${data.cacheReadPercent}%`}
                ></span>`
              : nothing}
          </div>
          <div class="turn-usage-legend" aria-hidden="true">
            <span
              ><i class="turn-usage-dot turn-usage-input"></i>Uncached
              input</span
            >
            <span
              ><i class="turn-usage-dot turn-usage-write"></i>Cache write</span
            >
            <span
              ><i class="turn-usage-dot turn-usage-read"></i>Cache read</span
            >
          </div>
        </div>`
      : nothing}
    <p class="turn-usage-totals" title=${exactTotals}>
      <span aria-hidden="true"
        >${prompt} input tokens (${cacheRead} cache read · ${uncached} uncached;
        ${cacheWrite} cache write) · ${output} output tokens</span
      >
      <span class="sr-only">${exactTotals}</span>
    </p>
    ${options.showCost === false
      ? nothing
      : html`<p class="turn-usage-cost">${costLabel}</p>`}
  </section>`;
}

function assistantUsage(usage: TurnUsage | null | undefined): TemplateResult {
  if (!turnUsageModel(usage))
    return html`<section
      class="turn-usage turn-usage-unavailable"
      aria-label="Conversation model usage unavailable"
    >
      <p class="turn-usage-selector">Conversation model · unavailable</p>
      <p class="turn-usage-cost">Tokens and cost unavailable</p>
    </section>`;
  const selectors =
    usage?.selectorPartial === false && usage.selectors?.length === 1
      ? usage.selectors
      : undefined;
  return usageHeader(usage, {
    caption: turnUsageCaption(null),
    selectorLabel: "Conversation model",
    selectors,
    selectorPartial: selectors ? false : usage?.selectorPartial,
    cost: usage?.cost,
    costPartial: usage?.costPartial ?? usage?.costScopePartial,
  });
}

function paint(view: TurnPromptView | null): void {
  if (!view) {
    render(html`<p class="prompt-msg">Couldn't load this message.</p>`, bodyEl);
    return;
  }
  render(
    view.role === "assistant"
      ? html`${view.model_response
          ? responseDetails(view.model_response)
          : nothing}${assistantUsage(view.usage)}`
      : html` ${view.input_source === "stored"
          ? html`<p class="prompt-msg">
              This is the message as stored. Request hooks, such as clock
              stamps, are added when it is sent to the model.
            </p>`
          : nothing}
        ${view.driving.trim()
          ? block(
              view.input_source === "stored"
                ? "User input as stored"
                : "User input delivered to the model",
              view.driving,
            )
          : nothing}`,
    bodyEl,
  );
}

let token = 0;
let inspectorCid: string | null = null;
let restoreFocus: HTMLElement | null = null;

// Open the modal on a "Loading…" body and return the token this open owns, so a
// slow response cannot paint over a newer open or a close.
function beginModal(cid: string, title: string): number {
  const mine = ++token;
  titleEl.textContent = title;
  if (!overlay.classList.contains("on")) {
    restoreFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }
  if (inspectorCid) toolDetailStore.closeConversation(inspectorCid);
  inspectorCid = cid;
  render(html`<p class="prompt-msg">Loading…</p>`, bodyEl);
  overlay.classList.add("on");
  queueMicrotask(() => closeButton.focus());
  return mine;
}

function current(mine: number): boolean {
  return overlay.classList.contains("on") && mine === token;
}

// Completed-turn totals already rode the conversation poll. This inspector is
// separate from the answer inspector below: it never fetches or reads an
// assistant row, and its caption says exactly how many turn totals it combines.
// `viewInput` opens the block's delivered input in this same inspector.
export function openActivityUsageModal(
  cid: string,
  usage: ActivityUsage,
  conversationModel?: string | null,
  viewInput?: () => void,
  responses: readonly ModelResponse[] = [],
): void {
  beginModal(cid, "Turn usage");
  const conversation = conversationModelUsage(
    usage.modelTotal,
    conversationModel,
  );
  const groupedConversation = conversation?.groups.length
    ? conversation.groups
    : null;
  const caption = activityUsageCaption(usage);
  const totalCostLabel = activityTotalCostLabel(usage);
  render(
    html`
      <p class="turn-usage-caption">${caption}</p>
      ${responses.map(responseDetails)}
      ${groupedConversation?.map((group) =>
        usageHeader(group, {
          selectorLabel: "Conversation model",
          selectors: [group.selector],
          cost: group.cost,
          costPartial: group.costPartial,
        }),
      ) || nothing}
      ${usage.safetyTotal?.groups.map((group) =>
        usageHeader(group, {
          selectorLabel: "Safety reviewer",
          selectors: [group.selector],
          cost: group.cost,
          costPartial: group.costPartial,
        }),
      ) || nothing}
      ${totalCostLabel
        ? html`<p
            class="turn-usage-cost turn-usage-total-cost"
            aria-label="Conversation model total cost"
          >
            ${totalCostLabel}
          </p>`
        : nothing}
      ${viewInput
        ? html`<button class="prompt-copy" type="button" @click=${viewInput}>
            View delivered input
          </button>`
        : nothing}
    `,
    bodyEl,
  );
}

export async function openTurnPromptModal(
  cid: string,
  offset: number,
): Promise<void> {
  const mine = beginModal(cid, "Message details");
  const view = await backendFor(cid)
    .api(`/api/conversations/${cid}/turn-prompt?offset=${offset}`)
    .then((r) => (r.ok ? (r.json() as Promise<TurnPromptView>) : null))
    .catch(() => null);
  if (current(mine)) paint(view);
}

export function closePrompt(): boolean {
  if (!overlay.classList.contains("on")) return false;
  overlay.classList.remove("on");
  token++;
  if (inspectorCid) toolDetailStore.closeConversation(inspectorCid);
  inspectorCid = null;
  render(nothing, bodyEl);
  const target = restoreFocus;
  restoreFocus = null;
  if (target?.isConnected) target.focus();
  return true;
}
export function promptOpen(): boolean {
  return overlay.classList.contains("on");
}
closeButton.onclick = closePrompt;
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) closePrompt();
});
document.addEventListener(
  "keydown",
  (e) => {
    if (!overlay.classList.contains("on")) return;
    if (e.key === "Escape") {
      closePrompt();
      requestKeyboardMode("normal");
    }
    if (e.key === "Tab") {
      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hidden);
      if (!focusable.length) {
        e.preventDefault();
        closeButton.focus();
      } else {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            !modal.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !modal.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    e.stopPropagation();
    e.stopImmediatePropagation();
  },
  true,
);
