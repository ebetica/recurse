// Comments persist before the viewer closes, with crops and idempotency keys.
// comment-lock.ts serializes upload/send/discard across tabs even on HTTP,
// without a lease expiring and exposing a paused send's crops to deletion.
// Crop identity and recipient stay fixed; saved bytes are indexed by send.
import { html, type TemplateResult } from "lit";
import {
  backendFor,
  parseConversationId,
  resolveUrl,
} from "../backends/backend.js";
import { state } from "../state.js";
import { paint } from "../conversation/thread.js";
import {
  deliverQueuedOperatorMessage,
  startOperatorSend,
} from "../conversation/operator-send.js";
import { addOptimisticPending } from "../pending-queue.js";
import { refreshConv } from "../conversation/fetch.js";
import { uploadBlob, type PreparedCrop } from "./comment-crops.js";
import { readCrop, removeCrop, saveCrop } from "./crop-store.js";
import { withCommentLock } from "./comment-lock.js";

interface Crop {
  token: string;
  filename: string;
  key?: string;
  expires?: number;
  url?: string;
}
export interface CommentSend {
  recipient: string;
  text: string;
  snapshot: string;
  count: number;
  clientId: string;
  sinceOffset: number;
  withoutImages?: boolean;
  deliveryMode?: "images" | "text";
  admitted?: boolean;
  discarding?: boolean;
  messageId?: string;
  activity?: string;
  crops: Crop[];
}
interface Send {
  data: CommentSend;
  crops: (PreparedCrop | null)[];
  failed: boolean;
  busy: boolean;
  missingCrop?: boolean;
  checkLock?: () => void;
  waitingForLock?: boolean;
  storageChanged?: boolean;
  observing?: boolean;
}
const PREFIX = "recurse-comment-outbox-v1:";
const sends: Send[] = [];
function validAttachmentUrl(url: string, recipient: string): boolean {
  const match =
    /^\/api\/(?:attachments|conversations\/([A-Za-z0-9_-]+)\/attachments)\/[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.exec(
      url,
    );
  return (
    !!match && (!match[1] || match[1] === parseConversationId(recipient).cid)
  );
}
function validSend(value: unknown): value is CommentSend {
  if (!value || typeof value !== "object") return false;
  const send = value as CommentSend;
  if (
    typeof send.recipient !== "string" ||
    send.recipient.length > 128 ||
    !send.recipient ||
    typeof send.text !== "string" ||
    send.text.length > 2_000_000 ||
    typeof send.snapshot !== "string" ||
    send.snapshot.length > 2_000_000 ||
    typeof send.clientId !== "string" ||
    !/^c-[a-z0-9]+-[a-z0-9]+$/.test(send.clientId) ||
    send.clientId.length > 128 ||
    !Number.isInteger(send.count) ||
    send.count < 1 ||
    send.count > 1000 ||
    !Number.isFinite(send.sinceOffset) ||
    (send.withoutImages !== undefined &&
      typeof send.withoutImages !== "boolean") ||
    (send.deliveryMode !== undefined &&
      send.deliveryMode !== "images" &&
      send.deliveryMode !== "text") ||
    (send.admitted !== undefined && typeof send.admitted !== "boolean") ||
    (send.discarding !== undefined && typeof send.discarding !== "boolean") ||
    (send.messageId !== undefined &&
      (typeof send.messageId !== "string" || send.messageId.length > 128)) ||
    (send.activity !== undefined &&
      (typeof send.activity !== "string" ||
        !/^[a-f0-9]{32}$/.test(send.activity))) ||
    !Array.isArray(send.crops) ||
    send.crops.length > 1000
  )
    return false;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(parseConversationId(send.recipient).cid))
      return false;
  } catch {
    return false;
  }
  return send.crops.every((crop) => {
    if (
      !crop ||
      typeof crop.token !== "string" ||
      crop.token.length > 128 ||
      typeof crop.filename !== "string" ||
      crop.filename.length > 256 ||
      (crop.key === undefined) !== (crop.expires === undefined) ||
      (crop.key !== undefined &&
        (typeof crop.key !== "string" ||
          !/^[a-f0-9]{32}$/.test(crop.key) ||
          !Number.isSafeInteger(crop.expires) ||
          crop.expires! < 1_000_000_000_000 ||
          crop.expires! > 9_999_999_999_999)) ||
      (crop.url !== undefined &&
        (typeof crop.url !== "string" ||
          !validAttachmentUrl(crop.url, send.recipient)))
    )
      return false;
    return true;
  });
}
function persist(send: Send): void {
  send.checkLock?.();
  const key = PREFIX + send.data.clientId;
  const added = localStorage.getItem(key) === null;
  localStorage.setItem(key, JSON.stringify(send.data));
  if (added) scheduleRestore(true);
}
function removeSend(key: string): void {
  const existed = localStorage.getItem(key) !== null;
  localStorage.removeItem(key);
  if (existed) scheduleRestore(true);
}
let restoreIndex = 0;
let restoreLength = 0;
let restoreLastKey: string | null = null;
let restoreScheduled = false;
let restoreActive = false;
let restoreDirty = false;
function scheduleRestore(restart = false): void {
  if (restart) {
    if (restoreActive) restoreDirty = true;
    else {
      restoreIndex = 0;
      restoreActive = true;
    }
  }
  if (restoreScheduled) return;
  restoreScheduled = true;
  setTimeout(restoreBatch, 0);
}
function restoreBatch(): void {
  restoreScheduled = false;
  try {
    if (
      restoreIndex &&
      (restoreLength !== localStorage.length ||
        localStorage.key(restoreIndex - 1) !== restoreLastKey)
    )
      restoreDirty = true;
    restoreLength = localStorage.length;
    const end = Math.min(restoreLength, restoreIndex + 64);
    for (; restoreIndex < end; restoreIndex++) {
      const key = localStorage.key(restoreIndex);
      restoreLastKey = key;
      if (!key?.startsWith(PREFIX)) continue;
      if (!sends.some((send) => key === PREFIX + send.data.clientId))
        reconcile(key);
    }
    if (restoreIndex < restoreLength) scheduleRestore();
    else {
      restoreActive = false;
      if (restoreDirty) {
        restoreDirty = false;
        scheduleRestore(true);
      }
    }
  } catch {
    restoreActive = false;
  }
}
scheduleRestore(true);
function observeLock(send: Send, key: string): void {
  if (send.busy) return;
  send.busy = true;
  send.observing = true;
  send.waitingForLock = true;
  send.failed = false;
  let activity: string | undefined;
  let acquired = false;
  void withCommentLock(key, async () => {
    acquired = true;
    try {
      const data: unknown = JSON.parse(localStorage.getItem(key) || "null");
      if (validSend(data) && key === PREFIX + data.clientId)
        activity = data.activity;
    } catch {}
  })
    .catch(() => {})
    .finally(() => {
      send.busy = false;
      send.observing = false;
      send.waitingForLock = false;
      send.failed = true;
      send.storageChanged = false;
      reconcile(key, false);
      try {
        const current: unknown = JSON.parse(
          localStorage.getItem(key) || "null",
        );
        if (
          acquired &&
          sends.includes(send) &&
          validSend(current) &&
          key === PREFIX + current.clientId &&
          sameIdentity(send.data, current) &&
          current.activity !== activity
        )
          observeLock(send, key);
      } catch {}
      repaint(send.data.recipient);
    });
}
function sameIdentity(previous: CommentSend, data: CommentSend): boolean {
  return (
    previous.recipient === data.recipient &&
    previous.crops.length === data.crops.length &&
    data.crops.every(
      (crop, index) =>
        crop.token === previous.crops[index]?.token &&
        crop.filename === previous.crops[index]?.filename,
    )
  );
}
function reconcile(key: string, observe = true): void {
  try {
    const id = key.slice(PREFIX.length);
    const send = sends.find((item) => item.data.clientId === id);
    if (send?.busy && !send.observing) {
      send.storageChanged = true;
      return;
    }
    const saved = localStorage.getItem(key);
    if (saved === null) {
      if (!send) return;
      sends.splice(sends.indexOf(send), 1);
      for (const crop of send.crops) crop?.release();
      repaint(send.data.recipient);
      return;
    }
    const data: unknown = JSON.parse(saved);
    if (!validSend(data) || key !== PREFIX + data.clientId) return;
    if (!send) {
      const added: Send = {
        data,
        crops: data.crops.map(() => null),
        failed: true,
        busy: false,
      };
      sends.push(added);
      if (observe) observeLock(added, key);
    } else {
      if (!sameIdentity(send.data, data)) return;
      send.data = data;
      send.missingCrop = false;
      if (observe) observeLock(send, key);
    }
    repaint(data.recipient);
  } catch {}
}
addEventListener("storage", (event: StorageEvent) => {
  if (event.storageArea !== localStorage) return;
  if (event.key === null || event.oldValue === null || event.newValue === null)
    scheduleRestore(true);
  if (event.key?.startsWith(PREFIX)) reconcile(event.key);
  else if (event.key === null)
    for (const send of [...sends]) reconcile(PREFIX + send.data.clientId);
});
/** Whether browser-only comments are still sending or need retry. */
export function hasCommentSends(): boolean {
  return sends.length > 0;
}
addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
  if (!sends.length) return;
  event.preventDefault();
  event.returnValue = "";
});
function repaint(recipient: string): void {
  if (state.currentConv?.id === recipient) paint(state.currentConv);
}
async function deleteUploads(send: Send): Promise<void> {
  const { recipient, crops } = send.data;
  await Promise.all(
    crops.map(async (crop) => {
      if (!crop.key && !crop.url) return;
      if (crop.url && !validAttachmentUrl(crop.url, recipient))
        throw new Error("Invalid crop URL");
      send.checkLock?.();
      const cid = parseConversationId(recipient).cid;
      const path = crop.key
        ? `/api/conversations/${encodeURIComponent(cid)}/attachment-crops/${crop.key}?expires=${crop.expires}`
        : `${crop.url}?owner=${encodeURIComponent(cid)}`;
      const response = await backendFor(recipient).api(path, {
        method: "DELETE",
      });
      if (!response.ok && (crop.key || response.status !== 404))
        throw new Error("Crop cleanup failed");
    }),
  );
}
async function withSendLock(
  send: Send,
  work: () => Promise<void>,
): Promise<void> {
  if (send.busy || !sends.includes(send)) return;
  send.busy = true;
  send.failed = false;
  send.waitingForLock = true;
  repaint(send.data.recipient);
  try {
    const locked = async (check: () => void) => {
      send.checkLock = check;
      if (!sends.includes(send)) return;
      send.waitingForLock = false;
      repaint(send.data.recipient);
      const saved = localStorage.getItem(PREFIX + send.data.clientId);
      if (saved === null) {
        const index = sends.indexOf(send);
        if (index >= 0) sends.splice(index, 1);
        for (const crop of send.crops) crop?.release();
        return;
      }
      const data: unknown = JSON.parse(saved);
      if (
        !validSend(data) ||
        data.clientId !== send.data.clientId ||
        !sameIdentity(send.data, data)
      )
        throw new Error("Invalid pending comment");
      send.data = data;
      data.activity = Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      persist(send);
      await work();
    };
    await withCommentLock(PREFIX + send.data.clientId, locked);
  } catch {
    send.failed = true;
  } finally {
    send.checkLock = undefined;
    send.busy = false;
    send.waitingForLock = false;
    if (send.storageChanged) {
      send.storageChanged = false;
      reconcile(PREFIX + send.data.clientId);
    }
    repaint(send.data.recipient);
  }
}
async function discard(send: Send, ask = true): Promise<void> {
  if (send.busy) return;
  const confirmedDeliveryMode = send.data.deliveryMode;
  if (
    ask &&
    !confirm(
      confirmedDeliveryMode
        ? "Delivery may have succeeded. Discard this retry?"
        : "Discard these comments?",
    )
  )
    return;
  await withSendLock(send, async () => {
    if (ask && send.data.deliveryMode && !confirmedDeliveryMode)
      throw new Error("Delivery may have succeeded");
    send.data.discarding = true;
    persist(send);
    if (send.data.deliveryMode !== "images") await deleteUploads(send);
    send.checkLock?.();
    await Promise.all(
      send.data.crops.map((_, index) =>
        removeCrop(`${send.data.clientId}:${index}`),
      ),
    );
    send.checkLock?.();
    removeSend(PREFIX + send.data.clientId);
    const index = sends.indexOf(send);
    if (index >= 0) sends.splice(index, 1);
    for (const crop of send.crops) crop?.release();
  });
}
async function attempt(send: Send, withoutImages = false): Promise<void> {
  await withSendLock(send, async () => {
    const { data } = send;
    send.missingCrop = false;
    if (withoutImages && data.deliveryMode === "images")
      throw new Error("Delivery may have succeeded with images");
    if (withoutImages && !data.deliveryMode && !data.withoutImages) {
      data.withoutImages = true;
      persist(send);
    }
    let content = data.text;
    if (!data.withoutImages && !data.admitted) {
      let serverNow = 0;
      if (data.crops.some((crop) => !crop.url)) {
        const cid = parseConversationId(data.recipient).cid;
        const response = await backendFor(data.recipient).api(
          `/api/conversations/${encodeURIComponent(cid)}/attachment-crops`,
        );
        if (!response.ok) throw new Error("Crop recovery unavailable");
        const capability = (await response.json()) as {
          idempotent?: boolean;
          now?: number;
        };
        send.checkLock?.();
        if (
          capability.idempotent !== true ||
          !Number.isSafeInteger(capability.now) ||
          capability.now! < 1_000_000_000_000 ||
          capability.now! + 59 * 60 * 1000 > 9_999_999_999_999
        )
          throw new Error("Crop recovery unavailable");
        serverNow = capability.now!;
      }
      const uploads = await Promise.allSettled(
        data.crops.map(async (crop, index) => {
          if (crop.url) {
            resolveUrl(backendFor(data.recipient), crop.url);
            return crop.url;
          }
          const id = `${data.clientId}:${index}`;
          let blob = await readCrop(id);
          send.checkLock?.();
          if (!blob) {
            const prepared = send.crops[index];
            if (!prepared) {
              send.missingCrop = true;
              throw new Error("Crop source unavailable");
            }
            blob = await prepared.prepare();
            send.checkLock?.();
            await saveCrop(id, blob);
            send.checkLock?.();
          }
          if (crop.key && crop.expires! <= serverNow) {
            const cid = parseConversationId(data.recipient).cid;
            const cancelled = await backendFor(data.recipient).api(
              `/api/conversations/${encodeURIComponent(cid)}/attachment-crops/${crop.key}?expires=${crop.expires}`,
              { method: "DELETE" },
            );
            send.checkLock?.();
            if (!cancelled.ok) throw new Error("Expired crop cleanup failed");
            delete crop.key;
            delete crop.expires;
          }
          if (!crop.key) {
            crop.key = Array.from(
              crypto.getRandomValues(new Uint8Array(16)),
              (byte) => byte.toString(16).padStart(2, "0"),
            ).join("");
            crop.expires = serverNow + 59 * 60 * 1000;
            persist(send);
          }
          if (!crop.expires) throw new Error("Missing crop operation");
          crop.url = await uploadBlob(
            blob,
            crop.filename,
            data.recipient,
            crop.key,
            crop.expires,
          );
          if (!validAttachmentUrl(crop.url, data.recipient))
            throw new Error("Invalid crop URL");
          persist(send);
          return crop.url;
        }),
      );
      if (uploads.some((result) => result.status === "rejected"))
        throw new Error("Crop upload failed");
      content = data.snapshot;
      for (const [index, crop] of data.crops.entries()) {
        const upload = uploads[index]!;
        if (upload.status === "fulfilled")
          content = content.replace(
            `![${crop.filename}](${crop.token})`,
            `![${crop.filename}](${upload.value})`,
          );
      }
    }
    if (data.admitted && !data.withoutImages) {
      content = data.snapshot;
      for (const crop of data.crops) {
        if (!crop.url) throw new Error("Missing crop URL");
        content = content.replace(
          `![${crop.filename}](${crop.token})`,
          `![${crop.filename}](${crop.url})`,
        );
      }
    }
    if (!data.deliveryMode) {
      data.deliveryMode = data.withoutImages ? "text" : "images";
      persist(send);
    }
    if (!data.admitted) {
      const response = await deliverQueuedOperatorMessage(data.recipient, {
        content,
        client_message_id: data.clientId,
      });
      if (!response.ok) throw new Error("Comment send failed");
      const result = (await response.json()) as { message_id?: string };
      send.checkLock?.();
      data.admitted = true;
      data.messageId =
        typeof result.message_id === "string" ? result.message_id : undefined;
      persist(send);
    }
    if (data.withoutImages) await deleteUploads(send);
    send.checkLock?.();
    await Promise.all(
      data.crops.map((_, index) => removeCrop(`${data.clientId}:${index}`)),
    );
    send.checkLock?.();
    removeSend(PREFIX + data.clientId);
    const index = sends.indexOf(send);
    if (index >= 0) sends.splice(index, 1);
    for (const crop of send.crops) crop?.release();
    addOptimisticPending(
      data.recipient,
      content,
      data.sinceOffset,
      data.messageId,
    );
    state.openConvHash = "";
    refreshConv();
  });
}
/** Store the complete snapshot before detaching the viewer. */
export function queueComments(
  data: CommentSend,
  crops: PreparedCrop[],
): boolean {
  if (sends.length >= 100 || !validSend(data)) return false;
  const send: Send = { data, crops, failed: false, busy: false };
  try {
    persist(send);
  } catch {
    return false;
  }
  return startOperatorSend(data.recipient, () => {
    sends.push(send);
    void attempt(send);
    repaint(data.recipient);
    return true;
  });
}
/** Comment sends awaiting delivery for this conversation. */
export function commentOutbox(recipient: string): TemplateResult[] {
  return sends
    .filter((send) => send.data.recipient === recipient)
    .map(
      (send) =>
        html` <div
          class="msg user pending ${send.failed ? "failed" : ""}"
          data-comment-send=${send.data.clientId}
        >
          <div class="bubble">${send.data.text}</div>
          ${send.failed
            ? html`<div class="pending-failure" role="alert">
                <span class="pending-failure-text"
                  >${send.data.discarding
                    ? "Couldn’t discard comments."
                    : send.data.admitted
                      ? "Comments sent. Retry cleanup."
                      : send.missingCrop
                        ? "Image could not be saved. Send without images or discard."
                        : "Couldn’t send comments."}</span
                ><button
                  class="btn sm pending-retry"
                  @click=${() =>
                    void (send.data.discarding
                      ? discard(send, false)
                      : attempt(send))}
                >
                  Retry</button
                >${send.data.crops.length &&
                !send.data.discarding &&
                !send.data.deliveryMode &&
                !send.data.withoutImages
                  ? html`<button
                      class="btn sm"
                      @click=${() => void attempt(send, true)}
                    >
                      Send without images
                    </button>`
                  : null}${send.data.admitted || send.data.discarding
                  ? null
                  : html`<button
                      class="btn sm"
                      @click=${() => void discard(send)}
                    >
                      Discard
                    </button>`}
              </div>`
            : html`<div role="status">
                ${send.waitingForLock
                  ? "Waiting for another tab…"
                  : send.data.discarding
                    ? "Discarding comments…"
                    : send.data.admitted
                      ? "Finishing…"
                      : `Sending ${send.data.count} ${send.data.count === 1 ? "comment" : "comments"}…`}
              </div>`}
        </div>`,
    );
}
