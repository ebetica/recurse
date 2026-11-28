// Drafts and sidebar actions share one tag, snooze or confirmation popover.
// Input dialogs neither send mutations nor load the sidebar renderer.
import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { attachHoldTip } from "../hold-tip.js";
import { OPERATOR_TAGS } from "../../src/agent_metadata/index.js";
import { normalizeSearchText, textRank, titleTokens } from "../fuzzy-match.js";
import { state } from "../state.js";
import { shownTags } from "./tag-state.js";

/** Snooze presets: label and epoch seconds, from `now` (ms) in local time. */
function snoozePresets(now = Date.now()): [string, number][] {
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
      const viewportTop = viewport?.offsetTop ?? 0;
      const topInset =
        parseFloat(
          getComputedStyle(host!).getPropertyValue("--standalone-top-inset"),
        ) || 0;
      const top = Math.max(viewportTop, topInset) + 8;
      const bottom = viewportTop + (viewport?.height ?? innerHeight) - 8;
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

export function askSnooze(anchor: DOMRect): Promise<number | undefined> {
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

export async function askDeleteAgent(
  title: string,
  anchor: DOMRect,
): Promise<boolean> {
  const question = `Delete ${title} and all its subagents?`;
  let hold: ReturnType<typeof attachHoldTip> | undefined;
  return !!(await popover<boolean>(
    anchor,
    question,
    (done) => html`
      <p class="popover-title">${question}</p>
      <div class="dialog-buttons">
        <button
          type="button"
          class="btn"
          data-focus
          @click=${() => done(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn danger"
          ${ref((button) => {
            if (button instanceof HTMLButtonElement)
              hold = attachHoldTip(button, document, {
                text: () => "Tap to confirm deletion",
                onHoldEnd: () => done(false),
              });
          })}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") e.preventDefault();
          }}
          @click=${() => {
            if (!hold?.takeHoldConsumed()) done(true);
          }}
        >
          Delete agent
        </button>
      </div>
    `,
  ));
}

export async function askConfirm(
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
        <div class="dialog-buttons">
          <button class="btn" @click=${() => done(false)}>Cancel</button>
          <button class="btn primary" data-focus @click=${() => done(true)}>
            ${verb}
          </button>
        </div>`,
  ));
}
