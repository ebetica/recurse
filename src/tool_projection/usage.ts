// Provider-boundary usage/cost normalization and turn/segment accumulators.
// Count checks refuse noninteger/unsafe values; JS loses integral-float
// identity.
// Unsafe integer-valued costs are conservatively rejected.

import type { JsonObject } from "./redaction";

export const USAGE_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const;
export const MAX_USAGE_GROUPS = 16;
export const MAX_MODEL_SCOPE_KEYS = MAX_USAGE_GROUPS;
export const MAX_MODEL_SCOPE_ENTRIES = 2048;
export const MAX_MODEL_SCOPE_BYTES = 64 * 1024;

const MAX_SAFE_USAGE = Number.MAX_SAFE_INTEGER;
const MAX_COST_SCOPES = 512;
const MAX_COST_SCOPE_BYTES = 128;
const MAX_MODEL_SCOPE_IDS = MAX_COST_SCOPES;
const MODEL_GROUPS_STATE_VERSION = 2;
const COST_SCOPE_OVERFLOW = Symbol("cost-scope-overflow");
const COST_SCOPE_INVALID = Symbol("cost-scope-invalid");
const COST_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\s\S])/u;
const MODEL_SCOPE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}(?![\s\S])/u;

type Row = Record<string, any>;
type CostResult =
  | string
  | null
  | typeof COST_SCOPE_OVERFLOW
  | typeof COST_SCOPE_INVALID;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSet(value: unknown): value is Set<unknown> {
  return value instanceof Set;
}

function setEquals(values: unknown, expected: string): boolean {
  return isSet(values) && values.size === 1 && values.has(expected);
}

/** Accept only compact ASCII scope ids at the provider boundary. */
export function validCostScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_COST_SCOPE_BYTES &&
    /^[\x00-\x7f]+$/u.test(value) &&
    COST_SCOPE_RE.test(value)
  );
}

/** Accept only compact ASCII model selectors in durable scope metadata. */
export function validModelScopeKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_COST_SCOPE_BYTES &&
    /^[\x00-\x7f]+$/u.test(value) &&
    MODEL_SCOPE_KEY_RE.test(value)
  );
}

/** A billed token count representable exactly by browser numbers. */
export function validUsageCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_SAFE_USAGE
  );
}

/** A finite, nonnegative cost that can be accumulated safely. */
export function validUsageCost(value: unknown): value is number {
  return (
    typeof value === "number" &&
    !Number.isNaN(value) &&
    Number.isFinite(value) &&
    value >= 0 &&
    (!Number.isInteger(value) || Math.abs(value) <= MAX_SAFE_USAGE)
  );
}

/** One provider call's dollar cost, or null when the provider stated none. */
export function reportedCost(
  total: unknown,
  billedTokens: number,
  source: unknown = undefined,
): number | null {
  if (source === "unknown") return null;
  if (source === "authoritative") return validUsageCost(total) ? total : null;
  if (source !== undefined && source !== null) return null;
  if (!validUsageCost(total)) return null;
  if (total === 0 && billedTokens > 0) return null;
  return total;
}

function joinSelector(provider: unknown, model: unknown): string | null {
  if (!validModelScopeKey(provider) || !validModelScopeKey(model)) return null;
  const candidate = `${provider}/${model}`;
  return validModelScopeKey(candidate) ? candidate : null;
}

function resolveUsageSelector(
  provider: unknown,
  model: unknown,
  rawUsage: JsonObject,
): string | null {
  if (
    (provider === undefined || provider === null) &&
    (model === undefined || model === null)
  ) {
    const selectors = rawUsage["selectors"];
    if (
      rawUsage["selectorPartial"] === false &&
      Array.isArray(selectors) &&
      selectors.length === 1 &&
      validModelScopeKey(selectors[0])
    ) {
      return selectors[0];
    }
    return null;
  }
  return joinSelector(provider, model);
}

function normalizeUsageCost(
  rawUsage: JsonObject,
): [number | null, string | null] {
  const rawCost = rawUsage["cost"];
  const rawTotal = isRecord(rawCost) ? rawCost["total"] : rawCost;
  const rawSource = rawUsage["costSource"];
  let source =
    typeof rawSource === "string" &&
    (rawSource === "authoritative" || rawSource === "unknown")
      ? rawSource
      : null;
  const rawScope = rawUsage["costScope"];
  const invalidScope =
    rawScope !== undefined && rawScope !== null && !validCostScope(rawScope);
  if (invalidScope) source = "unknown";
  const billedTokens = USAGE_KEYS.reduce(
    (sum, key) => sum + Number(rawUsage[key]),
    0,
  );
  const cost = invalidScope
    ? null
    : reportedCost(rawTotal, billedTokens, source ?? undefined);
  return [cost, source];
}

function applyUsageFields(
  usage: Row,
  cost: number | null,
  source: string | null,
  rawUsage: JsonObject,
): void {
  if (source !== null)
    usage["costSource"] =
      cost !== null || source === "unknown" ? source : "unknown";
  if (cost !== null) usage["cost"] = cost;
  if (validCostScope(rawUsage["costScope"]))
    usage["costScope"] = rawUsage["costScope"];
  if (typeof rawUsage["costScopePartial"] === "boolean") {
    usage["costScopePartial"] = rawUsage["costScopePartial"];
  }
}

/** Normalize one Pi assistant message's provider usage for turn accounting. */
export function providerUsage(message: unknown): Row | null {
  if (!isRecord(message)) return null;
  const rawUsage = message["usage"];
  if (
    !isRecord(rawUsage) ||
    !USAGE_KEYS.every((key) => validUsageCount(rawUsage[key]))
  ) {
    return null;
  }
  const usage: Row = {};
  for (const key of USAGE_KEYS) usage[key] = rawUsage[key];
  const provider = message["provider"];
  const model = message["model"];
  const selector = resolveUsageSelector(provider, model, rawUsage);
  if (selector !== null) {
    usage["selectors"] = [selector];
    usage["selectorPartial"] = false;
  } else if (
    (provider !== undefined && provider !== null) ||
    (model !== undefined && model !== null) ||
    "selectors" in rawUsage ||
    "selectorPartial" in rawUsage
  ) {
    usage["selectorPartial"] = true;
  }
  const [cost, source] = normalizeUsageCost(rawUsage);
  applyUsageFields(usage, cost, source, rawUsage);
  return usage;
}

/** One Pi assistant entry's native usage as ledger-shaped counters. */
export function normalizePiUsage(
  message: JsonObject,
): Record<string, number> | null {
  const usage = message["usage"];
  if (!isRecord(usage)) return null;
  const counts: Record<string, number> = {};
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (!validUsageCount(value)) return null;
    counts[key] = value;
  }
  return counts;
}

function reportedSelector(usage: JsonObject): string | null {
  const selectors = usage["selectors"];
  if (
    usage["selectorPartial"] === false &&
    Array.isArray(selectors) &&
    selectors.length === 1 &&
    validModelScopeKey(selectors[0])
  ) {
    return selectors[0];
  }
  return null;
}

/** Fold Pi assistant-message usage fields into one turn summary. */
export function summarizePiMessages(messages: unknown): Row | null {
  const usage = new TurnUsage();
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    const normalized = providerUsage(message);
    if (normalized === null) {
      usage.partial = true;
      continue;
    }
    usage.addCall(normalized, true);
  }
  return usage.summary();
}

// Fold finalized safety-review attempts without mixing them into model totals.
export function summarizeSafetyResults(results: unknown): Row | null {
  const usage = new TurnUsage();
  if (!Array.isArray(results)) return null;
  for (const result of results) usage.addSafetyResult(result);
  return usage.safetySummary();
}

/** Whole-turn provider and safety-review billing, durably accumulated. */
export class TurnUsage {
  totals: Record<(typeof USAGE_KEYS)[number], number> = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  calls = 0;
  reports = 0;
  reported = 0;
  replies = 0;
  partial = false;
  cost = 0;
  costPartial = false;
  costScopes = new Map<string, Row>();
  unscopedCost = 0;
  unscopedCostPartial = false;
  selectors: string[] = [];
  modelGroups = new Map<string, Row>();
  modelScopeIds = new Map<string, Set<string>>();
  modelUsagePartial = false;
  modelScopePartial = new Set<string>();
  safetyGroups = new Map<string, Row>();
  safetyCalls = 0;
  safetyPartial = false;

  private static scope(value: unknown): string | null {
    return validCostScope(value) ? value : null;
  }

  private markModelPartial(selector: unknown): void {
    if (typeof selector === "string" && validModelScopeKey(selector)) {
      this.modelScopePartial.add(selector);
    }
    this.modelUsagePartial = true;
    this.partial = true;
  }

  private markAllModelsPartial(): void {
    this.modelUsagePartial = true;
    if (this.modelGroups.size > 0) this.partial = true;
    for (const [selector, group] of this.modelGroups) {
      this.modelScopePartial.add(selector);
      group["costPartial"] = true;
    }
  }

  private recomputeCost(): void {
    let total = this.unscopedCost;
    let partial = this.unscopedCostPartial;
    for (const scope of this.costScopes.values()) {
      if (scope["partial"] === true) {
        partial = true;
        this.partial = true;
      }
      if (scope["authoritative"] === true && validUsageCost(scope["cost"])) {
        total += scope["cost"];
      } else {
        partial = true;
      }
    }
    if (!validUsageCost(total)) {
      this.cost = 0;
      this.costPartial = true;
    } else {
      this.cost = total;
      this.costPartial = partial;
    }
  }

  private addUnscopedCost(cost: number | null, source: unknown): void {
    if (cost === null) {
      this.unscopedCostPartial = true;
      if (source === "unknown") this.partial = true;
    } else {
      this.unscopedCost += cost;
    }
    this.recomputeCost();
  }

  private addCost(usage: Row, billedTokens: number): CostResult {
    const source = usage["costSource"];
    const rawScope = usage["costScope"];
    const scopeId = TurnUsage.scope(rawScope);
    const cost = reportedCost(usage["cost"], billedTokens, source);
    const scopePartial = usage["costScopePartial"] === true;
    if (rawScope !== undefined && rawScope !== null && scopeId === null) {
      this.unscopedCostPartial = true;
      this.recomputeCost();
      return COST_SCOPE_INVALID;
    }
    if (scopeId === null) {
      this.addUnscopedCost(cost, source);
      return null;
    }
    if (
      !this.costScopes.has(scopeId) &&
      this.costScopes.size >= MAX_COST_SCOPES
    ) {
      this.partial = true;
      this.unscopedCostPartial = true;
      this.recomputeCost();
      return COST_SCOPE_OVERFLOW;
    }
    let record = this.costScopes.get(scopeId);
    if (record === undefined) {
      record = {
        scope: scopeId,
        authoritative: false,
        partial: false,
        cost: 0,
        selectors: new Set<string>(),
      };
      this.costScopes.set(scopeId, record);
    }
    record["partial"] = record["partial"] || scopePartial;
    if (scopePartial) this.partial = true;
    if (source === "authoritative") {
      if (cost === null) record["partial"] = true;
      else {
        record["authoritative"] = true;
        record["cost"] = cost;
      }
    } else if (source !== "unknown") {
      if (cost === null) record["partial"] = true;
      else {
        record["authoritative"] = true;
        record["cost"] = cost;
      }
    }
    this.recomputeCost();
    return scopeId;
  }

  private foldModelCost(
    group: Row,
    selector: string,
    usage: Row,
    billedTokens: number,
    scopeId: string | null,
    scopeBad: boolean,
  ): void {
    if (scopeBad) return;
    if (scopeId !== null) {
      let scopeIds = this.modelScopeIds.get(selector);
      if (scopeIds === undefined) {
        scopeIds = new Set<string>();
        this.modelScopeIds.set(selector, scopeIds);
      }
      scopeIds.add(scopeId);
      const selectors: unknown = this.costScopes.get(scopeId)?.["selectors"];
      if (isSet(selectors)) selectors.add(selector);
      return;
    }
    const callCost = reportedCost(
      usage["cost"],
      billedTokens,
      usage["costSource"],
    );
    if (callCost === null) {
      group["costPartial"] = true;
      return;
    }
    const nextCost =
      (typeof group["cost"] === "number" ? group["cost"] : 0) + callCost;
    if (!Number.isFinite(nextCost)) {
      group["costPartial"] = true;
      delete group["cost"];
    } else group["cost"] = nextCost;
  }

  private foldModelGroup(
    selector: string,
    usage: Row,
    billedTokens: number,
    scopeId: string | null,
    scopeBad: boolean,
  ): void {
    if (!this.selectors.includes(selector)) this.selectors.push(selector);
    let group = this.modelGroups.get(selector);
    if (group === undefined) {
      group = {
        selector,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        calls: 0,
        cost: 0,
        costPartial: this.modelUsagePartial,
      };
      this.modelGroups.set(selector, group);
    }
    if (scopeBad) {
      group["costPartial"] = true;
      this.markModelPartial(selector);
      delete group["cost"];
    }
    const nextCounts: Row = {};
    for (const key of USAGE_KEYS)
      nextCounts[key] = group[key] + Number(usage[key] ?? 0);
    const nextCalls = group["calls"] + 1;
    if (
      !USAGE_KEYS.every((key) => validUsageCount(nextCounts[key])) ||
      !validUsageCount(nextCalls)
    ) {
      this.modelUsagePartial = true;
    } else {
      Object.assign(group, nextCounts, { calls: nextCalls });
      this.foldModelCost(
        group,
        selector,
        usage,
        billedTokens,
        scopeId,
        scopeBad,
      );
    }
  }

  /** Fold one provider call without assigning unknown usage to a model. */
  addCall(usage: Row, successful: boolean): void {
    const nextTotals: Record<(typeof USAGE_KEYS)[number], number> =
      {} as Record<(typeof USAGE_KEYS)[number], number>;
    for (const key of USAGE_KEYS)
      nextTotals[key] = this.totals[key] + Number(usage[key] ?? 0);
    if (USAGE_KEYS.every((key) => validUsageCount(nextTotals[key])))
      this.totals = nextTotals;
    else this.partial = true;
    if (this.calls < MAX_SAFE_USAGE) this.calls += 1;
    else this.partial = true;
    if (successful || "costSource" in usage || "cost" in usage) {
      if (this.reported < MAX_SAFE_USAGE) this.reported += 1;
      else this.partial = true;
    }
    const billedTokens = USAGE_KEYS.reduce(
      (sum, key) => sum + Number(usage[key] ?? 0),
      0,
    );
    const costResult = this.addCost(usage, billedTokens);
    const scopeOverflow = costResult === COST_SCOPE_OVERFLOW;
    const scopeInvalid = costResult === COST_SCOPE_INVALID;
    const scopeId = typeof costResult === "string" ? costResult : null;
    const selector = reportedSelector(usage);
    if (selector === null) {
      const hasSelectorMetadata =
        "selectors" in usage || "selectorPartial" in usage;
      this.markAllModelsPartial();
      if (hasSelectorMetadata) this.partial = true;
    } else if (
      this.modelGroups.has(selector) ||
      this.modelGroups.size < MAX_USAGE_GROUPS
    ) {
      this.foldModelGroup(
        selector,
        usage,
        billedTokens,
        scopeId,
        scopeOverflow || scopeInvalid,
      );
    } else this.markAllModelsPartial();
  }

  private safetyAttemptUsage(
    attempt: unknown,
  ): [string, unknown[], number | null] | null {
    if (!isRecord(attempt)) return null;
    const report = attempt["usage"];
    const provider = attempt["provider"];
    const model = attempt["model"];
    const counts = USAGE_KEYS.map((key) =>
      isRecord(report) ? report[key] : undefined,
    );
    const costFields = isRecord(report) ? report["cost"] : undefined;
    const costs = isRecord(costFields)
      ? [...USAGE_KEYS.map((key) => costFields[key]), costFields["total"]]
      : [];
    const selector = joinSelector(provider, model);
    if (
      attempt["status"] !== "reported" ||
      selector === null ||
      !counts.every(validUsageCount)
    ) {
      return null;
    }
    const callCost =
      costs.length === 5 && costs.every(validUsageCost)
        ? reportedCost(
            costs[costs.length - 1],
            counts.reduce((sum, value) => sum + Number(value), 0),
          )
        : null;
    return [selector, counts, callCost];
  }

  /** Fold bounded hidden reviewer attempts from one finalized tool result. */
  addSafetyResult(result: unknown): void {
    if (!isRecord(result)) return;
    const details = result["details"];
    if (!isRecord(details) || !("recurseSafetyUsage" in details)) return;
    const metadata = details["recurseSafetyUsage"];
    const attempts =
      isRecord(metadata) && metadata["version"] === 1
        ? metadata["attempts"]
        : undefined;
    const boundedAttempts = Array.isArray(attempts)
      ? attempts.slice(0, 4)
      : [{}];
    for (const attempt of boundedAttempts) {
      if (this.safetyCalls < MAX_SAFE_USAGE) this.safetyCalls += 1;
      else this.safetyPartial = true;
      const parsed = this.safetyAttemptUsage(attempt);
      if (parsed === null) {
        this.safetyPartial = true;
        continue;
      }
      const [selector, counts, callCost] = parsed;
      if (
        !this.safetyGroups.has(selector) &&
        this.safetyGroups.size >= MAX_USAGE_GROUPS
      ) {
        this.safetyPartial = true;
        continue;
      }
      let group = this.safetyGroups.get(selector);
      if (group === undefined) {
        group = {
          selector,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          calls: 0,
          costPartial: false,
        };
        this.safetyGroups.set(selector, group);
      }
      const nextCounts: Row = {};
      for (let i = 0; i < USAGE_KEYS.length; i += 1) {
        const key = USAGE_KEYS[i]!;
        nextCounts[key] = group[key] + Number(counts[i]);
      }
      const nextCalls = group["calls"] + 1;
      const nextCost =
        callCost === null || group["costPartial"]
          ? null
          : group["cost"] + callCost;
      if (
        !USAGE_KEYS.every((key) => validUsageCount(nextCounts[key])) ||
        !validUsageCount(nextCalls)
      ) {
        this.safetyPartial = true;
      } else {
        Object.assign(group, nextCounts);
        if (nextCost === null || !validUsageCost(nextCost)) {
          group["costPartial"] = true;
          delete group["cost"];
        } else group["cost"] = nextCost;
        group["calls"] = nextCalls;
      }
    }
  }

  countReport(): void {
    if (this.reports < MAX_SAFE_USAGE) this.reports += 1;
    else this.partial = true;
    if (this.reported < this.reports) this.partial = true;
  }

  countReply(reported: boolean): void {
    if (this.replies < MAX_SAFE_USAGE) this.replies += 1;
    else this.partial = true;
    if (!reported) this.partial = true;
  }

  private modelGroupsSummary(): Row[] {
    const groups: Row[] = [];
    for (const original of this.modelGroups.values()) {
      const group: Row = { ...original };
      const selector = group["selector"] as string;
      const scopeIds = this.modelScopeIds.get(selector) ?? new Set<string>();
      if (this.modelScopePartial.has(selector)) group["costPartial"] = true;
      if (scopeIds.size > 0) {
        const groupCost = validUsageCost(group["cost"]) ? group["cost"] : 0;
        let total = groupCost;
        let partial = Boolean(group["costPartial"]);
        let knownScope = false;
        for (const scopeId of scopeIds) {
          const scope = this.costScopes.get(scopeId);
          if (
            scope === undefined ||
            scope["authoritative"] !== true ||
            !setEquals(scope["selectors"], selector) ||
            !validUsageCost(scope["cost"])
          )
            partial = true;
          else {
            knownScope = true;
            total += scope["cost"];
            if (scope["partial"] === true) partial = true;
          }
        }
        if (knownScope) group["cost"] = total;
        else if (!validUsageCost(group["cost"])) delete group["cost"];
        group["costPartial"] = partial;
      }
      groups.push(group);
    }
    return groups;
  }

  private costScopeState(): Row[] {
    const result: Row[] = [];
    let totalBytes = 0;
    for (const [key, value] of this.costScopes) {
      const rawSelectors: unknown =
        value["selectors"] === undefined ? new Set() : value["selectors"];
      if (!(isSet(rawSelectors) || Array.isArray(rawSelectors))) {
        this.partial = true;
        this.modelUsagePartial = true;
        this.unscopedCostPartial = true;
        continue;
      }
      const selectors = [...rawSelectors];
      const validSelectors = selectors.filter(validModelScopeKey).sort();
      if (
        !validCostScope(key) ||
        validSelectors.length !== selectors.length ||
        typeof value["authoritative"] !== "boolean" ||
        typeof value["partial"] !== "boolean" ||
        (value["authoritative"] && !validUsageCost(value["cost"]))
      ) {
        for (const selector of selectors) this.markModelPartial(selector);
        this.unscopedCostPartial = true;
        continue;
      }
      const metadataBytes =
        key.length +
        validSelectors.reduce((sum, selector) => sum + selector.length, 0);
      if (totalBytes + metadataBytes > MAX_MODEL_SCOPE_BYTES) {
        for (const selector of validSelectors) this.markModelPartial(selector);
        this.unscopedCostPartial = true;
        continue;
      }
      totalBytes += metadataBytes;
      result.push({
        scope: key,
        authoritative: Boolean(value["authoritative"]),
        partial: Boolean(value["partial"]),
        cost: value["cost"],
        selectors: validSelectors,
      });
    }
    return result;
  }

  private modelScopeState(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    let entries = 0;
    let totalBytes = 0;
    for (const [selector, values] of this.modelScopeIds) {
      if (Object.keys(result).length >= MAX_MODEL_SCOPE_KEYS) {
        this.markModelPartial(selector);
        break;
      }
      if (!validModelScopeKey(selector) || !this.modelGroups.has(selector)) {
        this.markModelPartial(selector);
        continue;
      }
      if (values.size > MAX_MODEL_SCOPE_IDS) this.markModelPartial(selector);
      const validValues: string[] = [];
      for (const value of values) {
        if (validValues.length >= MAX_MODEL_SCOPE_IDS) break;
        if (validCostScope(value)) validValues.push(value);
        else this.markModelPartial(selector);
      }
      const sortedValues = [...new Set(validValues)].sort();
      if (sortedValues.length !== values.size) this.markModelPartial(selector);
      const selectorBytes = selector.length;
      const scopeBytes = sortedValues.reduce(
        (sum, value) => sum + value.length,
        0,
      );
      if (
        entries + sortedValues.length > MAX_MODEL_SCOPE_ENTRIES ||
        totalBytes + selectorBytes + scopeBytes > MAX_MODEL_SCOPE_BYTES
      ) {
        this.markModelPartial(selector);
        continue;
      }
      result[selector] = sortedValues;
      entries += sortedValues.length;
      totalBytes += selectorBytes + scopeBytes;
    }
    return result;
  }

  /** Serialize the bounded durable turn-usage state. */
  state(turnId: string | null): Row {
    const costScopeState = this.costScopeState();
    const modelScopeIds = this.modelScopeState();
    this.recomputeCost();
    return {
      turn_id: turnId,
      ...this.totals,
      calls: this.calls,
      reported: this.reported,
      replies: this.replies,
      partial: this.partial,
      cost: this.cost,
      cost_partial: this.costPartial,
      unscoped_cost: this.unscopedCost,
      unscoped_cost_partial: this.unscopedCostPartial,
      cost_scopes: costScopeState,
      selectors: [...this.selectors],
      model_groups_version: MODEL_GROUPS_STATE_VERSION,
      model_groups: [...this.modelGroups.values()].map((group) => ({
        selector: group["selector"],
        ...Object.fromEntries(USAGE_KEYS.map((key) => [key, group[key]])),
        calls: group["calls"],
        ...(Object.hasOwn(group, "cost") ? { cost: group["cost"] } : {}),
        costPartial: Boolean(
          group["costPartial"] || this.modelScopePartial.has(group["selector"]),
        ),
      })),
      model_scope_ids: modelScopeIds,
      model_usage_partial: this.modelUsagePartial,
      safety_groups: [...this.safetyGroups.values()],
      safety_calls: this.safetyCalls,
      safety_partial: this.safetyPartial,
    };
  }

  private parseScopeItem(
    rawScope: unknown,
    metadataBytes: number,
  ): [boolean, string | null, string[], boolean, number, number] | null {
    if (!isRecord(rawScope)) return null;
    const scopeId = TurnUsage.scope(rawScope["scope"]);
    const rawSelectors = rawScope["selectors"];
    let selectorsValid = Array.isArray(rawSelectors);
    const selectors: string[] = [];
    if (Array.isArray(rawSelectors)) {
      if (rawSelectors.length > MAX_USAGE_GROUPS) selectorsValid = false;
      for (const selector of rawSelectors.slice(0, MAX_USAGE_GROUPS)) {
        if (validModelScopeKey(selector)) selectors.push(selector);
        else selectorsValid = false;
      }
      if (new Set(selectors).size !== selectors.length) selectorsValid = false;
    }
    const authoritative = rawScope["authoritative"];
    const partial = rawScope["partial"];
    let usable =
      scopeId !== null &&
      selectorsValid &&
      typeof authoritative === "boolean" &&
      typeof partial === "boolean";
    const cost = rawScope["cost"];
    if (authoritative && !validUsageCost(cost)) usable = false;
    if (cost !== undefined && cost !== null && !validUsageCost(cost))
      usable = false;
    const scopeBytes =
      (scopeId?.length ?? 0) +
      selectors.reduce((sum, selector) => sum + selector.length, 0);
    if (metadataBytes + scopeBytes > MAX_MODEL_SCOPE_BYTES) usable = false;
    const safeCost = validUsageCost(cost) ? cost : 0;
    return [
      usable,
      scopeId,
      selectors,
      authoritative === true,
      safeCost,
      scopeBytes,
    ];
  }

  private restoreCostScopes(state: JsonObject): boolean {
    const scopes = state["cost_scopes"];
    const scopesTruncated =
      Array.isArray(scopes) && scopes.length > MAX_COST_SCOPES;
    let relationshipMetadataPartial = scopesTruncated;
    if (Array.isArray(scopes)) {
      if (scopesTruncated) {
        this.partial = true;
        this.unscopedCostPartial = true;
      }
      let metadataBytes = 0;
      for (const rawScope of scopes.slice(0, MAX_COST_SCOPES)) {
        const parsed = this.parseScopeItem(rawScope, metadataBytes);
        if (parsed === null) {
          this.partial = true;
          relationshipMetadataPartial = true;
          continue;
        }
        const [usable, scopeId, selectors, auth, cost, scopeBytes] = parsed;
        if (!usable || scopeId === null || this.costScopes.has(scopeId)) {
          for (const selector of selectors) this.markModelPartial(selector);
          relationshipMetadataPartial = true;
          this.partial = true;
          this.unscopedCostPartial = true;
          continue;
        }
        metadataBytes += scopeBytes;
        this.costScopes.set(scopeId, {
          scope: scopeId,
          authoritative: auth,
          partial: (rawScope as JsonObject)["partial"],
          cost,
          selectors: new Set(selectors),
        });
      }
    } else if (scopes !== undefined && scopes !== null) {
      relationshipMetadataPartial = true;
      this.partial = true;
      this.unscopedCostPartial = true;
    }
    return relationshipMetadataPartial;
  }

  private restoreUnscopedCost(state: JsonObject): void {
    const costPartial = state["cost_partial"];
    const scopes = state["cost_scopes"];
    const unscoped = state["unscoped_cost"];
    const unscopedPartial = state["unscoped_cost_partial"];
    if (typeof unscopedPartial === "boolean" && validUsageCost(unscoped)) {
      this.unscopedCost = unscoped;
      this.unscopedCostPartial = unscopedPartial;
    } else if (scopes !== undefined && scopes !== null) {
      this.unscopedCostPartial = true;
    } else if (typeof costPartial === "boolean" && !costPartial) {
      const cost = reportedCost(
        state["cost"],
        USAGE_KEYS.reduce((sum, key) => sum + this.totals[key], 0),
      );
      if (cost !== null) this.unscopedCost = cost;
      else this.unscopedCostPartial = true;
    } else this.unscopedCostPartial = true;
    this.recomputeCost();
  }

  private restoreSelectorList(state: JsonObject): boolean {
    const selectors = state["selectors"];
    if (
      Array.isArray(selectors) &&
      selectors.length <= MAX_USAGE_GROUPS &&
      selectors.every(validModelScopeKey) &&
      new Set(selectors).size === selectors.length
    ) {
      const selectorBytes = selectors.reduce(
        (sum: number, value: string) => sum + value.length,
        0,
      );
      if (selectorBytes <= MAX_MODEL_SCOPE_BYTES) {
        this.selectors = [...selectors];
        return false;
      }
      this.modelUsagePartial = true;
      this.partial = true;
      return true;
    }
    this.modelUsagePartial = true;
    this.partial = true;
    return true;
  }

  private parseRelationshipEntry(
    selector: unknown,
    values: unknown,
  ): string[] | null {
    if (!validModelScopeKey(selector) || !Array.isArray(values)) return null;
    if (values.length > MAX_MODEL_SCOPE_IDS) this.markModelPartial(selector);
    const validValues: string[] = [];
    for (const value of values.slice(0, MAX_MODEL_SCOPE_IDS)) {
      if (validCostScope(value)) validValues.push(value);
      else this.markModelPartial(selector);
    }
    return [...new Set(validValues)].sort();
  }

  private restoreRelationships(state: JsonObject): boolean {
    const scopeGroups =
      state["model_scope_ids"] === undefined ? {} : state["model_scope_ids"];
    if (!isRecord(scopeGroups)) {
      this.modelUsagePartial = true;
      this.partial = true;
      return true;
    }
    const entries = Object.entries(scopeGroups);
    const relationshipsTruncated = entries.length > MAX_MODEL_SCOPE_KEYS;
    let relationshipPartial = false;
    if (relationshipsTruncated) {
      relationshipPartial = true;
      this.modelUsagePartial = true;
      this.partial = true;
    }
    let entryCount = 0;
    let totalBytes = 0;
    for (const [selector, values] of entries.slice(0, MAX_MODEL_SCOPE_KEYS)) {
      const validValues = this.parseRelationshipEntry(selector, values);
      if (validValues === null) {
        relationshipPartial = true;
        this.markModelPartial(selector);
        continue;
      }
      const selectorBytes = selector.length;
      const scopeBytes = validValues.reduce(
        (sum, value) => sum + value.length,
        0,
      );
      if (
        validValues.length !== (values as unknown[]).length ||
        entryCount + validValues.length > MAX_MODEL_SCOPE_ENTRIES ||
        totalBytes + selectorBytes + scopeBytes > MAX_MODEL_SCOPE_BYTES
      ) {
        relationshipPartial = true;
        this.markModelPartial(selector);
        continue;
      }
      this.modelScopeIds.set(selector, new Set(validValues));
      entryCount += validValues.length;
      totalBytes += selectorBytes + scopeBytes;
    }
    return relationshipPartial;
  }

  private subtractScopeBase(
    restored: Row,
    groupCost: number,
    selector: string,
  ): number | null {
    const scopeIds = this.modelScopeIds.get(selector) ?? new Set<string>();
    let scopeTotal = 0;
    let ambiguous = false;
    for (const scopeId of scopeIds) {
      const scope = this.costScopes.get(scopeId);
      if (
        scope === undefined ||
        !setEquals(scope["selectors"], selector) ||
        scope["authoritative"] !== true ||
        !validUsageCost(scope["cost"])
      )
        ambiguous = true;
      else {
        scopeTotal += scope["cost"];
        restored["costPartial"] =
          restored["costPartial"] || scope["partial"] === true;
      }
    }
    if (scopeIds.size > 0 && !ambiguous) {
      const base = groupCost - scopeTotal;
      if (base >= 0 && validUsageCost(base)) return base;
      restored["costPartial"] = true;
      this.markModelPartial(selector);
      return null;
    }
    if (scopeIds.size > 0) {
      restored["costPartial"] = true;
      this.markModelPartial(selector);
    }
    return groupCost;
  }

  private resolveRestoredCost(
    restored: Row,
    costRaw: unknown,
    groupCostPartial: boolean,
    isSafety: boolean,
    legacyModelGroups: boolean,
    selector: string,
  ): void {
    const coverage = isSafety ? "safety" : "model";
    let groupCost: number | null;
    if (!legacyModelGroups && !isSafety)
      groupCost = validUsageCost(costRaw) ? costRaw : null;
    else if (groupCostPartial) groupCost = null;
    else {
      const billed = USAGE_KEYS.reduce(
        (sum, key) => sum + Number(restored[key]),
        0,
      );
      groupCost = reportedCost(costRaw, billed);
    }
    restored["costPartial"] = groupCostPartial || groupCost === null;
    if (groupCost === null) {
      if (!groupCostPartial && !validUsageCost(costRaw)) {
        if (coverage === "safety") this.safetyPartial = true;
        else this.modelUsagePartial = true;
        this.partial = true;
      }
    } else {
      if (legacyModelGroups && !isSafety) {
        groupCost = this.subtractScopeBase(restored, groupCost, selector);
      }
      if (groupCost !== null) restored["cost"] = groupCost;
    }
  }

  private restoreGroup(
    target: Map<string, Row>,
    group: unknown,
    isSafety: boolean,
    legacyModelGroups: boolean,
  ): void {
    if (!isRecord(group)) {
      if (isSafety) this.safetyPartial = true;
      else this.modelUsagePartial = true;
      this.partial = true;
      return;
    }
    const selector = group["selector"];
    const countsValid = [...USAGE_KEYS, "calls"].every((key) =>
      validUsageCount(group[key]),
    );
    if (!validModelScopeKey(selector) || !countsValid || target.has(selector)) {
      if (isSafety) this.safetyPartial = true;
      else this.modelUsagePartial = true;
      this.partial = true;
      return;
    }
    const restored: Row = { selector };
    for (const key of USAGE_KEYS) restored[key] = group[key];
    restored["calls"] = group["calls"];
    let groupCostPartial = group["costPartial"];
    if (isSafety && groupCostPartial === undefined) groupCostPartial = false;
    if (typeof groupCostPartial !== "boolean") {
      if (isSafety) this.safetyPartial = true;
      else this.modelUsagePartial = true;
      this.partial = true;
      return;
    }
    this.resolveRestoredCost(
      restored,
      group["cost"],
      groupCostPartial,
      isSafety,
      legacyModelGroups,
      selector,
    );
    target.set(selector, restored);
  }

  private restoreGroups(state: JsonObject): void {
    const version = state["model_groups_version"];
    if (
      version !== undefined &&
      version !== null &&
      version !== MODEL_GROUPS_STATE_VERSION
    ) {
      this.partial = true;
      this.modelUsagePartial = true;
    }
    const legacyModelGroups = version !== MODEL_GROUPS_STATE_VERSION;
    for (const [field, target, isSafety] of [
      ["model_groups", this.modelGroups, false],
      ["safety_groups", this.safetyGroups, true],
    ] as const) {
      const groups = state[field] === undefined ? [] : state[field];
      if (!Array.isArray(groups) || groups.length > MAX_USAGE_GROUPS) {
        if (isSafety) this.safetyPartial = true;
        else this.modelUsagePartial = true;
        this.partial = true;
        continue;
      }
      for (const group of groups)
        this.restoreGroup(target, group, isSafety, legacyModelGroups);
    }
  }

  private reconcileRestoredCounts(): void {
    const modelGroups = [...this.modelGroups.values()];
    const safetyGroups = [...this.safetyGroups.values()];
    const modelCalls = modelGroups.reduce(
      (sum, group) => sum + group["calls"],
      0,
    );
    const safetyCalls = safetyGroups.reduce(
      (sum, group) => sum + group["calls"],
      0,
    );
    const modelSums: Record<string, number> = {};
    for (const key of USAGE_KEYS)
      modelSums[key] = modelGroups.reduce((sum, group) => sum + group[key], 0);
    if (modelCalls > this.calls) {
      if (validUsageCount(modelCalls)) this.calls = modelCalls;
      this.modelUsagePartial = true;
      this.partial = true;
    }
    for (const key of USAGE_KEYS) {
      if (modelSums[key]! > this.totals[key]) {
        if (validUsageCount(modelSums[key])) this.totals[key] = modelSums[key]!;
        this.modelUsagePartial = true;
        this.partial = true;
      }
    }
    if (
      new Set(this.modelGroups.keys()).size !== this.selectors.length ||
      this.modelGroups.size !== this.selectors.length ||
      [...this.modelGroups.keys()].some(
        (selector) => !this.selectors.includes(selector),
      ) ||
      (!this.modelUsagePartial &&
        (modelCalls !== this.calls ||
          USAGE_KEYS.some((key) => modelSums[key] !== this.totals[key])))
    )
      this.modelUsagePartial = true;
    if (safetyCalls > this.safetyCalls) {
      if (validUsageCount(safetyCalls)) this.safetyCalls = safetyCalls;
      this.safetyPartial = true;
    }
    if (!this.safetyPartial && safetyCalls !== this.safetyCalls)
      this.safetyPartial = true;
  }

  private restoreTail(
    state: JsonObject,
    relationshipMetadataPartial: boolean,
  ): void {
    const scopedSelectors = new Set<string>();
    for (const scope of this.costScopes.values()) {
      const selectors: unknown = scope["selectors"];
      if (isSet(selectors))
        for (const selector of selectors)
          if (typeof selector === "string") scopedSelectors.add(selector);
    }
    if (relationshipMetadataPartial) {
      for (const selector of this.modelGroups.keys())
        this.markModelPartial(selector);
    }
    for (const selector of scopedSelectors) {
      if (!this.modelGroups.has(selector)) this.markModelPartial(selector);
    }
    for (const [selector, scopeIds] of [...this.modelScopeIds]) {
      if ([...scopeIds].some((scopeId) => !this.costScopes.has(scopeId)))
        this.markModelPartial(selector);
      if (!this.modelGroups.has(selector)) {
        this.markModelPartial(selector);
        this.modelScopeIds.delete(selector);
      }
    }
    this.reports = this.reported;
    this.partial ||=
      typeof state["partial"] === "boolean" ? state["partial"] : true;
    this.modelUsagePartial ||=
      typeof state["model_usage_partial"] === "boolean"
        ? state["model_usage_partial"]
        : true;
    this.safetyPartial ||=
      typeof state["safety_partial"] === "boolean"
        ? state["safety_partial"]
        : true;
    this.reconcileRestoredCounts();
  }

  /** Restore validated persisted state for a matching turn id. */
  static restore(state: unknown, turnId: string | null): TurnUsage {
    const usage = new TurnUsage();
    if (state === undefined || state === null) return usage;
    if (!isRecord(state)) {
      usage.partial = true;
      return usage;
    }
    const storedTurnId =
      state["turn_id"] === undefined ? null : state["turn_id"];
    if (storedTurnId !== turnId) return usage;
    for (const key of [
      ...USAGE_KEYS,
      "calls",
      "reported",
      "replies",
      "safety_calls",
    ]) {
      const value = state[key] ?? (key === "safety_calls" ? 0 : undefined);
      if (!validUsageCount(value)) usage.partial = true;
      else if ((USAGE_KEYS as readonly string[]).includes(key)) {
        usage.totals[key as (typeof USAGE_KEYS)[number]] = value;
      } else if (key === "calls") usage.calls = value;
      else if (key === "reported") usage.reported = value;
      else if (key === "replies") usage.replies = value;
      else usage.safetyCalls = value;
    }
    let relationshipMetadataPartial = usage.restoreCostScopes(state);
    usage.restoreUnscopedCost(state);
    const selectorListPartial = usage.restoreSelectorList(state);
    relationshipMetadataPartial =
      relationshipMetadataPartial || selectorListPartial;
    const relationshipsPartial = usage.restoreRelationships(state);
    relationshipMetadataPartial =
      relationshipMetadataPartial || relationshipsPartial;
    usage.restoreGroups(state);
    usage.restoreTail(state, relationshipMetadataPartial);
    return usage;
  }

  /** Return the compact served whole-turn summary, or null when empty. */
  summary(): Row | null {
    if (!this.calls || !this.reported) return null;
    const summary: Row = {
      ...this.totals,
      calls: this.calls,
      replies: this.replies,
      partial: this.partial,
    };
    const knownScopedCost = [...this.costScopes.values()].some(
      (scope) =>
        scope["authoritative"] === true && validUsageCost(scope["cost"]),
    );
    if (
      this.costPartial &&
      (knownScopedCost ||
        (this.unscopedCost > 0 && validUsageCost(this.unscopedCost)))
    ) {
      summary["cost"] = this.cost;
      summary["costPartial"] = true;
    } else if (!this.costPartial) summary["cost"] = this.cost;
    if (this.selectors.length > 0) {
      summary["selectors"] = [...this.selectors];
      summary["selectorPartial"] = this.modelUsagePartial;
    }
    if (this.modelGroups.size > 0) {
      summary["model_groups"] = this.modelGroupsSummary();
      summary["model_usage_partial"] = this.modelUsagePartial;
    }
    return summary;
  }

  /** Return bounded reviewer-only usage. */
  safetySummary(): Row | null {
    if (!this.safetyCalls) return null;
    return {
      groups: [...this.safetyGroups.values()],
      calls: this.safetyCalls,
      partial: this.safetyPartial,
    };
  }
}

/** Provider-reported billing for one assistant reply, across its calls. */
export class SegmentUsage {
  usage: Row | null = null;
  latestUsage: Row | null = null;
  usageSelectors: string[] = [];
  private usageSelectorSet = new Set<string>();
  private usageSelectorBytes = 0;
  usageSelectorPartial = false;
  usageCost = 0;
  usageCostPartial = false;
  usageCostKnown = false;
  usageCostOverflow = false;
  usageUnavailable = false;

  private registerSegmentSelector(
    usage: JsonObject,
    selector: string | null,
  ): void {
    if (selector === null) {
      if ("selectors" in usage || "selectorPartial" in usage)
        this.usageSelectorPartial = true;
    } else if (!this.usageSelectorSet.has(selector)) {
      const selectorBytes = selector.length;
      if (
        this.usageSelectors.length >= MAX_USAGE_GROUPS ||
        this.usageSelectorBytes + selectorBytes > MAX_MODEL_SCOPE_BYTES
      )
        this.usageSelectorPartial = true;
      else {
        this.usageSelectorSet.add(selector);
        this.usageSelectors.push(selector);
        this.usageSelectorBytes += selectorBytes;
      }
    }
  }

  private foldSegmentScopedCost(
    segment: Row,
    scope: unknown,
    scopePartial: boolean,
    cost: unknown,
    source: unknown,
  ): void {
    if (source === "unknown") {
      const priorCost = segment["cost"];
      if (
        typeof priorCost === "number" &&
        Number.isFinite(priorCost) &&
        priorCost >= 0
      ) {
        this.usageCostPartial = true;
        segment["costScope"] = scope;
        segment["costScopePartial"] = true;
        segment["costPartial"] = true;
      } else {
        segment["costScope"] = scope;
        segment["costSource"] = "unknown";
        segment["costScopePartial"] = scopePartial;
        delete segment["cost"];
        delete segment["costPartial"];
      }
    } else if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      this.usageCost = cost;
      this.usageCostKnown = true;
      this.usageCostPartial = scopePartial;
      segment["cost"] = this.usageCost;
      segment["costSource"] = "authoritative";
      segment["costScope"] = scope;
      segment["costScopePartial"] = scopePartial;
      segment["costPartial"] = scopePartial;
    } else {
      this.usageCostPartial = true;
      delete segment["cost"];
      delete segment["costPartial"];
      segment["costSource"] = "unknown";
      segment["costScope"] = scope;
      segment["costScopePartial"] = true;
    }
  }

  private foldSegmentUnscopedCost(
    segment: Row,
    cost: unknown,
    source: unknown,
  ): void {
    if (
      source === "unknown" ||
      typeof cost !== "number" ||
      !Number.isFinite(cost) ||
      cost < 0
    ) {
      this.usageCostPartial = true;
      if (source === "unknown") segment["costSource"] = "unknown";
    } else {
      this.usageCost += cost;
      this.usageCostKnown = true;
      if (!Number.isFinite(this.usageCost)) {
        this.usageCost = 0;
        this.usageCostPartial = true;
        this.usageCostOverflow = true;
      }
    }
  }

  private projectSegmentCost(
    scoped: boolean,
    source: unknown,
    cost: unknown,
    scopePartial: boolean,
  ): void {
    if (this.usage === null) return;
    if (
      scoped &&
      source === "authoritative" &&
      typeof cost === "number" &&
      Number.isFinite(cost) &&
      cost >= 0
    ) {
      this.usage["cost"] = this.usageCost;
      this.usage["costPartial"] = scopePartial;
    } else if (!this.usageCostPartial && !(scoped && source === "unknown")) {
      this.usage["cost"] = this.usageCost;
      delete this.usage["costPartial"];
    } else if (
      !scoped &&
      this.usageCostKnown &&
      !this.usageCostOverflow &&
      Number.isFinite(this.usageCost) &&
      this.usageCost >= 0
    ) {
      this.usage["cost"] = this.usageCost;
      this.usage["costPartial"] = true;
    } else if (!(scoped && source === "unknown")) {
      delete this.usage["cost"];
      delete this.usage["costPartial"];
    }
  }

  private recordLatestUsage(usage: JsonObject): void {
    const latest: Row = {};
    for (const key of USAGE_KEYS) latest[key] = usage[key];
    if (this.usageSelectors.length > 0) {
      latest["selectors"] = [...this.usageSelectors];
      latest["selectorPartial"] = this.usageSelectorPartial;
    } else if (this.usageSelectorPartial) latest["selectorPartial"] = true;
    if (
      this.usage !== null &&
      ["authoritative", "unknown"].includes(this.usage["costSource"])
    ) {
      latest["costSource"] = this.usage["costSource"];
    }
    if (this.usage !== null && validCostScope(this.usage["costScope"]))
      latest["costScope"] = this.usage["costScope"];
    if (
      this.usage !== null &&
      typeof this.usage["costScopePartial"] === "boolean"
    ) {
      latest["costScopePartial"] = this.usage["costScopePartial"];
    }
    if (this.usage !== null && "cost" in this.usage)
      latest["cost"] = this.usage["cost"];
    if (this.usage?.["costPartial"] === true) latest["costPartial"] = true;
    this.latestUsage = latest;
  }

  // Accumulate billed usage; unsuccessful calls do not replace latest usage.
  addUsage(usage: Row, successful: boolean): void {
    if (this.usage === null) {
      this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const nextCounts: Row = {};
    for (const key of USAGE_KEYS)
      nextCounts[key] = this.usage[key] + Number(usage[key]);
    if (USAGE_KEYS.every((key) => nextCounts[key] <= MAX_SAFE_USAGE))
      Object.assign(this.usage, nextCounts);
    else this.usageUnavailable = true;
    const segment = this.usage;
    this.registerSegmentSelector(usage, reportedSelector(usage));
    let cost = usage["cost"];
    let source = usage["costSource"];
    const scope = usage["costScope"];
    const scoped = validCostScope(scope);
    if (scope !== undefined && scope !== null && !scoped) {
      source = "unknown";
      cost = undefined;
    }
    const scopePartial = usage["costScopePartial"] === true;
    if (scoped && (source === "unknown" || source === "authoritative")) {
      this.foldSegmentScopedCost(segment, scope, scopePartial, cost, source);
    } else this.foldSegmentUnscopedCost(segment, cost, source);
    if (this.usageUnavailable) this.usage = null;
    else if (this.usageSelectors.length > 0) {
      segment["selectors"] = [...this.usageSelectors];
      segment["selectorPartial"] = this.usageSelectorPartial;
    }
    this.projectSegmentCost(scoped, source, cost, scopePartial);
    if (successful) this.recordLatestUsage(usage);
  }
}
