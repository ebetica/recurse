// Service principals get isolated conversations with mandatory safety review.
// HTTP validates service input and maps create refusals; reply cursors do not acknowledge delivery.

import { TreeLifecycleBusy } from "../agents/lifecycle";
import { pyTruthy } from "../agents/runtime";
import { ExternalKeyConflict, validateExternalKey } from "../agents/storage";
import {
  ServiceCreateRefusal,
  type SupervisorCreate,
} from "../agents/supervisor";
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
  readonly create: Pick<SupervisorCreate, "createOrRejoinServiceConversation">;
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
    if (
      !(await deps.serviceCreateSlots.acquire(
        SERVICE_CREATE_WAIT_SECONDS * 1000,
      ))
    )
      throw new HttpError(429, "service create is busy");
    try {
      const { conversation, created } =
        await deps.create.createOrRejoinServiceConversation({
          title: title as string | null,
          servicePrincipal: principal,
          externalKey,
          allowedModels: policy.allowed_models,
          ownedLimit: policy.quotas?.max_owned_conversations ?? null,
        });
      return {
        id: conversation.id,
        status: conversation.status,
        title: conversation.title ?? null,
        created,
      };
    } catch (error) {
      if (error instanceof ExternalKeyConflict)
        throw new HttpError(409, error.message);
      if (error instanceof TreeLifecycleBusy)
        throw new HttpError(429, "service create is busy");
      if (error instanceof ServiceCreateRefusal)
        throw error.reason === "quota_exceeded"
          ? new HttpError(429, "max_owned_conversations exceeded")
          : new HttpError(503, "service_storage_unavailable");
      if (isValueError(error))
        throw (error as Error).message === "model_not_allowed"
          ? new HttpError(403, "model_not_allowed")
          : new HttpError(422, "service conversation creation rejected");
      throw error;
    } finally {
      deps.serviceCreateSlots.release();
    }
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
