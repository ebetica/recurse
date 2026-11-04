// Ripgrep and bounded transcript-header lookups stay off the server event loop.
// Live files finish before the archive pass; cancellation reaps either child.
import { closeSync, constants, openSync, readSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { projectionCurrent } from "./projection_state.worker";
import { INFO } from "../observability/runtime_logging";
import {
  BODY_BYTES,
  HEADER_BYTES,
  parseHeader,
  type TranscriptHeader,
} from "./transcript";
import type {
  Log,
  QueryResult,
  SearchFile,
  SearchHit,
  SearchOptions,
  SearchTarget,
} from "./index";

const networkFilesystems = new Set(
  Object.values({
    nfs: 0x6969,
    ninep: 0x01021997,
    fuse: 0x65735546,
    smb: 0x517b,
    cifs: 0xff534d42,
    smb2: 0xfe534d42,
    ceph: 0x00c36400,
    afs: 0x5346414f,
    afsFs: 0x6b414653,
    coda: 0x73757245,
  }),
);

async function threadArguments(path: string): Promise<string[]> {
  for (;;) {
    try {
      return networkFilesystems.has((await statfs(path)).type >>> 0)
        ? ["--threads=8"]
        : [];
    } catch (error) {
      const parent = dirname(path);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path)
        return [];
      path = parent;
    }
  }
}

export async function runRipgrep(
  files: SearchFile[],
  options: SearchOptions,
  signal: AbortSignal,
  log: Log,
): Promise<QueryResult> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 20));
  const result: QueryResult = {
    hits: [],
    truncated: false,
    missing: [],
    unindexed: [],
  };
  for (const file of files) {
    signal.throwIfAborted();
    if (file.checkCurrent && !projectionCurrent(file.target.path))
      result.unindexed!.push(file.path);
  }
  let outputRemaining = 8 * 1024 * 1024;
  let scanned = 0;
  let scannedKnown = true;
  for (const group of [
    files.filter(({ target }) => !target.archived),
    files.filter(({ target }) => target.archived),
  ]) {
    if (!group.length) continue;
    signal.throwIfAborted();
    const pass = await runPass(
      group,
      { ...options, limit: limit - result.hits.length },
      signal,
      log,
      outputRemaining,
    );
    result.hits.push(...pass.hits);
    result.missing!.push(...(pass.missing ?? []));
    outputRemaining -= pass.output_bytes;
    if (pass.bytes_scanned === undefined) scannedKnown = false;
    else scanned += pass.bytes_scanned;
    result.truncated = pass.truncated;
    if (pass.truncated || result.hits.length >= limit) break;
  }
  if (scannedKnown) result.bytes_scanned = scanned;
  return result;
}

async function runPass(
  files: SearchFile[],
  options: SearchOptions,
  signal: AbortSignal,
  log: Log,
  outputLimit: number,
): Promise<QueryResult & { output_bytes: number }> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 20));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const matcher = new RegExp(
    options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "iu",
  );
  const missing = new Set<string>();
  const descriptors = new Map<string, number>();
  const ranges = new Map<
    string,
    { header: TranscriptHeader; start: number; end: number }
  >();
  const remember = (
    path: string,
    header: TranscriptHeader,
    start: number,
    end: number,
  ) => {
    if (ranges.size >= 64 && !ranges.has(path))
      ranges.delete(ranges.keys().next().value!);
    ranges.set(path, { header, start, end });
    return header;
  };
  const headerFor = (path: string, offset: number, line: string) => {
    const cached = ranges.get(path);
    if (cached && offset >= cached.start && offset < cached.end)
      return cached.header;
    if (line.startsWith("--- #")) {
      const header = parseHeader(line);
      return header
        ? remember(
            path,
            header,
            offset,
            offset + Buffer.byteLength(line) + 1 + header.bytes,
          )
        : undefined;
    }
    let fd = descriptors.get(path);
    if (fd === undefined) {
      if (descriptors.size >= 64) {
        const [oldPath, oldFd] = descriptors.entries().next().value!;
        closeSync(oldFd);
        descriptors.delete(oldPath);
      }
      fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      descriptors.set(path, fd);
    }
    for (const length of [4096, BODY_BYTES + HEADER_BYTES]) {
      const start = Math.max(0, offset - length);
      const storage = new Uint8Array(offset - start);
      const buffer = Buffer.from(storage.buffer);
      let count = 0;
      while (count < buffer.length) {
        const read = readSync(
          fd,
          storage,
          count,
          buffer.length - count,
          start + count,
        );
        if (!read) break;
        count += read;
      }
      const bytes = buffer.subarray(0, count);
      const index = bytes.lastIndexOf("\n--- #");
      const at = index >= 0 ? index + 1 : start === 0 ? 0 : -1;
      if (at < 0) continue;
      const end = bytes.indexOf(10, at);
      if (end < 0) return;
      const header = parseHeader(bytes.subarray(at, end).toString("utf8"));
      const boundary = start + end + 1 + (header?.bytes ?? 0);
      return header && offset < boundary
        ? remember(path, header, start + at, boundary)
        : undefined;
    }
    return undefined;
  };
  let truncated = false;
  let bytesScanned: number | undefined;
  const byPath = new Map<string, SearchTarget[]>();
  for (const file of files)
    byPath.set(file.path, [...(byPath.get(file.path) ?? []), file.target]);
  const threads = await threadArguments(files[0]!.path);
  signal.throwIfAborted();
  const process = Bun.spawn(
    [
      "rg",
      "--no-config",
      "--no-ignore",
      "--fixed-strings",
      "--ignore-case",
      "--with-filename",
      "--null",
      "--line-number",
      "--byte-offset",
      "--line-buffered",
      "--stats",
      "--color=never",
      ...threads,
      "--",
      options.query,
      ...byPath.keys(),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  log("search_rg", { delta: 1 }, INFO);
  const errors = (async () => {
    const reader = process.stderr.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let bytes = 0;
    let failed = false;
    const inspect = (line: string) => {
      const message = line.startsWith("rg: ") ? line.slice(4) : line;
      if (message.endsWith("(os error 2)")) {
        for (
          let end = message.indexOf(": ");
          end >= 0;
          end = message.indexOf(": ", end + 2)
        ) {
          const path = message.slice(0, end);
          if (byPath.has(path)) {
            missing.add(path);
            return;
          }
        }
      }
      if (line) failed = true;
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024) {
          failed = true;
          continue;
        }
        pending += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          inspect(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
        if (pending.length > 8192) {
          failed = true;
          pending = "";
        }
      }
      if (pending) inspect(pending);
    } catch {
      failed = true;
    } finally {
      reader.releaseLock();
    }
    return failed;
  })();
  const stop = () => {
    process.kill();
  };
  signal.addEventListener("abort", stop, { once: true });
  let pending = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  const reader = process.stdout.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > outputLimit) {
        truncated = true;
        stop();
        break;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      let consumed = 0;
      while ((end = pending.indexOf("\n", consumed)) >= 0) {
        const output = pending.slice(consumed, end);
        consumed = end + 1;
        const split = output.indexOf("\u0000");
        if (split < 0) {
          const stats = /^(\d+) bytes searched$/.exec(output);
          if (stats) bytesScanned = Number(stats[1]);
          continue;
        }
        const path = output.slice(0, split);
        const targets = byPath.get(path);
        if (!targets) continue;
        const first = output.indexOf(":", split + 1);
        const second = output.indexOf(":", first + 1);
        const line = Number(output.slice(split + 1, first));
        const offset = Number(output.slice(first + 1, second));
        const text = output.slice(second + 1);
        let header: TranscriptHeader | undefined;
        try {
          header = headerFor(path, offset, text);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missing.add(path);
          continue;
        }
        if (
          !header ||
          header.role === "checkpoint" ||
          (options.role && options.role !== header.role)
        )
          continue;
        const at = text.search(matcher);
        for (const target of targets) {
          if (header.conversation !== (target.conversation ?? 1)) continue;
          const key = `${target.agent ?? target.cid}:${path}:${header.entry}:${header.role}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({
            agent: target.agent ?? target.cid,
            cid: target.cid,
            entry: header.entry,
            time: header.time,
            role: header.role,
            snippet: text.slice(Math.max(0, at - 120), Math.max(0, at) + 400),
            path,
            line,
          });
          if (hits.length >= limit) {
            truncated = true;
            stop();
            break;
          }
        }
        if (truncated) break;
      }
      pending = pending.slice(consumed);
      if (truncated) break;
    }
    await reader.cancel();
    const code = await process.exited;
    const failed = await errors;
    signal.throwIfAborted();
    if (
      failed ||
      (!truncated && code !== 0 && code !== 1 && !(code === 2 && missing.size))
    )
      throw new Error(
        "ripgrep search failed; check that rg is installed and agent files are readable",
      );
    return {
      hits,
      truncated,
      missing: [...missing],
      bytes_scanned: bytesScanned,
      output_bytes: bytes,
    };
  } finally {
    signal.removeEventListener("abort", stop);
    process.kill();
    await reader.cancel().catch(() => {});
    await process.exited;
    await errors;
    for (const fd of descriptors.values()) closeSync(fd);
    log("search_rg", { delta: -1 }, INFO);
  }
}
