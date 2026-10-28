// Prove detached group identity before signals; uncertainty stays pending.
// TERM/verify/KILL/verify covers same-group children, not setsid escapees.
// Concurrent cleanup still requires proof of absence before stop succeeds.
// Foreground ownership is in-memory only; restart forgets prior generations.
import { constants } from "node:os";
import { readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { ShellRecord, ShellRegistry } from "./pi_bg_shell";
import { bootId, procStat, sessionMemberState } from "./utils/proc_stat";
import { PROC } from "./utils/process_table";

import type { ProcStat } from "./utils/proc_stat";
import { AsyncMutex, TaskSet } from "./utils/tasks";

export const STOP_GRACE_MS = 2000;
export const MAX_REPORTED_PROCESSES = 12;
export const UNVERIFIED_IDENTITY = "unverified";

export class ProcessRegistryUnreadable extends Error {
  override name = "ProcessRegistryUnreadable";
}

export interface ProcessHandle {
  recordId: string;
  instanceId: string;
  pid: number;
  startTime: string | null;
  pgid: number | null;
  sid: number | null;
  bootId: string | null;
  ownerId: string | null;
}

export interface CleanupNotice {
  eventId: string;
  cid: string | null;
  content: string;
}

export interface ProcessBlocker {
  cid: string;
  instanceId: string;
  recordId: string;
  pid: number | null;
  reason: string;
}

export interface OwnedProcess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly exited: Promise<number>;
}

export type Row = Record<string, unknown>;

export interface ProcessLifecycleOptions {
  registry: ShellRegistry;
  shellStateDir: string;
  procRoot?: string;
  bootPath?: string;
  termGraceMs?: number;
  killGraceMs?: number;
  // Isolated child environment when a spawn supplies none.
  baseEnv?: () => Record<string, string>;
  newId?: () => string;
  nowSeconds?: () => number;
  /** Whose /proc stat answers Python's os.getpgid(0) self-group check. */
  selfPid?: number;
}

type GroupState =
  | "ok"
  | "dead"
  | "invalid"
  | "unverified"
  | "reused"
  | "changed-group"
  | "self-group"
  | "permission"
  | "unavailable";

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

/** asyncio returncode: exit status, or -signum for a signal death. */
export function returncode(proc: OwnedProcess): number | null {
  if (proc.exitCode !== null && proc.exitCode !== undefined)
    return proc.exitCode;
  if (proc.signalCode) {
    const signum = (constants.signals as Record<string, number>)[
      proc.signalCode
    ];
    return signum === undefined ? null : -signum;
  }
  return null;
}

const ALNUM = /^[\p{L}\p{N}]$/u;

export function safeRegistryId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    return false;
  if (value === "." || value === "..") return false;
  const chars = [...value];
  if (!ALNUM.test(chars[0]!)) return false;
  return chars.every((ch) => ALNUM.test(ch) || "._-".includes(ch));
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  return String(value);
}

export function recordFromBgShell(
  shell: ShellRecord,
  instanceId: string,
  cid: string | null,
  sessionId: string,
  boot: string | null,
): Row | null {
  const pid = shell.pid;
  const pgid = shell.pgid;
  const identity = shell.identity;
  if (shell.status !== "running" || !isInt(pid) || pid <= 1 || pgid !== pid)
    return null;
  let started = shell.startedAt;
  if (typeof started === "boolean") started = Number(started);
  if (started !== undefined && started !== null && typeof started !== "number")
    throw new ProcessRegistryUnreadable(
      "background-shell record has a non-numeric timestamp",
    );
  return {
    version: 1,
    id: `bg-${sessionId}-${pyStr("id" in shell ? shell.id : pid)}`,
    shell_id: shell.id ?? null,
    instance_id: instanceId,
    pid,
    start_time:
      identity !== null && identity !== undefined ? String(identity) : null,
    pgid,
    sid: pid,
    boot_id: shell.boot_id || boot,
    kind: "background-shell",
    command: shell.command ?? null,
    log_path: shell.logPath ?? null,
    mode: shell.mode ?? null,
    cid,
    launch_owner_id: shell.ownerId ?? null,
    session_id: sessionId,
    created: ((started as number | null | undefined) || 0) / 1000,
  };
}

function shellsForOwner(shells: Row[], owner: unknown): Row[] {
  return shells.filter(
    (shell) =>
      typeof owner === "string" && owner && shell.launch_owner_id === owner,
  );
}

function eventKey(record: Row): string {
  return `${pyStr(record.kind)}:${pyStr(record.pid)}:${pyStr(record.start_time)}`;
}

/** Stable, content-free inbox id making cleanup delivery idempotent. */
export function deterministicNoticeKey(
  notice: CleanupNotice,
  targetCid: string,
): string {
  return createHash("sha256")
    .update(`${notice.eventId}:${targetCid}`)
    .digest("hex")
    .slice(0, 24);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Detached bash groups belong to the shell extension, not shutdown cleanup.
// Reap/idle Stop verify shell ownership before signals; Durable's host supplies
// stopGroup for its tasks. Unknown identity never widens signals to strangers.
export class ProcessLifecycle {
  generationId: string | null = null;
  // Every live row: owned foreground groups plus retained shell associations.
  readonly rows = new Map<string, Row>();
  /** The subset with a live local child object. */
  readonly owned = new Map<string, [ProcessHandle, OwnedProcess]>();
  readonly reaps = new TaskSet();
  private startupAllowsSweep = false;
  private spawnsOpen = true;
  private readonly spawnLock = new AsyncMutex();
  private readonly procRoot: string;
  private readonly termGraceMs: number;
  private readonly killGraceMs: number;
  private readonly newId: () => string;
  private readonly nowSeconds: () => number;

  constructor(private readonly options: ProcessLifecycleOptions) {
    this.procRoot = options.procRoot ?? PROC;
    this.termGraceMs = options.termGraceMs ?? 2000;
    this.killGraceMs = options.killGraceMs ?? 1000;
    this.newId = options.newId ?? (() => randomUUID().replaceAll("-", ""));
    this.nowSeconds = options.nowSeconds ?? (() => Date.now() / 1000);
  }

  private boot(): Promise<string | null> {
    return bootId(this.options.bootPath);
  }

  private ensureGeneration(): string {
    this.generationId ??= this.newId();
    return this.generationId;
  }

  /** Validate start token + leader pgid/sid immediately before a signal. */
  async safeGroupRecord(record: Row): Promise<[GroupState, ProcStat | null]> {
    const pid = record.pid;
    if (!isInt(pid) || pid <= 1) return ["invalid", null];
    const recorded = record.boot_id;
    const current = await this.boot();
    if (!recorded || !current) return ["unverified", null];
    if (recorded !== current) return ["dead", null];
    const start = record.start_time;
    if (!start || record.pgid !== pid || record.sid !== pid)
      return ["unverified", null];
    const result = await procStat(pid, this.procRoot);
    if (result.state !== "ok") return [result.state, null];
    const stat = result.stat;
    if (stat.startTime !== String(start)) return ["reused", stat];
    if (stat.pgrp !== record.pgid || stat.session !== record.sid)
      return ["changed-group", stat];
    const self = await procStat(
      this.options.selfPid ?? process.pid,
      this.procRoot,
    );
    if (self.state !== "ok") return ["unverified", stat];
    if (self.stat.pgrp === record.pgid) return ["self-group", stat];
    return ["ok", stat];
  }

  // `present`, `absent` or `unknown` for the recorded session (fail closed).
  sessionMemberState(
    record: Row,
    excludeLeader = false,
    ignoreMarked?: string,
  ): Promise<"present" | "absent" | "unknown"> {
    const boot = record.boot_id;
    return sessionMemberState(
      {
        start_time:
          record.start_time == null ? null : String(record.start_time),
        pgid: isInt(record.pgid) ? record.pgid : null,
        sid: isInt(record.sid) ? record.sid : null,
        boot_id: boot ? String(boot) : null,
      },
      this.procRoot,
      this.options.bootPath,
      excludeLeader,
      ignoreMarked,
    );
  }

  async signalGroup(record: Row, sig: NodeJS.Signals): Promise<string> {
    let [state] = await this.safeGroupRecord(record);
    if (state === "dead") {
      // Invariant: A leader can leave before its descendants; only a verified
      // member authorizes the signal, and an unreadable scan stays pending.
      const members = await this.sessionMemberState(record);
      if (members === "absent") return "dead";
      if (members === "unknown") return "unavailable";
      state = "ok";
    }
    if (state !== "ok") return state;
    const pgid = record.pgid;
    if (!isInt(pgid)) return "unavailable";
    try {
      process.kill(-pgid, sig);
      return "signaled";
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") return "dead";
      if (code === "EPERM") return "permission";
      return "error";
    }
  }

  private ownersForCids(
    cids: Set<string>,
    generation: string,
  ): Map<string, [unknown, unknown]> {
    const owners = new Map<string, [unknown, unknown]>();
    for (const row of this.rows.values()) {
      if (
        cids.has(row.cid as string) &&
        row.instance_id === generation &&
        typeof row.launch_owner_id === "string" &&
        row.launch_owner_id &&
        !owners.has(row.launch_owner_id)
      )
        owners.set(row.launch_owner_id, [row.cid ?? null, row.boot_id ?? null]);
    }
    return owners;
  }

  /** Detached shells owned by these conversations; throws when unreadable. */
  async pollOwnedShells(cids: Set<string>): Promise<Row[]> {
    const generation = this.generationId;
    if (generation === null || !cids.size) return [];
    const owners = this.ownersForCids(cids, generation);
    if (!owners.size) return [];
    let sessions: string[];
    try {
      sessions = (
        await readdir(this.options.shellStateDir, { withFileTypes: true })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new ProcessRegistryUnreadable(
        "unreadable background-shell state dir",
      );
    }
    const found: Row[] = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      for (const [owner, [cid, boot]] of owners) {
        if (
          (cid !== null && typeof cid !== "string") ||
          (boot !== null && typeof boot !== "string")
        )
          throw new ProcessRegistryUnreadable(
            "owned row carries a non-string association identity",
          );
        const [shells, readable] = await this.options.registry.lifecycleRecords(
          session,
          owner,
        );
        if (!readable)
          throw new ProcessRegistryUnreadable(
            "unreadable background-shell registry",
          );
        for (const shell of shells) {
          const key = JSON.stringify([session, shell.id ?? null]);
          if (seen.has(key)) continue;
          seen.add(key);
          const rec = recordFromBgShell(
            shell,
            generation,
            cid as string | null,
            session,
            boot as string | null,
          );
          if (rec) found.push(rec);
        }
      }
    }
    return found;
  }

  private async backgroundRecordLive(record: Row): Promise<boolean> {
    const [state] = await this.safeGroupRecord(record);
    return (
      state === "ok" ||
      (state === "dead" && (await this.sessionMemberState(record)) !== "absent")
    );
  }

  private async recordsStillAlive(
    records: Row[],
    candidates: Set<string>,
  ): Promise<Set<string>> {
    const alive = new Set(candidates);
    for (const record of records) {
      const key = eventKey(record);
      if (!alive.has(key)) continue;
      const [state] = await this.safeGroupRecord(record);
      if (state === "dead") {
        if ((await this.sessionMemberState(record)) === "absent")
          alive.delete(key);
      } else if (
        ["reused", "changed-group", "self-group", "invalid"].includes(state)
      )
        alive.delete(key);
    }
    return alive;
  }

  private async waitRecords(
    records: Row[],
    deadline: number,
  ): Promise<Set<string>> {
    let alive = new Set(records.map(eventKey));
    while (alive.size && performance.now() < deadline) {
      alive = await this.recordsStillAlive(records, alive);
      if (alive.size) await sleep(50);
    }
    return alive;
  }

  /** Positive proof that a recorded group is gone, never signaling it. */
  async recordGoneReason(record: Row): Promise<string | null> {
    const [state] = await this.safeGroupRecord(record);
    if (!["dead", "reused", "changed-group"].includes(state)) return null;
    if ((await this.sessionMemberState(record)) !== "absent") return null;
    if (record.boot_id !== (await this.boot()))
      return "record is from a previous boot";
    if (state === "reused") return "pid was reused by a different process";
    if (state === "changed-group")
      return "recorded process left the owned session";
    return "pid and owned session are gone on the recorded boot";
  }

  private async blockerReason(record: Row, retained: boolean): Promise<string> {
    if (retained)
      return (
        "reaped foreground process still has an unverified detached " +
        "shell association; the reap path stops verifiable groups itself " +
        "and only truly unverifiable ones wait for extension reconciliation"
      );
    const gone = await this.recordGoneReason(record);
    if (gone) return `stale record was not yet released: ${gone}`;
    let [state] = (await this.safeGroupRecord(record)) as [string, unknown];
    if (state === "dead")
      state = `dead leader, session membership ${await this.sessionMemberState(record)}`;
    return `process identity is ${state}`;
  }

  /** Every ownership row that still blocks target deletion. */
  async processRecordBlockersFor(cids: Set<string>): Promise<ProcessBlocker[]> {
    if (!cids.size) return [];
    const generation = this.generationId;
    const snapshot = [...this.rows].map(
      ([id, row]) => [id, { ...row }, !this.owned.has(id)] as const,
    );
    const blockers: ProcessBlocker[] = [];
    for (const [recordId, record, retained] of snapshot) {
      if (!cids.has(record.cid as string)) continue;
      blockers.push({
        cid: String(record.cid),
        instanceId: generation ?? "<unknown>",
        recordId,
        pid: isInt(record.pid) ? record.pid : null,
        reason: await this.blockerReason(record, retained),
      });
    }
    const key = (b: ProcessBlocker) => [b.cid, b.instanceId, b.recordId];
    blockers.sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < 3; i++)
        if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
      return 0;
    });
    return blockers;
  }

  async hasProcessRecordsFor(cids: Set<string>): Promise<boolean> {
    return (await this.processRecordBlockersFor(cids)).length > 0;
  }

  /** Stop this generation's rows for targets whose runner dropped its proc. */
  async cleanupCurrentRecordsFor(cids: Set<string>): Promise<boolean> {
    if (this.generationId === null || !cids.size) return true;
    const owned = [...this.owned]
      .filter(
        ([id, [handle]]) =>
          handle.recordId === id && cids.has(this.rows.get(id)?.cid as string),
      )
      .map(([, [, proc]]) => proc);
    const retained = [...this.rows]
      .filter(([id, row]) => !this.owned.has(id) && cids.has(row.cid as string))
      .map(([id]) => id);
    let pending = false;
    for (const proc of owned) {
      const complete = await this.cleanupProcessObject(proc);
      if (complete !== true && complete !== null) pending = true;
    }
    let shells: Row[] | null;
    try {
      shells = await this.pollOwnedShells(cids);
    } catch (error) {
      if (!(error instanceof ProcessRegistryUnreadable)) throw error;
      shells = null;
    }
    for (const id of retained) {
      const row = this.rows.get(id);
      if (!row) continue;
      if (shells === null) {
        pending = true;
        continue;
      }
      if (!shellsForOwner(shells, row.launch_owner_id).length)
        this.rows.delete(id);
      else pending = true;
    }
    return !pending;
  }

  /** Reap path: stop retained detached-shell groups for deletion targets. */
  async cleanupBackgroundRecordsFor(cids: Set<string>): Promise<boolean> {
    if (this.generationId === null || !cids.size) return true;
    const generation = this.generationId;
    const retained = [...this.rows]
      .filter(
        ([id, row]) =>
          !this.owned.has(id) &&
          cids.has(row.cid as string) &&
          row.instance_id === generation,
      )
      .map(([id]) => id);
    let pending = false;
    let shells: Row[];
    try {
      shells = await this.pollOwnedShells(cids);
    } catch (error) {
      if (error instanceof ProcessRegistryUnreadable) return false;
      throw error;
    }
    for (const id of retained) {
      const row = this.rows.get(id);
      if (!row) continue;
      const associated = shellsForOwner(shells, row.launch_owner_id);
      if (!associated.length) {
        this.rows.delete(id);
        continue;
      }
      if (!(await this.stopVerifiedShells(associated, generation))) {
        pending = true;
        continue;
      }
      let rest: Row[];
      try {
        rest = shellsForOwner(
          await this.pollOwnedShells(cids),
          row.launch_owner_id,
        );
      } catch (error) {
        if (!(error instanceof ProcessRegistryUnreadable)) throw error;
        pending = true;
        continue;
      }
      let allGone = true;
      for (const shell of rest)
        if ((await this.recordGoneReason(shell)) === null) allGone = false;
      if (allGone) this.rows.delete(id);
      else pending = true;
    }
    return !pending;
  }

  private async stopVerifiedShells(
    shells: Row[],
    generation: string,
  ): Promise<boolean> {
    for (const shell of shells) {
      if (shell.instance_id !== generation) return false;
      if (!(await this.stopGroup(shell))) return false;
    }
    return true;
  }

  // Stop a recorded detached group with TERM/verify/KILL/verify.
  // True when proven gone; never signal reused pids or groups outside the
  // session.
  // False for unverifiable identity or surviving members.
  async stopGroup(shell: Row): Promise<boolean> {
    if ((await this.recordGoneReason(shell)) !== null) return true;
    if (!(await this.backgroundRecordLive(shell)))
      return (await this.recordGoneReason(shell)) !== null;
    if (
      !["signaled", "dead"].includes(await this.signalGroup(shell, "SIGTERM"))
    )
      return (await this.recordGoneReason(shell)) !== null;
    let alive = await this.waitRecords(
      [shell],
      performance.now() + this.termGraceMs,
    );
    if (alive.size) {
      if (
        !["signaled", "dead"].includes(await this.signalGroup(shell, "SIGKILL"))
      )
        return (await this.recordGoneReason(shell)) !== null;
      alive = await this.waitRecords(
        [shell],
        performance.now() + this.killGraceMs,
      );
    }
    return alive.size === 0;
  }

  /** In-memory check only: does this generation retain a shell row for cid? */
  hasRetainedShellsFor(cid: string): boolean {
    if (this.generationId === null || !cid) return false;
    for (const [id, row] of this.rows)
      if (
        !this.owned.has(id) &&
        row.cid === cid &&
        row.instance_id === this.generationId
      )
        return true;
    return false;
  }

  private async liveShells(cid: string): Promise<Row[]> {
    const live: Row[] = [];
    for (const record of await this.pollOwnedShells(new Set([cid])))
      if (await this.backgroundRecordLive(record)) live.push(record);
    return live;
  }

  /** Idle Stop: `[stopped, pending]` detached-shell groups for cid. */
  async stopIdleShellsFor(cid: string): Promise<[number, number]> {
    const generation = this.generationId;
    if (generation === null || !cid) return [0, 0];
    let unverified = false;
    let before: Row[];
    try {
      before = await this.liveShells(cid);
    } catch (error) {
      if (!(error instanceof ProcessRegistryUnreadable)) throw error;
      before = [];
      unverified = true;
    }
    if (before.length) await this.stopVerifiedShells(before, generation);
    const cleared = await this.cleanupBackgroundRecordsFor(new Set([cid]));
    let after: Row[];
    try {
      after = await this.liveShells(cid);
    } catch (error) {
      if (!(error instanceof ProcessRegistryUnreadable)) throw error;
      after = before;
    }
    const stopped = Math.max(0, before.length - after.length);
    let pending = after.length;
    if (unverified && !cleared) pending = Math.max(pending, 1);
    return [stopped, pending];
  }

  startupAllowsTempSweep(): boolean {
    return this.startupAllowsSweep;
  }

  tempSweepSafeNow(): boolean {
    return this.startupAllowsSweep && this.generationId !== null;
  }

  /** Initialize this generation; prior generations are forgotten. */
  async startupCleanup(): Promise<CleanupNotice[]> {
    if (this.generationId !== null) return [];
    this.generationId = this.newId();
    this.startupAllowsSweep = true;
    this.spawnsOpen = true;
    return [];
  }

  async runtimeShellCleanupNotice(
    handle: ProcessHandle,
    cid: string,
    sessionId: string,
    reason: string,
  ): Promise<CleanupNotice | null> {
    if (
      !["model change", "session change"].includes(reason) ||
      !safeRegistryId(cid) ||
      !safeRegistryId(sessionId) ||
      !safeRegistryId(handle.ownerId)
    )
      return null;
    const [records, readable] = await this.options.registry.lifecycleRecords(
      sessionId,
      handle.ownerId,
    );
    if (!readable || !records.some((r) => r.status === "running")) return null;
    const eventId = createHash("sha256")
      .update(
        `runtime-shell-cleanup:${handle.instanceId}:${handle.recordId}:${reason}`,
      )
      .digest("hex")
      .slice(0, 20);
    const content =
      `[Platform process cleanup · ${eventId.slice(0, 8)}] A ${reason} is retiring ` +
      `the Pi session for agent \`${cid}\`, so its running background shells ` +
      "will be stopped. Their completion notices identify the shells and " +
      "preserved log paths.";
    return { eventId, cid, content };
  }

  /** Track a newly spawned, own-generation process before it may run. */
  async registerProcess(
    proc: OwnedProcess,
    kind: string,
    cid: string | null = null,
    sessionId: string | null = null,
    ownerId: string | null = null,
  ): Promise<ProcessHandle> {
    const pid = proc.pid;
    if (!isInt(pid) || pid <= 0)
      return {
        recordId: `test-untracked-${this.newId()}`,
        instanceId: "",
        pid: -1,
        startTime: null,
        pgid: null,
        sid: null,
        bootId: null,
        ownerId: null,
      };
    const generation = this.ensureGeneration();
    const [result, boot] = await Promise.all([
      procStat(pid, this.procRoot),
      this.boot(),
    ]);
    const stat = result.state === "ok" ? result.stat : null;
    const recordId = this.newId();
    const verified = !!(
      stat?.startTime &&
      stat.pgrp === pid &&
      stat.session === pid
    );
    // Invariant: An unreadable leader identity keeps ownership open but never
    // signalable.
    const row: Row = {
      version: 1,
      id: recordId,
      instance_id: generation,
      pid,
      start_time: verified ? stat!.startTime : null,
      pgid: verified ? pid : null,
      sid: verified ? pid : null,
      boot_id: boot,
      ...(verified ? {} : { identity_state: UNVERIFIED_IDENTITY }),
      kind,
      cid,
      session_id: sessionId,
      launch_owner_id: ownerId,
      created: this.nowSeconds(),
    };
    const handle: ProcessHandle = {
      recordId,
      instanceId: generation,
      pid,
      startTime: row.start_time as string | null,
      pgid: row.pgid as number | null,
      sid: row.sid as number | null,
      bootId: boot,
      ownerId,
    };
    this.rows.set(recordId, row);
    this.owned.set(recordId, [handle, proc]);
    return handle;
  }

  private rowForHandle(handle: ProcessHandle): Row | null {
    if (handle.instanceId !== this.generationId) return null;
    const row = this.rows.get(handle.recordId);
    if (!row || row.pid !== handle.pid) return null;
    return Object.fromEntries(
      Object.entries(row).filter(([key]) => !key.startsWith("_")),
    );
  }

  /** Forget an owned handle; retire its row unless it still guards shells. */
  async unregisterProcess(
    handle: ProcessHandle,
    detached = false,
  ): Promise<void> {
    this.owned.delete(handle.recordId);
    const row = this.rows.get(handle.recordId);
    if (handle.pid <= 0 || !safeRegistryId(handle.instanceId) || !row) return;
    const snapshot = { ...row };
    if (!detached) return this.retireRow(handle, snapshot);
    this.detach("process_retire_row", () => this.retireRow(handle, snapshot));
  }

  private async retireRow(handle: ProcessHandle, row: Row): Promise<void> {
    const cid = row.cid;
    let shells: Row[];
    try {
      shells = await this.pollOwnedShells(
        typeof cid === "string" ? new Set([cid]) : new Set(),
      );
    } catch (error) {
      if (error instanceof ProcessRegistryUnreadable) return;
      throw error;
    }
    if (shellsForOwner(shells, row.launch_owner_id).length) return;
    if (!this.owned.has(handle.recordId)) this.rows.delete(handle.recordId);
  }

  async unregisterIfDead(
    handle: ProcessHandle,
    proc: OwnedProcess,
  ): Promise<void> {
    if (returncode(proc) !== null) await this.unregisterProcess(handle, true);
  }

  /** Forget every handle for this exact process object once it has exited. */
  async unregisterProcessObject(proc: OwnedProcess | null): Promise<void> {
    if (!proc || returncode(proc) === null) return;
    const handles = [...this.owned.values()]
      .filter(([, owned]) => owned === proc)
      .map(([handle]) => handle);
    for (const handle of handles) await this.unregisterProcess(handle);
  }

  private isOwned(proc: OwnedProcess): boolean {
    for (const [, owned] of this.owned.values())
      if (owned === proc) return true;
    return false;
  }

  /** Stop and verify one registered foreground group. */
  async cleanupProcessObject(proc: OwnedProcess): Promise<boolean | null> {
    if (!this.isOwned(proc)) return null;
    await this.terminate(proc);
    return !this.isOwned(proc);
  }

  private async terminate(
    proc: OwnedProcess,
    graceMs = this.termGraceMs,
  ): Promise<void> {
    try {
      const handle = this.ownedHandle(proc);
      const record = handle ? this.rowForHandle(handle) : null;
      if (!record) return;
      const result = await this.signalGroup(record, "SIGTERM");
      if (result !== "signaled" && result !== "dead") return;
      let alive = await this.waitRecords(
        [record],
        performance.now() + Math.max(0, graceMs),
      );
      if (alive.size) {
        await this.signalGroup(record, "SIGKILL");
        alive = await this.waitRecords(
          [record],
          performance.now() + this.killGraceMs,
        );
      }
      if (alive.size) return;
      // Invariant: Group liveness can reach zero just before the exit is
      // published.
      if (returncode(proc) === null) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const exited = await Promise.race([
          proc.exited.then(() => true),
          new Promise<boolean>((r) => {
            timer = setTimeout(() => r(false), this.killGraceMs);
          }),
        ]);
        clearTimeout(timer);
        if (!exited) return;
      }
      await this.unregisterProcessObject(proc);
    } catch {
      // Invariant: The in-memory row is the retry path.
    }
  }

  /** TaskSet holds and reports the task; this caller only discards it. */
  private detach(name: string, fn: () => Promise<void>): void {
    this.reaps.spawn(name, fn).catch(() => undefined);
  }

  async drainReaps(): Promise<void> {
    await this.reaps.drain();
  }

  /** TERM→KILL and forget a registered child outside the cancelled caller. */
  scheduleReap(proc: OwnedProcess): boolean {
    if (!this.isOwned(proc)) return false;
    this.detach("process_reap", () => this.terminate(proc));
    return true;
  }

  /** Spawn a group/session leader tracked by this generation. */
  async spawnTracked<T extends OwnedProcess = ReturnType<typeof Bun.spawn>>(
    argv: string[],
    kind: string,
    options: {
      cid?: string | null;
      env?: Record<string, string>;
      spawn?: Omit<
        Parameters<typeof Bun.spawn>[1] & object,
        "env" | "detached"
      >;
    } = {},
  ): Promise<[T, ProcessHandle]> {
    return this.spawnLock.run(async () => {
      if (!this.spawnsOpen)
        throw new Error("process lifecycle is shutting down");
      const ownerId = this.newId();
      const env = {
        ...(options.env ?? this.options.baseEnv?.() ?? {}),
        PI_BG_SHELL_OWNER_ID: ownerId,
      };
      const proc = Bun.spawn(argv, {
        ...(options.spawn ?? {}),
        env,
        detached: true,
      }) as unknown as T;
      try {
        const handle = await this.registerProcess(
          proc,
          kind,
          options.cid ?? null,
          null,
          ownerId,
        );
        return [proc, handle] as [T, ProcessHandle];
      } catch (error) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          try {
            process.kill(proc.pid, "SIGKILL");
          } catch {}
        }
        throw error;
      }
    });
  }

  ownedHandle(proc: OwnedProcess): ProcessHandle | null {
    for (const [handle, owned] of this.owned.values())
      if (owned === proc) return handle;
    return null;
  }

  private recordForProcessObject(proc: OwnedProcess): Row | null {
    const handle = this.ownedHandle(proc);
    if (!handle) return null;
    const record = this.rowForHandle(handle);
    if (record) return record;
    if (handle.pid <= 0) return null;
    return {
      version: 1,
      id: handle.recordId,
      instance_id: handle.instanceId,
      pid: handle.pid,
      start_time: handle.startTime,
      pgid: handle.pgid,
      sid: handle.sid,
      boot_id: handle.bootId,
      launch_owner_id: handle.ownerId,
      kind: "in-memory-owned",
    };
  }

  async signalProcessObject(
    proc: OwnedProcess,
    sig: NodeJS.Signals,
  ): Promise<boolean> {
    const record = this.recordForProcessObject(proc);
    return !!record && (await this.signalGroup(record, sig)) === "signaled";
  }

  /** Stop this generation's foreground groups; detached shells stay. */
  async shutdownCleanup(graceMs = this.termGraceMs): Promise<boolean> {
    this.spawnsOpen = false;
    const processes = await this.spawnLock.run(async () =>
      [...this.owned.values()].map(([, proc]) => proc),
    );
    for (const proc of processes) await this.terminate(proc, graceMs);
    const pending = this.owned.size > 0;
    if (!pending) this.rows.clear();
    return !pending;
  }
}
