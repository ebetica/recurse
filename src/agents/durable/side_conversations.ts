// A side conversation is a Durable fork of its parent's root, in the parent's
// Harness, keeping the parent's prompt, tools and provider session (README.md).
// Spec: the fork and its root mapping commit together at the parent's newest
// entry with no open tool call; only return_to_main reaches the parent.
import { setImmediate } from "node:timers/promises";
import { Type, type Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  ToolTask,
  defineExtension,
  defineTool,
  hook,
  section,
  InboxDoc,
  LiveDoc,
  ProviderDoc,
  defineDoc,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

/** The only tools that run in a side conversation, directly or nested. */
export const SIDE_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
]);

export const RETURN_TO_MAIN = "return_to_main";

export const SIDE_INSTRUCTIONS = `This is a read-only side conversation, forked from the main conversation above. Answer the operator's side questions. Of the tools above only read, grep and find run here; any other tool call is refused. Nothing here reaches the main conversation unless the operator explicitly asks you to return or send something to it: only then call ${RETURN_TO_MAIN} once, with self-contained instructions for the main conversation distilled from this side conversation. Never call it otherwise.`;

export const PROMOTED_INSTRUCTIONS = `This conversation began as a read-only side conversation forked from the main conversation above, and the operator has promoted it to a subagent of that conversation. The read-only note no longer applies: every tool above runs here. When a run ends, your final message is reported to the main conversation, which is now your parent; ${RETURN_TO_MAIN} also sends it a message.`;

/**
 * Selected by side forks and the subagents promoted from them: the read-only
 * note (or, once promoted, PROMOTED_INSTRUCTIONS) and return_to_main.
 */
export function sideExtension(
  send: (conversation: ConversationId, message: string) => Promise<string>,
  isSide: (conversation: ConversationId) => boolean,
) {
  return defineExtension({
    name: "recurse-side-conversation",
    sections: [
      section("side_conversation", (input) =>
        isSide(input.conversationId)
          ? SIDE_INSTRUCTIONS
          : PROMOTED_INSTRUCTIONS,
      ),
    ],
    tools: [
      defineTool({
        name: RETURN_TO_MAIN,
        callers: ["model"],
        description:
          "Send instructions to the main conversation this side conversation was forked from. Call only when the operator explicitly asks to return or send something to main.",
        parameters: Type.Object({
          message: Type.String({
            description:
              "Self-contained instructions for the main conversation, distilled from this side conversation",
          }),
        }),
        async execute(args, api) {
          const id = await send(api.conversationId, args.message);
          return {
            output: [
              {
                type: "text",
                text: `Sent to the main conversation as message ${id}.`,
              },
            ],
            details: { message_id: id },
          };
        },
      }),
    ],
  });
}

/**
 * Refuse tools outside SIDE_TOOLS/return_to_main before safety or codemode.
 */
export function sideGuard(isSide: (conversation: ConversationId) => boolean) {
  return defineExtension({
    name: "recurse-side-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) =>
          !isSide(api.conversationId) ||
          SIDE_TOOLS.has(call.name) ||
          call.name === RETURN_TO_MAIN
            ? undefined
            : {
                block: `${call.name} is refused: this is a read-only side conversation, where only read, grep, find and ${RETURN_TO_MAIN} run.`,
              },
      }),
    ],
  });
}

/** Side cid → its fork, kept on the parent's root conversation. */
export const SideDoc = defineDoc<{
  sides: Record<string, { conversation: number; sessionId: string }>;
}>({
  kind: "recurse.side-conversations",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ sides: {} }),
});

/** Promoted copy: each tool result entry id → its assistant call's entry id. */
export const CopiedCallsDoc = defineDoc<{ calls: Record<string, number> }>({
  kind: "recurse.copied-tool-calls",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ calls: {} }),
});

const FORK_SCAN = 256;

function toolCalls(entry: EntryRecord): string[] {
  return (entry.model ?? []).flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) =>
          part.type === "toolCall" ? [part.id] : [],
        )
      : [],
  );
}

function toolResults(entry: EntryRecord): string[] {
  return (entry.model ?? []).flatMap((message) =>
    message.role === "toolResult" ? [message.toolCallId] : [],
  );
}

/** The newest entry after which no tool call in the scanned tail is open. */
export async function forkPoint(
  root: Conversation,
): Promise<EntryId | undefined> {
  const page = await root.entries({}, FORK_SCAN, undefined, context);
  const entries = [...page.items].reverse();
  const open = new Set<string>();
  let at: EntryId | undefined;
  for (const entry of entries) {
    for (const id of toolCalls(entry)) open.add(id);
    for (const id of toolResults(entry)) open.delete(id);
    if (open.size === 0) at = entry.id;
  }
  return at;
}

/**
 * Send side-session requests under the parent's provider session id, OpenAI's
 * cache key. Wrap inside request capture, which keys on the side's own id.
 */
export function shareParentSession(
  models: Models,
  parentSession: (sessionId: string) => string | undefined,
): Models {
  return new Proxy(models, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "stream" && key !== "streamSimple") return value.bind(target);
      return (
        model: unknown,
        context: unknown,
        options?: Record<string, unknown>,
      ) => {
        const sessionId = options?.sessionId;
        const parent =
          typeof sessionId === "string" ? parentSession(sessionId) : undefined;
        return value.call(
          target,
          model,
          context,
          parent === undefined ? options : { ...options, sessionId: parent },
        );
      };
    },
  });
}

/** Fork the parent's root for `cid`, or return the fork it already has. */
export async function forkSide(
  harness: Harness,
  root: Conversation,
  cid: string,
  side: Extension,
): Promise<{ conversation: Conversation; sessionId: string }> {
  const known = (await harness.snapshot(SideDoc, root.id, context))?.sides[cid];
  if (known) {
    const conversation = await harness.conversation(
      known.conversation as ConversationId,
      context,
    );
    if (!conversation)
      throw new Error(`side conversation fork is gone: ${cid}`);
    return { conversation, sessionId: known.sessionId };
  }
  const at = await forkPoint(root);
  if (at === undefined)
    throw new Error("the main conversation has nothing to fork yet");
  let sessionId = "";
  const conversation = await root.fork(
    at,
    {
      ownership: { kind: "ownerless" },
      agent: { extensions: { add: [side] } },
      init: async (tx, id) => {
        sessionId = (await tx.doc(ProviderDoc, id)).sessionId;
        (await tx.doc(SideDoc, root.id)).sides[cid] = {
          conversation: Number(id),
          sessionId,
        };
      },
    },
    context,
  );
  return { conversation, sessionId };
}

const COPY_PAGE = 64;

// Promotion: copy `fork`'s visible history, agent and outgoing provider
// session id into `target`'s new root; refuse unless both next-request
// contexts are JSON-identical.
export async function copyFork(
  harness: Harness,
  fork: Conversation,
  target: Harness,
  sessionId: string,
  ctx: Context,
): Promise<void> {
  const agent = await harness.snapshot(AgentDoc, fork.id, ctx);
  const root = await target.root(ctx, {
    init: async (tx, id) => {
      Object.assign(await tx.doc(AgentDoc, id), structuredClone(agent ?? {}));
      (await tx.doc(ProviderDoc, id)).sessionId = sessionId;
    },
  });
  const ids = new Map<EntryId, EntryId>();
  const callers = new Map<string, EntryId>();
  const calls: Record<string, number> = {};
  const copied = (id: EntryId) => {
    const to = ids.get(id);
    if (to === undefined)
      throw new Error("the side conversation's history refers outside itself");
    return to;
  };
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await fork.entries(
      { order: "ascending" },
      COPY_PAGE,
      cursor,
      ctx,
    );
    await root.commit(async (tx) => {
      for (const entry of page.items) {
        const {
          id,
          conversationId: _from,
          byTaskId: _task,
          head,
          edits,
          ...rest
        } = entry;
        const draft = await tx.appendEntry(root.id, {
          ...rest,
          ...(head !== undefined && {
            head: head === id ? ("self" as const) : copied(head),
          }),
          ...(edits !== undefined && {
            edits: edits.map((edit) => ({
              ...edit,
              target: copied(edit.target),
            })),
          }),
        });
        ids.set(id, draft.id);
        for (const call of toolCalls(entry)) callers.set(call, draft.id);
        const result = entry.model?.[0];
        const caller =
          result?.role === "toolResult" && callers.get(result.toolCallId);
        if (caller) calls[String(draft.id)] = caller;
      }
    }, ctx);
    cursor = page.next;
    await setImmediate();
  } while (cursor !== undefined);
  await root.commit(async (tx) => {
    (await tx.doc(CopiedCallsDoc, root.id)).calls = calls;
  }, ctx);
  const [want, got] = await Promise.all([fork.context(ctx), root.context(ctx)]);
  if (
    want.messages.length !== got.messages.length ||
    want.messages.some(
      (message, index) =>
        JSON.stringify(message) !== JSON.stringify(got.messages[index]),
    )
  )
    throw new Error("the copied history would change the next request");
}

/** The forks recorded on `root`, by side cid. */
export async function sideForks(harness: Harness, root: Conversation) {
  return (await harness.snapshot(SideDoc, root.id, context))?.sides ?? {};
}

/**
 * Withdraw a fork's queued input, stop its run and forget it, so no work of a
 * deleted side conversation runs again, even from archived storage.
 */
export async function dropFork(
  harness: Harness,
  root: Conversation,
  cid: string,
): Promise<{ conversation: number; sessionId: string } | undefined> {
  const fork = (await sideForks(harness, root))[cid];
  if (fork === undefined) return undefined;
  const id = fork.conversation as ConversationId;
  for (const item of (await harness.snapshot(InboxDoc, id, context))?.items ??
    [])
    await harness.abortSubmission(item.id, context, id);
  const run = (await harness.snapshot(LiveDoc, id, context))?.run;
  if (run !== undefined) await harness.abortTask(run.taskId, context);
  await root.commit(async (tx) => {
    delete (await tx.doc(SideDoc, root.id)).sides[cid];
  }, context);
  return fork;
}

/**
 * Only the changes of one conversation; Session-scoped changes stay with the
 * root.
 */
export function forConversation(
  publication: CommitPublication,
  id: ConversationId,
  root: boolean,
): CommitPublication {
  const owned = (owner: ConversationId | undefined) =>
    owner === undefined ? root : owner === id;
  return {
    seq: publication.seq,
    changes: publication.changes.filter((change) =>
      change.type === "document" || change.type === "document.copy"
        ? owned(change.conversationId)
        : change.type === "conversation"
          ? change.value.id === id
          : owned(change.value.conversationId),
    ),
  };
}
