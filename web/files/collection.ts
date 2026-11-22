// Bounded conversation metadata and text caches. Request currency is
// checked on both sides of decoding; an open pane owns its own refresh.
import { backendFor } from "../backends/index.js";
import { fetchPaneData } from "../panes.js";
import { state } from "../state.js";
import type { PaneContext } from "../types.js";
import { selectedFile, type SessionFile } from "./model.js";

export const PANE_ID = "files";
const FILES_PAGE_SIZE = 100;
const MAX_CLIENT_SOURCES = 40;
const MAX_CONVERSATION_CACHES = 12;
const MAX_TEXT_PREVIEW_CACHES = 24;

export interface FilePreviewState {
  status: "idle" | "loading" | "ready" | "missing" | "evicted";
  text?: string;
  truncated?: boolean;
  controller?: AbortController;
}

interface FilesPage {
  files: SessionFile[];
  cursor: string | null;
  generation: number;
  stale?: boolean;
  done: boolean;
  capped?: boolean;
}

export interface CacheEntry {
  files: Map<string, SessionFile>;
  displayFiles: Map<string, SessionFile> | null;
  filter: string;
  cursor: string | null;
  generation: number | null;
  initialized: boolean;
  complete: boolean;
  capped: boolean;
  inflight: boolean;
  pending?: Promise<void>;
  error: string | null;
  notice?: string;
  failedDeletion: SessionFile | null;
  request: number;
  controller: AbortController | null;
  previews: Map<string, FilePreviewState>;
  previewLru: string[];
  conversationVersion: string | null;
  lastRefresh: number;
  // A throttled running version still reloads at settle, including fast turns.
  refreshPending: boolean;
}

const cache = new Map<string, CacheEntry>();
let lastSelectedId: string | null = null;

interface CollectionHooks {
  changed(): void;
  paneOpen(id: string): boolean;
  detailKey(id: string): string | undefined;
}

let hooks: CollectionHooks;
const listeners = new Set<() => void>();

export function configureFilesCollection(options: CollectionHooks): void {
  hooks = options;
}

export function subscribeFilesCollection(listener: () => void): void {
  listeners.add(listener);
}

function changed(): void {
  hooks.changed();
  for (const listener of listeners) listener();
}

export function cachedEntry(id: string): CacheEntry | undefined {
  return cache.get(id);
}

export function entry(id: string): CacheEntry {
  let value = cache.get(id);
  if (value) {
    cache.delete(id);
    cache.set(id, value);
    return value;
  }
  while (cache.size >= MAX_CONVERSATION_CACHES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const removed = cache.get(oldest);
    if (removed) abandon(removed);
    cache.delete(oldest);
  }
  value = {
    files: new Map(),
    displayFiles: null,
    filter: "",
    cursor: null,
    generation: null,
    initialized: false,
    complete: false,
    capped: false,
    inflight: false,
    error: null,
    failedDeletion: null,
    request: 0,
    controller: null,
    previews: new Map(),
    previewLru: [],
    conversationVersion: null,
    lastRefresh: 0,
    refreshPending: false,
  };
  cache.set(id, value);
  return value;
}

export function visibleFiles(value: CacheEntry): Map<string, SessionFile> {
  return value.displayFiles ?? value.files;
}

export function allFiles(value: CacheEntry): SessionFile[] {
  return [...visibleFiles(value).values()];
}

export function abandon(value: CacheEntry): void {
  value.request++;
  value.controller?.abort();
  value.controller = null;
  value.inflight = false;
  for (const preview of value.previews.values()) {
    preview.controller?.abort();
    preview.controller = undefined;
    if (preview.status === "loading") preview.status = "idle";
  }
}

function reset(
  value: CacheEntry,
  generation: number | null = null,
  preservePreviews = false,
): void {
  abandon(value);
  value.files.clear();
  value.displayFiles = null;
  if (!preservePreviews) {
    value.previews.clear();
    value.previewLru = [];
  }
  value.cursor = null;
  value.generation = generation;
  value.initialized = false;
  value.complete = false;
  value.capped = false;
  value.error = null;
  value.refreshPending = false;
}

export function revalidate(value: CacheEntry, generation: number | null): void {
  abandon(value);
  if (value.displayFiles === null && value.files.size)
    value.displayFiles = new Map(value.files);
  value.files.clear();
  value.cursor = null;
  value.generation = generation;
  value.complete = false;
  value.capped = false;
  value.error = null;
}

// The owned collection changed outside the conversation record (a
// completed upload or release): no poll version moves, so mark the entry
// owed and reload now when its pane is open. Closed panes reload on open
// through the version mismatch this leaves behind.
export function invalidateFiles(id: string): void {
  const value = cache.get(id);
  if (!value) return;
  value.conversationVersion = null;
  value.refreshPending = true;
  if (hooks.paneOpen(id) && !document.hidden) {
    revalidate(value, value.generation);
    void loadPage(id);
  }
}

export function loadPage(
  id: string,
  signal?: AbortSignal,
): Promise<void> | void {
  const value = entry(id);
  if (value.inflight) return value.pending;
  if (value.complete || value.error || id === "__draft__") return;
  const controller = signal ? null : new AbortController();
  const activeSignal = signal || controller!.signal;
  const request = ++value.request;
  value.controller = controller;
  value.inflight = true;
  if (!value.cursor) value.lastRefresh = performance.now();
  const query = new URLSearchParams();
  if (value.initialized && value.cursor) query.set("cursor", value.cursor);
  if (value.generation !== null)
    query.set("generation", String(value.generation));
  query.set("limit", String(FILES_PAGE_SIZE));
  const url = `/api/conversations/${encodeURIComponent(id)}/files?${query}`;
  return (value.pending = backendFor(id)
    .api(url, { signal: activeSignal })
    .then(async (response) => {
      if (
        (lastSelectedId && lastSelectedId !== id) ||
        value.request !== request
      ) {
        // Invariant: An unread body holds its connection open; release it.
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok) throw new Error(`files ${response.status}`);
      const page = (await response.json()) as FilesPage;
      if (
        (lastSelectedId && lastSelectedId !== id) ||
        value.request !== request
      )
        return;
      if (
        page.stale ||
        (value.generation !== null && value.generation !== page.generation)
      ) {
        revalidate(value, page.generation);
        if (!activeSignal.aborted && !document.hidden && hooks.paneOpen(id))
          void loadPage(id, activeSignal);
        return;
      }
      value.generation = page.generation;
      for (const incoming of page.files || []) {
        if (!incoming || typeof incoming.key !== "string" || !incoming.key)
          continue;
        const prior = value.files.get(incoming.key);
        if (!prior) {
          value.files.set(incoming.key, {
            ...incoming,
            references: Math.max(0, Number(incoming.references) || 0),
            sources: (incoming.sources || []).slice(0, MAX_CLIENT_SOURCES),
          });
          continue;
        }
        prior.references += Math.max(0, Number(incoming.references) || 0);
        const identities = new Set(
          prior.sources.map(
            (source) =>
              `${source.offset ?? "pending"}:${source.message_id || ""}`,
          ),
        );
        for (const source of incoming.sources || []) {
          const identity = `${source.offset ?? "pending"}:${source.message_id || ""}`;
          if (
            identities.has(identity) ||
            prior.sources.length >= MAX_CLIENT_SOURCES
          )
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
      value.cursor = page.cursor;
      value.capped = !!page.capped;
      value.complete = !!page.done || !page.cursor;
      value.initialized = true;
      value.error = null;
      value.displayFiles = null;
    })
    .catch(() => {
      if (request !== value.request) return;
      if (activeSignal.aborted) {
        if (!value.initialized) value.error = null;
        return;
      }
      value.error = value.displayFiles
        ? "Couldn’t refresh files. Showing the last loaded version."
        : value.initialized
          ? "Couldn’t load older files. Showing what loaded."
          : "Couldn’t load files.";
    })
    .finally(() => {
      if (request !== value.request) return;
      value.inflight = false;
      value.pending = undefined;
      value.controller = null;
      changed();
    }));
}

function conversationVersion(ctx: PaneContext): string | null {
  const conv = ctx.conv;
  if (!conv || conv.id !== ctx.agentId) return null;
  // Invariant: Status/version/tree stamps capture settle and between-poll
  // turns. Each distinct version reloads once; unchanged legacy message counts
  // do not prove no publication occurred.
  return [
    conv.message_log_generation ?? 0,
    conv.msg_count,
    conv.status,
    ctx.nodes[ctx.agentId]?.updated ?? 0,
    JSON.stringify(
      (conv.pending || []).map((message) => [
        message.id,
        message.attachment_ids,
        (message.attachments || []).map((file) => file.id),
      ]),
    ),
  ].join(":");
}

// Open panes read immediately; closed probes queue per agent and abort on
// switch. loadPage guards make completed repeat probes no-ops.
export function scheduleFetch(id: string): void {
  if (!id || id === "__draft__") return;
  fetchPaneData(PANE_ID, id, (signal) => loadPage(id, signal));
}

export function available(ctx: PaneContext): boolean | undefined {
  const id = ctx.agentId;
  const switched = lastSelectedId !== id;
  if (switched) {
    if (lastSelectedId) abandon(entry(lastSelectedId));
    lastSelectedId = id && id !== "__draft__" && ctx.node ? id : null;
  }
  if (!id || id === "__draft__" || !ctx.node) return false;
  const version = conversationVersion(ctx);
  if (version === null) return false;
  const value = entry(id);
  const paneOpen = hooks.paneOpen(id);
  // Invariant: A selection boundary is a fresh opportunity to observe the owned
  // file collection. A completed empty (or stale) projection must not suppress
  // the next probe merely because conversation metadata did not change.
  if (switched && value.complete) revalidate(value, value.generation);
  // Invariant: Stale-while-revalidate like the Changes pane: a version move
  // resets the closed entry and its probe re-establishes availability, but a
  // matching version keeps its warm button while the probe converges the tail
  // pages. An open pane's refresh belongs to update(), never to this reset.
  if (!paneOpen && value.conversationVersion !== version) {
    reset(value, ctx.conv?.message_log_generation ?? null, true);
    value.conversationVersion = version;
  }
  // Invariant: First discovery needs a snapshot with files or an error. An open
  // pending read stays offered; only a settled empty snapshot hides its controls.
  if (!paneOpen) scheduleFetch(id);
  if (
    (paneOpen && value.inflight) ||
    value.error !== null ||
    (value.initialized && visibleFiles(value).size > 0)
  )
    return true;
  return !value.complete && !value.error ? undefined : false;
}

export function badge(ctx: PaneContext): string | number | null {
  const value = cache.get(ctx.agentId);
  if (!value?.initialized) return null;
  const count = visibleFiles(value).size;
  return value.complete && !value.capped ? count : `${count}+`;
}

export function refreshCollection(
  value: CacheEntry,
  ctx: PaneContext,
  opened: boolean,
  switched: boolean,
): boolean {
  const version = conversationVersion(ctx);
  const running = ctx.conv?.status === "running";
  const changed = value.conversationVersion !== version;
  // Invariant: A change throttled away while running is still owed: the settle
  // poll consumes it, so a fast turn never slips through between polls.
  if (changed && running) value.refreshPending = true;
  const refresh =
    !document.hidden &&
    version !== null &&
    (opened ||
      switched ||
      (!value.inflight &&
        (changed || value.refreshPending) &&
        (!running || performance.now() - value.lastRefresh >= 60_000)));
  if (refresh) {
    if (value.initialized)
      revalidate(value, ctx.conv?.message_log_generation ?? null);
    value.conversationVersion = version;
    value.refreshPending = false;
  }
  return refresh;
}

export async function attachmentFile(
  cid: string,
  attachmentId: string,
): Promise<SessionFile | null> {
  const value = entry(cid);
  let file = selectedFile(visibleFiles(value).values(), { id: attachmentId });
  if (!file && value.complete) revalidate(value, value.generation);
  while (!file && !value.complete && !value.error && cid === state.selectedId) {
    await loadPage(cid);
    file = selectedFile(visibleFiles(value).values(), { id: attachmentId });
  }
  return cid === state.selectedId ? file : null;
}

export function downloadHref(cid: string, file: SessionFile): string | null {
  if (file.image_url)
    return file.image_url.replace(
      /^(\/api\/[^#]*\/path-image\?[^#]*)$/,
      "$1&download=1",
    );
  if (!file.id || file.unavailable) return null;
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/attachments/${encodeURIComponent(file.id)}`,
  );
}

export function imageHref(cid: string, file: SessionFile): string | null {
  if (file.image_url) return file.image_url;
  const base = downloadHref(cid, file);
  if (!base || file.preview !== "image") return null;
  // Invariant: The bytes route forces octet-stream + nosniff (never renders);
  // raster display goes through the inline-only preview capability.
  return `${base}/preview`;
}

export function mediaHref(cid: string, file: SessionFile): string | null {
  const base = downloadHref(cid, file);
  if (!base || (file.preview !== "audio" && file.preview !== "video"))
    return null;
  return `${base}/preview`;
}

export function textPreviewHref(cid: string, file: SessionFile): string | null {
  if (!file.id || file.preview !== "text" || file.unavailable) return null;
  return backendFor(cid).url(
    `/api/conversations/${encodeURIComponent(cid)}/files/${file.storage}/${encodeURIComponent(file.id)}/preview`,
  );
}

function retainPreview(id: string, key: string): void {
  const value = entry(id);
  const detailKey = hooks.detailKey(id);
  const next = value.previewLru.filter((candidate) => candidate !== key);
  next.push(key);
  while (next.length > MAX_TEXT_PREVIEW_CACHES) {
    const index = next.findIndex((candidate) => candidate !== detailKey);
    if (index < 0) break;
    const [oldest] = next.splice(index, 1);
    if (!oldest) break;
    const preview = value.previews.get(oldest);
    if (!preview) continue;
    preview.controller?.abort();
    preview.controller = undefined;
    preview.status = "evicted";
    preview.text = undefined;
    preview.truncated = undefined;
  }
  value.previewLru = next;
}

function ensureFilePreview(
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

export function reloadPreview(id: string, key: string): void {
  const value = entry(id);
  const preview = ensureFilePreview(value.previews, key);
  preview.status = "idle";
  preview.text = undefined;
  preview.truncated = undefined;
  value.previewLru = value.previewLru.filter((candidate) => candidate !== key);
  changed();
}

export function loadTextPreview(id: string, file: SessionFile): void {
  const value = entry(id);
  const preview = ensureFilePreview(value.previews, file.key);
  const href = textPreviewHref(id, file);
  if (!href || preview.status !== "idle") return;
  const controller = new AbortController();
  preview.status = "loading";
  preview.controller = controller;
  backendFor(id)
    .api(href, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error("preview unavailable");
      const payload = (await response.json()) as {
        kind?: unknown;
        text?: unknown;
        truncated?: unknown;
      };
      if (id !== state.selectedId || value.previews.get(file.key) !== preview)
        return;
      if (payload.kind !== "text" || typeof payload.text !== "string")
        throw new Error("invalid preview");
      preview.status = "ready";
      preview.text = payload.text;
      preview.truncated = payload.truncated === true;
      retainPreview(id, file.key);
    })
    .catch(() => {
      if (!controller.signal.aborted) preview.status = "missing";
    })
    .finally(() => {
      preview.controller = undefined;
      if (id === state.selectedId) changed();
    });
}

export async function deleteFile(
  cid: string,
  file: SessionFile,
): Promise<void> {
  const href = downloadHref(cid, file);
  if (!href) return;
  if (!confirm(`Delete ${file.name}? This cannot be undone.`)) return;
  const value = entry(cid);
  try {
    const response = await backendFor(cid).api(href, { method: "DELETE" });
    if (!response.ok) throw new Error(`delete ${response.status}`);
  } catch {
    value.failedDeletion = file;
    changed();
    return;
  }
  if (value.failedDeletion?.key === file.key) value.failedDeletion = null;
  value.files.delete(file.key);
  value.displayFiles?.delete(file.key);
  value.previews.delete(file.key);
  value.previewLru = value.previewLru.filter(
    (candidate) => candidate !== file.key,
  );
  document.dispatchEvent(
    new CustomEvent("recurse:file-deleted", { detail: { cid, key: file.key } }),
  );
  changed();
}
