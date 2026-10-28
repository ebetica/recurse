// Thin authenticated tree/subagent/stop routes; fail closed before readiness.
// Stop exact runs (unscoped: 422, stale: 409), never a replacement run.
// Idle stop targets owned groups. Subagent-tool routes stay loopback-only,
// except transcript reads also accept backend keys and operator sessions.

import { randomBytes } from "node:crypto";

import {
  INFO,
  logEvent,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import type { TranscriptQuery } from "../agents/durable/transcript";
import type { EnvironmentChange } from "../extensions/core/environment/managed_tools";
import { conditionalJson } from "./caching";
import { jsonDictBody } from "./login";
import { TEMP_ID_RE } from "./conversations";
import { ReviveRefused } from "../agents/supervisor/revive";
import { clientIp } from "./request_auth";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";

type Rec = Record<string, unknown>;

/** Client-supplied idempotency token for a deliver stop. */
export const STOP_ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
export const STOP_DIAGNOSTIC_EVENTS: ReadonlySet<string> = new Set([
  "capture_installed",
  "capture_seen",
  "dispatch_started",
  "request_initiated",
  "request_id_fallback",
  "request_result",
  "request_failure",
]);
export const STOP_DIAGNOSTIC_GENERATORS: ReadonlySet<string> = new Set([
  "random_uuid",
  "get_random_values",
  "fallback",
]);
export const STOP_DIAGNOSTIC_INPUTS: ReadonlySet<string> = new Set([
  "pointerdown",
  "touchstart",
  "click",
  "keyboard",
]);
export const STOP_DIAGNOSTIC_POINTERS: ReadonlySet<string> = new Set([
  "mouse",
  "touch",
  "pen",
  "unknown",
]);
export const STOP_DIAGNOSTIC_RESULTS: ReadonlySet<string> = new Set([
  "accepted",
  "rejected",
  "finished",
  "lookup_failed",
  "exception",
]);
export const STOP_DIAGNOSTIC_WINDOW = 60.0;
export const STOP_DIAGNOSTIC_MAX = 32;
const STOP_DIAGNOSTIC_IPS = 1024;
const STOP_DIAGNOSTIC_FIELDS = new Set([
  "event",
  "conversation_id",
  "run_id",
  "stop_id",
  "generation",
  "input",
  "pointer_type",
  "request_id_generator",
  "result",
  "status",
]);

/** Per-IP Stop breadcrumb budget: 32 per 60 s window, 1,024 IPs. */
export class StopDiagnosticBuckets {
  private readonly buckets = new Map<string, [number, number]>();

  constructor(private readonly now: () => number = () => Date.now() / 1000) {}

  allowed(ip: string, now = this.now()): boolean {
    const record = this.buckets.get(ip);
    if (record === undefined || now - record[0] >= STOP_DIAGNOSTIC_WINDOW) {
      if (this.buckets.size >= STOP_DIAGNOSTIC_IPS) {
        for (const [key, [started]] of [...this.buckets])
          if (now - started >= STOP_DIAGNOSTIC_WINDOW) this.buckets.delete(key);
        if (this.buckets.size >= STOP_DIAGNOSTIC_IPS && !this.buckets.has(ip))
          return false;
      }
      this.buckets.set(ip, [now, 1]);
      return true;
    }
    const [started, count] = record;
    if (count >= STOP_DIAGNOSTIC_MAX) return false;
    this.buckets.set(ip, [started, count + 1]);
    return true;
  }
}

export interface DeliverStopDeps {
  /** conversation_store.load (with pending). */
  loadConversation(cid: string): Rec | null;
  /** conversation_store.active_run_id. */
  activeRunId(conv: Rec): string | null;
  /** (status, run_id) of a live turn, else nulls. */
  liveStatus(
    cid: string,
  ):
    | readonly [string | null, string | null]
    | Promise<readonly [string | null, string | null]>;
  /** supervisor.request_stop_processes: enqueue; null keeps the rejection. */
  requestStopProcesses(
    cid: string,
    stopId: string,
    options: { expected: string | null; convStatus: string | null },
  ): Promise<Rec | null>;
  /** agent_tree.request_stop. */
  requestStop(
    cid: string,
    options: { expectedRun: string; stopId: string },
  ): Promise<boolean>;
  /** secrets.token_hex(16). */
  tokenHex(): string;
  /** time.time(). */
  nowSeconds(): number;
  readonly log: RuntimeLogger;
}

export interface TreeRoutesDeps extends DeliverStopDeps {
  /** 503 `service_storage_unavailable` + Retry-After until action-ready. */
  requireActionReady(): void;
  /** supervisor.tree. */
  tree(): Promise<unknown>;
  /** The loopback tool token on a loopback peer, for /api only. */
  loopbackAuthenticated(ex: Exchange): boolean;
  /** conversation_store.projection_ready. */
  projectionReady(): boolean;
  /** agent_nodes.node_cids. */
  nodeCids(): readonly string[];
  /** conversation_store.cli_index. */
  cliIndex(): Promise<Rec[]>;
  /** DurableHost.transcript; null for an unknown conversation. */
  transcript(cid: string, options: TranscriptQuery): Promise<Rec | null>;
  /** DurableHost.changeEnvironment; null for a non-Durable conversation. */
  changeEnvironment(
    cid: string,
    change: EnvironmentChange,
  ): Promise<
    { names: string[]; absent: string[] } | { refused: string } | null
  >;
  readonly stopDiagnostics: StopDiagnosticBuckets;
  /** The agent archive (src/agents/supervisor/revive.ts). */
  readonly revive?: {
    search(query: string, offset: number, limit: number): Promise<unknown[]>;
    revive(target: string, parent: string | null): Promise<unknown>;
    reviveFrom(path: string, parent: string | null): Promise<unknown>;
  };
}

export const defaultTokenHex = () => randomBytes(16).toString("hex");

const isRunning = (status: string | null) =>
  status === "running" || status === "interrupting";
const statusOf = (conv: Rec) =>
  (conv.status as string | null | undefined) ?? null;
const truthy = (conv: Rec | null): conv is Rec =>
  conv !== null && Object.keys(conv).length > 0;

/** Enqueue an idle-owned process stop; null keeps the caller's rejection. */
async function acceptIdleProcessStop(
  deps: DeliverStopDeps,
  cid: string,
  expected: string | null,
  stopId: unknown,
  convStatus: string | null,
): Promise<Rec | null> {
  if (
    stopId !== null &&
    stopId !== undefined &&
    (typeof stopId !== "string" || !STOP_ID_RE.test(stopId))
  )
    throw new HttpError(422, "invalid stop_id");
  const id = typeof stopId === "string" ? stopId : deps.tokenHex();
  const idle = await deps.requestStopProcesses(cid, id, {
    expected,
    convStatus,
  });
  if (idle === null) return null;
  const current = deps.loadConversation(cid) ?? {};
  const [liveStatus, liveRun] = await deps.liveStatus(cid);
  logEvent(deps.log, INFO, "stop_http_accepted", {
    conversation_id: cid,
    run_id: expected,
    fields: {
      stop_id: id,
      status: "stopped_processes",
      running: isRunning(liveStatus),
      active_run_id: liveRun || deps.activeRunId(current),
      session_id: current.session_id ?? null,
    },
  });
  return idle;
}

export interface DurableStop {
  owns(cid: string): boolean;
  stopStatus(cid: string): Promise<readonly [string | null, string | null]>;
  /** Abort exactly `expectedRun`; false when it is not the live run. */
  stop(cid: string, expectedRun: string): Promise<boolean>;
  /** Start stopping the conversation's shells; false refuses the stop. */
  stopProcesses(cid: string): Promise<boolean>;
}

/**
 * Stop deps that send a Durable conversation's stop to its host under the
 * same exact-run contract; its idle stop stops the conversation's shells.
 */
export function withDurableStop(
  deps: DeliverStopDeps,
  durable: DurableStop,
): DeliverStopDeps {
  return {
    ...deps,
    liveStatus: (cid) =>
      durable.owns(cid) ? durable.stopStatus(cid) : deps.liveStatus(cid),
    requestStopProcesses: async (cid, stopId, options) => {
      if (!durable.owns(cid))
        return deps.requestStopProcesses(cid, stopId, options);
      if (!(await durable.stopProcesses(cid))) return null;
      return {
        ok: true,
        run_id: options.expected,
        stop_id: stopId,
        status: "stopped_processes",
        updated: deps.nowSeconds(),
      };
    },
    requestStop: (cid, options) =>
      durable.owns(cid)
        ? durable.stop(cid, options.expectedRun)
        : deps.requestStop(cid, options),
  };
}

/** web/tree `_deliver_stop`: the stop branch of /deliver. */
export async function deliverStop(
  deps: DeliverStopDeps,
  cid: string,
  body: Rec | null,
): Promise<Response> {
  body = body ?? {};
  const expected = body.run_id;
  let stopId = body.stop_id;
  const observed = deps.loadConversation(cid) ?? {};

  const [liveStatus, liveRun] = await deps.liveStatus(cid);
  const context = {
    conversation_id: cid,
    run_id: typeof expected === "string" ? expected : null,
  };
  const logFields = {
    stop_id: typeof stopId === "string" ? stopId : null,
    status: liveStatus || (observed.status ?? null),
    running: isRunning(liveStatus),
    active_run_id: liveRun || deps.activeRunId(observed),
    session_id: observed.session_id ?? null,
  };
  const reject = (reason: string, status: number) =>
    logEvent(deps.log, INFO, "stop_http_rejected", {
      ...context,
      fields: { ...logFields, reason_code: reason, status_code: status },
    });
  logEvent(deps.log, INFO, "stop_http_received", {
    ...context,
    fields: logFields,
  });
  // Invariant: A missing scope still stops idle-owned processes; a running
  // conversation without a scope keeps the 422.
  if (typeof expected !== "string" || !expected) {
    let idle: Rec | null = null;
    if (truthy(observed) && !isRunning(liveStatus))
      idle = await acceptIdleProcessStop(
        deps,
        cid,
        null,
        stopId,
        statusOf(observed),
      );
    if (idle === null) {
      reject("missing_run_id", 422);
      throw new HttpError(422, "run_id is required");
    }
    return jsonResponse(idle);
  }
  if (
    stopId !== null &&
    stopId !== undefined &&
    (typeof stopId !== "string" || !STOP_ID_RE.test(stopId))
  ) {
    reject("invalid_stop_id", 422);
    throw new HttpError(422, "invalid stop_id");
  }
  // Invariant: Legacy callers get the same exact request identity as browsers.
  if (stopId === null || stopId === undefined) stopId = deps.tokenHex();
  const id = stopId as string;
  const requestedAt = deps.nowSeconds();
  if (!(await deps.requestStop(cid, { expectedRun: expected, stopId: id }))) {
    // Invariant: No live run for this scope: an idle conversation may still own
    // process groups. A running one keeps the 409 so a stale scope never
    // touches a replacement turn.
    const current = deps.loadConversation(cid) ?? {};
    const [statusNow, runNow] = await deps.liveStatus(cid);
    if (truthy(current) && !isRunning(statusNow)) {
      const idle = await acceptIdleProcessStop(
        deps,
        cid,
        expected,
        id,
        statusOf(current),
      );
      if (idle !== null) return jsonResponse(idle);
    }
    const refused = runNow === expected;
    reject(refused ? "abort_refused" : "stale_or_finished_run", 409);
    throw new HttpError(
      409,
      refused
        ? "the live turn did not stop; try again"
        : "that turn is no longer running",
    );
  }
  const current = deps.loadConversation(cid) ?? {};
  const [, runAfter] = await deps.liveStatus(cid);
  logEvent(deps.log, INFO, "stop_http_accepted", {
    conversation_id: cid,
    run_id: expected,
    fields: {
      stop_id: id,
      status: "idle",
      running: false,
      active_run_id: runAfter || deps.activeRunId(current),
      session_id: current.session_id ?? null,
    },
  });
  return jsonResponse({
    ok: true,
    run_id: expected,
    stop_id: id,
    status: "idle",
    updated: requestedAt,
  });
}

export function registerTreeRoutes(router: Router, deps: TreeRoutesDeps): void {
  router.get("/api/tree", async (ex) => {
    // Invariant: Until the startup replay applies, an empty tree would read as
    // a fresh install: refuse with the loading signal instead.
    deps.requireActionReady();
    return conditionalJson(ex.request, await deps.tree());
  });

  router.get("/api/subagent-tool/conversations", async (ex) => {
    if (!deps.loopbackAuthenticated(ex)) throw new HttpError(403);
    // Invariant: A stale projection cannot claim completeness: fail closed.
    if (!deps.projectionReady())
      throw new HttpError(503, "membership not ready");
    // Invariant: A creating child reserves its node before its row exists.
    const nodeCids = deps.nodeCids();
    const rows = await deps.cliIndex();
    const known = new Set(rows.map((row) => row.id));
    for (const cid of nodeCids) if (!known.has(cid)) rows.push({ id: cid });
    return jsonResponse({ conversations: rows, complete: true });
  });

  router.get(
    "/api/subagent-tool/conversations/{cid}/transcript",
    async (ex) => {
      if (
        !deps.loopbackAuthenticated(ex) &&
        !["backend-key", "cookie", "tailscale", "local"].includes(
          String(ex.state.auth_method),
        )
      )
        throw new HttpError(403);
      const limit = Math.min(Math.max(Number(ex.query.limit), 1), 50);
      const query = { ...ex.query, limit } as TranscriptQuery;
      const window = await deps.transcript(ex.params.cid!, query);
      if (window === null) throw new HttpError(404, "conversation not found");
      return jsonResponse(window);
    },
    {
      query: {
        limit: { type: "int", default: 20 },
        before: { type: "int" },
        after: { type: "int" },
      },
    },
  );

  // Invariant: Only the calling agent's environment overrides are exposed.
  // Responses name variables only; values never leave the server.
  const environment = async (ex: Exchange, change: EnvironmentChange) => {
    if (!deps.loopbackAuthenticated(ex)) throw new HttpError(403);
    const cid = ex.request.headers.get("x-recurse-agent");
    if (cid === null || !TEMP_ID_RE.test(cid))
      throw new HttpError(422, "x-recurse-agent must name the calling agent");
    const result = await deps.changeEnvironment(cid, change);
    if (result === null) throw new HttpError(404, "conversation not found");
    if ("refused" in result) throw new HttpError(422, result.refused);
    return jsonResponse(result);
  };
  router.get("/api/agent-environment", (ex) =>
    environment(ex, { set: {}, unset: [] }),
  );
  router.post("/api/agent-environment", async (ex) => {
    if (!deps.loopbackAuthenticated(ex)) throw new HttpError(403);
    const { set = {}, unset = [], ...rest } = await jsonDictBody(ex);
    const strings = (values: unknown) =>
      Array.isArray(values) && values.every((v) => typeof v === "string");
    const named = typeof set === "object" && set && !Array.isArray(set);
    const values = named ? Object.values(set) : [0];
    if (Object.keys(rest).length || !strings(values) || !strings(unset))
      throw new HttpError(422, "expected {set: {NAME: VALUE}, unset: [NAME]}");
    return environment(ex, {
      set: set as Record<string, string>,
      unset: unset as string[],
    });
  });

  router.get(
    "/api/agent-archive",
    async (ex) => {
      const revive = deps.revive;
      if (revive === undefined) throw new HttpError(404);
      const offset = Math.max(Number(ex.query.offset), 0);
      const limit = Math.min(Math.max(Number(ex.query.limit), 1), 50);
      const query = String(ex.query.q ?? "").slice(0, 200);
      const rows = await revive.search(query, offset, limit + 1);
      return jsonResponse({
        agents: rows.slice(0, limit),
        next_offset: rows.length > limit ? offset + limit : null,
      });
    },
    {
      query: {
        q: { type: "str", default: "" },
        offset: { type: "int", default: 0 },
        limit: { type: "int", default: 20 },
      },
    },
  );
  router.post("/api/agent-archive/revive", async (ex) => {
    deps.requireActionReady();
    const revive = deps.revive;
    if (revive === undefined) throw new HttpError(404);
    const { target, from, parent = null } = await jsonDictBody(ex);
    if (from !== undefined) {
      if (
        target !== undefined ||
        typeof from !== "string" ||
        !from.trim() ||
        from.length > 4096 ||
        from.includes("\0")
      )
        throw new HttpError(422, "pass either target or from (a source path)");
    } else if (
      typeof target !== "string" ||
      !target.trim() ||
      target.length > 200
    )
      throw new HttpError(422, "target must name an archived agent");
    if (
      parent !== null &&
      (typeof parent !== "string" || !TEMP_ID_RE.test(parent))
    )
      throw new HttpError(422, "parent must be an agent id or null");
    try {
      return jsonResponse(
        from !== undefined
          ? await revive.reviveFrom(from as string, parent)
          : await revive.revive((target as string).trim(), parent),
      );
    } catch (error) {
      if (error instanceof ReviveRefused)
        throw new HttpError(error.status, {
          message: error.message,
          candidates: error.candidates,
        });
      if (error instanceof Error && error.name === "ArchiveImportRefused")
        throw new HttpError(422, error.message);
      if (error instanceof Error && error.name === "ValueError")
        throw new HttpError(422, error.message);
      throw error;
    }
  });

  router.post("/api/stop-diagnostics", async (ex) => {
    const body = (await jsonDictBody(ex, false)) ?? {};
    if (Object.keys(body).some((key) => !STOP_DIAGNOSTIC_FIELDS.has(key)))
      throw new HttpError(422, "unsupported Stop diagnostic field");
    const event = body.event;
    if (typeof event !== "string" || !STOP_DIAGNOSTIC_EVENTS.has(event))
      throw new HttpError(422, "invalid Stop diagnostic event");
    const safeId = (name: string): string | null => {
      const value = body[name];
      if (value === undefined || value === null) return null;
      if (typeof value !== "string" || !STOP_ID_RE.test(value))
        throw new HttpError(422, `invalid Stop diagnostic ${name}`);
      return value;
    };
    const conversationId = safeId("conversation_id");
    const runId = safeId("run_id");
    const stopId = safeId("stop_id");
    const generation = safeId("generation");
    const member = (
      name: string,
      allowed: ReadonlySet<string>,
      message: string,
    ): string | null => {
      const value = body[name];
      if (value === undefined || value === null) return null;
      if (typeof value !== "string" || !allowed.has(value))
        throw new HttpError(422, message);
      return value;
    };
    const input = member(
      "input",
      STOP_DIAGNOSTIC_INPUTS,
      "invalid Stop diagnostic input",
    );
    const pointer = member(
      "pointer_type",
      STOP_DIAGNOSTIC_POINTERS,
      "invalid Stop diagnostic pointer",
    );
    const generator = member(
      "request_id_generator",
      STOP_DIAGNOSTIC_GENERATORS,
      "invalid Stop diagnostic request-id generator",
    );
    const result = member(
      "result",
      STOP_DIAGNOSTIC_RESULTS,
      "invalid Stop diagnostic result",
    );
    const status = body.status ?? null;
    if (
      status !== null &&
      (typeof status !== "number" ||
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599)
    )
      throw new HttpError(422, "invalid Stop diagnostic status");
    const empty = () => new Response(null, { status: 204 });
    if (!deps.stopDiagnostics.allowed(clientIp(ex.request.headers, ex.client)))
      return empty();
    const fields: Rec = {
      stage: event,
      stop_id: stopId,
      generation,
      input,
      pointer_type: pointer,
      result,
      status,
    };
    if (generator !== null) fields.request_id_generator = generator;
    logEvent(deps.log, INFO, "stop_ui_diagnostic", {
      conversation_id: conversationId,
      run_id: runId,
      fields,
    });
    return empty();
  });
}
