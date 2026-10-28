// Pure state transitions for paged Files metadata.
import type { AgentAttachment } from "../types.js";

export function filesRefreshDue(
  running: boolean,
  changed: boolean,
  lastRefresh: number,
  now: number,
): boolean {
  // Invariant: An idle conversation never changes under the pane, so a version
  // change is a discrete event (turn settled, upload staged) worth one
  // immediate reload. A running conversation churns, so it stays on the minute
  // throttle.
  if (!changed) return false;
  if (!running) return true;
  return now - lastRefresh >= 60_000;
}

export interface FileSource {
  offset: number | null;
  message_id?: string | null;
  pending?: boolean;
  turn_id: string;
  role: "operator" | "agent";
  timestamp: number | null;
}

export interface FilePreviewState {
  status: "idle" | "loading" | "ready" | "missing" | "evicted";
  text?: string;
  truncated?: boolean;
  controller?: AbortController;
}

export interface SessionFile {
  key: string;
  storage: "upload" | "published";
  id?: string;
  name: string;
  size: number;
  media_type: string;
  preview?: "image" | "text" | "audio" | "video" | "pdf" | "none";
  unavailable?: "copied" | "missing";
  /** Upload or publication time in epoch seconds. */
  created_at?: number;
  references: number;
  sources: FileSource[];
}

export function mergeSessionFiles(
  target: Map<string, SessionFile>,
  incomingFiles: SessionFile[],
  maxFiles: number,
  maxSources: number,
): void {
  for (const incoming of incomingFiles || []) {
    if (
      !incoming ||
      typeof incoming.key !== "string" ||
      !incoming.key ||
      (target.size >= maxFiles && !target.has(incoming.key))
    )
      continue;
    const prior = target.get(incoming.key);
    if (!prior) {
      target.set(incoming.key, {
        ...incoming,
        references: Math.max(0, Number(incoming.references) || 0),
        sources: (incoming.sources || []).slice(0, maxSources),
      });
      continue;
    }
    prior.references += Math.max(0, Number(incoming.references) || 0);
    const identities = new Set(
      prior.sources.map(
        (source) => `${source.offset ?? "pending"}:${source.message_id || ""}`,
      ),
    );
    for (const source of incoming.sources || []) {
      const identity = `${source.offset ?? "pending"}:${source.message_id || ""}`;
      if (identities.has(identity) || prior.sources.length >= maxSources)
        continue;
      identities.add(identity);
      prior.sources.push(source);
    }
    prior.sources.sort(
      (a, b) =>
        (a.offset ?? Number.MAX_SAFE_INTEGER) -
        (b.offset ?? Number.MAX_SAFE_INTEGER),
    );
  }
}

export function ensureFilePreview(
  previews: Map<string, FilePreviewState>,
  key: string,
): FilePreviewState {
  let preview = previews.get(key);
  if (!preview) {
    preview = { status: "idle" };
    previews.set(key, preview);
  }
  return preview;
}

export function retainFilePreview(
  previews: Map<string, FilePreviewState>,
  lru: string[],
  key: string,
  limit: number,
  protectedKey?: string,
): string[] {
  const next = lru.filter((candidate) => candidate !== key);
  next.push(key);
  while (next.length > limit) {
    const index = next.findIndex((candidate) => candidate !== protectedKey);
    if (index < 0) break;
    const [oldest] = next.splice(index, 1);
    if (!oldest) break;
    const preview = previews.get(oldest);
    if (!preview) continue;
    preview.controller?.abort();
    preview.controller = undefined;
    preview.status = "evicted";
    preview.text = undefined;
    preview.truncated = undefined;
  }
  return next;
}

export type FileSelection = ({ key: string } | { id: string }) & {
  latest?: boolean;
};

export function selectedFile(
  files: Iterable<SessionFile>,
  selection: FileSelection,
): SessionFile | null {
  for (const file of files)
    if (
      "key" in selection ? file.key === selection.key : file.id === selection.id
    )
      return file;
  return null;
}

// Groups same-name published versions newest-first; uploads never group.
const versionName = (file: SessionFile): string | null =>
  file.storage === "published" && file.id ? file.name : null;
const latestOffset = (file: SessionFile): number =>
  Math.max(-1, ...file.sources.map((source) => source.offset ?? -1));
const newestFirst = (a: SessionFile, b: SessionFile): number =>
  (b.created_at ?? latestOffset(b)) - (a.created_at ?? latestOffset(a)) ||
  a.name.localeCompare(b.name) ||
  a.key.localeCompare(b.key);

/** Newest files first, with published names placed by their newest version. */
export function versionGroups(files: SessionFile[]): SessionFile[][] {
  const groups: SessionFile[][] = [];
  const byName = new Map<string, SessionFile[]>();
  for (const file of files) {
    const name = versionName(file);
    const group = name === null ? undefined : byName.get(name);
    if (group) group.push(file);
    else {
      groups.push([file]);
      if (name !== null) byName.set(name, groups.at(-1)!);
    }
  }
  for (const group of groups) group.sort(newestFirst);
  return groups.sort((a, b) => newestFirst(a[0]!, b[0]!));
}

/** Markdown files render as formatted text in the detail view. */
export function rendersAsMarkdown(file: SessionFile): boolean {
  return file.preview === "text" && /\.(?:md|markdown)$/i.test(file.name);
}

export function fileKindLabel(storage: SessionFile["storage"]): string {
  return storage === "upload" ? "Uploaded" : "Published by agent";
}

interface WatchedTurn {
  turn_id: string;
  open: boolean;
  system?: unknown;
  segments: { assistant?: { attachments?: AgentAttachment[] } | null }[];
}

// Auto-opens only one non-image file published by a turn settling this visit.
// Initial/cache/away-settled rows establish the floor, never trigger opening.
export class SettledTurnFile {
  private cid: string | null = null;
  private fresh = false;
  private newest: string | null | undefined = undefined;
  private file: string | null = null;

  /** A new visit (a conversation, the draft, or nothing selected). */
  beginVisit(cid: string): void {
    if (cid === this.cid) return;
    this.cid = cid;
    this.fresh = false;
    this.newest = undefined;
    this.file = null;
  }

  /** The server returned rows for this conversation during the visit. */
  rowsRead(cid: string): void {
    if (cid === this.cid) this.fresh = true;
  }

  observe(cid: string, turns: readonly WatchedTurn[]): void {
    if (cid !== this.cid || !this.fresh) return;
    let turn: WatchedTurn | undefined;
    for (let index = turns.length - 1; index >= 0 && !turn; index--)
      if (!turns[index]!.open && !turns[index]!.system) turn = turns[index];
    const newest = turn?.turn_id ?? null;
    const first = this.newest === undefined;
    if (newest === this.newest) return;
    this.newest = newest;
    if (first) return;
    const files = (turn?.segments ?? [])
      .flatMap((segment) => segment.assistant?.attachments ?? [])
      .filter((file) => !file.inline_media_type);
    const only = files.length === 1 ? files[0]! : null;
    this.file = only?.id && !only.unavailable ? only.id : null;
  }

  /** The attachment id to open for this conversation, or null. */
  current(cid: string): string | null {
    return cid === this.cid ? this.file : null;
  }
}

export function filesPaneAvailable(
  initialized: boolean,
  error: string | null,
  visibleCount: number,
): boolean {
  // Invariant: Availability is known state, never optimism. An unprobed
  // conversation offers no pane until its first snapshot resolves; a recorded
  // error still offers it so the reader can see and retry.
  return error !== null || (initialized && visibleCount > 0);
}

export function currentFilesRequest(
  selectedId: string,
  requestAgentId: string,
  currentRequest: number,
  request: number,
): boolean {
  return selectedId === requestAgentId && currentRequest === request;
}
