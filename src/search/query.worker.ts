// Ripgrep and bounded header lookups stay off the server event loop.
// Per-agent caps diversify hits without sorting; live precedes archived files.
// Optional cursors track entry/role watermarks and projection identities.
// Unpaged requests avoid cursor metadata; cancellation reaps either child.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { projectionCurrent } from "./projection_state.worker";
import { INFO } from "../observability/runtime_logging";
import {
  BODY_BYTES,
  HEADER_BYTES,
  parseHeader,
  type TranscriptHeader,
  type TranscriptRole,
} from "./transcript";
import { SearchInputError } from "./index";
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

type Position = { entry: number; roles: number; identity: string };
const roleBits: Record<TranscriptRole, number> = {
  user: 1,
  assistant: 2,
  agent: 4,
  tool: 8,
  "tool-result": 16,
};

function fileIdentity(path: string, fd?: number): string {
  const info =
    fd === undefined
      ? statSync(path, { bigint: true })
      : fstatSync(fd, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

function cursorPositions(
  cursor: string,
  fingerprint: string,
  files: SearchFile[],
): Map<string, Position> {
  const positions = new Map<string, Position>();
  if (cursor === "start") return positions;
  const invalid = () =>
    new SearchInputError("Invalid search cursor; restart with --cursor start");
  let value: unknown;
  try {
    if (cursor.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw invalid();
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== fingerprint ||
    !Array.isArray(value[1]) ||
    value[1].length > 200
  )
    throw invalid();
  const byAgent = new Map(
    files.map((file) => [file.target.agent ?? file.target.cid, file.path]),
  );
  for (const row of value[1]) {
    if (
      !Array.isArray(row) ||
      row.length !== 4 ||
      typeof row[0] !== "string" ||
      row[0].length > 256 ||
      !Number.isSafeInteger(row[1]) ||
      row[1] < 1 ||
      !Number.isInteger(row[2]) ||
      row[2] < 1 ||
      row[2] > 31 ||
      typeof row[3] !== "string" ||
      row[3].length > 80 ||
      !/^\d+:\d+$/.test(row[3]) ||
      positions.has(row[0])
    )
      throw invalid();
    const path = byAgent.get(row[0]);
    if (!path) throw invalid();
    try {
      if (fileIdentity(path) !== row[3]) throw invalid();
    } catch {
      throw new SearchInputError(
        "A cursor transcript changed; restart with --cursor start",
      );
    }
    positions.set(row[0], { entry: row[1], roles: row[2], identity: row[3] });
  }
  return positions;
}

export async function runRipgrep(
  files: SearchFile[],
  options: SearchOptions,
  signal: AbortSignal,
  log: Log,
): Promise<QueryResult> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 20));
  const agents = new Set(files.map(({ target }) => target.agent ?? target.cid));
  const perAgentLimit =
    agents.size > 1 ? Math.min(5, Math.ceil(limit / 2)) : limit;
  const fingerprint = options.cursor
    ? Bun.hash(
        JSON.stringify([
          options.query,
          options.alternatives ?? [],
          options.role,
          options.conversationOnly ?? false,
          options.since,
          options.until,
          files.map(({ target }) => target.agent ?? target.cid),
        ]),
      ).toString(16)
    : "";
  const positions = options.cursor
    ? cursorPositions(options.cursor, fingerprint, files)
    : new Map<string, Position>();
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
      perAgentLimit,
      positions,
    );
    if (options.cursor)
      for (const hit of pass.hits) {
        const before = positions.get(hit.agent);
        positions.set(hit.agent, {
          entry: hit.entry,
          roles:
            roleBits[hit.role] |
            (before?.entry === hit.entry ? before.roles : 0),
          identity: pass.identities.get(hit.agent)!,
        });
      }
    result.hits.push(...pass.hits);
    result.missing!.push(...(pass.missing ?? []));
    outputRemaining -= pass.output_bytes;
    if (pass.bytes_scanned === undefined) scannedKnown = false;
    else scanned += pass.bytes_scanned;
    result.truncated ||= pass.truncated;
    if (pass.truncation) result.truncation = pass.truncation;
    if (
      pass.truncation === "hit_limit" ||
      pass.truncation === "byte_limit" ||
      result.hits.length >= limit
    )
      break;
  }
  if (scannedKnown) result.bytes_scanned = scanned;
  if (
    options.cursor &&
    result.truncated &&
    result.hits.length &&
    positions.size <= 200
  ) {
    const cursor = Buffer.from(
      JSON.stringify([
        fingerprint,
        [...positions].map(([agent, position]) => [
          agent,
          position.entry,
          position.roles,
          position.identity,
        ]),
      ]),
    ).toString("base64url");
    if (cursor.length <= 32768) result.next_cursor = cursor;
  }
  return result;
}

async function runPass(
  files: SearchFile[],
  options: SearchOptions,
  signal: AbortSignal,
  log: Log,
  outputLimit: number,
  perAgentLimit: number,
  positions: Map<string, Position>,
): Promise<
  QueryResult & { output_bytes: number; identities: Map<string, string> }
> {
  const limit = Math.min(200, Math.max(1, options.limit ?? 20));
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const terms = [options.query, ...(options.alternatives ?? [])];
  const matcher = new RegExp(
    terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "iu",
  );
  const counts = new Map<string, number>();
  const remainingAgents = new Set(
    files.map(({ target }) => target.agent ?? target.cid),
  );
  const identities = new Map<string, string>();
  let capped = false;
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
  let truncation: QueryResult["truncation"];
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
      ...terms.flatMap((term) => ["-e", term]),
      "--",
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
        truncation = "byte_limit";
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
          (options.role && options.role !== header.role) ||
          (options.conversationOnly &&
            (header.role === "tool" || header.role === "tool-result")) ||
          (options.since !== undefined && header.time < options.since) ||
          (options.until !== undefined && header.time >= options.until)
        )
          continue;
        const at = text.search(matcher);
        for (const target of targets) {
          if (
            header.conversation !== (target.conversation ?? 1) ||
            (!target.archived &&
              target.cid === options.exclude?.cid &&
              header.entry >= options.exclude.fromEntry)
          )
            continue;
          const agent = target.agent ?? target.cid;
          const position = positions.get(agent);
          if (
            position &&
            (header.entry < position.entry ||
              (header.entry === position.entry &&
                position.roles & roleBits[header.role]))
          )
            continue;
          const key = `${agent}:${path}:${header.entry}:${header.role}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if ((counts.get(agent) ?? 0) >= perAgentLimit) {
            capped = true;
            continue;
          }
          const count = (counts.get(agent) ?? 0) + 1;
          counts.set(agent, count);
          if (count >= perAgentLimit) remainingAgents.delete(agent);
          if (options.cursor && !identities.has(agent))
            identities.set(agent, fileIdentity(path, descriptors.get(path)));
          const start = Math.max(0, at - 120);
          const end = Math.max(0, at) + 400;
          hits.push({
            agent,
            cid: target.cid,
            entry: header.entry,
            time: header.time,
            role: header.role,
            snippet:
              (start > 0 ? "[… clipped] " : "") +
              text.slice(start, end) +
              (end < text.length ? " [… clipped]" : ""),
            path,
            line,
          });
          if (hits.length >= limit || !remainingAgents.size) {
            truncation = hits.length >= limit ? "hit_limit" : "agent_limit";
            stop();
            break;
          }
        }
        if (truncation) break;
      }
      pending = pending.slice(consumed);
      if (truncation) break;
    }
    await reader.cancel();
    const code = await process.exited;
    const failed = await errors;
    signal.throwIfAborted();
    if (
      failed ||
      (!truncation && code !== 0 && code !== 1 && !(code === 2 && missing.size))
    )
      throw new Error(
        "ripgrep search failed; check that rg is installed and agent files are readable",
      );
    return {
      hits,
      identities,
      truncated: truncation !== undefined || capped,
      ...(truncation
        ? { truncation }
        : capped
          ? { truncation: "agent_limit" as const }
          : {}),
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
