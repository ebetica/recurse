// Pure ordering helper for manual titles. The origin-issued order is sent to
// the backend, so later edits win even when HTTP processing reverses; the local
// revision also fences callbacks that resolve out of order.
export interface TitleAction {
  revision: number;
  order: string;
}

export class TitleActionOrder {
  private revisions = new Map<string, number>();
  private lastStamp = 0n;
  private readonly clientId: string;

  constructor(clientId = Math.random().toString(36).slice(2, 14)) {
    this.clientId =
      clientId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "client";
  }

  begin(id: string, nowMs = Date.now()): TitleAction {
    const revision = (this.revisions.get(id) || 0) + 1;
    this.revisions.set(id, revision);
    const wall = BigInt(Math.max(0, Math.trunc(nowMs))) * 1_000_000n;
    this.lastStamp = wall > this.lastStamp ? wall : this.lastStamp + 1n;
    return {
      revision,
      order: `${this.lastStamp.toString().padStart(20, "0")}-${this.clientId}`,
    };
  }

  isCurrent(id: string, action: TitleAction): boolean {
    return this.revisions.get(id) === action.revision;
  }
}

export interface PendingManualTitle {
  title: string;
  acknowledged: boolean;
  waitForSettle: boolean;
}

export function reconcilePendingManualTitle(
  node: { title?: string | null; status?: string },
  pending: PendingManualTitle,
): boolean {
  const observedTitle = node.title;
  node.title = pending.title;
  // Invariant: Text equality alone is not an acknowledgement: in an A→B→A
  // rename, a pre-action poll already contains A. A running rename is confirmed
  // only by a post-response snapshot after that turn has settled and persisted
  // its drain.
  const settled =
    node.status === "idle" ||
    node.status === "error" ||
    node.status === "interrupted" ||
    node.status === "working";
  return (
    pending.acknowledged &&
    observedTitle === pending.title &&
    (!pending.waitForSettle || settled)
  );
}
