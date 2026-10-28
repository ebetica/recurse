// Shell tasks use only agent env/private overrides. Checkpoint notices before
// idempotent submission; retain ownership until groups are proven gone.
// Recovery verifies identities (see its setsid limit). Run abort stops only
// foreground; background abort/Stop processes stop tasks.

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import {
  HAS_PROCESS_TABLE,
  PROC,
  procIds,
  procText,
} from "../../../utils/process_table.ts";
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  defineTask,
  defineTool,
  type DocumentReader,
  type Extension,
  InboxDoc,
  type Harness,
  type SubmissionId,
  type JsonObject,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { delayMsForStep, fmtWait } from "./backoff.ts";
import { fileSize, readRange } from "./fileio.ts";
import {
  MonitorWakeCoalescer,
  type MonitorWakeConfig,
} from "./monitor-notifications.ts";
import {
  type Notifier,
  type Shell,
  type ShellConfig,
  ShellRegistry,
  TOOL_CALL_ID_ENV,
} from "./registry.ts";
import { RegistryStore } from "./persist.ts";
import { middleElide } from "./status.ts";

export const SHELL_TASK = "recurse.shell";
/** The tool-task memo holding a bash call's launch id. */
const LAUNCH_MEMO = "recurse.shell";
// Call launch id inherited by every shell descendant.
export const LAUNCH_ENV = "RECURSE_SHELL_LAUNCH";

// Call-specific launch and publish ownership ids. The launch's 32 hex digits
// form a stable, unique run id across resume.
function callEnvironment(
  call: { launch: string; callId: string } | undefined,
): Record<string, string> {
  if (call === undefined) return { [LAUNCH_ENV]: "" };
  return {
    [LAUNCH_ENV]: call.launch,
    [TOOL_CALL_ID_ENV]: call.callId,
    RECURSE_RUN_ID: call.launch.replaceAll("-", ""),
  };
}
const OUTPUT_CHUNK_BYTES = 256 * 1024;
const MAX_TIMER_MS = 3_600_000;
const STOP_RETRY_MS = 1000;
const MAX_STOP_RETRY_MS = 60_000;
const WAIT_POLL_MS = 2_000;

export type ShellGroup = {
  pid: number;
  pgid: number;
  sid: number;
  start_time: string | null;
  boot_id: string | null;
};

export type DurableShellScope = {
  /** Stable per Recurse conversation; one registry per key. */
  key: string;
  cwd: string;
  /** The whole environment shells start with. */
  env: Record<string, string>;
  // Registry settings captured when the scope's registry is created.
  config?: Partial<ShellConfig>;
};

export type ShellsOptions = {
  scope(
    api: { conversationId: ConversationId } & DocumentReader,
    context: Context,
  ): Promise<DurableShellScope>;
  // Exclusive shell-store directory, stable across restarts.
  stateDir: string;
  // Verified TERM/KILL stop; true only once the group is proven gone.
  stopGroup(group: ShellGroup): Promise<boolean>;
  monitor?: Partial<MonitorWakeConfig>;
  report?(error: unknown): void;
};

type Ownership = {
  shellId: string;
  pid: number;
  pgid: number;
  identity: string;
  bootId: string | null;
  logPath: string;
  command: string;
  startedAt: number;
};

type ShellInput = Ownership & {
  key: string;
  mode: "background" | "monitor";
  /** First still-running notice; null for monitors, which get none. */
  noticeAt: number | null;
  backgroundedAt: number;
  inactivityMs: number;
  // Retry time for group stops an abort could not prove complete.
  stopRetryAt?: number;
};

type ShellCheckpoint =
  | {
      phase: "watch";
      step: number;
      noticeAt: number | null;
      quietSince: number;
      reminders: number;
      batches: number;
    }
  | { phase: "notify"; message: string }
  | { phase: "stop"; attempts: number; retryAt: number };

type ShellResult = { event: "exit" | "lost" | "stopped"; gone: boolean };

type Watch = {
  registry: ShellRegistry;
  shell: Shell;
  exit?: string;
  monitor?: MonitorWakeCoalescer;
  batches: { id: string; message: string }[];
  wake?: () => void;
  // Wait timeout step; move the next still-running notice one step later.
  waitStep?: number;
};

const bashSchema = Type.Object({
  command: Type.String({ description: "The shell command to run." }),
  monitor: Type.Optional(
    Type.Boolean({
      description: "Stream progress batches; set at launch.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description: "Return immediately with a shell id.",
    }),
  ),
  inactivityReminderSeconds: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 86_400,
      description:
        "Inactivity reminder delay in seconds (default 1800); set to 0 to explicitly disable reminders for this shell.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2000,
      description: "Max output lines (default 2000).",
    }),
  ),
});

const BASH_DESCRIPTION =
  'Run a shell command; foreground calls auto-background after a short wait, with output capped at 2000 lines/50KB and full logs available through read (use limit for less output). background returns immediately; monitor sends batches that cost model turns. For reminders, use a monitored sleep loop, for example `while sleep 600; do echo "check X $(date -u +%T)"; done`; include the check time because repeated identical lines are suppressed. For goals, check a done-condition every few minutes and print a dated reminder only while it is unmet, so the monitor can wake you if you finish a turn early. For watchers, print only when the watched state changes, never heartbeat lines. Stop the monitor’s whole process group when it is no longer needed. Stop reported process groups with kill -- -<pgid>, and at the live-shell limit wait, inspect logs or stop a group instead of launching poll shells.';

const WAIT_DESCRIPTION =
  "Wait for background shells; successive waits/notices use 5m, 10m, 30m, 1h, 3h, then 6h intervals.";

/** Wait-interrupt notice: user input arrived, so the wait ends at once while
 * still-live shells keep their completion notification guarantee. */
function userInputWaitText(count: number): string {
  return `User message arrived — ending the wait. ${count} backgrounded shell${count === 1 ? "" : "s"} still running; their completion will still notify.`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function groupOf(owner: {
  pid: number;
  identity: string | null;
  bootId: string | null;
}): ShellGroup {
  return {
    pid: owner.pid,
    pgid: owner.pid,
    sid: owner.pid,
    start_time: owner.identity,
    boot_id: owner.bootId,
  };
}

function ownershipOf(shell: Shell): Ownership | undefined {
  if (
    shell.pid === undefined ||
    shell.pid <= 1 ||
    shell.pgid !== shell.pid ||
    !shell.identity
  )
    return undefined;
  return {
    shellId: shell.id,
    pid: shell.pid,
    pgid: shell.pgid,
    identity: shell.identity,
    bootId: shell.bootId ?? null,
    logPath: shell.logPath,
    command: shell.command,
    startedAt: shell.startedAt,
  };
}

function inactivityMs(seconds: number | undefined, fallbackMs: number): number {
  if (seconds === 0) return 0;
  return Math.max(0, (seconds ?? fallbackMs / 1000) * 1000);
}

function lostText(input: ShellInput, gone: boolean): string {
  const head = `Shell \`${input.shellId}\` (${middleElide(input.command, 300)}) was stopped because the server restarted; its exit status is unknown.`;
  const tail = gone
    ? ""
    : ` Its process group could not be proven gone; stop it with kill -- -${input.pgid}.`;
  return `${head}${tail}\nLog: ${input.logPath}`;
}

/** Resolve at `until`, on wake(), or reject when the invocation is signaled. */
function nextEvent(
  watch: Watch,
  until: number | undefined,
  now: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (watch.wake === done) watch.wake = undefined;
      if (error === undefined) resolve();
      else reject(error);
    };
    const done = () => finish();
    const abort = () => finish(signal.reason ?? new Error("aborted"));
    if (until !== undefined)
      timer = setTimeout(
        done,
        Math.min(MAX_TIMER_MS, Math.max(0, until - now)),
      );
    watch.wake = done;
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createShells(host: ShellsOptions) {
  const registries = new Map<string, ShellRegistry>();
  const envs = new Map<string, Record<string, string>>();
  const watches = new Map<string, Watch>();
  // Invariant: Non-timeout wait outcomes reset the per-scope timeout count.
  const waitCalls = new Map<string, number>();
  // Invariant: Scope-owned notices retain wait-ending flags and in-flight
  // posts.
  const notices = new Map<
    string,
    { ids: Map<SubmissionId, boolean>; posting: Set<Promise<unknown>> }
  >();
  const noticesOf = (key: string) => {
    let entry = notices.get(key);
    if (!entry)
      notices.set(key, (entry = { ids: new Map(), posting: new Set() }));
    return entry;
  };
  // Count queued inbox items, dropping notices already removed.
  async function queued(
    reader: DocumentReader,
    key: string,
    conversationId: ConversationId,
    context: Context,
  ) {
    const entry = noticesOf(key);
    await Promise.all(entry.posting);
    const items =
      (await reader.snapshot(InboxDoc, conversationId, context))?.items ?? [];
    const present = new Set(items.map((item) => item.id));
    for (const id of entry.ids.keys())
      if (!present.has(id)) entry.ids.delete(id);
    let answers = 0;
    let others = 0;
    for (const item of items) {
      const ends = entry.ids.get(item.id);
      if (ends === undefined && item.mode !== "write") others++;
      else if (ends) answers++;
    }
    return { answers, others };
  }
  // Invariant: registry.run spawns synchronously with these launch/call ids.
  let launching: { launch: string; callId: string } | undefined;
  let closing = false;
  const report = (error: unknown) => {
    try {
      host.report?.(error);
    } catch {}
  };

  // Invariant: Tasks own notices; drop registry ticks/recovery notices.
  // Acknowledge completions immediately because the task, not the store,
  // delivers them.
  const notifier = (key: string): Notifier => ({
    send(text, opts) {
      if (opts.completion) {
        const id = opts.completion.id;
        queueMicrotask(() =>
          registries.get(key)?.completionPersistence()?.acknowledge([id]),
        );
        const watch = watches.get(id);
        if (!watch) return;
        watch.exit = text;
        watch.monitor?.dispose();
        watch.wake?.();
      } else if (opts.monitor && !opts.triggerTurn) {
        watches
          .get(opts.monitor.shellId)
          ?.monitor?.send(opts.monitor.shellId, opts.monitor.lines);
      }
    },
    error: (message) => report(new Error(`[pi-bg-shell] ${message}`)),
  });

  function registryFor(scope: DurableShellScope): ShellRegistry {
    if (closing)
      throw new Error("Shells are shutting down; no new commands can start.");
    envs.set(scope.key, scope.env);
    let registry = registries.get(scope.key);
    if (!registry) {
      const key = scope.key;
      registry = new ShellRegistry(
        notifier(key),
        {
          // Invariant: Use only the conversation override file, never the
          // host's.
          environmentFile: scope.env.RECURSE_AGENT_ENV_FILE,
          agentTempDir: scope.env.RECURSE_AGENT_TMPDIR,
          ...scope.config,
          shell: "/usr/bin/env",
          shellArgs: (command) => [
            "-i",
            ...Object.entries({
              ...envs.get(key),
              ...callEnvironment(launching),
            })
              .filter(([name]) => ENV_NAME.test(name))
              .map(([name, value]) => `${name}=${value}`),
            "bash",
            "-c",
            command,
          ],
        },
        new RegistryStore(host.stateDir, key, { keepTerminated: 0 }),
        { ownerId: key, environment: () => envs.get(key) ?? {} },
      );
      registries.set(key, registry);
    }
    return registry;
  }

  function watch(registry: ShellRegistry, shell: Shell): Watch {
    const entry: Watch = { registry, shell, batches: [] };
    if (shell.mode === "monitor") {
      entry.monitor = new MonitorWakeCoalescer((message, _trigger, details) => {
        entry.batches.push({ id: details.monitorBatchId, message });
        entry.wake?.();
      }, host.monitor);
    }
    watches.set(shell.id, entry);
    return entry;
  }

  function unwatch(shellId: string): void {
    watches.get(shellId)?.monitor?.dispose();
    watches.delete(shellId);
  }

  type Runtime = TaskRuntime<ShellInput, ShellCheckpoint, ShellResult, object>;

  async function post(
    runtime: Runtime,
    input: ShellInput,
    event: string,
    content: string,
    context: Context,
  ) {
    const conversation = await runtime.conversation(
      runtime.conversationId,
      context,
    );
    if (!conversation)
      throw new Error(`conversation ${runtime.conversationId} is gone`);
    const entry = noticesOf(input.key);
    // Spec: shellNotice marks stored text through pi-messages; provider
    // adapters rebuild text without that mark.
    const part = { type: "text" as const, text: content, shellNotice: true };
    // Spec: Still-running/inactivity notices do not end a wait.
    const posting = conversation
      .submit(
        {
          type: "input",
          content: [part],
          whenBusy: "steer",
          requestId: `shell:${input.shellId}:${event}`,
        },
        context,
      )
      .then((submission) =>
        entry.ids.set(submission.id, !/^(running|idle):/.test(event)),
      );
    entry.posting.add(posting);
    try {
      await posting;
    } finally {
      entry.posting.delete(posting);
    }
    await queued(runtime, input.key, runtime.conversationId, context);
  }

  const done = (event: ShellResult["event"], gone: boolean) => ({
    status: "terminal" as const,
    outcome: { status: "completed" as const, result: { event, gone } },
  });

  const ShellTask = defineTask<ShellInput, ShellCheckpoint, ShellResult>({
    name: SHELL_TASK,
    version: 1,
    initial: (input): ShellCheckpoint =>
      input.stopRetryAt !== undefined
        ? { phase: "stop", attempts: 1, retryAt: input.stopRetryAt }
        : {
            phase: "watch",
            step: 0,
            noticeAt: input.noticeAt,
            quietSince: input.backgroundedAt,
            reminders: 0,
            batches: 0,
          },
    phases: {
      watch: async (task, runtime, context) => {
        const input = task.input;
        const entry = watches.get(input.shellId);
        if (!entry) {
          // Invariant: A shell unknown to this process belongs to a departed
          // host.
          const gone = await host.stopGroup(groupOf(input));
          await post(runtime, input, "lost", lostText(input, gone), context);
          const retryAt = runtime.now() + STOP_RETRY_MS;
          await runtime.commit(
            () =>
              gone
                ? done("lost", true)
                : {
                    status: "running",
                    checkpoint: { phase: "stop", attempts: 1, retryAt },
                  },
            context,
          );
          return;
        }
        const { registry, shell } = entry;
        const withReminder = (text: string) => {
          const reminder = registry.backgroundShellReminder();
          return reminder ? `${text}\n\n${reminder}` : text;
        };
        let state = task.state.checkpoint;
        const advance = async (next: typeof state) => {
          state = next;
          await runtime.commit(
            () => ({ status: "running", checkpoint: next }),
            context,
          );
        };
        for (;;) {
          if (entry.exit !== undefined) {
            const message = withReminder(entry.exit);
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: { phase: "notify", message },
              }),
              context,
            );
            return;
          }
          const batch = entry.batches.shift();
          if (batch) {
            await post(
              runtime,
              input,
              `monitor:${state.batches}`,
              withReminder(batch.message),
              context,
            );
            entry.monitor?.turnEnded(new Set([batch.id]));
            await advance({ ...state, batches: state.batches + 1 });
            continue;
          }
          const now = runtime.now();
          if (entry.waitStep !== undefined && state.noticeAt !== null) {
            const step = Math.max(state.step, entry.waitStep + 1);
            entry.waitStep = undefined;
            await advance({
              ...state,
              step,
              noticeAt:
                now + delayMsForStep(step, registry.cfg.scheduleSeconds),
            });
            continue;
          }
          if (state.noticeAt !== null && now >= state.noticeAt) {
            await post(
              runtime,
              input,
              `running:${state.step}`,
              withReminder(registry.stillRunningText(shell)),
              context,
            );
            const step = state.step + 1;
            await advance({
              ...state,
              step,
              noticeAt:
                now + delayMsForStep(step, registry.cfg.scheduleSeconds),
            });
            continue;
          }
          const quietUntil =
            input.inactivityMs > 0
              ? state.quietSince + input.inactivityMs
              : undefined;
          if (quietUntil !== undefined && now >= quietUntil) {
            let changedAt = state.quietSince;
            try {
              changedAt = Math.max(changedAt, statSync(input.logPath).mtimeMs);
            } catch {}
            if (changedAt > state.quietSince) {
              await advance({ ...state, quietSince: changedAt });
              continue;
            }
            const reminders = state.reminders + 1;
            const text = `[shell ${input.shellId}] still running; no new output for ${Math.floor((now - changedAt) / 1000)}s (reminder ${reminders}). Stop it (whole group): kill -- -${input.pgid}`;
            await post(
              runtime,
              input,
              `idle:${state.reminders}`,
              withReminder(text),
              context,
            );
            await advance({ ...state, reminders, quietSince: now });
            continue;
          }
          const deadlines = [
            state.noticeAt ?? Infinity,
            quietUntil ?? Infinity,
          ];
          const until = Math.min(...deadlines);
          await nextEvent(
            entry,
            Number.isFinite(until) ? until : undefined,
            now,
            runtime.signal,
          );
        }
      },
      notify: async (task, runtime, context) => {
        const state = task.state.checkpoint;
        await post(runtime, task.input, "exit", state.message, context);
        unwatch(task.input.shellId);
        await runtime.commit(() => done("exit", true), context);
      },
      // Invariant: Retain group ownership until the group is proven gone.
      stop: async (task, runtime, context) => {
        const { attempts, retryAt } = task.state.checkpoint;
        await runtime.sleep(retryAt, context);
        const gone = await host.stopGroup(groupOf(task.input));
        const next =
          runtime.now() +
          Math.min(MAX_STOP_RETRY_MS, STOP_RETRY_MS * 2 ** attempts);
        await runtime.commit(
          () =>
            gone
              ? done("lost", true)
              : {
                  status: "running",
                  checkpoint: {
                    phase: "stop",
                    attempts: attempts + 1,
                    retryAt: next,
                  },
                },
          context,
        );
      },
    },
    abort: async (task, runtime, context) => {
      unwatch(task.input.shellId);
      const gone = await host.stopGroup(groupOf(task.input));
      await runtime.commit(async (tx) => {
        // Invariant: Abort must end this task; a successor retains unresolved
        // group ownership.
        if (!gone) {
          const input = {
            ...task.input,
            stopRetryAt: runtime.now() + STOP_RETRY_MS,
          };
          await tx.createTask(ShellTask, input, {
            ownership: { kind: "conversation" },
            background: true,
          });
        }
        return {
          status: "terminal",
          outcome: {
            status: "aborted",
            reason: gone ? "stopped" : "process group survived",
            result: { event: "stopped", gone },
          },
        };
      }, context);
    },
  });

  const bash = defineTool({
    name: "bash",
    description: BASH_DESCRIPTION,
    parameters: bashSchema,
    async execute(args, api, context): Promise<ToolExecutionResult> {
      const started = performance.now();
      let advisories: string[] = [];
      const result = (
        message: string,
        details: JsonObject = {},
      ): ToolExecutionResult => ({
        output: [
          {
            type: "text",
            text: advisories.length
              ? `${message ? `${message}\n` : ""}${advisories.join("\n")}`
              : message,
          },
        ],
        details: {
          ...details,
          recurseCommandTiming: {
            version: 1,
            commandMs: Math.max(1, Math.round(performance.now() - started)),
          },
        },
      });
      const command = args.command;
      if (typeof command !== "string" || command.trim() === "") {
        return result("Error: `command` must be a non-empty string.");
      }
      const scope = await host.scope(api, context);
      const registry = registryFor(scope);
      advisories = registry.commandAdvisories(command);
      const mode = args.monitor
        ? "monitor"
        : args.background
          ? "background"
          : "foreground";
      // Invariant: Memoize before spawn so recovery can find setsid descendants
      // by launch id.
      const launch = await api.memo<string>(LAUNCH_MEMO, randomUUID(), context);
      // Invariant: Tasks own inactivity reminders; keep the registry timer off.
      launching = { launch, callId: api.callId };
      const shell = registry.run(command, mode, scope.cwd, 0);
      launching = undefined;
      const quietMs = inactivityMs(
        args.inactivityReminderSeconds,
        registry.cfg.inactivityReminderMs,
      );
      // Invariant: Watch detached completions before their first event.
      if (mode !== "foreground") watch(registry, shell);
      const note = registry.commandHygieneNote(shell);
      if (note) advisories.push(note);
      await registry.waitForLaunch(shell);
      const failure = (text: string) =>
        shell.launchErrorMessage
          ? `Failed to start command in ${scope.cwd}: ${shell.launchErrorMessage}`
          : text;
      if (shell.status === "error") {
        unwatch(shell.id);
        return result(
          shell.launchError === "live-cap"
            ? registry.liveShellCapMessage()
            : failure(`Failed to start command: ${command}`),
        );
      }
      const owner = ownershipOf(shell);
      const details: JsonObject = {
        shellId: shell.id,
        mode,
        pid: shell.pid ?? null,
        pgid: shell.pgid ?? null,
      };
      const refuse = async (prefix: string) => {
        unwatch(shell.id);
        const stopped = await registry.discardUnowned(shell);
        return result(
          `${prefix}; ${stopped ? "command stopped." : "forced termination remains pending and ownership was retained for shutdown retry."}`,
        );
      };
      if (!owner && mode !== "foreground") {
        return refuse(
          `Failed to start ${mode} command: its process identity is unreadable`,
        );
      }
      const detach = async (): Promise<boolean> => {
        if (!owner) return false;
        const backgroundedAt = shell.backgroundedAt;
        const input: ShellInput = {
          ...owner,
          key: scope.key,
          mode: shell.mode === "monitor" ? "monitor" : "background",
          noticeAt:
            shell.mode === "monitor"
              ? null
              : backgroundedAt +
                delayMsForStep(0, registry.cfg.scheduleSeconds),
          backgroundedAt,
          inactivityMs: quietMs,
        };
        try {
          await api.createTask(
            ShellTask,
            input,
            { ownership: { kind: "conversation" }, background: true },
            context,
          );
          return true;
        } catch (error) {
          report(error);
          return false;
        }
      };
      const pgid = String(shell.pgid);
      const handoff = `Output trimmed to 2000 lines/50KB (middle-truncated); full log: ${shell.logPath} — Read with offset/limit to continue. End your message; you will be notified when done.\nStop it (whole group): \`kill -- -${pgid}\``;
      const othersReminder = () => {
        const reminder = registry.backgroundShellReminder(shell.id);
        return reminder ? `\n${reminder}` : "";
      };

      if (mode === "monitor") {
        if (!(await detach()))
          return refuse(
            "Failed to start monitored command: its shell task could not be recorded",
          );
        return result(
          `Monitoring shell \`${shell.id}\` (pid ${shell.pid}, pgid ${pgid}). Meaningful complete output lines will arrive as user messages after this turn ends; monitoring continues until the command exits.\nStop it (whole group): kill -- -${pgid}\nLog: ${shell.logPath}${othersReminder()}`,
          details,
        );
      }
      if (mode === "background") {
        if (!(await detach()))
          return refuse(
            "Failed to start background command: its shell task could not be recorded",
          );
        return result(
          `Started shell \`${shell.id}\` (pid ${shell.pid}, pgid ${pgid}) in the background. ${handoff}${othersReminder()}`,
          details,
        );
      }

      const signal = context.abortSignal;
      const abortForeground = () => registry.abortShell(shell);
      if (signal?.aborted) abortForeground();
      else signal?.addEventListener("abort", abortForeground, { once: true });
      let streamed = 0;
      const stream = () => {
        try {
          const size = fileSize(shell.logPath);
          if (size <= streamed) return;
          const start = Math.max(streamed, size - OUTPUT_CHUNK_BYTES);
          api.output(readRange(shell.logPath, start, size - start));
          streamed = size;
        } catch {}
      };
      const timer = setInterval(stream, 100);
      let waited: "exited" | "timeout";
      try {
        waited = await registry.waitForExit(
          shell,
          registry.cfg.foregroundWaitMs,
        );
      } finally {
        clearInterval(timer);
        stream();
        signal?.removeEventListener("abort", abortForeground);
      }
      const seconds = Math.round(registry.cfg.foregroundWaitMs / 1000);
      if (waited === "exited") {
        const out = registry.trimmedOutput(shell, args.limit);
        if (shell.status !== "killed" && shell.exitCode === 0)
          return result(out);
        const status =
          shell.status === "killed"
            ? "killed by signal"
            : `exited ${shell.exitCode}`;
        return result(`Command ${status}.\n${out}`);
      }
      const capFull = async () => {
        const recovery = registry.liveShellCapMessage();
        const out = registry.trimmedOutput(shell, args.limit);
        const stopped = await registry.discardUnowned(shell);
        return result(
          `Command still running after ${seconds}s, but the live background-shell limit is full; it was not backgrounded. ${stopped ? "The command was stopped." : "Forced termination remains pending."}\n${recovery}\nOutput so far:\n${out}`,
        );
      };
      if (!registry.canBackgroundify(shell)) return capFull();
      if (!owner)
        return refuse(
          "Command exceeded the foreground window, but its process identity is unreadable",
        );
      // Invariant: Watch before backgrounding; the registry emits exit only
      // once.
      watch(registry, shell);
      if (!registry.backgroundify(shell, 0)) {
        unwatch(shell.id);
        return capFull();
      }
      if (!(await detach()))
        return refuse(
          "Command exceeded the foreground window, but its shell task could not be recorded",
        );
      const out = registry.trimmedOutput(shell, args.limit);
      return result(
        `Command still running after ${seconds}s — backgrounded as shell \`${shell.id}\` (pid ${shell.pid}, pgid ${pgid}). ${handoff}${othersReminder()}\nOutput so far:\n${out}`,
        { ...details, mode: "background" },
      );
    },
  });

  const wait = defineTool({
    name: "wait",
    callers: ["model"],
    description: WAIT_DESCRIPTION,
    parameters: Type.Object({}),
    async execute(_args, api, context): Promise<ToolExecutionResult> {
      const scope = await host.scope(api, context);
      const registry = registryFor(scope);
      const text = (message: string, calls = 0): ToolExecutionResult => {
        waitCalls.set(scope.key, calls);
        return { output: [{ type: "text", text: message }] };
      };
      const answer = async () => {
        const { answers, others } = await queued(
          api,
          scope.key,
          api.conversationId,
          context,
        );
        const running = registry
          .list()
          .filter(
            (shell) =>
              (shell.mode === "background" || shell.mode === "monitor") &&
              shell.status === "running",
          );
        if (answers > 0)
          return "A backgrounded shell reported; its notice follows this result.";
        if (running.length === 0) return "No backgrounded shells to wait for.";
        if (others > 0) return userInputWaitText(running.length);
        return undefined;
      };
      const schedule = registry.cfg.scheduleSeconds;
      const stepIndex = Math.min(
        waitCalls.get(scope.key) ?? 0,
        schedule.length - 1,
      );
      const seconds = schedule[stepIndex]!;
      const deadline = Date.now() + seconds * 1000;
      const signal = context.abortSignal;
      // Spec: Any inbox change wakes wait; polling covers an inbox not yet
      // created.
      const inbox = await api.watchDoc(InboxDoc, api.conversationId, context);
      let changed = false;
      let wake = () => {};
      inbox?.start(async () => {
        changed = true;
        wake();
      });
      try {
        for (;;) {
          changed = false;
          const woke = await answer();
          if (woke !== undefined) return text(woke);
          if (signal?.aborted) return text("Wait aborted.");
          if (Date.now() >= deadline) break;
          if (changed) continue;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(
              done,
              Math.min(WAIT_POLL_MS, deadline - Date.now()),
            );
            function done() {
              clearTimeout(timer);
              signal?.removeEventListener("abort", done);
              resolve();
            }
            wake = done;
            signal?.addEventListener("abort", done, { once: true });
          });
        }
      } finally {
        await inbox?.stop();
      }
      // Spec: A timeout consumes this schedule step for all running background
      // shells.
      for (const entry of watches.values()) {
        if (entry.registry !== registry || entry.shell.mode !== "background")
          continue;
        entry.waitStep = Math.max(entry.waitStep ?? 0, stepIndex);
        entry.wake?.();
      }
      const lines = registry.stillRunningLines();
      const detail = lines.length > 0 ? `\n${lines.join("\n")}` : "";
      return text(
        `Waited for ${fmtWait(seconds)}. Call wait again to wait longer.${detail}`,
        stepIndex + 1,
      );
    },
  });

  const extension: Extension = defineExtension({
    name: "recurse-shells",
    tools: [bash, wait],
    tasks: [ShellTask],
  });

  return {
    extension,
    task: ShellTask,
    // Refuse commands and stop all owned groups, independently of Harness join.
    async shutdown(): Promise<void> {
      closing = true;
      for (const id of [...watches.keys()]) unwatch(id);
      await Promise.all(
        [...registries.values()].map((registry) => registry.shutdown()),
      );
      registries.clear();
      notices.clear();
      waitCalls.clear();
    },
    // Release a reaped registry only after its shell tasks stop.
    async release(key: string): Promise<void> {
      const registry = registries.get(key);
      for (const [id, entry] of watches)
        if (entry.registry === registry) unwatch(id);
      registries.delete(key);
      envs.delete(key);
      notices.delete(key);
      waitCalls.delete(key);
      await registry?.shutdown();
    },
  };
}

// Abort shell tasks and await their stop handlers. Return proven-gone group
// count and surviving shell ids.
export async function stopConversationShells(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<{ stopped: number; pending: string[] }> {
  const tasks = (await harness.inspect(context)).tasks
    .map((task) => task.record)
    .filter(
      (record) =>
        record.kind === SHELL_TASK && record.conversationId === conversationId,
    );
  await Promise.all(tasks.map((task) => harness.abortTask(task.id, context)));
  let stopped = 0;
  const pending: string[] = [];
  for (const task of tasks) {
    const settled = await harness.waitForTask(
      task.id as TaskId<ShellResult>,
      context,
    );
    const outcome = settled.state.outcome;
    const gone =
      "result" in outcome && outcome.result ? outcome.result.gone : false;
    if (gone) stopped++;
    else pending.push((task.input as ShellInput).shellId);
  }
  return { stopped, pending };
}

/** A live process's start time, from its stat line. */
async function startOf(pid: number): Promise<string | undefined> {
  try {
    const raw = await procText(pid, "stat");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? undefined : fields[19];
  } catch {
    return undefined;
  }
}

// Before resume, verify/stop recorded groups and recover interrupted launches
// by marker plus rechecked start identity. A setsid process clearing its env
// escapes. Return pids not proven gone.
export async function recoverInterruptedCommands(
  harness: Harness,
  host: Pick<ShellsOptions, "stopGroup" | "stateDir">,
  context: Context,
): Promise<number[]> {
  const launches = new Set<string>();
  const pending: number[] = [];
  for (const { record } of (await harness.inspect(context)).tasks) {
    if (record.kind !== "pi.tool") continue;
    const launch = record.memos?.[LAUNCH_MEMO];
    if (typeof launch === "string") launches.add(launch);
  }
  // Invariant: run writes ownership records synchronously with spawn.
  for (const key of await readdir(host.stateDir).catch(() => [] as string[])) {
    const store = new RegistryStore(host.stateDir, key);
    for (const record of store.readAll()) {
      if (record.status === "running" && record.pid !== undefined) {
        const group = groupOf({
          pid: record.pid,
          identity: record.identity ?? null,
          bootId: record.bootId ?? null,
        });
        if (!(await host.stopGroup(group))) {
          pending.push(record.pid);
          continue;
        }
      }
      store.remove(record.id);
    }
    await rmdir(store.dir).catch(() => undefined);
  }
  if (launches.size === 0 || !HAS_PROCESS_TABLE) return pending;
  const marked: { pid: number; start: string }[] = [];
  for (const name of await procIds()) {
    if (!/^\d+$/.test(name)) continue;
    // Invariant: Read stat/environ/stat to prove the marker belongs to this
    // process, not a reused pid.
    const pid = Number(name);
    const start = await startOf(pid);
    if (!start) continue;
    const environ = await procText(name, "environ", PROC, "latin1").catch(
      () => "",
    );
    const launch = environ
      .split("\0")
      .find((item) => item.startsWith(`${LAUNCH_ENV}=`));
    if (!launch || !launches.has(launch.slice(LAUNCH_ENV.length + 1))) continue;
    if ((await startOf(pid)) === start) marked.push({ pid, start });
  }
  for (const { pid, start } of marked) {
    if ((await startOf(pid)) !== start) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  const deadline = Date.now() + 1000;
  for (const { pid, start } of marked) {
    while ((await startOf(pid)) === start && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    if ((await startOf(pid)) === start) pending.push(pid);
  }
  return pending;
}
