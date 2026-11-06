// Sidebar actions change tags through API v1 on the owning backend, in batches.
// Changes overlay tree tags until a read started after the answer arrives.
// Snooze asks for a time; custom tags use typed names or existing suggestions.
// Section actions confirm their count before applying changes.
import { html, nothing, render, type TemplateResult } from "lit";
import { backendFor, parseConversationId } from "../backends/backend.js";
import { treeOf } from "../backends/tree.js";
import { poll } from "../conversation/poll.js";
import { requestUiStatus } from "../ui-events.js";
import { state } from "../state.js";
import { OPERATOR_TAGS } from "../../src/agents/conversation_tags.js";
import { normalizeSearchText, textRank, titleTokens } from "../fuzzy-match.js";
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
  if (action.ask === "tag") {
    const name = await askTag(anchor, ids, action.clearAsked === true);
    if (!name) return;
    action = {
      ...action,
      set: action.clearAsked ? action.set : [...action.set, name],
      clear: action.clearAsked ? [...action.clear, name] : action.clear,
    };
  }
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
  body: (
    done: (value: T | undefined) => void,
    refresh: () => void,
  ) => TemplateResult,
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
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
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
    const position = () => {
      const viewport = window.visualViewport;
      const top = (viewport?.offsetTop ?? 0) + 8;
      const bottom = top + (viewport?.height ?? innerHeight) - 16;
      host!.style.maxHeight = `${bottom - top}px`;
      const box = host!.getBoundingClientRect();
      const left = Math.min(
        Math.max(8, anchor.left),
        innerWidth - box.width - 8,
      );
      const y =
        anchor.bottom + 4 + box.height < bottom
          ? anchor.bottom + 4
          : anchor.top - box.height - 4;
      host!.style.left = `${left}px`;
      host!.style.top = `${Math.max(top, Math.min(y, bottom - box.height))}px`;
    };
    const refresh = () => {
      render(
        html`<div role="dialog" aria-label=${label}>
          ${body(done, refresh)}
        </div>`,
        host!,
      );
      position();
    };
    host!.hidden = false;
    refresh();
    host!
      .querySelector<HTMLElement>("[data-focus]")
      ?.focus({ preventScroll: true });
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
  });
}

/** Pick a custom tag from live rows, or type a normalized new name. */
export function askTag(
  anchor: DOMRect,
  ids: string[],
  removing: boolean,
  optional = false,
): Promise<string | undefined> {
  const now = Date.now() / 1000;
  const names = [
    ...new Set(
      (removing ? ids : Object.keys(state.nodes)).flatMap((id) =>
        Object.keys(shownTags(id, now)),
      ),
    ),
  ]
    .filter((name) => !OPERATOR_TAGS.has(name))
    .sort();
  let value = "";
  let picked = -1;
  const label = removing ? "Remove tag" : "Tag name";
  return popover<string>(anchor, label, (done, refresh) => {
    const suggestions = names
      .flatMap((name) => {
        const rank = textRank(
          {
            normalizedTitle: name,
            normalizedId: "",
            tokens: titleTokens(name),
          },
          value,
        );
        return rank ? [{ name, ...rank }] : [];
      })
      .sort(
        (a, b) =>
          a.tier - b.tier || a.score - b.score || a.name.localeCompare(b.name),
      );
    const error = OPERATOR_TAGS.has(value)
      ? "This tag is reserved. Choose another name."
      : removing && value && !names.includes(value)
        ? "Choose a tag on these conversations."
        : "";
    const submit = () => {
      const name = suggestions[picked]?.name ?? value;
      if (optional && !name) done("");
      else if (
        name &&
        !OPERATOR_TAGS.has(name) &&
        (!removing || names.includes(name))
      )
        done(name);
    };
    return html`<label class="popover-title" for="sidebar-tag-name"
        >${label}</label
      >
      <input
        id="sidebar-tag-name"
        data-focus
        type="text"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        enterkeyhint="done"
        .value=${value}
        aria-invalid=${error ? "true" : "false"}
        aria-describedby="sidebar-tag-error"
        @input=${(event: Event) => {
          const input = event.target as HTMLInputElement;
          value = normalizeSearchText(input.value.replace(/\s/g, "-"))
            .replace(/[^a-z0-9-]+/g, "-")
            .slice(0, 24);
          input.value = value;
          picked = -1;
          refresh();
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            picked =
              event.key === "ArrowDown"
                ? Math.min(picked + 1, suggestions.length - 1)
                : Math.max(-1, picked - 1);
            refresh();
            host!
              .querySelector("[aria-pressed=true]")
              ?.scrollIntoView({ block: "nearest" });
          } else if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      <span id="sidebar-tag-error" role="status" ?hidden=${!error}
        >${error}</span
      >
      <div class="tag-suggestions" aria-label="Existing tags">
        ${suggestions.map(
          ({ name }, index) =>
            html`<button
              type="button"
              class="btn"
              aria-pressed=${picked === index ? "true" : "false"}
              @click=${() => done(name)}
            >
              ${name}
            </button>`,
        )}
      </div>
      <button
        type="button"
        class="btn primary"
        ?disabled=${!value || !!error}
        @click=${submit}
      >
        ${removing ? "Remove tag" : "Set tag"}
      </button>
      ${optional
        ? html`<button type="button" class="btn" @click=${() => done("")}>
            No tag
          </button>`
        : nothing}`;
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
