// Artifacts-pane list cache. This module owns fetching and invalidating the
// per-agent artifact list, including the stale-selection retry and the
// out-of-band rediscovery bound.
import {
  backendFor,
  parseConversationId,
  type Backend,
} from "../backends/backend.js";
import type { ArtifactInfo } from "./model.js";
import { artifactListUrl, normalizeArtifactList } from "./model.js";
import {
  artifactViewSnapshot,
  shouldPreserveArtifactView,
  stableArtifactView,
} from "./pane-state.js";
import { fetchPaneData, invalidatePaneCache } from "../panes.js";
import { renderShell } from "./pane.js";
import { showArtifact } from "./artifact-detail.js";
import { DRAFT, state } from "../state.js";
import { ARTIFACTS_REFRESH_EVENT, UI_REFRESH_EVENT } from "../ui-events.js";
import {
  ARTIFACTS_PANE_ID,
  artifactMount,
  caches,
  contentCache,
} from "./artifact-state.js";
import type { ArtifactEl, ListCache } from "./artifact-state.js";

const MAX_LIST_CACHES = 64;
const LIST_STALE_MS = 15_000;

function evictListCache(agentId: string, cache: ListCache): void {
  if (caches.get(agentId) !== cache) return;
  caches.delete(agentId);
  cache.controller?.abort();
}

export function entry(agentId: string): ListCache {
  let value = caches.get(agentId);
  if (value) {
    caches.delete(agentId);
    caches.set(agentId, value);
    return value;
  }
  value = {
    list: [],
    fetching: false,
    invalidated: true,
    pending: null,
    controller: null,
    loaded: false,
    error: null,
    selectionStale: false,
    readAt: 0,
  };
  caches.set(agentId, value);
  for (const [id, candidate] of caches) {
    if (caches.size <= MAX_LIST_CACHES) break;
    if (id !== agentId && !candidate.pending) evictListCache(id, candidate);
  }
  while (caches.size > MAX_LIST_CACHES) {
    const oldest = caches.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === agentId) break;
    evictListCache(oldest, caches.get(oldest)!);
  }
  return value;
}
export function listFor(agentId: string | null): ArtifactInfo[] {
  return agentId ? entry(agentId).list : [];
}
export function selectedInfo(pane: ArtifactEl): ArtifactInfo | null {
  return (
    listFor(pane._rs.agentId).find((item) => item.id === pane._rs.selId) || null
  );
}
export function errorText(prefix: string, response?: Response): string {
  return response ? `${prefix} (${response.status})` : prefix;
}

export async function refreshList(
  agentId: string,
  invalidate = false,
  signal?: AbortSignal,
): Promise<void> {
  if (!agentId || agentId === DRAFT) return;
  const cache = entry(agentId);
  if (invalidate) cache.invalidated = true;
  if (cache.pending) {
    await cache.pending;
    if (cache.invalidated && !signal?.aborted)
      await refreshList(agentId, false, signal);
    return;
  }
  if (!cache.invalidated && !cache.selectionStale) return;
  cache.invalidated = false;
  cache.selectionStale = false;
  cache.fetching = true;
  cache.error = null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  cache.controller = controller;
  const preserveBeforeFetch = stableArtifactView(
    artifactMount.current?._rs ?? null,
    agentId,
  );
  if (artifactMount.current?._rs.agentId === agentId && !preserveBeforeFetch)
    renderShell(artifactMount.current);
  const pending = (async () => {
    try {
      const response = await backendFor(agentId).api(artifactListUrl(agentId), {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(errorText("Couldn’t load artifacts", response));
      const next = normalizeArtifactList(await response.json());
      const preserve =
        artifactMount.current?._rs.agentId === agentId &&
        shouldPreserveArtifactView(
          artifactViewSnapshot(artifactMount.current._rs, agentId),
          next.map((item) => item.id),
        );
      if (preserve) {
        // Invariant: Keep the old list authoritative for rendering. The
        // response may be a transient pre-publication snapshot; a later pane
        // poll retries it.
        cache.selectionStale = true;
      } else {
        cache.list = next;
        cache.loaded = true;
      }
    } catch (err) {
      // Invariant: An abandoned background probe learned nothing. Leave this
      // agent re-fetchable instead of reporting a failure the reader never hit.
      if (signal?.aborted) {
        cache.invalidated = true;
        return;
      }
      if (controller.signal.aborted) return;
      cache.loaded = true;
      cache.error =
        err instanceof Error && err.message
          ? err.message
          : "Couldn’t load artifacts";
    } finally {
      signal?.removeEventListener("abort", abort);
      cache.fetching = false;
      cache.pending = null;
      cache.readAt = Date.now();
      if (cache.controller === controller) cache.controller = null;
      if (
        artifactMount.current?._rs.agentId === agentId &&
        !cache.selectionStale
      ) {
        renderShell(artifactMount.current);
        void showArtifact(artifactMount.current);
      }
    }
  })();
  cache.pending = pending;
  await pending;
  if (cache.invalidated && !signal?.aborted)
    await refreshList(agentId, false, signal);
}

// Route one list read at the priority the reader's attention implies: immediate
// while this pane is open, best-effort background warming while it is closed.
// The invalidation is recorded on the cache entry BEFORE queueing, so a probe
// the queue drops under its cap cannot lose it.
export function scheduleListRefresh(agentId: string, invalidate = false): void {
  if (!agentId || agentId === DRAFT) return;
  const cache = entry(agentId);
  // Invariant: Out-of-band publication may bypass mutation events. Bounded
  // rereads must rediscover artifacts, not cache an empty list forever.
  if (
    invalidate ||
    (cache.loaded &&
      !cache.pending &&
      Date.now() - cache.readAt >= LIST_STALE_MS)
  )
    cache.invalidated = true;
  fetchPaneData(ARTIFACTS_PANE_ID, agentId, (signal) =>
    refreshList(agentId, false, signal),
  );
}

function onMutation(event: Event): void {
  const id = (event as CustomEvent<{ agentId?: unknown }>).detail?.agentId;
  if (typeof id !== "string" || !id) return;
  // Invariant: Versioned payloads are immutable. Only current-revision content
  // needs an explicit mutation signal to become eligible for another request.
  contentCache.invalidateMutable(id);
  invalidatePaneCache("report", id);
  if (artifactMount.current?._rs.agentId === id) {
    // Invariant: A mutation is also the explicit retry boundary for a prior
    // transient content failure. Ordinary pane refreshes remain cache/error
    // hits.
    artifactMount.current._rs.failedKey = null;
    if (artifactMount.current._rs.selectedVersion === null) {
      // Invariant: Supersede a current-revision request already in flight as
      // well as the displayed key. The list refresh's completion calls
      // showArtifact once.
      artifactMount.current._rs.requestSeq++;
      artifactMount.current._rs.loadingKey = null;
      artifactMount.current._rs.shownKey = null;
    }
  }
  const cache = caches.get(id);
  if (cache) cache.invalidated = true;
  if (state.selectedId === id || artifactMount.current?._rs.agentId === id)
    scheduleListRefresh(id, true);
}

const unsupportedRevisionBackends = new WeakSet<Backend>();
let revisionProbePending = false;
let observedRevision: { agentId: string; revision: string | null } | null =
  null;

async function checkOpenArtifactRevision(): Promise<void> {
  const pane = artifactMount.current;
  const agentId = pane?._rs.agentId;
  if (revisionProbePending || document.hidden || !pane?.isConnected || !agentId)
    return;
  revisionProbePending = true;
  try {
    const backend = backendFor(agentId);
    if (unsupportedRevisionBackends.has(backend)) return;
    const response = await backend.api(
      `/api/artifacts/revision?agent=${encodeURIComponent(parseConversationId(agentId).cid)}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (backend.label && (response.status === 404 || response.status === 405))
      unsupportedRevisionBackends.add(backend);
    if (!response.ok) return;
    const { revision } = (await response.json()) as { revision: string | null };
    if (
      artifactMount.current !== pane ||
      !pane.isConnected ||
      pane._rs.agentId !== agentId
    )
      return;
    const changed =
      observedRevision?.agentId !== agentId ||
      observedRevision.revision !== revision;
    observedRevision = { agentId, revision };
    if (changed) await refreshList(agentId, true);
  } catch {
    // Invariant: Failed probes defer to normal list error/retry handling.
  } finally {
    revisionProbePending = false;
  }
}

setInterval(() => void checkOpenArtifactRevision(), 750);
window.addEventListener("focus", () => void checkOpenArtifactRevision());
document.addEventListener(
  "visibilitychange",
  () => void checkOpenArtifactRevision(),
);

window.addEventListener(UI_REFRESH_EVENT, onMutation);
window.addEventListener(ARTIFACTS_REFRESH_EVENT, onMutation);
