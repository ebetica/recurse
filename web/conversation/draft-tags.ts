// Optional draft tags share the sidebar's fuzzy picker and effort defaults.
import { html, render } from "lit";
import { askTag } from "../sidebar/actions.js";
import { newAgentSettings } from "../sidebar/script.js";
import { showDraftModel } from "../models.js";
import { requestUiStatus } from "../ui-events.js";
import { state } from "../state.js";
import type { Draft } from "../types.js";

const initialized = new WeakSet<Draft>();

/** Paint the optional tag control without delaying or refocusing the draft. */
export async function showDraftTags(draft: Draft): Promise<void> {
  if (draft.parent !== null) return;
  const settings = await newAgentSettings().catch((error) => {
    requestUiStatus(String(error?.message ?? error));
    return undefined;
  });
  const host = document.querySelector<HTMLElement>("#draft-tag-host");
  if (!host || state.draft !== draft || draft.pending?.length) return;
  const applyDefault = () => {
    const effort = (draft.tags ?? [])
      .map((tag) => settings?.defaults?.[tag]?.effort)
      .find((value) => value !== undefined);
    if (effort !== undefined) showDraftModel(effort);
  };
  if (!initialized.has(draft)) {
    initialized.add(draft);
    if (draft.level == null) applyDefault();
  }
  if (settings?.ask !== "tag") return;
  const paint = () =>
    render(
      html`<button
        id="draft-tag"
        type="button"
        aria-label=${draft.tags?.length
          ? `Tag: ${draft.tags.join(", ")}`
          : "No tag"}
        aria-haspopup="dialog"
        @click=${async (event: Event) => {
          const button = event.currentTarget as HTMLElement;
          const name = await askTag(
            button.getBoundingClientRect(),
            [],
            false,
            true,
          );
          if (
            name === undefined ||
            state.draft !== draft ||
            draft.pending?.length
          )
            return;
          draft.tags = name ? [name] : [];
          applyDefault();
          paint();
        }}
      >
        ${draft.tags?.length ? `Tag: ${draft.tags.join(", ")}` : "No tag"}
        <span aria-hidden="true">⌃</span>
      </button>`,
      host,
    );
  paint();
}
