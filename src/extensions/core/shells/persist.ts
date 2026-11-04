// Best-effort session-scoped shell records support liveness and
// interrupted-command recovery. Record initialization, reads and mutations are
// asynchronous. Corrupt records, /proc errors or failed writes must not crash
// Pi, block commands or escape handlers.

import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  HAS_PROCESS_TABLE,
  bootIdText,
  procTextSync,
} from "../../../utils/process_table.ts";

export interface CompletionRecord {
  id: string;
  message: string;
  createdAt: number;
  sequence: number;
}

export interface CompletionPersistence {
  loadPending(): Promise<CompletionRecord[]>;
  acknowledge(completionIds: readonly string[]): Promise<boolean>;
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

type Mutation = ({ kind: "write"; text: string } | { kind: "remove" }) & {
  result: Promise<boolean>;
  resolve(ok: boolean): void;
};

type MutationQueue = { pending: Mutation[]; done: Promise<void> };
const activeTemps = new Set<string>();
const mutations = new Map<string, MutationQueue>();

// Session-scoped atomic shell JSON store. Per-record mutations stay ordered;
// concurrent writes coalesce behind the active write. Readers never see tears.
export class RegistryStore {
  /** The session-scoped directory holding this session's shell records. */
  readonly dir: string;
  /** False when no session id was available (records share a fallback dir). */
  readonly sessionScoped: boolean;
  private readonly keepTerminated: number;
  private readonly terminatedTtlMs: number;
  private readonly initialized: Promise<void>;

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
    this.initialized = mkdir(this.dir, { recursive: true }).then(
      () => undefined,
      () => undefined,
    );
  }

  private fileFor(id: string): string {
    return join(this.dir, `${sanitizeSegment(id)}.json`);
  }

  /** Commit an atomic snapshot; newer queued snapshots share one write. */
  write(rec: ShellRecord): Promise<boolean> {
    try {
      return this.enqueue(this.fileFor(rec.id), {
        kind: "write",
        text: JSON.stringify({ ...rec, updatedAt: Date.now() }),
      });
    } catch {
      return Promise.resolve(false);
    }
  }

  private enqueue(
    path: string,
    operation: { kind: "write"; text: string } | { kind: "remove" },
  ): Promise<boolean> {
    const queue = mutations.get(path);
    const last = queue?.pending.at(-1);
    if (operation.kind === "write" && last?.kind === "write") {
      last.text = operation.text;
      return last.result;
    }
    let resolve!: (ok: boolean) => void;
    const result = new Promise<boolean>((done) => {
      resolve = done;
    });
    const mutation: Mutation = { ...operation, result, resolve };
    if (queue) queue.pending.push(mutation);
    else {
      const next: MutationQueue = {
        pending: [mutation],
        done: Promise.resolve(),
      };
      mutations.set(path, next);
      next.done = this.drain(path, next);
    }
    return result;
  }

  private async drain(path: string, queue: MutationQueue): Promise<void> {
    await this.initialized;
    while (queue.pending.length) {
      const mutation = queue.pending.shift()!;
      let ok = false;
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        if (mutation.kind === "write") {
          activeTemps.add(tmp);
          await writeFile(tmp, mutation.text);
          // Invariant: Rename is atomic on the same filesystem.
          await rename(tmp, path);
        } else await unlink(path);
        ok = true;
      } catch {
        if (mutation.kind === "write") await unlink(tmp).catch(() => {});
      } finally {
        activeTemps.delete(tmp);
      }
      mutation.resolve(ok);
    }
    mutations.delete(path);
  }

  /** Drain pending commits before recovery, pruning or ownership transfer. */
  async flush(id?: string): Promise<void> {
    await this.initialized;
    const path = id === undefined ? undefined : this.fileFor(id);
    for (;;) {
      const queues = path
        ? [mutations.get(path)].filter(
            (queue): queue is MutationQueue => !!queue,
          )
        : [...mutations]
            .filter(([file]) => dirname(file) === this.dir)
            .map(([, queue]) => queue);
      if (!queues.length) return;
      await Promise.all(queues.map((queue) => queue.done));
    }
  }

  /** Pending terminal notifications, in their original arrival order. */
  async loadPendingCompletions(): Promise<CompletionRecord[]> {
    return (await this.readAll())
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
  async acknowledgeCompletions(
    completionIds: readonly string[],
  ): Promise<boolean> {
    await this.flush();
    const ids = new Set(completionIds);
    let ok = true;
    for (const record of await this.readAll()) {
      if (!record.completion || !ids.has(record.completion.id)) continue;
      const terminated = record.status !== "running";
      if (terminated) {
        await this.remove(record.id);
        if ((await this.readRecord(record.id)) !== undefined) ok = false;
        continue;
      }
      delete record.completion;
      const before = (await this.readRecord(record.id))?.completion;
      await this.write(record);
      if (before && (await this.readRecord(record.id))?.completion) ok = false;
    }
    return (
      ok &&
      !(await this.loadPendingCompletions()).some((completion) =>
        ids.has(completion.id),
      )
    );
  }

  async readRecord(id: string): Promise<ShellRecord | undefined> {
    await this.initialized;
    try {
      const record = JSON.parse(
        await readFile(this.fileFor(id), "utf8"),
      ) as ShellRecord;
      return record && typeof record.id === "string" ? record : undefined;
    } catch {
      return undefined;
    }
  }

  /** Delete a shell's record file. Never throws. */
  async remove(id: string): Promise<void> {
    try {
      await this.enqueue(this.fileFor(id), { kind: "remove" });
    } catch {}
  }

  /** Read and parse every valid record, skipping corrupt/torn/partial files. */
  async readAll(): Promise<ShellRecord[]> {
    await this.initialized;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: ShellRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          await readFile(join(this.dir, name), "utf8"),
        ) as ShellRecord;
        if (rec && typeof rec.id === "string" && typeof rec.status === "string")
          out.push(rec);
      } catch {}
    }
    return out;
  }

  // Prune old terminated records and stale temp files. Keep running shells;
  // acknowledged records are removed immediately by acknowledgeCompletions.
  async prune(now = Date.now()): Promise<void> {
    await this.flush();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith(".tmp") && !activeTemps.has(join(this.dir, name))) {
        try {
          await unlink(join(this.dir, name));
        } catch {}
      }
    }
    // Invariant: Never age/cap unacknowledged notices before their delivery is
    // durable.
    const terminated = (await this.readAll()).filter(
      (r) => r.status !== "running",
    );
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
      if (now - ended > this.terminatedTtlMs) await this.remove(r.id);
      else survivors.push(r);
    }
    if (survivors.length > this.keepTerminated) {
      survivors.sort(
        (a, b) =>
          (b.endedAt ?? b.updatedAt ?? 0) - (a.endedAt ?? a.updatedAt ?? 0),
      );
      for (const r of survivors.slice(this.keepTerminated))
        await this.remove(r.id);
    }
  }
}

let cachedBootId: string | undefined;
let bootIdReady: Promise<void> | undefined;

/** Prepare the immutable boot token once, before any child is spawned. */
export function prepareBootId(): Promise<void> {
  return (bootIdReady ??= bootIdText().then(
    (text) => {
      const raw = text.trim();
      if (/^[0-9a-f-]{8,64}$/i.test(raw)) cachedBootId = raw.toLowerCase();
    },
    () => {},
  ));
}

/** Cached boot token; unavailable tokens refuse boot-tagged signals. */
export function getBootId(): string | undefined {
  return cachedBootId;
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
