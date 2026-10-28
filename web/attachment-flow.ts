// DOM-free ownership helpers for staged attachments. Upload callers snapshot an
// owner promise before any network wait, so later navigation cannot retarget a
// file to a different saved agent or draft.
export interface ConversationIdLease {
  convIdReady: Promise<string>;
  resolveConvId: (id: string) => void;
}

export function conversationIdLease(
  existingId: string | null,
): ConversationIdLease {
  if (existingId) {
    return {
      convIdReady: Promise.resolve(existingId),
      resolveConvId: () => {},
    };
  }
  let resolveConvId!: (id: string) => void;
  const convIdReady = new Promise<string>((resolve) => {
    resolveConvId = resolve;
  });
  return { convIdReady, resolveConvId };
}

export interface AttachmentDraftLease {
  attachmentDraft?: string;
  attachmentDraftPromise?: Promise<string>;
  creator?: { convIdReady?: Promise<string> };
}

export type AttachmentOwner =
  | { kind: "owner"; id: string }
  | { kind: "draft"; id: string };

export interface AttachmentSelection {
  selectedId: string;
  draft: AttachmentDraftLease | null;
}

export function ensureAttachmentDraft(
  draft: AttachmentDraftLease,
  create: () => Promise<string>,
): Promise<string> {
  if (draft.attachmentDraft) return Promise.resolve(draft.attachmentDraft);
  if (draft.attachmentDraftPromise) return draft.attachmentDraftPromise;

  const pending = create().then((id) => {
    if (!id) throw new Error("attachment draft missing id");
    draft.attachmentDraft = id;
    return id;
  });
  draft.attachmentDraftPromise = pending;
  pending.catch(() => {
    // Invariant: A later file selection may retry creating the lease. Do not
    // let an older rejection clear a newer attempt.
    if (draft.attachmentDraftPromise === pending)
      draft.attachmentDraftPromise = undefined;
  });
  return pending;
}

export function attachmentOwnerForSelection(
  selection: AttachmentSelection,
  createDraft: () => Promise<string>,
): Promise<AttachmentOwner> {
  // Invariant: Capture both branches synchronously. In particular, never read
  // selectedId after awaiting draft creation: the operator may have navigated
  // by then.
  const draft = selection.draft;
  const selectedId = selection.selectedId;
  if (draft?.creator?.convIdReady) {
    return draft.creator.convIdReady.then((id) => ({ kind: "owner", id }));
  }
  if (draft) {
    return ensureAttachmentDraft(draft, createDraft).then((id) => ({
      kind: "draft",
      id,
    }));
  }
  if (!selectedId) return Promise.reject(new Error("attachment owner missing"));
  return Promise.resolve({ kind: "owner", id: selectedId });
}

export interface ConversationDraftSpec {
  parent?: string | null;
  model?: string | null;
  effort?: string | null;
  level?: number | null;
  attachmentDraft?: string | null;
  muted?: boolean;
}

export function conversationCreationBody(
  spec: ConversationDraftSpec,
): Record<string, unknown> {
  const body: Record<string, unknown> = { parent: spec.parent };
  if (spec.model) body.model = spec.model;
  if (spec.effort) body.effort = spec.effort;
  if (typeof spec.level === "number") body.level = spec.level;
  if (spec.attachmentDraft) body.attachment_draft = spec.attachmentDraft;
  // Invariant: All browser creation affordances snapshot the same strict
  // preference. Keep it on the initial create transaction so no report can
  // escape before muting.
  if (typeof spec.muted === "boolean") body.muted = spec.muted;
  return body;
}

export function attachmentIdFromUrl(url: string): string | null {
  // Invariant: All three staged-upload address forms carry the stable file id
  // in their final segment: the shared route, a conversation collection, or a
  // draft collection. Anything else (foreign hosts, query strings) yields no
  // release id.
  const match =
    /^\/api\/attachments\/([^/?#]+)$/.exec(url) ??
    /^\/api\/conversations\/[^/?#]+\/attachments\/([^/?#]+)$/.exec(url) ??
    /^\/api\/attachment-drafts\/[^/?#]+\/([^/?#]+)$/.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
