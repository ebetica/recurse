// Resolve history bindings without creating/warming Pi; revalidate after each
// async read so reap/rebinding fails closed. Readers get plain values, not
// claims.
// Store/node/topology/binding inputs are injected to avoid Pi imports.

import { createHash } from "node:crypto";

export interface PiBinding {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
}

export type JsonObject = Record<string, unknown>;
const VIEW_METADATA_KEYS = [
  "tmp_key",
  "session_id",
  "session_file",
  "session_cwd",
];

export type BindingFactory = (
  sessionId: string,
  sessionFile: string,
  cwd: string,
) => PiBinding;
export interface HistoryNode {
  readonly reaping: boolean;
}
export interface HistoryClaimDeps {
  metadataSnapshot(cid: string): JsonObject | null;
  existing(cid: string): HistoryNode | null | undefined;
  topologyEpoch(): number;
  dataDir(): string;
  /** pi/session piBinding, with normalized paths. */
  binding: BindingFactory;
}

export interface HistoryClaim {
  readonly cid: string;
  readonly conv: JsonObject;
  readonly stamp: readonly unknown[];
  readonly epoch: number;
  readonly root: string;
  readonly node: HistoryNode | null;
  readonly binding: PiBinding | null;
}

const stampOf = (conv: JsonObject): unknown[] =>
  VIEW_METADATA_KEYS.map((key) => conv[key] ?? null);
const sameBinding = (a: PiBinding | null, b: PiBinding | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.sessionId === b.sessionId &&
    a.sessionFile === b.sessionFile &&
    a.cwd === b.cwd);
// Stamp values are JSON scalars in practice; compare by JSON like Python ==.
const sameStamp = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The recorded session binding, or null while any part is missing. */
export function viewBinding(
  conv: JsonObject,
  makeBinding: BindingFactory,
): PiBinding | null {
  const [sid, path, cwd] = VIEW_METADATA_KEYS.slice(1).map((key) => conv[key]);
  if (![sid, path, cwd].every((value) => typeof value === "string" && value))
    return null;
  return makeBinding(sid as string, path as string, cwd as string);
}

/** Resolve the recorded binding without creating or warming anything. */
export function claimHistory(
  deps: HistoryClaimDeps,
  cid: string,
): HistoryClaim | null {
  const conv = deps.metadataSnapshot(cid);
  if (conv === null) return null;
  const node = deps.existing(cid) ?? null;
  if (node !== null && node.reaping) return null;
  return Object.freeze({
    cid,
    conv,
    stamp: stampOf(conv),
    epoch: deps.topologyEpoch(),
    root: deps.dataDir(),
    node,
    binding: viewBinding(conv, deps.binding),
  });
}

/** Revalidate membership and session identity after an asynchronous read. */
export function historyAlive(
  deps: HistoryClaimDeps,
  claim: HistoryClaim,
): boolean {
  const current = deps.metadataSnapshot(claim.cid);
  const { node } = claim;
  return (
    current !== null &&
    claim.root === deps.dataDir() &&
    sameStamp(stampOf(current), claim.stamp) &&
    deps.topologyEpoch() === claim.epoch &&
    (deps.existing(claim.cid) ?? null) === node &&
    (node === null || !node.reaping) &&
    sameBinding(viewBinding(current, deps.binding), claim.binding)
  );
}

export function historyStatus(stored: unknown): { state: string } {
  const state =
    stored === "running" ? "working" : stored === "error" ? "failed" : "idle";
  return { state };
}

/** The per-session scroll fence; unbound conversations sit at zero. */
export function historyGeneration(sessionId: string): number {
  if (!sessionId) return 0;
  const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
  return 2 ** 31 + Math.floor(Number.parseInt(digest.slice(0, 8), 16) / 2);
}
