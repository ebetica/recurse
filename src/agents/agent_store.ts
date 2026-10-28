// Per-agent SQLite persistence: bounded FIFO admission on the main thread;
// batches, reads and fsyncs run in four Workers. Only the main thread enqueues.
// Rejected admission never swaps projected state; flush/close/load are async.
// Nonstandard NaN JSON is corrupt; JS normalizes integral floats and key order.
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pyCompactJson } from "../utils/py_compact_json";
export { pyCompactJson } from "../utils/py_compact_json";

export const MAX_PER_AGENT_OPS = 256;
export const MAX_TOTAL_OPS = 2048;
export const MAX_OP_BYTES = 1 << 20;
export const POOL_WORKERS = 4;
const CID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const KINDS = new Set(["submission", "control", "spawn"]);

export class MailboxFull extends Error {}
export class AgentClosed extends Error {}
export class StoreError extends Error {}

export type StoreOp =
  | { kind: "save"; payload: string }
  | { kind: "intent"; payload: [string, string, string, number] }
  | { kind: "retire" | "dispatched" | "undispatched"; payload: string };
export type WorkerRequest =
  | { id: number; kind: "apply"; cid: string; path: string; batch: StoreOp[] }
  | { id: number; kind: "load"; cid: string; path: string };
export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

interface Mailbox {
  ops: StoreOp[];
  attempted: StoreOp[];
  inFlight: boolean;
  closing: boolean;
  admitted: number;
  lastError: string | null;
  failedOps: number;
  overflows: number;
  errorSeq: number;
  changed: Set<() => void>;
}
interface Job {
  request: WorkerRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
}
interface Slot {
  worker: Worker;
  job: Job | null;
}

// One active request per Worker. On a crash reject precisely that batch and
// replace the dead slot before scheduling the next request. No SQLite work runs
// on this thread.
class SqlitePool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 0;
  private stopped = false;
  constructor(
    private readonly workerUrl: string,
    private readonly createWorker: (url: string) => Worker = (url) =>
      new Worker(url),
  ) {}
  private spawn(): Slot {
    const worker = this.createWorker(this.workerUrl);
    const slot: Slot = { worker, job: null };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const job = slot.job;
      if (!job || response.id !== job.request.id) return;
      slot.job = null;
      if (response.ok) job.resolve(response.result);
      else job.reject(new Error(response.error));
      this.schedule();
    };
    const failed = (error: unknown) => {
      if (!this.slots.includes(slot)) return;
      const job = slot.job;
      slot.job = null;
      this.slots.splice(this.slots.indexOf(slot), 1);
      worker.terminate();
      job?.reject(new Error(`SQLite worker died: ${String(error)}`));
      this.schedule();
    };
    worker.onerror = failed;
    worker.addEventListener("close", () => failed("worker exited"));
    return slot;
  }
  run(request: Omit<WorkerRequest, "id">): Promise<unknown> {
    if (this.stopped)
      return Promise.reject(new Error("SQLite worker pool closed"));
    return new Promise((resolve, reject) => {
      this.queue.push({
        request: { ...request, id: ++this.nextId } as WorkerRequest,
        resolve,
        reject,
      });
      this.schedule();
    });
  }
  private schedule(): void {
    while (this.queue.length) {
      let slot = this.slots.find((entry) => !entry.job);
      if (!slot && this.slots.length < POOL_WORKERS) {
        try {
          slot = this.spawn();
          this.slots.push(slot);
        } catch (error) {
          // Invariant: Construction may fail synchronously. Retire the queued
          // job before rejecting it, or a later flush will replay this stale
          // batch twice.
          this.queue
            .shift()!
            .reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
      }
      if (!slot) return;
      const job = this.queue.shift()!;
      slot.job = job;
      try {
        slot.worker.postMessage(job.request);
      } catch (error) {
        slot.job = null;
        this.slots.splice(this.slots.indexOf(slot), 1);
        slot.worker.terminate();
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  stop(): void {
    this.stopped = true;
    for (const job of this.queue)
      job.reject(new Error("SQLite worker pool closed"));
    this.queue = [];
    for (const slot of this.slots) {
      slot.job?.reject(new Error("SQLite worker pool closed"));
      slot.worker.terminate();
    }
    this.slots = [];
  }
}

export interface StoreOptions {
  ids?: () => string;
  now?: () => number;
  // Test-only Worker module override for deterministic crash/failure injection.
  workerUrl?: string;
  // Test-only Worker constructor injection to cover synchronous spawn failure.
  workerFactory?: (url: string) => Worker;
}
export class AgentStore {
  private readonly pool: SqlitePool;
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly closed = new Set<string>();
  private totalAdmitted = 0;
  private readonly ids: () => string;
  private readonly now: () => number;
  constructor(
    readonly baseDir: string,
    options: StoreOptions = {},
  ) {
    this.ids = options.ids ?? (() => crypto.randomUUID().replaceAll("-", ""));
    this.now = options.now ?? (() => Date.now() / 1000);
    this.pool = new SqlitePool(
      options.workerUrl ??
        new URL("./agent_store_worker.ts", import.meta.url).href,
      options.workerFactory,
    );
  }
  private checkCid(cid: string): void {
    if (typeof cid !== "string" || !CID.test(cid))
      throw new TypeError(`unsafe agent id for database file: ${String(cid)}`);
  }
  dbPath(cid: string): string {
    this.checkCid(cid);
    return join(this.baseDir, `${cid}.sqlite`);
  }
  dbPaths(cid: string): string[] {
    const path = this.dbPath(cid);
    const journal = `${path}-journal`;
    return existsSync(journal) && statSync(journal).isFile()
      ? [path, journal]
      : [path];
  }
  async allAgentIds(): Promise<string[]> {
    try {
      return (await readdir(this.baseDir))
        .filter(
          (name) => name.endsWith(".sqlite") && CID.test(name.slice(0, -7)),
        )
        .map((name) => name.slice(0, -7))
        .sort();
    } catch {
      return [];
    }
  }
  private mailbox(cid: string): Mailbox {
    let box = this.mailboxes.get(cid);
    if (!box) {
      box = {
        ops: [],
        attempted: [],
        inFlight: false,
        closing: false,
        admitted: 0,
        lastError: null,
        failedOps: 0,
        overflows: 0,
        errorSeq: 0,
        changed: new Set(),
      };
      this.mailboxes.set(cid, box);
    }
    return box;
  }
  private notify(box: Mailbox): void {
    for (const callback of box.changed) callback();
  }
  private pump(cid: string, box: Mailbox): void {
    if (box.inFlight || !box.ops.length || this.closed.has(cid)) return;
    const batch = box.ops.splice(0);
    box.inFlight = true;
    box.attempted = batch;
    void this.pool
      .run({ kind: "apply", cid, path: this.dbPath(cid), batch } as Omit<
        WorkerRequest,
        "id"
      >)
      .then(
        () => this.finished(cid, box, null),
        (error: Error) =>
          this.finished(cid, box, `${error.name}: ${error.message}`),
      );
  }
  private finished(cid: string, box: Mailbox, error: string | null): void {
    const batch = box.attempted;
    box.attempted = [];
    box.inFlight = false;
    if (error) {
      box.lastError = error;
      box.failedOps += batch.length;
      box.errorSeq++;
      box.ops.unshift(...batch);
    } else {
      box.admitted -= batch.length;
      this.totalAdmitted -= batch.length;
      this.pump(cid, box);
    }
    this.notify(box);
  }
  private enqueue(cid: string, op: StoreOp): void {
    this.checkCid(cid);
    if (this.closed.has(cid))
      throw new AgentClosed(`agent mailbox is closed: '${cid}'`);
    const box = this.mailbox(cid);
    if (box.closing)
      throw new AgentClosed(`agent mailbox is closing: '${cid}'`);
    if (
      box.admitted >= MAX_PER_AGENT_OPS ||
      this.totalAdmitted >= MAX_TOTAL_OPS
    ) {
      box.overflows++;
      throw new MailboxFull(`agent store queue full for '${cid}'`);
    }
    if (op.kind === "save" && box.ops.at(-1)?.kind === "save")
      box.ops[box.ops.length - 1] = op;
    else {
      box.ops.push(op);
      box.admitted++;
      this.totalAdmitted++;
    }
    this.pump(cid, box);
  }
  private encode(value: unknown, what: string): string {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError(`${what} must be a JSON object`);
    let text: string;
    try {
      text = pyCompactJson(value);
    } catch (error) {
      throw new TypeError(`${what} must be a JSON object: ${String(error)}`);
    }
    if (Buffer.byteLength(text, "utf8") > MAX_OP_BYTES)
      throw new RangeError(`${what} exceeds ${MAX_OP_BYTES} bytes`);
    return text;
  }
  enqueueMetadata(cid: string, metadata: Record<string, unknown>): void {
    this.checkCid(cid);
    this.enqueue(cid, {
      kind: "save",
      payload: this.encode(metadata, "metadata"),
    });
  }
  submit(cid: string, kind: string, body: Record<string, unknown>): string {
    this.checkCid(cid);
    if (!KINDS.has(kind)) throw new TypeError(`unknown intent kind: '${kind}'`);
    const text = this.encode(body, "intent body");
    const id = this.ids();
    this.enqueue(cid, {
      kind: "intent",
      payload: [id, kind, text, this.now()],
    });
    return id;
  }
  private mark(
    cid: string,
    id: string,
    kind: "retire" | "dispatched" | "undispatched",
  ): void {
    this.checkCid(cid);
    if (typeof id !== "string" || !id)
      throw new TypeError("intent_id must be a non-empty string");
    this.enqueue(cid, { kind, payload: id });
  }
  retire(cid: string, id: string): void {
    this.mark(cid, id, "retire");
  }
  noteDispatched(cid: string, id: string): void {
    this.mark(cid, id, "dispatched");
  }
  noteUndispatched(cid: string, id: string): void {
    this.mark(cid, id, "undispatched");
  }
  status(cid: string): Record<string, unknown> {
    this.checkCid(cid);
    const box = this.mailboxes.get(cid);
    return {
      queued: box?.ops.length ?? 0,
      admitted: box?.admitted ?? 0,
      in_flight: box?.inFlight ?? false,
      last_error: box?.lastError ?? null,
      failed_ops: box?.failedOps ?? 0,
      overflows: box?.overflows ?? 0,
      closed: this.closed.has(cid),
    };
  }
  pendingClosures(): number {
    return this.closed.size;
  }
  async loadPersistedAgent(
    cid: string,
  ): Promise<[Record<string, unknown> | null, Record<string, unknown>[]]> {
    try {
      return (await this.pool.run({
        kind: "load",
        cid,
        path: this.dbPath(cid),
      } as Omit<WorkerRequest, "id">)) as [
        Record<string, unknown> | null,
        Record<string, unknown>[],
      ];
    } catch (error) {
      throw new StoreError(String(error));
    }
  }
  private async drain(cid: string, deadline: number): Promise<boolean> {
    const box = this.mailboxes.get(cid);
    if (!box) return true;
    const seenErrors = box.errorSeq;
    while (true) {
      if (!box.ops.length && !box.inFlight) return box.errorSeq === seenErrors;
      if (box.errorSeq !== seenErrors) return false;
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      this.pump(cid, box);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        function done() {
          clearTimeout(timer);
          box!.changed.delete(done);
          resolve();
        }
        box.changed.add(done);
      });
    }
  }
  async flush(cid: string, timeout = 10): Promise<boolean> {
    this.checkCid(cid);
    return await this.drain(cid, performance.now() + timeout * 1000);
  }
  async flushAll(timeout = 30): Promise<boolean> {
    const deadline = performance.now() + timeout * 1000;
    let clean = true;
    for (const cid of this.mailboxes.keys()) {
      if (!(await this.drain(cid, deadline))) clean = false;
      if (performance.now() >= deadline) break;
    }
    const elapsed = performance.now() - (deadline - timeout * 1000);
    if (elapsed >= 5000)
      console.warn("store_flush_all_slow", {
        agents: this.mailboxes.size,
        clean,
        elapsed_seconds: Math.round(elapsed) / 1000,
      });
    return clean;
  }
  async close(cid: string, timeout = 10): Promise<boolean> {
    this.checkCid(cid);
    const started = performance.now();
    const box = this.mailboxes.get(cid);
    const pending = box ? box.ops.length + Number(box.inFlight) : 0;
    if (box) box.closing = true;
    const clean = await this.drain(cid, started + timeout * 1000);
    if (box && (box.ops.length || box.inFlight)) {
      box.closing = false;
      return false;
    }
    this.mailboxes.delete(cid);
    this.closed.add(cid);
    const elapsed = performance.now() - started;
    if (elapsed >= 5000)
      console.warn("store_close_slow", {
        conversation_id: cid,
        pending_ops: pending,
        clean,
        elapsed_seconds: Math.round(elapsed) / 1000,
      });
    return clean;
  }
  forget(cid: string): void {
    this.checkCid(cid);
    this.closed.delete(cid);
  }
  // Tests/orderly shutdown: drain first, then tear down the private Worker
  // pool.
  async dispose(): Promise<boolean> {
    const clean = await this.flushAll(15);
    if (clean) this.pool.stop();
    return clean;
  }
}
