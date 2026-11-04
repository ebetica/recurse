// Signed-in Codex models always compact on the server into encrypted items.
// Items match a retained-history marker, model and account; capture shows the
// item as a block. Unusable or rejected items fall back lazily on the next
// request, without retrying a rejected generation.
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type {
  AssistantMessage,
  Message,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import {
  type Agent,
  AgentDoc,
  type Conversation,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  type HookApi,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { accountId } from "../../../auth/codex.ts";
import {
  readableCompactionMessages,
  type ProviderCompaction,
} from "../../core/context/durable-compaction.ts";

export const CODEX_PROVIDER = "openai-codex";
const OPEN = "<codex-compaction-item>";
const CLOSE = "</codex-compaction-item>";
const REJECTED = /encrypted content for item (\S+) could not be verified/i;

type Item = { type: "compaction"; encrypted_content: string; id: string };
type Rec = Record<string, unknown>;
const record = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Checkpoint = {
  summaryHash: string;
  model: string;
  account: string;
  item: Item;
};

/** The last two items by summary hash; an unplaced compaction keeps one. */
export const CodexCheckpointDoc = defineDoc<{ saved: Checkpoint[] }>({
  kind: "recurse.codex-checkpoint",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ saved: [] }),
  checkpointWhen: () => false,
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** The signed-in ChatGPT account, hashed; never the token itself. */
async function accountKey(models: Models): Promise<string | undefined> {
  const auth = await models.getAuth(CODEX_PROVIDER).catch(() => undefined);
  const id = accountId(auth?.auth.apiKey);
  return id ? hash(id) : undefined;
}

function textOf(message: Message | undefined): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: Rec) => (block.type === "text" ? String(block.text) : ""))
    .join("\n");
}

/** The hash of the summary a wrapped compaction message carries. */
function summaryHash(text: string): string | undefined {
  const open = text.indexOf("<summary>\n");
  const close = text.lastIndexOf("\n</summary>");
  return open >= 0 && close > open
    ? hash(text.slice(open + "<summary>\n".length, close))
    : undefined;
}

/** Add the saved item to the head summary message when it applies. */
export function withCheckpoint(
  messages: readonly Message[],
  saved: readonly Checkpoint[] | undefined,
  model: string,
  account: string | undefined,
): readonly Message[] {
  const at = messages.findIndex((message) => message.role === "user");
  const head = messages[at];
  if (head?.role !== "user") return messages;
  const hashed = summaryHash(textOf(head));
  const doc = saved?.find(
    (entry) =>
      entry.summaryHash === hashed &&
      entry.model === model &&
      entry.account === account,
  );
  if (!doc) return messages;
  const content =
    typeof head.content === "string"
      ? [{ type: "text" as const, text: head.content }]
      : head.content;
  const block = `${OPEN}${JSON.stringify(doc.item)}${CLOSE}`;
  const next = [...messages];
  next[at] = { ...head, content: [...content, { type: "text", text: block }] };
  return next;
}

function toItem(item: unknown): Item | undefined {
  if (!record(item) || item.type !== "compaction") return undefined;
  if (typeof item.encrypted_content !== "string") return undefined;
  // Invariant: a rejection names the id; an item without one is not saved.
  if (typeof item.id !== "string") return undefined;
  return {
    type: "compaction",
    encrypted_content: item.encrypted_content,
    id: item.id,
  };
}

function itemIn(content: unknown): Item | undefined {
  const text = Array.isArray(content) ? content.at(-1)?.text : undefined;
  if (typeof text !== "string" || !text.startsWith(OPEN)) return undefined;
  if (!text.endsWith(CLOSE)) return undefined;
  try {
    return toItem(JSON.parse(text.slice(OPEN.length, -CLOSE.length)));
  } catch {
    return undefined;
  }
}

/** Send each marked summary message as its compaction item (Codex body). */
export function sendCheckpointItems(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.input)) return payload;
  let changed = false;
  const input = payload.input.map((entry: unknown) => {
    const item =
      record(entry) && entry.role === "user"
        ? itemIn(entry.content)
        : undefined;
    changed ||= item !== undefined;
    return item ?? entry;
  });
  return changed ? { ...payload, input } : payload;
}

/** Drop item blocks from a request to any other provider. */
export function withoutCheckpointItems(messages: Message[]): Message[] {
  if (!messages.some((m) => m.role === "user" && itemIn(m.content)))
    return messages;
  return messages.map((message) =>
    message.role === "user" && itemIn(message.content)
      ? { ...message, content: (message.content as unknown[]).slice(0, -1) }
      : message,
  ) as Message[];
}

/** The single compaction item of a Codex SSE reply, or an error. */
function compactionItem(sse: string): Item {
  const items: Item[] = [];
  let completed = false;
  for (const frame of sse.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data || data === "[DONE]") continue;
    const event: unknown = JSON.parse(data);
    if (!record(event)) continue;
    if (event.type === "response.output_item.done") {
      const found = toItem(event.item);
      if (found) items.push(found);
    }
    if (event.type === "response.completed") completed = true;
  }
  if (!completed) throw new Error("Codex compaction reply did not complete");
  if (items.length !== 1)
    throw new Error(`Codex compaction returned ${items.length} items`);
  return items[0]!;
}

/** Codex's compaction of `messages`, for a Codex agent; undefined otherwise.
 * `prepare` applies the turn requests' model-bound steps, so the cached prefix
 * matches. */
export async function requestCodexCompaction(
  models: Models,
  prepare: (messages: readonly Message[]) => Message[],
  messages: readonly Message[],
  agent: Agent,
  api: HookApi,
  context: Context,
  conversation: Conversation,
): Promise<ProviderCompaction | undefined> {
  const ref = agent.model;
  if (ref?.provider !== CODEX_PROVIDER) return undefined;
  const model = models.getModel(ref.provider, ref.modelId);
  const account = await accountKey(models);
  if (!model || !account) return undefined;
  const [saved, provider] = await Promise.all([
    api.snapshot(CodexCheckpointDoc, api.conversationId, context),
    api.snapshot(ProviderDoc, api.conversationId, context),
  ]);
  const prepared = prepare(messages);
  const marked = withCheckpoint(prepared, saved?.saved, ref.modelId, account);
  const history =
    marked === prepared
      ? await readableCompactionMessages(
          models,
          conversation,
          prepared,
          agent,
          context,
        )
      : marked;
  let reply: Promise<string> | undefined;
  const message: AssistantMessage = await models.completeSimple(
    model,
    {
      messages: [...history],
    },
    {
      transport: "sse",
      signal: context.abortSignal,
      headers: { "x-codex-beta-features": "remote_compaction_v2" },
      ...(provider ? { sessionId: provider.sessionId } : {}),
      ...(agent.thinkingLevel === "off"
        ? {}
        : { reasoning: agent.thinkingLevel }),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        reply = response.clone().text();
        // Invariant: a dropped stream also fails this copy; never leave it
        // unhandled, or the process exits.
        reply.catch(() => undefined);
        return response;
      },
      onPayload: (payload: unknown) => {
        const body = sendCheckpointItems(payload) as Rec;
        const input = Array.isArray(body.input) ? body.input : [];
        return { ...body, input: [...input, { type: "compaction_trigger" }] };
      },
    } as Parameters<Models["completeSimple"]>[2],
  );
  if (message.stopReason !== "stop")
    throw new Error(
      message.errorMessage ?? `Codex compaction ${message.stopReason}`,
    );
  if (reply === undefined) throw new Error("Codex compaction sent no request");
  const item = compactionItem(await reply);
  return {
    usage: message.usage,
    model: model as Model<never>,
    save: async (tx, conversationId, summary) => {
      const doc = await tx.doc(CodexCheckpointDoc, conversationId);
      const summaryHash = hash(summary);
      doc.saved = [
        ...(doc.saved ?? []).filter(
          (entry) => entry.summaryHash !== summaryHash,
        ),
        { summaryHash, model: ref.modelId, account, item },
      ].slice(-2);
    },
  };
}

export interface CodexCheckpointHost {
  models: Models;
  conversation(context: Context, id: Conversation["id"]): Promise<Conversation>;
  report(event: string, error: unknown): void;
}

/** Send saved items on Codex requests; drop an item Codex rejects. */
export function createCodexCheckpoints(host: CodexCheckpointHost) {
  return defineExtension({
    name: "recurse-codex-checkpoints",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const agent = await api.snapshot(
            AgentDoc,
            api.conversationId,
            context,
          );
          const ref = agent?.model;
          if (!agent) return undefined;
          const doc = await api.snapshot(
            CodexCheckpointDoc,
            api.conversationId,
            context,
          );
          const account = await accountKey(api.models);
          const marked =
            ref?.provider === CODEX_PROVIDER
              ? withCheckpoint(messages, doc?.saved, ref.modelId, account)
              : messages;
          return {
            messages:
              marked !== messages
                ? [...marked]
                : await readableCompactionMessages(
                    host.models,
                    await host.conversation(context, api.conversationId),
                    messages,
                    agent,
                    context,
                  ),
          };
        },
        afterResponse: async (message, api, context) => {
          if (message.stopReason !== "error") return;
          const id = REJECTED.exec(message.errorMessage ?? "")?.[1];
          if (!id) return;
          const conversation = await host.conversation(
            context,
            api.conversationId,
          );
          let dropped = false;
          await conversation.commit(async (tx) => {
            const doc = await tx.doc(CodexCheckpointDoc, conversation.id);
            const kept = (doc.saved ?? []).filter(
              (entry) => entry.item.id !== id,
            );
            dropped = kept.length < (doc.saved?.length ?? 0);
            doc.saved = kept;
          }, context);
          if (dropped)
            host.report(
              "durable_codex_checkpoint_rejected",
              message.errorMessage,
            );
        },
      }),
    ],
  });
}
