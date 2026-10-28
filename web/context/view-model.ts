// Pure formatting, semantic partitioning, and stale-request fencing for the
// context viewer.
import type { ContextTokenEstimate, ContextUsageDetail } from "../types.js";

export type ContextSplitKey = keyof ContextTokenEstimate;

export interface ContextBarSegment {
  id: ContextSplitKey | "used";
  label: string;
  tokens: number;
  basisPoints: number;
  color: string;
}

/** Display order and palette of the estimated split; also drives the legend. */
export const CONTEXT_SPLIT: readonly {
  key: ContextSplitKey;
  label: string;
  color: string;
}[] = [
  { key: "system", label: "System", color: "system" },
  { key: "prompts", label: "User prompts", color: "prompt" },
  { key: "messages", label: "Messages", color: "message" },
  { key: "tool_calls", label: "Tool calls", color: "call" },
  { key: "tool_outputs", label: "Tool outputs", color: "output" },
];

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeEstimate(
  value: unknown,
  used: number,
): ContextTokenEstimate | null {
  if (typeof value !== "object" || value === null) return null;
  const { system, prompts, messages, tool_calls, tool_outputs } =
    value as Partial<ContextTokenEstimate>;
  if (
    !validCount(system) ||
    !validCount(prompts) ||
    !validCount(messages) ||
    !validCount(tool_calls) ||
    !validCount(tool_outputs) ||
    system + prompts + messages + tool_calls + tool_outputs !== used
  )
    return null;
  return { system, prompts, messages, tool_calls, tool_outputs };
}

function allocatePoints(values: number[], total: number): number[] {
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (sum <= 0 || total <= 0) return values.map(() => 0);
  const exact = values.map((value) => (value / sum) * total);
  const points = exact.map(Math.floor);
  let left = total - points.reduce((acc, value) => acc + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - points[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of order) {
    if (left-- <= 0) break;
    points[item.index]!++;
  }
  return points;
}

export function contextBarSegments(
  detail: ContextUsageDetail,
  aggregateFallback = false,
): ContextBarSegment[] {
  const max =
    validCount(detail.context_window) && detail.context_window > 0
      ? detail.context_window
      : null;
  const used = validCount(detail.used_tokens) ? detail.used_tokens : null;
  if (max === null || used === null) return [];
  const usedPoints = Math.min(10_000, Math.round((used / max) * 10_000));
  const estimate = safeEstimate(detail.estimated_tokens, used);
  if (!estimate)
    return aggregateFallback && usedPoints > 0
      ? [
          {
            id: "used",
            label: "Used",
            tokens: used,
            basisPoints: usedPoints,
            color: "input",
          },
        ]
      : [];
  const rows = CONTEXT_SPLIT.map((row) => ({
    id: row.key,
    label: row.label,
    tokens: estimate[row.key],
    color: row.color,
  }));
  const points = allocatePoints(
    rows.map((row) => row.tokens),
    usedPoints,
  );
  return rows.map((row, index) => ({ ...row, basisPoints: points[index]! }));
}

export function formatContextInteger(value: number | null | undefined): string {
  if (!validCount(value)) return "Unavailable";
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function contextPercent(
  value: number | null | undefined,
  total: number | null | undefined,
): string {
  if (!validCount(value) || !validCount(total) || total <= 0)
    return "Unavailable";
  const percent = Math.round((value / total) * 1_000) / 10;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

export function contextOverviewLabel(detail: ContextUsageDetail): string {
  const used = formatContextInteger(detail.used_tokens);
  const percent = contextPercent(detail.used_tokens, detail.context_window);
  const measured =
    percent === "Unavailable"
      ? `${used} provider-reported context tokens; model maximum unavailable`
      : `${used} of ${formatContextInteger(detail.context_window)} context tokens used (${percent})`;
  const estimate = validCount(detail.used_tokens)
    ? safeEstimate(detail.estimated_tokens, detail.used_tokens)
    : null;
  return estimate
    ? `${measured}; estimated split: ` +
        CONTEXT_SPLIT.map(
          (row) => `${formatContextInteger(estimate[row.key])} ${row.label}`,
        ).join(", ")
    : measured;
}

export function contextMiniBarCollapsed(containerWidth: number): boolean {
  return !Number.isFinite(containerWidth) || containerWidth < 620;
}

export type ContextDetailFetcher = (
  id: string,
  signal: AbortSignal,
) => Promise<ContextUsageDetail>;

export class ContextRequestFence {
  private generation = 0;
  private controller: AbortController | null = null;

  cancel(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }

  async load(
    id: string,
    fetcher: ContextDetailFetcher,
  ): Promise<ContextUsageDetail | null> {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const detail = await fetcher(id, controller.signal);
      return generation === this.generation && !controller.signal.aborted
        ? detail
        : null;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation)
        return null;
      throw error;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

export function safeContextDetail(
  value: ContextUsageDetail,
): ContextUsageDetail | null {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.model !== "string" ||
    value.model.length > 256 ||
    typeof value.model_label !== "string" ||
    value.model_label.length > 256 ||
    !validCount(value.used_tokens)
  )
    return null;
  const usageModel =
    typeof value.usage_model === "string" && value.usage_model.length <= 256
      ? value.usage_model
      : null;
  const capacity =
    validCount(value.context_window) &&
    value.context_window > 0 &&
    usageModel === value.model
      ? value.context_window
      : null;
  return {
    ...value,
    usage_model: usageModel,
    context_window: capacity,
    unused_tokens:
      capacity === null ? null : Math.max(0, capacity - value.used_tokens),
    estimated_tokens: safeEstimate(value.estimated_tokens, value.used_tokens),
  };
}
