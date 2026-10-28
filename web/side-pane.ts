// Side pane: /btw and New forks share one embedded app frame
// (`/?embed=1#agent=<id>`), warmed behind the focused read. Switching changes
// its hash; closing parks it, still loaded. Deletes hide immediately,
// survive stale tree reads, and restore on failure.
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { backendFor } from "./backends/backend.js";
import { poll } from "./conversation/poll.js";
import {
  CHEVRON_DOWN_ICON,
  DELETE_ICON,
  NEW_ICON,
  PEN_ICON,
  PROMOTE_ICON,
  SIDE_ICON,
} from "./icons.js";
import { fetchPaneData, openPane, registerPane, syncPanes } from "./panes.js";
import { renderPowerbarControls } from "./panes/powerbar.js";
import { embedded, state } from "./state.js";
import type { PaneContext } from "./types.js";

const PANE_ID = "side";
// Parent id -> the side conversation its pane shows.
const chosen = new Map<string, string>();
// Created side id -> parent, until the tree lists it.
const pending = new Map<string, string>();
// Deleted here: a tree read already in flight may still list them.
const deleted = new Set<string>();
// Renamed here: shown until the tree lists the new title.
const titles = new Map<string, string>();
// Promotion requested here: shown until the tree reports it.
const promoting = new Set<string>();
// The side conversation whose name is being edited.
let renaming: string | null = null;
let busy = false;
let notice = "";
// The page's one embedded app, in the pane body or parked while closed.
let frame: HTMLIFrameElement | null = null;

// Without moveBefore, moving reloads frames: never park/warm; boot on open.
const canPark = "moveBefore" in Element.prototype;

const frameUrl = (id: string) => `/?embed=1#agent=${encodeURIComponent(id)}`;

function parking(): HTMLElement {
  let lot = document.getElementById("side-frame-parking");
  if (!lot) {
    lot = document.createElement("div");
    lot.id = "side-frame-parking";
    lot.hidden = true;
    document.body.append(lot);
  }
  return lot;
}

/** Show side conversation {id} in the page's frame, moved into {target}. */
function placeFrame(target: HTMLElement, id: string, title?: string): void {
  const move = (
    target as { moveBefore?: (node: Node, child: Node | null) => void }
  ).moveBefore;
  if (frame && frame.parentElement !== target && !move) {
    frame.remove();
    frame = null;
  }
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "side-frame";
    frame.src = frameUrl(id);
  } else if (frame.dataset.side !== id)
    // Invariant: Only the hash changes, so the embedded app switches
    // conversations without reloading or adding a Back entry.
    frame.contentWindow?.location.replace(frameUrl(id));
  frame.dataset.side = id;
  if (title !== undefined) frame.title = `Side conversation: ${title}`;
  if (frame.parentElement === target) return;
  if (frame.isConnected && move) move.call(target, frame, null);
  else target.append(frame);
  frame.contentWindow?.dispatchEvent(new Event("recurse:embedded-visibility"));
}

/** Park a closing frame, or drop it if parking would reload. */
function parkFrame(el: HTMLElement): void {
  if (!frame || !el.contains(frame)) return;
  if (canPark) return placeFrame(parking(), frame.dataset.side!);
  frame.remove();
  frame = null;
}

/** Preboot the parent's shown side conversation frame. */
function warmFrame(parent: string): Promise<void> | void {
  const id = shownSide(parent);
  if (embedded || !canPark || !id || frame) return;
  placeFrame(parking(), id);
  const booting = frame!;
  return new Promise((resolve) =>
    booting.addEventListener("load", () => resolve(), { once: true }),
  );
}

function sidesOf(parent: string) {
  const sides = state.sides.filter(
    (side) =>
      side.side_of === parent &&
      side.status !== "deleting" &&
      !deleted.has(side.id),
  );
  for (const side of sides) {
    pending.delete(side.id);
    if (titles.get(side.id) === side.title) titles.delete(side.id);
    if (side.promoting || side.promotion_error) promoting.delete(side.id);
  }
  return sides;
}

function shownSide(parent: string): string | null {
  const sides = sidesOf(parent);
  const id = chosen.get(parent);
  if (id && (pending.get(id) === parent || sides.some((s) => s.id === id)))
    return id;
  return sides[0]?.id ?? null;
}

/** Show side conversation {id} of {parent}, opening the pane. */
export function showSide(parent: string, id: string): void {
  if (!state.sides.some((side) => side.id === id)) pending.set(id, parent);
  chosen.set(parent, id);
  notice = "";
  openPane(PANE_ID, { userInitiated: true });
  syncPanes();
}

async function act(work: () => Promise<string>): Promise<void> {
  busy = true;
  notice = "";
  syncPanes();
  try {
    notice = await work();
  } catch {
    notice = "The server could not be reached.";
  } finally {
    busy = false;
    syncPanes();
    void poll();
  }
}

function create(parent: string): Promise<void> {
  return act(async () => {
    const r = await backendFor(parent).jpost(
      `/api/conversations/${encodeURIComponent(parent)}/side`,
      {},
      { availability: "core", timeoutMs: 0 },
    );
    if (!r.ok) return "Could not start a side conversation.";
    showSide(parent, ((await r.json()) as { id: string }).id);
    return "";
  });
}

function remove(parent: string, id: string): Promise<void> {
  const wasPending = pending.get(id);
  const wasChosen = chosen.get(parent);
  deleted.add(id);
  pending.delete(id);
  if (wasChosen === id) chosen.delete(parent);
  return act(async () => {
    let removed = false;
    try {
      const r = await backendFor(id).api(
        `/api/conversations/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        { timeoutMs: 30_000 },
      );
      removed = r.ok;
      return r.ok ? "" : "Could not delete this side conversation.";
    } finally {
      if (!removed) {
        deleted.delete(id);
        if (wasPending) pending.set(id, wasPending);
        if (wasChosen) chosen.set(parent, wasChosen);
        if (state.selectedId === parent) openPane(PANE_ID);
      }
    }
  });
}

function promote(id: string): Promise<void> {
  return act(async () => {
    const r = await backendFor(id).jpost(
      `/api/conversations/${encodeURIComponent(id)}/promote`,
      {},
    );
    if (r.ok) {
      promoting.add(id);
      return "";
    }
    const detail = ((await r.json().catch(() => ({}))) as { detail?: unknown })
      .detail;
    return typeof detail === "string"
      ? `Could not promote: ${detail}.`
      : "Could not promote this side conversation.";
  });
}

function rename(id: string, title: string): Promise<void> {
  return act(async () => {
    const r = await backendFor(id).jpost(
      `/api/conversations/${encodeURIComponent(id)}/rename`,
      { title },
    );
    if (!r.ok) return "Could not rename this side conversation.";
    titles.set(id, ((await r.json()) as { title: string }).title);
    return "";
  });
}

function paint(el: HTMLElement, ctx: PaneContext): void {
  const parent = ctx.agentId;
  const sides = sidesOf(parent);
  const id = shownSide(parent);
  const title = (sid: string) =>
    titles.get(sid) ||
    sides.find((side) => side.id === sid)?.title ||
    "New side conversation";
  const options = sides.some((side) => side.id === id) || !id ? [] : [id];
  const shown = sides.find((side) => side.id === id);
  const promotingShown =
    !!id && (promoting.has(id) || shown?.promoting === true);
  const idle =
    !!shown && shown.status !== "running" && !shown.queued && !promotingShown;
  if (renaming !== id) renaming = null;
  const finishRename = (input: HTMLInputElement, commit: boolean) => {
    if (renaming === null) return;
    const value = input.value.trim();
    renaming = null;
    if (commit && id && value && value !== title(id)) void rename(id, value);
    else syncPanes();
  };
  const picker = renaming
    ? html`<input
        class="text-field side-rename"
        aria-label="Side conversation name"
        maxlength="200"
        .value=${title(renaming)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key !== "Enter" || event.isComposing) return;
          event.preventDefault();
          finishRename(event.target as HTMLInputElement, true);
        }}
        @blur=${(event: FocusEvent) =>
          finishRename(event.target as HTMLInputElement, false)}
      />`
    : html`<label class="sr-only" for="side-picker">Side conversation</label>
        <span class="side-picker-box"
          ><select
            id="side-picker"
            class="side-picker"
            ?disabled=${busy || sides.length + options.length < 2}
            @change=${(event: Event) => {
              chosen.set(parent, (event.target as HTMLSelectElement).value);
              syncPanes();
            }}
          >
            ${[...options, ...sides.map((side) => side.id)].map(
              (sid) =>
                html`<option value=${sid} .selected=${sid === id}>
                  ${title(sid)}
                </option>`,
            )}</select
          ><span class="side-picker-chevron" aria-hidden="true"
            >${unsafeHTML(CHEVRON_DOWN_ICON)}</span
          ></span
        >`;
  renderPowerbarControls(
    el,
    html`${picker}
      <button
        type="button"
        class="icon-btn side-rename-btn"
        title="Rename side conversation"
        aria-label="Rename side conversation"
        ?disabled=${busy || !id || !!renaming}
        @click=${() => {
          renaming = id;
          syncPanes();
          el.closest(".pane-col")
            ?.querySelector<HTMLInputElement>(".side-rename")
            ?.select();
        }}
      >
        ${unsafeHTML(PEN_ICON)}
      </button>
      <button
        type="button"
        class="icon-btn side-new"
        title="New side conversation"
        aria-label="New side conversation"
        ?disabled=${busy}
        @click=${() => void create(parent)}
      >
        ${unsafeHTML(NEW_ICON)}
      </button>
      <button
        type="button"
        class="icon-btn side-promote"
        title="Promote to subagent"
        aria-label="Promote to subagent"
        ?disabled=${busy || !idle}
        @click=${() => id && void promote(id)}
      >
        ${unsafeHTML(PROMOTE_ICON)}
      </button>
      <button
        type="button"
        class="icon-btn side-delete"
        title="Delete side conversation"
        aria-label="Delete side conversation"
        ?disabled=${busy || !id}
        @click=${() => id && void remove(parent, id)}
      >
        ${unsafeHTML(DELETE_ICON)}
      </button>`,
    true,
  );
  let status = el.querySelector<HTMLElement>(".side-notice");
  if (!status) {
    status = document.createElement("p");
    status.className = "side-notice";
    status.setAttribute("role", "status");
    el.prepend(status);
  }
  const shownNotice =
    notice ||
    (promotingShown
      ? "Promoting to a subagent…"
      : shown?.promotion_error
        ? `Could not promote: ${shown.promotion_error}.`
        : "");
  status.textContent = shownNotice;
  status.hidden = !shownNotice;
  if (id) placeFrame(el, id, title(id));
  else {
    frame?.remove();
    frame = null;
  }
}

// Repaint when a tree read changes the sides, e.g. a promotion's outcome.
let seenSides = "";
addEventListener("recurse:tree-authoritative", () => {
  const sides = JSON.stringify(
    state.sides.map((side) => [
      side.id,
      side.status,
      side.queued,
      side.promoting,
      side.promotion_error,
    ]),
  );
  if (sides === seenSides) return;
  seenSides = sides;
  syncPanes();
});

registerPane({
  id: PANE_ID,
  title: "Side conversations",
  icon: SIDE_ICON,
  available: (ctx: PaneContext) =>
    !!ctx.node &&
    (sidesOf(ctx.agentId).length > 0 ||
      [...pending.values()].includes(ctx.agentId)),
  visit: (agentId: string) =>
    fetchPaneData(PANE_ID, agentId, () => warmFrame(agentId)),
  render: paint,
  refresh: paint,
  leave: parkFrame,
});
