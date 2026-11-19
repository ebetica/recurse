// One tree read per backend; slow remotes never hold the home.
// Abort superseded reads; home wake only fences its read.
// Exact home snapshots revalidate; remotes check versions and back off.
// Report body/status changes so callers can skip redraws.
import type { TreeDelta, TreeUpdate } from "../../src/web/tree_protocol.js";
import type { TreeNode } from "../types.js";
import { backendFor, homeBackend, type Backend } from "./backend.js";
import {
  conversationId,
  parseConversationId,
} from "./conversation-id/index.js";

type TreeStatus =
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

type HomeSnapshot = { etag: string | null; nodes: TreeNode[] };

function applyDelta(
  snapshot: HomeSnapshot,
  delta: TreeDelta<TreeNode>,
): TreeNode[] {
  if (delta.base !== snapshot.etag) throw new Error("Wrong tree delta base");
  const rows = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const id of delta.deleted)
    if (!rows.delete(id)) throw new Error("Unknown deleted tree row");
  for (const node of delta.changed) rows.set(node.id, node);
  const order = delta.order ?? snapshot.nodes.map((node) => node.id);
  if (order.length !== rows.size || new Set(order).size !== rows.size)
    throw new Error("Invalid tree delta order");
  return order.map((id) => {
    const row = rows.get(id);
    if (!row) throw new Error("Missing tree delta row");
    return row;
  });
}

class BackendTree {
  status: TreeStatus = "loading";
  private remoteBody: string | null = null;
  private homeSnapshot: HomeSnapshot | null = null;
  private generation = 0;
  private retryDelay = 0;
  private retryAt = 0;
  private serverIncompatible = false;
  private inFlight: {
    controller: AbortController;
    startedAt: number;
    done: Promise<boolean>;
  } | null = null;
  private readonly pendingCreations = new Map<string, number>();
  /** Number of the newest applied read; reads are numbered as they start. */
  appliedRead = 0;

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

  /** A pushed change supersedes older snapshots and retries immediately. */
  refreshChanged(apply: ApplyTree): Promise<boolean> {
    this.retryAt = 0;
    this.invalidate();
    return this.refresh(apply);
  }

  /** A fresh compatible server verdict retries a direct version mismatch. */
  confirmCompatible(): void {
    if (this.status !== "incompatible version" || this.serverIncompatible)
      return;
    this.invalidate();
    this.status = "loading";
    this.retryAt = 0;
    this.backend.apiVersion = null;
  }

  /** Absence of a new row is unconfirmed until a read starts after creation. */
  noteCreation(cid: string): void {
    this.pendingCreations.set(cid, this.generation);
  }

  /** Reads started so far: a later applied read started after this call. */
  get readsStarted(): number {
    return this.generation;
  }

  canConfirmAbsence(cid: string): boolean {
    return this.status === "connected" && !this.pendingCreations.has(cid);
  }

  /** Starts a read unless one is in flight; `force` supersedes it (wake). */
  refresh(apply: ApplyTree, force = false): Promise<boolean> {
    if (this.backend.compatibility === "incompatible") {
      this.serverIncompatible = true;
      if (this.status === "incompatible version") return Promise.resolve(false);
      this.invalidate();
      this.status = "incompatible version";
      return Promise.resolve(apply({ nodes: [], changed: true }));
    }
    if (this.serverIncompatible) {
      this.serverIncompatible = false;
      this.status = "loading";
      this.retryAt = 0;
      this.backend.apiVersion = null;
    }
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
      const prior = this.homeSnapshot;
      const opts: RequestInit = { signal };
      if (!label) {
        if (prior?.etag) opts.cache = "no-store";
        opts.headers = { "x-recurse-tree-base": prior?.etag ?? "snapshot" };
      }
      // Invariant: apiJson keeps the body read under the request's timeout
      // and this read's abort signal.
      const { response, data } = await this.backend.apiJson<
        TreeNode[] | TreeUpdate<TreeNode>
      >("/api/tree", opts, { availability: "core" });
      if (generation !== this.generation) return false;
      if (!response.ok) throw new Error(String(response.status));
      let wire: TreeNode[];
      if (label) {
        if (!Array.isArray(data)) throw new Error("Invalid remote tree");
        wire = data;
        const body = JSON.stringify(wire);
        read = {
          nodes: wire.map((node) => ({
            ...node,
            id: conversationId(label, node.id),
            parent: node.parent ? conversationId(label, node.parent) : null,
            // Spec: A backend older than the taken_over rename sends
            // `pinned`; drop this one release after the rename.
            taken_over: node.taken_over ?? node.pinned,
          })),
          changed: body !== this.remoteBody,
        };
        this.remoteBody = body;
      } else {
        const etag = response.headers.get("etag");
        this.homeSnapshot = null;
        if (Array.isArray(data)) wire = data;
        else if (prior?.etag && etag && data) {
          if ("unchanged" in data) {
            if (etag !== prior.etag)
              throw new Error("Wrong unchanged tree ETag");
            wire = prior.nodes;
          } else wire = applyDelta(prior, data);
        } else throw new Error("Invalid home tree response");
        read = {
          // Invariant: UI edits must not mutate the retained wire base.
          nodes: structuredClone(wire),
          changed:
            etag && prior?.etag
              ? etag !== prior.etag
              : JSON.stringify(wire) !== JSON.stringify(prior?.nodes),
        };
        this.homeSnapshot = { etag, nodes: wire };
      }
      read.changed ||= this.status !== "connected";
      for (const [cid, afterRead] of this.pendingCreations)
        if (generation > afterRead || wire.some((node) => node.id === cid))
          this.pendingCreations.delete(cid);
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
    this.appliedRead = generation;
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
