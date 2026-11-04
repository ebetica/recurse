// One visible-tab SSE connection carries home and remote tag invalidations.
// The usual loaders still own snapshots, errors, and stale-read fencing; polls
// remain the fallback for disconnected streams and older servers.
import {
  openSseConnection,
  type SseConnection,
} from "../connection/sse-transport.js";
import { embedded } from "../state.js";
import { backends, findBackend } from "./backend.js";
import { refreshChangedRemoteTrees } from "./discovery.js";
import { treeOf, type ApplyTree } from "./tree.js";

export function startTreeEvents(apply: (label: string) => ApplyTree): void {
  let stream: SseConnection | null = null;
  let current = "";
  let catchUp = false;
  const sync = () => {
    const labels = backends().map((backend) => backend.label);
    const next = !embedded && !document.hidden ? JSON.stringify(labels) : "";
    if (next === current) return;
    const wasOpen = stream !== null;
    stream?.close();
    stream = null;
    current = next;
    if (!next) {
      catchUp ||= wasOpen;
      return;
    }
    let initial = !catchUp;
    catchUp = false;
    const query = new URLSearchParams();
    for (const label of labels) if (label) query.append("backend", label);
    stream = openSseConnection(
      `/api/tree/events?${query}`,
      {},
      {
        onEvent: (kind, _id, data) => {
          if (kind !== "changed") return;
          if (initial) {
            initial = false;
            return;
          }
          const labels: unknown = JSON.parse(data);
          if (!Array.isArray(labels)) return;
          const remote: string[] = [];
          for (const label of labels) {
            if (typeof label !== "string") continue;
            const backend = findBackend(label);
            if (!backend) continue;
            if (label) remote.push(label);
            else void treeOf(backend).refreshChanged(apply(label));
          }
          if (remote.length)
            refreshChangedRemoteTrees(remote, (label, read) =>
              apply(label)(read),
            );
        },
        onFailure: () => {},
      },
    );
  };
  window.addEventListener("recurse:backends-change", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
}
