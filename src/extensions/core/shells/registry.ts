// Detached shell groups with foreground/background/monitor notices. Timer and
// async failures are guarded, logged and fail open without crashing Pi or
// wedging turns.

import { type ChildProcess, spawn } from "node:child_process";
import { slowSpan } from "../../../observability/slow_span";
import fs from "node:fs";
import fsPromises, { type FileHandle } from "node:fs/promises";
import {
  HAS_PROCESS_TABLE,
  procEntryExists,
  procIds,
  procIdsSync,
  procText,
  procTextSync,
} from "../../../utils/process_table.ts";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_WAIT_SCHEDULE_SECONDS } from "./backoff.ts";
import { rewriteCommand } from "./rewrite.ts";
import { type AdviceKind, ReminderSpacing } from "../../../reminder_text.ts";
import { fileSize, readLastLine, readRange, trimFile } from "./fileio.ts";
import { capLines, splitCompleteLines } from "./lines.ts";
import {
  getBootId,
  prepareBootId,
  procStartTime,
  type RecordStatus,
  type RegistryStore,
  type ShellRecord,
  type CompletionPersistence,
  type CompletionRecord,
} from "./persist.ts";
import {
  formatBackgroundShellReminder,
  formatStillRunningShell,
  fmtElapsed,
  middleElide,
  type BackgroundReminderShell,
} from "./status.ts";
import { clampLineLimit, trimOutput } from "./trim.ts";

export type ShellMode = "foreground" | "background" | "monitor";
export type ShellStatus = "running" | "exited" | "killed" | "error";
export type ShellLaunchError = "live-cap" | "spawn";

// Notification command cap; logs and trimmed output retain details.
const COMMAND_CHARS_IN_MESSAGES = 300;

// Publish ownership call id; never inherited when a shell has no call id.
export const TOOL_CALL_ID_ENV = "RECURSE_TOOL_CALL_ID";
const TOOL_CALL_ID = /^[\x21-\x7e]{1,256}$/;

export interface ShellConfig {
  /** How long a foreground command blocks before being backgrounded (ms). */
  foregroundWaitMs: number;
  /** Byte budget for trimmed output returned/notified. */
  byteBudget: number;
  /** Max output lines shown (split between head and tail); capped at 2000. */
  lineLimit: number;
  /** Max characters per line before truncation. */
  maxLineLen: number;
  // Notice/wait intervals in seconds; repeat the last step indefinitely.
  scheduleSeconds: number[];
  /** Monitor flush interval (ms). */
  monitorFlushMs: number;
  /** Max lines delivered per monitor flush; overflow collapses to a summary. */
  monitorMaxLinesPerFlush: number;
  /** Grace period between SIGTERM and SIGKILL when killing (ms). */
  killGraceMs: number;
  /** Directory for per-shell log files. */
  logDir: string;
  /** Shell binary. */
  shell: string;
  /** Build shell args from the command string. */
  shellArgs: (command: string) => string[];
  /** Tail window for "last log line" sampling (bytes). */
  tailWindowBytes: number;
  /** Max bytes read per monitor flush (bounds work under a flooding writer). */
  monitorMaxChunkBytes: number;
  /** Max shells retained in the registry; oldest completed ones are evicted. */
  maxTrackedShells: number;
  // Detached live-group cap; foreground recovery remains usable.
  maxLiveShells: number;
  /** Rewrite live ownership records on this interval (ms), repairing loss. */
  ownershipHeartbeatMs: number;
  /** Remind the agent after this many silent milliseconds; 0 disables. */
  inactivityReminderMs: number;
  /** Runner-selected per-agent override file and its private parent. */
  environmentFile: string | undefined;
  agentTempDir: string | undefined;
}

export const DEFAULT_CONFIG: ShellConfig = {
  foregroundWaitMs: 10_000,
  byteBudget: 50 * 1024,
  lineLimit: 2000,
  maxLineLen: 500,
  scheduleSeconds: [...DEFAULT_WAIT_SCHEDULE_SECONDS],
  monitorFlushMs: 1000,
  monitorMaxLinesPerFlush: 50,
  killGraceMs: 3000,
  logDir: join(tmpdir(), "pi-bg-shell"),
  shell: "bash",
  shellArgs: (command: string) => ["-c", command],
  tailWindowBytes: 8192,
  monitorMaxChunkBytes: 128 * 1024,
  maxTrackedShells: 200,
  maxLiveShells: 9,
  ownershipHeartbeatMs: 30_000,
  inactivityReminderMs: 1_800_000,
  environmentFile: undefined,
  agentTempDir: undefined,
};

export interface MonitorNotice {
  shellId: string;
  lines: string[];
}

export interface Notifier {
  // Deliver agent messages with durable ids for terminal notices.
  send(
    text: string,
    opts: {
      triggerTurn: boolean;
      completion?: CompletionRecord;
      monitor?: MonitorNotice;
    },
  ): void;
  /** Report an internal error (fail-open; never propagated to the host). */
  error?(message: string): void;
}

export interface Shell {
  id: string;
  command: string;
  /** Whether the run dropped anti-patterns before spawn (see rewrite.ts). */
  hygieneDropped: boolean;
  mode: ShellMode;
  pid: number | undefined;
  pgid: number | undefined;
  startedAt: number;
  launchSequence: number;
  // Background entry time anchors the still-running cadence.
  backgroundedAt: number;
  endedAt: number | undefined;
  logPath: string;
  status: ShellStatus;
  exitCode: number | null;
  /** Killing signal name when terminated by a signal, else null. */
  signal: NodeJS.Signals | null;
  /** Process-identity token captured at spawn (stat field 22 start time). */
  identity: string | undefined;
  // Spawn boot token; refuse kills from a previous generation.
  bootId: string | undefined;
  /** Why a launch failed before spawn, when the error is actionable. */
  launchError?: ShellLaunchError;
  /** Native spawn failure, retained for an actionable tool result. */
  launchErrorMessage?: string;
  /** Whether completion should be pushed to the agent (vs returned inline). */
  notifyOnComplete: boolean;
  /** Max output lines frozen into this shell's completion (clamped 1..2000). */
  lineLimit: number;
  child: ChildProcess | undefined;
  fd: number | undefined;
  // timers / streaming state
  monitorTimer: ReturnType<typeof setTimeout> | undefined;
  ownershipTimer: ReturnType<typeof setInterval> | undefined;
  pendingExit:
    | { code: number | null; signal: NodeJS.Signals | null }
    | undefined;
  monitorPending: string;
  monitorPos: number;
  completed: boolean;
  /** Whether the current ownership record reached the atomic on-disk store. */
  recordPersisted: boolean;
  persistenceVersion?: number;
  /** Epoch ms of the latest successful live ownership write. */
  lastOwnershipPersistAt: number;
  /** Pending until the corresponding custom-message batch is acknowledged. */
  completion: CompletionRecord | undefined;
}

// Veto signals on mismatched leader start time or boot id. A missing leader can
// pass only with the caller's owned-group membership proof covering surviving
// descendants.
export function verifySignalIdentity(shell: {
  pid: number | undefined;
  pgid: number | undefined;
  identity: string | undefined;
  bootId?: string | undefined;
}): boolean {
  if (shell.pgid === undefined || shell.pid !== shell.pgid) return false;
  if (typeof shell.bootId === "string" && shell.bootId) {
    const boot = getBootId();
    if (boot === undefined || boot !== shell.bootId.toLowerCase()) return false;
  }
  if (shell.identity !== undefined && HAS_PROCESS_TABLE) {
    let current: string | undefined;
    try {
      current = procStartTime(shell.pgid);
    } catch {
      current = undefined;
    }
    if (current !== undefined && current !== shell.identity) return false;
  }
  return true;
}

export interface ShellInfo {
  id: string;
  pid: number | undefined;
  command: string;
  mode: ShellMode;
  status: ShellStatus;
  exitCode: number | null;
  elapsedMs: number;
  logPath: string;
}

let idCounter = 0;
const OPEN_DESCRIPTORS =
  process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

const GREP_WORD = /\bgrep\b/;
const FIND_WORD = /\bfind\b/;

/** A shell search that ran directly rather than filtering a pipeline. */
function nakedSearch(command: string, word: RegExp): boolean {
  return !command.includes("|") && word.test(command);
}

function shortId(): string {
  idCounter = (idCounter + 1) % 100000;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${Date.now().toString(36).slice(-4)}${rand}${idCounter.toString(36)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function trustedEnvironmentFile(
  file: string | undefined,
  tempDir: string | undefined,
): string | undefined {
  if (!file || !tempDir || !isAbsolute(file) || !isAbsolute(tempDir))
    return undefined;
  return resolve(file) === file &&
    resolve(tempDir) === tempDir &&
    dirname(file) === tempDir &&
    file === join(tempDir, "env.sh")
    ? file
    : undefined;
}

interface ProcGroupStat {
  pid: number;
  pgrp: number;
  sid: number;
  state: string;
  start: string;
}

function procGroupStat(pid: number): ProcGroupStat | undefined {
  if (!HAS_PROCESS_TABLE) return undefined;
  try {
    const raw = procTextSync(pid, "stat");
    const end = raw.lastIndexOf(")");
    const fields = raw
      .slice(end + 1)
      .trim()
      .split(/\s+/);
    if (end < 0 || fields.length < 20) return undefined;
    return {
      pid,
      state: fields[0],
      pgrp: Number(fields[2]),
      sid: Number(fields[3]),
      start: fields[19],
    };
  } catch {
    return undefined;
  }
}

interface GroupSnapshot {
  members: number;
  leaderStart?: string;
}

/** One /proc traversal shared by every leader-exited shell in this registry. */
function addGroupStat(
  groups: Map<number, GroupSnapshot>,
  stat: ProcGroupStat | undefined,
): void {
  if (!stat || stat.state === "Z" || stat.pgrp <= 1 || stat.sid !== stat.pgrp)
    return;
  const group = groups.get(stat.pgrp) ?? { members: 0 };
  group.members++;
  if (stat.pid === stat.pgrp) group.leaderStart = stat.start;
  groups.set(stat.pgrp, group);
}

function verifiedProcessGroupSnapshot():
  | Map<number, GroupSnapshot>
  | undefined {
  const groups = new Map<number, GroupSnapshot>();
  if (!HAS_PROCESS_TABLE) return undefined;
  try {
    for (const name of procIdsSync()) {
      if (!/^\d+$/.test(name)) continue;
      const stat = procGroupStat(Number(name));
      if (!stat && procEntryExists(name)) return undefined;
      addGroupStat(groups, stat);
    }
  } catch {
    return undefined;
  }
  return groups;
}

function processGroupSnapshot(): Map<number, GroupSnapshot> {
  return verifiedProcessGroupSnapshot() ?? new Map();
}

async function processGroupSnapshotAsync(): Promise<
  Map<number, GroupSnapshot>
> {
  const groups = new Map<number, GroupSnapshot>();
  if (!HAS_PROCESS_TABLE) return groups;
  let names: string[];
  try {
    names = await procIds();
  } catch {
    return groups;
  }
  for (let start = 0; start < names.length; start += 64) {
    const stats = await Promise.all(
      names.slice(start, start + 64).map(async (name) => {
        if (!/^\d+$/.test(name)) return undefined;
        try {
          const pid = Number(name);
          const raw = await procText(name, "stat");
          const end = raw.lastIndexOf(")");
          const fields = raw
            .slice(end + 1)
            .trim()
            .split(/\s+/);
          if (end < 0 || fields.length < 20) return undefined;
          return {
            pid,
            state: fields[0],
            pgrp: Number(fields[2]),
            sid: Number(fields[3]),
            start: fields[19],
          };
        } catch {
          return undefined;
        }
      }),
    );
    for (const stat of stats) addGroupStat(groups, stat);
  }
  return groups;
}

/** Unknown liveness retains teardown ownership; only ESRCH proves absence. */
function processGroupExists(shell: Shell): boolean {
  const pgid = shell.pgid;
  if (pgid === undefined || pgid <= 1 || shell.pid !== pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

function ownedGroupHasMembers(
  shell: Shell,
  groups: Map<number, GroupSnapshot>,
): boolean {
  const pgid = shell.pgid;
  if (pgid === undefined || pgid <= 1 || shell.pid !== pgid) return false;
  const group = groups.get(pgid);
  if (!group || group.members === 0) return false;
  return !group.leaderStart || group.leaderStart === shell.identity;
}

function slug(command: string): string {
  return (
    command
      .trim()
      .slice(0, 24)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "cmd"
  );
}

export class ShellRegistry {
  readonly cfg: ShellConfig;
  private readonly notifier: Notifier;
  private readonly environmentFile: string | undefined;
  private readonly shells = new Map<string, Shell>();
  /** Bounded live index; terminal history may outlive this process view. */
  private readonly liveShells = new Map<string, Shell>();
  private readonly monitorFlushes = new WeakMap<Shell, Promise<void>>();
  private readonly outputReaders = new WeakMap<Shell, number>();
  private readonly initialized: Promise<void>;
  private readonly launches = new WeakMap<Shell, Promise<void>>();
  private readonly descriptors = new WeakMap<
    Shell,
    { handle: FileHandle; close?: Promise<void> }
  >();
  private readonly recentCommands: string[] = [];
  /** Every run() call; orders launches. */
  private totalRuns = 0;
  /** Spacing for this agent's shell reminders. */
  readonly reminders = new ReminderSpacing();
  private disposed = false;
  // On-disk mirror; absent until session id is known or when degraded.
  private store: RegistryStore | undefined;
  // Freeze live records at teardown so resume sees interrupted shells.
  private frozen = false;
  private readonly pendingPersists = new Map<string, Promise<boolean>>();
  private shutdownPromise: Promise<void> | undefined;
  private completionSequence = 0;
  private groupPollTimer: ReturnType<typeof setTimeout> | undefined;
  private groupPollEpoch = 0;

  constructor(
    notifier: Notifier,
    cfg: Partial<ShellConfig> = {},
    store?: RegistryStore,
    private readonly inputs: {
      ownerId?: string;
      environment?: () => Record<string, string>;
    } = {},
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.notifier = notifier;
    this.environmentFile = trustedEnvironmentFile(
      this.cfg.environmentFile,
      this.cfg.agentTempDir,
    );
    this.store = store;
    this.initialized = fsPromises
      .mkdir(this.cfg.logDir, { recursive: true })
      .then(
        () => {},
        () => {},
      );
  }

  // Completion state shares the shell-liveness session directory.
  completionPersistence(): CompletionPersistence | undefined {
    const store = this.store;
    if (!store) return undefined;
    return {
      loadPending: () => store.loadPendingCompletions(),
      acknowledge: async (completionIds) => {
        const ok = await store.acknowledgeCompletions(completionIds);
        if (ok) {
          const ids = new Set(completionIds);
          for (const shell of this.shells.values()) {
            if (shell.completion && ids.has(shell.completion.id))
              shell.completion = undefined;
          }
          this.evict();
        }
        return ok;
      },
    };
  }

  // Persist current shell state unless the store is absent or frozen.
  private async persist(shell: Shell): Promise<boolean> {
    if (!this.store || this.frozen) return false;
    const version = (shell.persistenceVersion ?? 0) + 1;
    shell.persistenceVersion = version;
    const requestedAt = Date.now();
    let pending: Promise<boolean> | undefined;
    try {
      pending = this.store.write(toRecord(shell, this.inputs.ownerId));
      this.pendingPersists.set(shell.id, pending);
      const ok = await pending;
      if (shell.persistenceVersion === version) {
        shell.recordPersisted = ok;
        if (ok) shell.lastOwnershipPersistAt = requestedAt;
      }
      return ok;
    } catch (err) {
      if (shell.persistenceVersion === version) shell.recordPersisted = false;
      this.reportError(err);
      return false;
    } finally {
      if (pending && this.pendingPersists.get(shell.id) === pending)
        this.pendingPersists.delete(shell.id);
    }
  }

  /** Settle accepted snapshots before handoff or a foreground result. */
  async flushPersistence(shell: Shell): Promise<void> {
    await this.store?.flush(shell.id);
  }

  // Retry missing records or transient /proc identity failures.
  private refreshOwnershipRecord(shell: Shell): void {
    if (
      shell.completed ||
      shell.status !== "running" ||
      this.pendingPersists.has(shell.id)
    )
      return;
    let identityChanged = false;
    if (shell.identity === undefined && shell.pid !== undefined) {
      try {
        const identity = procStartTime(shell.pid);
        if (identity !== undefined) {
          shell.identity = identity;
          identityChanged = true;
        }
      } catch {}
    }
    const heartbeatDue =
      Date.now() - shell.lastOwnershipPersistAt >=
      this.cfg.ownershipHeartbeatMs;
    if (!shell.recordPersisted || identityChanged || heartbeatDue)
      this.persist(shell);
  }

  // Prove exact pid/start identity is durably readable before detached launch
  // handoff. A successful write is insufficient: directory replacement may
  // erase it before return.
  async hasDurableOwnership(shell: Shell): Promise<boolean> {
    if (!this.store?.sessionScoped || this.frozen) return false;
    if (shell.pid === undefined || shell.pid <= 1 || shell.pgid !== shell.pid)
      return false;
    if (!shell.identity) this.refreshOwnershipRecord(shell);
    await this.flushPersistence(shell);
    if (this.frozen) return false;
    if (!shell.identity || procStartTime(shell.pid) !== shell.identity)
      return false;
    const matches = async () => {
      const record = await this.store?.readRecord(shell.id);
      return Boolean(
        !this.frozen &&
        !shell.completed &&
        record &&
        record.id === shell.id &&
        record.pid === shell.pid &&
        record.pgid === shell.pgid &&
        record.identity === shell.identity &&
        record.ownerId === this.inputs.ownerId &&
        shell.pid !== undefined &&
        procStartTime(shell.pid) === shell.identity,
      );
    };
    if (shell.recordPersisted && (await matches())) return true;
    if (this.frozen || shell.completed) return false;
    return (await this.persist(shell)) && (await matches());
  }

  // Stop launches without durable ownership rather than let them escape
  // untracked. Guard signals with identity/group snapshots.
  async discardUnowned(shell: Shell): Promise<boolean> {
    shell.notifyOnComplete = false;
    this.clearTimers(shell);
    // Invariant: Before handoff the exact unreaped ChildProcess owns its group
    // even if /proc capture failed; that failure must not orphan it.
    const child = shell.child;
    const pgid = shell.pgid;
    const signalFreshGroup = (sig: NodeJS.Signals) => {
      if (!child || child.pid !== pgid || pgid === undefined || pgid <= 1)
        return;
      try {
        process.kill(-pgid, sig);
      } catch {}
    };
    // Invariant: Kill before awaiting to close teardown races. SIGKILL avoids
    // identity-less leaders exiting during TERM grace while children linger.
    signalFreshGroup("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, this.cfg.killGraceMs));
    if (processGroupExists(shell)) {
      // Invariant: Retain ownership for exit retries; never claim cleanup while
      // an uninterruptible member survives.
      await this.closeFd(shell);
      return false;
    }
    // Invariant: Mark terminal before removal so late exit callbacks cannot
    // recreate records.
    shell.completed = true;
    shell.status = "killed";
    shell.endedAt ??= Date.now();
    shell.pendingExit = undefined;
    this.clearTimers(shell);
    await this.closeFd(shell);
    await this.removePersist(shell.id);
    this.liveShells.delete(shell.id);
    this.shells.delete(shell.id);
    await this.pruneStore();
    return true;
  }

  /** Drop a shell's on-disk record (no-op without a store / when frozen). */
  private async removePersist(id: string): Promise<void> {
    if (!this.store || this.frozen) return;
    try {
      await this.store.remove(id);
    } catch {}
  }

  // Guard callbacks so thrown errors cannot escape to the host.
  private safe(fn: () => void | Promise<void>): void {
    try {
      void Promise.resolve(fn()).catch((err) => this.reportError(err));
    } catch (err) {
      this.reportError(err);
    }
  }

  private reportError(err: unknown): void {
    try {
      this.notifier.error?.(err instanceof Error ? err.message : String(err));
    } catch {
      // Invariant: A failed notifier must not propagate diagnostic errors.
    }
  }

  private notify(
    text: string,
    triggerTurn: boolean,
    completion?: CompletionRecord,
    monitor?: MonitorNotice,
  ): void {
    try {
      this.notifier.send(text, { triggerTurn, completion, monitor });
    } catch (err) {
      this.reportError(err);
    }
  }

  /** Persist a terminal notice before exposing it to the in-memory pi queue. */
  private async queueCompletion(
    shell: Shell,
    message: string,
  ): Promise<CompletionRecord> {
    const completion: CompletionRecord = {
      id: shell.id,
      message,
      createdAt: Date.now(),
      sequence: ++this.completionSequence,
    };
    shell.completion = completion;
    await this.persist(shell);
    return completion;
  }

  get(id: string): Shell | undefined {
    return this.shells.get(id);
  }

  private liveBackgroundShellCount(): number {
    let count = 0;
    for (const shell of this.liveShells.values()) {
      if (
        !shell.completed &&
        shell.status === "running" &&
        (shell.mode === "background" || shell.mode === "monitor")
      )
        count++;
    }
    return count;
  }

  private liveShellCap(): number {
    return Math.max(1, Math.floor(this.cfg.maxLiveShells));
  }

  /** Spaced hygiene advice for a run whose rewrite dropped something. */
  commandHygieneNote(shell: Shell): string | undefined {
    return shell.hygieneDropped
      ? this.reminders.advice("shell-hygiene")
      : undefined;
  }

  /** Record one invocation and return bounded-loop guidance for its result. */
  commandAdvisories(command: string): string[] {
    this.recentCommands.push(command);
    if (this.recentCommands.length > 3) this.recentCommands.shift();
    if (this.recentCommands.length < 3) return [];
    const kinds: AdviceKind[] = [];
    if (this.recentCommands.every((item) => item === command))
      kinds.push("loop");
    if (this.recentCommands.every((item) => item.startsWith("cd ")))
      kinds.push("cd");
    if (this.recentCommands.every((item) => nakedSearch(item, GREP_WORD)))
      kinds.push("grep");
    if (this.recentCommands.every((item) => nakedSearch(item, FIND_WORD)))
      kinds.push("find");
    return kinds.flatMap((kind) => this.reminders.advice(kind) ?? []);
  }

  // Whether this foreground shell may become detached.
  canBackgroundify(shell: Shell): boolean {
    if (shell.completed || shell.mode !== "foreground") return true;
    return this.liveBackgroundShellCount() < this.liveShellCap();
  }

  /** Bounded recovery instructions when no detached slot is available. */
  liveShellCapMessage(): string {
    const count = this.liveBackgroundShellCount();
    const reminder = this.backgroundShellReminder();
    return `Live background-shell limit reached (${count}/${this.liveShellCap()}). Wait for an existing completion, inspect an existing log, or kill an existing process group using its reported pgid; do not launch another sleep/poll shell.${reminder ? `\n${reminder}` : ""}`;
  }

  list(): ShellInfo[] {
    const now = Date.now();
    return [...this.shells.values()].map((s) => ({
      id: s.id,
      pid: s.pid,
      command: s.command,
      mode: s.mode,
      status: s.status,
      exitCode: s.exitCode,
      elapsedMs: (s.endedAt ?? now) - s.startedAt,
      logPath: s.logPath,
    }));
  }

  // Spaced snapshot of live background shells. Exclude the just-announced
  // launch so reminders name only other live shells; completion/limit paths
  // exclude none.
  backgroundShellReminder(excludeId?: string): string | undefined {
    const shells: BackgroundReminderShell[] = [];
    for (const shell of this.liveShells.values()) {
      if (excludeId !== undefined && shell.id === excludeId) continue;
      if (shell.completed || shell.status !== "running") continue;
      if (shell.mode !== "background" && shell.mode !== "monitor") continue;
      // Invariant: Exit events can race backgrounding; omit children already
      // reporting exit.
      if (
        shell.child?.exitCode !== null &&
        shell.child?.exitCode !== undefined &&
        !shell.pendingExit
      )
        continue;
      if (!processGroupExists(shell)) continue;
      shells.push({
        id: shell.id,
        command: shell.command,
        status: shell.pendingExit ? "stopping" : "running",
        startedAt: shell.startedAt,
        launchSequence: shell.launchSequence,
      });
    }
    const snapshot = formatBackgroundShellReminder(shells);
    return snapshot === undefined
      ? undefined
      : this.reminders.status(
          "background-shells",
          snapshot,
          shells.map((shell) => shell.id),
        );
  }

  /** Keep a log until its output consumer finishes, including nested reads. */
  retainOutput(shell: Shell): Disposable {
    this.outputReaders.set(shell, (this.outputReaders.get(shell) ?? 0) + 1);
    let released = false;
    return {
      [Symbol.dispose]: () => {
        if (released) return;
        released = true;
        const remaining = this.outputReaders.get(shell)! - 1;
        if (remaining > 0) this.outputReaders.set(shell, remaining);
        else {
          this.outputReaders.delete(shell);
          if (shell.completed) this.evict();
        }
      },
    };
  }

  // Trim the log to the shell's line limit or override, at most 2000.
  async trimmedOutput(shell: Shell, limit?: number): Promise<string> {
    using _output = this.retainOutput(shell);
    return (
      await trimFile(shell.logPath, {
        byteBudget: this.cfg.byteBudget,
        maxLines: clampLineLimit(
          limit ?? shell.lineLimit ?? this.cfg.lineLimit,
        ),
        maxLineLen: this.cfg.maxLineLen,
        logPath: shell.logPath,
      })
    ).text;
  }

  // Track a shell immediately; waitForLaunch includes asynchronous log setup.
  // toolCallId keys publish ownership.
  run(
    command: string,
    mode: ShellMode,
    cwd: string,
    _inactivityReminderSeconds?: number,
    lineLimit?: number,
    toolCallId?: string,
  ): Shell {
    this.totalRuns++;
    // Invariant: Persist the executed hygiene-rewritten command; the caller
    // surfaces commandHygieneNote when patterns are removed.
    const hygiene = rewriteCommand(command);
    command = hygiene.command;
    const id = shortId();
    const logPath = join(this.cfg.logDir, `${slug(command)}-${id}.log`);
    const shell: Shell = {
      id,
      command,
      hygieneDropped: hygiene.dropped,
      mode,
      pid: undefined,
      pgid: undefined,
      startedAt: Date.now(),
      launchSequence: this.totalRuns,
      backgroundedAt: Date.now(),
      endedAt: undefined,
      logPath,
      status: "running",
      exitCode: null,
      signal: null,
      identity: undefined,
      bootId: undefined,
      notifyOnComplete: mode !== "foreground",
      lineLimit: clampLineLimit(lineLimit, this.cfg.lineLimit),
      child: undefined,
      fd: undefined,
      monitorTimer: undefined,
      ownershipTimer: undefined,
      pendingExit: undefined,
      monitorPending: "",
      monitorPos: 0,
      completed: false,
      recordPersisted: false,
      lastOwnershipPersistAt: 0,
      completion: undefined,
    };
    if (
      mode !== "foreground" &&
      this.liveBackgroundShellCount() >= this.liveShellCap()
    ) {
      shell.status = "error";
      shell.launchError = "live-cap";
      shell.completed = true;
      shell.endedAt = Date.now();
      return shell;
    }
    this.shells.set(id, shell);
    this.liveShells.set(id, shell);
    if (this.frozen || this.disposed) {
      shell.status = "error";
      shell.completed = true;
      shell.endedAt = Date.now();
      this.liveShells.delete(id);
      return shell;
    }

    let env: NodeJS.ProcessEnv;
    let args: string[];
    try {
      env = { ...this.inputs.environment?.() };
      // Invariant: Strip runner-owned descriptor names; undeclared fds would be
      // stale capabilities in tools and descendant processes.
      for (const name of Object.keys(env)) {
        if (name.endsWith("_FD")) delete env[name];
      }
      delete env[TOOL_CALL_ID_ENV];
      if (toolCallId && TOOL_CALL_ID.test(toolCallId))
        env[TOOL_CALL_ID_ENV] = toolCallId;
      const environmentFile =
        trustedEnvironmentFile(
          env.RECURSE_AGENT_ENV_FILE,
          env.RECURSE_AGENT_TMPDIR,
        ) ?? this.environmentFile;
      const scrubbedCommand = [
        `for _recurse_fd_path in ${OPEN_DESCRIPTORS}/*; do`,
        "  _recurse_fd=${_recurse_fd_path##*/}",
        '  case $_recurse_fd in 0|1|2) ;; *) eval "exec ${_recurse_fd}>&-" 2>/dev/null || : ;; esac',
        "done",
        "unset _recurse_fd _recurse_fd_path",
        // Invariant: Source only private per-agent scratch. This isolates
        // siblings, not this agent's own same-uid reviewed Bash injection.
        ...(environmentFile
          ? [
              `if [ -r ${shellQuote(environmentFile)} ]; then . ${shellQuote(environmentFile)}; fi`,
            ]
          : []),
        command,
      ].join("\n");
      // Invariant: Capture call-scoped arguments before asynchronous log setup.
      args = this.cfg.shellArgs(scrubbedCommand);
    } catch (error) {
      this.failLaunch(shell, error);
      return shell;
    }
    const launch = this.launch(shell, cwd, args, env);
    this.launches.set(shell, launch);
    void launch.catch((error) => this.reportError(error));
    return shell;
  }

  private failLaunch(shell: Shell, error: unknown): void {
    shell.status = "error";
    shell.launchError = "spawn";
    shell.launchErrorMessage =
      error instanceof Error ? error.message : String(error);
    shell.completed = true;
    shell.endedAt = Date.now();
    this.liveShells.delete(shell.id);
    this.reportError(error);
  }

  private async launch(
    shell: Shell,
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    await this.initialized;
    await prepareBootId();
    if (this.frozen || this.disposed || shell.completed) {
      this.abortShell(shell);
      return;
    }
    try {
      const handle = await fsPromises.open(shell.logPath, "a");
      this.descriptors.set(shell, { handle });
      shell.fd = handle.fd;
    } catch (error) {
      this.failLaunch(shell, error);
      return;
    }
    if (this.frozen || this.disposed || shell.completed) {
      this.abortShell(shell);
      await this.closeFd(shell);
      return;
    }
    let child: ChildProcess;
    try {
      child = slowSpan("shell_spawn", undefined, () =>
        spawn(this.cfg.shell, args, {
          cwd,
          detached: true,
          stdio: ["ignore", shell.fd!, shell.fd!],
          env,
        }),
      );
    } catch (error) {
      await this.closeFd(shell);
      this.failLaunch(shell, error);
      return;
    }
    shell.child = child;
    shell.pid = child.pid;
    shell.pgid = child.pid;
    // Invariant: Capture identity while the leader is alive, then persist it.
    try {
      shell.identity =
        child.pid !== undefined ? procStartTime(child.pid) : undefined;
    } catch {
      shell.identity = undefined;
    }
    shell.bootId = getBootId();
    this.persist(shell);
    child.once("error", (err) =>
      this.safe(() => this.onSpawnError(shell, err)),
    );
    child.once("exit", (code, signal) =>
      this.safe(() => this.onExit(shell, code, signal)),
    );

    if (shell.mode === "monitor") {
      this.startOwnershipHeartbeat(shell);
      this.startMonitor(shell);
    } else if (shell.mode === "background") {
      this.startOwnershipHeartbeat(shell);
    }
  }

  private async onSpawnError(shell: Shell, err: unknown): Promise<void> {
    if (shell.completed) return;
    shell.status = "error";
    await this.closeFd(shell);
    if (shell.completed) return;
    shell.launchError = "spawn";
    shell.launchErrorMessage = err instanceof Error ? err.message : String(err);
    shell.completed = true;
    shell.endedAt = Date.now();
    this.clearTimers(shell);
    this.liveShells.delete(shell.id);
    this.reportError(err);
    if (shell.notifyOnComplete) {
      const message = `Shell \`${shell.id}\` failed to start: ${shell.launchErrorMessage}`;
      const completion = await this.queueCompletion(shell, message);
      this.notify(message, true, completion);
    } else {
      await this.persist(shell);
    }
    this.evict();
  }

  // Authoritative ChildProcess exit path, not PID polling vulnerable to reuse.
  // completed makes all exit/kill races terminate exactly once.
  private onExit(
    shell: Shell,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (shell.completed) return;
    shell.pendingExit = { code, signal };
    this.closeFd(shell);
    // Invariant: No-descendant exit is O(1); surviving groups use a shared
    // async identity scan, never per-shell /proc traversal.
    if (!processGroupExists(shell)) this.safe(() => this.finishExit(shell));
    else this.startGroupPoll();
  }

  private startGroupPoll(): void {
    if (this.groupPollTimer) return;
    const epoch = this.groupPollEpoch;
    const timer = setTimeout(() => {
      if (this.groupPollTimer === timer) this.groupPollTimer = undefined;
      void processGroupSnapshotAsync().then((groups) =>
        this.safe(() => {
          if (epoch !== this.groupPollEpoch) return;
          for (const shell of this.shells.values()) {
            if (shell.pendingExit && !ownedGroupHasMembers(shell, groups))
              this.safe(() => this.finishExit(shell));
          }
          if ([...this.shells.values()].some((shell) => shell.pendingExit))
            this.startGroupPoll();
        }),
      );
    }, 50);
    timer.unref?.();
    this.groupPollTimer = timer;
  }

  private async finishExit(shell: Shell): Promise<void> {
    if (shell.completed) return;
    await this.closeFd(shell);
    if (shell.completed) return;
    const { code, signal } = shell.pendingExit ?? {
      code: shell.exitCode,
      signal: shell.signal,
    };
    shell.completed = true;
    shell.endedAt = Date.now();
    shell.exitCode = code;
    shell.signal = signal;
    if (shell.status === "running") shell.status = signal ? "killed" : "exited";
    this.clearTimers(shell);
    shell.pendingExit = undefined;
    this.liveShells.delete(shell.id);

    using _output = this.retainOutput(shell);
    if (shell.mode === "monitor") {
      await this.monitorFlushes.get(shell);
      await this.flushMonitor(shell);
    }

    if (shell.notifyOnComplete) {
      const how = signal ? `killed by ${signal}` : `exited ${code}`;
      const out = await this.trimmedOutput(shell);
      const message = `Shell \`${shell.id}\` (${middleElide(shell.command, COMMAND_CHARS_IN_MESSAGES)}) ${how} after ${fmtElapsed(
        (shell.endedAt ?? shell.startedAt) - shell.startedAt,
      )} (was pid ${shell.pid ?? "?"}, pgid ${pgidStr(shell)}).\nLog: ${shell.logPath}\n${out}`;
      const completion = await this.queueCompletion(shell, message);
      this.notify(message, true, completion);
    } else {
      await this.persist(shell);
    }
  }

  // Evict oldest completed shells/logs over the cap, never running shells.
  // Prune on-disk records on every terminal transition, even below the cap.
  private evict(): void {
    const cap = Math.max(1, this.cfg.maxTrackedShells);
    if (this.shells.size > cap) {
      const completed = [...this.shells.values()]
        .filter(
          (s) =>
            s.completed &&
            !this.outputReaders.has(s) &&
            (!this.store || !s.completion),
        )
        .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
      let over = this.shells.size - cap;
      for (const s of completed) {
        if (over <= 0) break;
        this.shells.delete(s.id);
        this.removePersist(s.id);
        try {
          // oxlint-disable-next-line no-restricted-properties -- known: main-thread shell log lifecycle filesystem operation
          fs.unlinkSync(s.logPath);
        } catch {}
        over--;
      }
    }

    this.pruneStore();
  }

  /** Best-effort on-disk prune; never throws and respects the frozen state. */
  private async pruneStore(): Promise<void> {
    if (this.store && !this.frozen) {
      try {
        await this.store.prune();
      } catch {}
    }
  }

  // Wait for log preparation and Node's spawn or failure confirmation.
  async waitForLaunch(shell: Shell, signal?: AbortSignal): Promise<void> {
    const abort = () => this.abortShell(shell);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.launches.get(shell);
      const child = shell.child;
      if (shell.status !== "running" || shell.pid !== undefined || !child)
        return;
      await new Promise<void>((resolve) => {
        const settled = () => {
          child.off("spawn", settled);
          child.off("error", settled);
          resolve();
        };
        child.once("spawn", settled);
        child.once("error", settled);
      });
    } finally {
      if (shell.status === "error") await this.closeFd(shell);
      if (signal?.aborted) abort();
      signal?.removeEventListener("abort", abort);
    }
  }

  /**
   * Await foreground completion for up to `ms`, resolving "exited" if the
   * process finished or "timeout" if it is still running.
   */
  async waitForExit(shell: Shell, ms: number): Promise<"exited" | "timeout"> {
    await this.waitForLaunch(shell);
    if (shell.completed || shell.status !== "running" || !shell.child) {
      return Promise.resolve("exited");
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: "exited" | "timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(poll);
        resolve(result);
      };
      const poll = setInterval(() => {
        if (shell.completed) done("exited");
      }, 10);
      poll.unref?.();
      const timeout = setTimeout(
        () => done(shell.completed ? "exited" : "timeout"),
        ms,
      );
      timeout.unref?.();
      if (shell.completed) done("exited");
    });
  }

  /** Transition a still-running foreground shell into background mode. */
  backgroundify(shell: Shell, _inactivityReminderSeconds?: number): boolean {
    if (shell.completed || shell.mode === "monitor") return true;
    if (!this.canBackgroundify(shell)) return false;
    if (shell.mode === "foreground") {
      // Spec: Still-running cadence starts at backgrounding, not spawn.
      shell.backgroundedAt = Date.now();
    }
    shell.mode = "background";
    shell.notifyOnComplete = true;
    this.startOwnershipHeartbeat(shell);
    // Invariant: Persist mode changes so replacement processes do not treat
    // detached shells as foreground calls.
    this.persist(shell);
    return true;
  }

  // Still-running block shared with wait timeout answers.
  async stillRunningText(shell: Shell): Promise<string> {
    using _output = this.retainOutput(shell);
    let last = "";
    try {
      last = await readLastLine(shell.logPath, this.cfg.tailWindowBytes);
    } catch {}
    return formatStillRunningShell({
      id: shell.id,
      command: shell.command,
      pid: shell.pid,
      pgid: shell.pgid,
      elapsedMs: Date.now() - shell.backgroundedAt,
      logPath: shell.logPath,
      lastLine: last
        ? truncateForNotice(last, this.cfg.maxLineLen)
        : "(no output yet)",
    });
  }

  // Live detached-shell blocks for wait timeout answers.
  async stillRunningLines(): Promise<string[]> {
    const lines: string[] = [];
    for (const shell of this.shells.values()) {
      if (shell.completed || shell.status !== "running") continue;
      if (shell.mode !== "background" && shell.mode !== "monitor") continue;
      lines.push(await this.stillRunningText(shell));
    }
    return lines;
  }

  private startOwnershipHeartbeat(shell: Shell): void {
    if (shell.ownershipTimer || shell.completed) return;
    const timer = setInterval(
      () => this.safe(() => this.refreshOwnershipRecord(shell)),
      this.cfg.ownershipHeartbeatMs,
    );
    timer.unref?.();
    shell.ownershipTimer = timer;
  }

  private startMonitor(shell: Shell): void {
    const timer = setInterval(() => {
      if (!this.monitorFlushes.has(shell))
        this.safe(() => this.flushMonitor(shell));
    }, this.cfg.monitorFlushMs);
    timer.unref?.();
    shell.monitorTimer = timer;
  }

  private flushMonitor(shell: Shell): Promise<void> {
    const pending = this.monitorFlushes.get(shell);
    if (pending) return pending;
    const reading = this.readMonitor(shell)
      .catch((error) => this.reportError(error))
      .finally(() => this.monitorFlushes.delete(shell));
    this.monitorFlushes.set(shell, reading);
    return reading;
  }

  /** Read newly-appended complete lines and deliver a bounded batch. */
  private async readMonitor(shell: Shell): Promise<void> {
    this.refreshOwnershipRecord(shell);
    const size = await fileSize(shell.logPath);
    if (size > shell.monitorPos) {
      let skippedBytes = 0;
      // Invariant: Skip huge backlogs to the newest window, dropping the
      // partial line at the byte cut.
      const backlog = size - shell.monitorPos;
      if (backlog > this.cfg.monitorMaxChunkBytes) {
        const newPos = size - this.cfg.monitorMaxChunkBytes;
        skippedBytes = newPos - shell.monitorPos;
        shell.monitorPos = newPos;
        shell.monitorPending = "";
      }
      const want = Math.min(
        size - shell.monitorPos,
        this.cfg.monitorMaxChunkBytes,
      );
      let chunk = await readRange(shell.logPath, shell.monitorPos, want);
      // Invariant: Advance by requested bytes, not decoded length; multibyte
      // boundary cuts otherwise cause drift.
      shell.monitorPos += want;
      if (skippedBytes > 0) {
        const nl = chunk.indexOf("\n");
        chunk = nl >= 0 ? chunk.slice(nl + 1) : "";
        const skipped = `… skipped ~${skippedBytes} bytes (writer outpacing monitor)`;
        this.notify(`[monitor ${shell.id}] ${skipped}`, false, undefined, {
          shellId: shell.id,
          lines: [skipped],
        });
      }
      const { lines, pending } = splitCompleteLines(
        shell.monitorPending,
        chunk,
      );
      shell.monitorPending = pending;
      // Invariant: Bound unterminated line buffers; force-emit/reset before
      // memory grows without limit.
      const pendingCap = Math.max(4096, this.cfg.maxLineLen * 4);
      if (shell.monitorPending.length > pendingCap) {
        lines.push(shell.monitorPending);
        shell.monitorPending = "";
      }
      if (lines.length > 0) {
        const trimmed = lines.map((l) =>
          truncateForNotice(l, this.cfg.maxLineLen),
        );
        const { shown, omitted } = capLines(
          trimmed,
          this.cfg.monitorMaxLinesPerFlush,
        );
        const delivered =
          omitted > 0 ? [...shown, `… ${omitted} more lines`] : shown;
        this.notify(
          `[monitor ${shell.id}]\n${delivered.join("\n")}`,
          false,
          undefined,
          {
            shellId: shell.id,
            lines: delivered,
          },
        );
      }
    }
  }

  private clearTimers(shell: Shell): void {
    if (shell.monitorTimer) {
      clearInterval(shell.monitorTimer);
      shell.monitorTimer = undefined;
    }
    if (shell.ownershipTimer) {
      clearInterval(shell.ownershipTimer);
      shell.ownershipTimer = undefined;
    }
  }

  private stopGroupPoll(): void {
    this.groupPollEpoch++;
    if (this.groupPollTimer) clearTimeout(this.groupPollTimer);
    this.groupPollTimer = undefined;
  }

  private closeFd(shell: Shell): Promise<void> {
    const descriptor = this.descriptors.get(shell);
    if (!descriptor) return Promise.resolve();
    shell.fd = undefined;
    return (descriptor.close ??= descriptor.handle.close().catch(() => {}));
  }

  // Note: there is no per-shell kill API. The agent stops a shell itself with
  // its normal bash using the pgid we surface in every message
  // (`kill -- -<pgid>`). The registry only kills groups collectively on an
  // explicit stop or shutdown so nothing is orphaned when pi goes away.
  private signalGroup(shell: Shell, sig: NodeJS.Signals): void {
    const pgid = shell.pgid;
    if (
      pgid === undefined ||
      !Number.isSafeInteger(pgid) ||
      pgid <= 1 ||
      shell.pid !== pgid
    )
      return;
    // Invariant: Never signal reused numeric groups; owned-group proof covers
    // exited leaders.
    if (!verifySignalIdentity(shell)) return;
    try {
      process.kill(-pgid, sig);
    } catch {
      // Invariant: Never fall back to a potentially recycled leader PID.
    }
  }

  /** Cancel pending launches; abort only foreground processes. */
  abortShell(shell: Shell): void {
    if (!shell.child) {
      shell.status = "error";
      shell.launchError = "spawn";
      shell.launchErrorMessage = "Command was canceled before launch.";
      shell.completed = true;
      shell.endedAt ??= Date.now();
      this.liveShells.delete(shell.id);
      return;
    }
    if (shell.mode !== "foreground") return;
    shell.notifyOnComplete = false;
    this.clearTimers(shell);
    this.signalGroup(shell, "SIGKILL");
  }

  /** Graceful shutdown: SIGTERM then SIGKILL every live group. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    // Invariant: Close the spawn race synchronously before the first await.
    this.frozen = true;
    this.shutdownPromise = this.shutdownImpl();
    return this.shutdownPromise;
  }

  private async shutdownImpl(): Promise<void> {
    const ownedGroups = processGroupSnapshot();
    const live = [...this.shells.values()].filter(
      (s) =>
        !s.completed &&
        s.status === "running" &&
        (!s.pendingExit || ownedGroupHasMembers(s, ownedGroups)),
    );
    for (const s of live) this.signalGroup(s, "SIGTERM");
    const deadline = performance.now() + this.cfg.killGraceMs;
    // Invariant: Only group absence ends grace early, never leader exit or an
    // unreadable process table. The timer keeps escalation alive for survivors.
    while (live.some(processGroupExists)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(50, remaining)));
    }
    for (const s of live) this.signalGroup(s, "SIGKILL");
    const closes = [...this.shells.values()].map((shell) =>
      this.closeFd(shell),
    );
    for (const shell of this.shells.values()) this.clearTimers(shell);
    this.stopGroupPoll();
    await Promise.allSettled([
      this.initialized,
      ...[...this.shells.values()].map((shell) => this.launches.get(shell)),
    ]);
    await Promise.all([
      ...closes,
      ...[...this.shells.values()].map((shell) => this.closeFd(shell)),
    ]);
    await this.store?.flush();
    this.disposed = true;
  }
}

/** Process-group id as a string for messages, or "?" when unknown. */
function pgidStr(shell: Shell): string {
  return shell.pgid === undefined ? "?" : String(shell.pgid);
}

/** Project a live Shell onto its persisted record. */
function toRecord(s: Shell, ownerId: string | undefined): ShellRecord {
  const status: RecordStatus =
    s.status === "running"
      ? "running"
      : s.status === "killed"
        ? "killed"
        : s.status === "error"
          ? "failed"
          : "exited";
  return {
    id: s.id,
    ownerId,
    pid: s.pid,
    pgid: s.pgid,
    command: s.command,
    mode: s.mode,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    logPath: s.logPath,
    status,
    exitCode: s.exitCode,
    signal: s.signal,
    identity: s.identity,
    bootId: s.bootId,
    completion: s.completion,
    updatedAt: Date.now(),
  };
}

/** Single-line truncation for notice lines (keeps notices compact). */
function truncateForNotice(line: string, maxLineLen: number): string {
  return trimOutput(line, {
    maxLineLen,
    byteBudget: Math.max(64, maxLineLen * 2),
  }).text;
}
