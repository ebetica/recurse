// Bounded asynchronous log reads, never whole command logs in memory. I/O
// failures return empty/degraded results rather than throw.

import { open, stat, type FileHandle } from "node:fs/promises";
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
export async function readTail(
  path: string,
  maxBytes: number,
): Promise<string> {
  const size = await fileSize(path);
  const want = Math.min(maxBytes, size);
  return readRange(path, size - want, want);
}

/** Read up to `maxBytes` from the start of a file as UTF-8 text. */
export async function readHead(
  path: string,
  maxBytes: number,
): Promise<string> {
  return readRange(path, 0, Math.min(maxBytes, await fileSize(path)));
}

// Read len bytes at start; return empty text on I/O failure.
export async function readRange(
  path: string,
  start: number,
  len: number,
): Promise<string> {
  if (len <= 0) return "";
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await file.read(
      buf as unknown as Uint8Array,
      0,
      len,
      start,
    );
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

/** The last non-empty line of a file, read from a bounded tail window. */
export async function readLastLine(
  path: string,
  windowBytes = 8192,
): Promise<string> {
  const tail = await readTail(path, windowBytes);
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/\r$/, "");
    if (l.trim().length > 0) return l;
  }
  return "";
}

/** Current byte size of a file, or 0 if it can't be stat'd. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

// Trim logs using bounded reads. Small logs get exact omitted-line counts;
// large logs use head/tail windows and a byte-based omission marker.
export async function trimFile(
  path: string,
  options: TrimOptions = {},
): Promise<TrimResult> {
  const READ_CAP = 256 * 1024;
  const size = await fileSize(path);
  if (size <= READ_CAP) {
    return trimOutput(await readHead(path, READ_CAP), options);
  }

  const byteBudget = options.byteBudget ?? DEFAULT_BYTE_BUDGET;
  const maxLines = clampLineLimit(options.maxLines, DEFAULT_MAX_LINES);
  const headTarget = Math.ceil(maxLines / 2);
  const tailTarget = maxLines - headTarget;
  const half = Math.floor(byteBudget / 2);
  // Invariant: Byte cuts leave partial edge lines; retain only whole lines.
  const headWindow = await readHead(path, half);
  const headLines = headWindow.split("\n");
  headLines.pop();
  const head = headLines.slice(0, headTarget);
  const tailWindow = await readTail(path, byteBudget - half);
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
