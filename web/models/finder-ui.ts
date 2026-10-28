// Settings model combobox picks explicitly; highlights never save accidentally.
// Escape/Tab/leave restore the chosen name; the inline list stays above phone
// keyboards rather than floating behind them.
import {
  contextLabel,
  modelBoxKeyAction,
  searchModels,
  type FinderModel,
  type IndexedModel,
} from "./finder.js";

let boxes = 0;

export interface ModelBox {
  element: HTMLElement;
  input: HTMLInputElement;
  /** The chosen model id: the stored one until the user picks another. */
  value(): string;
}

export function createModelBox(options: {
  label: string;
  index: readonly IndexedModel[];
  value: string;
  /** The text shown for the chosen id (its name, or the id when unlisted). */
  nameOf(id: string): string;
  onPick(model: FinderModel): void;
}): ModelBox {
  const n = ++boxes;
  let value = options.value;
  let open = false;
  let matches: FinderModel[] = [];
  let active = -1;

  const element = document.createElement("div");
  element.className = "model-box";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "model-box-input";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", options.label);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  const list = document.createElement("div");
  list.className = "model-box-list";
  list.id = `model-box-list-${n}`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", options.label);
  list.hidden = true;
  input.setAttribute("aria-controls", list.id);
  const note = document.createElement("div");
  note.className = "model-box-note";
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  note.hidden = true;
  element.append(input, list, note);

  const showValue = () => {
    input.value = options.nameOf(value);
    input.title = value;
  };
  showValue();

  const paintActive = () => {
    for (const [i, row] of [...list.children].entries()) {
      if (
        !(row instanceof HTMLElement) ||
        row.getAttribute("role") !== "option"
      )
        continue;
      const on = i === active;
      row.setAttribute("aria-selected", on ? "true" : "false");
      row.classList.toggle("active", on);
      if (on) {
        input.setAttribute("aria-activedescendant", row.id);
        row.scrollIntoView?.({ block: "nearest" });
      }
    }
    if (active < 0) input.removeAttribute("aria-activedescendant");
  };

  const render = (query: string) => {
    const found = searchModels(options.index, query);
    matches = found.models;
    list.textContent = "";
    matches.forEach((model, i) => {
      const row = document.createElement("div");
      row.className = "model-box-option";
      row.id = `${list.id}-${i}`;
      row.setAttribute("role", "option");
      row.dataset.id = model.id;
      const name = document.createElement("span");
      name.className = "model-box-name";
      name.textContent = model.label;
      const route = document.createElement("span");
      route.className = "model-box-route";
      route.textContent = model.route;
      const id = document.createElement("code");
      id.className = "model-box-id";
      id.textContent = model.id;
      const context = document.createElement("span");
      context.className = "model-box-context";
      context.textContent = contextLabel(model.context_window);
      row.append(name, route, id, context);
      list.append(row);
    });
    note.textContent = !matches.length
      ? "No model matches."
      : found.total > matches.length
        ? `${found.total - matches.length} more; type to narrow.`
        : "";
    note.hidden = !note.textContent;
    active = matches.length ? 0 : -1;
    paintActive();
  };

  const openList = (query: string) => {
    render(query);
    if (query === "") {
      const chosen = matches.findIndex((model) => model.id === value);
      if (chosen >= 0) active = chosen;
      paintActive();
    }
    open = true;
    list.hidden = matches.length === 0;
    input.setAttribute("aria-expanded", "true");
  };

  const close = () => {
    open = false;
    list.hidden = true;
    note.hidden = true;
    note.textContent = "";
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    showValue();
  };

  const pick = (model: FinderModel) => {
    value = model.id;
    close();
    options.onPick(model);
  };

  input.addEventListener("focus", () => {
    input.placeholder = options.nameOf(value);
    input.value = "";
    openList("");
  });
  input.addEventListener("input", () => openList(input.value));
  input.addEventListener("keydown", (event) => {
    const action = modelBoxKeyAction(
      open,
      matches.length > 0,
      event.key,
      event.isComposing,
    );
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "open") {
      input.value = "";
      openList("");
    } else if (action === "close") {
      close();
      input.select();
    } else if (action === "next") {
      active = (active + 1) % matches.length;
      paintActive();
    } else if (action === "previous") {
      active = (active - 1 + matches.length) % matches.length;
      paintActive();
    } else if (action === "choose" && matches[active]) pick(matches[active]);
  });
  input.addEventListener("blur", () => {
    if (open) close();
  });
  // Invariant: Keep focus in the box while a row is pressed, so the pick is not
  // lost to the blur that would otherwise restore the chosen name first.
  list.addEventListener("pointerdown", (event) => event.preventDefault());
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[role=option]",
    );
    const model = row && matches.find((entry) => entry.id === row.dataset.id);
    if (model) pick(model);
  });

  return { element, input, value: () => value };
}
