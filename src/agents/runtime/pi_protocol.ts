// Shared admission errors and the submission envelope. The Pi RPC codecs
// left with the Pi process runtime.

export type JsonObject = Record<string, any>;
export class PiRPCError extends Error {}
export class ProcessCleanupPending extends Error {
  override name = "ProcessCleanupPending";
}
export class TakenOverReapBlocked extends Error {
  override name = "TakenOverReapBlocked";
  readonly cid: string;
  constructor(cid: string, title: string | null = null) {
    super(
      `Agent ${title ? `${cid} ("${title}")` : cid} is taken over by the operator; only the operator can delete it.`,
    );
    this.cid = cid;
  }
}
const PYTHON_SPACE =
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
const strip = (text: string): string => text.replace(PYTHON_SPACE, "");
export function buildSubmission(
  content: string | string[],
  args: {
    messageId: string;
    arrivalNs: number;
    source?: string;
    sender?: string | null;
    senderTitle?: string | null;
    origin?: string | null;
    interruptId?: string | null;
    attachmentIds?: string[] | null;
    nextTurnOnly?: boolean;
  },
): JsonObject {
  const {
    messageId,
    arrivalNs,
    source = "user",
    sender,
    senderTitle,
    origin,
    interruptId,
    attachmentIds,
    nextTurnOnly,
  } = args;
  const msg: JsonObject = {
    role: "user",
    content,
    ts: arrivalNs / 1_000_000_000,
    source,
    id: messageId,
  };
  if (attachmentIds?.length)
    msg["attachment_ids"] = [...new Set(attachmentIds)];
  if (sender) {
    msg["from"] = sender;
    if (senderTitle && strip(senderTitle))
      msg["from_name"] = [...strip(senderTitle)].slice(0, 256).join("");
  }
  if (origin) msg["origin"] = origin;
  if (interruptId) msg["interrupt_id"] = interruptId;
  if (nextTurnOnly) msg["next_turn_only"] = true;
  msg["_ingress"] = {
    v: 1,
    source,
    arrived_ns: arrivalNs,
    ...(origin ? { origin } : {}),
    ...(sender ? { sender } : {}),
  };
  if (!origin)
    msg["_ingress"]["origin"] =
      sender || source === "spawn" || source === "report"
        ? "agent"
        : "platform";
  return msg;
}
