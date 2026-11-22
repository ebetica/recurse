// The composer's context control and shortcut open usage for the selected conversation.
import { backendFor } from "./backends/backend.js";
import { backgroundWork } from "./background-work.js";
import { $, el } from "./dom.js";
import { conversationContextTokens } from "./context/tokens.js";
import {
  CONTEXT_SPLIT,
  contextBarSegments,
  contextOverviewLabel,
  ContextRequestFence,
  contextPercent,
  formatContextInteger,
  safeContextDetail,
} from "./context/view-model.js";
import { formatContextTokens } from "./context/tokens.js";
import type { ContextUsageDetail, Conversation } from "./types.js";

const indicator = $<HTMLButtonElement>("#context-indicator");
const mini = $("#context-mini");
const overlay = $("#context-overlay");
const closeButton = $<HTMLButtonElement>("#context-close");
const body = $("#context-body");
const fence = new ContextRequestFence();

interface SelectedContext {
  id: string;
  key: string;
  used: number;
  max: number | null;
}

let selected: SelectedContext | null = null;
let cached: { key: string; detail: ContextUsageDetail } | null = null;
let warmingKey: string | null = null;
let openedFor: string | null = null;
let restoreFocus: HTMLElement | null = null;

function coarseDetail(context: SelectedContext): ContextUsageDetail {
  const unused =
    context.max === null ? null : Math.max(0, context.max - context.used);
  return {
    model: "",
    model_label: "",
    used_tokens: context.used,
    usage_model: null,
    context_window: context.max,
    unused_tokens: unused,
    estimated_tokens: null,
  };
}

function renderStackedBar(host: HTMLElement, detail: ContextUsageDetail): void {
  host.replaceChildren();
  const segments = contextBarSegments(detail);
  host.classList.toggle("empty", segments.length === 0);
  for (const segment of segments) {
    if (segment.basisPoints <= 0) continue;
    const part = el("span", `turn-usage-segment turn-usage-${segment.color}`);
    part.style.width = `${segment.basisPoints / 100}%`;
    part.title = `${segment.label} (estimated): ${formatContextInteger(segment.tokens)} tokens`;
    part.setAttribute("aria-hidden", "true");
    host.appendChild(part);
  }
}

function renderMini(detail = selected ? coarseDetail(selected) : null): void {
  if (!mini || !indicator || !detail) return;
  const { used_tokens: used, context_window: max } = detail;
  if (used === null) return;
  const count = formatContextInteger(used);
  const text =
    max === null
      ? `${count} tokens used; context limit unavailable`
      : `${count} of ${formatContextInteger(max)} tokens used`;
  mini.setAttribute("aria-label", `Context usage: ${text}`);
  indicator.title = `Context usage: ${text}. Open context details (Shift+C).`;
  indicator.setAttribute(
    "aria-label",
    `Latest provider context: ${text}. Open context details.`,
  );
  // An unknown window cannot express a bounded measurement. Keep its exact
  // token count available as an image description instead of inventing a max.
  mini.setAttribute("role", max === null ? "img" : "meter");
  if (max === null) {
    for (const attr of [
      "aria-valuemin",
      "aria-valuemax",
      "aria-valuenow",
      "aria-valuetext",
    ])
      mini.removeAttribute(attr);
  } else {
    mini.setAttribute("aria-valuemin", "0");
    mini.setAttribute("aria-valuemax", String(max));
    mini.setAttribute("aria-valuenow", String(Math.min(used, max)));
    mini.setAttribute("aria-valuetext", text);
    mini.style.setProperty(
      "--context-fill",
      `${Math.min(used / max, 1) * 100}%`,
    );
  }
}

function backgroundKey(context: SelectedContext): string {
  return `context-usage:${context.id}:${context.key}`;
}

async function fetchContextDetail(
  id: string,
  signal: AbortSignal,
): Promise<ContextUsageDetail> {
  const response = await backendFor(id).api(
    `/api/conversations/${encodeURIComponent(id)}/context-usage`,
    { signal },
    { availability: "optional", timeoutMs: 10_000 },
  );
  if (!response.ok) throw new Error("context detail unavailable");
  const value = safeContextDetail(
    (await response.json()) as ContextUsageDetail,
  );
  if (!value) throw new Error("invalid context detail");
  return value;
}

function warmContextDetail(context: SelectedContext): void {
  const key = backgroundKey(context);
  if (warmingKey === key) return;
  warmingKey = key;
  backgroundWork.enqueue(key, async (signal) => {
    const detail = await fetchContextDetail(context.id, signal);
    if (
      signal.aborted ||
      selected?.id !== context.id ||
      selected.key !== context.key
    )
      return;
    cached = { key: context.key, detail };
    renderMini(detail);
  });
}

function closeContextViewer({
  restore = true,
  focusTarget = null,
}: {
  restore?: boolean;
  focusTarget?: HTMLElement | null;
} = {}): void {
  fence.cancel();
  openedFor = null;
  const target = restore ? restoreFocus : focusTarget;
  restoreFocus = null;
  if (target?.isConnected) target.focus({ preventScroll: true });
  overlay?.classList.remove("on");
  if (overlay) overlay.hidden = true;
  indicator?.setAttribute("aria-expanded", "false");
}

function legend(): HTMLElement {
  const host = el("div", "turn-usage-legend");
  for (const { label, color } of CONTEXT_SPLIT) {
    const item = el("span");
    item.append(el("i", `turn-usage-dot turn-usage-${color}`), label);
    host.append(item);
  }
  host.setAttribute("aria-hidden", "true");
  return host;
}

function renderDetail(detail: ContextUsageDetail): void {
  if (!body) return;
  body.replaceChildren();
  const bar = el("div", "turn-usage-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", contextOverviewLabel(detail));
  renderStackedBar(bar, detail);
  if (!bar.classList.contains("empty")) {
    const barLine = el("div", "turn-usage-bar-line");
    barLine.append(bar, legend());
    body.append(barLine);
  }

  const model = detail.model_label || detail.model || "Model unavailable";
  const used = formatContextInteger(detail.used_tokens);
  const capacity = formatContextInteger(detail.context_window);
  const percent = contextPercent(detail.used_tokens, detail.context_window);
  const totals =
    detail.context_window === null
      ? `${model} · ${used} provider-reported tokens · maximum unavailable`
      : `${model} · ${used} of ${capacity} tokens · ${percent} used`;
  body.append(el("p", "turn-usage-totals", totals));
  body.append(
    el(
      "p",
      "turn-usage-cost",
      detail.estimated_tokens
        ? "The total is provider-reported. The System, User prompts, Messages, Tool calls, and Tool outputs split is estimated from text and image sizes."
        : "The total is provider-reported. The estimated System, User prompts, Messages, Tool calls, and Tool outputs split is unavailable.",
    ),
  );
}

export async function openContextViewer(): Promise<void> {
  if (!selected || !indicator || !overlay || !body) return;
  openedFor = selected.id;
  restoreFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : indicator;
  overlay.hidden = false;
  overlay.classList.add("on");
  indicator.setAttribute("aria-expanded", "true");
  body.replaceChildren(el("p", "context-loading", "Loading context details…"));
  closeButton?.focus();
  const context = selected;
  const warmed = cached?.key === context.key ? cached.detail : null;
  if (warmed) {
    renderDetail(warmed);
    return;
  }
  backgroundWork.abandon(backgroundKey(context));
  try {
    const loaded = await fence.load(context.id, fetchContextDetail);
    if (!loaded || openedFor !== context.id || selected?.key !== context.key)
      return;
    cached = { key: context.key, detail: loaded };
    renderMini(loaded);
    renderDetail(loaded);
  } catch {
    if (openedFor === context.id && selected?.key === context.key) {
      body.replaceChildren(
        el("p", "context-error", "Context details are unavailable."),
      );
    }
  }
}

function applyConversationContext(
  conv: Conversation | null,
  label: string | null,
  used: number | null,
  contextWindow: number | null,
  warm = true,
): void {
  if (!indicator) return;
  const max =
    Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0
      ? contextWindow
      : null;
  const next =
    conv && label && used !== null
      ? {
          id: conv.id,
          key: JSON.stringify([
            used,
            max,
            conv.model,
            conv.msg_count,
            conv.message_log_generation,
            conv.thread_generation,
          ]),
          used,
          max,
        }
      : null;
  if (selected?.id !== next?.id || selected?.key !== next?.key) {
    cached = null;
    warmingKey = null;
    if (openedFor !== null)
      closeContextViewer({
        restore: false,
        focusTarget: next ? indicator : $<HTMLElement>("#input"),
      });
  }
  selected = next;
  indicator.classList.toggle("on", next !== null);
  indicator.disabled = next === null;
  renderMini(cached && cached.key === next?.key ? cached.detail : undefined);
  if (next && warm) warmContextDetail(next);
}

export function showConversationContext(
  conv: Conversation | null,
  label: string | null,
  contextWindow: number | null,
): void {
  applyConversationContext(
    conv,
    label,
    conversationContextTokens(conv),
    contextWindow,
  );
}

export function showConversationContextFallback(
  conv: Conversation,
  used: number,
  contextWindow: number | null,
): void {
  const label = formatContextTokens(used);
  if (label === null) return;
  applyConversationContext(conv, label, used, contextWindow, false);
}

indicator?.addEventListener("click", () => {
  void openContextViewer();
});
closeButton?.addEventListener("click", () => closeContextViewer());
overlay?.addEventListener("click", (event) => {
  if (event.target === overlay) closeContextViewer();
});
document.addEventListener(
  "keydown",
  (event) => {
    if (openedFor === null) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeContextViewer();
    } else if (event.key === "Tab" && closeButton) {
      event.preventDefault();
      event.stopPropagation();
      closeButton.focus();
    }
  },
  { capture: true },
);
