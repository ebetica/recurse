// The checks a sidebar script's output (`sidebar(rows, now) → sections`)
// passes before it is shown. A section can start folded, but its header and
// count always show, and roots the script leaves out go to a visible "Unsorted"
// section. The built-in script is default_sidebar.js.
import type { SidebarRow, Tags } from "./rows.js";
export {
  liveTags,
  sidebarRow,
  sidebarRows,
  type SidebarRow,
  type Tag,
  type Tags,
} from "./rows.js";

type Names = string | string[];
export interface ScriptAction {
  label: string;
  icon?: string;
  set?: Names;
  clear?: Names;
  until?: number | "ask";
  if?: string;
  unless?: string;
  rows?: (SidebarRow | string)[];
}
export interface ScriptSection {
  title: string;
  rows: (SidebarRow | string)[];
  collapsed?: boolean;
  actions?: ScriptAction[];
  rowActions?: ScriptAction[];
  empty?: string;
}

export interface Action {
  label: string;
  icon: string;
  set: string[];
  clear: string[];
  until?: number | "ask";
  if?: string;
  unless?: string;
  /** A section action's targets, picked when the arrangement ran. */
  ids: string[];
}
export interface Section {
  backend?: string;
  title: string;
  ids: string[];
  collapsed: boolean;
  actions: Action[];
  rowActions: Action[];
  empty?: string;
}

export const ICONS = ["archive", "snooze", "pin", "unpin", "restore", "tag"];
export const UNSORTED = "Unsorted";
const LIMITS = { sections: 12, actions: 2, rowActions: 4, text: 40 };
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

function action(value: unknown, known: Set<string>): Action {
  const a = (value ?? {}) as ScriptAction;
  const label = text(a.label, "An action label");
  const icon = a.icon ?? "tag";
  if (!ICONS.includes(icon))
    throw new ArrangementError(`${label}: unknown icon ${icon}`);
  const checked: Action = {
    label,
    icon,
    set: names(a.set ?? [], `${label}: set`),
    clear: names(a.clear ?? [], `${label}: clear`),
    ids: ids(a.rows ?? [], known),
  };
  if (!checked.set.length && !checked.clear.length)
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
  const sections = list<ScriptSection>(
    output,
    LIMITS.sections,
    "The arrangement",
  ).map((raw): Section => {
    const s = (raw ?? {}) as ScriptSection;
    const title = text(s.title, "A section title");
    const section: Section = {
      title,
      ids: ids(s.rows, known).filter((id) => !placed.has(id) && placed.add(id)),
      collapsed: s.collapsed === true,
      actions: list(s.actions, LIMITS.actions, `${title} actions`).map((a) =>
        action(a, known),
      ),
      rowActions: list(s.rowActions, LIMITS.rowActions, `${title} row actions`)
        .map((a) => action(a, known))
        .map((a) => ({ ...a, ids: [] })),
    };
    if (s.empty !== undefined) section.empty = text(s.empty, `${title} empty`);
    return section;
  });
  const unsorted = rows
    .filter((r) => r.depth === 0 && !r.side_of)
    .map((r) => r.id)
    .filter((id) => !placed.has(id));
  if (unsorted.length)
    sections.push({
      title: UNSORTED,
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
