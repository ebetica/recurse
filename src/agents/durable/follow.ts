// Follow one conversation of an open Harness from its commits: run, shells,
// queue, model and safety state for its live row. Promote queued input at
// idle; write lost-task rows; kick its run reporter.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  InboxDoc,
  LiveDoc,
  type Conversation,
  type Harness,
  type LiveState,
} from "@earendil-works/pi-durable";
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
  model(): { provider: string; model: string };
  log(event: string, fields: Rec, level?: number): void;
  rowChanged(): void;
  safetyChanged(): void;
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
    if (run !== undefined) row.modelError = undefined;
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
  const stop = harness.subscribeCommits((all) => {
    const publication = forConversation(all, conversation.id, input.root);
    // Invariant: Settings are read on the Session line: use the adopted live
    // revision, not the asynchronous metadata snapshot, at the very next
    // boundary.
    let moved = false;
    for (const change of publication.changes)
      if (
        change.type === "document" &&
        change.record.kind === LiveDoc.definition.kind &&
        change.conversationId === conversation.id
      ) {
        const run = (change.value as LiveState | undefined)?.run;
        const before = row.runId;
        row.runId = run && String(run.taskId);
        moved ||= row.runId !== before;
      } else if (
        change.type === "document" &&
        change.record.kind === InboxDoc.definition.kind &&
        change.conversationId === conversation.id
      )
        row.queued = (
          change.value as { items?: unknown[] } | undefined
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
    if (reporter?.noteCommit(publication))
      queueMicrotask(() => void reporter.kick());
    queueMicrotask(() => void retrack());
  });
  return { track, retrack, stop };
}
