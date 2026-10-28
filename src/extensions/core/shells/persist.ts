// Best-effort session-scoped shell records support liveness and
// interrupted-command recovery. Corrupt records, /proc errors or failed writes
// must not crash Pi, block commands or escape handlers.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  HAS_PROCESS_TABLE,
  bootIdTextSync,
  procTextSync,
} from "../../../utils/process_table.ts";

export interface CompletionRecord {
  id: string;
  message: string;
  createdAt: number;
  sequence: number;
}

export interface CompletionPersistence {
  loadPending(): CompletionRecord[];
  acknowledge(completionIds: readonly string[]): boolean;
}

const RECURSE_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RecordStatus = "running" | "exited" | "killed" | "failed" | "lost";

export interface ShellRecord {
  /** Registry-local shell id (matches the in-memory Shell.id). */
  id: string;
  // Conversation owner; legacy records may contain opaque capabilities.
  ownerId?: string;
  // Process-group leader pid; absent if spawn never returned.
  pid: number | undefined;
  /** Process-group id (equals pid, since we spawn detached leaders). */
  pgid: number | undefined;
  /** The command string, verbatim. */
  command: string;
  /** foreground | background | monitor at the time of writing. */
  mode?: string;
  /** Epoch ms when the shell was spawned. */
  startedAt: number;
  /** Epoch ms when it terminated (exit/kill/lost), if known. */
  endedAt?: number;
  /** Absolute path of the merged stdout+stderr log. */
  logPath: string;
  /** Lifecycle status. */
  status: RecordStatus;
  /** Exit code when it exited normally; null when killed/unknown. */
  exitCode?: number | null;
  /** Killing signal name when known (e.g. "SIGKILL"). */
  signal?: string | null;
  // Spawn /proc start token; absent means destructive recovery fails closed.
  identity?: string;
  // Boot token: never signal old boots; absent legacy tokens use start time.
  bootId?: string;
  // Terminal notice removed only after its batch is acknowledged.
  completion?: CompletionRecord;
  /** Recurse delivery that already owns this terminal result. */
  recurseNotice?: { version: 1; deliveryId: string };
  /** Epoch ms of the last write to this record. */
  updatedAt: number;
}

/** Make a string safe to use as a single path segment. */
function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "_";
}

export interface StoreOptions {
  /** Cap on retained terminated records before the oldest are dropped. */
  keepTerminated?: number;
  /** Age past which a terminated record is dropped (ms). */
  terminatedTtlMs?: number;
}

// Session-scoped atomic shell JSON store. Concurrent readers never see torn
// writes; methods are total and never throw.
export class RegistryStore {
  /** The session-scoped directory holding this session's shell records. */
  readonly dir: string;
  /** False when no session id was available (records share a fallback dir). */
  readonly sessionScoped: boolean;
  private readonly keepTerminated: number;
  private readonly terminatedTtlMs: number;

  constructor(
    baseDir: string,
    sessionId: string | undefined,
    opts: StoreOptions = {},
  ) {
    this.sessionScoped = Boolean(sessionId);
    const seg = sessionId ? sanitizeSegment(sessionId) : "_no-session";
    this.dir = join(baseDir, seg);
    this.keepTerminated = opts.keepTerminated ?? 500;
    this.terminatedTtlMs = opts.terminatedTtlMs ?? 6 * 60 * 60 * 1000;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {}
  }

  private fileFor(id: string): string {
    return join(this.dir, `${sanitizeSegment(id)}.json`);
  }

  /** Atomically write a record (temp file + rename). Never throws. */
  write(rec: ShellRecord): boolean {
    const path = this.fileFor(rec.id);
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ ...rec, updatedAt: Date.now() }));
      // Invariant: Rename is atomic on the same filesystem.
      renameSync(tmp, path);
      return true;
    } catch {
      try {
        unlinkSync(tmp);
      } catch {}
      return false;
    }
  }

  /** Pending terminal notifications, in their original arrival order. */
  loadPendingCompletions(): CompletionRecord[] {
    return this.readAll()
      .flatMap((record) => (record.completion ? [record.completion] : []))
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          a.sequence - b.sequence ||
          a.id.localeCompare(b.id),
      );
  }

  // Acknowledge only notices durable in Pi. Remove terminated records
  // immediately; running records retain their file with the payload cleared.
  // Unacknowledged completions remain untouched.
  acknowledgeCompletions(completionIds: readonly string[]): boolean {
    const ids = new Set(completionIds);
    let ok = true;
    for (const record of this.readAll()) {
      if (!record.completion || !ids.has(record.completion.id)) continue;
      const terminated = record.status !== "running";
      if (terminated) {
        this.remove(record.id);
        if (this.readRecord(record.id) !== undefined) ok = false;
        continue;
      }
      delete record.completion;
      const before = this.readRecord(record.id)?.completion;
      this.write(record);
      if (before && this.readRecord(record.id)?.completion) ok = false;
    }
    return (
      ok &&
      !this.loadPendingCompletions().some((completion) =>
        ids.has(completion.id),
      )
    );
  }

  readRecord(id: string): ShellRecord | undefined {
    try {
      const record = JSON.parse(
        readFileSync(this.fileFor(id), "utf8"),
      ) as ShellRecord;
      return record && typeof record.id === "string" ? record : undefined;
    } catch {
      return undefined;
    }
  }

  /** Delete a shell's record file. Never throws. */
  remove(id: string): void {
    try {
      unlinkSync(this.fileFor(id));
    } catch {}
  }

  /** Read and parse every valid record, skipping corrupt/torn/partial files. */
  readAll(): ShellRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: ShellRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          readFileSync(join(this.dir, name), "utf8"),
        ) as ShellRecord;
        if (rec && typeof rec.id === "string" && typeof rec.status === "string")
          out.push(rec);
      } catch {}
    }
    return out;
  }

  // Prune old terminated records and stale temp files. Keep running shells;
  // acknowledged records are removed immediately by acknowledgeCompletions.
  prune(now = Date.now()): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith(".tmp")) {
        try {
          unlinkSync(join(this.dir, name));
        } catch {}
      }
    }
    // Invariant: Never age/cap unacknowledged notices before their delivery is
    // durable.
    const terminated = this.readAll().filter((r) => r.status !== "running");
    const survivors: ShellRecord[] = [];
    for (const r of terminated) {
      const ended = r.endedAt ?? r.updatedAt ?? 0;
      const pendingRecurseLoss =
        r.ownerId && r.status === "lost" && !r.recurseNotice;
      if (
        r.completion ||
        (pendingRecurseLoss && now - ended <= RECURSE_RECOVERY_TTL_MS)
      )
        continue;
      if (now - ended > this.terminatedTtlMs) this.remove(r.id);
      else survivors.push(r);
    }
    if (survivors.length > this.keepTerminated) {
      survivors.sort(
        (a, b) =>
          (b.endedAt ?? b.updatedAt ?? 0) - (a.endedAt ?? a.updatedAt ?? 0),
      );
      for (const r of survivors.slice(this.keepTerminated)) this.remove(r.id);
    }
  }
}

let cachedBootId: string | undefined | null = null;

// Cached kernel boot id; absent without a process table or on read failure.
// Records with a boot generation must then fail closed.
export function getBootId(): string | undefined {
  if (cachedBootId !== null) return cachedBootId;
  let boot: string | undefined;
  try {
    const raw = bootIdTextSync().trim();
    if (/^[0-9a-f-]{8,64}$/i.test(raw)) boot = raw.toLowerCase();
  } catch {
    boot = undefined;
  }
  cachedBootId = boot;
  return boot;
}

// Read stat field 22 (Linux start jiffies, macOS unique process id) for
// PID-reuse protection. Absent without a process table or on read failure;
// detached ownership handoff fails closed.
export function procStartTime(pid: number): string | undefined {
  if (!HAS_PROCESS_TABLE) return undefined;
  try {
    const stat = procTextSync(pid, "stat");
    // Spec: comm can contain spaces/parens; split at the LAST ')'. Field 22 is
    // index 19 after it.
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return undefined;
    const after = stat
      .slice(rparen + 1)
      .trim()
      .split(/\s+/);
    const starttime = after[19];
    return starttime && /^\d+$/.test(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}
