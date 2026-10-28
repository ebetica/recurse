// Cached tree rows replace atomically; failed refresh keeps the old row.
// Rebuild swaps whole maps, preserving refreshes/discards that raced its
// awaits.
// Serve does no record loads/scans; overlays derive from live in-memory rows.
import type { ConversationRecord, LiveInputs } from "./conversation_store";
import {
  type RuntimeLogger,
  WARNING,
  logException,
} from "../observability/runtime_logging";

type Conv = ConversationRecord;
export type TreeRow = Readonly<Record<string, unknown>>;

export const PERSISTED_AGENT_STATUSES: ReadonlySet<string> = new Set([
  "idle",
  "running",
  "interrupted",
  "error",
  "deleting",
]);
export const TREE_STATUSES: ReadonlySet<string> = new Set([
  ...PERSISTED_AGENT_STATUSES,
  "working",
  "waiting",
  "interrupting",
  "unknown",
]);

export const IDLE_LIVE: LiveInputs = Object.freeze({
  status: null,
  runId: null,
  muted: false,
  safetyOff: false,
  safetyOffActive: false,
  queued: 0,
  activeRunId: null,
  hasLiveShells: false,
});

function isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function pyType(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number")
    return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (Array.isArray(value)) return "list";
  return "dict";
}

function codePoints(value: string, n: number): string {
  return Array.from(value).slice(0, n).join("");
}

const FLOAT_RE =
  /^[+-]?(?:(?:\d(?:_?\d)*)?\.?(?:\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;

/** Python float() over a JSON number or string; ValueError otherwise. */
function pyFloat(value: number | string | boolean): number {
  if (typeof value !== "string") return Number(value);
  const text = value.trim();
  if (!FLOAT_RE.test(text) || !/\d|inf|nan/i.test(text))
    throw new Error(`could not convert string to float: '${value}'`);
  const lower = text.toLowerCase().replaceAll("_", "");
  if (lower.includes("nan")) return Number.NaN;
  if (lower.includes("inf"))
    return lower.startsWith("-")
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  return Number(lower);
}

/** One conversation's base (pre-overlay) tree status. */
export function projectBase(conv: Conv, live: LiveInputs): string {
  if (live.status === "interrupting") return "interrupting";
  if (live.status === "running") return "running";
  const raw = conv.status;
  if (typeof raw !== "string" || !PERSISTED_AGENT_STATUSES.has(raw))
    return "unknown";
  if (raw === "running") {
    const active = conv.active_turn;
    if (active !== undefined && active !== null && !isDict(active))
      return "unknown";
  }
  if (raw === "idle" && live.hasLiveShells) return "waiting";
  return raw;
}

function statusRecordId(c: Conv): string {
  const id = c.id;
  if (typeof id !== "string")
    throw new Error(`tree record id must be a string, got ${pyType(id)}`);
  return id;
}

// Invariant: A side conversation is no tree child: it never counts or
// overlays its parent.
function checkedParent(conv: Conv): string | null {
  if (typeof conv.side_of === "string") return null;
  const parent = conv.parent;
  if (parent === undefined || parent === null) return null;
  if (typeof parent !== "string")
    throw new Error(
      `tree parent must be a string or None, got ${pyType(parent)}`,
    );
  return parent;
}

/** The operator's take-over marker (the pin); mute never counts. */
export function isTakenOver(conv: Conv): boolean {
  return pyTruthy(conv.pinned);
}

function markAncestors(
  roots: Iterable<string>,
  parents: ReadonlyMap<string, string | null>,
  marked: Set<string>,
): void {
  for (const cid of roots) {
    let p = parents.get(cid);
    while (typeof p === "string" && !marked.has(p)) {
      marked.add(p);
      p = parents.get(p);
    }
  }
}

/** Working/waiting overlays over base statuses; taken-over agents sit out. */
export function applyOverlays(
  base: ReadonlyMap<string, string>,
  parents: ReadonlyMap<string, string | null>,
  takenOver: ReadonlySet<string>,
): Map<string, string> {
  const running = new Set<string>();
  markAncestors(
    [...base]
      .filter(
        ([cid, s]) =>
          (s === "running" || s === "interrupting") && !takenOver.has(cid),
      )
      .map(([cid]) => cid),
    parents,
    running,
  );
  const out = new Map(base);
  for (const cid of running) {
    const s = out.get(cid);
    if (!takenOver.has(cid) && (s === "idle" || s === "waiting"))
      out.set(cid, "working");
  }
  const waiting = new Set<string>();
  markAncestors(
    [...out]
      .filter(([cid, s]) => s === "waiting" && !takenOver.has(cid))
      .map(([cid]) => cid),
    parents,
    waiting,
  );
  for (const cid of waiting)
    if (out.get(cid) === "idle") out.set(cid, "waiting");
  return out;
}

/** Canonical per-node tree states over detached inputs, overlays included. */
export function projectStatuses(
  convs: readonly Conv[],
  live: Readonly<Record<string, LiveInputs>>,
): Record<string, string> {
  const ids = convs.map(statusRecordId);
  const base = new Map<string, string>();
  const parents = new Map<string, string | null>();
  const took = new Set<string>();
  ids.forEach((cid, i) =>
    base.set(cid, projectBase(convs[i], live[cid] ?? IDLE_LIVE)),
  );
  ids.forEach((cid, i) => parents.set(cid, checkedParent(convs[i])));
  ids.forEach((cid, i) => {
    if (isTakenOver(convs[i])) took.add(cid);
  });
  return Object.fromEntries(applyOverlays(base, parents, took));
}

/** One display row; `status` is the pre-overlay base. Python key order. */
export function buildRow(
  conv: Conv,
  o: {
    base: string;
    children: number;
    queued: number;
    skill: string | null;
    muted: boolean;
    safetyOff: boolean;
    safetyOffActive: boolean;
  },
): TreeRow {
  const last = conv.last;
  let preview: string;
  if (isDict(last)) {
    const raw = last.content;
    const content = pyTruthy(raw) ? raw : "";
    if (typeof content !== "string")
      throw new Error(
        `tree preview content must be a string, got ${pyType(content)}`,
      );
    preview = codePoints(content, 90).replaceAll("\n", " ");
  } else if (pyTruthy(last)) {
    throw new Error(`tree last message must be a dict, got ${pyType(last)}`);
  } else preview = "";
  const updatedRaw = "updated" in conv ? conv.updated : 0;
  if (
    typeof updatedRaw !== "number" &&
    typeof updatedRaw !== "string" &&
    typeof updatedRaw !== "boolean"
  )
    throw new TypeError(
      `tree updated must be numeric, got ${pyType(updatedRaw)}`,
    );
  const updated = pyFloat(updatedRaw);
  const status = o.base;
  const change = conv.backend_change as { reason?: unknown } | undefined;
  const rawReason =
    (status === "idle" || status === "error") &&
    typeof change?.reason === "string"
      ? change.reason
      : conv.status_reason;
  const statusReason =
    typeof rawReason === "string" ? codePoints(rawReason, 500) : null;
  if (
    (status === "running" || status === "error" || status === "idle") &&
    statusReason
  )
    preview = codePoints(statusReason, 90).replaceAll("\n", " ");
  return {
    id: conv.id,
    parent: conv.parent ?? null,
    title: pyTruthy(conv.title) ? conv.title : "New agent",
    status,
    status_reason: statusReason,
    updated,
    operator_message_at:
      typeof conv.operator_message_at === "number"
        ? conv.operator_message_at
        : null,
    children: o.children,
    queued: o.queued,
    preview,
    muted: o.muted,
    pinned: pyTruthy(conv.pinned),
    restart_parked: pyTruthy(conv.restart_parked) && status === "interrupted",
    reap_deferred: pyTruthy(conv.reap_deferred),
    reap_deferred_reason: conv.reap_deferred_reason ?? null,
    safety_off: o.safetyOff,
    safety_off_active: o.safetyOffActive,
    skill_context: o.skill,
    ...(typeof conv.side_of === "string" && { side_of: conv.side_of }),
    ...(conv.promoting === true && { promoting: true }),
    ...(typeof conv.promotion_error === "string" && {
      promotion_error: conv.promotion_error,
    }),
  };
}

export interface SkillContextSource {
  /** Installed snapshot only; never blocks (context_for_workdir_loop_safe). */
  contextForWorkdirLoopSafe(workdir: string | null): string | null;
  /** One shared render per rebuild (context_for_workdir + SkillRenderCache). */
  renderer(): (workdir: string | null) => Promise<string | null>;
}

export interface TreeViewDeps {
  skills: SkillContextSource;
  logger: RuntimeLogger;
}

export interface TreeEntryInput {
  record: Conv;
  live: LiveInputs;
  workdir: string | null;
}

export class TreeView {
  private rows = new Map<string, TreeRow>();
  private base = new Map<string, string>();
  private parent = new Map<string, string | null>();
  private takenOver = new Map<string, boolean>();

  private touched: Set<string> | null = null;

  constructor(private readonly deps: TreeViewDeps) {}

  private recomputeDerived(): void {
    const counts = new Map<string, number>();
    for (const p of this.parent.values())
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    const took = new Set(
      [...this.takenOver].filter(([, t]) => t).map(([cid]) => cid),
    );
    const final = applyOverlays(this.base, this.parent, took);
    for (const [cid, row] of this.rows) {
      const want = final.get(cid) ?? "unknown";
      const children = counts.get(cid) ?? 0;
      if (row.status !== want || row.children !== children)
        this.rows.set(cid, { ...row, status: want, children });
    }
  }

  private report(op: string, cid: string | null, error: unknown): void {
    try {
      logException(this.deps.logger, "tree_view_refresh_failed", error, {
        conversation_id: cid ?? "",
        level: WARNING,
        fields: { op },
      });
    } catch {}
  }

  /** Rebuild one agent's row from its record + live inputs. */
  refresh(entry: TreeEntryInput): TreeRow | null {
    const conv = entry.record;
    const cid = conv.id;
    if (typeof cid !== "string") return null;
    this.touched?.add(cid);
    try {
      const parent = checkedParent(conv);
      const base = projectBase(conv, entry.live);
      this.base.set(cid, base);
      this.parent.set(cid, parent);
      this.takenOver.set(cid, isTakenOver(conv));
      const skill = this.deps.skills.contextForWorkdirLoopSafe(entry.workdir);
      let children = 0;
      for (const p of this.parent.values()) if (p === cid) children += 1;
      this.rows.set(
        cid,
        buildRow(conv, {
          base,
          children,
          queued: entry.live.queued,
          skill,
          muted: entry.live.muted,
          safetyOff: entry.live.safetyOff,
          safetyOffActive: entry.live.safetyOffActive,
        }),
      );
      this.recomputeDerived();
      return this.rows.get(cid) ?? null;
    } catch (error) {
      this.report("refresh", cid, error);
      return this.rows.get(cid) ?? null;
    }
  }

  /** Drop one agent's row for good. */
  discard(cid: string): void {
    this.touched?.add(cid);
    try {
      if (
        !this.rows.has(cid) &&
        !this.base.has(cid) &&
        !this.parent.has(cid) &&
        !this.takenOver.has(cid)
      )
        return;
      this.rows.delete(cid);
      this.base.delete(cid);
      this.parent.delete(cid);
      this.takenOver.delete(cid);
      this.recomputeDerived();
    } catch (error) {
      this.report("discard", cid, error);
    }
  }

  /** Rebuild every row; the finished maps swap in one synchronous step. */
  async rebuildAll(entries: readonly TreeEntryInput[]): Promise<void> {
    const touched = new Set<string>();
    this.touched = touched;
    try {
      const render = this.deps.skills.renderer();
      const parents = new Map<string, string | null>();
      for (const e of entries)
        parents.set(statusRecordId(e.record), checkedParent(e.record));
      const counts = new Map<string, number>();
      for (const p of parents.values())
        if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
      const rows = new Map<string, TreeRow>();
      const base = new Map<string, string>();
      const taken = new Map<string, boolean>();
      for (const e of entries) {
        const cid = statusRecordId(e.record);
        const b = projectBase(e.record, e.live);
        base.set(cid, b);
        taken.set(cid, isTakenOver(e.record));
        const skill = await render(e.workdir);
        rows.set(
          cid,
          buildRow(e.record, {
            base: b,
            children: counts.get(cid) ?? 0,
            queued: e.live.queued,
            skill,
            muted: e.live.muted,
            safetyOff: e.live.safetyOff,
            safetyOffActive: e.live.safetyOffActive,
          }),
        );
      }
      for (const cid of touched) {
        const pairs: [Map<string, unknown>, Map<string, unknown>][] = [
          [rows, this.rows],
          [base, this.base],
          [parents, this.parent],
          [taken, this.takenOver],
        ];
        for (const [next, live] of pairs)
          if (live.has(cid)) next.set(cid, live.get(cid));
          else next.delete(cid);
      }
      this.rows = rows;
      this.base = base;
      this.parent = parents;
      this.takenOver = taken;
      this.recomputeDerived();
    } catch (error) {
      this.report("rebuild_all", null, error);
    } finally {
      if (this.touched === touched) this.touched = null;
    }
  }

  /** The tree payload: cached rows, newest first. Callers must not mutate. */
  serve(): TreeRow[] {
    const rows = [...this.rows.values()];
    for (const row of rows)
      if (typeof row.updated !== "number")
        throw new TypeError(
          `tree row updated must be numeric, got ${pyType(row.updated)}`,
        );
    return rows.sort((a, b) => (b.updated as number) - (a.updated as number));
  }

  clear(): void {
    this.rows.clear();
    this.base.clear();
    this.parent.clear();
    this.takenOver.clear();
  }
}
