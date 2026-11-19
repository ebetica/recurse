// Opt-in /api/tree patches use the weak ETag of the exact ordered snapshot.
// History is per server, not per reader. Older clients use the legacy route.
import { PRIVATE_REVALIDATE, ifNoneMatchMatches, weakEtag } from "./caching";
import type { TreeDelta } from "./tree_protocol";

type Row = { id: string };

const HISTORY_LIMIT = 8;
const MAX_SNAPSHOT_LENGTH = 128 * 1024;

export class TreeDeltaHistory {
  private readonly snapshots = new Map<string, string>();

  respond(request: Request, rows: Row[], base: string): Response {
    const full = JSON.stringify(rows);
    const etag = weakEtag(full);
    const bootstrap = base === "snapshot";
    const before = this.snapshots.get(base);
    if (full.length <= MAX_SNAPSHOT_LENGTH && !this.snapshots.has(etag)) {
      if (this.snapshots.size === HISTORY_LIMIT)
        this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(etag, full);
    }
    // Invariant: Only bootstrap shares the legacy HTTP snapshot cache.
    const headers = {
      etag,
      "cache-control": bootstrap ? PRIVATE_REVALIDATE : "private, no-store",
    };
    if (
      bootstrap &&
      ifNoneMatchMatches(request.headers.get("if-none-match"), etag)
    )
      return new Response(null, { status: 304, headers });

    let body = base === etag ? '{"unchanged":true}' : full;
    let size = Buffer.byteLength(body);
    if (base !== etag && before !== undefined) {
      const previous = JSON.parse(before) as Row[];
      const byId = new Map(previous.map((row) => [row.id, row]));
      const delta: TreeDelta<Row> = {
        base,
        changed: rows.filter((row) => {
          const old = byId.get(row.id);
          byId.delete(row.id);
          return JSON.stringify(old) !== JSON.stringify(row);
        }),
        deleted: [...byId.keys()],
      };
      if (
        rows.length !== previous.length ||
        rows.some((row, i) => row.id !== previous[i]?.id)
      )
        delta.order = rows.map((row) => row.id);
      const patch = JSON.stringify(delta);
      const patchSize = Buffer.byteLength(patch);
      if (patchSize < size) {
        body = patch;
        size = patchSize;
      }
    }
    return new Response(body, {
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-length": String(size),
      },
    });
  }
}
