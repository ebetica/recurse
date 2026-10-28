// Advisory process context, never permission to signal. Bound /proc
// scans/output and revalidate owned detached groups by PGID/session. Missing
// leaders retain descendants with uncertainty; mismatched leader start tokens
// exclude reused groups.
import { closeSync, openSync, readSync } from "node:fs";
import {
  HAS_PROCESS_TABLE,
  PROCESS_TABLE_EMULATED,
  type ProcFile,
  procIdsSync,
  procTextSync,
} from "../../../utils/process_table.ts";

const MAX_RECORDS = 100;
const MAX_RECORD_BYTES = 8 * 1024;
const MAX_PROCESSES = 512;
const MAX_BYTES = 32 * 1024;
const MAX_PROC_ENTRIES = 100_000;

export interface ProcessRoot {
  pid: number;
  pgid: number;
  identity: string;
}
type LeaderStatus = "verified" | "missing" | "reused";
interface Member {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  state: string;
  command: string;
  start: string;
}
interface RootScan {
  roots: ProcessRoot[];
  truncated: boolean;
}

function boundedText(path: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytes = readSync(
      fd,
      buffer as unknown as Uint8Array,
      0,
      buffer.length,
      0,
    );
    if (bytes > maxBytes) return undefined;
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function procFile(
  pid: number,
  file: ProcFile,
  maxBytes: number,
): string | undefined {
  if (!PROCESS_TABLE_EMULATED)
    return boundedText(`/proc/${pid}/${file}`, maxBytes);
  try {
    const text = procTextSync(pid, file);
    return Buffer.byteLength(text) > maxBytes ? undefined : text;
  } catch {
    return undefined;
  }
}

function statProcess(pid: number, includeCommand = false): Member | undefined {
  const raw = procFile(pid, "stat", 4096);
  if (!raw) return undefined;
  const end = raw.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = raw
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  if (fields.length < 20) return undefined;
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const sid = Number(fields[3]);
  if (![ppid, pgid, sid].every(Number.isSafeInteger)) return undefined;
  const command = includeCommand
    ? procFile(pid, "comm", 80)?.trim() || "unknown"
    : "";
  return {
    pid,
    state: fields[0]!,
    ppid,
    pgid,
    sid,
    start: fields[19]!,
    command,
  };
}

function roots(records: readonly ProcessRoot[]): RootScan | undefined {
  if (records.length > MAX_RECORDS) return undefined;
  const out: ProcessRoot[] = [];
  let bytes = 0;
  let truncated = false;
  for (const { pid, pgid, identity } of records) {
    const size = Buffer.byteLength(JSON.stringify({ pid, pgid, identity }));
    if (size > MAX_RECORD_BYTES || bytes + size > MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += size;
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 1 ||
      !Number.isSafeInteger(pgid) ||
      pgid <= 1 ||
      pid !== pgid ||
      typeof identity !== "string" ||
      !identity
    )
      continue;
    out.push({ pid, pgid, identity });
  }
  return { roots: out, truncated };
}

function appendBounded(
  lines: string[],
  line: string,
  state: { bytes: number },
): boolean {
  const bytes = Buffer.byteLength(line);
  const extra = lines.length > 0 ? 1 : 0;
  if (state.bytes + extra + bytes > MAX_BYTES) return false;
  lines.push(line);
  state.bytes += extra + bytes;
  return true;
}

/** Bounded, owner/session-scoped ps-like context for the safety reviewer. */
export function ownedProcessSnapshot(
  records: readonly ProcessRoot[] | undefined,
): string {
  if (!HAS_PROCESS_TABLE)
    return "Process snapshot: unavailable (this host has no supported process table).";
  const rootsFound = records && roots(records);
  if (!rootsFound)
    return "Process snapshot: unavailable (shell registry could not be read safely).";
  const rootNotes = rootsFound.truncated
    ? ["registry records truncated at 100 records or 32768 bytes"]
    : [];
  if (!rootsFound.roots.length) {
    return [
      "Process snapshot: no running owned background shells.",
      ...rootNotes,
    ].join(" ");
  }

  const byGroup = new Map<number, ProcessRoot>();
  const conflicting = new Set<number>();
  for (const root of rootsFound.roots) {
    const previous = byGroup.get(root.pgid);
    if (
      previous &&
      (previous.pid !== root.pid || previous.identity !== root.identity)
    ) {
      conflicting.add(root.pgid);
      continue;
    }
    byGroup.set(root.pgid, root);
  }
  for (const pgid of conflicting) byGroup.delete(pgid);

  // Invariant: Check the leader separately; warn if absent, exclude the group
  // if its start token changed (PGID reuse).
  const leaderStatus = new Map<number, LeaderStatus>();
  for (const root of byGroup.values()) {
    const leader = statProcess(root.pid);
    if (!leader) {
      leaderStatus.set(root.pgid, "missing");
    } else if (
      leader.pid !== root.pid ||
      leader.pgid !== root.pgid ||
      leader.sid !== root.pgid ||
      leader.start !== root.identity
    ) {
      leaderStatus.set(root.pgid, "reused");
    } else if (leader.state === "Z" || leader.state === "X") {
      leaderStatus.set(root.pgid, "missing");
    } else {
      leaderStatus.set(root.pgid, "verified");
    }
  }

  if (
    leaderStatus.size > 0 &&
    [...leaderStatus.values()].every((status) => status === "reused")
  ) {
    const lines = [
      "Owned background process snapshot (session-scoped; command names only):",
    ];
    const output = { bytes: Buffer.byteLength(lines[0]!) };
    for (const [pgid] of leaderStatus) {
      appendBounded(lines, `group=${pgid} PGID reused; not owned`, output);
    }
    for (const note of rootNotes) {
      appendBounded(lines, `… ${note}`, output);
    }
    return lines.join("\n");
  }

  let names: string[];
  try {
    const allNames = procIdsSync();
    if (allNames.length > MAX_PROC_ENTRIES) {
      return "Process snapshot: unavailable (process table exceeded the safe scan bound).";
    }
    names = allNames
      .filter((name) => /^\d+$/.test(name))
      .sort((a, b) => Number(a) - Number(b));
  } catch {
    return "Process snapshot: unavailable (process table could not be read safely).";
  }
  const members: Member[] = [];
  let memberTruncated = false;
  for (const name of names) {
    const member = statProcess(Number(name));
    if (
      !member ||
      member.state === "Z" ||
      member.state === "X" ||
      member.pgid <= 1 ||
      member.sid !== member.pgid
    )
      continue;
    const root = byGroup.get(member.pgid);
    if (
      !root ||
      member.pgid !== root.pgid ||
      leaderStatus.get(member.pgid) === "reused"
    )
      continue;
    if (member.pid === root.pid && member.start !== root.identity) continue;
    if (members.length >= MAX_PROCESSES) {
      memberTruncated = true;
      break;
    }
    member.command = procFile(member.pid, "comm", 80)?.trim() || "unknown";
    members.push(member);
  }
  members.sort((a, b) => a.pid - b.pid);
  const lines = [
    "Owned background process snapshot (session-scoped; command names only):",
  ];
  const output = { bytes: Buffer.byteLength(lines[0]!) };
  for (const [pgid, status] of leaderStatus) {
    if (status === "missing") {
      appendBounded(
        lines,
        `group=${pgid} leader exited; PGID reuse cannot be excluded`,
        output,
      );
    } else if (status === "reused") {
      appendBounded(lines, `group=${pgid} PGID reused; not owned`, output);
    }
  }
  let outputTruncated = false;
  for (const member of members) {
    const line = `pid=${member.pid} ppid=${member.ppid} pgid=${member.pgid} sid=${member.sid} state=${member.state} command=${member.command}`;
    if (!appendBounded(lines, line, output)) {
      outputTruncated = true;
      break;
    }
  }
  const notes = [...rootNotes];
  if (memberTruncated) notes.push("process members truncated at 512 rows");
  if (outputTruncated) notes.push("snapshot truncated at 32768 bytes");
  for (const note of notes) {
    const marker = `… ${note}`;
    while (!appendBounded(lines, marker, output) && lines.length > 1) {
      const removed = lines.pop()!;
      output.bytes -= Buffer.byteLength(removed) + 1;
    }
  }
  return lines.join("\n");
}
