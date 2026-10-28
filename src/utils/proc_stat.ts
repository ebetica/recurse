// /proc identity primitives for owned process groups; macOS answers through
// ./process_table. A missing or unreadable identity is never permission to
// signal a PID or numeric PGID.
// Stat parsing uses the *last* ')' because comm may contain spaces or ')'.
import {
  BOOT_ID_PATH,
  PROC,
  bootIdText,
  procEntries,
  procEntry,
  procIds,
  procText,
} from "./process_table";

export interface ProcStat {
  pid: number;
  state: string;
  pgrp: number;
  session: number;
  startTime: string;
}
export type ProcResult =
  | { state: "ok"; stat: ProcStat }
  | { state: "dead" | "permission" | "unavailable"; stat: null };
export interface ProcessIdentity {
  start_time: string | null;
  pgid: number | null;
  sid: number | null;
  boot_id: string | null;
}

/** The shell backstop reads state even from a short stat line and starttime
 * even for a zombie, unlike the cleanup identity reader. */
export function procFields(raw: string): {
  state: string | null;
  startTime: string | null;
} {
  const end = raw.lastIndexOf(")");
  const fields =
    end < 0
      ? []
      : raw
          .slice(end + 1)
          .trim()
          .split(/\s+/u);
  return { state: fields[0] || null, startTime: fields[19] ?? null };
}

/** Parse fields 3, 5, 6 and 22 without converting the start token to Number. */
export function parseProcStat(pid: number, raw: string): ProcResult {
  const end = raw.lastIndexOf(")");
  if (end < 0) return { state: "unavailable", stat: null };
  const fields = raw
    .slice(end + 1)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) return { state: "unavailable", stat: null };
  if (fields[0] === "Z") return { state: "dead", stat: null };
  const pgrp = Number(fields[2]);
  const session = Number(fields[3]);
  if (!Number.isSafeInteger(pgrp) || !Number.isSafeInteger(session))
    return { state: "unavailable", stat: null };
  return {
    state: "ok",
    stat: { pid, state: fields[0]!, pgrp, session, startTime: fields[19]! },
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

export async function procStat(pid: number, root = PROC): Promise<ProcResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { state: "unavailable", stat: null };
  try {
    const raw = await procText(pid, "stat", root);
    return parseProcStat(pid, raw);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      try {
        await procEntry(root);
      } catch {
        return { state: "unavailable", stat: null };
      }
      return { state: "dead", stat: null };
    }
    if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM")
      return { state: "permission", stat: null };
    try {
      await procEntry(root, pid);
      return { state: "unavailable", stat: null };
    } catch (checkError) {
      return {
        state: errorCode(checkError) === "ENOENT" ? "dead" : "unavailable",
        stat: null,
      };
    }
  }
}

export async function bootId(path = BOOT_ID_PATH): Promise<string | null> {
  try {
    return (await bootIdText(path)).trim() || null;
  } catch {
    return null;
  }
}

export async function identityFor(
  pid: number,
  root = PROC,
  bootPath?: string,
): Promise<ProcessIdentity> {
  const [result, boot] = await Promise.all([
    procStat(pid, root),
    bootId(bootPath),
  ]);
  const own = result.state === "ok" ? result.stat : null;
  return {
    start_time: own?.startTime ?? null,
    pgid: own?.pgrp ?? null,
    sid: own?.session ?? null,
    boot_id: boot,
  };
}

/** Whether `pid` started with `marker` (`NAME=value`) in its environment.
 * An unreadable environment reads as unmarked, so the member still counts. */
async function startedWithEnv(
  pid: number,
  root: string,
  marker: string,
): Promise<boolean> {
  try {
    const raw = await procText(pid, "environ", root);
    return raw.split("\0").includes(marker);
  } catch {
    return false;
  }
}

// Fail closed on uncertain enumeration, unreadable entries, or a reused leader.
// `ignoreMarked` (`NAME=value`) skips members that started with that variable
// in their environment.
export async function sessionMemberState(
  identity: ProcessIdentity,
  root = PROC,
  bootPath?: string,
  excludeLeader = false,
  ignoreMarked?: string,
): Promise<"present" | "absent" | "unknown"> {
  const currentBoot = await bootId(bootPath);
  if (!identity.boot_id || !currentBoot) return "unknown";
  if (identity.boot_id !== currentBoot) return "absent";
  const pgid = identity.pgid;
  if (!pgid || pgid <= 1 || identity.sid !== pgid) return "unknown";
  const leader = await procStat(pgid, root);
  if (leader.state === "ok" && leader.stat.startTime !== identity.start_time)
    return "absent";
  if (leader.state === "permission" || leader.state === "unavailable")
    return "unknown";
  let names: string[];
  try {
    names = await procIds(root);
  } catch {
    return "unknown";
  }
  let uncertain = false;
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    const result = await procStat(pid, root);
    if (result.state === "permission" || result.state === "unavailable") {
      uncertain = true;
      continue;
    }
    if (
      result.state !== "ok" ||
      result.stat.pgrp !== pgid ||
      result.stat.session !== pgid
    )
      continue;
    if (pid === pgid && excludeLeader) continue;
    if (ignoreMarked && (await startedWithEnv(pid, root, ignoreMarked)))
      continue;
    return "present";
  }
  return uncertain ? "unknown" : "absent";
}

// Bounded shell-registry group snapshot: unlike cleanup, unrelated unreadable
// entries do not taint a requested group. Values: count, leaderStart,
// uncertain.
export async function groupSnapshot(
  wanted: ReadonlySet<number>,
  root = PROC,
  maxEntries = 100_000,
): Promise<
  Map<number, { count: number; leaderStart: string | null; uncertain: boolean }>
> {
  const groups = new Map<
    number,
    { count: number; leaderStart: string | null; uncertain: boolean }
  >();
  if (!wanted.size) return groups;
  const mark = (id: number) => {
    const row = groups.get(id) ?? {
      count: 0,
      leaderStart: null,
      uncertain: false,
    };
    row.uncertain = true;
    groups.set(id, row);
  };
  let names: AsyncIterable<string>;
  try {
    names = await procEntries(root);
  } catch {
    for (const id of wanted) mark(id);
    return groups;
  }
  // Invariant: Async iteration closes the directory automatically, including on
  // break.
  let index = 0;
  for await (const name of names) {
    if (index++ >= maxEntries) {
      for (const id of wanted) mark(id);
      break;
    }
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    const result = await procStat(pid, root);
    if (result.state === "unavailable" || result.state === "permission") {
      if (wanted.has(pid)) mark(pid);
      continue;
    }
    if (result.state !== "ok") continue;
    const row = result.stat;
    if (!wanted.has(row.pgrp) || row.session !== row.pgrp) continue;
    const current = groups.get(row.pgrp) ?? {
      count: 0,
      leaderStart: null,
      uncertain: false,
    };
    current.count++;
    if (pid === row.pgrp) current.leaderStart = row.startTime;
    groups.set(row.pgrp, current);
  }
  return groups;
}
