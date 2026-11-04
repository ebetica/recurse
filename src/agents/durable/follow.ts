// Follow an open Harness conversation's live watches and commits: run, shells,
// queue, model, committed usage and safety state. Promote queued input at idle;
// write lost-task rows; kick its run reporter.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  ToolTask,
  type CommitPublication,
  type Conversation,
  type EntryId,
  type Harness,
  type LiveState,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import { assistantContextUsage } from "../runtime/context_usage.ts";
import { createdPrUrls } from "../conversation_prs.ts";
import { pendingRows } from "./durable_rows.ts";
import { lostTasks, taskFailures } from "./failure_log.ts";
import type { Reporter } from "./report.ts";
import { forConversation } from "./side_conversations.ts";
import { SHELL_TASK } from "../../extensions/core/shells/shells.ts";
import {
  continuationNote,
  queuedCompaction,
  writeContinuationNote,
} from "../../extensions/core/context/durable-compaction.ts";
import {
  safetyReviewOff,
  safetyReviewUnavailable,
} from "../../extensions/core/safety/durable.ts";
import { WARNING } from "../../observability/runtime_logging";

type Rec = Record<string, unknown>;

export interface ShellInput {
  pid: number;
  identity: string;
  shellId: string;
  command: string;
  mode: "background" | "monitor";
  startedAt: number;
}

export interface LiveRow {
  contextUsage?: Rec | null;
  runId?: string;
  /** InboxDoc items, set synchronously from commits. */
  queued?: number;
  pending: Rec[];
  safetyOff?: boolean;
  safetyUnavailable?: string;
  shells: Map<unknown, ShellInput>;
  modelError?: string;
}

export interface FollowInput {
  cid: string;
  harness: Harness;
  conversation: Conversation;
  row: LiveRow;
  reporter: Reporter | null;
  /** The Harness root also follows Session-scoped changes. */
  root: boolean;
  /** Set once the Harness resumed: queued input may be promoted. */
  ready(): boolean;
  state(): { closing: boolean; rotating: boolean; deleting: boolean };
  /** Whether `row` is still the conversation's live row. */
  current(): boolean;
  syncAgent(): Promise<void>;
  clearPending?(): void;
  onIdle?(): void;
  activityChanged?(): void;
  committed?(publication: CommitPublication): void;
  contextChanged?(): void;
  model(): { provider: string; model: string };
  log(event: string, fields: Rec, level?: number): void;
  rowChanged(): void;
  viewChanged?(): void;
  safetyChanged(): void;
  /** PRs a tool call that started at `since` (epoch seconds) created. */
  prsCreated?(urls: string[], since: number): void;
}

// Successful model bash calls this commit settled whose output names a pull
// request: [assistant entry, call id, output text, start in epoch seconds].
function prOutputs(
  publication: CommitPublication,
): [EntryId, string, string, number][] {
  const calls = new Map<string, EntryId>();
  for (const change of publication.changes)
    if (
      change.type === "task" &&
      change.value.kind === ToolTask.definition.name &&
      (change.value.input as Rec)?.kind === "model"
    ) {
      const input = change.value.input as unknown as ToolTaskInput & {
        kind: "model";
      };
      calls.set(input.callId, input.assistant);
    }
  return publication.changes.flatMap((change) => {
    if (change.type !== "entry" || change.value.kind !== "pi.tool-result")
      return [];
    const message = change.value.model?.[0] as Rec | undefined;
    const text = (Array.isArray(message?.content) ? message.content : [])
      .map((part: Rec) => (part.type === "text" ? String(part.text) : ""))
      .join("\n");
    const assistant = calls.get(String(message?.toolCallId));
    return assistant !== undefined &&
      message?.toolName === "bash" &&
      message.isError !== true &&
      text.includes("/pull/")
      ? [
          [
            assistant,
            String(message!.toolCallId),
            text,
            (Number(message!.timestamp) - Number(message!.durationMs ?? 0)) /
              1000,
          ],
        ]
      : [];
  });
}

export async function followConversation(input: FollowInput): Promise<{
  track(): Promise<void>;
  retrack(): Promise<void>;
  stop(): void;
}> {
  const { cid, harness, conversation, row, reporter } = input;
  const blocked = () => {
    const { closing, rotating, deleting } = input.state();
    return closing || rotating || deleting;
  };
  const report = (event: string) => (error: unknown) =>
    input.log(event, {
      cid,
      error: error instanceof Error ? error.message : String(error),
    });
  let requests = new Map<string, string>();

  let noteDue = true;
  let syncError: string | undefined;
  const track = async () => {
    const run = (await harness.snapshot(LiveDoc, conversation.id, context))
      ?.run;
    if (run === undefined) input.onIdle?.();
    const inbox = await harness.snapshot(InboxDoc, conversation.id, context);

    const known = new Map<string, string>();
    for (const item of inbox?.items ?? []) {
      const key = String(item.id);
      const requestId =
        requests.get(key) ??
        (await (await harness.submission(item.id, context))?.status(context))
          ?.requestId;
      if (requestId) known.set(key, requestId);
    }
    requests = known;
    row.pending = pendingRows(inbox, known);
    // Invariant: After a compaction, the model reads one continuation note at
    // its next turn. It is written before queued input is placed, so the next
    // run has it.
    if (noteDue && run === undefined && input.ready() && !blocked()) {
      noteDue = false;
      const note = await writeContinuationNote(conversation, context).catch(
        (error: unknown) => {
          report("durable_continuation_note_failed")(error);
          return "busy" as const;
        },
      );
      if (note === "busy") noteDue = true;
    }
    // Invariant: Empty edits queue a boundary without changing model context;
    // display-only writes bypass the inbox. Idle promotion starts the oldest.
    // Queued writes precede input, so an unplaced compaction receives its
    // continuation note before the next run.
    const oldest = inbox?.items[0];
    // Invariant: A model that cannot apply (unknown) keeps queued input
    // queued, its oldest row showing the error: it never runs on the previous
    // model.
    let synced = true;
    if (run !== undefined) row.modelError = syncError = undefined;
    if (input.ready() && run === undefined && !input.state().closing)
      await input.syncAgent().then(
        () => {
          row.modelError = syncError = undefined;
        },
        (error: unknown) => {
          synced = false;
          if (syncError !== String(error))
            report("durable_model_sync_failed")(error);
          row.modelError = syncError = String(error);
        },
      );
    if (
      synced &&
      input.ready() &&
      run === undefined &&
      oldest !== undefined &&
      !blocked()
    )
      await conversation.submit(
        {
          type: "write",
          requestId: `promote:${String(oldest.id)}`,
          entry: inbox!.items.some(queuedCompaction)
            ? continuationNote()
            : { kind: "recurse.promote", edits: [] },
        },
        context,
      );
    input.clearPending?.();
    reporter?.recheck();
    const off = await safetyReviewOff(harness, conversation, context);
    const unavailable = await safetyReviewUnavailable(
      harness,
      conversation,
      context,
    );
    if (
      input.current() &&
      (row.safetyOff !== off || row.safetyUnavailable !== unavailable)
    ) {
      row.safetyOff = off;
      row.safetyUnavailable = unavailable;
      input.safetyChanged();
    }
  };
  // Invariant: A commit listener must not call Session APIs, so read after it
  // returns. Reads run one at a time, and commits during a read cause one
  // more, so the last read always follows the last commit.
  let tracking = false;
  let again = false;
  const retrack = async () => {
    if (tracking) return void (again = true);
    tracking = true;
    try {
      do {
        again = false;
        await track().catch(() => undefined);
      } while (again);
    } finally {
      tracking = false;
    }
  };
  const run = (await harness.snapshot(LiveDoc, conversation.id, context))?.run;
  row.runId = run && String(run.taskId);
  row.queued = (
    await harness.snapshot(InboxDoc, conversation.id, context)
  )?.items.length;
  const live = await conversation.watch(context);
  live.start(async (call) => {
    if (call.kind === "value" && input.current()) input.viewChanged?.();
  });
  const committed = (all: CommitPublication) => {
    input.committed?.(all);
    const publication = forConversation(all, conversation.id, input.root);
    if (publication.changes.length)
      queueMicrotask(() => {
        if (input.current()) input.viewChanged?.();
      });
    // Invariant: Settings are read on the Session line: use the adopted live
    // revision, not the asynchronous metadata snapshot, at the very next
    // boundary.
    for (const change of publication.changes) {
      if (change.type !== "entry") continue;
      if (change.value.kind === "pi.compaction") row.contextUsage = null;
      else if (change.value.kind === "pi.assistant")
        row.contextUsage = assistantContextUsage(
          change.value.model?.[0] as Rec | undefined,
        );
    }
    let moved = false;
    for (const change of publication.changes)
      if (
        change.type === "document" &&
        change.record.kind === LiveDoc.definition.kind &&
        change.conversationId === conversation.id
      ) {
        const run =
          change.kind === "change"
            ? (change.value as LiveState).run
            : undefined;
        const before = row.runId;
        row.runId = run && String(run.taskId);
        moved ||= row.runId !== before;
      } else if (
        change.type === "document" &&
        change.record.kind === InboxDoc.definition.kind &&
        change.conversationId === conversation.id
      )
        row.queued = (
          change.kind === "change"
            ? (change.value as { items?: unknown[] })
            : undefined
        )?.items?.length;
      else if (
        change.type === "task" &&
        change.value.kind === SHELL_TASK &&
        change.value.conversationId === conversation.id
      ) {
        const { id, state, input } = change.value;
        const before = row.shells.size;
        if (state.status === "completing" || state.status === "terminal")
          row.shells.delete(id);
        else row.shells.set(id, input as unknown as ShellInput);
        moved ||= row.shells.size !== before;
      }
    if (
      publication.changes.some(
        (change) =>
          (change.type === "document" &&
            change.record.kind === AgentDoc.definition.kind) ||
          (change.type === "entry" && change.value.kind === "pi.compaction"),
      )
    )
      input.contextChanged?.();
    input.activityChanged?.();
    if (moved)
      queueMicrotask(() => {
        if (input.current()) input.rowChanged();
      });
    for (const failure of taskFailures(publication, input.model))
      input.log("durable_task_failed", { cid, ...failure }, WARNING);
    // Invariant: A lost reply or compaction gets an error row, never from
    // inside the commit listener.
    for (const { task, text } of lostTasks(publication))
      queueMicrotask(() => {
        const { closing, deleting } = input.state();
        if (closing || deleting) return;
        conversation
          .submit(
            {
              type: "write",
              requestId: `task-failure:${task}`,
              entry: {
                kind: "recurse.task-failure",
                data: { text, at: Date.now() },
              },
            },
            context,
          )
          .catch((error: unknown) =>
            input.log(
              "durable_task_failure_row_failed",
              { cid, error: String(error) },
              WARNING,
            ),
          );
      });
    if (
      publication.changes.some(
        (change) =>
          change.type === "entry" && change.value.kind === "pi.compaction",
      )
    )
      noteDue = true;
    for (const [assistant, callId, text, since] of prOutputs(publication))
      void conversation
        .entries(
          { minEntryId: assistant, maxEntryId: assistant },
          1,
          undefined,
          context,
        )
        .then(({ items }) => {
          const message = items[0]?.model?.[0] as Rec | undefined;
          const call = (
            Array.isArray(message?.content) ? message.content : []
          ).find((part: Rec) => part.type === "toolCall" && part.id === callId);
          const command = (call?.arguments as Rec | undefined)?.command;
          const urls =
            typeof command === "string" ? createdPrUrls(command, text) : [];
          if (urls.length) input.prsCreated?.(urls, since);
        })
        .catch(report("created_pr_read_failed"));
    if (reporter?.noteCommit(publication))
      queueMicrotask(() => void reporter.kick());
    queueMicrotask(() => void retrack());
  };
  const observation = harness.observeCommits({
    advance: committed,
    end: () => {},
  });
  return {
    track,
    retrack,
    stop() {
      observation.detach();
      void live.stop();
    },
  };
}
