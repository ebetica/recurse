// The native button used beside a queued message. Keep the label and the
// cancellability rule here so the DOM-free frontend tests can pin the
// accessible control without importing conversation.ts (which owns live browser
// state).
import { html, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { CLOSE_ICON } from "../icons.js";
import { splitHiddenFrame } from "../thread-render/turn-view.js";

export const REMOVE_QUEUED_MESSAGE_LABEL = "Remove queued message";
export const RETRY_QUEUED_MESSAGE_LABEL = "Retry sending queued message";

// Compact failed-send wording; raw backend text remains in the tooltip.
const STOPPED_BEFORE_SEND_RE = /stopped before provider input/i;
const NOT_DELIVERED_RE =
  /^(not delivered|the server restarted while sending)\b/i;
const PROSE_START_RE = /^[A-Z][a-z]/;
const FAILURE_REASON_MAX = 160;

export function sendFailureCopy(error?: string | null): string {
  const raw = typeof error === "string" ? error.trim() : "";
  if (!raw) return "Not delivered — the send failed before Pi accepted it.";
  if (STOPPED_BEFORE_SEND_RE.test(raw))
    return "Not delivered — stopped before Pi accepted it.";
  const oneLine = raw.replace(/\s+/g, " ").slice(0, FAILURE_REASON_MAX);
  if (NOT_DELIVERED_RE.test(oneLine)) return oneLine;
  const reason = PROSE_START_RE.test(oneLine)
    ? oneLine.charAt(0).toLowerCase() + oneLine.slice(1)
    : oneLine;
  return `Not delivered — ${reason}`;
}

export function isFailedPending(message: {
  error?: string | null;
  uncertain?: boolean;
}): boolean {
  // Invariant: A send the driver flagged non-dispatchable (e.g. no API key for
  // the provider): the user's message stays visible with its failure, retryable
  // under its own id, cancellable like any queued row. Never auto-resent.
  return Boolean(message.uncertain || message.error);
}

// Whether an admitted-but-undispatched send is still waiting on the
// agent: any queued row that is not a failure. Failure rows carry their
// own retry UI, so they never count toward the queued indicator.
export function hasSendablePending(
  messages: readonly { error?: string | null; uncertain?: boolean }[],
): boolean {
  return messages.some((message) => !isFailedPending(message));
}

export function isDeliveryReceipt(message: {
  delivery_state?: string;
}): boolean {
  // Invariant: Receipts acknowledge input; only the Pi transcript renders
  // delivered text.
  return (
    message.delivery_state === "accepted" ||
    message.delivery_state === "materialized"
  );
}

export function canRemovePendingMessage(message: { steer?: boolean }): boolean {
  // Invariant: A steer has crossed the non-rollbackable Pi stdin boundary.
  // Removing it from Recurse at that point could hide input Pi still delivers,
  // so only inbox rows retain the control.
  return !message.steer;
}

export function removeOptimisticMessageById<T extends { id?: string }>(
  messages: readonly T[],
  id: string,
): T[] {
  return messages.filter((message) => message.id !== id);
}

export function isPendingEcho(
  optimistic: { id?: string; content: string },
  pending: { id?: string; content: string },
): boolean {
  // Invariant: Current servers give every optimistic item a durable id. Content
  // matching remains only for rolling replacement with an older server.
  return optimistic.id
    ? optimistic.id === pending.id
    : optimistic.content === pending.content;
}

// Matches receipt-stripped text on both sides, mirroring backend retirement.
const DELIVERY_TRAILER_TAIL =
  /\n?\[recurse-delivery:[A-Za-z0-9_.:-]{1,128}\]\s*$/;

export function stripDeliveryTrailer(content: string): string {
  return content.replace(DELIVERY_TRAILER_TAIL, "");
}

// The committed row stores the whole prompt: platform context ahead of a
// "## Message" frame line, then the operator's text. Identity compares the
// text the operator sent, so the frame comes off first (then the receipt).
export function committedMessageIdentity(content: string): string {
  return stripDeliveryTrailer(splitHiddenFrame(content));
}

export interface OptimisticEntry {
  content: string;
  id?: string;
  ts: number;
  lastTrace: number;
  sinceOffset: number;
  seq: number;
  echoed: boolean;
  // Echoed identities survive TTL until committed rows retire them.
  confirmed?: boolean;
}

export interface CommittedCandidate {
  content: unknown;
  offset: number;
  from?: string | null;
}

interface PendingCandidate {
  id?: string;
  content: string;
  delivery_state?: string;
}

// Reconciles optimistic sends oldest-first against content past their floor.
// Each repeated send needs its own committed row; echoed identities survive
// rebuilds/receipt lapses, while never-echoed entries retain a TTL backstop.
export function pruneOptimisticEntries(
  entries: readonly OptimisticEntry[],
  pending: readonly PendingCandidate[],
  committed: readonly CommittedCandidate[],
  now: number,
  ttlMs: number,
): OptimisticEntry[] {
  const open = [...pending];
  const consumedCommitted = new Set<number>();
  const kept: OptimisticEntry[] = [];
  for (const entry of entries) {
    if (!entry.confirmed && now - entry.lastTrace > ttlMs) continue;
    const echo = open.findIndex((message) => isPendingEcho(entry, message));
    if (echo >= 0) {
      const echoed = open.splice(echo, 1)[0]!;
      // Invariant: Receipts acknowledge input, not user prose. Keep optimistic
      // text until its committed row arrives so the hand-off never loses the
      // message.
      kept.push({
        ...entry,
        echoed: !isDeliveryReceipt(echoed),
        lastTrace: now,
        confirmed: true,
      });
      continue;
    }
    let committedRow = false;
    const want = stripDeliveryTrailer(entry.content);
    for (const row of committed) {
      if (
        typeof row.offset !== "number" ||
        row.offset <= entry.sinceOffset ||
        consumedCommitted.has(row.offset) ||
        row.from ||
        typeof row.content !== "string"
      )
        continue;
      if (committedMessageIdentity(row.content) !== want) continue;
      consumedCommitted.add(row.offset);
      committedRow = true;
      break;
    }
    if (!committedRow) kept.push({ ...entry, echoed: false });
  }
  return kept;
}

// A server echo acknowledges the send, even when its receipt is not rendered.
// Entries the server never echoed are still queued locally.
export function visibleOptimisticEntries(
  entries: readonly OptimisticEntry[],
): OptimisticEntry[] {
  return entries.filter((entry) => !entry.echoed && !entry.confirmed);
}

// Accepted by the agent: echoed once, gone from the server queue, and no
// committed row yet. Live tool rows can arrive before the session file is
// read back, so these render as delivered bubbles ahead of the live turn
// rather than as queued input trailing it.
export function acceptedOptimisticEntries(
  entries: readonly OptimisticEntry[],
): OptimisticEntry[] {
  return entries.filter((entry) => !entry.echoed && entry.confirmed === true);
}

function queuedMessageButton(
  kind: "cancel" | "dismiss",
  remove: (event: Event) => void,
): TemplateResult {
  return html`<button
    class=${kind === "dismiss"
      ? "btn sm pending-dismiss"
      : "icon-btn pending-cancel"}
    type="button"
    title=${REMOVE_QUEUED_MESSAGE_LABEL}
    aria-label=${REMOVE_QUEUED_MESSAGE_LABEL}
    @click=${remove}
  >
    ${kind === "dismiss" ? html`Dismiss` : unsafeHTML(CLOSE_ICON)}
  </button>`;
}

export function pendingMessageRemoveButton(
  remove: (event: Event) => void,
): TemplateResult {
  return queuedMessageButton("cancel", remove);
}

// Dismiss removes the queued message like the close button, but uses a
// footer text button so the failure line has no floating close control.
export function pendingMessageDismissButton(
  dismiss: (event: Event) => void,
): TemplateResult {
  return queuedMessageButton("dismiss", dismiss);
}
