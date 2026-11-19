// What is new in a Markdown document since its reviewed version, for Artifacts
// and Files. Reviewed versions live in page memory only: after a reload the
// first version seen counts as reviewed. Reviewed, submitting comments on the
// highlighted version, or picking a version under "New since" moves it.
import { html, type TemplateResult } from "lit";
import { clearDocumentChanges } from "./document-diff.js";

const reviewed = new Map<string, string>();
const reviewers = new WeakMap<Element, () => void>();

/** The version last counted as reviewed; the first one seen starts it. */
export function reviewedVersion(doc: string, seen: string): string {
  if (!reviewed.has(doc)) reviewed.set(doc, seen);
  return reviewed.get(doc)!;
}

function setReviewed(doc: string, version: string): void {
  reviewed.set(doc, version);
}

export interface DocumentChanges {
  doc: string;
  /** The highlighted (latest) version and the one it is compared with. */
  version: string;
  since: string;
  /** The highlights are already gone; hide the review controls. */
  onReviewed: () => void;
  /** Show the document again, compared with its new reviewed version. */
  onCompare: () => void;
}

/**
 * Let `root`, the rendered document, be marked reviewed in place: the
 * highlights go, comment marks stay. Called with null for a plain render.
 */
export function watchReview(root: Element, changes: DocumentChanges | null) {
  if (!changes) return void reviewers.delete(root);
  reviewers.set(root, () => {
    reviewers.delete(root);
    setReviewed(changes.doc, changes.version);
    clearDocumentChanges(root);
    changes.onReviewed();
  });
}

/** Mark the highlighted document in `root` reviewed, if it is showing. */
export function reviewDocument(root: Element | null): void {
  if (root) reviewers.get(root)?.();
}

/** "New since [version]"; `versions` are earlier ones, newest first. */
export function changesHeader(
  changes: DocumentChanges,
  versions: { value: string; label: string }[],
): TemplateResult {
  const options = versions.some((item) => item.value === changes.since)
    ? versions
    : [{ value: changes.since, label: "Last reviewed" }, ...versions];
  return html`<div class="doc-changes">
    <label>
      <span>New since</span>
      <select
        @change=${(event: Event) => {
          setReviewed(
            changes.doc,
            (event.currentTarget as HTMLSelectElement).value,
          );
          changes.onCompare();
        }}
      >
        ${options.map(
          (item) =>
            html`<option
              value=${item.value}
              .selected=${item.value === changes.since}
            >
              ${item.label}
            </option>`,
        )}
      </select>
    </label>
  </div>`;
}

export function reviewedFooter(root: Element | null): TemplateResult {
  return html`<div class="doc-reviewed">
    <button class="btn" type="button" @click=${() => reviewDocument(root)}>
      Reviewed
    </button>
  </div>`;
}
