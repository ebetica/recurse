// One tree loader/current read per backend; slow remotes never hold the home.
// Abort superseded/invalidated/removed reads; home wake only fences its read.
// Remotes check API version and back off 5–60s while unreachable.
// Report body/status changes so callers can skip redraws.
import type { TreeNode } from "../types.js";
import {
  backendFor,
  conversationId,
  homeBackend,
  parseConversationId,
  type Backend,
} from "./backend.js";

export type TreeStatus =
  | "loading"
  | "connected"
  | "unreachable"
  | "key revoked"
  | "incompatible version";

export interface TreeRead {
  /** Qualified ids in wire order, including side conversations. */
  nodes: TreeNode[];
  changed: boolean;
}

export type ApplyTree = (read: TreeRead | null) => boolean;

// A wedged mobile/background fetch stops blocking fresh reads after this bound.
const TREE_WEDGE_MS = 12_000;
let homeVersion: Promise<number> | undefined;

export class BackendTree {
  status: TreeStatus = "loading";
  private body: string | null = null;
  private generation = 0;
  private retryDelay = 0;
  private retryAt = 0;
  private inFlight: {
    controller: AbortController;
    startedAt: number;
    done: Promise<boolean>;
  } | null = null;
  private readonly pendingCreations = new Map<string, number>();

  constructor(
    private readonly backend: Backend,
    public lastContact: number | null = null,
  ) {}

  get reading(): boolean {
    return this.inFlight !== null;
  }

  /** Stale in-flight reads after backend row changes or removal. */
  invalidate(): void {
    this.generation++;
    this.inFlight?.controller.abort();
    this.inFlight = null;
  }

  /** Absence of a new row is unconfirmed until a read starts after creation. */
  noteCreation(cid: string): void {
    this.pendingCreations.set(cid, this.generation);
  }

  canConfirmAbsence(cid: string): boolean {
    return this.status === "connected" && !this.pendingCreations.has(cid);
  }

  /** Starts a read unless one is in flight; `force` supersedes it (wake). */
  refresh(apply: ApplyTree, force = false): Promise<boolean> {
    const current = this.inFlight;
    if (
      current &&
      !force &&
      performance.now() - current.startedAt < TREE_WEDGE_MS
    )
      return current.done;
    if (
      this.status === "incompatible version" ||
      (this.backend.label && Date.now() < this.retryAt)
    )
      return current?.done ?? Promise.resolve(false);
    // Invariant: A home wake supersedes the read in flight without aborting
    // it (the generation fence discards it); remote and wedged reads abort, so
    // remote requests stay within the cap in discovery.ts.
    if (!force || this.backend.label) current?.controller.abort();
    const controller = new AbortController();
    const entry = {
      controller,
      startedAt: performance.now(),
      done: Promise.resolve(false),
    };
    entry.done = this.read(controller.signal, apply).finally(() => {
      if (this.inFlight === entry) this.inFlight = null;
    });
    this.inFlight = entry;
    return entry.done;
  }

  private async read(signal: AbortSignal, apply: ApplyTree): Promise<boolean> {
    const generation = ++this.generation;
    const { label } = this.backend;
    let read: TreeRead;
    try {
      if (label && this.backend.apiVersion === null) {
        const [expected, version] = await this.versions(signal);
        if (generation !== this.generation) return false;
        this.backend.apiVersion = version;
        if (version !== expected) {
          this.status = "incompatible version";
          return apply({ nodes: [], changed: true });
        }
      }
      // Invariant: apiJson keeps the body read under the request's timeout
      // and this read's abort signal.
      const { response, data: wire } = await this.backend.apiJson<TreeNode[]>(
        "/api/tree",
        { signal },
        { availability: "core" },
      );
      if (!response.ok) throw new Error(String(response.status));
      if (generation !== this.generation) return false;
      const body = JSON.stringify(wire);
      read = {
        nodes: label
          ? wire.map((node) => ({
              ...node,
              id: conversationId(label, node.id),
              parent: node.parent ? conversationId(label, node.parent) : null,
            }))
          : wire,
        changed: body !== this.body || this.status !== "connected",
      };
      for (const [cid, afterRead] of this.pendingCreations)
        if (generation > afterRead || wire.some((node) => node.id === cid))
          this.pendingCreations.delete(cid);
      this.body = body;
    } catch {
      if (signal.aborted || generation !== this.generation) return false;
      const status =
        this.backend.connectionHealth.snapshot().phase === "auth-expired"
          ? "key revoked"
          : "unreachable";
      if (label) {
        this.retryDelay = Math.min((this.retryDelay || 2500) * 2, 60_000);
        this.retryAt = Date.now() + this.retryDelay;
      }
      if (status === this.status) return false;
      this.status = status;
      apply(null);
      return false;
    }
    this.status = "connected";
    this.lastContact = Date.now() / 1000;
    this.retryDelay = 0;
    this.retryAt = 0;
    return apply(read);
  }

  private async versions(signal: AbortSignal): Promise<[number, number]> {
    const expected = await (homeVersion ??= homeBackend
      .apiJson<{ api: number }>("/api/version", { signal })
      .then(({ data }) => (homeBackend.apiVersion = data.api))
      .catch((error: unknown) => {
        homeVersion = undefined;
        throw error;
      }));
    const { response, data } = await this.backend.apiJson<{ api: number }>(
      "/api/version",
      { signal },
      { availability: "core" },
    );
    if (!response.ok) throw new Error(String(response.status));
    return [expected, data.api];
  }
}

/** Neutral last-seen copy for intermittent remotes and homes with access. */
export function lastSeen(seconds: number | null): string {
  if (seconds === null) return "last seen never";
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  const [amount, unit] =
    elapsed < 60
      ? [elapsed, "sec"]
      : elapsed < 3600
        ? [Math.floor(elapsed / 60), "min"]
        : elapsed < 86400
          ? [Math.floor(elapsed / 3600), "hr"]
          : [Math.floor(elapsed / 86400), "day"];
  return `last seen ${amount} ${unit}${unit === "day" && Number(amount) !== 1 ? "s" : ""} ago`;
}

const trees = new WeakMap<Backend, BackendTree>();

/** The tree loader of a registered backend, created on first use. */
export function treeOf(backend: Backend, lastContact?: number | null) {
  let tree = trees.get(backend);
  if (!tree) trees.set(backend, (tree = new BackendTree(backend, lastContact)));
  return tree;
}

/** The loader owning a conversation id, or null once its backend is removed. */
export function treeFor(id: string): BackendTree | null {
  try {
    return treeOf(backendFor(id));
  } catch {
    return null;
  }
}

/** Only the owning backend's tree can establish that a row is gone. */
export function treeCanConfirmAbsence(id: string): boolean {
  return !!treeFor(id)?.canConfirmAbsence(parseConversationId(id).cid);
}
