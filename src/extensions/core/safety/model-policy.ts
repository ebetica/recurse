import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MODEL_POLICY_ENV = "RECURSE_MODEL_POLICY";

export type ReviewEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type PolicyModel = {
  provider: string;
  model: string;
};

export type PolicyCandidate = PolicyModel & {
  effort: ReviewEffort;
};

export type PolicyRoute = PolicyCandidate & {
  /** Ordered reviewer fallbacks; only the reviewer route may carry these. */
  candidates?: readonly PolicyCandidate[];
};

export type TrustedModelPolicy = {
  version: 1;
  active: PolicyModel;
  reviewer: PolicyRoute;
  summary: PolicyRoute;
};

export type TrustedModelPolicyState =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; policy: TrustedModelPolicy };

const EFFORTS = new Set<ReviewEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function model(value: unknown): PolicyModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.model !== "string"
  )
    return undefined;
  // Invariant: Empty providers only support bare-custom fallback; registry
  // failure must not silently choose another provider.
  if (!candidate.model) return undefined;
  return { provider: candidate.provider, model: candidate.model };
}

function candidate(value: unknown): PolicyCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const parsed = model(value);
  const raw = value as Record<string, unknown>;
  if ("candidates" in raw) return undefined;
  const effort = raw.effort;
  if (
    !parsed ||
    !parsed.provider ||
    typeof effort !== "string" ||
    !EFFORTS.has(effort as ReviewEffort)
  ) {
    return undefined;
  }
  return { ...parsed, effort: effort as ReviewEffort };
}

function route(
  value: unknown,
  allowCandidates = false,
): PolicyRoute | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const parsed = model(value);
  const effort = raw.effort;
  if (
    !parsed ||
    typeof effort !== "string" ||
    !EFFORTS.has(effort as ReviewEffort)
  ) {
    return undefined;
  }
  const base = { ...parsed, effort: effort as ReviewEffort };
  if (!("candidates" in raw)) return base;
  if (
    !allowCandidates ||
    !Array.isArray(raw.candidates) ||
    raw.candidates.length === 0
  ) {
    return undefined;
  }
  const seen = new Set<string>([`${base.provider}\u0000${base.model}`]);
  const candidates: PolicyCandidate[] = [];
  for (const value of raw.candidates) {
    const parsedCandidate = candidate(value);
    if (!parsedCandidate) return undefined;
    const key = `${parsedCandidate.provider}\u0000${parsedCandidate.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(parsedCandidate);
  }
  return candidates.length ? { ...base, candidates } : base;
}

// Parse runner-owned policy, distinguishing absence during old-runner overlap
// from invalidity. Present invalid values always fail strict validation.
export function loadTrustedModelPolicy(
  env: NodeJS.ProcessEnv,
): TrustedModelPolicyState {
  const raw = env[MODEL_POLICY_ENV];
  if (raw === undefined) return { status: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { status: "invalid" };
  }
  const candidate = value as Record<string, unknown>;
  const active = model(candidate.active);
  const reviewer = route(candidate.reviewer, true);
  const summary = route(candidate.summary);
  if (candidate.version !== 1 || !active || !reviewer || !summary) {
    return { status: "invalid" };
  }
  return { status: "valid", policy: { version: 1, active, reviewer, summary } };
}

function sameModel(
  actual: Model<any> | undefined,
  expected: PolicyModel,
): boolean {
  if (!actual || actual.provider !== expected.provider) return false;
  // Invariant: Qualified model ids remain compatible without relaxing provider
  // equality.
  return (
    actual.id === expected.model ||
    actual.id === `${expected.provider}/${expected.model}`
  );
}

export type ReviewSelection = {
  model: Model<any>;
  effort: ReviewEffort;
};

// Prove policy ownership of ctx.model, then try runner-ordered reviewer
// candidates. Never infer candidates. Only an absent key during old-runner
// overlap uses the active model at low effort without lookup or provider
// change.
export function pickReviewerCandidates(
  ctx: ExtensionContext,
  state: TrustedModelPolicyState,
  purpose: "reviewer" | "summary",
): ReviewSelection[] | undefined {
  if (state.status === "absent") {
    return ctx.model ? [{ model: ctx.model, effort: "low" }] : undefined;
  }
  if (state.status !== "valid") return undefined;
  const policy = state.policy;
  if (!sameModel(ctx.model, policy.active)) return undefined;
  const target = policy[purpose];
  const candidates =
    purpose === "reviewer" ? [target, ...(target.candidates ?? [])] : [target];
  const selected: ReviewSelection[] = [];
  for (const candidate of candidates) {
    if (!candidate.provider) continue;
    const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
    if (model && sameModel(model, candidate)) {
      selected.push({ model, effort: candidate.effort });
    }
  }
  return selected.length ? selected : undefined;
}
