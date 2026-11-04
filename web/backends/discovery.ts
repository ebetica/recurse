// Register approved remotes without joining the home's tree or focused read.
// tree.ts owns per-backend version checks, snapshots, status and retry backoff.
// conversation/poll.ts commits all snapshots; offline sections keep theirs.
import { html, nothing, type TemplateResult } from "lit";
import { api } from "../api.js";
import { backgroundWork } from "../background-work.js";
import { embeddedFrameHidden, state } from "../state.js";
import {
  Backend,
  backends,
  findBackend,
  registerBackend,
  unregisterBackend,
} from "./backend.js";
import { lastSeen, treeOf, type TreeRead } from "./tree.js";

const remotes = () => backends().filter((backend) => backend.label);
let discovering = false;
let discoveryRequested = false;
let discovered = false;
const changed = () =>
  window.dispatchEvent(new Event("recurse:backends-change"));

export function remoteBootPending(id: string | null): boolean {
  if (!id?.includes("/")) return false;
  const backend = findBackend(id.split("/")[0]!);
  return !discovered || (!!backend && treeOf(backend).status === "loading");
}

function removeNodes(label: string): void {
  for (const id of Object.keys(state.nodes))
    if (id.startsWith(label + "/")) delete state.nodes[id];
}

// Cap remote reads to preserve this origin's scarce HTTP/1.1 connections.
const REMOTE_TREE_READS = 2;
let rotation = 0;
const changedTrees = new Set<string>();
const watchedReads = new WeakSet<Promise<boolean>>();

/** Queue pushed tag changes through the same bounded remote-read scheduler. */
export function refreshChangedRemoteTrees(
  labels: string[],
  apply: (label: string, read: TreeRead | null) => boolean,
): void {
  for (const label of labels) changedTrees.add(label);
  refreshRemoteTrees(apply);
}

/** Starts remote tree reads, at most two at once, independent of the home. */
export function refreshRemoteTrees(
  apply: (label: string, read: TreeRead | null) => boolean,
  force = false,
): void {
  if (embeddedFrameHidden()) return;
  if (!discovered) queueDiscovery();
  const remote = remotes();
  const trees = remote.map((_, i) => {
    const backend = remote[(rotation + i) % remote.length]!;
    return [
      backend.label,
      treeOf(backend),
      backend.apiVersion === null,
    ] as const;
  });
  for (const label of changedTrees)
    if (!remote.some((backend) => backend.label === label))
      changedTrees.delete(label);
  trees.sort(
    ([a], [b]) => Number(changedTrees.has(b)) - Number(changedTrees.has(a)),
  );
  let reading = trees.filter(([, tree]) => tree.reading).length;
  for (const [label, tree, versionPending] of trees) {
    if (!tree.reading && reading >= REMOTE_TREE_READS) continue;
    const wasReading = tree.reading;
    const commit = (read: TreeRead | null) => apply(label, read);
    const changed =
      !(tree.reading && versionPending) && changedTrees.delete(label);
    const done = changed
      ? tree.refreshChanged(commit)
      : tree.refresh(commit, force);
    if (tree.reading && !watchedReads.has(done)) {
      watchedReads.add(done);
      void done.finally(() => {
        if (changedTrees.size) refreshRemoteTrees(apply);
      });
    }
    if (!wasReading && tree.reading) reading++;
  }
  rotation = (rotation + 1) % (trees.length || 1);
}

async function discover(signal: AbortSignal): Promise<void> {
  if (discovering) return;
  discovering = true;
  discoveryRequested = false;
  try {
    const response = await api("/api/backends", { signal });
    if (!response.ok) return;
    const rows = (await response.json()) as Array<{
      label: string;
      url: string;
      state: string;
      reason: string | null;
      compatibility?: string;
      last_contact: number | null;
    }>;
    const approved = rows.filter((row) => row.state !== "pending");
    for (const backend of remotes()) {
      if (approved.some((row) => row.label === backend.label)) continue;
      treeOf(backend).invalidate();
      unregisterBackend(backend.label);
      removeNodes(backend.label);
    }
    for (const row of approved) {
      const existing = findBackend(row.label);
      const compatibility =
        row.compatibility === "incompatible" &&
        (row.state === "connected" || row.reason === "Health check pending")
          ? "incompatible"
          : "unknown";
      if (existing?.directUrl === row.url) {
        if (existing.compatibility !== compatibility) {
          existing.compatibility = compatibility;
          treeOf(existing).invalidate();
        }
        if (row.compatibility === "compatible" || row.compatibility === "older")
          treeOf(existing).confirmCompatible();
        continue;
      }
      if (existing) {
        treeOf(existing).invalidate();
        removeNodes(row.label);
      }
      const backend = new Backend(row.label);
      backend.directUrl = row.url;
      backend.compatibility = compatibility;
      registerBackend(backend);
      treeOf(backend, row.last_contact);
    }
  } catch {
  } finally {
    if (!signal.aborted) discovered = true;
    discovering = false;
    changed();
    if (discoveryRequested) setTimeout(queueDiscovery, 0);
  }
}

function queueDiscovery(): void {
  if (embeddedFrameHidden()) return;
  backgroundWork.enqueue("backend-discovery", discover);
}

export function startBackendDiscovery(): void {
  queueDiscovery();
  window.addEventListener("recurse:refresh-remotes", () => {
    discoveryRequested = true;
    queueDiscovery();
  });
  setInterval(queueDiscovery, 60_000);
}

export function remoteSectionHeader(backend: Backend): TemplateResult {
  const { label, directUrl: url } = backend;
  const { status, lastContact } = treeOf(backend);
  const message =
    status === "unreachable"
      ? `Offline · ${lastSeen(lastContact)}`
      : status === "key revoked"
        ? "reconnect in Settings"
        : status;
  return html`<div class="backend-heading">
    <strong>${label}</strong>
    <span
      class="backend-status"
      title=${status === "unreachable" && lastContact !== null
        ? new Date(lastContact * 1000).toLocaleString()
        : message}
      >${status === "unreachable" ? message : status}</span
    >
    ${status === "incompatible version"
      ? html`<a href=${url} target="_blank" rel="noopener noreferrer"
          >open ${url} directly</a
        >`
      : status === "key revoked"
        ? html`<button
            class="backend-settings"
            @click=${() =>
              window.dispatchEvent(
                new CustomEvent("recurse:open-settings", { detail: "account" }),
              )}
          >
            ${message} — Remotes
          </button>`
        : nothing}
  </div>`;
}
