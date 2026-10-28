// Bounded async byte-offset detail reads from append-only Pi JSONL.
// Callers own session path/lifecycle; exact-entry reads never rescan whole
// files.

import {
  AsyncJsonlRangeReader,
  type JsonObject,
} from "../view/session_entries";

export type { JsonObject };

const MAX_DETAIL_BYTES = 4 << 20;

function pythonInt(value: number): number {
  if (typeof value === "boolean") return Number(value);
  if (!Number.isFinite(value))
    throw new RangeError("expected a finite integer");
  return Math.trunc(value);
}

function validOffset(value: number): boolean {
  if (typeof value === "boolean") return true;
  return Number.isSafeInteger(value) && value >= 0;
}

function detailByteLimit(value: number): number {
  return Math.min(Math.max(pythonInt(value), 1), MAX_DETAIL_BYTES);
}

/** One parsed Pi entry at its exact byte offset; storage errors propagate. */
export async function entryAtOffsetStrict(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<JsonObject | null> {
  if (!validOffset(offset)) return null;
  return new AsyncJsonlRangeReader(path).entryAt(
    offset,
    detailByteLimit(maxBytes),
  );
}

// One parsed entry at an exact offset; missing or unreadable files are absent.
export async function entryAtOffset(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<JsonObject | null> {
  if (!validOffset(offset)) return null;
  const byteLimit = detailByteLimit(maxBytes);
  try {
    return await entryAtOffsetStrict(path, offset, byteLimit);
  } catch {
    return null;
  }
}
