// DOM-free validation for the one navigation that cannot retain in-memory send
// jobs: an explicit reload to log in. sessionStorage remains owned by
// composer.ts; this module only bounds and validates the payload before it can
// rebuild state.

import { validBackendLabel } from "../../src/backends/label.js";
import { parseConversationId } from "../backends/backend.js";

export interface StoredAttachment {
  url: string;
  isImage: boolean;
  filename: string;
  owner: { kind: "owner" | "draft"; id: string };
  // Legacy v1 recovery remaps the active owner through AuthRecovery.owner.
  uiOwnerId?: string;
}

export interface StoredSendJob {
  draft: boolean;
  convId: string | null;
  content: string;
  attachmentIds?: string[];
  // Send id survives login reload; older keyless payloads mint a fresh id.
  clientId?: string;
  parent?: string | null;
  backendLabel?: string;
  model?: string | null;
  effort?: string | null;
  level?: number | null;
  attachmentDraft?: string | null;
  muted?: boolean;
  waitForIndex: number;
}

export interface StoredDraft {
  parent: string | null;
  backendLabel?: string;
  creatorIndex: number;
  model?: string | null;
  effort?: string | null;
  level?: number | null;
  attachmentDraft?: string | null;
  muted?: boolean;
}

export interface AuthRecovery {
  version: 1;
  // Exact composer owner; only the preceding generation may omit it.
  owner: string | null;
  input: string;
  selectionStart?: number;
  selectionEnd?: number;
  attachments: StoredAttachment[];
  draft: StoredDraft | null;
  jobs: StoredSendJob[];
}

const optionalString = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === "string";
const optionalLevel = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5);
const optionalBackendLabel = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === "string" && validBackendLabel(value));
const optionalAttachmentDraft = (value: unknown): boolean => {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  try {
    return /^[a-f0-9]{32}$/.test(parseConversationId(value).cid);
  } catch {
    return false;
  }
};

function validStoredJob(value: unknown): value is StoredSendJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<StoredSendJob>;
  return (
    typeof job.draft === "boolean" &&
    (job.convId === null ||
      (typeof job.convId === "string" &&
        job.convId.length > 0 &&
        job.convId.length <= 128)) &&
    typeof job.content === "string" &&
    job.content.length <= 2_000_000 &&
    (job.attachmentIds === undefined ||
      (Array.isArray(job.attachmentIds) &&
        job.attachmentIds.length <= 50_000 &&
        job.attachmentIds.every(
          (id) =>
            typeof id === "string" &&
            /^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(id),
        ))) &&
    optionalString(job.parent) &&
    optionalBackendLabel(job.backendLabel) &&
    optionalString(job.model) &&
    optionalString(job.effort) &&
    optionalLevel(job.level) &&
    optionalAttachmentDraft(job.attachmentDraft) &&
    (job.muted === undefined || typeof job.muted === "boolean") &&
    (job.clientId === undefined ||
      (typeof job.clientId === "string" &&
        /^[A-Za-z0-9._-]{1,64}$/.test(job.clientId))) &&
    typeof job.waitForIndex === "number" &&
    Number.isInteger(job.waitForIndex)
  );
}

function validAttachment(value: unknown): value is StoredAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredAttachment>;
  const owner = item.owner as { kind?: unknown; id?: unknown } | undefined;
  return (
    typeof item.url === "string" &&
    /^\/api\/attachments\/[\w.-]+$/.test(item.url) &&
    typeof item.isImage === "boolean" &&
    typeof item.filename === "string" &&
    item.filename.length <= 1_000 &&
    !!owner &&
    (owner.kind === "owner" || owner.kind === "draft") &&
    typeof owner.id === "string" &&
    owner.id.length > 0 &&
    owner.id.length <= 128 &&
    (item.uiOwnerId === undefined ||
      (typeof item.uiOwnerId === "string" &&
        item.uiOwnerId.length > 0 &&
        item.uiOwnerId.length <= 256 &&
        (/^[A-Za-z0-9._-]+$/.test(item.uiOwnerId) ||
          /^draft:[A-Za-z0-9._-]+$/.test(item.uiOwnerId))))
  );
}

function validDraft(value: unknown): value is StoredDraft | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredDraft>;
  return (
    (draft.parent === null || typeof draft.parent === "string") &&
    optionalBackendLabel(draft.backendLabel) &&
    typeof draft.creatorIndex === "number" &&
    Number.isInteger(draft.creatorIndex) &&
    draft.creatorIndex >= -1 &&
    optionalString(draft.model) &&
    optionalString(draft.effort) &&
    optionalLevel(draft.level) &&
    optionalAttachmentDraft(draft.attachmentDraft) &&
    (draft.muted === undefined || typeof draft.muted === "boolean")
  );
}

export function resolveAuthRecoveryOwner(
  owner: string | null,
  availableIds: ReadonlySet<string>,
  currentId: string,
): string {
  if (owner && availableIds.has(owner)) return owner;
  if (currentId && availableIds.has(currentId)) return currentId;
  return availableIds.values().next().value || "";
}

export function serializeAuthRecovery(value: AuthRecovery): string | null {
  try {
    const raw = JSON.stringify(value);
    // Invariant: Writer and reader share one admission boundary: never navigate
    // after storing a payload the next generation will delete as invalid.
    return raw.length <= 8_000_000 && parseAuthRecovery(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function parseAuthRecovery(raw: string | null): AuthRecovery | null {
  if (!raw || raw.length > 8_000_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const recovery = value as Partial<AuthRecovery>;
  if (
    recovery.version !== 1 ||
    !(
      recovery.owner === undefined ||
      recovery.owner === null ||
      (typeof recovery.owner === "string" &&
        /^[A-Za-z0-9._-]{1,128}$/.test(recovery.owner))
    ) ||
    typeof recovery.input !== "string" ||
    recovery.input.length > 2_000_000 ||
    !(
      recovery.selectionStart === undefined ||
      (typeof recovery.selectionStart === "number" &&
        Number.isInteger(recovery.selectionStart) &&
        recovery.selectionStart >= 0 &&
        recovery.selectionStart <= recovery.input.length)
    ) ||
    !(
      recovery.selectionEnd === undefined ||
      (typeof recovery.selectionEnd === "number" &&
        Number.isInteger(recovery.selectionEnd) &&
        recovery.selectionEnd >= 0 &&
        recovery.selectionEnd <= recovery.input.length)
    ) ||
    !Array.isArray(recovery.jobs) ||
    recovery.jobs.length > 100 ||
    !recovery.jobs.every(validStoredJob) ||
    !Array.isArray(recovery.attachments) ||
    recovery.attachments.length > 50_000 ||
    !recovery.attachments.every(validAttachment) ||
    !validDraft(recovery.draft)
  )
    return null;
  if (
    !recovery.jobs.every((job) => {
      const waitsForCreator =
        job.waitForIndex >= 0 &&
        job.waitForIndex < recovery.jobs!.length &&
        recovery.jobs![job.waitForIndex].draft;
      return (
        (job.waitForIndex === -1 || waitsForCreator) &&
        (job.draft || job.convId !== null || waitsForCreator)
      );
    })
  )
    return null;
  if (
    recovery.draft &&
    (recovery.draft.creatorIndex >= recovery.jobs.length ||
      (recovery.draft.creatorIndex >= 0 &&
        !recovery.jobs[recovery.draft.creatorIndex].draft))
  )
    return null;
  // Invariant: Parsed values are copied so no caller retains a mutable graph
  // supplied by storage or a test double.
  return {
    version: 1,
    owner: typeof recovery.owner === "string" ? recovery.owner : null,
    input: recovery.input,
    selectionStart: recovery.selectionStart ?? recovery.input.length,
    selectionEnd: recovery.selectionEnd ?? recovery.input.length,
    attachments: recovery.attachments.map((item) => ({
      ...item,
      owner: { ...item.owner },
    })),
    draft: recovery.draft ? { ...recovery.draft } : null,
    jobs: recovery.jobs.map((job) => ({
      ...job,
      attachmentIds: job.attachmentIds ? [...job.attachmentIds] : undefined,
    })),
  };
}
