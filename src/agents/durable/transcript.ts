// Bounded Durable transcript windows expose entry-ID cursors as offset pairs.
// Before B selects newest IDs below B; after A selects oldest IDs from A.
// Prev is oldest examined; next follows newest. Reads use CHUNK, cap MAX_IDS.
import type {
  Conversation,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { projectionEntries, rowState } from "./durable_rows";

type Rec = Record<string, unknown>;
type Row = [off: number, entry: Rec];
export type TranscriptQuery = {
  limit: number;
  before?: number | null;
  after?: number | null;
};

const CHUNK = 100;
const MAX_IDS = 2000;
const ROLES = new Set(["user", "assistant", "toolResult"]);

/** Message rows of the entries with ids lo..hi, oldest first. */
async function messageRows(
  read: TranscriptReader,
  lo: number,
  hi: number,
): Promise<Row[]> {
  return projectionEntries(
    (await read(lo, hi, CHUNK)).reverse(),
    rowState(),
  ).flatMap((row) => {
    const message = row.message as Rec | undefined;
    if (row.type !== "message" || !ROLES.has(String(message?.role))) return [];
    const timestamp =
      row.timestamp ?? new Date(Number(message!.timestamp)).toISOString();
    return [[Number(row._offset), { type: "message", timestamp, message }]];
  });
}

export async function transcriptWindow(
  conversation: Conversation,
  options: TranscriptQuery,
  context: Context,
): Promise<{ rows: Row[]; prev: number; next: number }> {
  return transcriptEntries(async (lo, hi, limit) => {
    const page = await conversation.entries(
      { minEntryId: lo as EntryId, maxEntryId: hi as EntryId },
      limit,
      undefined,
      context,
    );
    return [...page.items];
  }, options);
}

type TranscriptReader = (
  lo: number,
  hi: number,
  limit: number,
) => Promise<EntryRecord[]>;

/** The same bounded window for a closed, read-only archive. */
export async function transcriptEntries(
  read: TranscriptReader,
  options: TranscriptQuery,
): Promise<{ rows: Row[]; prev: number; next: number }> {
  const newest = (await read(0, Number.MAX_SAFE_INTEGER, 1))[0];
  const end = newest === undefined ? 0 : Number(newest.id) + 1;
  const forward = options.after != null;
  const cursor = (forward ? options.after : options.before) ?? end;
  const from = Math.min(Math.max(cursor, 0), end);
  const rows: Row[] = [];
  const full = () => rows.length >= options.limit;
  let edge = from;
  for (let scanned = 0; scanned < MAX_IDS && !full(); scanned += CHUNK) {
    const lo = Math.max(forward ? from + scanned : from - scanned - CHUNK, 0);
    const hi = Math.min(forward ? from + scanned + CHUNK : from - scanned, end);
    if (lo >= hi) break;
    const chunk = await messageRows(read, lo, hi - 1);
    for (const row of forward ? chunk : chunk.reverse()) {
      if (full()) break;
      rows.push(row);
      edge = forward ? row[0] + 1 : row[0];
    }
    if (!full()) edge = forward ? hi : lo;
  }
  if (forward) return { rows, prev: from, next: edge };
  return { rows: rows.reverse(), prev: edge, next: from };
}
