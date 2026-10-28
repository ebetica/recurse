// Parent reports held while their child or a local descendant works (the rule
// is in delivery.ts). Holders are open conversations only, and every way one
// stops holding rechecks all held reports (durable/README.md "Held reports").
import type { LiveRow } from "./follow.ts";

export interface HeldReporter {
  readonly caughtUp: boolean;
  kick(): Promise<void>;
}

export type Holding = "turn" | "report";

export class ReportHolds {
  private readonly reporters = new Map<string, HeldReporter>();
  private readonly held = new Set<HeldReporter>();

  constructor(
    private readonly rows: ReadonlyMap<string, LiveRow>,
    private readonly clears: ReadonlyMap<string, unknown>,
    private readonly deleting: (cid: string) => boolean,
  ) {}

  /** Count `reporter`'s unsent report as holding until `unwatch`. */
  watch(cid: string, reporter: HeldReporter): void {
    this.reporters.set(cid, reporter);
  }

  unwatch(cid: string, reporter: HeldReporter): void {
    if (this.reporters.get(cid) === reporter) this.reporters.delete(cid);
  }

  /** `reporter`'s report waits; the next release rechecks it. */
  hold(reporter: HeldReporter): void {
    this.held.add(reporter);
  }

  // Open conversations that can hold `cid`'s report: "turn" while working (a
  // run, input that will start one, or a deletion), "report" while owing one.
  // `queued`: the reporter saw `cid`'s next input before its row did. None
  // while `cid` waits for a clear, which needs its reports sent.
  holders(cid: string, queued = false): [string, Holding][] {
    if (this.clears.has(cid)) return [];
    return [...this.rows.keys()].flatMap((other) => {
      const state = this.holding(other, other === cid && queued);
      return state === null ? [] : [[other, state] as [string, Holding]];
    });
  }

  /** Whether commits show `cid` with no run and no queued Durable input. */
  settled(cid: string): boolean {
    const row = this.rows.get(cid);
    return row?.runId === undefined && !row?.queued;
  }

  // After `cid`'s Harness closed: it holds nothing now. A deletion releases at
  // its end instead (reap.ts), and a server shutdown never releases.
  closed(cid: string, stopping: boolean): void {
    if (!stopping && !this.deleting(cid)) this.release();
  }

  /** Recheck every held report, unless `cid` can still hold one. */
  release(cid?: string): void {
    if (!this.held.size) return;
    if (cid !== undefined && this.holding(cid) !== null) return;
    const held = [...this.held];
    this.held.clear();
    for (const reporter of held) void reporter.kick();
  }

  private holding(cid: string, queued = false): Holding | null {
    const row = this.rows.get(cid);
    if (row === undefined) return null;
    // Invariant: A deletion holds until its end releases (reap.ts), after the
    // parent's notice; closing its Harness releases nothing.
    if (row.runId !== undefined || this.deleting(cid)) return "turn";
    const input = queued || row.pending.length > 0;
    if (input && row.modelError === undefined) return "turn";
    return this.reporters.get(cid)?.caughtUp === false ? "report" : null;
  }
}
