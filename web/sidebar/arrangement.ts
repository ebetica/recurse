// The checks a sidebar script's output (`sidebar(rows, now) → sections`)
// passes before it is shown. Sections can start folded or hide when empty;
// roots the script leaves out go to a visible "Unsorted" section. The built-in
// script is default_sidebar.js.
import type { SidebarRow, Tags } from "./rows.js";
import { OPERATOR_TAGS } from "../../src/agents/conversation_tags.js";
export {
  liveTags,
  sidebarRow,
  sidebarRows,
  type SidebarRow,
  type Tag,
  type Tags,
} from "./rows.js";

export interface NewAgent {
  ask?: "tag";
  defaults?: Record<string, { effort: number }>;
}

/** Check the optional creation settings exported by a sidebar script. */
export function checkNewAgent(value: unknown): NewAgent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ArrangementError("newAgent must be an object");
  const config = value as NewAgent;
  if (Object.keys(config).some((key) => !["ask", "defaults"].includes(key)))
    throw new ArrangementError("newAgent supports ask and defaults");
  if (config.ask !== undefined && config.ask !== "tag")
    throw new ArrangementError('newAgent.ask must be "tag"');
  if (config.defaults !== undefined) {
    if (
      !config.defaults ||
      typeof config.defaults !== "object" ||
      Array.isArray(config.defaults)
    )
      throw new ArrangementError("newAgent.defaults must map tags to defaults");
    for (const [tag, defaults] of Object.entries(config.defaults)) {
      if (
        !/^[a-z0-9-]{1,24}$/.test(tag) ||
        OPERATOR_TAGS.has(tag) ||
        !defaults ||
        typeof defaults !== "object" ||
        Object.keys(defaults).some((key) => key !== "effort") ||
        !Number.isInteger(defaults.effort) ||
        defaults.effort < 1 ||
        defaults.effort > 5
      )
        throw new ArrangementError(
          "newAgent defaults need a custom tag and effort 1-5",
        );
    }
  }
  return config;
}

type Names = string | string[];
export interface ScriptAction {
  label: string;
  icon?: string;
  /** Start a top-level agent with set tags (section actions only). */
  start?: boolean;
  set?: Names;
  clear?: Names;
  /** Ask for a custom tag; clear: "ask" removes it instead of setting it. */
  ask?: "tag";
  until?: number | "ask";
  if?: string;
  unless?: string;
  rows?: (SidebarRow | string)[];
}
export interface ScriptSection {
  title: string;
  rows?: (SidebarRow | string)[];
  /** Child sections, one level deep; use either rows or sections. */
  sections?: ScriptSection[];
  collapsed?: boolean;
  /** Hide the whole section when no rows remain on a backend. */
  hideWhenEmpty?: boolean;
  actions?: ScriptAction[];
  rowActions?: ScriptAction[];
  empty?: string;
}

export interface Action {
  label: string;
  icon: string;
  start?: boolean;
  set: string[];
  clear: string[];
  ask?: "tag";
  clearAsked?: boolean;
  until?: number | "ask";
  if?: string;
  unless?: string;
  /** A section action's targets, picked when the arrangement ran. */
  ids: string[];
}
export interface Section {
  backend?: string;
  title: string;
  /** Title path within the arrangement, independent of the backend. */
  path: string[];
  sections?: Section[];
  ids: string[];
  collapsed: boolean;
  hideWhenEmpty?: boolean;
  actions: Action[];
  rowActions: Action[];
  empty?: string;
}

export const ICONS = [
  "archive",
  "snooze",
  "pin",
  "unpin",
  "restore",
  "tag",
  "new",
];
export const UNSORTED = "Unsorted";
const LIMITS = {
  sections: 12,
  children: 12,
  actions: 2,
  rowActions: 4,
  text: 40,
};
/** An arrangement whose output fails the checks; shown to the operator. */
export class ArrangementError extends Error {}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ArrangementError(`${what} must be non-empty text`);
  if ([...value].length > LIMITS.text)
    throw new ArrangementError(`${what} is over ${LIMITS.text} characters`);
  return value;
}

function list<T>(value: unknown, max: number, what: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ArrangementError(`${what} is not a list`);
  if (value.length > max)
    throw new ArrangementError(`${what} has more than ${max} entries`);
  return value as T[];
}

const ids = (rows: unknown, known: Set<string>): string[] =>
  list<unknown>(rows, Infinity, "rows").flatMap((row) => {
    const id = typeof row === "string" ? row : (row as SidebarRow)?.id;
    return typeof id === "string" && known.has(id) ? [id] : [];
  });

function names(value: unknown, what: string): string[] {
  const all = typeof value === "string" ? [value] : list(value, 16, what);
  if (all.some((name) => typeof name !== "string"))
    throw new ArrangementError(`${what} must name tags`);
  return all as string[];
}

function action(
  value: unknown,
  known: Set<string>,
  sectionRows?: unknown,
): Action {
  const a = (value ?? {}) as ScriptAction;
  const label = text(a.label, "An action label");
  const icon = a.icon ?? "tag";
  if (!ICONS.includes(icon))
    throw new ArrangementError(`${label}: unknown icon ${icon}`);
  const checked: Action = {
    label,
    icon,
    set: names(a.set ?? [], `${label}: set`),
    clear: a.clear === "ask" ? [] : names(a.clear ?? [], `${label}: clear`),
    ids: ids(a.rows ?? sectionRows, known),
  };
  if (a.ask !== undefined) {
    if (a.ask !== "tag")
      throw new ArrangementError(`${label}: ask must be "tag"`);
    checked.ask = a.ask;
  }
  if (a.clear === "ask") {
    if (!a.ask)
      throw new ArrangementError(`${label}: clear "ask" needs ask: "tag"`);
    checked.clearAsked = true;
  }
  if (a.start !== undefined) {
    if (
      a.start !== true ||
      sectionRows === undefined ||
      a.clear !== undefined ||
      a.ask !== undefined ||
      a.until !== undefined ||
      a.rows !== undefined ||
      a.if !== undefined ||
      a.unless !== undefined ||
      checked.set.some(
        (name) => !/^[a-z0-9-]{1,24}$/.test(name) || OPERATOR_TAGS.has(name),
      )
    )
      throw new ArrangementError(
        `${label}: start is a section action with only custom set tags`,
      );
    checked.start = true;
  }
  if (
    !checked.start &&
    !checked.set.length &&
    !checked.clear.length &&
    !checked.ask
  )
    throw new ArrangementError(`${label}: changes no tag`);
  if (a.until !== undefined) {
    if (a.until !== "ask" && typeof a.until !== "number")
      throw new ArrangementError(`${label}: until is a time or "ask"`);
    checked.until = a.until;
  }
  if (typeof a.if === "string") checked.if = a.if;
  if (typeof a.unless === "string") checked.unless = a.unless;
  return checked;
}

/**
 * Check an arrangement's output against `rows`: unknown ids are dropped, a
 * repeated id keeps its first place, and omitted roots go to "Unsorted".
 */
export function checkSections(output: unknown, rows: SidebarRow[]): Section[] {
  const known = new Set(rows.map((row) => row.id));
  const placed = new Set<string>();
  const check = (raw: ScriptSection, parent: string[] = []): Section => {
    const s = (raw ?? {}) as ScriptSection;
    const title = text(s.title, "A section title");
    if ((s.rows === undefined) === (s.sections === undefined))
      throw new ArrangementError(`${title}: use either rows or sections`);
    if (parent.length && s.sections !== undefined)
      throw new ArrangementError(`${title}: sections may nest only one level`);
    const path = [...parent, title];
    const children =
      s.sections === undefined
        ? undefined
        : list<ScriptSection>(
            s.sections,
            LIMITS.children,
            `${title} sections`,
          ).map((child) => check(child, path));
    const sectionIds = children
      ? children.flatMap((child) => child.ids)
      : ids(s.rows, known).filter((id) => !placed.has(id) && placed.add(id));
    const section: Section = {
      title,
      path,
      ...(children ? { sections: children } : {}),
      ids: sectionIds,
      collapsed: s.collapsed === true,
      actions: list(s.actions, LIMITS.actions, `${title} actions`).map((a) =>
        action(a, known, sectionIds),
      ),
      rowActions: list(s.rowActions, LIMITS.rowActions, `${title} row actions`)
        .map((a) => action(a, known))
        .map((a) => ({ ...a, ids: [] })),
    };
    if (s.hideWhenEmpty !== undefined) {
      if (typeof s.hideWhenEmpty !== "boolean")
        throw new ArrangementError(`${title}: hideWhenEmpty must be a boolean`);
      section.hideWhenEmpty = s.hideWhenEmpty;
    }
    if (s.empty !== undefined) section.empty = text(s.empty, `${title} empty`);
    return section;
  };
  const sections = list<ScriptSection>(
    output,
    LIMITS.sections,
    "The arrangement",
  ).map((raw) => check(raw));
  const unsorted = rows
    .filter((r) => r.depth === 0 && !r.side_of)
    .map((r) => r.id)
    .filter((id) => !placed.has(id));
  if (unsorted.length)
    sections.push({
      title: UNSORTED,
      path: [UNSORTED],
      ids: unsorted,
      collapsed: false,
      actions: [],
      rowActions: [],
    });
  return sections;
}

/** Whether a row action applies to a row with these tags. */
export const actionApplies = (a: Action, tags: Tags): boolean =>
  (!a.if || !!tags[a.if]) && (!a.unless || !tags[a.unless]);
