// Record/transcript-generation/tool-detail replacement takes lifecycle lease.
// Scan-then-mutate must not race reap/restart, including in other processes.
// Worktree sweeps share the data-root inode flock; kernel waits poll async.
// Live tokens nest; queued/fenced work drains before cancellation wins.
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import {
  WARNING,
  logEvent,
  logException,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { lstatAt, mkdirAt } from "../utils/dir_fd";
import { flockExclusive, TreeLifecycleBusy } from "../utils/flock";
import { openPinnedDirectory, openPinnedLockFile } from "./fs_utils";

export { TreeLifecycleBusy };

const LOCK_NAME = ".tree-lifecycle.lock";
const SITE_RE = /^[a-z][a-z0-9_]{0,47}$/;
const TEMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Python round(value, 3): exact-value rounding, ties to even. */
export function round3(value: number): number {
  // Invariant: An exact decimal tie at 3 places is k + odd/16 (the only dyadic
  // halves); every other double rounds by its exact value, which toFixed also
  // does.
  const sixteenths = value * 16;
  if (Number.isInteger(sixteenths) && sixteenths % 2 !== 0) {
    const floor = Math.floor(value * 1000);
    return (floor % 2 === 0 ? floor : floor + 1) / 1000;
  }
  return Number(value.toFixed(3));
}
/** A Python float log field: round(value, 3) rendered with "%.3f". */
const secs = (value: number): string => round3(value).toFixed(3);
const same = (a: Stats, b: Stats): boolean =>
  a.dev === b.dev && a.ino === b.ino;

/** A snapshot's seconds as a Python float log field ("2.000", not "2"). */
const logSnapshot = (snap: HolderSnapshot): Record<string, unknown> => ({
  ...snap,
  holder_held_seconds:
    snap.holder_held_seconds === null ? null : secs(snap.holder_held_seconds),
});

export interface LeaseToken {
  readonly kind: string;
}
interface TokenState {
  live: boolean;
  spent: boolean;
}

export interface LifecycleHolder {
  readonly site: string;
  readonly conversationId: string | null;
  readonly acquired: number;
}

export interface HolderSnapshot {
  holder_site: string;
  holder_conversation: string | null;
  holder_held_seconds: number | null;
}

export interface TreeLease {
  readonly dataFd: FileHandle;
  readonly locksFd: FileHandle;
  readonly lockFd: FileHandle;
  readonly rootIdentity: readonly [number, number];
  unlock(): void;
}

export interface TreeLifecycleOptions {
  readonly dataDir: string;
  /** config.MUTE_LOCK_DIR; only its basename under dataDir is used. */
  readonly muteLockDir: string;
  readonly logger: RuntimeLogger;
  /** Monotonic seconds. */
  readonly now?: () => number;
  readonly waitReportSeconds?: number;
  readonly slowHoldSeconds?: number;
  readonly slowHoldQuietSeconds?: number;
  /** RECURSE_DATA_ROOT_WAIT_SECONDS (default 60). */
  readonly dataRootWaitSeconds?: number;
}

export class TreeLifecycle {
  private owner: LeaseToken | null = null;
  private depth = 0;
  private holder: LifecycleHolder | null = null;
  private waiters = new Set<() => void>();
  private readonly tokens = new WeakMap<LeaseToken, TokenState>();
  private readonly slowHoldReported = new Map<
    string,
    [since: number, suppressed: number, worst: number]
  >();
  readonly now: () => number;
  private readonly waitReport: number;
  private readonly slowHold: number;
  private readonly slowQuiet: number;
  readonly dataRootWaitSeconds: number;

  constructor(private readonly options: TreeLifecycleOptions) {
    this.now = options.now ?? (() => performance.now() / 1000);
    this.waitReport = options.waitReportSeconds ?? 1;
    this.slowHold = options.slowHoldSeconds ?? 1;
    this.slowQuiet = options.slowHoldQuietSeconds ?? 60;
    this.dataRootWaitSeconds = options.dataRootWaitSeconds ?? 60;
  }

  /** A fresh caller identity; `kind` appears as waiter_kind/holder_kind. */
  newToken(kind = "task"): LeaseToken {
    const token = Object.freeze({ kind });
    this.tokens.set(token, { live: false, spent: false });
    return token;
  }

  private checkToken(token: LeaseToken | undefined): LeaseToken | undefined {
    if (token === undefined) return undefined;
    if (!this.tokens.get(token)?.live || this.owner !== token)
      throw new Error("inactive lifecycle lease token");
    return token;
  }

  /** Whether `token` owns the in-process lease right now. */
  holds(token: LeaseToken | undefined): boolean {
    return token !== undefined && this.owner === token;
  }

  /** Current holder identity, for logs and tests. */
  currentHolder(): LifecycleHolder | null {
    return this.holder;
  }

  /** Claim the single in-process lease or refuse; true means nested. */
  reserve(
    token: LeaseToken,
    site = "unspecified",
    cid: string | null = null,
  ): boolean {
    if (this.owner === token) {
      this.depth += 1;
      return true;
    }
    if (this.tokens.get(token)?.spent)
      throw new Error("inactive lifecycle lease token");
    if (this.owner !== null)
      throw new TreeLifecycleBusy("tree lifecycle is busy in this process");
    this.claim(token, site, cid);
    return false;
  }

  private claim(token: LeaseToken, site: string, cid: string | null): void {
    this.owner = token;
    this.depth = 1;
    this.holder = { site, conversationId: cid, acquired: this.now() };
    const state = this.tokens.get(token);
    if (state) state.live = true;
  }

  /** Drop one level; at zero wake queued waiters and report a slow hold. */
  release(): void {
    this.depth -= 1;
    if (this.depth > 0) return;
    const state = this.owner ? this.tokens.get(this.owner) : undefined;
    if (state) {
      state.live = false;
      state.spent = true;
    }
    const released = this.holder;
    this.owner = null;
    this.depth = 0;
    this.holder = null;
    const woken = [...this.waiters];
    this.waiters.clear();
    for (const wake of woken) wake();
    if (released !== null) this.reportSlowHold(released);
  }

  holderSnapshot(holder: LifecycleHolder | null = this.holder): HolderSnapshot {
    if (holder === null)
      return {
        holder_site: "released",
        holder_conversation: null,
        holder_held_seconds: null,
      };
    return {
      holder_site: holder.site,
      holder_conversation: holder.conversationId,
      holder_held_seconds: round3(this.now() - holder.acquired),
    };
  }

  private event(
    event: string,
    cid: string | null,
    fields: Record<string, unknown>,
  ): void {
    logEvent(this.options.logger, WARNING, event, {
      conversation_id: cid,
      fields,
    });
  }

  reportWait(
    token: LeaseToken,
    waited: number,
    site = "unspecified",
    cid: string | null = null,
    blocker: HolderSnapshot | null = null,
    reportShortWait = false,
  ): void {
    if (waited < this.waitReport && !reportShortWait) return;
    this.event("tree_lifecycle_queued", cid, {
      waiter_kind: token.kind,
      waiter_site: site,
      waited_seconds: secs(waited),
      ...logSnapshot(blocker ?? this.holderSnapshot(null)),
    });
  }

  reportBusy(
    token: LeaseToken,
    waited = 0,
    site = "unspecified",
    cid: string | null = null,
  ): void {
    const holder = this.owner;
    this.event("tree_lifecycle_busy", cid, {
      holder_kind: holder ? holder.kind : "released",
      waiter_kind: token.kind,
      waiter_site: site,
      waited_seconds: secs(waited),
      ...logSnapshot(this.holderSnapshot(holder ? this.holder : null)),
    });
  }

  private reportSlowHold(holder: LifecycleHolder): void {
    const held = this.now() - holder.acquired;
    if (held < this.slowHold) return;
    const now = this.now();
    const [since, suppressed, worst] = this.slowHoldReported.get(
      holder.site,
    ) ?? [Number.NEGATIVE_INFINITY, 0, 0];
    if (now - since < this.slowQuiet) {
      this.slowHoldReported.set(holder.site, [
        since,
        suppressed + 1,
        Math.max(worst, held),
      ]);
      return;
    }
    this.slowHoldReported.set(holder.site, [now, 0, 0]);
    this.event("tree_lifecycle_slow_hold", holder.conversationId, {
      holder_site: holder.site,
      held_seconds: secs(held),
      since_last: suppressed,
      worst_suppressed_seconds: secs(Math.max(worst, held)),
    });
  }

  /** One wakeup for the next release, registered in the refusing tick. */
  private nextRelease(timeoutSeconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, timeoutSeconds * 1000));
      const waiters = this.waiters;
      function done(): void {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      }
      waiters.add(done);
    });
  }

  /** Queue behind an in-process holder; optional deadline bounds admission. */
  async awaitReservation(
    token: LeaseToken,
    site = "unspecified",
    cid: string | null = null,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<boolean> {
    const started = this.now();
    let reported = 0;
    let blocker: HolderSnapshot | null = null;
    for (;;) {
      if (this.now() >= deadline) {
        this.reportBusy(token, this.now() - started, site, cid);
        throw new TreeLifecycleBusy("tree lifecycle admission timed out");
      }
      try {
        const nested = this.reserve(token, site, cid);
        this.reportWait(
          token,
          this.now() - started,
          site,
          cid,
          blocker,
          blocker !== null && Number.isFinite(deadline),
        );
        return nested;
      } catch (error) {
        if (!(error instanceof TreeLifecycleBusy)) throw error;
      }
      const wake = this.nextRelease(
        Math.min(this.waitReport, deadline - this.now()),
      );
      const waited = this.now() - started;
      if (this.holder !== null) blocker = this.holderSnapshot();
      if (waited - reported >= this.waitReport) {
        reported = waited;
        this.reportBusy(token, waited, site, cid);
      }
      await wake;
    }
  }

  /** Open and flock the data-root lease; nonblocking refuses contention. */
  async openLease(
    nonblocking: boolean,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<TreeLease> {
    const { dataDir } = this.options;
    const lockDirName = basename(this.options.muteLockDir);
    let dataFd: FileHandle | undefined;
    let locksFd: FileHandle | undefined;
    let lockFd: FileHandle | undefined;
    let unlock: (() => void) | undefined;
    try {
      await mkdir(dataDir, { recursive: true });
      const before = await stat(dataDir);
      dataFd = await open(
        await realpath(dataDir),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const inside = await dataFd.stat();
      const after = await stat(dataDir);
      if (
        !same(before, inside) ||
        !same(after, inside) ||
        !inside.isDirectory()
      )
        throw new Error("unsafe tree-lifecycle data root");
      try {
        await mkdirAt(dataFd.fd, lockDirName, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      locksFd = await openPinnedDirectory(lockDirName, dataFd);
      lockFd = await openPinnedLockFile(LOCK_NAME, locksFd);
      const remaining = deadline - this.now();
      if (remaining <= 0)
        throw new TreeLifecycleBusy("tree lifecycle admission timed out");
      unlock = await flockExclusive(dataFd.fd, dataDir, {
        timeoutMs: nonblocking ? 0 : remaining * 1000,
        log: ({ waitMs, outcome }) => {
          if (
            waitMs / 1000 >= this.waitReport ||
            (Number.isFinite(deadline) && (waitMs >= 5 || outcome === "busy"))
          )
            this.event(
              "tree_lifecycle_lease_wait",
              this.holder?.conversationId ?? null,
              {
                waiter_site: this.holder?.site,
                holder_site: "external_process",
                waited_seconds: secs(waitMs / 1000),
                outcome,
              },
            );
        },
      });
      const visible = await lstatAt(locksFd.fd, LOCK_NAME);
      if (!same(visible, await lockFd.stat()))
        throw new Error("tree-lifecycle lock was replaced");
      return {
        dataFd,
        locksFd,
        lockFd,
        rootIdentity: [inside.dev, inside.ino],
        unlock,
      };
    } catch (error) {
      unlock?.();
      for (const fd of [lockFd, locksFd, dataFd])
        await fd?.close().catch(() => undefined);
      throw error;
    }
  }

  /** The root flock must still name the same lock domain it was taken in. */
  async verifyLease(lease: TreeLease): Promise<void> {
    const lockDirName = basename(this.options.muteLockDir);
    const visibleDir = await lstatAt(lease.dataFd.fd, lockDirName);
    const visibleLock = await lstatAt(lease.locksFd.fd, LOCK_NAME);
    const heldRoot = await lease.dataFd.stat();
    const finalRoot = await stat(this.options.dataDir);
    const [dev, ino] = lease.rootIdentity;
    if (
      !same(visibleDir, await lease.locksFd.stat()) ||
      !same(visibleLock, await lease.lockFd.stat()) ||
      heldRoot.dev !== dev ||
      heldRoot.ino !== ino ||
      finalRoot.dev !== dev ||
      finalRoot.ino !== ino
    )
      throw new Error("tree-lifecycle directory/lock changed during use");
  }

  async closeLease(lease: TreeLease): Promise<void> {
    let failure: unknown;
    try {
      await this.verifyLease(lease);
    } catch (error) {
      failure = error;
    } finally {
      lease.unlock();
      for (const fd of [lease.lockFd, lease.locksFd, lease.dataFd])
        await fd.close().catch(() => undefined);
    }
    if (failure !== undefined) throw failure;
  }

  private async body<T>(
    token: LeaseToken,
    nested: boolean,
    nonblocking: boolean,
    fn: (token: LeaseToken, lease: TreeLease | null) => Promise<T>,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<T> {
    try {
      if (nested) return await fn(token, null);
      const lease = await this.openLease(nonblocking, deadline);
      try {
        return await fn(token, lease);
      } finally {
        // Invariant: Close before releasing, so no in-process caller reaches
        // the kernel while this process still holds the flock.
        await this.closeLease(lease);
      }
    } finally {
      this.release();
    }
  }

  // Refuse/report an in-process holder instead of queueing. Kernel flock is
  // nonblocking by default; nonblocking:false polls for another process.
  async guard<T>(
    site: string,
    cid: string | null,
    fn: (token: LeaseToken, lease: TreeLease | null) => Promise<T>,
    options: { token?: LeaseToken; nonblocking?: boolean } = {},
  ): Promise<T> {
    const token = this.checkToken(options.token) ?? this.newToken();
    let nested: boolean;
    try {
      nested = this.reserve(token, site, cid);
    } catch (error) {
      if (error instanceof TreeLifecycleBusy)
        this.reportBusy(token, 0, site, cid);
      throw error;
    }
    return this.body(token, nested, options.nonblocking ?? true, fn);
  }

  /** Queue in process, then flock; timeout bounds admission only. */
  async guardAsync<T>(
    site: string,
    cid: string | null,
    fn: (token: LeaseToken, lease: TreeLease | null) => Promise<T>,
    token?: LeaseToken,
    options: { timeoutSeconds?: number } = {},
  ): Promise<T> {
    const timeout = options.timeoutSeconds ?? Number.POSITIVE_INFINITY;
    if (Number.isNaN(timeout) || timeout < 0)
      throw new RangeError("invalid lifecycle admission timeout");
    const held = this.checkToken(token) ?? this.newToken();
    const deadline = this.now() + timeout;
    const nested = await this.awaitReservation(held, site, cid, deadline);
    return this.body(held, nested, false, fn, deadline);
  }

  /** Run work as the live lease owner. */
  async withLease<T>(token: LeaseToken, fn: () => Promise<T>): Promise<T> {
    if (!this.holds(token) || !this.tokens.get(token)?.live)
      throw new Error("current task does not own lifecycle lease");
    return fn();
  }

  /**
   * Run one filesystem mutation under the lease; on failure run `rollback`
   * (its own failure is logged, never raised) and rethrow the original.
   */
  async mutateExternalStorage<A extends unknown[], T>(
    mutation: (...args: A) => T | Promise<T>,
    args: A,
    options: { rollback?: () => unknown; token?: LeaseToken } = {},
  ): Promise<T> {
    const token = this.checkToken(options.token) ?? this.newToken();
    const nested = await this.awaitReservation(
      token,
      mutationSite(mutation),
      mutationCid(args),
    );
    return this.body(token, nested, false, async () => {
      try {
        return await mutation(...args);
      } catch (error) {
        await this.runRollback(options.rollback);
        throw error;
      }
    });
  }

  private async runRollback(
    rollback: (() => unknown) | undefined,
  ): Promise<void> {
    if (rollback === undefined) return;
    try {
      await rollback();
    } catch (error) {
      logException(
        this.options.logger,
        "service_conversation_rollback_failed",
        error,
        {
          level: WARNING,
          fields: { step: "callback" },
        },
      );
    }
  }

  // Serialize the caller-owned data-root fd flock with a bounded queue.
  // Nested acquisition with the caller's live token passes false to fn.
  async dataRootFlock<T>(
    dataFd: number,
    site: string,
    cid: string | null,
    fn: (acquired: boolean) => Promise<T>,
    token?: LeaseToken,
  ): Promise<T> {
    const held = this.checkToken(token) ?? this.newToken();
    if (this.owner === held) return fn(false);
    const started = this.now();
    const blocker = this.owner !== null ? this.holderSnapshot() : null;
    const deadline = started + this.dataRootWaitSeconds;
    while (this.owner !== null) {
      const left = deadline - this.now();
      if (left <= 0) {
        const holder = this.holder;
        throw new TreeLifecycleBusy(
          `data root still held after ${this.dataRootWaitSeconds}s by ${
            holder ? holder.site : this.owner.kind
          }`,
        );
      }
      await this.nextRelease(left);
    }
    if (this.tokens.get(held)?.spent)
      throw new Error("inactive lifecycle lease token");
    this.claim(held, site, cid);
    try {
      this.reportWait(held, this.now() - started, site, cid, blocker);
      const waitedFrom = this.now();
      const unlock = await flockExclusive(dataFd, this.options.dataDir, {
        timeoutMs: Number.POSITIVE_INFINITY,
        log: () => undefined,
      });
      const waited = this.now() - waitedFrom;
      if (waited >= this.waitReport)
        this.event("data_root_flock_wait", cid, {
          waiter_site: site,
          waited_seconds: secs(waited),
        });
      try {
        return await fn(true);
      } finally {
        unlock();
      }
    } finally {
      this.release();
    }
  }

  /** Reserve the data root for a repo; a refusal is "later" (false). */
  async reserveDataRootForRepo<T>(
    dataFd: number,
    site: string,
    fn: (acquired: boolean) => Promise<T>,
  ): Promise<T> {
    const started = this.now();
    let entered = false;
    try {
      return await this.dataRootFlock(dataFd, site, null, async () => {
        entered = true;
        return fn(true);
      });
    } catch (error) {
      if (entered || !(error instanceof TreeLifecycleBusy)) throw error;
      this.event("data_root_reservation_refused", null, {
        waiter_site: site,
        waited_seconds: secs(this.now() - started),
        reason: error.message,
      });
      return fn(false);
    }
  }
}

// The work always finishes; an abort that arrives meanwhile wins.
export async function fenced<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  }
  if (signal?.aborted) throw signal.reason;
  return result;
}

/** Label a delegated mutation by its function name, for the lease log. */
export function mutationSite(mutation: { readonly name: string }): string {
  const name = mutation.name ?? "";
  return SITE_RE.test(name) ? name : "mutate_external_storage";
}

/** The conversation a mutation acts on, when its first argument is one. */
export function mutationCid(args: readonly unknown[]): string | null {
  const first = args[0];
  return typeof first === "string" && TEMP_ID_RE.test(first) ? first : null;
}

/** Retire detached tool payloads, then drain bounded trash. */
export async function cleanupRetiredToolDetails(deps: {
  retireDetached(): Promise<unknown>;
  drainTrash(options: { force: boolean }): Promise<unknown>;
}): Promise<void> {
  await fenced(() => deps.retireDetached());
  await deps.drainTrash({ force: true });
}
