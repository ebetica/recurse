// Browser-only attachments share the composer's bounded owner lifecycle.
// Navigation changes rendering; promotion transfers; send takes; eviction
// disposes. Before the first composer owner, uploads report visible failure.
import { state } from "./state.js";
import { $, inputEl } from "./dom.js";
import {
  backendFor,
  conversationId,
  parseConversationId,
  resolveUrl,
} from "./backends/backend.js";

const ownerBackend = (owner: AttachmentOwner) => backendFor(owner.id);
import { CLOSE_ICON, COPY_ERROR_ICON } from "./icons.js";
import {
  attachmentIdFromUrl,
  attachmentOwnerForSelection,
  type AttachmentOwner,
  type AttachmentSelection,
} from "./attachment-flow.js";
import { canSnapshotMessage } from "./composer/send.js";
import { setComposerSendState } from "./composer/action.js";
import { conversationUiState } from "./conversation-ui-state/store.js";
import { previewTargetFor } from "./image-preview.js";
import { setDrawingUploadCapture } from "./image-preview/drawing.js";

// files.js registers the Files pane at import: a static import here would
// evaluate it (via composer.ts) before diff.js and flip the pane rail
// order, so load it lazily at the call sites instead.
function invalidateOwnedFiles(id: string): void {
  void import("./files.js").then((m) => m.invalidateFiles(id));
}

export interface ReadyAttachment {
  url: string;
  isImage: boolean;
  filename: string;
}

export interface RecoverableAttachment extends ReadyAttachment {
  owner: AttachmentOwner;
  uiOwnerId: string;
}

type UploadStatus = "uploading" | "failed" | "ready";

interface StagedAttachment {
  url: string | null;
  isImage: boolean;
  filename: string;
  preview: string | null;
  file: File | null;
  resolveOwner: (() => Promise<AttachmentOwner>) | null;
  resolvedOwner: AttachmentOwner | null;
  status: UploadStatus;
  attempt: number;
  discarded: boolean;
}

interface AttachmentOwnerState {
  entries: StagedAttachment[];
  // Retains the empty draft upload lease so owner abandonment releases it.
  draftToken: string | null;
}

const attachEl = $("#attachments")!;
const attachButton = $<HTMLButtonElement>("#attach")!;
const fileInput = $<HTMLInputElement>("#file-input")!;
let activeOwnerId = "";
let attachmentInputBlocked = false;
let attachmentError = "";

function revokePreview(entry: StagedAttachment): void {
  if (!entry.preview) return;
  URL.revokeObjectURL(entry.preview);
  entry.preview = null;
}

function createDraftToken(ownerId: string, backendLabel = ""): Promise<string> {
  const backend = backendFor(conversationId(backendLabel, "draft"));
  return backend
    .api("/api/attachment-drafts", { method: "POST" })
    .then(async (response) => {
      if (!response.ok) throw new Error("attachment draft failed");
      const token = ((await response.json()) as { id?: string }).id;
      if (!token) throw new Error("attachment draft missing id");
      const id = conversationId(backend.label, token);
      const ownerState = attachmentStates.get(ownerId);
      if (ownerState) ownerState.draftToken = id;
      else releaseDraftToken(id);
      return id;
    });
}

function releaseDraftToken(token: string): void {
  void backendFor(token)
    .api(
      `/api/attachment-drafts/${encodeURIComponent(parseConversationId(token).cid)}`,
      {
        method: "DELETE",
      },
    )
    .catch(() => {});
}

function releaseAttachmentUrl(url: string, owner: AttachmentOwner): void {
  const aid = attachmentIdFromUrl(url);
  if (!aid) return;
  const query = new URLSearchParams([
    [owner.kind, parseConversationId(owner.id).cid],
  ]);
  void ownerBackend(owner)
    .api(`/api/attachments/${encodeURIComponent(aid)}?${query}`, {
      method: "DELETE",
    })
    .then(() => {
      if (owner.kind === "owner") invalidateOwnedFiles(owner.id);
    })
    .catch(() => {});
}

function discard(entry: StagedAttachment): void {
  if (entry.discarded) return;
  entry.discarded = true;
  entry.attempt++;
  revokePreview(entry);
  if (entry.url && entry.resolvedOwner)
    releaseAttachmentUrl(entry.url, entry.resolvedOwner);
  entry.file = null;
  entry.resolveOwner = null;
}

function disposeOwnerAttachments(ownerState: AttachmentOwnerState): void {
  for (const entry of ownerState.entries) discard(entry);
  if (ownerState.draftToken) releaseDraftToken(ownerState.draftToken);
}

const attachmentStates =
  conversationUiState.ownerResource<AttachmentOwnerState>(
    disposeOwnerAttachments,
  );

function attachments(ownerId = activeOwnerId): StagedAttachment[] {
  return attachmentStates.get(ownerId)?.entries || [];
}

function rerenderOwner(ownerId: string): void {
  if (ownerId !== activeOwnerId) return;
  renderAttachments();
  refreshAttachmentSendState();
}

function rerenderEntry(ownerId: string, entry: StagedAttachment): void {
  if (ownerId === activeOwnerId || attachments().includes(entry))
    rerenderOwner(activeOwnerId);
}

function removeEntry(ownerId: string, entry: StagedAttachment): void {
  if (attachmentInputBlocked || ownerId !== activeOwnerId) return;
  const ownerState = attachmentStates.get(ownerId);
  const index = ownerState?.entries.indexOf(entry) ?? -1;
  if (!ownerState || index < 0) return;
  ownerState.entries.splice(index, 1);
  discard(entry);
  if (!ownerState.entries.length && !ownerState.draftToken)
    attachmentStates.take(ownerId);
  rerenderOwner(ownerId);
}

function renderAttachments(): void {
  attachEl.innerHTML = "";
  if (attachmentError) {
    const error = document.createElement("div");
    error.className = "attachment-error";
    error.setAttribute("role", "alert");
    error.innerHTML = COPY_ERROR_ICON;
    const message = document.createElement("span");
    message.textContent = attachmentError;
    error.append(message);
    attachEl.appendChild(error);
  }
  const ownerId = activeOwnerId;
  for (const entry of attachments(ownerId)) {
    const chip = document.createElement("div");
    const progressClass = entry.status === "ready" ? "" : ` ${entry.status}`;
    if (entry.isImage) {
      chip.className = `attach-chip${progressClass}`;
      const img = document.createElement("img");
      const preview = previewTargetFor(entry);
      // Invariant: Thumbnail from the preview address: a staged owner-scoped
      // URL serves forced-download bytes that never rasterize in an <img>.
      const url = preview?.url || entry.url || entry.preview || "";
      img.src =
        entry.url && entry.resolvedOwner
          ? resolveUrl(ownerBackend(entry.resolvedOwner), url)
          : url;
      img.alt = entry.filename || "image";
      // Spec: Only a saved conversation has a Files pane to open the image in.
      const owner = entry.resolvedOwner;
      const fileId =
        owner?.kind === "owner" && entry.url
          ? attachmentIdFromUrl(entry.url)
          : null;
      if (preview && owner && fileId) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "preview";
        open.setAttribute("aria-label", `Open ${preview.alt}`);
        img.alt = "";
        open.appendChild(img);
        open.onclick = () =>
          void import("./files.js").then((m) =>
            m.showFileInPane(owner.id, fileId),
          );
        chip.appendChild(open);
      } else {
        chip.appendChild(img);
      }
    } else {
      chip.className = `attach-chip file${progressClass}`;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.filename || "file";
      chip.appendChild(name);
    }
    if (entry.status === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "Retry";
      retry.disabled = attachmentInputBlocked;
      retry.onclick = () => {
        if (!attachmentInputBlocked && ownerId === activeOwnerId)
          void uploadEntry(ownerId, entry);
      };
      chip.appendChild(retry);
    }
    const remove = document.createElement("button");
    remove.className = "rm";
    remove.innerHTML = CLOSE_ICON;
    remove.title = "Remove";
    remove.setAttribute("aria-label", `Remove ${entry.filename}`);
    remove.disabled = attachmentInputBlocked;
    remove.onclick = () => removeEntry(ownerId, entry);
    chip.appendChild(remove);
    attachEl.appendChild(chip);
  }
}

export function hasStagedAttachments(): boolean {
  return attachments().length > 0;
}

export function hasAnyStagedAttachments(): boolean {
  return attachmentStates
    .entries()
    .some(([, ownerState]) => ownerState.entries.length > 0);
}

// Auth reload stores only completed upload metadata, never File/blob bytes. If
// any owner still has a local file or ambiguous POST, the caller refuses
// reload.
export function recoverableStagedAttachments(): RecoverableAttachment[] | null {
  const recovered: RecoverableAttachment[] = [];
  for (const [uiOwnerId, ownerState] of attachmentStates.entries()) {
    const entries = ownerState.entries;
    if (
      entries.some(
        (entry) =>
          entry.status !== "ready" || !entry.url || !entry.resolvedOwner,
      )
    )
      return null;
    recovered.push(
      ...entries.map((entry) => ({
        url: entry.url!,
        isImage: entry.isImage,
        filename: entry.filename,
        owner: { ...entry.resolvedOwner! },
        uiOwnerId,
      })),
    );
  }
  return recovered;
}

export function restoreStagedAttachments(
  items: RecoverableAttachment[],
  ownerId: (item: RecoverableAttachment) => string = (item) => item.uiOwnerId,
): void {
  for (const [id] of attachmentStates.entries()) attachmentStates.remove(id);
  const grouped = new Map<string, AttachmentOwnerState>();
  for (const item of items) {
    const id = ownerId(item);
    const ownerState = grouped.get(id) || { entries: [], draftToken: null };
    ownerState.entries.push({
      url: item.url,
      isImage: item.isImage,
      filename: item.filename,
      preview: null,
      file: null,
      resolveOwner: null,
      resolvedOwner: { ...item.owner },
      status: "ready",
      attempt: 0,
      discarded: false,
    });
    if (item.owner.kind === "draft") ownerState.draftToken = item.owner.id;
    grouped.set(id, ownerState);
  }
  for (const [id, ownerState] of grouped) attachmentStates.set(id, ownerState);
  rerenderOwner(activeOwnerId);
}

export function transferStagedAttachmentOwner(
  fromOwnerId: string,
  toOwnerId: string,
): void {
  if (fromOwnerId === toOwnerId) return;
  const ownerState = attachmentStates.take(fromOwnerId);
  if (ownerState) attachmentStates.set(toOwnerId, ownerState);
  rerenderOwner(activeOwnerId);
}

export function refreshAttachmentSendState(): void {
  const staged = attachments();
  setComposerSendState(
    inputEl.value.length > 0 || staged.length > 0,
    !attachmentInputBlocked && canSnapshotMessage(inputEl.value, staged),
  );
}

function refreshAttachmentInputAvailability(): void {
  const unavailable = attachmentInputBlocked || !activeOwnerId;
  attachButton.disabled = unavailable;
  fileInput.disabled = unavailable;
  document.dispatchEvent(new Event("recurse:attachment-availability"));
}

export function setAttachmentInputBlocked(blocked: boolean): void {
  attachmentInputBlocked = blocked;
  refreshAttachmentInputAvailability();
  renderAttachments();
  refreshAttachmentSendState();
}

async function uploadEntry(
  ownerId: string,
  entry: StagedAttachment,
): Promise<void> {
  if (
    entry.discarded ||
    !entry.file ||
    !entry.resolveOwner ||
    entry.status === "uploading"
  )
    return;
  const attempt = ++entry.attempt;
  entry.status = "uploading";
  rerenderEntry(ownerId, entry);
  let uploaded: { url: string; is_image?: boolean; filename?: string } | null =
    null;
  let owner: AttachmentOwner | null = null;
  try {
    owner = entry.resolvedOwner || (await entry.resolveOwner());
    if (entry.discarded || attempt !== entry.attempt) return;
    entry.resolvedOwner = owner;
    const body = new FormData();
    body.append("file", entry.file);
    body.append(owner.kind, parseConversationId(owner.id).cid);
    const response = await ownerBackend(owner).api("/api/attachments", {
      method: "POST",
      body,
    });
    if (!response.ok) throw new Error("upload failed");
    uploaded = (await response.json()) as {
      url: string;
      is_image?: boolean;
      filename?: string;
    };
    if (entry.discarded || attempt !== entry.attempt) {
      releaseAttachmentUrl(uploaded.url, owner);
      return;
    }
    resolveUrl(ownerBackend(owner), uploaded.url);
    entry.url = uploaded.url;
    if (typeof uploaded.is_image === "boolean")
      entry.isImage = uploaded.is_image;
    if (uploaded.filename) entry.filename = uploaded.filename;
    entry.status = "ready";
    entry.file = null;
    entry.resolveOwner = null;
    if (owner?.kind === "owner") invalidateOwnedFiles(owner.id);
    revokePreview(entry);
  } catch {
    if (!entry.discarded && attempt === entry.attempt) entry.status = "failed";
  } finally {
    rerenderEntry(ownerId, entry);
  }
}

setDrawingUploadCapture(() => {
  if (attachmentInputBlocked || !activeOwnerId) return null;
  const ownerId = activeOwnerId;
  return (file) => {
    if (attachmentInputBlocked || ownerId !== activeOwnerId)
      throw new Error("Attachment conversation changed");
    if (!addFiles([file])) throw new Error("Could not attach drawing");
  };
});

function addFiles(files: FileList | File[] | null): boolean {
  if (!files?.length) return false;
  if (!activeOwnerId) {
    attachmentError =
      "File not attached: the conversation was not ready. Please attach it again.";
    renderAttachments();
    return false;
  }
  if (attachmentInputBlocked) return false;
  attachmentError = "";
  const ownerId = activeOwnerId;
  // Invariant: Capture the saved id or live draft object once. Retrying later
  // must never consult whichever conversation happens to be selected then.
  const selection: AttachmentSelection = {
    selectedId: state.selectedId,
    draft: state.draft,
  };
  const backendLabel = state.draft?.backendLabel;
  let ownerState = attachmentStates.get(ownerId);
  if (!ownerState) {
    ownerState = { entries: [], draftToken: null };
    if (!attachmentStates.set(ownerId, ownerState)) return false;
  }
  for (const file of files) {
    if (!file) continue;
    const isImage = !!(file.type && file.type.startsWith("image/"));
    const entry: StagedAttachment = {
      url: null,
      isImage,
      filename: file.name || "file",
      preview: isImage ? URL.createObjectURL(file) : null,
      file,
      resolveOwner: () =>
        attachmentOwnerForSelection(selection, () =>
          createDraftToken(ownerId, backendLabel),
        ),
      resolvedOwner: null,
      status: "failed",
      attempt: 0,
      discarded: false,
    };
    ownerState.entries.push(entry);
    void uploadEntry(ownerId, entry);
  }
  rerenderOwner(ownerId);
  return true;
}

// Returns this owner's send-safe snapshot, then clears without release: these
// stable URLs are about to become message content and are no longer unsent.
export function takeAttachmentsForSend(): ReadyAttachment[] | null {
  const ownerState = attachmentStates.get(activeOwnerId);
  const entries = ownerState?.entries || [];
  if (entries.some((entry) => entry.status !== "ready" || !entry.url))
    return null;
  const ready = entries.map((entry) => ({
    url: entry.url!,
    isImage: entry.isImage,
    filename: entry.filename,
  }));
  // Invariant: A text-only draft may already hold an empty upload lease after
  // its last chip was removed. Sending consumes that lease too; an empty send
  // does not.
  if (entries.length || (ownerState?.draftToken && inputEl.value.trim()))
    attachmentStates.take(activeOwnerId);
  for (const entry of entries) {
    revokePreview(entry);
    entry.file = null;
    entry.resolveOwner = null;
  }
  renderAttachments();
  refreshAttachmentSendState();
  return ready;
}

export function abandonStagedAttachments(ownerId = activeOwnerId): void {
  attachmentStates.remove(ownerId);
  rerenderOwner(ownerId);
}

attachButton.addEventListener("click", () => {
  if (!attachmentInputBlocked) fileInput.click();
});
fileInput.addEventListener("change", () => {
  if (!attachmentInputBlocked) addFiles(fileInput.files);
  fileInput.value = "";
});

$("#composer")!.addEventListener("paste", (event) => {
  if (attachmentInputBlocked) return;
  const items = (event as ClipboardEvent).clipboardData?.items;
  const files: File[] = [];
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) {
    event.preventDefault();
    addFiles(files);
  }
});

const composerEl = $("#composer")!;
let dragDepth = 0;
const dragHasFiles = (event: DragEvent): boolean =>
  !!event.dataTransfer && [...event.dataTransfer.types].includes("Files");
composerEl.addEventListener("dragenter", (event: DragEvent) => {
  if (attachmentInputBlocked || !dragHasFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  composerEl.classList.add("dragover");
});
composerEl.addEventListener("dragover", (event: DragEvent) => {
  if (attachmentInputBlocked || !dragHasFiles(event)) return;
  event.preventDefault();
});
composerEl.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    composerEl.classList.remove("dragover");
  }
});
composerEl.addEventListener("drop", (event: DragEvent) => {
  if (attachmentInputBlocked) return;
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  event.preventDefault();
  dragDepth = 0;
  composerEl.classList.remove("dragover");
  addFiles(files);
});

document.addEventListener("recurse:composer-state-restored", (event) => {
  const ownerId = (event as CustomEvent<{ ownerId?: unknown }>).detail?.ownerId;
  if (typeof ownerId !== "string") return;
  if (activeOwnerId && ownerId !== activeOwnerId) attachmentError = "";
  activeOwnerId = ownerId;
  refreshAttachmentInputAvailability();
  renderAttachments();
  refreshAttachmentSendState();
});
refreshAttachmentInputAvailability();
