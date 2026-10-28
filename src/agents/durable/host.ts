// One Harness per conversation; runs outlive HTTP requests. The host keeps open
// handles, live rows and per-conversation order; host/ holds the lifecycles
// (open, registry, send, clear, delete, close, title, import, reads). Settings
// owns auth. Reap, clear and recovery verify group cleanup before retiring.
import { ServerStoppingError } from "./stopping_error";
import { IdleHarnesses } from "./idle_harnesses";
import { ReportHolds } from "./report_holds";
import { Promotions, type PromotionRecord } from "./promotion";
import type { AbortScope } from "../../utils/tasks";
import { join } from "node:path";
import { splitPiUserText } from "../view/session_entries";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ImageContent, MutableModels } from "@earendil-works/pi-ai";
import type { CustomProviderSpec } from "./models";
import type { Config } from "../../config";
import type { LiveState } from "@earendil-works/pi-durable";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";
import type { DurableViews, PageOptions } from "./durable_rows.ts";
import type { PromptSnapshot } from "./prompt_sections.ts";
import type { SqliteWorker } from "./sqlite_worker.ts";
import {
  AgentArchive,
  type ArchivedAgent,
  type ArchiveReason,
} from "./archive.ts";
import type { ReviveState } from "./revive_doc.ts";
import type { FffWorker } from "../../extensions/extra/fff/fff_worker.ts";
import type { TranscriptQuery } from "./transcript.ts";
import type {
  PromptResources,
  PromptResourcesWorker,
} from "./prompt_resources.ts";
import type { DurableReport, ReportOutcome } from "./report.ts";
import type { ShellGroup } from "../../extensions/core/shells/shells.ts";
import type { OwnedProcess } from "../../process_lifecycle.ts";
import type { EnvironmentChange } from "../../extensions/core/environment/managed_tools.ts";
import type { LiveRow } from "./follow.ts";
import { WARNING } from "../../observability/runtime_logging";
import { timed, timingDetail } from "../../observability/request_timing";
import type { PiImportOptions, PiImportResult } from "./import_pi_session";
import { runtime, type Runtime } from "./host/load.ts";
import { openHarness, openSide, type Opened } from "./host/open.ts";
import { CONTEXT_RETENTION_MS } from "./host/registry.ts";
import { cancel, send, type SendOptions } from "./host/send.ts";
import { requestClear, retireCleared, type ClearState } from "./host/clear.ts";
import { forgetFork, retire } from "./host/delete.ts";
import { closeAll, closeHarness } from "./host/close.ts";
import { importArchive, importPi, supportsImport } from "./host/import.ts";
import {
  contextUsage,
  markerSummary,
  prompt,
  thinking,
  toolDetails,
  turnPrompt,
} from "./host/reads.ts";

/** Overall bound for a background phase waiting on focused opens. */
const FOCUS_WAIT_MS = 60_000;
/** How long retire() waits for a Harness to close. */
const RETIRE_CLOSE_MS = 5000;

type Rec = Record<string, unknown>;

export interface DurableHostDeps extends PromotionRecord {
  dataDir: string;
  /** The instance's settings, restricted by the native settings adapter. */
  config?: Config;
  /** Where retire() moves a deleted conversation's storage. */
  trashDir: string;
  piAgentDir: string;
  /** An owned record (or selected field), or null when it no longer exists. */
  load(cid: string, fields?: readonly string[]): Rec | null;
  /** Resolve owned upload paths and images before the admission commit. */
  uploadParts?(
    cid: string,
    text: string,
    attachmentIds: readonly string[],
  ): Promise<[string, readonly ImageContent[]]>;
  /** Ids of every live conversation record, deepest in the tree first. */
  liveIds(): string[];
  /** Protect a managed checkout before a cwd change commits. */
  claimWorkdir?(cid: string, cwd: string, signal?: AbortSignal): Promise<void>;
  /** The environment the conversation's tools run with. */
  agentEnv(
    conv: Rec,
    recordTiming?: (phase: string, ms: number) => void,
  ): Promise<Record<string, string>>;
  // Create the publish collection; refuse once conversation deletion begins.
  admitFiles?(conv: Rec): Promise<unknown>;
  /** The conversation's model ("provider/model") and thinking level. */
  settings(conv: Rec): [string, string];
  /** The conversation's prompt state for a request in `cwd`. */
  promptSnapshot(conv: Rec, cwd: string): Promise<PromptSnapshot>;
  // Verified stop of one shell's process group; true once it is proven gone.
  stopGroup(group: ShellGroup): Promise<boolean>;
  /** Record a detached MCP process group (mcp.ts) for the conversation. */
  ownProcess(proc: OwnedProcess, cid: string): Promise<void>;
  /** Verified stop of a recorded MCP group; true once it is proven gone. */
  releaseProcess(proc: OwnedProcess): Promise<boolean>;
  /** Monotonic milliseconds for open diagnostics. */
  openClock?(): number;
  /** Wall-clock milliseconds model requests are stamped with; Date.now. */
  wallClock?(): number;
  /** Log an event, at INFO unless `level` (runtime_logging) is given. */
  log(event: string, fields: Rec, level?: number): void;
  /** The conversation's safety state changed; its tree row should refresh. */
  safetyChanged?(cid: string): void;
  // The conversation's run or live shells changed; its tree row should refresh.
  rowChanged?(cid: string): void;
  /** Effort-1 settings for best-effort top-level conversation naming. */
  titleSettings?(): [string, string];
  /** Apply only while the original default title has not been renamed. */
  applyTitle?(cid: string, title: string): void;
  /** Persist the time of a newly admitted trusted operator message. */
  operatorMessageAdmitted?(cid: string, at: number): void;
  /** Deliver a return_to_main message to the sender's main conversation. */
  returnToMain?(from: string, message: string): Promise<string | null>;
  /** Deliver one settled run's report to the parent (report.ts). */
  report?(cid: string, report: DurableReport): Promise<ReportOutcome>;
  /** Delete side conversations before clearing their parent's storage. */
  clearingSides?(cid: string): void;
  /** The Settings cap on a model's context window. */
  maximumContextWindow?(): number;
  models?: MutableModels;
  /** Settings' custom providers (model-providers.json), from Config's cache. */
  customProviders?(): Record<string, CustomProviderSpec>;
  /** The server environment's value of a custom provider's own env_key. */
  customProviderEnvValue?(provider: string): string | undefined;
  // Build the Settings model catalog and effort ladder that settings() reads.
  warmSettings?(): void;
  /** How long a latest request stays in memory before it moves to its file. */
  captureIdleMs?: number;
  /** How long an unused Harness stays open after its last activity. */
  harnessIdleMs?: number;
}

/** Launcher data-dir lock plus old-server exit before new-server start
 * exclude two processes opening the same conversation storage. Members
 * without `private` are shared with the lifecycles in ./host/. */
export class DurableHost {
  private worker: SqliteWorker | null = null;
  private images: Promise<ImageProcessor> | null = null;
  private searchWorker: FffWorker | null = null;
  /** A search thread a failed warm-up dropped; shutdown waits for it. */
  private retiredSearch: Promise<void> = Promise.resolve();
  private promptWorker: PromptResourcesWorker | null = null;
  /** Focused opens in flight, with their conversation ids. */
  private readonly onDemand = new Map<Promise<Opened>, string>();
  /** Background conversation naming (host/title.ts), by conversation. */
  readonly titleTasks = new Map<
    string,
    { scope: AbortScope; done: Promise<void> }
  >();
  /** Each conversation's open handle, or the open or rotation making it. */
  readonly opened = new Map<string, Promise<Opened>>();
  readonly idle: IdleHarnesses<Opened>;
  /** Side conversations' promotions to subagents (promotion.ts). */
  readonly promotions: Promotions;
  /** Verified closes after idle or a failed session; opens wait for them. */
  readonly recovering = new Map<string, Promise<void>>();
  private modelsValue: MutableModels | null = null;
  private syncCustom:
    | ((providers: Record<string, CustomProviderSpec>) => void)
    | null = null;
  /** Synchronous reads share the row owned by each open handle. */
  readonly liveRows = new Map<string, LiveRow>();
  views: DurableViews | null = null;
  /** Harness closes started by retire(), awaited again by a retry. */
  readonly retiring = new Map<string, Promise<unknown>>();
  /** Requested clears, mirrored in conversations/<cid>/clear.json. */
  readonly clears = new Map<string, ClearState>();
  /** Parent reports waiting for working conversations. */
  readonly reportHolds = new ReportHolds(this.liveRows, this.clears, (cid) =>
    this.deleting(cid),
  );
  /** Conversations whose storage is being replaced by a clear. */
  readonly rotating = new Set<string>();
  /** Each conversation's sends and clear requests, in order. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Each conversation's clear.json writes, in order. */
  readonly clearWrites = new Map<string, Promise<unknown>>();
  closing = false;
  private closingTask: Promise<void> | null = null;
  /** Stores kept at reap and clear, for revive. */
  readonly archive: AgentArchive;

  constructor(
    readonly deps: DurableHostDeps,
    readonly focusWaitMs = FOCUS_WAIT_MS,
  ) {
    this.promotions = new Promotions({
      ...deps,
      stopping: (cid) => this.closing || this.deleting(cid),
      serial: (cid, step) => this.serial(cid, step),
      open: (cid) => this.open(cid),
      storage: async (path) => {
        const rt = await runtime();
        return rt.openWorkerSqliteStorage(this.sqlite(rt), path);
      },
      models: () => this.models(),
      forget: (cid, main) => forgetFork(this, main, cid),
    });
    this.idle = new IdleHarnesses({
      idleMs: () => deps.harnessIdleMs ?? CONTEXT_RETENTION_MS,
      get: (cid) => this.opened.get(cid),
      blocked: (cid) =>
        this.closing ||
        this.deleting(cid) ||
        this.clears.has(cid) ||
        this.rotating.has(cid) ||
        this.recovering.has(cid),
      naming: (cid) => this.titleTasks.has(cid),
      serial: (cid, step) => this.serial(cid, step),
      close: async (cid, opened) => {
        // Invariant: Opens and sends wait for verified close.
        const closing = closeHarness(this, cid, opened).then(() => {
          if (this.opened.get(cid) === opened) this.opened.delete(cid);
          this.deps.log("durable_idle_close", { cid });
        });
        this.recovering.set(cid, closing);
        await closing;
        if (this.recovering.get(cid) === closing) this.recovering.delete(cid);
      },
      failed: (cid, error) =>
        deps.log("durable_idle_close_failed", { cid, error: String(error) }),
    });
    this.archive = new AgentArchive(
      join(deps.dataDir, "agent-archive"),
      async (path) => this.sqlite(await runtime()).openDatabase(path),
    );
  }

  /** The shared SQLite thread; `rt` is loaded first so one thread is made. */
  sqlite(rt: Runtime): SqliteWorker {
    return (this.worker ??= new rt.SqliteWorker());
  }

  imageService(): Promise<ImageProcessor> {
    return (this.images ??=
      import("@earendil-works/pi-durable/images/node").then(
        ({ createNodePhotonImages }) => createNodePhotonImages(),
      ));
  }

  // Archive a closed store as cid.key; true also for intentional skips.
  // Failure logs its cause at WARNING and returns false.
  async keepStore(
    cid: string,
    reason: ArchiveReason,
    key: string,
  ): Promise<boolean> {
    const conv = this.deps.load(cid);
    if (conv === null || conv.service_principal != null) return true;
    const parent = typeof conv.parent === "string" ? conv.parent : null;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    try {
      await this.archive.keep(join(this.storagePath(cid), ".."), {
        archive_id: `${cid}.${key}`,
        cid,
        reason,
        title: text(conv.title),
        parent,
        parent_title: parent
          ? text(this.deps.load(parent, ["title"])?.title)
          : null,
        top_level: parent === null,
        model: text(conv.model),
        effort: text(conv.effort),
        level: typeof conv.level === "number" ? conv.level : null,
        workdir: text(conv.workdir),
        created: typeof conv.created === "number" ? conv.created : null,
        archived: Date.now() / 1000,
      });
      return true;
    } catch (error) {
      this.deps.log(
        "durable_archive_failed",
        { cid, reason, error: String(error) },
        WARNING,
      );
      return false;
    }
  }

  // Validate/copy external history off the event loop, before creating an
  // agent.
  importArchive(path: string): Promise<ArchivedAgent> {
    return importArchive(this, path);
  }

  /** What the first open of a revived conversation settled (revive_doc.ts). */
  async revived(cid: string): Promise<ReviveState | undefined> {
    const { harness, conversation } = await this.open(cid);
    const { ReviveDoc } = await runtime();
    return harness.snapshot(ReviveDoc, conversation.id, context);
  }

  // A conversation whose deletion started (the reap stamps reap_deferred
  // before any effect, and it is never cleared) or whose record is gone.
  deleting(cid: string): boolean {
    const conv = this.deps.load(cid, ["reap_deferred"]);
    return conv === null || Boolean(conv.reap_deferred);
  }

  /** Whether `conv` is a Durable conversation. */
  owns(conv: Rec | null | undefined): boolean {
    return conv?.backend === "durable";
  }

  /** The shared Models, with Settings' current custom providers. */
  async models(): Promise<MutableModels> {
    if (this.modelsValue === null) {
      const rt = await runtime();
      this.modelsValue ??=
        this.deps.models ?? rt.durableModels(this.deps.piAgentDir);
      this.syncCustom ??= rt.customProviderSync(this.modelsValue, (provider) =>
        this.deps.customProviderEnvValue?.(provider),
      );
    }
    try {
      this.syncCustom!(this.deps.customProviders?.() ?? {});
    } catch {
      // Invariant: An unreadable model-providers.json keeps the last providers.
    }
    return this.modelsValue;
  }

  /** A Settings provider login's token, as Pi gives `"auth": { "provider" }`
   * MCP servers; undefined when signed out. */
  async providerToken(provider: string): Promise<string | undefined> {
    return (await runtime()).providerToken(await this.models(), provider);
  }

  storagePath(cid: string): string {
    return join(
      this.deps.dataDir,
      "conversations",
      cid,
      "durable",
      "session.sqlite",
    );
  }

  /** Background phases yield to other conversations' focused opens. */
  async yieldToFocus(
    excludeCid?: string,
    deadline = performance.now() + this.focusWaitMs,
  ): Promise<boolean> {
    const started = performance.now();
    for (;;) {
      const pending = [...this.onDemand].filter(
        ([, cid]) =>
          excludeCid === undefined ||
          (cid !== excludeCid &&
            this.deps.load(cid, ["side_of"])?.side_of !== excludeCid),
      );
      if (!pending.length) return true;
      const cids = pending
        .map(([, cid]) => cid)
        .slice(0, 3)
        .join(",");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<true>((done) => {
        timer = setTimeout(
          done,
          Math.max(0, deadline - performance.now()),
          true,
        );
      });
      const settled = Promise.allSettled(pending.map(([opened]) => opened));
      const bounded = await Promise.race([settled.then(() => false), late]);
      clearTimeout(timer);
      const waited_ms = Math.round(performance.now() - started);
      if (bounded) {
        this.deps.log(
          "durable_focus_wait_bounded",
          { cids, waited_ms },
          WARNING,
        );
        return false;
      }
    }
  }

  supportsImport(conv: Rec): Promise<boolean> {
    return supportsImport(this, conv);
  }

  /** Build historical storage only; never open a Harness that can run tools. */
  importPi(
    conv: Rec,
    options: Pick<PiImportOptions, "state" | "publish">,
    signal: AbortSignal,
  ): Promise<PiImportResult> {
    return importPi(this, conv, options, signal);
  }

  /** An on-demand open never waits for a background-resume slot. */
  open(cid: string): Promise<Opened> {
    const opened = this.getOpened(cid);
    this.onDemand.set(opened, cid);
    const settled = () => this.onDemand.delete(opened);
    void opened.then(settled, settled);
    timingDetail("conversation_open_cid", cid);
    return timed("conversation_open_wait", () => opened);
  }

  private getOpened(cid: string, background = false): Promise<Opened> {
    if (this.closing)
      return Promise.reject(new ServerStoppingError("server is stopping"));
    if (this.deleting(cid))
      return Promise.reject(new Error(`conversation is being deleted: ${cid}`));
    const recovery = this.recovering.get(cid);
    if (recovery)
      return recovery.then(
        () => this.getOpened(cid, background),
        () => {
          if (this.recovering.get(cid) === recovery) {
            const opened = this.opened.get(cid);
            const retry = closeHarness(this, cid, opened, true).then(() => {
              if (this.opened.get(cid) === opened) this.opened.delete(cid);
              if (this.recovering.get(cid) === retry)
                this.recovering.delete(cid);
            });
            this.recovering.set(cid, retry);
          }
          return this.recovering
            .get(cid)!
            .then(() => this.getOpened(cid, background));
        },
      );
    let opened = this.opened.get(cid);
    if (opened === undefined) {
      const parent = this.deps.load(cid, ["side_of"])?.side_of;
      opened =
        typeof parent === "string"
          ? openSide(this, cid, parent)
          : openHarness(this, cid, background);
      this.opened.set(cid, opened);
      this.watchFailure(cid, opened);
      opened.catch((error) => {
        this.opened.delete(cid);
        this.deps.log("durable_open_failed", { cid, error: String(error) });
      });
    }
    this.idle.retain(cid);
    return opened;
  }

  private watchFailure(cid: string, opened: Promise<Opened>): void {
    void opened.then(
      (handle) => {
        void handle.harness.closed.then((end) => {
          if (end.reason !== "failed" || this.opened.get(cid) !== opened)
            return;
          this.deps.log("durable_session_failed", {
            cid,
            error: String(end.error),
          });
          const cleanup = closeHarness(this, cid, opened, true).then(() => {
            if (this.opened.get(cid) === opened) this.opened.delete(cid);
            this.recovering.delete(cid);
          });
          this.recovering.set(cid, cleanup);
          void cleanup.catch((error) =>
            this.deps.log("durable_recovery_failed", {
              cid,
              error: String(error),
            }),
          );
        });
      },
      () => {},
    );
  }

  // Open every live Durable conversation, one at a time, so interrupted work
  // resumes.
  async openLive(): Promise<void> {
    const cids = this.deps
      .liveIds()
      .filter((cid) => this.owns(this.deps.load(cid, ["backend"])));
    for (const cid of cids) {
      if (this.closing) break;
      try {
        if (!this.closing) await this.getOpened(cid, true);
        this.promotions.resume(cid);
      } catch {}
    }
  }

  /**
   * Admit one input; resolves with its request id once Durable committed it,
   * or null when the conversation is being deleted (host/send.ts).
   */
  send(
    cid: string,
    content: string,
    requestId: string,
    options: SendOptions = {},
  ): Promise<string | null> {
    return send(this, cid, content, requestId, options);
  }

  /** Run `step` after the conversation's earlier sends and clear requests. */
  serial<T>(cid: string, step: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(cid) ?? Promise.resolve()).then(step);
    const tail = result.catch(() => undefined);
    this.chains.set(cid, tail);
    void tail.then(() => {
      if (this.chains.get(cid) === tail) this.chains.delete(cid);
    });
    return result;
  }

  /**
   * Withdraw one queued input by its request id (also one held by a clear).
   * False when it already reached the transcript or does not exist.
   */
  cancel(cid: string, requestId: string): Promise<boolean> {
    return cancel(this, cid, requestId);
  }

  /** Clear once queued input has run and reports are delivered (clear.ts). */
  clear(cid: string): Promise<Rec | null> {
    return requestClear(this, cid);
  }

  // Rotate requested clear only when idle, queue empty and reports delivered.
  // Failed close keeps storage for retry. Report passes must not kick reporting
  // again, or each pass would trigger the next forever.
  async maybeRotate(cid: string, reported = false): Promise<void> {
    const clear = this.clears.get(cid);
    const opened = this.opened.get(cid);
    if (
      clear === undefined ||
      clear.rotated ||
      opened === undefined ||
      this.rotating.has(cid) ||
      this.closing ||
      this.deleting(cid)
    )
      return;
    const handle = await opened.catch(() => null);
    if (handle === null || !handle.ready) return;
    const { InboxDoc, LiveDoc } = await runtime();
    const idle = async () =>
      (await handle.harness.snapshot(LiveDoc, handle.conversation.id, context))
        ?.run === undefined &&
      !(
        await handle.harness.snapshot(InboxDoc, handle.conversation.id, context)
      )?.items.length;
    if (!(await idle())) return;
    if (handle.reporter !== null) {
      if (!reported) await handle.reporter.kick();
      if (!handle.reporter.caughtUp) return;
    }
    if (!(await idle())) return;
    // Invariant: Commits and report passes call this concurrently: only the
    // first past the last await rotates.
    if (
      this.rotating.has(cid) ||
      this.opened.get(cid) !== opened ||
      this.clears.get(cid) !== clear ||
      clear.rotated ||
      this.closing ||
      this.deleting(cid)
    )
      return;
    this.rotating.add(cid);
    this.deps.log("durable_clear", { cid, held: clear.held.length });
    // Invariant: Rotation retires the storage that holds the forks.
    this.deps.clearingSides?.(cid);
    const rotation = (async () => {
      try {
        await closeHarness(this, cid, opened);
        await retireCleared(this, cid, clear);
        return await openHarness(this, cid);
      } finally {
        this.rotating.delete(cid);
        this.idle.retain(cid);
      }
    })();
    this.opened.set(cid, rotation);
    this.watchFailure(cid, rotation);
    rotation.catch((error) => {
      if (this.opened.get(cid) === rotation) this.opened.delete(cid);
      this.deps.log("durable_clear_failed", { cid, error: String(error) });
    });
  }

  /** Queued rows, then the rows a clear holds. */
  private pendingRows(cid: string): Rec[] {
    const held = (this.clears.get(cid)?.held ?? []).map((item) => {
      const [origin, sender, senderName, content] = splitPiUserText(
        item.content,
      );
      return {
        id: item.requestId,
        role: "user",
        content,
        ...(origin ? { origin } : {}),
        ...(sender ? { from: sender } : {}),
        ...(senderName ? { from_name: senderName } : {}),
      };
    });
    const row = this.liveRows.get(cid);
    const rows = [...(row?.pending ?? []), ...held];
    const error = row?.modelError;
    if (error !== undefined && rows[0]) rows[0] = { ...rows[0], error };
    return rows;
  }

  /** ["clear"] while a requested clear waits. */
  private pendingActions(cid: string): string[] {
    return this.clears.has(cid) ? ["clear"] : [];
  }

  async live(cid: string): Promise<Readonly<LiveState> | undefined> {
    const { harness, conversation } = await this.open(cid);
    const { LiveDoc } = await runtime();
    return harness.snapshot(LiveDoc, conversation.id, context);
  }

  /**
   * Abort the current run, or only `expectedRun` when given; queued input
   * stays queued. False when no matching run was in progress.
   */
  async stop(cid: string, expectedRun?: string): Promise<boolean> {
    const { harness } = await this.open(cid);
    const run = (await this.live(cid))?.run;
    if (run === undefined) return false;
    if (expectedRun !== undefined && String(run.taskId) !== expectedRun)
      return false;
    await harness.abortTask(run.taskId, context);
    return true;
  }

  // The operator's /compact: start a manual compaction, which summarizes while
  // the conversation keeps working and places its summary at the next boundary.
  // Null when the conversation is being deleted.
  async compact(cid: string): Promise<Rec | null> {
    if (this.deleting(cid)) return null;
    const opened = await this.open(cid);
    await opened.compact();
    return { id: cid, action: "compact", queued: this.isRunning(cid) };
  }

  // "Stop processes": stop the conversation's shell groups in the background
  // and log the outcome; the run, if any, keeps going. False when the
  // conversation is being deleted.
  async stopProcesses(cid: string): Promise<boolean> {
    if (this.deleting(cid)) return false;
    const { harness, conversation } = await this.open(cid);
    const { stopConversationShells } = await runtime();
    void stopConversationShells(harness, conversation.id, context).then(
      (result) => this.deps.log("durable_stop_processes", { cid, ...result }),
      (error) =>
        this.deps.log("durable_stop_processes_failed", {
          cid,
          error: String(error),
        }),
    );
    return true;
  }

  /** Authoritative run status for Stop, independent of the deferred tracker. */
  async stopStatus(cid: string): Promise<[string | null, string | null]> {
    const run = (await this.live(cid))?.run;
    return run === undefined ? [null, null] : ["running", String(run.taskId)];
  }

  isRunning(cid: string): boolean {
    return this.liveRows.get(cid)?.runId !== undefined && !this.deleting(cid);
  }

  /** Commit-published [status, run id] for rows and lifecycle reads. */
  liveStatus(cid: string): [string | null, string | null] {
    const run = this.isRunning(cid) ? this.liveRows.get(cid)?.runId : undefined;
    return run === undefined ? [null, null] : ["running", run];
  }

  /** Reap: close with verified cleanup, then retire storage (delete.ts). */
  retire(cid: string, timeoutMs = RETIRE_CLOSE_MS): Promise<boolean> {
    return retire(this, cid, timeoutMs);
  }

  /** Where a conversation's shell records live, and how its groups stop. */
  shellState(cid: string) {
    return {
      stateDir: join(this.storagePath(cid), "..", "shells"),
      stopGroup: (group: ShellGroup) => this.deps.stopGroup(group),
    };
  }

  /** The latest captured request, for the inspector (host/reads.ts). */
  prompt(cid: string): Promise<Rec> {
    return prompt(this, cid);
  }

  /** Full payloads, addressed by their existing tool task identity. */
  toolDetails(cid: string, artifactId: string): Promise<Rec | null> {
    return toolDetails(this, cid, artifactId);
  }

  /** Operator-only control, called by AgentNode.setSafety before its notice. */
  async setSafetyReviewOff(cid: string, off: boolean): Promise<void> {
    const { conversation, row } = await this.open(cid);
    const safety = await runtime();
    await safety.setSafetyReviewOff(conversation, off, context);
    row.safetyOff = off;
    if (off) row.safetyUnavailable = undefined;
    this.deps.safetyChanged?.(cid);
  }

  /** Durable's persisted chdir cwd, also used in runtime prompts. */
  async effectiveCwd(cid: string): Promise<string | null> {
    const { conversation } = await this.open(cid);
    return (await conversation.agent(context)).cwd ?? null;
  }

  // Atomically change tool environment overrides for the next tool call.
  // An empty change reads; invalid changes return refusal, not storage errors.
  async changeEnvironment(
    cid: string,
    change: EnvironmentChange,
  ): Promise<{ names: string[]; absent: string[] } | { refused: string }> {
    const { conversation, harness } = await this.open(cid);
    const { EnvironmentDoc, changedOverrides } = await runtime();
    let before: string[] = [];
    let refused: string | undefined;
    let after = (
      await harness.snapshot(EnvironmentDoc, conversation.id, context)
    )?.overrides;
    if (change.unset.length || Object.keys(change.set).length)
      after = await conversation.commit(async (tx) => {
        const doc = await tx.doc(EnvironmentDoc, conversation.id);
        // Invariant: The draft is only readable inside the transaction.
        before = Object.keys(doc.overrides);
        try {
          // Invariant: Pure validation: its throws are refusals, never storage
          // errors.
          return (doc.overrides = changedOverrides(doc.overrides, change));
        } catch (error) {
          refused = (error as Error).message;
          return undefined;
        }
      }, context);
    if (refused !== undefined) return { refused };
    return {
      names: Object.keys(after ?? {}).sort(),
      absent: change.unset.filter((name) => !before.includes(name)),
    };
  }

  /** Whether recurse.safety turns review off, once the Harness has read it. */
  safetyReviewOff(cid: string): boolean | undefined {
    return this.liveRows.get(cid)?.safetyOff;
  }

  /** Load the Durable runtime modules (the server does before listening). */
  async loadRuntime(): Promise<void> {
    await runtime();
  }

  /** Build the shared Models and Settings' catalog before listening, so the
   * first open does neither on the main thread after it. Best-effort: on
   * failure it logs and the first open builds them as before. */
  async warmOpen(): Promise<void> {
    try {
      await this.models();
      this.deps.warmSettings?.();
    } catch (error) {
      this.deps.log(
        "durable_open_warm_failed",
        { error: String(error) },
        WARNING,
      );
    }
  }

  searchService(Worker: typeof FffWorker): FffWorker {
    return (this.searchWorker ??= new Worker(process.env));
  }

  /** Start the search thread and import pi-fff on it, so the first open
   * waits for neither. Best-effort: on failure it logs, drops that thread,
   * and the next open starts one the lazy way. */
  warmSearch(): void {
    let worker: FffWorker | undefined;
    void runtime()
      .then(({ FffWorker }) => {
        if (this.closing) return;
        worker = this.searchService(FffWorker);
        return worker.warm();
      })
      .catch((error: unknown) => {
        this.deps.log(
          "durable_search_warm_failed",
          { error: String(error) },
          WARNING,
        );
        if (!worker || this.searchWorker !== worker || this.closing) return;
        this.searchWorker = null;
        this.retiredSearch = worker
          .close()
          .catch((closeError: unknown) =>
            this.deps.log(
              "durable_search_close_failed",
              { error: String(closeError) },
              WARNING,
            ),
          );
      });
  }

  /** How many Durable conversations have a run in progress. */
  runningCount(): number {
    return this.runningConversations().length;
  }

  /** The ids of the Durable conversations with a run in progress. */
  runningConversations(): string[] {
    return [...this.liveRows.keys()].filter((cid) => this.isRunning(cid));
  }

  /** The conversation's file collection: its agent environment's, as on Pi. */
  collection(cid: string, env: Record<string, string>): string {
    return (
      env.RECURSE_COLLECTION_DIR ||
      join(this.deps.dataDir, "conversations", cid, "files")
    );
  }

  // Read files by call ID for publish-CLI bash calls and legacy attachment
  // calls.
  // The bash environment names the publication's owning conversation and call.
  private async publishedFiles(
    cid: string,
    callIds: readonly string[],
  ): Promise<Record<string, unknown[]>> {
    const { publishedCallFiles } =
      await import("../runtime/attachments/published.ts");
    const env = await this.deps.agentEnv(this.deps.load(cid)!);
    const files = await publishedCallFiles(this.collection(cid, env), cid);
    return Object.fromEntries(
      callIds
        .filter((id) => Object.hasOwn(files, id))
        .map((id) => [id, files[id]!]),
    );
  }

  /** A prompt's context files and skills, read off the event loop. */
  async promptResources(
    cwd: string,
    agentDir: string,
    skillPaths: string[],
  ): Promise<PromptResources> {
    const { PromptResourcesWorker, loadPromptResources } =
      await import("./prompt_resources.ts");

    if (this.closing) return loadPromptResources(cwd, agentDir, skillPaths);
    this.promptWorker ??= new PromptResourcesWorker((error) =>
      this.deps.log(
        "durable_prompt_resources_fallback",
        { error: error.message },
        WARNING,
      ),
    );
    return this.promptWorker.load(cwd, agentDir, skillPaths);
  }

  /** The /view page of a Durable conversation. */
  async view(cid: string, options: PageOptions = {}): Promise<Rec> {
    const { conversation, harness } = await this.open(cid);
    const { DurableViews } = await runtime();
    return (this.views ??= new DurableViews()).page(
      cid,
      harness,
      conversation,
      context,
      {
        pending: this.pendingRows(cid),
        pending_actions: this.pendingActions(cid),
      },
      options,
      (callIds) => this.publishedFiles(cid, callIds),
    );
  }

  // Overlay live run, queue and safety state on metadata. Review hooks read
  // recurse.safety per call, so desired and effective state are equal.
  metadata(cid: string): {
    status: string;
    active_run: string | null;
    pending: Rec[];
    pending_actions: string[];
    safety_off: boolean;
    safety_off_active: boolean;
    safety_unavailable: string | null;
  } {
    const row = this.liveRows.get(cid);
    const run = this.liveStatus(cid)[1];
    const off = row?.safetyOff ?? false;
    return {
      status: run === null ? "idle" : "running",
      active_run: run,
      pending: this.pendingRows(cid),
      pending_actions: this.pendingActions(cid),
      safety_off: off,
      safety_off_active: off,
      safety_unavailable: off ? null : (row?.safetyUnavailable ?? null),
    };
  }

  // Live shells from open Harness tasks, newest first, without I/O.
  // Include tasks still stopping groups not yet proven gone.
  shells(cid: string, nowMs = Date.now()) {
    const items = [...(this.liveRows.get(cid)?.shells.values() ?? [])]
      .map((input) => ({
        id: input.shellId,
        pid: input.pid,
        pgid: input.pid,
        identity: input.identity,
        command: input.command,
        mode: input.mode,
        status: "running" as const,
        started_at: input.startedAt / 1000,
        elapsed_seconds: Math.max(0, (nowMs - input.startedAt) / 1000),
      }))
      .sort((a, b) => b.started_at - a.started_at);
    return {
      status: "ready" as const,
      items,
      truncated: false,
      active_count: items.length,
      background_count: items.length,
    };
  }

  /** The subagent CLI's transcript window (transcript.ts). */
  async transcript(cid: string, options: TranscriptQuery): Promise<Rec> {
    const { conversation } = await this.open(cid);
    const { transcriptWindow } = await import("./transcript.ts");
    return transcriptWindow(conversation, options, context);
  }

  /** One 64-entry usage page and the latest bounded request capture. */
  contextUsage(cid: string): Promise<Rec> {
    return contextUsage(this, cid);
  }

  // Full thinking of the reply at entry `offset`, or of the live answer at -1.
  thinking(cid: string, offset: number): Promise<Rec | null> {
    return thinking(this, cid, offset);
  }

  /** The stored model input or reply, addressed by Durable entry id. */
  turnPrompt(cid: string, offset: number): Promise<Rec | null> {
    return turnPrompt(this, cid, offset);
  }

  /** The summary of the compaction entry at `offset`. */
  markerSummary(cid: string, offset: number): Promise<Rec | null> {
    return markerSummary(this, cid, offset);
  }

  // Stop recorded groups before Harness close, even for abort-ignoring tools.
  // Refuse later opens; pending close keeps storage under the directory lock.
  // Shell tasks survive for restart notices; reject naming any surviving pids.
  close(): Promise<void> {
    return (this.closingTask ??= this.shutdown());
  }

  private async shutdown(): Promise<void> {
    const failures = await closeAll(this);
    await this.archive.close().catch(() => undefined);
    this.worker?.close();
    await this.searchWorker?.close();
    await this.retiredSearch;
    await this.promptWorker?.close();
    if (failures.length)
      throw new Error(
        `shell processes survived shutdown: ${failures.join("; ")}`,
      );
  }
}
