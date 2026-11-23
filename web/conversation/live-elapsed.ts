// Shares the elapsed-seconds counter between thinking rows and the status bar.
import { html, type TemplateResult } from "lit";
import { statusBarEl, msgsEl } from "../dom.js";

let thinkingElapsedTimer: number | null = null;

function updateThinkingElapsedTimer(): void {
  if (typeof performance === "undefined") return;
  const selector = ".thinking-elapsed[data-thinking-received]";
  const spans = [
    ...msgsEl.querySelectorAll<HTMLElement>(selector),
    ...statusBarEl.querySelectorAll<HTMLElement>(selector),
  ];
  if (!spans.length) {
    if (thinkingElapsedTimer !== null && typeof window !== "undefined") {
      window.clearInterval(thinkingElapsedTimer);
      thinkingElapsedTimer = null;
    }
    return;
  }
  const now = performance.now();
  for (const span of spans) {
    const base = Number(span.dataset.thinkingElapsed ?? "NaN");
    const received = Number(span.dataset.thinkingReceived ?? "NaN");
    if (!Number.isFinite(base) || !Number.isFinite(received)) continue;
    const elapsed = Math.floor((base + Math.max(0, now - received)) / 1000);
    span.textContent =
      span.dataset.thinkingHasTitle === "true"
        ? `${elapsed}s`
        : ` for ${elapsed}s`;
  }
}

function ensureThinkingElapsedTimer(): void {
  if (thinkingElapsedTimer !== null || typeof window === "undefined") return;
  thinkingElapsedTimer = window.setInterval(updateThinkingElapsedTimer, 1000);
}

// The interval changes textContent; keep Lit child markers outside the span.
export function thinkingElapsedT(
  elapsedMs: number,
  hasTitle: boolean,
): TemplateResult {
  ensureThinkingElapsedTimer();
  const received = typeof performance === "undefined" ? 0 : performance.now();
  const seconds = Math.floor(elapsedMs / 1000);
  return html`<span
    class="thinking-elapsed"
    data-thinking-elapsed=${elapsedMs}
    data-thinking-received=${received}
    data-thinking-has-title=${String(hasTitle)}
    role="timer"
    aria-label=${`${seconds} seconds`}
    .textContent=${hasTitle ? `${seconds}s` : ` for ${seconds}s`}
  ></span>`;
}
