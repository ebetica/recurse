// Bounded head/tail log reads, never whole command logs in memory. I/O failures
// return empty/degraded results rather than throw.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
  byteTruncationMarker,
  clampLineLimit,
  DEFAULT_BYTE_BUDGET,
  DEFAULT_MAX_LINES,
  trimOutput,
  type TrimOptions,
  type TrimResult,
} from "./trim.ts";

/** Read up to `maxBytes` from the end of a file as UTF-8 text. */
export function readTail(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const want = Math.min(maxBytes, size);
    const start = size - want;
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(want);
    const read = readSync(fd, buf as unknown as Uint8Array, 0, want, start);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** Read up to `maxBytes` from the start of a file as UTF-8 text. */
export function readHead(path: string, maxBytes: number): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size === 0) return "";
    const want = Math.min(maxBytes, size);
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(want);
    const read = readSync(fd, buf as unknown as Uint8Array, 0, want, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

// Read len bytes at start; return empty text on I/O failure.
export function readRange(path: string, start: number, len: number): string {
  if (len <= 0) return "";
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf as unknown as Uint8Array, 0, len, start);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

/** The last non-empty line of a file, read from a bounded tail window. */
export function readLastLine(path: string, windowBytes = 8192): string {
  const tail = readTail(path, windowBytes);
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/\r$/, "");
    if (l.trim().length > 0) return l;
  }
  return "";
}

/** Current byte size of a file, or 0 if it can't be stat'd. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Trim logs using bounded reads. Small logs get exact omitted-line counts;
// large logs use head/tail windows and a byte-based omission marker.
export function trimFile(path: string, options: TrimOptions = {}): TrimResult {
  const READ_CAP = 256 * 1024;
  const size = fileSize(path);
  if (size <= READ_CAP) {
    return trimOutput(readHead(path, READ_CAP), options);
  }

  const byteBudget = options.byteBudget ?? DEFAULT_BYTE_BUDGET;
  const maxLines = clampLineLimit(options.maxLines, DEFAULT_MAX_LINES);
  const headTarget = Math.ceil(maxLines / 2);
  const tailTarget = maxLines - headTarget;
  const half = Math.floor(byteBudget / 2);
  // Invariant: Byte cuts leave partial edge lines; retain only whole lines.
  const headWindow = readHead(path, half);
  const headLines = headWindow.split("\n");
  headLines.pop();
  const head = headLines.slice(0, headTarget);
  const tailWindow = readTail(path, byteBudget - half);
  const tailLines = tailWindow.split("\n");
  tailLines.shift();
  const tail = tailLines.slice(Math.max(0, tailLines.length - tailTarget));
  const keptBytes =
    Buffer.byteLength(head.join("\n"), "utf8") +
    Buffer.byteLength(tail.join("\n"), "utf8") +
    2;
  const omittedBytes = Math.max(0, size - keptBytes);
  const marker = byteTruncationMarker(
    omittedBytes,
    options.logPath,
    head.length,
    maxLines,
  );
  return {
    text: `${head.join("\n")}\n${marker}\n${tail.join("\n")}`,
    trimmed: true,
    omittedLines: 0,
  };
}
