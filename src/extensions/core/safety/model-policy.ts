import type {
  ClassifierApi,
  ClassifierModel,
  Model,
} from "@earendil-works/pi-ai";
import { shippedReviewModels } from "../../../safety_review_models";
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
  reviewer_pin?: PolicyModel;
  reviewer_explicit?: boolean;
  reviewer_revision?: number;
  reviewer: PolicyRoute;
  summary: PolicyRoute;
};

export type TrustedModelPolicyState =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; policy: TrustedModelPolicy };

const BUILTIN_REVIEWERS = new Map(
  shippedReviewModels().map(({ provider, id, type }) => [
    `${provider}\u0000${id}`,
    type,
  ]),
);

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
  const pin =
    candidate.reviewer_pin === undefined
      ? undefined
      : model(candidate.reviewer_pin);
  const summary = route(candidate.summary);
  if (
    candidate.version !== 1 ||
    !active ||
    !reviewer ||
    !summary ||
    (candidate.reviewer_pin !== undefined && !pin) ||
    (candidate.reviewer_explicit !== undefined &&
      candidate.reviewer_explicit !== true) ||
    (candidate.reviewer_revision !== undefined &&
      (!Number.isSafeInteger(candidate.reviewer_revision) ||
        (candidate.reviewer_revision as number) < 0))
  ) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    policy: {
      version: 1,
      active,
      reviewer,
      summary,
      ...(pin ? { reviewer_pin: pin } : {}),
      ...(candidate.reviewer_explicit === true
        ? { reviewer_explicit: true }
        : {}),
      ...(typeof candidate.reviewer_revision === "number"
        ? { reviewer_revision: candidate.reviewer_revision }
        : {}),
    },
  };
}

function sameModel(
  actual: Pick<Model<any>, "provider" | "id"> | undefined,
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

export type ReviewModel = Model<any> | ClassifierModel<ClassifierApi>;

export type ReviewSelection = {
  model: ReviewModel;
  effort: ReviewEffort;
};

function findReviewModel(
  ctx: ExtensionContext,
  target: PolicyModel,
  explicit: boolean,
): ReviewModel | undefined {
  if (!explicit) return ctx.modelRegistry.find(target.provider, target.model);
  const type = BUILTIN_REVIEWERS.get(`${target.provider}\u0000${target.model}`);
  if (!type) return undefined;
  const model = ctx.modelRegistry.findOfType(
    type,
    target.provider,
    target.model,
  );
  return model?.type === type ? model : undefined;
}

/** Bounded diagnostics when no trusted candidate resolves. */
export function reviewerConfigurationCategory(
  ctx: ExtensionContext,
  state: TrustedModelPolicyState,
  activeModel: Pick<Model<any>, "provider" | "id"> | undefined,
): string {
  if (state.status === "invalid") return "invalid_policy";
  if (state.status === "valid") {
    const { policy } = state;
    const pin = policy.reviewer_pin;
    if (
      pin &&
      !sameModel(
        findReviewModel(ctx, pin, Boolean(policy.reviewer_explicit)),
        pin,
      )
    )
      return "unsupported_reviewer_pin";
    if (!sameModel(activeModel, policy.active))
      return "acting_identity_mismatch";
  }
  return "no_trusted_candidates";
}

// Try runner-ordered candidates in the trusted registry even when the acting
// identity or reviewer pin is stale. Never infer candidates from file models.
// Only an absent policy uses the trusted active model at low effort.
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
  const target = policy[purpose];
  const candidates = policy.reviewer_explicit
    ? [policy.reviewer]
    : purpose === "reviewer"
      ? [target, ...(target.candidates ?? [])]
      : [target, policy.reviewer, ...(policy.reviewer.candidates ?? [])];
  const isOpenAI = (provider: string) =>
    provider === "openai" || provider === "openai-codex";
  // Invariant: Fix the first OpenAI billing route before checking availability.
  const billing = candidates.find(({ provider }) =>
    isOpenAI(provider),
  )?.provider;
  const selected: ReviewSelection[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (isOpenAI(candidate.provider) && candidate.provider !== billing)
      continue;
    const key = `${candidate.provider}\u0000${candidate.model}`;
    if (!candidate.provider || seen.has(key)) continue;
    seen.add(key);
    const model = findReviewModel(
      ctx,
      candidate,
      Boolean(policy.reviewer_explicit),
    );
    if (model && sameModel(model, candidate)) {
      selected.push({ model, effort: candidate.effort });
    }
  }
  return selected.length ? selected : undefined;
}
