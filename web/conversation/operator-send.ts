// Foreground operator messages start here so enqueueing always applies the
// open thread's send-scroll behaviour. Delivery retries and restored outbox
// entries use the transport directly, without starting another viewport jump.
import { backendFor } from "../backends/backend.js";
import { state } from "../state.js";
import { holdQueuedSend, pinOperatorSend } from "./thread.js";

type DeliveryOptions = Parameters<ReturnType<typeof backendFor>["jpost"]>[2];
interface OperatorMessage {
  content: string;
  client_message_id?: string;
  attachment_ids?: string[];
}

/** Start foreground work only after applying the recipient's scroll policy. */
export function startOperatorSend<T>(
  recipient: string | null,
  enqueue: () => T,
): T {
  const conv = state.currentConv;
  if (recipient && conv?.id === recipient) {
    if (["running", "interrupting"].includes(conv.status))
      holdQueuedSend(recipient);
    else pinOperatorSend(recipient);
  }
  return enqueue();
}

/** Deliver a new foreground message without a browser-side outbox. */
export function sendOperatorMessage(
  recipient: string,
  body: OperatorMessage,
  options?: DeliveryOptions,
): Promise<Response> {
  return startOperatorSend(recipient, () =>
    deliverQueuedOperatorMessage(recipient, body, options),
  );
}

/** Transport for existing composer jobs and persisted comment attempts only. */
export function deliverQueuedOperatorMessage(
  recipient: string,
  body: OperatorMessage,
  options?: DeliveryOptions,
): Promise<Response> {
  return backendFor(recipient).api(
    `/api/conversations/${recipient}/deliver`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(options?.timeoutMs
        ? { signal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
    },
    options,
  );
}

/** Stop is not an operator message and must never change thread scrolling. */
export function deliverStop(
  recipient: string,
  body: { stop_id: string; run_id?: string },
): Promise<Response> {
  return backendFor(recipient).jpost(
    `/api/conversations/${recipient}/deliver`,
    body,
    { availability: "core" },
  );
}
