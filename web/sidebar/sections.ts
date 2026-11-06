// Sidebar sections for every backend: runs the arrangement over all
// conversations, remembers which sections the operator folded on this device,
// and draws section headers and the row and section action buttons. On
// hover devices, buttons overlay the right edge on hover or keyboard focus.
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { PEN_ICON, actionIcon } from "../icons.js";
import type { TreeNode } from "../types.js";
import { parseConversationId } from "../backends/backend.js";
import { runAction, shownTags } from "./actions.js";
import { startNewAgent } from "../composer.js";
import defaultSidebar from "./default_sidebar.js";
import { arrangedScriptRows, scriptOutput } from "./script.js";
import {
  actionApplies,
  checkSections,
  sidebarRows,
  type Action,
  type Section,
} from "./arrangement.js";
import type { HoldItem } from "./hold.js";

const FOLDS_KEY = "recurse.sidebarFolds";
let folds: Record<string, boolean> = {};
try {
  folds = JSON.parse(localStorage.getItem(FOLDS_KEY) || "{}") ?? {};
} catch {}

/** Full paths keep repeated child titles independent on every backend. */
export const sectionKey = (section: Section): string =>
  JSON.stringify([section.backend ?? "", ...section.path]);

export const isFolded = (section: Section): boolean =>
  folds[sectionKey(section)] ??
  (section.path.length === 1
    ? (folds[`${section.backend ?? ""}/${section.title}`] ??
      folds[section.title])
    : undefined) ??
  section.collapsed;

export function toggleFold(section: Section): void {
  folds[sectionKey(section)] = !isFolded(section);
  try {
    localStorage.setItem(FOLDS_KEY, JSON.stringify(folds));
  } catch {}
}

/** Sections for all conversations, given in activity order. */
export function arrange(roots: TreeNode[]): Section[] {
  const now = Date.now() / 1000;
  const rows = sidebarRows(roots, now, (node) => shownTags(node.id, now));
  try {
    const output = scriptOutput(rows, now) ?? defaultSidebar(rows, now);
    return checkSections(output, arrangedScriptRows(rows));
  } catch (error) {
    console.error("sidebar arrangement failed", error);
    return checkSections([], rows);
  }
}

/** Backend-local rows and actions, omitting sections that hide when empty. */
export function sectionForBackend(
  original: Section,
  backend: string,
  writable: (id: string) => boolean,
): Section | null {
  const owns = (id: string) => parseConversationId(id).label === backend;
  const ids = original.ids.filter(owns);
  if (original.hideWhenEmpty && !ids.length) return null;
  return {
    ...original,
    backend,
    ids,
    sections: original.sections?.flatMap((child) => {
      const section = sectionForBackend(child, backend, writable);
      return section ? [section] : [];
    }),
    actions: original.actions
      .map((a) => ({
        ...a,
        ids: a.ids.filter((id) => owns(id) && writable(id)),
      }))
      .filter((a) => a.start || a.ids.length),
  };
}

/** Row actions that apply to `id` now. */
export function rowActions(section: Section, id: string): Action[] {
  const tags = shownTags(id, Date.now() / 1000);
  return section.rowActions.filter((a) => actionApplies(a, tags));
}

const runSectionAction = (action: Action, section: Section, anchor: DOMRect) =>
  action.start
    ? startNewAgent(anchor, section.backend, action.set)
    : runAction(action, action.ids, anchor, true);

const anchorOf = (e: Event) =>
  (e.currentTarget as HTMLElement).getBoundingClientRect();

/** The row's action buttons, shown on hover or focus. */
export function rowButtons(
  actions: Action[],
  id: string,
  title: string,
  focusable: boolean,
): TemplateResult | typeof nothing {
  if (!actions.length) return nothing;
  return html`<span class="row-actions">
    ${actions.map(
      (a) =>
        html`<button
          type="button"
          class="icon-btn"
          tabindex=${focusable ? 0 : -1}
          aria-label=${`${a.label} ${title}`}
          title=${`${a.label} ${title}`}
          @click=${(e: Event) => {
            e.stopPropagation();
            void runAction(a, [id], anchorOf(e));
          }}
          @dblclick=${(e: Event) => e.stopPropagation()}
        >
          ${unsafeHTML(actionIcon(a.icon))}
        </button>`,
    )}
  </span>`;
}

/** A section header: its title and count fold it; actions show on hover. */
export function sectionHeader(
  section: Section,
  onToggle: () => void,
): TemplateResult {
  const folded = isFolded(section);
  return html`<div
      class="tree-section-header"
      role="none"
      data-section=${section.title}
      data-section-key=${sectionKey(section)}
      style=${section.path.length > 1
        ? "margin-inline-start: var(--space-3)"
        : ""}
    >
      <button
        type="button"
        class="tree-section-toggle"
        aria-expanded=${String(!folded)}
        @click=${() => {
          toggleFold(section);
          onToggle();
        }}
      >
        <span class="fold-mark" aria-hidden="true">${folded ? "▸" : "▾"}</span>
        <span class="tree-section-title" title=${section.title}
          >${section.title}</span
        >
        <span class="tree-section-count">${section.ids.length}</span>
      </button>
      <span class="section-actions">
        ${section.actions.map(
          (a) =>
            html`<button
              type="button"
              class="btn sm quiet"
              title=${a.label}
              @click=${(e: Event) =>
                void runSectionAction(a, section, anchorOf(e))}
            >
              ${a.label}
            </button>`,
        )}
      </span>
    </div>
    ${!folded && !section.ids.length && section.empty
      ? html`<div
          class="tree-section-empty"
          role="none"
          style=${section.path.length > 1
            ? "margin-inline-start: var(--space-3)"
            : ""}
        >
          ${section.empty}
        </div>`
      : nothing}`;
}

/** Hold-menu items for a row: its actions, then Rename. */
export function rowHoldItems(
  actions: Action[],
  id: string,
  rename: () => void,
): HoldItem[] {
  return [
    ...actions.map((a) => ({
      label: a.label,
      icon: actionIcon(a.icon),
      run: (anchor: DOMRect) => void runAction(a, [id], anchor),
    })),
    { label: "Rename", icon: PEN_ICON, run: rename },
  ];
}

/** Hold-menu items for a section header: its actions. */
export const sectionHoldItems = (section: Section): HoldItem[] =>
  section.actions.map((a) => ({
    label: a.label,
    icon: actionIcon(a.icon),
    run: (anchor: DOMRect) => void runSectionAction(a, section, anchor),
  }));
