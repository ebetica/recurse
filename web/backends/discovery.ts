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

/** Starts remote tree reads, at most two at once, independent of the home. */
export function refreshRemoteTrees(
  apply: (label: string, read: TreeRead | null) => boolean,
  force = false,
): void {
  if (embeddedFrameHidden()) return;
  if (!discovered) queueDiscovery();
  const trees = remotes().map(
    (backend) => [backend.label, treeOf(backend)] as const,
  );
  let reading = trees.filter(([, tree]) => tree.reading).length;
  for (let i = 0; i < trees.length; i++) {
    const [label, tree] = trees[(rotation + i) % trees.length]!;
    if (!tree.reading && reading >= REMOTE_TREE_READS) continue;
    const wasReading = tree.reading;
    void tree.refresh((read) => apply(label, read), force);
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
      if (existing?.directUrl === row.url) continue;
      if (existing) {
        treeOf(existing).invalidate();
        removeNodes(row.label);
      }
      const backend = new Backend(row.label);
      backend.directUrl = row.url;
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
              document
                .querySelector<HTMLButtonElement>("#settings-btn")
                ?.click()}
          >
            ${message} — Remotes
          </button>`
        : nothing}
  </div>`;
}
