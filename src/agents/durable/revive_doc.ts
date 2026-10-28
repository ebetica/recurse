// Revived stores become passive before resume: abort runs, withdraw queued
// input (retain text), advance report cursor, and reset missing cwd to workdir.
// The revive document records progress so crashes repeat only unfinished work.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  configure,
  defineDoc,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type Harness,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ReportDoc } from "./report.ts";
import { isDirectory } from "./archive.ts";
import {
  EnvironmentDoc,
  unprotectedOverrides,
} from "../../extensions/core/environment/managed_tools";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ReviveState = {
  archive: string;
  /** Text of each input withdrawn from the queue, oldest first. */
  queued: string[];
  /** The agent cwd that was gone, or null. */
  oldCwd: string | null;
  /** The run and queued input are withdrawn. */
  settled: boolean;
};

export const ReviveDoc = defineDoc<ReviveState>({
  kind: "recurse.revive",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ archive: "", queued: [], oldCwd: null, settled: false }),
});

// Only the initial imported open resets foreign settings; later operator
// toggles survive.
export async function sanitizeImported(
  harness: Harness,
  conversation: Conversation,
  model: ModelRef,
  effort: ModelThinkingLevel,
  archive: string,
  ctx: typeof context,
): Promise<boolean> {
  const state = await harness.snapshot(ReviveDoc, conversation.id, ctx);
  if (state?.archive === archive && state.settled) return false;
  await conversation.commit(async (tx) => {
    const env = await tx.doc(EnvironmentDoc, conversation.id);
    env.overrides = unprotectedOverrides(env.overrides);
    await configure(tx, conversation.id, { model, thinkingLevel: effort });
  }, ctx);
  return true;
}

function inputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: unknown }) =>
      part.type === "text" ? String(part.text) : "[image]",
    )
    .join("");
}

export async function settleRevive(
  harness: Harness,
  conversation: Conversation,
  storage: SqliteStorage,
  archive: string,
  cwd: string,
): Promise<void> {
  const id = conversation.id;
  const state = await harness.snapshot(ReviveDoc, id, context);
  if (state?.archive === archive && state.settled) return;
  // Invariant: Queued text, report cursor and cwd commit before the aborts
  // (each kicks the reporter); a crash in between repeats only the aborts.
  if (state?.archive !== archive) {
    const latest = (
      await storage.scanSubmissions(
        { conversationId: id, order: "descending" },
        1,
        undefined,
        context,
      )
    ).items[0];
    const queued = (
      (await harness.snapshot(InboxDoc, id, context))?.items ?? []
    )
      .filter((item) => item.mode !== "write")
      .map((item) => inputText(item.content));
    const agentCwd = (await harness.snapshot(AgentDoc, id, context))?.cwd;
    const gone = agentCwd !== undefined && !(await isDirectory(agentCwd));
    await conversation.commit(async (tx) => {
      const report = await tx.doc(ReportDoc, id);
      if (latest !== undefined)
        report.after = Math.max(report.after, Number(latest.id));
      if (gone) await configure(tx, id, { cwd });
      Object.assign(await tx.doc(ReviveDoc, id), {
        archive,
        queued,
        oldCwd: gone ? agentCwd : null,
        settled: false,
      });
    }, context);
  }
  const run = (await harness.snapshot(LiveDoc, id, context))?.run;
  if (run !== undefined) await harness.abortTask(run.taskId, context);
  for (const item of (await harness.snapshot(InboxDoc, id, context))?.items ??
    [])
    if (item.mode !== "write")
      await harness.abortSubmission(item.id, context, id);
  await conversation.commit(async (tx) => {
    (await tx.doc(ReviveDoc, id)).settled = true;
  }, context);
}
