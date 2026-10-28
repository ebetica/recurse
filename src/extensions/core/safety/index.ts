// Shared Durable side-effect review, MCP detection, bounded billing and
// failures. policy.ts owns reviewer rules; review.ts/transcript.ts own action
// evidence. Codemode also calls ordinary tools; MCP tools require scripts.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DENIAL_LIMIT } from "./circuit-breaker.ts";
import type { ReviewSelection } from "./model-policy.ts";
import {
  reviewAction,
  type SafetyReviewAttempt,
  type SafetyVerdict,
} from "./review.ts";

// Codemode has no fs/net/process access; review each nested state change.
const BASE_REVIEWED_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  "return_to_main",
  "publish",
  "env",
  "recurse_settings",
  "artifact",
]);

// MCP readOnlyHint/resources are untrusted and never skip review.
const MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp__") || MCP_RESOURCE_TOOLS.has(toolName);
}

export const DIRECT_MCP_CALL_MESSAGE =
  "[pi-safety] MCP tools can only be called from a codemode script, so this direct call was blocked.";

export function reviewedToolNames(
  _cwd = process.cwd(),
  _home?: string,
): ReadonlySet<string> {
  return new Set(BASE_REVIEWED_TOOLS);
}

function conciseReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, 1_000);
}

function denialReason(reason: string): string {
  const concise = conciseReason(reason);
  const sentence = /^[A-Z][a-z]+(?=\s|[.!?]|$)/.test(concise)
    ? concise[0]!.toLowerCase() + concise.slice(1)
    : concise;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export function denialMessage(
  verdict: SafetyVerdict,
  count: number,
  open: boolean,
): string {
  const details = `Tool call blocked because ${denialReason(verdict.reason)}`;
  const guidance =
    "Choose a materially safer alternative, or ask the user to explicitly authorize the concrete action — do not retry the same outcome through a workaround.";
  const breaker = open
    ? `Circuit breaker opened after ${count} denied actions; the current agent run has been stopped.`
    : `Denied actions this run: ${count}/${DENIAL_LIMIT}.`;
  return `[pi-safety] ${details}\n${guidance}\n${breaker}`;
}

export function invalidConfigMessage(): string {
  return "[pi-safety] Safety policy could not be loaded, so this agent run was blocked.";
}

type ReviewFailure = {
  stage: "journal" | "provider" | "infrastructure";
  category:
    | "capacity"
    | "failure"
    | "timeout"
    | "auth"
    | "unavailable"
    | "invalid"
    | "aborted"
    | "unknown";
  summary: string;
};

export function classifyReviewFailure(
  reason: string,
  journalFailure: boolean,
): ReviewFailure {
  const normalized = reason.toLowerCase();
  const observedJournalFailure =
    journalFailure || normalized.includes("reviewer journal");
  if (observedJournalFailure) {
    return normalized.includes("capacity") ||
      normalized.includes("bounded capacity")
      ? {
          stage: "journal",
          category: "capacity",
          summary:
            "Reviewer journal capacity reached; explicitly compact the conversation.",
        }
      : {
          stage: "journal",
          category: "failure",
          summary:
            "Reviewer journal failed; retry the action after checking Recurse storage.",
        };
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return {
      stage: "provider",
      category: "timeout",
      summary: "Reviewer request timed out.",
    };
  }
  if (
    normalized.includes("authenticate") ||
    normalized.includes("authentication") ||
    normalized.includes("api key") ||
    normalized.includes("credential") ||
    normalized.includes("unauthorized") ||
    /\b401\b/.test(normalized)
  ) {
    return {
      stage: "provider",
      category: "auth",
      summary: "Reviewer authentication failed.",
    };
  }
  if (normalized.includes("no active model")) {
    return {
      stage: "provider",
      category: "unavailable",
      summary: "No active reviewer model is available.",
    };
  }
  if (normalized.includes("configured reviewer model")) {
    return {
      stage: "provider",
      category: "unavailable",
      summary:
        "The configured reviewer model is unavailable or does not match the active model policy.",
    };
  }
  if (normalized.includes("did not receive the review policy")) {
    return {
      stage: "provider",
      category: "invalid",
      summary: "Reviewer never received the review policy.",
    };
  }
  if (
    normalized.includes("invalid verdict") ||
    normalized.includes("invalid decision json") ||
    normalized.includes("invalid response")
  ) {
    return {
      stage: "provider",
      category: "invalid",
      summary: "Reviewer returned an invalid response.",
    };
  }
  if (normalized.includes("aborted")) {
    return {
      stage: "provider",
      category: "aborted",
      summary: "Reviewer request was aborted.",
    };
  }
  if (
    normalized.includes("provider") ||
    normalized.includes("did not finish cleanly")
  ) {
    return {
      stage: "provider",
      category: "failure",
      summary: "Reviewer provider request failed.",
    };
  }
  return {
    stage: "infrastructure",
    category: "unknown",
    summary: "Reviewer infrastructure error.",
  };
}

export function reviewFailureMessage(
  verdict: SafetyVerdict,
  journalFailure = false,
): string {
  const failure = classifyReviewFailure(verdict.reason, journalFailure);
  return `[pi-safety] Safety review failed, so this action was allowed without review. Reviewer error: ${failure.summary}`;
}

function reviewerAuthFailure(verdict: SafetyVerdict): boolean {
  return (
    Boolean(verdict.procedural) &&
    classifyReviewFailure(verdict.reason, false).category === "auth"
  );
}

export function safeLog(message: string): void {
  // Invariant: Diagnostic logging must never reverse the fail-open decision.
  try {
    console.error(message);
  } catch {}
}

type ReviewAction = typeof reviewAction;

/** Review with the first runner-owned candidate. Authentication is checked
 * before completion, so a provider auth failure can safely advance to the next
 * candidate without duplicating a review or weakening a real DENY. All attempts
 * are kept because a remote auth failure may still have unknown spend. */
export async function reviewWithCandidates(
  review: ReviewAction,
  ctx: ExtensionContext,
  reviewers: readonly ReviewSelection[],
  args: {
    rules: readonly string[];
    transcript: string;
    action: string;
    durableEvidence: string;
    conversationId: string | undefined;
    blocks: readonly string[] | undefined;
    complete?: Parameters<ReviewAction>[6];
    inputs?: Parameters<ReviewAction>[10];
  },
): Promise<SafetyVerdict> {
  const call = (candidate: ReviewSelection) =>
    review(
      ctx,
      candidate.model,
      candidate.effort,
      args.rules,
      args.transcript,
      args.action,
      args.complete,
      args.durableEvidence,
      args.conversationId,
      args.blocks,
      args.inputs,
    );
  let verdict = await call(reviewers[0]!);
  const reviewAttempts = [...(verdict.reviewAttempts ?? [])];
  for (const candidate of reviewers.slice(1)) {
    if (!reviewerAuthFailure(verdict)) break;
    const candidateVerdict = await call(candidate);
    reviewAttempts.push(...(candidateVerdict.reviewAttempts ?? []));
    verdict = reviewAttempts.length
      ? { ...candidateVerdict, reviewAttempts }
      : candidateVerdict;
  }
  return verdict;
}

/** The built-in reviewer retries once. Bound custom implementations too so one
 * tool result cannot carry unbounded hidden metadata. */
export function boundedAttempts(
  attempts: readonly SafetyReviewAttempt[],
): SafetyReviewAttempt[] {
  return attempts.length > 4
    ? [
        ...attempts.slice(0, 3).map((attempt) => ({ ...attempt })),
        // Invariant: Omitted provider billing stays explicitly unreported.
        { status: "unreported" as const },
      ]
    : attempts.map((attempt) => ({ ...attempt }));
}

export const RESERVED_RESULT_DETAILS = new Set([
  "recurseCommandTiming",
  "recurseToolTiming",
  "recurseSafetyTiming",
  "recurseSafetyUsage",
  "recurseSafetyCircuitBreaker",
  "recurseSafetyCircuit",
]);

export function positiveElapsedMs(
  start: number,
  end: number,
): number | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const elapsed = end - start;
  if (!(elapsed > 0) || !Number.isFinite(elapsed)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.round(elapsed)));
}

export function commandTimingMs(
  value: unknown,
  totalMs: number,
): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const timing = value as { version?: unknown; commandMs?: unknown };
  return timing.version === 1 &&
    Number.isSafeInteger(timing.commandMs) &&
    (timing.commandMs as number) > 0 &&
    (timing.commandMs as number) <= totalMs
    ? (timing.commandMs as number)
    : undefined;
}
