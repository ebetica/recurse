// Uses Pi-reported usage: prompt volume is input + cacheRead + cacheWrite. Only
// recorded backend totals cover whole turns; replies cannot recreate missing
// provider calls or authoritative turn totals.
import type {
  ConversationModelUsageGroup,
  SafetyReviewUsageGroup,
  SafetyReviewUsageTotal,
  TurnSummary,
  TurnUsage,
  TurnUsageTotal,
} from "../types.js";

export interface TurnUsageModel extends TurnUsage {
  promptTokens: number;
  inputPercent: number;
  cacheReadPercent: number;
  cacheWritePercent: number;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function turnUsageModel(
  usage: TurnUsage | null | undefined,
): TurnUsageModel | null {
  if (
    !usage ||
    !validCount(usage.input) ||
    !validCount(usage.output) ||
    !validCount(usage.cacheRead) ||
    !validCount(usage.cacheWrite)
  )
    return null;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!Number.isSafeInteger(promptTokens)) return null;
  return {
    ...usage,
    promptTokens,
    inputPercent: promptTokens ? (usage.input / promptTokens) * 100 : 0,
    cacheReadPercent: promptTokens ? (usage.cacheRead / promptTokens) * 100 : 0,
    cacheWritePercent: promptTokens
      ? (usage.cacheWrite / promptTokens) * 100
      : 0,
  };
}

// Reads recorded turn totals and partiality, never reconstructing from replies.
// Calls/replies count different events; arithmetic can cancel independent gaps.
export function turnTotalUsage(
  summary: TurnSummary | null | undefined,
): TurnUsageTotal | null {
  const total = summary?.usage;
  if (!total || !turnUsageModel(total)) return null;
  if (!validCount(total.calls) || !validCount(total.replies)) return null;
  if (
    typeof total.partial !== "boolean" ||
    ("costPartial" in total && typeof total.costPartial !== "boolean")
  )
    return null;
  // Invariant: No reported call means no total, whatever the other numbers say.
  if (total.calls < 1) return null;
  return total;
}

// Labels whole-turn scope, answer count and completeness, never a single
// answer's cost or an exact total when part is missing.
export function turnUsageLabel(total: TurnUsageTotal | null): string {
  if (!total) return "Token usage for this turn's last answer";
  const answers =
    total.replies > 1 ? `, across its ${total.replies} answers` : "";
  const partial = total.partial || total.costPartial === true;
  return (
    `Token usage for this turn${answers}` +
    (partial ? ", at least this much" : "")
  );
}

// Names whole-turn request aggregation, including tool-loop calls. These summed
// measurements can exceed any single model context.
export function turnUsageCaption(total: TurnUsageTotal | null): string {
  if (!total) {
    return (
      "Tokens the model provider reported for this answer. An agent that was" +
      " interrupted and sent somewhere else mid-turn gave more than one answer," +
      " and these counts cover only the last."
    );
  }
  const parts = ["Totals for this whole turn."];
  if (total.calls > 1) {
    parts.push(
      `This turn went to the model ${total.calls} times — every tool result` +
        " and every new instruction sends the conversation again, and each request is" +
        ` charged for everything it sent. These totals add up all ${total.calls}` +
        " requests, not just the last one.",
    );
  }
  if (total.partial || total.costPartial === true) {
    parts.push(
      "Part of this turn is missing from the record — a request the" +
        " provider did not report, or an earlier run of the turn that a container" +
        " replacement cut short — so these are at least this much rather than" +
        " exactly this much.",
    );
  }
  return parts.join(" ");
}

const exactTokens = new Intl.NumberFormat("en-US");
const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatTokenCount(value: number): string {
  return compactTokens.format(value).toLowerCase();
}

export function formatExactTokenCount(value: number): string {
  return exactTokens.format(value);
}

export function conversationModelUsage(
  value: TurnUsageTotal | null | undefined,
  fallbackSelector?: string | null,
): { groups: ConversationModelUsageGroup[]; partial: boolean } | null {
  if (
    !value ||
    !turnUsageModel(value) ||
    !validCount(value.calls) ||
    value.calls < 1
  )
    return null;
  const fallback =
    typeof fallbackSelector === "string" && fallbackSelector.trim()
      ? fallbackSelector
      : null;
  const rawGroups = value.model_groups;
  if (!Array.isArray(rawGroups) && !fallback) return null;
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) return null;

  let groupedCalls = 0;
  const grouped = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const selectors = new Set<string>();
  const groups: ConversationModelUsageGroup[] = [];
  let knownCost = 0;
  let knownCostComplete = true;
  for (const group of rawGroups || []) {
    if (
      !turnUsageModel(group) ||
      typeof group.selector !== "string" ||
      !group.selector ||
      selectors.has(group.selector) ||
      !validCount(group.calls) ||
      group.calls < 1 ||
      typeof group.costPartial !== "boolean" ||
      (!group.costPartial &&
        (typeof group.cost !== "number" ||
          !Number.isFinite(group.cost) ||
          group.cost < 0))
    )
      return null;
    selectors.add(group.selector);
    groups.push({ ...group });
    groupedCalls += group.calls;
    if (!Number.isSafeInteger(groupedCalls) || groupedCalls > value.calls)
      return null;
    for (const field of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
    ] as const) {
      grouped[field] += group[field];
      if (
        !Number.isSafeInteger(grouped[field]) ||
        grouped[field] > value[field]
      )
        return null;
    }
    if (
      group.costPartial ||
      typeof group.cost !== "number" ||
      !Number.isFinite(group.cost) ||
      group.cost < 0
    ) {
      knownCostComplete = false;
    } else {
      knownCost += group.cost;
      if (!Number.isFinite(knownCost)) knownCostComplete = false;
    }
  }

  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const tokenCoveragePartial = fields.some(
    (field) => grouped[field] !== value[field],
  );
  const missingCalls = value.calls - groupedCalls;
  const canAttributeRemainder =
    fallback !== null && (missingCalls > 0 || tokenCoveragePartial);
  if (canAttributeRemainder && fallback !== null && missingCalls > 0) {
    const remainder = {
      input: value.input - grouped.input,
      output: value.output - grouped.output,
      cacheRead: value.cacheRead - grouped.cacheRead,
      cacheWrite: value.cacheWrite - grouped.cacheWrite,
    };
    if (fields.some((field) => !validCount(remainder[field]))) return null;
    let remainderCost: number | undefined;
    let remainderCostPartial = value.costPartial === true;
    if (
      typeof value.cost === "number" &&
      Number.isFinite(value.cost) &&
      value.cost >= 0 &&
      knownCostComplete
    ) {
      const candidate = Number((value.cost - knownCost).toFixed(12));
      if (Number.isFinite(candidate) && candidate >= 0) {
        remainderCost = candidate;
      } else {
        remainderCostPartial = true;
      }
    } else {
      remainderCostPartial = true;
    }
    const existing = groups.find((group) => group.selector === fallback);
    if (existing) {
      const merged = {
        input: existing.input + remainder.input,
        output: existing.output + remainder.output,
        cacheRead: existing.cacheRead + remainder.cacheRead,
        cacheWrite: existing.cacheWrite + remainder.cacheWrite,
        calls: existing.calls + missingCalls,
      };
      if (
        fields.some((field) => !Number.isSafeInteger(merged[field])) ||
        !Number.isSafeInteger(merged.calls)
      )
        return null;
      Object.assign(existing, merged);
      if (remainderCost !== undefined && existing.cost !== undefined) {
        const mergedCost = existing.cost + remainderCost;
        if (Number.isFinite(mergedCost) && mergedCost >= 0)
          existing.cost = mergedCost;
        else remainderCostPartial = true;
      } else if (remainderCost !== undefined) {
        existing.cost = remainderCost;
      }
      existing.costPartial ||= remainderCostPartial;
    } else {
      groups.push({
        ...remainder,
        selector: fallback,
        calls: missingCalls,
        ...(remainderCost !== undefined ? { cost: remainderCost } : {}),
        costPartial: remainderCostPartial,
      });
    }
    groupedCalls += missingCalls;
    for (const field of fields) grouped[field] += remainder[field];
  }

  const coveragePartial = fields.some(
    (field) => grouped[field] !== value[field],
  );
  const partial = fallback
    ? value.partial || groupedCalls !== value.calls || coveragePartial
    : value.model_usage_partial === true ||
      value.partial ||
      groupedCalls !== value.calls ||
      coveragePartial;
  return { groups, partial };
}

// Token counts that the authoritative conversation total has but its known
// selector rows do not. Cost is deliberately absent: this row is attribution,
// not a guessed model or price.
export function conversationUsageRemainder(
  total: TurnUsage | null | undefined,
  groups: readonly TurnUsage[],
): TurnUsage | null {
  const aggregate = turnUsageModel(total);
  if (!aggregate) return null;
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const grouped = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const group of groups) {
    if (!turnUsageModel(group)) return null;
    for (const field of fields) {
      const next = grouped[field] + group[field];
      if (!Number.isSafeInteger(next) || next > aggregate[field]) return null;
      grouped[field] = next;
    }
  }
  const remainder = {
    input: aggregate.input - grouped.input,
    output: aggregate.output - grouped.output,
    cacheRead: aggregate.cacheRead - grouped.cacheRead,
    cacheWrite: aggregate.cacheWrite - grouped.cacheWrite,
  };
  if (fields.some((field) => !validCount(remainder[field]))) return null;
  return fields.some((field) => remainder[field] > 0) ? remainder : null;
}

export function safetyReviewUsage(
  value: SafetyReviewUsageTotal | null | undefined,
): SafetyReviewUsageTotal | null {
  if (
    !value ||
    !validCount(value.calls) ||
    value.calls < 1 ||
    typeof value.partial !== "boolean" ||
    !Array.isArray(value.groups)
  )
    return null;
  const groups: SafetyReviewUsageGroup[] = [];
  const selectors = new Set<string>();
  let groupedCalls = 0;
  for (const group of value.groups) {
    if (
      !turnUsageModel(group) ||
      typeof group.selector !== "string" ||
      !group.selector ||
      selectors.has(group.selector) ||
      !validCount(group.calls) ||
      group.calls < 1
    )
      return null;
    selectors.add(group.selector);
    groupedCalls += group.calls;
    if (!Number.isSafeInteger(groupedCalls) || groupedCalls > value.calls)
      return null;
    // Invariant: A turn closed before a reviewer price could be unavailable
    // recorded no costPartial. Its token counts are exact and still worth
    // showing; discard the ambiguous legacy zero rather than claiming the
    // review was free.
    if (typeof group.costPartial !== "boolean") {
      const { cost: _ambiguousCost, ...counts } = group;
      groups.push({ ...counts, costPartial: true });
      continue;
    }
    if (
      !group.costPartial &&
      (typeof group.cost !== "number" ||
        !Number.isFinite(group.cost) ||
        group.cost < 0)
    )
      return null;
    groups.push(group);
  }
  return {
    ...value,
    groups,
    partial: value.partial || groupedCalls !== value.calls,
  };
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatCost(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? usd.format(value)
    : null;
}
