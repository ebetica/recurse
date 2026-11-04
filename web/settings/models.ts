// Model settings keep prompt caching, context limits and the
// effort ladder on the selected backend. Picker edits save together
// without changing its default.
import { settingsClient } from "./target.js";
import { settingsDetail } from "./layout.js";
import {
  modelListStatusText,
  type ModelListUpdateStatus,
} from "../models/list-status.js";
import {
  clampReasoning,
  indexModels,
  reasoningChoices,
  THINKING_ORDER,
  type FinderModel,
  type IndexedModel,
} from "../models/finder.js";
import { createModelBox, type ModelBox } from "../models/finder-ui.js";

async function errDetail(r: Response, fallback: string): Promise<string> {
  try {
    return ((await r.json()) as { detail?: string }).detail || fallback;
  } catch {
    return fallback;
  }
}

export function buildPromptCacheSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <div class="group"><label class="item check"><span>Keep prompt cache warm while agents work</span>
      <input type="checkbox" class="switch" role="switch" disabled></label></div>
    <p class="msg"></p>`;
  const box = body.querySelector<HTMLInputElement>("input")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  api("/api/settings/prompt-cache-warming")
    .then(async (r) => {
      if (!r.ok) throw new Error(await errDetail(r, "Couldn't load."));
      box.checked = (await r.json()).enabled;
      box.disabled = false;
    })
    .catch(() => {
      msg.textContent = "Couldn't load.";
      msg.className = "msg err";
    });
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      const r = await jpost("/api/settings/prompt-cache-warming", {
        enabled: box.checked,
      });
      if (!r.ok) throw new Error(await errDetail(r, "Couldn't save."));
      box.checked = (await r.json()).enabled;
      msg.textContent = "";
    } catch (error) {
      box.checked = !box.checked;
      msg.textContent =
        error instanceof Error ? error.message : "Couldn't save.";
      msg.className = "msg err";
    } finally {
      box.disabled = false;
    }
  });
}

export function buildMaximumContextSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <form>
      <div class="group"><div class="item context-window-controls">
        <input type="range" aria-label="Maximum context window slider (tokens)"
          min="64000" max="1000000" step="1000" value="400000">
        <span class="control"><input id="maximum-context-window" type="number"
          name="maximum" aria-label="Maximum context window (tokens)"
          min="64000" max="1000000" step="1" required> tokens</span></div></div>
      <div class="actions"><p class="msg"></p>
        <button type="submit" class="primary">Save</button></div>
    </form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector<HTMLInputElement>('input[type="number"]')!;
  const slider = body.querySelector<HTMLInputElement>('input[type="range"]')!;
  const button = body.querySelector<HTMLButtonElement>("button")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  const detail = settingsDetail(body, "Maximum context window", () =>
    input.value
      ? `${Number(input.value).toLocaleString()} tokens`
      : "Checking…",
  );
  const syncSlider = () => {
    if (!input.validity.valid) return;
    slider.step = input.valueAsNumber % 1000 === 0 ? "1000" : "1";
    slider.value = input.value;
    detail.refresh();
  };
  input.addEventListener("input", syncSlider);
  slider.addEventListener("input", () => {
    input.value = slider.value;
    syncSlider();
  });
  api("/api/settings/maximum-context-window")
    .then((r) => r.json())
    .then((state: { maximum_context_window: number }) => {
      input.value = String(state.maximum_context_window);
      syncSlider();
    })
    .catch(() => show("err", "Couldn't load the maximum context window."));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    show("", "");
    try {
      const r = await jpost("/api/settings/maximum-context-window", {
        maximum_context_window: Number(input.value),
      });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save."));
        return;
      }
      const state = (await r.json()) as { maximum_context_window: number };
      input.value = String(state.maximum_context_window);
      syncSlider();
      show("ok", "Saved. Applies when an agent process next starts.");
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      button.disabled = false;
    }
  });
}

interface LadderModelOption {
  id: string;
  label: string;
}
interface LadderState {
  default_level: number;
  levels: Record<string, { model: string; reasoning: string }>;
  reachability: Record<
    string,
    { reachable: boolean; model: string; reasoning: string; reason: string }
  >;
  models: LadderModelOption[];
  reasoning: string[];
}
interface ModelListState {
  models: FinderModel[];
  reasoning: string[];
}
interface LadderRow {
  level: number;
  box: ModelBox;
  reasoning: HTMLSelectElement;
  /** The user picked a model or reasoning here since the last load. */
  edited: boolean;
  detail: ReturnType<typeof settingsDetail>;
}
export function buildLadderSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  body.innerHTML = `
    <form>
      <div class="model-list-update">
        <button type="button" class="settings-row model-list-update-button">
          <span class="settings-row-label">Update model list</span>
          <span class="settings-row-value model-list-status" role="status"></span>
        </button>
      </div>
      <div class="efforts group"></div>
      <div class="actions"><p class="msg"></p>
        <button type="submit" class="primary">Save</button></div>
    </form>`;
  const form = body.querySelector("form")!;
  const list = body.querySelector<HTMLElement>(".efforts")!;
  const button = body.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const listStatus = body.querySelector<HTMLElement>(".model-list-status")!;
  const updateButton = body.querySelector<HTMLButtonElement>(
    ".model-list-update-button",
  )!;
  settingsDetail(body, "Effort ladder", () => "Levels 1–5");
  const show = (cls: string, text: string) => {
    msg.className = "msg " + cls;
    msg.textContent = text;
  };
  let defaultLevel = 3;
  let rows: LadderRow[] = [];
  let known = new Map<string, FinderModel>();
  let ladderLabels = new Map<string, string>();
  let allLevels: string[] = [...THINKING_ORDER];
  const nameOf = (id: string) =>
    known.get(id)?.label ?? ladderLabels.get(id) ?? id;
  // Invariant: A value Pi does not offer for this model stays selectable,
  // marked, so an untouched row saves what it already stores.
  const fillReasoning = (
    select: HTMLSelectElement,
    model: string,
    selected: string,
  ) => {
    const choices = reasoningChoices(
      known.get(model)?.reasoning_levels,
      allLevels,
    );
    select.textContent = "";
    for (const level of choices) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      select.append(option);
    }
    if (!choices.includes(selected)) {
      const option = document.createElement("option");
      option.value = selected;
      option.textContent = `${selected} (not offered for this model)`;
      select.append(option);
    }
    select.value = selected;
  };
  const render = (
    ladder: LadderState,
    index: readonly IndexedModel[],
    unsaved: Map<number, { model: string; reasoning: string }>,
  ) => {
    // Invariant: The rows edit models and reasoning only; the instance default
    // level rides the save untouched so it is never reset as a side effect.
    defaultLevel = ladder.default_level;
    for (const row of rows) row.detail.close();
    list.textContent = "";
    rows = [];
    for (let level = 1; level <= 5; level++) {
      const entry = ladder.levels[String(level)];
      if (!entry) continue;
      // Invariant: Keep an unsaved edit across a reload after a list update; a
      // row the user did not touch takes the reloaded value.
      const kept = unsaved.get(level);
      const keep =
        kept !== undefined &&
        (known.has(kept.model) || kept.model === entry.model);
      const model = keep ? kept.model : entry.model;
      const info = ladder.reachability[String(level)];
      const row = document.createElement("div");
      row.className = "row effort";
      const reasoning = document.createElement("select");
      reasoning.dataset.level = String(level);
      reasoning.setAttribute("aria-label", `Reasoning for level ${level}`);
      const box = createModelBox({
        label: `Model for level ${level}`,
        index,
        value: model,
        nameOf,
        onPick: (picked) => {
          ladderRow.edited = true;
          fillReasoning(
            reasoning,
            picked.id,
            clampReasoning(
              reasoningChoices(picked.reasoning_levels, allLevels),
              reasoning.value,
            ),
          );
          detail.refresh();
        },
      });
      box.input.autofocus = true;
      fillReasoning(reasoning, model, keep ? kept.reasoning : entry.reasoning);
      row.append(box.element, reasoning);
      if (level === 1) {
        const note = document.createElement("p");
        note.className = "hint effort-note";
        note.textContent =
          "Used for safety review and conversation names; choose an inexpensive model such as Luna or Haiku.";
        row.append(note);
      }
      if (info && !info.reachable) {
        const note = document.createElement("p");
        note.className = "hint";
        note.textContent = info.reason;
        row.append(note);
      }
      list.appendChild(row);
      const detail = settingsDetail(
        row,
        `Level ${level}`,
        () => `${nameOf(box.value())} · ${reasoning.value}`,
      );
      const ladderRow: LadderRow = {
        level,
        box,
        reasoning,
        edited: keep,
        detail,
      };
      reasoning.addEventListener("change", () => {
        ladderRow.edited = true;
        detail.refresh();
      });
      rows.push(ladderRow);
    }
  };
  // Invariant: Only the newest load renders, so an older reply cannot replace
  // it.
  let loads = 0;
  const loadLadder = async () => {
    const load = ++loads;
    try {
      const [ladderResponse, listResponse] = await Promise.all([
        api("/api/settings/effort-levels"),
        api("/api/settings/model-list").catch(() => null),
      ]);
      const ladder = (await ladderResponse.json()) as LadderState;
      let listed: ModelListState | null = null;
      if (listResponse?.ok)
        listed = (await listResponse.json()) as ModelListState;
      if (load !== loads) return;
      if (!listed)
        show(
          "err",
          "Couldn't load the model list. Only the ladder's own models are offered.",
        );
      ladderLabels = new Map(ladder.models.map((m) => [m.id, m.label]));
      allLevels = listed?.reasoning ?? ladder.reasoning;
      const models: FinderModel[] =
        listed?.models ??
        ladder.models.map((m) => ({
          id: m.id,
          label: m.label,
          route: "",
          context_window: null,
          reasoning_levels: null,
        }));
      known = new Map(models.map((m) => [m.id, m]));
      const unsaved = new Map(
        rows
          .filter((row) => row.edited)
          .map((row) => [
            row.level,
            { model: row.box.value(), reasoning: row.reasoning.value },
          ]),
      );
      const focused = rows.find(
        (row) => row.box.input === document.activeElement,
      )?.level;
      render(ladder, indexModels(models), unsaved);
      const focusedRow = rows.find((row) => row.level === focused);
      if (focusedRow) {
        focusedRow.detail.open();
        focusedRow.box.input.focus();
      }
    } catch {
      show("err", "Couldn't load the effort ladder.");
    }
  };
  void loadLadder();
  const showListStatus = (status: ModelListUpdateStatus) => {
    listStatus.textContent = modelListStatusText(status);
    listStatus.classList.toggle("err", Boolean(status.error));
    updateButton.disabled = status.updating;
  };
  const followUpdate = async (status: ModelListUpdateStatus) => {
    showListStatus(status);
    for (let polls = 0; status.updating && polls < 120; polls++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!body.isConnected) return;
      status = await (await api("/api/settings/model-list-update")).json();
      showListStatus(status);
    }
    if (!status.updating) await loadLadder();
  };
  api("/api/settings/model-list-update")
    .then((r) => r.json())
    .then((status: ModelListUpdateStatus) =>
      status.updating ? followUpdate(status) : showListStatus(status),
    )
    .catch(() => (listStatus.textContent = "Couldn't read the model list."));
  updateButton.addEventListener("click", async () => {
    updateButton.disabled = true;
    try {
      const r = await jpost("/api/settings/model-list-update", {});
      if (!r.ok) {
        listStatus.textContent = await errDetail(
          r,
          "Couldn't start the update.",
        );
        updateButton.disabled = false;
        return;
      }
      await followUpdate(await r.json());
    } catch {
      listStatus.textContent = "Network error. Try again.";
      updateButton.disabled = false;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    show("", "");
    const levels: Record<string, { model: string; reasoning: string }> = {};
    for (const row of rows)
      levels[String(row.level)] = {
        model: row.box.value(),
        reasoning: row.reasoning.value,
      };
    try {
      const r = await jpost("/api/settings/effort-levels", {
        levels,
        default_level: defaultLevel,
      });
      if (!r.ok) {
        show("err", await errDetail(r, "Couldn't save."));
        return;
      }
      window.dispatchEvent(new Event("recurse-ladder-changed"));
      show("ok", "Saved. Applies to new turns.");
    } catch {
      show("err", "Network error. Try again.");
    } finally {
      button.disabled = false;
    }
  });
}
