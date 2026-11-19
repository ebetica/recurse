// Settings model combobox picks explicitly; highlights never save accidentally.
// Escape/Tab/leave restore the chosen name; the inline list stays above phone
// keyboards rather than floating behind them. Results are grouped under one
// heading per route and show only model names; a check marks the chosen one.
import {
  MODEL_FINDER_LIMIT,
  modelBoxKeyAction,
  searchModelsByRoute,
  type FinderModel,
  type IndexedModel,
} from "./finder.js";

let boxes = 0;

/** Show which route pays for a model as a chip after a Settings row's value;
 * an empty route removes the chip. */
export function showModelRoute(row: Element, route: string): void {
  let chip = row.querySelector<HTMLElement>(":scope > .model-route");
  if (!route) return chip?.remove();
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "model-route";
    row.querySelector(":scope > .settings-row-value")?.after(chip);
  }
  chip.textContent = route;
}

export interface ModelBox {
  element: HTMLElement;
  input: HTMLInputElement;
  /** The chosen model id: the stored one until the user picks another. */
  value(): string;
  setValue(id: string): void;
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
  const label = document.createElement("label");
  label.className = "model-box-label";
  label.textContent = options.label;
  const input = document.createElement("input");
  input.id = `model-box-input-${n}`;
  label.htmlFor = input.id;
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
  const current = document.createElement("span");
  current.id = `${list.id}-current`;
  current.textContent = "Current model";
  current.hidden = true;
  element.append(label, input, list, note, current);

  const showValue = () => {
    input.value = options.nameOf(value);
    input.title = value;
  };
  showValue();

  const paintActive = () => {
    for (const [i, row] of list
      .querySelectorAll<HTMLElement>("[role=option]")
      .entries()) {
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
    const groups = searchModelsByRoute(
      options.index,
      query,
      MODEL_FINDER_LIMIT,
      value,
    );
    matches = groups.flatMap((group) => group.models);
    list.textContent = "";
    let hidden = 0;
    let rows = 0;
    for (const [g, group] of groups.entries()) {
      hidden += group.total - group.models.length;
      const holder = document.createElement("div");
      holder.className = "model-box-group";
      holder.setAttribute("role", "group");
      if (group.route) {
        const head = document.createElement("div");
        head.className = "model-box-group-head";
        head.setAttribute("role", "presentation");
        const route = document.createElement("span");
        route.id = `${list.id}-route-${g}`;
        route.textContent = group.route;
        const count = document.createElement("span");
        count.className = "model-box-count";
        count.textContent =
          group.total > group.models.length
            ? `${group.models.length} of ${group.total}`
            : String(group.total);
        head.append(route, count);
        holder.append(head);
        holder.setAttribute("aria-labelledby", route.id);
      }
      for (const model of group.models) {
        const row = document.createElement("div");
        row.className = "model-box-option";
        row.id = `${list.id}-${rows++}`;
        row.setAttribute("role", "option");
        row.dataset.id = model.id;
        row.title = model.id;
        const name = document.createElement("span");
        name.className = "model-box-name";
        name.textContent = model.label;
        row.append(name);
        if (model.id === value) {
          row.setAttribute("aria-describedby", current.id);
          const check = document.createElement("span");
          check.className = "model-box-current";
          check.textContent = "✓";
          check.setAttribute("aria-hidden", "true");
          row.append(check);
        }
        holder.append(row);
      }
      list.append(holder);
    }
    note.textContent = !matches.length
      ? "No model matches."
      : hidden
        ? `${hidden} more; type to narrow.`
        : "";
    note.hidden = !note.textContent;
    active = matches.length ? 0 : -1;
    paintActive();
  };

  // Invariant: The list is shown before the active row scrolls into view; a
  // hidden list cannot scroll.
  const openList = (query: string) => {
    open = true;
    list.hidden = false;
    render(query);
    list.hidden = matches.length === 0;
    if (query === "") {
      const chosen = matches.findIndex((model) => model.id === value);
      if (chosen >= 0) active = chosen;
      paintActive();
    }
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

  return {
    element,
    input,
    value: () => value,
    setValue: (id) => {
      value = id;
      close();
    },
  };
}
