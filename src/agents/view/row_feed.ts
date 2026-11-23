// Ordered rows, window cursors and revisions for one conversation view.
// Backfill adds history without a live revision; changes to held rows still count.

import type { Block } from "./entry_rows";
import { textHash } from "./text_hash";

interface TextMark {
  readonly length: number;
  readonly hash: number;
}

/** Streaming assistant text grows by appends; other rows are sent whole. */
function appendable(row: Block | undefined): row is Block {
  return row?.kind === "text" && row.role === "assistant";
}

/** The row with only its text after `held`, or whole if that is no prefix. */
function textDelta(row: Block, held: TextMark | null | undefined): Block {
  if (!held?.length || !appendable(row) || row.text.length < held.length)
    return row;
  if (textHash(row.text.slice(0, held.length)) !== held.hash) return row;
  return {
    ...row,
    text: row.text.slice(held.length),
    text_from: held.length,
    text_hash: held.hash,
  };
}

interface Snapshot {
  readonly instance_id: string;
  readonly revision: number;
  readonly blocks: readonly Block[];
  readonly older: boolean;
  readonly newer: boolean;
  readonly removed: readonly string[];
  readonly reset: boolean;
}

export class RowFeed {
  revision = 0;
  private blocks: Block[] = [];
  private readonly index = new Map<string, number>();
  private nextOrder = 0;
  private firstOrder = 0;
  /** Each change, with the row's text mark from before it. */
  private readonly changesLog: Array<[number, string, TextMark | null]> = [];
  private backfillExisting: ReadonlySet<string> | null = null;
  /** Each assistant row's text mark as of its latest change. */
  private readonly textMarks = new Map<string, TextMark>();

  constructor(readonly instance_id: string) {}

  get rows(): readonly Block[] {
    return this.blocks;
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  position(id: string): number | undefined {
    return this.index.get(id);
  }

  get(id: string): Block | undefined {
    return this.blocks[this.index.get(id) ?? -1];
  }

  takeOrder(): number {
    return this.nextOrder++;
  }

  append(row: Block, live: boolean): void {
    this.index.set(row.id, this.blocks.length);
    this.blocks.push(Object.freeze({ ...row, live, order: this.takeOrder() }));
    this.changed(row.id);
  }

  replace(row: Block): void {
    const position = this.index.get(row.id);
    if (position === undefined) throw new Error("cannot replace an absent row");
    this.blocks[position] = row;
    this.changed(row.id);
  }

  insert(position: number, row: Block): void {
    this.blocks.splice(position, 0, row);
    this.indexRange(position);
    this.changed(row.id);
  }

  move(from: number, target: number, order: number): boolean {
    const [row] = this.blocks.splice(from, 1);
    if (row === undefined) return false;
    this.blocks.splice(target, 0, Object.freeze({ ...row, order }));
    this.indexRange(Math.min(from, target), Math.max(from, target) + 1);
    this.changed(row.id);
    return true;
  }

  remove(rowId: string): boolean {
    const position = this.index.get(rowId);
    if (position === undefined) return false;
    this.blocks.splice(position, 1);
    this.index.delete(rowId);
    this.indexRange(position);
    this.changed(rowId);
    return true;
  }

  removeWhere(predicate: (row: Block) => boolean): void {
    const removed = this.blocks.filter(predicate).map((row) => row.id);
    if (removed.length === 0) return;
    const removedIds = new Set(removed);
    for (const id of removed) this.index.delete(id);
    this.reorder(this.blocks.filter((row) => !removedIds.has(row.id)));
    for (const id of removed) this.changed(id);
  }

  private indexRange(start: number, end = this.blocks.length): void {
    for (let position = start; position < end; position += 1)
      this.index.set(this.blocks[position]!.id, position);
  }

  private reorder(ordered: Block[]): void {
    for (let position = 0; position < ordered.length; position += 1) {
      const id = ordered[position]!.id;
      if (this.blocks[position]?.id !== id) this.index.set(id, position);
    }
    this.blocks = ordered;
  }

  backfill(ingest: () => void, reconcile: () => void): void {
    // Invariant: Split old and new rows by id, not by count: an older entry may
    // remove a displayed row (a compaction hides its notice), shifting every
    // position.
    const existing = new Set(this.blocks.map((row) => row.id));
    this.backfillExisting = existing;
    try {
      ingest();
      const prefix = this.blocks.filter((row) => !existing.has(row.id));
      this.firstOrder -= prefix.length;
      const orderedPrefix = prefix.map((row, index) =>
        Object.freeze({ ...row, order: this.firstOrder + index }),
      );
      this.reorder([
        ...orderedPrefix,
        ...this.blocks.filter((row) => existing.has(row.id)),
      ]);
      reconcile();
    } finally {
      this.backfillExisting = null;
    }
  }

  orderLiveTail(): void {
    const persisted = this.blocks
      .filter((row) => !row.live)
      .sort((left, right) => left.order - right.order);
    const live = this.blocks.filter((row) => row.live);
    live.forEach((row, index) => {
      const order = this.nextOrder + index;
      if (row.order !== order) {
        live[index] = Object.freeze({ ...row, order });
        this.changed(row.id);
      }
    });
    this.reorder([...persisted, ...live]);
  }

  changed(identity: string): void {
    const position = this.index.get(identity);
    const row = position === undefined ? undefined : this.blocks[position];
    if (this.backfillExisting === null || this.backfillExisting.has(identity)) {
      this.revision += 1;
      this.changesLog.push([
        this.revision,
        identity,
        this.textMarks.get(identity) ?? null,
      ]);
      if (this.changesLog.length > 512) this.changesLog.shift();
    }
    if (appendable(row) && row.id === identity)
      this.textMarks.set(identity, {
        length: row.text.length,
        hash: textHash(row.text),
      });
    else this.textMarks.delete(identity);
  }

  /**
   * Rows changed after `since`; with `textDeltas`, assistant rows still
   * extending their text at `since` carry only the rest and `text_from`.
   */
  changes(since: number, limit: number, textDeltas = false): Snapshot {
    if (
      since > this.revision ||
      since < 0 ||
      (this.changesLog.length > 0 && since < this.changesLog[0]![0] - 1)
    ) {
      return Object.freeze({ ...this.window({ limit }), reset: true });
    }
    const held = new Map<string, TextMark | null>();
    for (const [revision, identity, mark] of this.changesLog)
      if (revision > since && !held.has(identity)) held.set(identity, mark);
    const changed = new Set(held.keys());
    if (changed.size > limit)
      return Object.freeze({ ...this.window({ limit }), reset: true });
    const rows = this.blocks
      .filter((row) => changed.has(row.id))
      .map((row) => (textDeltas ? textDelta(row, held.get(row.id)) : row));
    const removed = [...changed]
      .filter((identity) => !this.index.has(identity))
      .sort();
    return Object.freeze({
      instance_id: this.instance_id,
      revision: this.revision,
      blocks: Object.freeze(rows),
      older: false,
      newer: false,
      removed: Object.freeze(removed),
      reset: false,
    });
  }

  // Cursor window: latest rows, forward after a row, or backward before one.
  window(
    options: {
      after?: string | null;
      before?: string | null;
      limit?: number;
    } = {},
  ): Snapshot {
    const after = options.after ?? null;
    const before = options.before ?? null;
    const limit = options.limit ?? 50;
    const total = this.blocks.length;
    const beforePosition = before === null ? undefined : this.index.get(before);
    if (beforePosition !== undefined)
      return this.snapshot(
        Math.max(0, beforePosition - limit),
        beforePosition,
        total,
      );
    const afterPosition = after === null ? undefined : this.index.get(after);
    const start =
      after === null
        ? Math.max(0, total - limit)
        : afterPosition !== undefined
          ? afterPosition + 1
          : total;
    return this.snapshot(start, Math.min(total, start + limit), total);
  }

  private snapshot(start: number, end: number, total: number): Snapshot {
    return Object.freeze({
      instance_id: this.instance_id,
      revision: this.revision,
      blocks: Object.freeze(this.blocks.slice(start, end)),
      older: start > 0,
      newer: end < total,
      removed: Object.freeze([]),
      reset: false,
    });
  }
}
