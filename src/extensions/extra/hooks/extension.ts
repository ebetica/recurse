// tool_call/tool_result on ToolTask (codemode's nested calls too) before safety
// review; before_agent_start, context and agent_before_settle on
// GenerationTask, session_before_compact on CompactionTask (agent_settled in
// host/follow.ts). Each stops with the Durable task, as on Stop.
import type {
  CompactionTask,
  defineExtension,
  GenerationTask,
  hook,
  HookApi,
  JsonObject,
  LiveDoc,
  ToolExecutionResult,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { HookScope, Hooks } from "./hooks";

type Durable = {
  defineExtension: typeof defineExtension;
  hook: typeof hook;
  GenerationTask: typeof GenerationTask;
  ToolTask: typeof ToolTask;
  CompactionTask: typeof CompactionTask;
  LiveDoc: typeof LiveDoc;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How many tool tasks may hold `tool_call` notes and arguments for later. */
const MAX_PENDING = 1024;

/** `rt` is the Durable API, passed in so this module stays light to import. */
export function hooksExtension(
  rt: Durable,
  hooks: Hooks,
  cid: string,
  scope: HookScope,
) {
  const pending = new Map<string, { notes: string[]; input?: JsonObject }>();
  // The run a request belongs to: the input that started it, which every
  // generation it hands over to keeps.
  const request = async (api: HookApi, context: Context) => {
    const run = (await api.snapshot(rt.LiveDoc, api.conversationId, context))
      ?.run;
    return {
      conversation: String(api.conversationId),
      run: run
        ? `${run.inputs[0] ?? `entry ${run.first ?? run.taskId}`}`
        : `task ${api.taskId}`,
      signal: context.abortSignal,
    };
  };
  return rt.defineExtension({
    name: "recurse-hooks",
    hooks: [
      rt.hook(rt.GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const changed = await hooks.beforeRequest(cid, scope, {
            ...(await request(api, context)),
            messages,
          });
          return changed && { messages: changed as Message[] };
        },
        onYield: async (answer, api, context) => {
          const text = await hooks.beforeSettle(cid, scope, {
            ...(await request(api, context)),
            answer: (Array.isArray(answer.content) ? answer.content : [])
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
          });
          return text === undefined ? undefined : { continue: text };
        },
      }),
      rt.hook(rt.ToolTask, {
        beforeTool: async (call, api, context) => {
          const { input, block, notes } = await hooks.toolCall(
            cid,
            scope,
            call,
            () => request(api, context),
            context.abortSignal,
          );
          const ran = block === undefined ? (input as JsonObject) : undefined;
          if (notes.length || ran) {
            if (pending.size >= MAX_PENDING)
              pending.delete(pending.keys().next().value!);
            pending.set(String(api.taskId), { notes, input: ran });
          }
          if (block !== undefined) return { block };
          return ran && { arguments: ran };
        },
        afterTool: async (call, result, api, context) => {
          const { notes: before = [], input } =
            pending.get(String(api.taskId)) ?? {};
          pending.delete(String(api.taskId));
          const after = await hooks.toolResult(
            cid,
            scope,
            call,
            {
              content: result.output ?? [],
              details: result.details,
              isError: result.isError === true,
            },
            () => request(api, context),
            context.abortSignal,
          );
          const notes = [...before, ...after.notes];
          if (!after.result && !notes.length && !input) return undefined;
          const details = after.result ? after.result.details : result.details;
          const output = [
            ...((after.result?.content ?? result.output ?? []) as NonNullable<
              ToolExecutionResult["output"]
            >),
            ...(notes.length
              ? [{ type: "text" as const, text: notes.join("\n") }]
              : []),
          ];
          // The arguments a hook changed go in the details, which the UI
          // shows and the model never sees; every Recurse tool's details are
          // an object or absent, so other details are kept as they are.
          return {
            ...result,
            output,
            ...((after.result || input) && {
              details: (input && (details === undefined || object(details))
                ? { ...details, recurseHookArguments: input }
                : details) as ToolExecutionResult["details"],
            }),
            ...(after.result && { isError: after.result.isError }),
          };
        },
      }),
    ],
  });
}

/** `session_before_compact`, installed ahead of Recurse's own summarizer so a
 * hook's cancel or summary wins. */
export function hooksCompactionExtension(
  rt: Durable,
  hooks: Hooks,
  cid: string,
  scope: HookScope,
) {
  return rt.defineExtension({
    name: "recurse-hooks-compaction",
    hooks: [
      rt.hook(rt.CompactionTask, {
        beforeCompact: (
          { reason, entries, messages, firstKept, instructions },
          _api,
          context,
        ) =>
          hooks.beforeCompact(
            cid,
            scope,
            {
              reason,
              preparation: { entries, messages, firstKept },
              customInstructions: instructions,
            },
            context.abortSignal,
          ),
      }),
    ],
  });
}
