// Service principals get isolated conversations with mandatory safety review.
// Bind creates under lease and roll back lost races. Reply cursors do not acknowledge delivery.

import { TreeLifecycleBusy } from "../agents/lifecycle";
import { pyTruthy } from "../agents/runtime";
import {
  ExternalKeyConflict,
  ServiceStorageUnavailable,
  validateExternalKey,
} from "../agents/storage";
import {
  CompletedReplyCursorError,
  CompletedReplyCursorExpired,
  CompletedReplyStorageUnavailable,
} from "../agents/view";
import {
  pyStrip,
  SERVICE_CREATE_MAX_ACTIVE,
  SERVICE_MESSAGE_MAX_CHARS,
  validateServicePolicy,
  type ServicePolicy,
} from "../auth";
import {
  codePoints,
  dictBody,
  isValueError,
  noStore,
  queryStr,
} from "./conversation_request";
import { createLiveSteerCheck, type LiveSteerDeps } from "./deliver_message";
import {
  serviceOwnsRequest,
  servicePrincipalOf,
  serviceRequestPolicy,
} from "./request_auth";
import { HttpError, jsonResponse, type Exchange, type Router } from "./router";

const SERVICE_CREATE_FIELDS = new Set(["title", "external_key"]);
/** Seconds a service create waits for a slot before 429. */
const SERVICE_CREATE_WAIT_SECONDS = 5;

type Rec = Record<string, unknown>;

/** asyncio.Semaphore with `wait_for(acquire(), timeout)`. */
export class CreateSlots {
  private waiters: (() => void)[] = [];
  constructor(private free = SERVICE_CREATE_MAX_ACTIVE) {}
  /** True once a slot is held; false when `timeoutMs` passed first. */
  acquire(timeoutMs: number): Promise<boolean> {
    if (this.free > 0 && !this.waiters.length) {
      this.free -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== grant);
        resolve(false);
      }, timeoutMs);
      this.waiters.push(grant);
    });
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free += 1;
  }
  get available(): number {
    return this.free;
  }
}

export interface ServiceConversationRoutesDeps extends LiveSteerDeps {
  readonly serviceCreateSlots: CreateSlots;
  readonly store: {
    load(cid: string, options?: { withPending?: boolean }): Rec | null;
  };
  lookupExternalKey(principal: string, key: string): Promise<Rec | null>;
  serviceOwnedConversationCount(principal: string): Promise<number>;
  bindServiceConversation(principal: string, cid: string): Promise<void>;
  bindExternalKey(principal: string, key: string, cid: string): Promise<void>;
  rollbackServiceConversation(conv: Rec): Promise<void>;
  /** mutation_guard.mutate_external_storage (the lifecycle lease). */
  mutateExternalStorage<T>(
    work: () => Promise<T>,
    rollback?: () => Promise<void>,
  ): Promise<T>;
  readonly delivery: {
    deliver(
      cid: string,
      content: string,
      options: { start?: boolean; origin?: string | null },
    ): Promise<string | null>;
    requestRun(cid: string): void;
  };
  readonly reads: {
    readCompletedReplies(
      cid: string,
      cursor: string | null,
      options: { wait?: unknown },
    ): Promise<Rec | null>;
  };
  readonly create: {
    createOrRejoinServiceConversation(options: {
      title: string | null;
      servicePrincipal: string;
      externalKey: string | null;
      allowedModels: readonly string[] | null;
    }): Promise<Rec>;
  };
}

export function registerServiceConversationRoutes(
  router: Router,
  deps: ServiceConversationRoutesDeps,
): void {
  const { store } = deps;
  const messageIsLiveSteer = createLiveSteerCheck(deps);

  const requireServicePrincipal = (ex: Exchange): [string, ServicePolicy] => {
    const principal = servicePrincipalOf(ex);
    const policy = serviceRequestPolicy(ex);
    if (principal === null)
      throw new HttpError(401, "service authentication required");
    if (policy === null) throw new HttpError(403, "service policy unavailable");
    return [principal, policy];
  };

  const createServiceConversation = async (
    principal: string,
    rawBody: Rec | null,
    rawPolicy: ServicePolicy,
  ): Promise<Rec> => {
    const policy = validateServicePolicy(rawPolicy);
    if (policy === null) throw new HttpError(403, "service policy unavailable");
    const body = rawBody ?? {};
    if (Object.keys(body).some((key) => !SERVICE_CREATE_FIELDS.has(key)))
      throw new HttpError(422, "unsupported service create field");
    const title = body.title ?? null;
    if (
      title !== null &&
      (typeof title !== "string" || !pyStrip(title) || codePoints(title) > 200)
    )
      throw new HttpError(422, "invalid title");
    let externalKey: string | null;
    try {
      externalKey = validateExternalKey(body.external_key ?? null);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    const ownedLimit = policy.quotas?.max_owned_conversations ?? null;
    const allowedModels = policy.allowed_models;
    let published: Rec | null = null;
    const rollbackPublished = async () => {
      if (published === null) return;
      try {
        await deps.rollbackServiceConversation(published);
      } finally {
        published = null;
      }
    };
    const checkQuota = async () => {
      if (ownedLimit === null) return;
      let owned: number;
      try {
        owned = await deps.serviceOwnedConversationCount(principal);
      } catch (error) {
        if (error instanceof ServiceStorageUnavailable)
          throw new ServiceRefusal("service_storage_unavailable");
        throw error;
      }
      if (owned >= ownedLimit) throw new ServiceRefusal("quota_exceeded");
    };
    // Invariant: Leased advisory gate before the phased create: a bound address
    // returns its conversation and an over-quota principal fails before
    // anything publishes. Both are rechecked under the bind lease below.
    const precheck = async (): Promise<Rec | null> => {
      if (externalKey) {
        const existing = await deps.lookupExternalKey(principal, externalKey);
        if (existing !== null) return { ...existing, _created: false };
      }
      await checkQuota();
      return null;
    };
    // Invariant: Authoritative address resolution under the same lease as the
    // binds: a key bound mid-flight rejoins its owner instead of conflicting.
    const bind = async (conv: Rec): Promise<Rec> => {
      if (externalKey) {
        const current = await deps.lookupExternalKey(principal, externalKey);
        if (current !== null && current.id !== conv.id) {
          await rollbackPublished();
          return { ...current, _created: false };
        }
      }
      await checkQuota();
      try {
        await deps.bindServiceConversation(principal, String(conv.id));
        if (externalKey)
          await deps.bindExternalKey(principal, externalKey, String(conv.id));
      } catch (error) {
        if (!(error instanceof ExternalKeyConflict) || !externalKey)
          throw error;
        // Invariant: Lost the bind race after the lookup: rejoin the winner, or
        // fail closed on a dangling leaf.
        const current = await deps.lookupExternalKey(principal, externalKey);
        if (current === null) throw error;
        await rollbackPublished();
        return { ...current, _created: false };
      }
      return conv;
    };
    const storage = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (isOsError(error))
          throw new ServiceRefusal("service_storage_unavailable");
        throw error;
      }
    };
    if (
      !(await deps.serviceCreateSlots.acquire(
        SERVICE_CREATE_WAIT_SECONDS * 1000,
      ))
    )
      throw new HttpError(429, "service create is busy");
    let conv: Rec;
    try {
      const existing = await storage(() =>
        deps.mutateExternalStorage(precheck),
      );
      if (existing !== null) conv = existing;
      else {
        // Invariant: Service threads are isolated top-level rows: a
        // caller-selected parent would be an IDOR path.
        conv = await storage(() =>
          deps.create.createOrRejoinServiceConversation({
            title: title as string | null,
            servicePrincipal: principal,
            externalKey,
            allowedModels: allowedModels ?? null,
          }),
        );
        if (conv._external_key_created !== false) {
          published = conv;
          const fresh = conv;
          conv = await storage(() =>
            deps.mutateExternalStorage(() => bind(fresh), rollbackPublished),
          );
        } else conv = { ...conv, _created: false };
      }
    } catch (error) {
      if (error instanceof ExternalKeyConflict)
        throw new HttpError(409, error.message);
      if (error instanceof TreeLifecycleBusy)
        throw new HttpError(429, "service create is busy");
      if (error instanceof ServiceRefusal || isValueError(error)) {
        const text = (error as Error).message;
        if (text === "model_not_allowed")
          throw new HttpError(403, "model_not_allowed");
        if (text === "quota_exceeded")
          throw new HttpError(429, "max_owned_conversations exceeded");
        if (text === "service_storage_unavailable")
          throw new HttpError(503, "service_storage_unavailable");
        throw new HttpError(422, "service conversation creation rejected");
      }
      throw error;
    } finally {
      deps.serviceCreateSlots.release();
    }
    return {
      id: conv.id,
      status: conv.status,
      title: conv.title ?? null,
      created: conv._created !== false,
    };
  };

  router.post(
    "/api/service/conversations",
    async (ex) => {
      // Invariant: FastAPI validates the body before the handler runs.
      const body = await dictBody(ex, false);
      const [principal, policy] = requireServicePrincipal(ex);
      return jsonResponse(
        await createServiceConversation(principal, body, policy),
      );
    },
    { longRunning: true },
  );

  router.get(
    "/api/service/conversations/{cid}/replies",
    async (ex) => {
      // Invariant: Service-owned completed turns with an at-least-once cursor;
      // the read never records delivery.
      requireServicePrincipal(ex);
      const cid = ex.params.cid!;
      if (!serviceOwnsRequest(ex, cid))
        throw new HttpError(404, "conversation not found");
      let page: Rec | null;
      try {
        page = await deps.reads.readCompletedReplies(
          cid,
          queryStr(ex, "after"),
          {
            wait: ex.query.wait,
          },
        );
      } catch (error) {
        if (error instanceof CompletedReplyCursorExpired)
          return jsonResponse(
            { error: { code: "cursor_expired", message: error.message } },
            410,
            noStore,
          );
        if (error instanceof CompletedReplyStorageUnavailable)
          throw new HttpError(503, "reply storage unavailable");
        if (
          error instanceof CompletedReplyCursorError ||
          isValueError(error) ||
          error instanceof RangeError
        )
          throw new HttpError(422, (error as Error).message);
        throw error;
      }
      if (page === null) throw new HttpError(404, "conversation not found");
      return jsonResponse(page, 200, noStore);
    },
    {
      query: { after: { type: "str" }, wait: { type: "float", default: 0 } },
      longRunning: true,
    },
  );

  router.post("/api/service/conversations/{cid}/messages", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const [, policy] = requireServicePrincipal(ex);
    const ownership = ex.state.service_conversation_ownership;
    if (
      !Array.isArray(ownership) ||
      ownership.length !== 2 ||
      !ownership.every((value) => typeof value === "string")
    )
      throw new HttpError(403, "service ownership unavailable");
    if (!serviceOwnsRequest(ex, cid))
      throw new HttpError(404, "conversation not found");
    const conv = store.load(cid, { withPending: false });
    if (!pyTruthy(conv)) throw new HttpError(404, "conversation not found");
    const allowed = policy.allowed_models;
    if (allowed !== null && !allowed.includes(conv!.model as string))
      throw new HttpError(403, "model_not_allowed");
    const active = (conv!.active_turn ?? {}) as Rec;
    if (pyTruthy(conv!.safety_off) || pyTruthy(active.safety_off))
      throw new HttpError(403, "service safety review is required");
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "content")
      throw new HttpError(422, "service message accepts only content");
    const raw = body.content;
    if (
      raw !== null &&
      raw !== undefined &&
      typeof raw !== "string" &&
      pyTruthy(raw)
    )
      throw new TypeError("service message content must be text");
    const content = pyTruthy(raw) ? pyStrip(raw as string) : "";
    if (!content) throw new HttpError(422, "empty message");
    if (codePoints(content) > SERVICE_MESSAGE_MAX_CHARS)
      throw new HttpError(413, "message is too large");
    const steer = messageIsLiveSteer(cid);
    const messageId = await deps.delivery.deliver(cid, content, {
      start: false,
      origin: "service",
    });
    if (messageId === null) throw new HttpError(404, "conversation not found");
    deps.delivery.requestRun(cid);
    const latest = store.load(cid, { withPending: false });
    return jsonResponse({
      ok: true,
      status: (latest ?? conv!).status,
      message_id: messageId,
      steer,
    });
  });
}

/** A named refusal inside a service create. */
class ServiceRefusal extends Error {
  override name = "ValueError";
}

const isOsError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  /^E[A-Z]+$/.test((error as { code: string }).code);
