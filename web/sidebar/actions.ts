// Sidebar actions change tags through API v1 on the owning backend, in batches.
// Each change shows at once, over the tree's tags, until a tree read started
// after its answer arrives or its request fails. Snooze asks for a time from a
// few presets; a section action confirms its count first.
import { html, nothing, render, type TemplateResult } from "lit";
import { backendFor, parseConversationId } from "../backends/backend.js";
import { treeOf } from "../backends/tree.js";
import { poll } from "../conversation/poll.js";
import { requestUiStatus } from "../ui-events.js";
import { state } from "../state.js";
import { liveTags, type Action, type Tags } from "./arrangement.js";

export const SIDEBAR_CHANGE = "recurse:sidebar-change";
const changed = () => window.dispatchEvent(new Event(SIDEBAR_CHANGE));

interface Change {
  set: Record<string, number | null>;
  clear: string[];
  /** When the change is shown to have happened, for reply comparisons. */
  at: number;
  /** Owning backend's tree reads started before the server answered. */
  readsBefore?: number;
}
const pending = new Map<string, Change[]>();
/** Batch size of POST /api/sidebar/tags (the route's MAX_TAG_IDS). */
const MAX_IDS = 500;

/** The tree's tags with this browser's unconfirmed changes applied in order.
 * A change is confirmed by the first tree read that started after its answer,
 * never by an older read that happens to agree with it. */
export function shownTags(id: string, now: number): Tags {
  const tags = liveTags(state.nodes[id]?.tags, -Infinity);
  const read = treeOf(backendFor(id)).appliedRead;
  const changes = (pending.get(id) ?? []).filter(
    (c) => c.readsBefore === undefined || read <= c.readsBefore,
  );
  if (changes.length) pending.set(id, changes);
  else pending.delete(id);
  for (const change of changes) {
    for (const name of change.clear) delete tags[name];
    for (const [name, until] of Object.entries(change.set))
      tags[name] =
        until === null
          ? { at: change.at, by: "operator" }
          : { at: change.at, by: "operator", until };
  }
  return liveTags(tags, now);
}

function drop(id: string, change: Change): void {
  const left = (pending.get(id) ?? []).filter((c) => c !== change);
  if (left.length) pending.set(id, left);
  else pending.delete(id);
}

/** Ask, confirm if needed, then apply `action` to `ids`. */
export async function runAction(
  action: Action,
  ids: string[],
  anchor: DOMRect,
  confirm = false,
): Promise<void> {
  let until = action.until;
  if (until === "ask") until = await askSnooze(anchor);
  if (until === undefined && action.until === "ask") return;
  if (confirm && !(await askConfirm(action.label, ids.length, anchor))) return;
  const now = Date.now() / 1000;
  const set = Object.fromEntries(
    action.set.map((name) => [name, typeof until === "number" ? until : null]),
  );
  const changes = new Map<string, Change>();
  for (const id of ids) {
    // Invariant: A shown archive outranks the last reply, whatever the clocks.
    const at = Math.max(now, (state.nodes[id]?.replied_at ?? 0) + 1);
    const change = { set, clear: action.clear, at };
    changes.set(id, change);
    pending.set(id, [...(pending.get(id) ?? []), change]);
  }
  changed();
  // Invariant: Requests reach the server in the order the operator acted, so
  // a later action is never overwritten by an earlier one still being sent.
  const turn = sending.then(() => send(action, ids, set, changes));
  sending = turn.catch(() => {});
  await turn;
}

let sending: Promise<void> = Promise.resolve();

async function send(
  action: Action,
  ids: string[],
  set: Record<string, number | null>,
  changes: Map<string, Change>,
): Promise<void> {
  let failed = 0;
  const groups = Map.groupBy(ids, (id) => backendFor(id));
  for (const [backend, targets] of groups) {
    for (let i = 0; i < targets.length; i += MAX_IDS) {
      const batch = targets.slice(i, i + MAX_IDS);
      const response = await backend
        .jpost(backend.label ? "/api/v1/agents/tags" : "/api/sidebar/tags", {
          ids: batch.map((id) => parseConversationId(id).cid),
          set,
          clear: action.clear,
        })
        .catch(() => null);
      const body = response?.ok
        ? ((await response.json().catch(() => null)) as {
            missing?: string[];
          } | null)
        : null;
      const missing = new Set(body?.missing ?? []);
      const readsBefore = treeOf(backend).readsStarted;
      for (const id of batch) {
        const change = changes.get(id)!;
        if (body && !missing.has(parseConversationId(id).cid))
          change.readsBefore = readsBefore;
        else {
          drop(id, change);
          if (!missing.has(parseConversationId(id).cid)) failed++;
        }
      }
    }
  }
  if (failed)
    requestUiStatus(
      failed === ids.length
        ? `${action.label} failed; try again`
        : `${action.label} failed for ${failed} of ${ids.length}; try again`,
    );
  changed();
  void poll();
}

/** Snooze presets: label and epoch seconds, from `now` (ms) in local time. */
export function snoozePresets(now = Date.now()): [string, number][] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.getTime() / 1000;
  };
  const presets: [string, number][] = [["1 hour", now / 1000 + 3600]];
  if (at(0, 20) - now / 1000 > 3600) presets.push(["Tonight", at(0, 20)]);
  presets.push(["Tomorrow 9:00", at(1, 9)]);
  presets.push(["Next week", at((8 - new Date(now).getDay()) % 7 || 7, 9)]);
  return presets;
}

let host: HTMLElement | null = null;
let closeOpen: (() => void) | null = null;

/** Show one small dialog near `anchor`; resolves when it closes. */
function popover<T>(
  anchor: DOMRect,
  label: string,
  body: (done: (value: T | undefined) => void) => TemplateResult,
): Promise<T | undefined> {
  closeOpen?.();
  host ??= document.body.appendChild(document.createElement("div"));
  host.id = "sidebar-popover";
  return new Promise((resolve) => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const done = (value: T | undefined) => {
      closeOpen = null;
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      render(nothing, host!);
      host!.hidden = true;
      returnFocus?.focus?.({ preventScroll: true });
      resolve(value);
    };
    const outside = (e: Event) => {
      if (!host!.contains(e.target as Node)) done(undefined);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      done(undefined);
    };
    closeOpen = () => done(undefined);
    render(
      html`<div role="dialog" aria-label=${label}>${body(done)}</div>`,
      host!,
    );
    host!.hidden = false;
    const box = host!.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.left), innerWidth - box.width - 8);
    const below = anchor.bottom + 4 + box.height < innerHeight;
    host!.style.left = `${left}px`;
    host!.style.top = `${below ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4)}px`;
    host!.querySelector<HTMLElement>("[data-focus]")?.focus();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
  });
}

function askSnooze(anchor: DOMRect): Promise<number | undefined> {
  return popover<number>(
    anchor,
    "Snooze until",
    (done) =>
      html`<p class="popover-title">Snooze until</p>
        ${snoozePresets().map(
          ([label, at], i) =>
            html`<button
              class="btn"
              ?data-focus=${i === 0}
              @click=${() => done(at)}
            >
              ${label}
            </button>`,
        )}`,
  );
}

async function askConfirm(
  label: string,
  count: number,
  anchor: DOMRect,
): Promise<boolean> {
  const verb = label.split(" ")[0]!;
  const question = `${verb} ${count} conversation${count === 1 ? "" : "s"}?`;
  return !!(await popover<boolean>(
    anchor,
    question,
    (done) =>
      html`<p class="popover-title">${question}</p>
        <div class="popover-buttons">
          <button class="btn" @click=${() => done(false)}>Cancel</button>
          <button class="btn primary" data-focus @click=${() => done(true)}>
            ${verb}
          </button>
        </div>`,
  ));
}
