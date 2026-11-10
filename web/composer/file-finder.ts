// # filename completion uses the selected agent's existing folder search.
// Pending queries retain completed rows/selection; closing cancels all reads.
// Picks edit the visible draft through its normal input/persistence lifecycle.
import { html, render } from "lit";
import { inputEl } from "../dom.js";
import { DRAFT, state } from "../state.js";
import { backendFor, parseConversationId } from "../backends/backend.js";
import { LazyResults } from "../lazy-results.js";
import {
  composerAutocompleteIs,
  hideComposerAutocomplete,
  showComposerAutocomplete,
} from "./autocomplete.js";

const id = "file-menu";
const menu = document.createElement("div");
menu.id = id;
menu.className = "menu";
menu.hidden = true;
menu.setAttribute("role", "listbox");
menu.setAttribute("aria-label", "Files in this agent’s folder");
inputEl.parentElement!.append(menu);
let paths: string[] = [],
  active = 0,
  queryKey = "",
  composing = false,
  pointer = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: AbortController | undefined;
let owner: string | null = null;
const results = new LazyResults();
const insertable = (path: string) =>
  path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(path);

function token() {
  if (composing || inputEl.selectionStart !== inputEl.selectionEnd) return null;
  const caret = inputEl.selectionStart;
  const match = inputEl.value.slice(0, caret).match(/(^|\s)#([^\s#`]*)$/u);
  if (!match) return null;
  const start = caret - match[2]!.length - 1;
  const whole = inputEl.value.slice(start + 1).match(/^[^\s#`]*/u)![0];
  return whole.length <= 128
    ? { start, end: start + whole.length + 1, query: whole }
    : null;
}
function close() {
  clearTimeout(timer);
  pending?.abort();
  pending = undefined;
  queryKey = "";
  owner = null;
  results.clear();
  paths = [];
  menu.hidden = true;
  hideComposerAutocomplete(id);
}
function owns(key: string, shift: boolean) {
  return (
    !composing &&
    (key === "Escape" ||
      (paths.some(insertable) &&
        (["ArrowDown", "ArrowUp", "Tab"].includes(key) ||
          (key === "Enter" && !shift))))
  );
}
function paint(status = "") {
  if (!document.getElementById("file-menu-style")) {
    const link = document.createElement("link");
    link.id = "file-menu-style";
    link.rel = "stylesheet";
    link.href = "/static/composer-files.css";
    document.head.append(link);
  }
  showComposerAutocomplete(
    id,
    close,
    owns,
    paths.length ? `file-option-${active}` : undefined,
  );
  render(
    html`${paths.map(
      (path, index) =>
        html`<button
          type="button"
          class="menu-item file-option"
          role="option"
          tabindex="-1"
          id=${`file-option-${index}`}
          aria-selected=${String(index === active)}
          ?disabled=${!insertable(path)}
          @click=${() => choose(index)}
        >
          ${path}
        </button>`,
    )}${status
      ? html`<div class="menu-note" role="status">${status}</div>`
      : ""}`,
    menu,
  );
  menu.hidden = false;
  menu
    .querySelector('[aria-selected="true"]')
    ?.scrollIntoView({ block: "nearest" });
}
function choose(index: number) {
  const current = token();
  const path = paths[index];
  if (
    !current ||
    !path ||
    !insertable(path) ||
    queryKey !== `${state.selectedId}:${current.query}`
  )
    return close();
  const fence = "`".repeat(
    Math.max(0, ...(path.match(/`+/g) || []).map((run) => run.length)) + 1,
  );
  const quoted =
    path.startsWith("`") || path.endsWith("`") ? ` ${path} ` : path;
  const text = `${fence}${quoted}${fence} `;
  if (
    inputEl.value.length - (current.end - current.start) + text.length >
    inputEl.maxLength
  ) {
    paths = [];
    paint("The message is too long to add this path.");
    return;
  }
  inputEl.setRangeText(text, current.start, current.end, "end");
  close();
  inputEl.focus();
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
}
function refresh() {
  const current = token();
  if (document.activeElement !== inputEl || !current) return close();
  const cid = state.selectedId;
  const key = `${cid}:${current.query}`;
  if (key === queryKey && composerAutocompleteIs(id)) return;
  if (owner !== cid || !current.query) close();
  clearTimeout(timer);
  pending?.abort();
  queryKey = key;
  owner = cid;
  if (!cid || cid === DRAFT)
    return paint("Send a message before finding files.");
  if (!current.query) return paint("Type a filename.");
  if (menu.hidden) paint();
  const sequence = results.next();
  const controller = new AbortController();
  pending = controller;
  timer = setTimeout(async () => {
    try {
      const { response, data } = await backendFor(cid).apiJson<{
        results: string[];
      }>(
        `/api/conversations/${encodeURIComponent(parseConversationId(cid).cid)}/tree/search?q=${encodeURIComponent(current.query)}`,
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        queryKey !== key ||
        state.selectedId !== cid
      )
        return;
      if (!response.ok || !data) throw Error("file search failed");
      if (!results.accept(sequence)) return;
      const selected = paths[active];
      paths = data.results.slice(0, 50);
      const retained = paths.findIndex(
        (path) => path === selected && insertable(path),
      );
      active =
        retained >= 0 ? retained : Math.max(0, paths.findIndex(insertable));
      paint(paths.length ? "" : "No matching files.");
    } catch {
      if (
        !controller.signal.aborted &&
        queryKey === key &&
        state.selectedId === cid &&
        results.accept(sequence)
      )
        paint("Could not find files. Edit the query to try again.");
    }
  }, 150);
}
inputEl.addEventListener("keydown", (event) => {
  if (
    !composerAutocompleteIs(id) ||
    event.isComposing ||
    event.keyCode === 229 ||
    !owns(event.key, event.shiftKey)
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") return close();
  if (event.key === "Tab" || event.key === "Enter") return choose(active);
  const direction = event.key === "ArrowDown" ? 1 : -1;
  do {
    active = (active + direction + paths.length) % paths.length;
  } while (!insertable(paths[active]!));
  paint();
});
for (const event of ["input", "click", "focus", "select"])
  inputEl.addEventListener(event, refresh);
inputEl.addEventListener("keyup", (event) => {
  if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
      event.key,
    )
  )
    refresh();
});
inputEl.addEventListener("compositionstart", () => {
  composing = true;
  close();
});
inputEl.addEventListener("compositionend", () => {
  composing = false;
  refresh();
});
inputEl.addEventListener("blur", () =>
  setTimeout(() => {
    if (!pointer && document.activeElement !== inputEl) close();
  }, 0),
);
menu.addEventListener("pointerdown", (event) => {
  pointer = true;
  if (event.pointerType === "mouse") event.preventDefault();
});
for (const event of ["pointerup", "pointercancel"])
  menu.addEventListener(event, () =>
    setTimeout(() => {
      pointer = false;
    }, 0),
  );
document.addEventListener("pointerdown", (event) => {
  if (event.target !== inputEl && !menu.contains(event.target as Node)) close();
});
document.addEventListener("recurse:composer-state-restored", close);
