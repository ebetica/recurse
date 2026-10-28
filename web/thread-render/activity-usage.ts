// Pure view model for token usage attributed to one operator-response boundary.
// Inputs are completed backend turns assigned by activity-boundary.ts.
// Assistant rows never participate: only a turn summary can account for every
// model call.
import type {
  ConversationModelUsageGroup,
  SafetyReviewUsageGroup,
  SafetyReviewUsageTotal,
  Turn,
  TurnUsage,
  TurnUsageTotal,
} from "../types.js";
import {
  conversationModelUsage,
  formatCost,
  formatTokenCount,
  safetyReviewUsage,
  turnTotalUsage,
  turnUsageModel,
} from "./turn-usage.js";

interface UsageSum {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
  cost: number;
  costReported: boolean;
  costPartial: boolean;
}

export interface ActivityUsage {
  completedTurns: number;
  reportedTurns: number;
  assistantMessages: number;
  toolCalls: number;
  modelTokens: number | null;
  modelPartial: boolean;
  safetyTokens: number | null;
  safetyPartial: boolean;
  modelTotal: TurnUsageTotal | null;
  safetyTotal: SafetyReviewUsageTotal | null;
}

function emptySum(): UsageSum {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
    cost: 0,
    costReported: false,
    costPartial: false,
  };
}

function addUsage(
  sum: UsageSum,
  usage: TurnUsage,
  calls: number,
  costPartial: boolean | undefined,
): boolean {
  if (!turnUsageModel(usage) || !Number.isSafeInteger(calls) || calls < 0)
    return false;
  const next = {
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: sum.cacheWrite + usage.cacheWrite,
    calls: sum.calls + calls,
  };
  if (Object.values(next).some((value) => !Number.isSafeInteger(value)))
    return false;
  Object.assign(sum, next);

  if (
    typeof usage.cost === "number" &&
    Number.isFinite(usage.cost) &&
    usage.cost >= 0 &&
    Number.isFinite(sum.cost + usage.cost)
  ) {
    sum.cost += usage.cost;
    sum.costReported = true;
  } else {
    sum.costPartial = true;
  }
  sum.costPartial ||= costPartial === true;
  return true;
}

function usageFrom(sum: UsageSum): TurnUsage {
  return {
    input: sum.input,
    output: sum.output,
    cacheRead: sum.cacheRead,
    cacheWrite: sum.cacheWrite,
    ...(sum.costReported ? { cost: sum.cost } : {}),
    costPartial: sum.costPartial,
  };
}

function tokenCount(usage: TurnUsage): number | null {
  const model = turnUsageModel(usage);
  if (!model) return null;
  const total = model.promptTokens + model.output;
  return Number.isSafeInteger(total) ? total : null;
}

function nonnegativeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function turnAssistantMessages(
  turn: Turn,
  model: TurnUsageTotal | null,
): number {
  if (model) return model.replies;
  return turn.segments.reduce(
    (count, segment) => count + (segment.assistant ? 1 : 0),
    0,
  );
}

function turnToolCalls(turn: Turn): number {
  const summarized = nonnegativeCount(turn.summary?.tools);
  if (summarized !== null) return summarized;
  return turn.segments.reduce(
    (count, segment) => count + segment.tools.length,
    0,
  );
}

function groupedModelUsage(
  groups: Map<string, UsageSum>,
): ConversationModelUsageGroup[] {
  return [...groups].map(([selector, sum]) => ({
    ...usageFrom(sum),
    selector,
    calls: sum.calls,
    costPartial: sum.costPartial,
  }));
}

function groupedSafetyUsage(
  groups: Map<string, UsageSum>,
): SafetyReviewUsageGroup[] {
  return [...groups].map(([selector, sum]) => ({
    ...usageFrom(sum),
    selector,
    calls: sum.calls,
    costPartial: sum.costPartial,
  }));
}

// `ambiguous` is presentation uncertainty: a live/page-leading/byte-partial
// boundary can be missing turns even though the completed totals it does
// contain are authoritative. It lowers every retained subtotal without
// inventing one.
export function activityUsage(
  turns: readonly Turn[],
  ambiguous = false,
): ActivityUsage {
  const modelSum = emptySum();
  const modelGroups = new Map<string, UsageSum>();
  const safetyGroups = new Map<string, UsageSum>();
  let completedTurns = 0;
  let reportedTurns = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let modelTurns = 0;
  let replies = 0;
  let safetyCalls = 0;
  let modelReported = false;
  let safetyReported = false;
  let modelPartial = ambiguous;
  let modelGroupsPartial = ambiguous;
  let safetyPartial = ambiguous;

  for (const turn of turns) {
    if (turn.open) {
      modelPartial = true;
      safetyPartial = true;
      continue;
    }
    completedTurns += 1;
    const model = turnTotalUsage(turn.summary);
    assistantMessages += turnAssistantMessages(turn, model);
    toolCalls += turnToolCalls(turn);
    let turnReported = false;
    const safety = safetyReviewUsage(turn.summary?.safety_usage);
    if (!model) {
      // Invariant: Legacy turns may have per-answer usage, but it is not a turn
      // total.
      modelPartial = true;
    } else if (
      !Number.isSafeInteger(replies + model.replies) ||
      !addUsage(modelSum, model, model.calls, model.costPartial)
    ) {
      modelPartial = true;
      modelGroupsPartial = true;
    } else {
      turnReported = true;
      modelTurns += 1;
      replies += model.replies;
      modelReported = true;
      modelPartial ||= model.partial;
      const grouped = conversationModelUsage(model);
      if (!grouped) {
        modelGroupsPartial = true;
      } else {
        modelGroupsPartial ||= grouped.partial;
        for (const group of grouped.groups) {
          const sum = modelGroups.get(group.selector) || emptySum();
          if (addUsage(sum, group, group.calls, group.costPartial)) {
            modelGroups.set(group.selector, sum);
          } else {
            modelGroupsPartial = true;
          }
        }
      }
    }

    if (turn.summary?.safety_usage != null) {
      if (!safety || !Number.isSafeInteger(safetyCalls + safety.calls)) {
        safetyPartial = true;
      } else {
        safetyCalls += safety.calls;
        safetyPartial ||= safety.partial;
        for (const group of safety.groups) {
          const sum = safetyGroups.get(group.selector) || emptySum();
          if (addUsage(sum, group, group.calls, group.costPartial)) {
            safetyGroups.set(group.selector, sum);
            safetyReported = true;
            turnReported = true;
          } else {
            safetyPartial = true;
          }
        }
      }
    }
    if (turnReported) reportedTurns += 1;
  }

  // Invariant: Missing legacy conversation totals affect only that provider.
  // True boundary uncertainty can hide calls from either provider, so it lowers
  // both retained subtotals without inventing an absent one.
  if (modelReported && modelTurns < completedTurns) modelPartial = true;
  if (ambiguous) {
    if (modelReported) modelPartial = true;
    if (safetyReported) safetyPartial = true;
  }

  let modelTotal: TurnUsageTotal | null = modelReported
    ? {
        ...usageFrom(modelSum),
        calls: modelSum.calls,
        replies,
        partial: modelPartial,
        model_groups: groupedModelUsage(modelGroups),
        model_usage_partial: modelGroupsPartial || modelPartial,
      }
    : null;
  if (modelTotal && modelPartial) {
    modelTotal.costPartial = true;
    modelTotal.model_groups = modelTotal.model_groups?.map((group) => ({
      ...group,
      costPartial: true,
    }));
  }

  let modelTokens = modelTotal ? tokenCount(modelTotal) : null;
  if (modelTotal && modelTokens === null) {
    modelPartial = true;
    modelTotal = { ...modelTotal, partial: true, costPartial: true };
  }

  let safetyTokens = 0;
  let safetyTokenReported = false;
  const safetyTotal: SafetyReviewUsageTotal | null = safetyReported
    ? {
        calls: safetyCalls,
        partial: safetyPartial,
        groups: groupedSafetyUsage(safetyGroups).map((group) =>
          safetyPartial ? { ...group, costPartial: true } : group,
        ),
      }
    : null;
  for (const group of safetyTotal?.groups || []) {
    const count = tokenCount(group);
    if (count === null || !Number.isSafeInteger(safetyTokens + count)) {
      safetyPartial = true;
      continue;
    }
    safetyTokens += count;
    safetyTokenReported = true;
  }
  if (safetyTotal && safetyPartial) safetyTotal.partial = true;

  return {
    completedTurns,
    reportedTurns,
    assistantMessages,
    toolCalls,
    modelTokens,
    modelPartial,
    safetyTokens: safetyTokenReported ? safetyTokens : null,
    safetyPartial,
    modelTotal,
    safetyTotal,
  };
}

// Sums reply usage when no recorded aggregate exists: always a lower bound.
// Missing calls contribute nothing; cumulative scope prices never sum.
export function replyUsageTotal(
  reported: readonly (TurnUsage | null | undefined)[],
  counts: Pick<
    ActivityUsage,
    "completedTurns" | "assistantMessages" | "toolCalls"
  > = {
    completedTurns: 0,
    assistantMessages: 0,
    toolCalls: 0,
  },
): ActivityUsage | null {
  const sum = emptySum();
  let replies = 0;
  for (const usage of reported) {
    const model = turnUsageModel(usage);
    if (!model || !addUsage(sum, model, 0, true)) continue;
    replies += 1;
  }
  if (!replies) return null;
  // Invariant: A scope's cumulative price can repeat across replies, so cost is
  // never summed: drop whatever the adder accumulated and mark the price
  // partial.
  const tokens = usageFrom(sum);
  delete tokens.cost;
  const modelTotal: TurnUsageTotal = {
    ...tokens,
    costPartial: true,
    calls: 1,
    replies,
    partial: true,
    model_usage_partial: true,
  };
  return {
    completedTurns: counts.completedTurns,
    reportedTurns: 0,
    assistantMessages: counts.assistantMessages || replies,
    toolCalls: counts.toolCalls,
    modelTokens: tokenCount(modelTotal),
    modelPartial: true,
    safetyTokens: null,
    safetyPartial: false,
    modelTotal,
    safetyTotal: null,
  };
}

export function activityUsageLabel(usage: ActivityUsage): string {
  const parts: string[] = [];
  if (usage.modelTokens !== null) {
    parts.push(`${formatTokenCount(usage.modelTokens)} model tokens`);
  }
  if (usage.safetyTokens !== null) {
    parts.push(`${formatTokenCount(usage.safetyTokens)} safety-review tokens`);
  }
  const label = parts.join(" · ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function activityTotalCostLabel(usage: ActivityUsage): string {
  if (!usage.modelTotal) return "";
  const cost = formatCost(usage.modelTotal.cost);
  if (cost === null) return "";
  return `Total cost: ${cost}${usage.modelTotal.costPartial ? "+" : ""}`;
}

export function activityUsageCaption(usage: ActivityUsage): string {
  const turns = usage.completedTurns;
  const turnNoun = turns === 1 ? "turn" : "turns";
  const messages = usage.assistantMessages;
  const messageNoun = messages === 1 ? "message" : "messages";
  const tools = usage.toolCalls;
  const toolNoun = tools === 1 ? "tool call" : "tool calls";
  const requests = usage.modelTotal?.calls;
  const requestNote =
    requests !== undefined && requests !== messages + tools
      ? ` (${requests} model request${requests === 1 ? "" : "s"})`
      : "";
  return `Totals for ${turns} ${turnNoun}: ${messages} ${messageNoun} and ${tools} ${toolNoun}${requestNote}.`;
}
