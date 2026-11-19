// Owns optimistic sidebar tags until a tree read begun after the POST answer.
import { backendFor, treeOf } from "../backends/index.js";
import { state } from "../state.js";
import { liveTags, type Tags } from "../../src/sidebar_script/index.js";

export interface Change {
  set: Record<string, number | null>;
  clear: string[];
  /** When the change is shown to have happened, for reply comparisons. */
  at: number;
  /** Owning backend's tree reads started before the server answered. */
  readsBefore?: number;
}
export const pending = new Map<string, Change[]>();

/** The tree's tags with this browser's unconfirmed changes applied in order.
 * A change is confirmed by the first tree read that started after its answer,
 * never by an older read that happens to agree with it. */
export function shownTags(id: string, now: number): Tags {
  const tags = liveTags(state.nodes[id]?.tags, -Infinity);
  const read = treeOf(backendFor(id)).appliedRead;
  const changes = (pending.get(id) ?? []).filter(
    (c) => c.readsBefore === undefined || read <= c.readsBefore,
  );
  if (changes.length) pending.set(id, changes);
  else pending.delete(id);
  for (const change of changes) {
    for (const name of change.clear) delete tags[name];
    for (const [name, until] of Object.entries(change.set))
      tags[name] =
        until === null
          ? { at: change.at, by: "operator" }
          : { at: change.at, by: "operator", until };
  }
  return liveTags(tags, now);
}

export function drop(id: string, change: Change): void {
  const left = (pending.get(id) ?? []).filter((c) => c !== change);
  if (left.length) pending.set(id, left);
  else pending.delete(id);
}
