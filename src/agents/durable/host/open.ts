// Open a conversation's Harness in steps: settings and environment, extensions,
// storage, root, side forks, live row, interrupted commands, held clear input,
// then resume. A failed open closes everything it allocated. Side conversations
// open as forks followed in their parent's Harness.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models, MutableModels } from "@earendil-works/pi-ai";
import type {
  Conversation,
  Extension,
  Harness,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { DurableHost } from "../host.ts";
import type { LiveRow, ShellInput } from "../follow.ts";
import type { Reporter } from "../report.ts";
import type { RequestCaptures } from "../request_capture.ts";
import { modelRef, requireModel } from "../model_selection";
import { INFO, WARNING } from "../../../observability/runtime_logging";
import {
  awaitedSpan,
  slowSpan,
  startOpenPhase,
} from "../../../observability/slow_span";
import { resumeClear, submitHeld, type ClearState } from "./clear.ts";
import { syncAgent } from "./send.ts";
import {
  CONTEXT_RETENTION_MS,
  failureLog,
  installHooks,
  installTools,
  type Tools,
} from "./registry.ts";
import { runtime, type Runtime } from "./load.ts";
import { DurableActivity } from "../activity";

type Rec = Record<string, unknown>;
type Inspection = Awaited<ReturnType<Harness["inspect"]>>;

const SLOW_OPEN_MS = 250;

export interface Opened {
  activity: DurableActivity;
  row: LiveRow;
  harness: Harness;
  conversation: Conversation;
  compact(target?: Conversation): Promise<string>;
  close(options?: { shellStop?: Promise<void> }): Promise<void>;
  shells: ReturnType<Runtime["createShells"]>;
  captures: RequestCaptures;
  transforms: ReturnType<Runtime["createModelClock"]>;
  storage: SqliteStorage;
  reporter: Reporter | null;
  /** Set once resume() ran: queued input may be promoted. */
  ready: boolean;
  /** A side conversation's parent; its Harness belongs to that parent. */
  parent?: string;
  /** The extension a side fork adds to its parent's selection. */
  side: Extension;
  /** Provider session id → conversation id, for request capture. */
  sessions: Map<string, string>;
  /** Side session id → its parent's session id, sent to providers instead. */
  parentSessions: Map<string, string>;
  /** Each followed Durable conversation of this Harness, by its id. */
  followed: Map<string, Conversation>;
  /** Durable conversation id → the conversation id that owns it. */
  owners: Map<string, string>;
  /** The side conversations following this Harness, by side cid. */
  attached: Map<string, Promise<Opened>>;
}

export interface Opening extends Pick<
  Opened,
  "row" | "sessions" | "parentSessions" | "followed" | "owners" | "attached"
> {
  cid: string;
  /** The conversation's record when the open began. */
  conv: Rec;
  models: MutableModels;
  requestModels?: Models;
  model: ReturnType<typeof modelRef>;
  effort: string;
  /** The conversation's workdir: the cwd until the agent changes it. */
  cwd: string;
  /** The conversation's session.sqlite. */
  path: string;
  /** The agent environment its tools run with. */
  env: Record<string, string>;
  /** A requested clear; once rotated, its held input awaits submission. */
  clear: ClearState | undefined;
  activity?: DurableActivity;
  storage?: SqliteStorage;
  harness?: Harness;
  conversation?: Conversation;
}

/** Wall costs and overlapping open context, never exclusive CPU attribution. */
class OpenTiming {
  private readonly started: number;
  private mark: number;
  private envMark: number;
  private rootMark?: number;
  private focusWaitMs = 0;
  private readonly phases: Rec = {};
  /** Environment and storage costs, logged only for a slow open. */
  private readonly detail: Record<string, number> = {};
  private readonly scope: ReturnType<typeof startOpenPhase>;

  constructor(
    private readonly now: () => number,
    cid: string,
  ) {
    this.started = this.mark = this.envMark = now();
    this.scope = startOpenPhase(cid);
  }

  begin(name: string): void {
    this.scope.begin(name);
  }

  close(): void {
    this.scope.close();
  }

  /** End phase `name`, which began where the previous phase ended. */
  readonly phase = (name: string): void => {
    const at = this.now();
    this.phases[`${name}_ms`] = Math.round(at - this.mark);
    this.mark = this.envMark = at;
  };

  /** End a root subphase without changing the enclosing root phase. */
  rootStep(name: string): void {
    const at = this.now();
    this.phases[`root_${name}_ms`] = Math.round(
      at - (this.rootMark ?? this.mark),
    );
    this.rootMark = at;
  }

  /** Charge admission waits separately from the phase that yielded. */
  async focusWait(wait: () => Promise<void>): Promise<void> {
    const started = this.now();
    await wait();
    const elapsed = this.now() - started;
    this.focusWaitMs += elapsed;
    this.mark += elapsed;
    this.envMark += elapsed;
  }

  /** Add `ms` to environment step `name`. */
  readonly env = (name: string, ms: number): void => {
    const key = `env_${name}_ms`;
    this.detail[key] = (this.detail[key] ?? 0) + Math.round(ms);
  };

  /** End environment step `name`, which began at the previous step's end. */
  envStep(name: string): void {
    const at = this.now();
    this.env(name, at - this.envMark);
    this.envMark = at;
  }

  /** Start the next environment step now, after self-timed work. */
  envRestart(): void {
    this.envMark = this.now();
  }

  readonly storage = (costs: Record<string, number | undefined>): void => {
    for (const [name, value] of Object.entries(costs))
      if (value !== undefined)
        this.detail[`storage_${name}`] = Math.round(value);
  };

  log(host: DurableHost, cid: string): void {
    const total = Math.round(this.mark - this.started);
    host.deps.log(
      "durable_open",
      {
        cid,
        ...this.phases,
        focus_wait_ms: Math.round(this.focusWaitMs),
        ...(total > SLOW_OPEN_MS ? this.detail : {}),
        total_ms: total,
      },
      total > SLOW_OPEN_MS ? WARNING : INFO,
    );
  }
}

/**
 * Open `cid`'s own Harness and resume its work. A failure closes everything
 * the open allocated before it rethrows.
 */
export async function openHarness(
  host: DurableHost,
  cid: string,
  background = false,
): Promise<Opened> {
  const allocated: { close?: () => Promise<void> } = {};
  const timing = new OpenTiming(
    host.deps.openClock ?? (() => performance.now()),
    cid,
  );
  try {
    return await openSteps(host, cid, background, allocated, timing);
  } catch (error) {
    timing.begin("cleanup");
    await allocated.close?.();
    throw error;
  } finally {
    timing.close();
  }
}

async function openSteps(
  host: DurableHost,
  cid: string,
  background: boolean,
  allocated: { close?: () => Promise<void> },
  timing: OpenTiming,
): Promise<Opened> {
  const wait = focusYield(host, cid, background);
  const yieldToFocus = () => timing.focusWait(wait);
  await yieldToFocus();
  const { rt, ...setup } = await prepare(host, cid, timing, yieldToFocus);
  timing.begin("tools");
  const target: Opening = {
    ...setup,
    cid,
    row: { pending: [], shells: new Map() },
    sessions: new Map(),
    parentSessions: new Map(),
    followed: new Map(),
    owners: new Map(),
    attached: new Map(),
  };
  const tools = await awaitedSpan("durable_install_tools", cid, () =>
    installTools(host, rt, target, yieldToFocus, timing.phase),
  );
  const close = closer(host, target, tools);
  allocated.close = close;
  timing.begin("safety");
  const hooks = slowSpan("durable_install_hooks", cid, () =>
    installHooks(host, rt, target, tools),
  );
  timing.phase("safety");
  await yieldToFocus();
  const harness = await openStorage(host, rt, target, tools, hooks, timing);
  const conversation = await openRoot(host, rt, target, hooks.readyMcp, timing);
  timing.phase("root");
  timing.begin("track");
  const opened = slowSpan("durable_handle", cid, () =>
    handle(host, rt, target, tools, hooks, close),
  );
  await attachForks(host, rt, cid, opened);
  const tracking = await follow(host, cid, rt, opened, target.conv, () => {
    void tools.mcp.close();
  });
  await awaitedSpan("pi_track_projection", cid, () => tracking.track());
  timing.phase("track");
  timing.begin("recover");
  // Invariant: Groups a killed server left behind stop before their tasks
  // resume. A group not proven gone fails the open (and keeps its record), so
  // no work resumes beside it; the next open retries.
  const pending = await rt.recoverInterruptedCommands(
    harness,
    tools.shellState,
    context,
  );
  if (pending.length)
    throw new Error(
      `processes of an interrupted command survived: ${pending.join(", ")}`,
    );
  timing.phase("recover");
  timing.begin("resume");
  if (target.clear?.rotated)
    await submitHeld(host, cid, target.clear, conversation);
  const inspection = await awaitedSpan("pi_inspect", cid, () =>
    harness.inspect(context),
  );
  await showShells(host, rt, target, inspection);
  opened.activity.start(inspection);
  if (typeof target.conv.revived_from === "string")
    await rt.settleRevive(
      harness,
      conversation,
      target.storage!,
      target.conv.revived_from,
      target.cwd,
    );
  slowSpan("durable_resume", cid, () => harness.resume());
  timing.phase("resume");
  timing.log(host, cid);
  opened.ready = true;
  void tracking.retrack();
  void opened.reporter?.kick();
  return opened;
}

/** A background open's yield to focused opens, within one overall budget. */
function focusYield(
  host: DurableHost,
  cid: string,
  background: boolean,
): () => Promise<void> {
  const deadline = performance.now() + host.focusWaitMs;
  let expired = false;
  return async () => {
    if (background && !expired && performance.now() < deadline)
      expired = !(await host.yieldToFocus(cid, deadline));
  };
}

/** Settings, a clear stopped while archiving, the storage directory, the
 * agent environment and the publish collection. */
async function prepare(
  host: DurableHost,
  cid: string,
  timing: OpenTiming,
  yieldToFocus: () => Promise<void>,
) {
  timing.begin("runtime");
  const conv = slowSpan("durable_load_record", cid, () => host.deps.load(cid));
  if (conv === null || !host.owns(conv))
    throw new Error(`not a durable conversation: ${cid}`);
  const rt = await runtime();
  const models = await host.models();
  timing.phase("runtime");
  timing.begin("env_settings");
  const [modelId, effort] = host.deps.settings(conv);
  const model = modelRef(modelId);
  requireModel(models, model);
  const cwd = String(conv.workdir ?? host.deps.dataDir);
  const path = host.storagePath(cid);
  timing.envStep("settings");
  timing.begin("env_clear");
  const clear = await resumeClear(host, cid);
  timing.envStep("clear");
  timing.begin("env_dir");
  await slowSpan("env_dir_mkdir_call", cid, () =>
    mkdir(join(path, ".."), { recursive: true, mode: 0o700 }),
  );
  timing.envStep("dir");
  await yieldToFocus();
  timing.begin("env_build");
  const env = await slowSpan("durable_agent_env_call", cid, () =>
    host.deps.agentEnv(conv, timing.env),
  );
  timing.envRestart();
  timing.begin("env_files");
  // Invariant: Every run, resumed or new, runs on an open Harness: publishing
  // works from its first tool call, as TurnPrep's admission gives a Pi turn.
  await host.deps.admitFiles?.(conv);
  timing.envStep("files");
  timing.phase("env");
  return { rt, conv, models, model, effort, cwd, path, env, clear };
}

/** The open's close: sides, captures, the Harness (or its unopened storage),
 * the live row, then the tools' processes and threads. */
function closer(
  host: DurableHost,
  target: Opening,
  tools: Tools,
): Opened["close"] {
  const { cid, row, attached } = target;
  return async (options = {}) => {
    host.idle.forget(cid);
    await target.activity?.close();
    tools.warmer.close();
    host.cacheWarmers.delete(tools.warmer);
    for (const [side, handle] of attached) {
      if (host.opened.get(side) !== undefined) host.opened.delete(side);
      await (await handle.catch(() => null))?.close();
    }
    attached.clear();
    await tools.captures.close();
    try {
      if (target.harness) await target.harness.close(context);
      else await target.storage?.close(context);
    } finally {
      if (host.liveRows.get(cid) === row) {
        host.liveRows.delete(cid);
        host.reconcileCacheWarmers();
        host.views?.drop(cid);
        host.reportHolds.closed(cid, host.closing);
        if (row.runId !== undefined || row.shells.size)
          host.deps.rowChanged?.(cid);
      }
      await tools.release(options.shellStop);
    }
  };
}

/** Open the conversation's storage, then a Harness on it. */
async function openStorage(
  host: DurableHost,
  rt: Runtime,
  target: Opening,
  tools: Tools,
  hooks: ReturnType<typeof installHooks>,
  timing: OpenTiming,
): Promise<Harness> {
  const { cid, row, cwd, env: baseEnv } = target;
  timing.begin("storage");
  const storage = await host.messageSearch.withStores([target.path], () =>
    rt.openWorkerSqliteStorage(
      host.sqlite(rt),
      target.path,
      (code) => host.deps.log("durable_write_refused", { cid, code }, WARNING),
      timing.storage,
      false,
      false,
      cid,
    ),
  );
  target.storage = storage;
  timing.phase("storage");
  timing.begin("harness");
  const { registry, context: contextExtension } = tools;
  const { side } = hooks;
  // Invariant: Match Pi: idle admission starts only the oldest input; a
  // running turn receives all queued steers together at its next boundary.
  target.requestModels = rt.shareParentSession(hooks.models, (id) =>
    target.parentSessions.get(id),
  );
  target.harness = await rt.Harness.open(
    storage,
    {
      models: rt.withRequestedEffort(
        rt.captureRequests(target.requestModels, tools.captures),
      ),
      registry,
      settings: {
        // Invariant: Only side forks select the side extension.
        get extensions() {
          return registry
            .snapshot()
            .installed()
            .filter((extension) => extension !== side);
        },
        get steeringMode() {
          return row.runId !== undefined ? "all" : "one-at-a-time";
        },
        get compaction() {
          return contextExtension.compaction;
        },
        contextRetentionMs: CONTEXT_RETENTION_MS,
      },
      env: async (envTarget, ctx) => {
        const overrides = (
          await envTarget.read.snapshot(
            rt.EnvironmentDoc,
            envTarget.conversationId,
            ctx,
          )
        )?.overrides;
        return new rt.NodeExecutionEnv({
          cwd: envTarget.cwd ?? cwd,
          shellEnv: {
            ...rt.scopedEnvironment(baseEnv, overrides),
            RECURSE_WORKDIR: envTarget.cwd ?? cwd,
          },
        });
      },
      onReport: (report) => {
        const { error } = report;
        const task = "task" in report ? report.task : undefined;
        host.deps.log("durable_extension_report", {
          cid,
          type: report.kind,
          ...(task ? { task: Number(task.id), kind: task.kind } : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      },
    },
    context,
  );
  timing.phase("harness");
  return target.harness;
}

/** The root conversation, with MCP ready if it offered codemode, imported
 * settings sanitized and the report generation recorded. */
async function openRoot(
  host: DurableHost,
  rt: Runtime,
  target: Opening,
  readyMcp: () => Promise<void>,
  timing: OpenTiming,
): Promise<Conversation> {
  const { conv, model, effort } = target;
  const harness = target.harness!;
  timing.begin("root_conversation");
  const conversation = await awaitedSpan("pi_root", target.cid, () =>
    harness.root(context, {
      agent: { model, thinkingLevel: effort as never, cwd: target.cwd },
    }),
  );
  target.conversation = conversation;
  timing.rootStep("conversation");
  timing.begin("root_snapshot");
  const live = await awaitedSpan("pi_live_snapshot", target.cid, () =>
    harness.snapshot(rt.LiveDoc, conversation.id, context),
  );
  timing.rootStep("snapshot");
  timing.begin("root_mcp");
  if (live?.tools?.some((slot) => slot.name === "codemode"))
    await readyMcp().catch(
      failureLog(host, target.cid)("durable_mcp_recovery_failed"),
    );
  timing.rootStep("mcp");
  timing.begin("root_import");
  // Invariant: Foreign stored settings are never trusted. Do this before
  // recovery/resume.
  if (
    typeof conv.revived_from === "string" &&
    (await host.archive.get(conv.revived_from))?.origin_path
  ) {
    const { sanitizeImported } = await import("../revive_doc");
    if (
      await sanitizeImported(
        harness,
        conversation,
        model,
        effort as never,
        conv.revived_from,
        context,
      )
    )
      await rt.setSafetyReviewOff(conversation, false, context);
  }
  timing.rootStep("import");
  timing.begin("root_report");
  await rt.ensureReportGeneration(harness, conversation);
  timing.rootStep("report");
  return conversation;
}

/** The open handle, with its run reporter, following its root. */
function handle(
  host: DurableHost,
  rt: Runtime,
  target: Opening,
  tools: Tools,
  hooks: ReturnType<typeof installHooks>,
  close: Opened["close"],
): Opened {
  const { cid } = target;
  const harness = target.harness!;
  const conversation = target.conversation!;
  const storage = target.storage!;
  const deliver = host.deps.report;
  const reporter =
    deliver === undefined
      ? null
      : new rt.Reporter({
          child: cid,
          harness,
          conversation,
          storage,
          deliver: (report) => deliver(cid, report),
          log: (event, fields) => host.deps.log(event, fields),
          onCaughtUp: () => {
            target.activity?.refresh();
            void host.maybeRotate(cid, true);
          },
          holds: host.reportHolds,
        });
  target.followed.set(String(conversation.id), conversation);
  target.owners.set(String(conversation.id), cid);
  const activity = (target.activity = new DurableActivity(
    join(target.path, "..", "activity"),
    () =>
      (reporter !== null && !reporter.caughtUp) ||
      [...target.owners.values()].some((id) => {
        const row = host.liveRows.get(id);
        return Boolean(row?.runId || row?.queued || row?.shells.size);
      }),
    (error) =>
      host.deps.log(
        "durable_activity_failed",
        { cid, error: String(error) },
        WARNING,
      ),
  ));
  return {
    activity,
    row: target.row,
    harness,
    conversation,
    compact: (compacted = conversation) =>
      tools.context.compact(harness, compacted, context),
    close,
    shells: tools.shells,
    captures: tools.captures,
    transforms: hooks.transforms,
    storage,
    reporter,
    ready: false,
    sessions: target.sessions,
    parentSessions: target.parentSessions,
    followed: target.followed,
    owners: target.owners,
    attached: target.attached,
    side: hooks.side,
  };
}

/** Follow every stored side fork, or drop it if its side conversation is
 * gone. */
async function attachForks(
  host: DurableHost,
  rt: Runtime,
  cid: string,
  opened: Opened,
): Promise<void> {
  const { harness, conversation, attached } = opened;
  // Invariant: Every fork is followed before resume(), so its resumed work
  // is attributed and recovered like any conversation's; a fork whose side
  // conversation is gone is dropped instead, so it never runs again.
  for (const [side, fork] of Object.entries(
    await rt.sideForks(harness, conversation),
  )) {
    const forked = await harness.conversation(
      fork.conversation as Conversation["id"],
      context,
    );
    if (host.deps.load(side, ["side_of"])?.side_of !== cid || !forked)
      await rt.dropFork(harness, conversation, side);
    else
      attached.set(
        side,
        attachSide(host, side, cid, opened, forked, fork.sessionId),
      );
  }
  await Promise.all(attached.values());
}

/** Show the root's shell tasks in its live row. */
async function showShells(
  host: DurableHost,
  rt: Runtime,
  target: Opening,
  inspection: Inspection,
): Promise<void> {
  const { row, cid } = target;
  const conversation = target.conversation!;
  // Invariant: Before resume() no task runs, so no shell task changes until
  // the commit listener above takes over.
  for (const { record } of inspection.tasks)
    if (
      record.kind === rt.SHELL_TASK &&
      record.conversationId === conversation.id
    )
      row.shells.set(record.id, record.input as unknown as ShellInput);
  if (row.runId !== undefined || row.shells.size) host.deps.rowChanged?.(cid);
}

/** Keep `opened`'s live row and queue current from its commits. */
async function follow(
  host: DurableHost,
  cid: string,
  rt: Runtime,
  opened: Opened,
  conv: Rec,
  onIdle?: () => void,
) {
  const { row } = opened;
  host.liveRows.set(cid, row);
  return rt.followConversation({
    cid,
    harness: opened.harness,
    conversation: opened.conversation,
    row,
    reporter: opened.reporter,
    root: opened.parent === undefined,
    ready: () => opened.ready,
    state: () => ({
      closing: host.closing,
      rotating: host.rotating.has(cid),
      deleting: host.deleting(cid),
    }),
    current: () => host.liveRows.get(cid) === row,
    activityChanged: () => {
      host.reconcileCacheWarmers();
      opened.activity.refresh();
    },
    committed: (publication) => {
      if (opened.parent === undefined) {
        opened.activity.committed(publication);
        host.messageSearch.schedule(host.searchTarget(cid), publication);
      }
    },
    contextChanged: () => host.invalidatePromptCache(cid),
    syncAgent: () => syncAgent(host, cid, opened.harness, opened.conversation),
    clearPending: () => {
      if (host.clears.has(cid)) void host.maybeRotate(cid);
    },
    onIdle: () => {
      onIdle?.();
      host.idle.retain(cid);
    },
    model: () => {
      const ref = modelRef(host.deps.settings(host.deps.load(cid) ?? conv)[0]);
      return { provider: ref.provider, model: ref.modelId };
    },
    log: (event, fields, level) => host.deps.log(event, fields, level),
    rowChanged: () => host.deps.rowChanged?.(cid),
    viewChanged: () => host.viewChanged(cid),
    safetyChanged: () => host.deps.safetyChanged?.(cid),
    prsCreated: (urls, since) => host.deps.prsCreated?.(cid, urls, since),
  });
}

/** A side conversation: its fork, followed in the parent's open Harness. */
export async function openSide(
  host: DurableHost,
  cid: string,
  parent: string,
): Promise<Opened> {
  const main = await host.open(parent);
  const known = main.attached.get(cid);
  if (known !== undefined) return known;
  const { conversation, sessionId } = await (
    await runtime()
  ).forkSide(main.harness, main.conversation, cid, main.side);
  const side = attachSide(host, cid, parent, main, conversation, sessionId);
  main.attached.set(cid, side);
  return side;
}

async function attachSide(
  host: DurableHost,
  cid: string,
  parent: string,
  main: Opened,
  conversation: Conversation,
  sessionId: string,
): Promise<Opened> {
  const rt = await runtime();
  main.sessions.set(sessionId, cid);
  const parentSession = (
    await main.harness.snapshot(rt.ProviderDoc, main.conversation.id, context)
  )?.sessionId;
  if (
    parentSession !== undefined &&
    (await conversation.agent(context)).extensions.includes(main.side)
  )
    main.parentSessions.set(sessionId, parentSession);
  main.followed.set(String(conversation.id), conversation);
  main.owners.set(String(conversation.id), cid);
  await rt.ensureReportGeneration(main.harness, conversation);
  const row: LiveRow = { pending: [], shells: new Map() };
  let stopTracking = () => undefined as void;
  const opened: Opened = {
    ...main,
    row,
    conversation,
    parent,
    reporter: null,
    compact: () => main.compact(conversation),
    close: async () => {
      stopTracking();
      if (host.liveRows.get(cid) === row) {
        host.liveRows.delete(cid);
        host.reconcileCacheWarmers();
        host.views?.drop(cid);
        if (row.runId !== undefined) host.deps.rowChanged?.(cid);
      }
    },
    ready: true,
  };
  const tracking = await follow(
    host,
    cid,
    rt,
    opened,
    host.deps.load(cid) ?? {},
  );
  stopTracking = tracking.stop;
  await tracking.track();
  return opened;
}
