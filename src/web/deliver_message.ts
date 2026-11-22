// @tla specs/tla/send/OperatorSend.tla: Admit deduplicates before interrupt.
// One content delivery path for the composer, remote sends and API v1.
// Startup rejects admission with a retryable response before resolving ids.
import { pyStrip } from "../auth";
import { deliverRelayed, CLIENT_KEY_RE } from "../agents/supervisor/delivery";
import { pyTruthy } from "../agents/runtime";
import { HttpError } from "./router";
import type { ConversationsRoutesDeps } from "./conversations";

type Rec = Record<string, unknown>;
type Relay = { sender: string; title: string | null } | null;

export interface LiveSteerDeps {
  readonly nodes: { node(cid: string): { piStatus(): string | null } };
  liveRunId(cid: string): string | null;
}

/** Read the live run state before admitting a message. */
export function createLiveSteerCheck(deps: LiveSteerDeps) {
  const messageIsLiveSteer = (cid: string): boolean => {
    if (deps.liveRunId(cid) === null) return false;
    try {
      const status = deps.nodes.node(cid).piStatus();
      return status !== null && status !== "interrupting";
    } catch {
      return false;
    }
  };
  return messageIsLiveSteer;
}

/** Reuse the same admission, interrupt and sender rules on both HTTP routes. */
export function createMessageSender(
  deps: ConversationsRoutesDeps,
  uploadsAvailable: (cid: string, ids: string[]) => Promise<boolean>,
  messageIsLiveSteer: (cid: string) => boolean,
) {
  return async (
    cid: string,
    body: Rec,
    sender: string | null,
    relayed: Relay = null,
  ): Promise<Rec> => {
    deps.requireActionReady();
    const { store } = deps;
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404);
    const content = pyStrip(body.content as string);
    const rawIds = body.attachment_ids ?? [];
    if (
      !Array.isArray(rawIds) ||
      rawIds.length > 50_000 ||
      rawIds.some((value) => typeof value !== "string")
    )
      throw new HttpError(422, "invalid attachment references");
    const attachmentIds = [...new Set(rawIds as string[])];
    if (attachmentIds.length && !(await uploadsAvailable(cid, attachmentIds)))
      throw new HttpError(422, "attachment is unavailable");
    // Invariant: A retry with the same client key replays its first ack.
    const clientMessageId = body.client_message_id ?? null;
    if (
      clientMessageId !== null &&
      (typeof clientMessageId !== "string" ||
        !CLIENT_KEY_RE.test(clientMessageId))
    )
      throw new HttpError(422, "invalid client_message_id");
    let interrupted = false;
    const interrupt = pyTruthy(body.interrupt)
      ? {
          interrupt: true,
          onInterrupt: (stopped: boolean) => {
            interrupted = stopped;
          },
        }
      : {};
    // Invariant: Only a live named agent supplies local sender provenance.
    const send = () =>
      relayed
        ? deliverRelayed(
            deps.delivery,
            cid,
            content,
            relayed,
            clientMessageId as string | null,
            pyTruthy(body.interrupt),
          )
        : deps.delivery.deliver(
            cid,
            content,
            sender && store.load(sender) !== null
              ? {
                  start: false,
                  ...interrupt,
                  source: "spawn",
                  sender,
                  attachmentIds,
                  clientMessageId: clientMessageId as string | null,
                }
              : {
                  start: false,
                  ...interrupt,
                  origin: "operator",
                  attachmentIds,
                  clientMessageId: clientMessageId as string | null,
                },
          );
    const statusOf = () => (store.load(cid) ?? conv!).status;
    if (pyTruthy(body.interrupt)) {
      // Invariant: Serialized admission deduplicates before stopping any run.
      const mid = await send();
      if (mid === null) throw new HttpError(404);
      deps.delivery.requestRun(cid);
      return {
        ok: true,
        status: statusOf(),
        message_id: mid,
        ...(!relayed ? { interrupted } : {}),
      };
    }
    const steer = messageIsLiveSteer(cid);
    const mid = await send();
    if (mid === null) throw new HttpError(404);
    deps.delivery.requestRun(cid);
    return { ok: true, status: statusOf(), message_id: mid, steer };
  };
}
