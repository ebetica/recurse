// Searches Settings models from logged-in/custom routes in server route order.
// finder-ui.ts owns DOM; model version/reasoning rules remain pure.
import {
  lexical,
  normalizeSearchText,
  textRank,
  titleTokens,
  type RankFields,
} from "../fuzzy-match.js";

export const MODEL_FINDER_LIMIT = 50;
const MAX_QUERY = 96;

/** Pi's reasoning levels, lowest first (Pi's EXTENDED_THINKING_LEVELS). */
export const THINKING_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface FinderModel {
  id: string;
  label: string;
  /** The route label: "Claude", "ChatGPT subscription", a custom name... */
  route: string;
  context_window: number | null;
  /** Pi's supported levels; null when Pi's list does not give them. */
  reasoning_levels: string[] | null;
}

export interface IndexedModel extends RankFields {
  model: FinderModel;
  order: number;
  routeOrder: number;
  version: readonly number[] | null;
}

type Version = readonly number[];

function isDate(parts: readonly number[]): boolean {
  if (parts.length === 1)
    return parts[0] >= 19_000_000 && parts[0] <= 21_000_000;
  return (
    parts.length === 3 &&
    parts[0] >= 1900 &&
    parts[0] <= 2100 &&
    parts[1] >= 1 &&
    parts[1] <= 12 &&
    parts[2] >= 1 &&
    parts[2] <= 31
  );
}

/** Extract version components without mistaking a dated model id for one. */
function extractVersion(value: string): Version | null {
  for (const match of value.matchAll(/\d+(?:[.-]\d+)*/g)) {
    const parts = match[0].split(/[.-]/u).map(Number);
    const dateAt = parts.findIndex((_, i) => isDate(parts.slice(i)));
    const version = dateAt < 0 ? parts : parts.slice(0, dateAt);
    if (version.length) return version;
  }
  return null;
}

function modelVersion(model: FinderModel): Version | null {
  // Invariant: Display names have clean version numbers. Only inspect ids when
  // the name has none, where a trailing date must not become a version
  // component.
  return extractVersion(model.label) ?? extractVersion(model.id);
}

function compareModels(a: IndexedModel, b: IndexedModel): number {
  if (a.routeOrder !== b.routeOrder) return a.routeOrder - b.routeOrder;
  if (!a.version && !b.version)
    return lexical(a.normalizedTitle, b.normalizedTitle);
  if (!a.version) return 1;
  if (!b.version) return -1;
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const difference = (b.version[i] ?? 0) - (a.version[i] ?? 0);
    if (difference) return difference;
  }
  return lexical(a.normalizedTitle, b.normalizedTitle);
}

/** Index the list once per load; searches then only rank. */
export function indexModels(models: readonly FinderModel[]): IndexedModel[] {
  const routes = new Map<string, number>();
  return models.map((model, order) => {
    const normalizedTitle = normalizeSearchText(model.label);
    const route = normalizeSearchText(model.route);
    let routeOrder = routes.get(route);
    if (routeOrder === undefined) {
      routeOrder = routes.size;
      routes.set(route, routeOrder);
    }
    return {
      model,
      order,
      routeOrder,
      version: modelVersion(model),
      normalizedTitle,
      normalizedId: `${normalizeSearchText(model.id)} ${route}`,
      tokens: [...titleTokens(normalizedTitle), ...titleTokens(route)],
    };
  });
}

/** Matches for `query`: text tier first, then version order; at most `limit`.
 * Fuzzy (subsequence) matches count only when nothing matches directly:
 * ids are long enough that "opus" would otherwise match most models.
 * `total` counts every match so the box can say how many were left out. */
export function searchModels(
  index: readonly IndexedModel[],
  query: string,
  limit = MODEL_FINDER_LIMIT,
): { models: FinderModel[]; total: number } {
  const needle = normalizeSearchText(query.slice(0, MAX_QUERY));
  const ranked: {
    tier: number;
    score: number;
    entry: IndexedModel;
  }[] = [];
  for (const entry of index) {
    const rank = textRank(entry, needle);
    if (rank) ranked.push({ tier: rank.tier, score: rank.score, entry });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.tier === 3 ? a.score - b.score : 0) ||
      compareModels(a.entry, b.entry) ||
      a.entry.order - b.entry.order,
  );
  const FUZZY = 3;
  if (ranked.length && ranked[0].tier < FUZZY) {
    const firstFuzzy = ranked.findIndex((entry) => entry.tier === FUZZY);
    if (firstFuzzy >= 0) ranked.length = firstFuzzy;
  }
  return {
    models: ranked.slice(0, limit).map((entry) => entry.entry.model),
    total: ranked.length,
  };
}

/** "1M", "272k", "32k": the context size a row shows. */
export function contextLabel(tokens: number | null): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000)}k`;
}

/** The levels a model's reasoning select offers: Pi's, else every level. */
export function reasoningChoices(
  levels: readonly string[] | null | undefined,
  all: readonly string[],
): string[] {
  return levels && levels.length ? [...levels] : [...all];
}

/** The reasoning a newly picked model starts with, as Pi's
 * clampThinkingLevel would run it: the same level when offered, else the
 * next one up, else the nearest one down. */
export function clampReasoning(
  choices: readonly string[],
  current: string,
): string {
  if (choices.includes(current)) return current;
  const at = THINKING_ORDER.indexOf(current as (typeof THINKING_ORDER)[number]);
  if (at < 0) return choices[0] ?? "off";
  for (let i = at + 1; i < THINKING_ORDER.length; i++)
    if (choices.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
  for (let i = at - 1; i >= 0; i--)
    if (choices.includes(THINKING_ORDER[i])) return THINKING_ORDER[i];
  return choices[0] ?? "off";
}

export type ModelBoxKeyAction =
  | "open"
  | "close"
  | "next"
  | "previous"
  | "choose"
  | null;

/** Keys the box owns. Escape only acts while the list is open, so a closed
 * box leaves Escape to the Settings dialog; Enter in a closed box opens the
 * list rather than submitting the form. */
export function modelBoxKeyAction(
  open: boolean,
  hasMatches: boolean,
  key: string,
  composing = false,
): ModelBoxKeyAction {
  if (composing) return null;
  if (!open)
    return key === "ArrowDown" || key === "ArrowUp" || key === "Enter"
      ? "open"
      : null;
  if (key === "Escape") return "close";
  if (!hasMatches) return key === "Enter" ? "close" : null;
  if (key === "ArrowDown") return "next";
  if (key === "ArrowUp") return "previous";
  if (key === "Enter") return "choose";
  return null;
}
