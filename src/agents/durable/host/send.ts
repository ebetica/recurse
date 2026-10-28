// Admit and withdraw input. Sends and cancels run in order per conversation
// (DurableHost.serial); input that arrives while a clear waits is held for
// the fresh storage. Model and effort changes apply only at idle boundaries.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  AgentState,
  Conversation,
  Harness,
  SubmissionDraft,
} from "@earendil-works/pi-durable";
import type { DurableHost } from "../host.ts";
import { splitPiUserText } from "../../view/session_entries";
import { modelRef, requireModel } from "../model_selection";
import { WARNING } from "../../../observability/runtime_logging";
import { writeClear } from "./clear.ts";
import { startTitle } from "./title.ts";
import { runtime } from "./load.ts";

export interface Held {
  requestId: string;
  content: string;
  images?: readonly ImageContent[];
  note: boolean;
}

export interface SendOptions {
  note?: boolean;
  attachmentIds?: readonly string[];
  interrupt?: boolean;
}

/** One send as a submission: an input, or a note written as a user message. */
export function draft(held: Held): SubmissionDraft {
  const content = held.images?.length
    ? [{ type: "text" as const, text: held.content }, ...held.images]
    : held.content;
  return held.note
    ? {
        type: "write",
        requestId: held.requestId,
        entry: {
          kind: "recurse.note",
          model: [{ role: "user", content, timestamp: Date.now() }],
        },
      }
    : {
        type: "input",
        content,
        requestId: held.requestId,
        // Invariant: Only explicit operator input cuts model output; all other
        // origins retain boundary steering. Pi treats interrupt as steer while
        // tools run.
        whenBusy:
          splitPiUserText(held.content)[0] === "operator"
            ? "interrupt"
            : "steer",
      };
}

/**
 * Admit one input; resolves with its request id once Durable committed it,
 * or null when the conversation is being deleted.
 */
export async function send(
  host: DurableHost,
  cid: string,
  content: string,
  requestId: string,
  options: SendOptions,
): Promise<string | null> {
  if (host.deleting(cid)) return null;
  return host.serial(cid, async () => {
    const [text, images] = host.deps.uploadParts
      ? await host.deps.uploadParts(cid, content, options.attachmentIds ?? [])
      : [content, []];
    const held: Held = {
      requestId,
      content: text,
      images: images.length ? await boundImages(host, cid, images) : [],
      note: options.note === true,
    };

    const opened = await host.open(cid);
    const { conversation } = opened;
    const clear = host.clears.get(cid);
    if (clear !== undefined) {
      if (!clear.held.some((item) => item.requestId === requestId)) {
        clear.held.push(held);
        await writeClear(host, cid, clear);
        if (requestId.startsWith("op:operator:"))
          host.deps.operatorMessageAdmitted?.(cid, Date.now() / 1000);
      }
      host.deps.log("durable_send_admitted", {
        cid,
        request_id: requestId,
        held: true,
      });
      return requestId;
    }
    await host.models();
    await syncAgent(host, cid, opened.harness, conversation);
    opened.row.modelError = undefined;
    const operator = requestId.startsWith("op:operator:");
    const existing =
      operator || options.interrupt
        ? await opened.storage.submissionByRequest(
            conversation.id,
            requestId,
            context,
          )
        : undefined;
    if (options.interrupt && existing === undefined) await host.stop(cid);
    const before = host.deps.load(cid);
    const submission = await conversation.submit(draft(held), context);
    if (operator && existing === undefined) {
      if (
        before &&
        (!before.parent || before.side_of) &&
        !before.title &&
        !before.title_order &&
        !before.operator_message_at
      )
        startTitle(host, cid, opened, splitPiUserText(content)[3]);
      host.deps.operatorMessageAdmitted?.(cid, Date.now() / 1000);
    }

    host.deps.log("durable_send_admitted", {
      cid,
      request_id: requestId,
      submission: Number(submission.id),
    });
    return requestId;
  });
}

/** Uploaded images within Durable's limits; failed images are left out. */
async function boundImages(
  host: DurableHost,
  cid: string,
  images: readonly ImageContent[],
): Promise<ImageContent[]> {
  const bounded: ImageContent[] = [];
  const [{ DEFAULT_IMAGE_LIMITS }, processor] = await Promise.all([
    import("@earendil-works/pi-durable/tools"),
    host.imageService(),
  ]);
  for (const image of images) {
    const prepared = await processor
      .prepare(
        new Uint8Array(Buffer.from(image.data, "base64")),
        image.mimeType,
        DEFAULT_IMAGE_LIMITS,
      )
      .catch(() => undefined);
    if (prepared) {
      const { data, mimeType } = prepared;
      bounded.push(
        data === image.data && mimeType === image.mimeType
          ? image
          : { type: "image", data, mimeType },
      );
    } else {
      host.deps.log(
        "upload_image_failed",
        { cid, mime_type: image.mimeType },
        WARNING,
      );
    }
  }
  return bounded;
}

// Apply model/effort only at idle boundaries; steers keep the running model.
// An unknown idle model fails rather than using the previous model.
export async function syncAgent(
  host: DurableHost,
  cid: string,
  harness: Harness,
  conversation: Conversation,
): Promise<void> {
  const conv = host.deps.load(cid);
  if (conv === null) return;
  const [modelId, effort] = host.deps.settings(conv);
  const model = modelRef(modelId);
  const thinkingLevel = effort as AgentState["thinkingLevel"];
  const { AgentDoc, LiveDoc, configure } = await runtime();
  const same = (agent: AgentState | undefined) =>
    agent?.model?.provider === model.provider &&
    agent.model.modelId === model.modelId &&
    agent.thinkingLevel === thinkingLevel;
  if (same(await harness.snapshot(AgentDoc, conversation.id, context))) return;
  const models = await host.models();
  const unknown = await conversation.commit(async (tx) => {
    if ((await tx.doc(LiveDoc, conversation.id)).run !== undefined) return;
    if (same(await tx.doc(AgentDoc, conversation.id))) return;
    if (!models.getModel(model.provider, model.modelId)) return true;
    await configure(tx, conversation.id, { model, thinkingLevel });
    return false;
  }, context);
  if (unknown) requireModel(models, model);
}

/**
 * Withdraw one queued input by its request id (also one held by a clear).
 * False when it already reached the transcript or does not exist.
 */
export function cancel(
  host: DurableHost,
  cid: string,
  requestId: string,
): Promise<boolean> {
  return host.serial(cid, async () => {
    await host.open(cid);
    // Invariant: Held input is withdrawn from the list until the old storage
    // is retired; from then on the fresh storage receives it, and it is
    // withdrawn there.
    const clear = host.clears.get(cid);
    const at = clear?.held.findIndex((item) => item.requestId === requestId);
    if (clear !== undefined && !clear.rotated && at !== undefined && at >= 0) {
      clear.held.splice(at, 1);
      await writeClear(host, cid, clear);
      return true;
    }
    const { harness, conversation, storage } = await host.open(cid);
    const record = await storage.submissionByRequest(
      conversation.id,
      requestId,
      context,
    );
    if (record?.type !== "input") return false;
    return (
      (await harness.abortSubmission(record.id, context, conversation.id)) ===
      "aborted"
    );
  });
}
