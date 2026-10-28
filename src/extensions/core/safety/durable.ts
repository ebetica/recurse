// Direct and nested ToolTask calls share review policy/evidence; direct MCP
// stays blocked. Only authenticated host toggles review off. Host owns
// identity/trusted policy/roots, never mutable tool env. Outcomes/denials
// survive restart; hook throws fail closed.

import type { Context } from "@earendil-works/chord";
import type { Models, Usage } from "@earendil-works/pi-ai";
import type { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AgentDoc,
  CompactionEntry,
  type ContextView,
  type Conversation,
  defineDoc,
  defineExtension,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  type HookApi,
  type JsonObject,
  LiveDoc,
  ProviderDoc,
  ToolTask,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { DENIAL_LIMIT, DenialCircuitBreaker } from "./circuit-breaker.ts";
import { loadSafetyConfig, type SafetyConfig } from "./config.ts";
import {
  boundedAttempts,
  classifyReviewFailure,
  commandTimingMs,
  denialMessage,
  DIRECT_MCP_CALL_MESSAGE,
  invalidConfigMessage,
  isMcpTool,
  positiveElapsedMs,
  RESERVED_RESULT_DETAILS,
  reviewedToolNames,
  reviewFailureMessage,
  reviewWithCandidates,
  safeLog,
} from "./index.ts";
import {
  loadTrustedModelPolicy,
  pickReviewerCandidates,
  type TrustedModelPolicyState,
} from "./model-policy.ts";
import { expandToolCallPaths } from "./path-expansion.ts";
import {
  allowedByPathScope,
  loadTrustedPathScope,
  type TrustedPathScope,
} from "./path-scope.ts";
import { isReadOnlyBashCommand } from "./read-only-bash.ts";
import { updateReviewerJournal } from "./review-journal.ts";
import {
  reviewAction,
  type SafetyReviewAttempt,
  type SafetyVerdict,
} from "./review.ts";
import { ownedProcessSnapshot, type ProcessRoot } from "./process-snapshot.ts";
import {
  buildReviewTranscript,
  formatPathOnlyProposedAction,
  formatProposedAction,
} from "./transcript.ts";

/** Review escape hatch/availability; display state never gates tools. */
const SafetyDoc = defineDoc<{ off: boolean; unavailable?: string }>({
  kind: "recurse.safety",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ off: false }),
});

type UsageTotals = Omit<Usage, "cost"> & { cost: Usage["cost"] };

export type DeniedReviewState = {
  calls: number;
  /** Attempts whose spend the provider did not report. */
  unreportedAttempts: number;
  usage: UsageTotals;
  safetyWaitMs: number;
  // Counted task ids, newest last; resumed calls count only once.
  recent: string[];
  // Run denials persisted to preserve its circuit breaker on resume.
  run?: { key: string; denied: string[] };
};

const MAX_RECENT_DENIALS = 64;

function zeroUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export const DeniedReviewDoc = defineDoc<DeniedReviewState>({
  kind: "recurse.safety-denied",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    calls: 0,
    unreportedAttempts: 0,
    usage: zeroUsage(),
    safetyWaitMs: 0,
    recent: [],
  }),
});

// Write the escape hatch only for the host's authenticated toggle route.
export async function setSafetyReviewOff(
  conversation: Conversation,
  off: boolean,
  context: Context,
): Promise<void> {
  await conversation.commit(async (tx) => {
    const doc = await tx.doc(SafetyDoc, conversation.id);
    doc.off = off;
    if (off) delete doc.unavailable;
  }, context);
}

// Read conversation review status for the host's display.
export async function safetyReviewOff(
  harness: Pick<Harness, "snapshot">,
  conversation: Conversation,
  context: Context,
): Promise<boolean> {
  return (
    (await harness.snapshot(SafetyDoc, conversation.id, context))?.off === true
  );
}

/** Current bounded, credential-free explanation for the composer. */
export async function safetyReviewUnavailable(
  harness: Pick<Harness, "snapshot">,
  conversation: Conversation,
  context: Context,
): Promise<string | undefined> {
  const state = await harness.snapshot(SafetyDoc, conversation.id, context);
  return state?.off ? undefined : state?.unavailable;
}

function unavailableReason(outcome: Outcome): string {
  const failure = classifyReviewFailure(
    outcome.reason,
    Boolean(outcome.journalFailure),
  );
  if (failure.stage === "journal") return "reviewer journal error";
  if (/usage|quota|rate.limit|\b429\b/i.test(outcome.reason))
    return "usage limit";
  if (failure.category === "auth") return "no reviewer login";
  if (failure.category === "unavailable") return "model unavailable";
  if (failure.category === "invalid") return "invalid reviewer response";
  if (failure.category === "timeout") return "review timed out";
  return "provider error";
}

export type DurableSafetyAgent = {
  // Host conversation id, independent of Durable's numeric id.
  id: string;
  /** Host-owned title, never inferred from tool environment or evidence. */
  title?: string;
  // Conversation tool environment, not the server environment.
  env: NodeJS.ProcessEnv;
  /** The working directory the conversation's tools run in. */
  cwd: string;
  conversation: Conversation;
  /** Stop the current run without withdrawing queued input. */
  stopRun(): void;
};

export type SafetyTrusted = {
  modelPolicy?: string;
  workspaceRoot?: string;
  worktreesRoot?: string;
  tempRoot?: string;
  home?: string;
  dataDir?: string;
  statsRoot?: string;
};

export type SafetyOptions = {
  models: Models;
  configDir: string;
  trusted(): SafetyTrusted;
  shells(): readonly ProcessRoot[] | undefined;
  /** Resolve the conversation of a hook; a throw blocks the call. */
  agent(api: HookApi, context: Context): Promise<DurableSafetyAgent>;
  mcpServer?(name: string): string | undefined;
  reviewAction?: typeof reviewAction;
  loadConfig?: typeof loadSafetyConfig;
  now?: () => number;
};

type Outcome = {
  decision: "allow" | "deny";
  reason: string;
  procedural?: boolean;
  journalFailure?: boolean;
  attempts?: SafetyReviewAttempt[];
  safetyWaitMs?: number;
};

type RunState = {
  key: string;
  config: SafetyConfig;
  pathScope: TrustedPathScope | undefined;
  modelPolicy: TrustedModelPolicyState;
  breaker: DenialCircuitBreaker;
  denied: Set<string>;
  open: boolean;
  stopPending: boolean;
};

const CANCELLED = "[pi-safety] Agent run cancelled.";
const BREAKER_OPEN = `[pi-safety] Tool call blocked because the circuit breaker opened after ${DENIAL_LIMIT} denied actions; the current agent run has been stopped.`;
const REVIEWED_TOOLS = reviewedToolNames();

const memoKey = (callId: string) => `recurse.safety:${callId}`;

function reviewContext(
  models: Models,
  cwd: string,
  model: ExtensionContext["model"],
  signal: AbortSignal | undefined,
  sessionId: string,
): ExtensionContext {
  return {
    cwd,
    model,
    signal,
    modelRegistry: {
      find: (provider: string, id: string) => models.getModel(provider, id),

      getApiKeyAndHeaders: async (target: Parameters<Models["getAuth"]>[0]) => {
        try {
          const resolution = await models.getAuth(target);
          if (!resolution)
            return {
              ok: false,
              error: `No API key found for "${(target as { provider: string }).provider}"`,
            };
          return {
            ok: true,
            apiKey: resolution.auth.apiKey,
            headers: resolution.auth.headers,
            env: resolution.env,
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

type ReviewRow = {
  type: string;
  id: string;
  parentId: string | null;
  message?: unknown;
};

// Project the active context as Pi evidence rows. Evidence starts at the
// nearest compaction; its verbatim retained entries are not evidence.
export function reviewRows(view: ContextView): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const head = view.entries[0];
  const compacted = head !== undefined && head.kind === CompactionEntry.kind;
  let parentId: string | null = null;
  view.entries.forEach((entry, index) => {
    if (compacted && entry !== head && entry.id < head.id) return;
    const messages: readonly unknown[] =
      entry === head && compacted
        ? [undefined]
        : (view.contributions[index] ?? []);
    messages.forEach((message, part) => {
      const id = part === 0 ? String(entry.id) : `${entry.id}#${part}`;
      rows.push(
        message === undefined
          ? { type: "compaction", id, parentId }
          : { type: "message", id, parentId, message },
      );
      parentId = id;
    });
  });
  return rows;
}

function reportedUsage(
  attempts: readonly SafetyReviewAttempt[] | undefined,
): UsageTotals | undefined {
  const reported = (attempts ?? []).flatMap((attempt) =>
    attempt.status === "reported" && attempt.usage ? [attempt.usage] : [],
  );
  if (!reported.length) return undefined;
  return reported.reduce<UsageTotals>(
    (sum, usage) =>
      addUsage(sum, {
        ...usage,
        totalTokens:
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      }),
    zeroUsage(),
  );
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

// Memoize reviews before applying decisions; resume never repeats a review.
// Infrastructure failure reports diagnostics and fails open; hook throws block.
// Denied calls skip afterTool: billing lives in the conversation document.
// Circuit-breaker stops preserve queued input and already-committed denials.
export function createDurableSafety(host: SafetyOptions): Extension {
  const review = host.reviewAction ?? reviewAction;
  const loadConfig = host.loadConfig ?? loadSafetyConfig;
  const now = host.now ?? (() => performance.now());
  const complete = ((model, context, options) =>
    host.models.completeSimple(
      model,
      context,
      options,
    )) as typeof completeSimple;
  const runs = new Map<string, RunState>();
  const reviewTails = new Map<string, Promise<void>>();
  const started = new Map<string, number>();

  // A run starts with its first input; a new run gets a fresh denial budget
  // and reloads the policy, as a new Pi agent loop does.
  async function runState(
    key: string,
    api: HookApi,
    context: Context,
  ): Promise<RunState> {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const runKey = String(live?.run?.inputs[0] ?? live?.run?.taskId ?? "none");
    const prior = runs.get(key);
    if (prior?.key === runKey) return prior;
    // Invariant: A resumed run retains its denial count.
    const stored = await api.snapshot(
      DeniedReviewDoc,
      api.conversationId,
      context,
    );
    const raced = runs.get(key);
    if (raced?.key === runKey) return raced;
    const trusted = host.trusted();
    const config = loadConfig(host.configDir);
    if (config.error) safeLog(invalidConfigMessage());
    const state: RunState = {
      key: runKey,
      config,
      pathScope: loadTrustedPathScope({
        RECURSE_WORKSPACE_ROOT: trusted.workspaceRoot,
        RECURSE_WORKTREES_ROOT: trusted.worktreesRoot,
        RECURSE_AGENT_TMPDIR: trusted.tempRoot,
        CHAT_DATA_DIR: trusted.dataDir,
      }),
      modelPolicy: loadTrustedModelPolicy({
        RECURSE_MODEL_POLICY: trusted.modelPolicy,
      }),
      breaker: new DenialCircuitBreaker(),
      denied: new Set(),
      open: false,
      stopPending: false,
    };
    for (const id of stored?.run?.key === runKey ? stored.run.denied : []) {
      state.denied.add(id);
      state.open = state.breaker.recordDenial().open;
    }
    state.stopPending = state.open;
    runs.set(key, state);
    return state;
  }

  async function acquireReviewSlot(key: string): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = reviewTails.get(key) ?? Promise.resolve();
    const tail = prior.then(
      () => mine,
      () => mine,
    );
    reviewTails.set(key, tail);
    await prior;
    return () => {
      release();
      if (reviewTails.get(key) === tail) reviewTails.delete(key);
    };
  }

  async function reviewCall(
    name: string,
    args: Record<string, unknown>,
    api: HookApi,
    agent: DurableSafetyAgent,
    run: RunState,
    safetyStartedMs: number,
    context: Context,
    nested?: { parentCallId: string; mcpServer?: string },
  ): Promise<Outcome> {
    const conversationId = agent.id;
    const stored = await api.snapshot(AgentDoc, api.conversationId, context);
    const active = stored?.model
      ? host.models.getModel(stored.model.provider, stored.model.modelId)
      : undefined;
    const sessionId =
      (await api.snapshot(ProviderDoc, api.conversationId, context))
        ?.sessionId ?? `conversation-${api.conversationId}`;
    const ctx = reviewContext(
      host.models,
      agent.cwd,
      active as ExtensionContext["model"],
      context.abortSignal,
      sessionId,
    );
    const pathTool = name === "write" || name === "edit" ? name : undefined;
    const reviewers = pickReviewerCandidates(
      ctx,
      run.modelPolicy,
      pathTool ? "summary" : "reviewer",
    );
    const action = pathTool
      ? formatPathOnlyProposedAction(pathTool, args)
      : formatProposedAction(
          name,
          args,
          nested && isMcpTool(name)
            ? {
                calledBy: { tool: "codemode", toolCallId: nested.parentCallId },
                mcpServer: nested.mcpServer,
              }
            : undefined,
        );

    const rows = reviewRows(await agent.conversation.context(context));
    let transcript = "";
    let durableEvidence = "";
    let blocks: readonly string[] | undefined;
    let journalFailure: string | undefined;
    if (conversationId) {
      const byId = new Map(rows.map((row) => [row.id, row]));
      try {
        const journal = updateReviewerJournal({
          conversationId,
          session: {
            getSessionId: () => sessionId,
            getLeafId: () => rows.at(-1)?.id ?? null,
            getEntry: (id: string) => byId.get(id),
          },
        });
        durableEvidence = journal.cacheKey;
        transcript = journal.journalEvidence;
        blocks = journal.evidenceBlocks;
      } catch (error) {
        journalFailure =
          error instanceof Error ? error.message : "reviewer journal failed";
      }
    } else {
      transcript = buildReviewTranscript(
        rows as Parameters<typeof buildReviewTranscript>[0],
      );
    }
    let verdict: SafetyVerdict;
    if (reviewers && !journalFailure) {
      verdict = await reviewWithCandidates(review, ctx, reviewers, {
        rules: run.config.additionalRules,
        transcript,
        action,
        durableEvidence,
        conversationId,
        blocks,
        complete,
        inputs: {
          dataDir: host.trusted().dataDir,
          statsRoot: host.trusted().statsRoot,
          processSnapshot: ownedProcessSnapshot(host.shells()),
          actingAgent: { id: agent.id, title: agent.title },
        },
      });
    } else {
      verdict = {
        decision: "deny",
        reason: journalFailure
          ? `Safety reviewer journal failed: ${journalFailure}`
          : "The configured reviewer model is unavailable or does not match the active model policy.",
        procedural: true,
      };
    }
    const safetyWaitMs =
      reviewers && !journalFailure
        ? positiveElapsedMs(safetyStartedMs, now())
        : undefined;
    return {
      decision: verdict.decision,
      reason: verdict.reason,
      ...(verdict.procedural ? { procedural: true } : {}),
      ...(journalFailure ? { journalFailure: true } : {}),
      ...(verdict.reviewAttempts?.length
        ? { attempts: boundedAttempts(verdict.reviewAttempts) }
        : {}),
      ...(safetyWaitMs === undefined ? {} : { safetyWaitMs }),
    };
  }

  async function recordDenied(
    agent: DurableSafetyAgent,
    runKey: string,
    taskId: string,
    outcome: Outcome,
    context: Context,
  ): Promise<void> {
    await agent.conversation.commit(async (tx) => {
      const doc = await tx.doc(DeniedReviewDoc, agent.conversation.id);
      if (doc.run?.key !== runKey) doc.run = { key: runKey, denied: [] };
      if (!doc.run.denied.includes(taskId)) doc.run.denied.push(taskId);
      if (doc.recent.includes(taskId)) return;
      doc.recent.push(taskId);
      if (doc.recent.length > MAX_RECENT_DENIALS)
        doc.recent.splice(0, doc.recent.length - MAX_RECENT_DENIALS);
      doc.calls += 1;
      doc.unreportedAttempts += (outcome.attempts ?? []).filter(
        (attempt) => attempt.status !== "reported",
      ).length;
      const usage = reportedUsage(outcome.attempts);
      if (usage) doc.usage = addUsage(doc.usage, usage);
      doc.safetyWaitMs += outcome.safetyWaitMs ?? 0;
    }, context);
  }

  const decide = async (
    call: ToolHookCall,
    api: HookApi,
    context: Context,
  ): Promise<{ arguments?: JsonObject; block?: string } | undefined> => {
    const nested = call.parent
      ? {
          parentCallId: call.parent.callId,
          mcpServer: host.mcpServer?.(call.name),
        }
      : undefined;
    const startedMs = now();
    const agent = await host.agent(api, context);
    const key = agent.id;
    const run = await runState(key, api, context);
    const denialKey = String(api.taskId);
    // Invariant: A resumed denied call replays its own denial.
    const resumedDenial = run.denied.has(denialKey);
    if (run.open && !resumedDenial) return { block: BREAKER_OPEN };
    const args = { ...call.arguments };
    await expandToolCallPaths(call.name, args, agent.env);
    const changed = Object.keys(args).some(
      (field) => args[field] !== call.arguments[field],
    );
    const allow = () => {
      // Invariant: Aborts skip afterTool removal, so the timing map must be
      // bounded.
      if (started.size >= 1024) started.delete(started.keys().next().value!);
      started.set(`${api.taskId}\u0000${call.id}`, startedMs);
      return changed ? { arguments: args as JsonObject } : undefined;
    };
    const mcp = isMcpTool(call.name);
    // Invariant: Direct MCP calls stay blocked even when review is off.
    if (mcp && !nested) return { block: DIRECT_MCP_CALL_MESSAGE };
    const settingsView =
      call.name === "recurse_settings" &&
      (args.action === "levels" || args.action === "themes");
    if (settingsView || (!mcp && !REVIEWED_TOOLS.has(call.name)))
      return allow();
    if (run.config.error) return { block: invalidConfigMessage() };
    if ((await api.snapshot(SafetyDoc, api.conversationId, context))?.off)
      return allow();
    if (context.abortSignal?.aborted) return { block: CANCELLED };
    if (allowedByPathScope(call.name, args, agent.cwd, run.pathScope))
      return allow();
    if (
      call.name === "bash" &&
      typeof args.command === "string" &&
      isReadOnlyBashCommand(args.command)
    ) {
      return allow();
    }

    const release = await acquireReviewSlot(key);
    try {
      if (run.open && !resumedDenial) return { block: BREAKER_OPEN };
      const outcome =
        (await api.memo<Outcome>(memoKey(call.id), context)) ??
        (await api.memo<Outcome>(
          memoKey(call.id),
          await reviewCall(
            call.name,
            args,
            api,
            agent,
            run,
            startedMs,
            context,
            nested,
          ),
          context,
        ));
      if (context.abortSignal?.aborted) return { block: CANCELLED };
      try {
        await agent.conversation.commit(async (tx) => {
          const doc = await tx.doc(SafetyDoc, agent.conversation.id);
          if (outcome.procedural && !doc.off)
            doc.unavailable = unavailableReason(outcome);
          else delete doc.unavailable;
        }, context);
      } catch {
        safeLog("[pi-safety] Availability display state could not be saved.");
      }
      if (outcome.procedural) {
        const failure = classifyReviewFailure(
          outcome.reason,
          Boolean(outcome.journalFailure),
        );
        safeLog(
          `[pi-safety] event=review_failure stage=${failure.stage} category=${failure.category}`,
        );
        return allow();
      }
      if (outcome.decision === "allow") return allow();
      await recordDenied(agent, run.key, denialKey, outcome, context);
      let breaker = {
        count: run.breaker.count,
        open: run.breaker.count >= DENIAL_LIMIT,
      };
      if (!run.denied.has(denialKey)) {
        run.denied.add(denialKey);
        breaker = run.breaker.recordDenial();
      }
      if (breaker.open && !run.open) {
        run.open = true;
        run.stopPending = true;
      }
      return { block: denialMessage(outcome, breaker.count, breaker.open) };
    } finally {
      release();
    }
  };

  const afterTool = async (
    call: { id: string; name: string },
    result: ToolExecutionResult,
    api: HookApi,
    context: Context,
  ): Promise<ToolExecutionResult | undefined> => {
    const startKey = `${api.taskId}\u0000${call.id}`;
    const startedMs = started.get(startKey);
    started.delete(startKey);
    const outcome = await api.memo<Outcome>(memoKey(call.id), context);
    const prior =
      result.details &&
      typeof result.details === "object" &&
      !Array.isArray(result.details)
        ? (result.details as Record<string, unknown>)
        : {};
    const hadReserved = Object.keys(prior).some((field) =>
      RESERVED_RESULT_DETAILS.has(field),
    );
    const totalMs =
      startedMs === undefined ? undefined : positiveElapsedMs(startedMs, now());
    if (!outcome && totalMs === undefined && !hadReserved) return undefined;
    const safetyWaitMs =
      totalMs !== undefined &&
      outcome?.safetyWaitMs !== undefined &&
      outcome.safetyWaitMs <= totalMs
        ? outcome.safetyWaitMs
        : undefined;
    const commandMs =
      totalMs !== undefined && call.name === "bash"
        ? commandTimingMs(prior.recurseCommandTiming, totalMs)
        : undefined;
    const details = {
      ...Object.fromEntries(
        Object.entries(prior).filter(
          ([field]) => !RESERVED_RESULT_DETAILS.has(field),
        ),
      ),
      ...(outcome?.attempts
        ? { recurseSafetyUsage: { version: 1, attempts: outcome.attempts } }
        : {}),
      ...(totalMs === undefined
        ? {}
        : {
            recurseToolTiming: {
              version: 1,
              totalMs,
              ...(safetyWaitMs === undefined ? {} : { safetyWaitMs }),
              ...(commandMs === undefined ? {} : { commandMs }),
            },
          }),
    };
    const reviewerUsage = reportedUsage(outcome?.attempts);
    const usage =
      reviewerUsage && result.usage
        ? addUsage(result.usage, reviewerUsage)
        : (reviewerUsage ?? result.usage);
    const notice = outcome?.procedural
      ? [
          {
            severity: "warn" as const,
            code: "safety_review_failed",
            message: reviewFailureMessage(
              outcome,
              Boolean(outcome.journalFailure),
            ),
          },
        ]
      : [];
    return {
      ...result,
      details: details as ToolExecutionResult["details"],
      ...(usage ? { usage: usage as Usage } : {}),
      ...(notice.length
        ? { diagnostics: [...(result.diagnostics ?? []), ...notice] }
        : {}),
    };
  };

  const extension = defineExtension({
    name: "recurse-safety",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api, context) => decide(call, api, context),
        afterTool: (call, result, api, context) =>
          afterTool(call, result, api, context),
      }),
      // Invariant: Commit blocked results before stopping, preserving denial
      // reasons.
      hook(GenerationTask, {
        afterTools: async (_assistant, _results, api, context) => {
          const agent = await host.agent(api, context);
          // Invariant: Rebuild pending stops from storage after a restart.
          const run = await runState(agent.id, api, context);
          if (!run?.stopPending) return;
          run.stopPending = false;
          agent.stopRun();
        },
      }),
    ],
  });
  return extension;
}
