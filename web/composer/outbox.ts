// Saved-agent sends persist before the composer clears. Per-message keys avoid
// cross-tab lost updates; the shared browser lock fences delivery and removal.
// Retries retain the server's idempotency key and serialize each recipient.
import { html } from "lit";
import { parseConversationId } from "../backends/backend.js";
import { withCommentLock } from "../artifacts/comment-lock.js";
import { userBubble } from "../thread-render.js";
import { pendingMessageRemoveButton } from "../pending-queue/pending-message.js";

export interface SavedSend {
  convId: string;
  content: string;
  attachmentIds: string[];
  clientId: string;
  sinceOffset: number;
  created: number;
  failed: boolean;
  error?: string;
}
const PREFIX = "recurse-composer-outbox-v1:";
const entries = new Map<string, SavedSend>();

function valid(value: unknown): value is SavedSend {
  if (!value || typeof value !== "object") return false;
  const send = value as SavedSend;
  try {
    if (
      typeof send.convId !== "string" ||
      send.convId.length > 128 ||
      !/^[A-Za-z0-9_-]+$/.test(parseConversationId(send.convId).cid)
    )
      return false;
  } catch {
    return false;
  }
  return (
    typeof send.content === "string" &&
    send.content.length <= 2_000_000 &&
    typeof send.clientId === "string" &&
    /^[A-Za-z0-9._-]{1,64}$/.test(send.clientId) &&
    Array.isArray(send.attachmentIds) &&
    send.attachmentIds.length <= 50_000 &&
    send.attachmentIds.every(
      (id) =>
        typeof id === "string" &&
        /^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(id),
    ) &&
    Number.isFinite(send.sinceOffset) &&
    send.sinceOffset >= 0 &&
    Number.isFinite(send.created) &&
    typeof send.failed === "boolean" &&
    (send.error === undefined || typeof send.error === "string")
  );
}

function readSend(key: string): void {
  entries.delete(key);
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 8_000_000) return;
    const send: unknown = JSON.parse(raw);
    if (valid(send) && key === PREFIX + send.clientId) entries.set(key, send);
  } catch {}
}

export const outboxReady = new Promise<void>((resolve) => {
  let index = 0;
  const batch = () => {
    try {
      const end = Math.min(localStorage.length, index + 64);
      for (; index < end; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(PREFIX)) readSend(key);
      }
      if (index < localStorage.length) {
        setTimeout(batch, 0);
        return;
      }
    } catch {}
    resolve();
    window.dispatchEvent(new Event("recurse:composer-outbox-change"));
  };
  setTimeout(batch, 0);
});

window.addEventListener("storage", (event) => {
  if (!event.key) {
    entries.clear();
  } else if (event.key.startsWith(PREFIX)) readSend(event.key);
  else return;
  window.dispatchEvent(new Event("recurse:composer-outbox-change"));
});

export function savedSends(): SavedSend[] {
  for (const key of Array.from(entries.keys())) readSend(key);
  return [...entries.values()].sort(
    (a, b) => a.created - b.created || a.clientId.localeCompare(b.clientId),
  );
}

export function persistSend(send: SavedSend): void {
  if (!valid(send)) throw new Error("Message could not be saved");
  const key = PREFIX + send.clientId;
  localStorage.setItem(key, JSON.stringify(send));
  entries.set(key, send);
}

export function forgetSend(clientId: string): void {
  const key = PREFIX + clientId;
  localStorage.removeItem(key);
  entries.delete(key);
}

export function withSendLock(
  convId: string,
  work: () => Promise<void>,
): Promise<void> {
  return withCommentLock("recurse-composer-send:" + convId, async (check) => {
    check();
    await work();
    check();
  });
}

export function outboxBubbles(convId: string) {
  return savedSends()
    .filter((send) => send.convId === convId)
    .map((send) => {
      const note = send.failed
        ? html`<div class="thread-marker pending"><span>Not sent</span></div>`
        : "";
      return html`<div
        class="msg user pending"
        data-client-message-id=${send.clientId}
      >
        ${pendingMessageRemoveButton(() =>
          window.dispatchEvent(
            new CustomEvent("recurse:remove-pending-send", {
              detail: send.clientId,
            }),
          ),
        )}
        <div class="bubble">${userBubble(send.content)}${note}</div>
      </div>`;
    });
}
