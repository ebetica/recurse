// Model settings keep context caching, context limits and the effort levels on
// the selected backend. Each level change saves all levels at once without
// changing the default level.
import { settingsClient, settingsLabel } from "./target.js";
import { settingsDetail } from "./layout.js";
import { buildSafetyReviewRow } from "./safety.js";
import { queueSettingsSave, readAfterSettingsSaves } from "./save-queue.js";
import {
  clampReasoning,
  createModelBox,
  indexModels,
  showModelRoute,
  modelListStatusText,
  reasoningChoices,
  THINKING_ORDER,
  type FinderModel,
  type IndexedModel,
  type ModelBox,
  type ModelListUpdateStatus,
} from "../models/index.js";

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
    <div class="group"><label class="item check"><span><span id="prompt-cache-warming-label">Keep context cached while agents work</span>
      <span class="hint" id="prompt-cache-warming-hint">Before the provider's cache expires, Recurse may resend the last request so the next reply can be faster and cheaper. Resends use tokens.</span></span>
      <input type="checkbox" class="switch" role="switch" data-setting="prompt-cache-warming"
        aria-labelledby="prompt-cache-warming-label" aria-describedby="prompt-cache-warming-hint" disabled></label>
    <label class="item check"><span><span id="idle-compaction-label">Compact long idle conversations before their cache expires</span>
      <span class="hint" id="idle-compaction-hint">Older messages are summarized for the model; the thread keeps them.</span></span>
      <input type="checkbox" class="switch" role="switch" data-setting="idle-compaction"
        aria-labelledby="idle-compaction-label" aria-describedby="idle-compaction-hint" disabled></label></div>
    <div class="idle-compaction-threshold" hidden><div class="group"><label class="item field">
      <span>Compact when the conversation is at least (tokens)</span>
      <input type="number" aria-label="Minimum conversation length for idle compaction (tokens)"
        min="32000" step="1" required disabled></label></div></div>
    <p class="msg"></p>`;
  const msg = body.querySelector<HTMLElement>(".msg")!;
  const thresholdRow = body.querySelector<HTMLElement>(
    ".idle-compaction-threshold",
  )!;
  const threshold = thresholdRow.querySelector<HTMLInputElement>("input")!;
  for (const box of body.querySelectorAll<HTMLInputElement>(
    'input[role="switch"]',
  )) {
    const idle = box.dataset.setting === "idle-compaction";
    const endpoint = `/api/settings/${box.dataset.setting}`;
    let saved: { enabled: boolean; minimum_tokens?: number };
    const apply = (state: typeof saved) => {
      saved = state;
      box.checked = state.enabled;
      if (idle) {
        threshold.value = String(state.minimum_tokens);
        thresholdRow.hidden = !state.enabled;
      }
    };
    api(endpoint)
      .then(async (r) => {
        if (!r.ok) throw new Error(await errDetail(r, "Couldn't load."));
        apply(await r.json());
        box.disabled = false;
        if (idle) threshold.disabled = false;
      })
      .catch(() => {
        msg.textContent = "Couldn't load.";
        msg.className = "msg err";
      });
    const save = async () => {
      if (idle) {
        thresholdRow.hidden = !box.checked;
        if (box.checked && !threshold.reportValidity()) return;
        threshold.disabled = true;
      }
      box.disabled = true;
      try {
        const r = await jpost(endpoint, {
          enabled: box.checked,
          ...(idle
            ? {
                minimum_tokens: box.checked
                  ? threshold.valueAsNumber
                  : saved.minimum_tokens,
              }
            : {}),
        });
        if (!r.ok) throw new Error(await errDetail(r, "Couldn't save."));
        apply(await r.json());
        msg.textContent = "";
      } catch (error) {
        apply(saved);
        msg.textContent =
          error instanceof Error ? error.message : "Couldn't save.";
        msg.className = "msg err";
      } finally {
        box.disabled = false;
        if (idle) threshold.disabled = false;
      }
    };
    box.addEventListener("change", save);
    if (idle) threshold.addEventListener("change", save);
  }
}

export function buildMaximumContextSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  const backend = settingsLabel();
  body.innerHTML = `
    <form novalidate>
      <div class="group"><div class="item context-window-controls">
        <input type="range" aria-label="Maximum context window slider (tokens)"
          min="64000" max="1000000" step="1000" value="400000" disabled>
        <span class="control"><input id="maximum-context-window" type="number"
          name="maximum" aria-label="Maximum context window (tokens)"
          min="64000" max="1000000" step="1" required disabled> tokens</span>
      </div></div>
      <p class="msg"></p>
    </form>`;
  const form = body.querySelector("form")!;
  const input = body.querySelector<HTMLInputElement>('input[type="number"]')!;
  const slider = body.querySelector<HTMLInputElement>('input[type="range"]')!;
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
  let saved: number | null = null;
  let wanted: number | null = null;
  let wantedBy = 0;
  let commit = 0;
  readAfterSettingsSaves(backend, () =>
    api("/api/settings/maximum-context-window"),
  )
    .then(async (r) => {
      if (!r.ok) throw new Error();
      const state = (await r.json()) as { maximum_context_window: number };
      saved = wanted = state.maximum_context_window;
      input.value = String(saved);
      syncSlider();
      input.disabled = slider.disabled = false;
    })
    .catch(() => show("err", "Couldn't load the maximum context window."));
  const persist = async (value: number, id: number) => {
    const fail = (text: string) => {
      if (wantedBy === id) wanted = saved;
      if (id === commit) show("err", text);
    };
    try {
      const r = await jpost("/api/settings/maximum-context-window", {
        maximum_context_window: value,
      });
      if (!r.ok) return fail(await errDetail(r, "Couldn't save."));
      const state = (await r.json()) as { maximum_context_window: number };
      saved = state.maximum_context_window;
      if (wantedBy === id) wanted = saved;
      if (id !== commit) return;
      if (input.valueAsNumber !== value) return show("", "");
      input.value = String(saved);
      syncSlider();
      show("ok", "Saved. Applies when an agent process next starts.");
    } catch {
      fail("Network error. Try again.");
    }
  };
  // Spec: Like the compaction switches, a released slider or a committed
  // number saves at once, in order with this Recurse's other Models saves.
  // Only the latest commit reports, and never over an uncommitted draft. An
  // invalid number shows why and isn't saved.
  const save = () => {
    if (!input.checkValidity()) {
      commit++;
      show("", "");
      input.reportValidity();
      return;
    }
    const value = input.valueAsNumber;
    if (value === wanted) return;
    const id = ++commit;
    wanted = value;
    wantedBy = id;
    show("", "Saving…");
    void queueSettingsSave(backend, () => persist(value, id));
  };
  input.addEventListener("change", save);
  slider.addEventListener("change", save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
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
  detail: ReturnType<typeof settingsDetail>;
  /** The reasoning the slider has chosen. */
  reasoning(): string;
}

/** Pi's order for a reasoning level; unknown names sort last. */
const thinkingRank = (level: string) => {
  const at = (THINKING_ORDER as readonly string[]).indexOf(level);
  return at < 0 ? THINKING_ORDER.length : at;
};

// Each level is one row: a button naming the model and the route that pays for
// it (it opens the model finder), then a reasoning slider. Every change saves
// at once, sending all five levels.
export function buildLadderSection(body: HTMLElement): void {
  const { api, jpost } = settingsClient();
  const backend = settingsLabel();
  body.innerHTML = `
    <p class="hint efforts-intro"></p>
    <div class="efforts group"></div>
    <p class="msg" role="status"></p>
    <div class="actions efforts-failed" hidden>
      <button type="button" class="secondary efforts-discard">Discard changes</button>
      <button type="button" class="primary efforts-retry">Retry</button>
    </div>
    <div class="model-list-update">
      <button type="button" class="settings-row model-list-update-button">
        <span class="settings-row-label">Update model list</span>
        <span class="settings-row-value model-list-status" role="status"></span>
      </button>
    </div>`;
  const list = body.querySelector<HTMLElement>(".efforts")!;
  const intro = body.querySelector<HTMLElement>(".efforts-intro")!;
  const msg = body.querySelector<HTMLElement>(":scope > .msg")!;
  const failed = body.querySelector<HTMLElement>(".efforts-failed")!;
  const listStatus = body.querySelector<HTMLElement>(".model-list-status")!;
  const updateButton = body.querySelector<HTMLButtonElement>(
    ".model-list-update-button",
  )!;
  const safety = document.createElement("div");
  list.append(safety);
  buildSafetyReviewRow(safety);
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

  // Invariant: `dirty` holds the levels edited since the server last
  // confirmed them. After a failed save the rows keep those edits, also across
  // reloads (which take every other level from the server), until a save
  // succeeds or the user discards them.
  const dirty = new Set<number>();
  let shown: { ladder: LadderState; index: IndexedModel[] } | null = null;
  const rowValues = () => {
    const levels: LadderState["levels"] = {};
    for (const row of rows)
      levels[String(row.level)] = {
        model: row.box.value(),
        reasoning: row.reasoning(),
      };
    return levels;
  };
  const saveNow = async () => {
    const levels = rowValues();
    const sent = [...dirty];
    failed.hidden = true;
    show("", "Saving…");
    const fail = (text: string) => {
      show("err", text);
      failed.hidden = false;
    };
    try {
      // Invariant: The rows edit models and reasoning only; the instance
      // default level rides the save untouched so it is never reset.
      const r = await jpost("/api/settings/effort-levels", {
        levels,
        default_level: defaultLevel,
      });
      if (!r.ok) return fail(await errDetail(r, "Couldn't save."));
      if (shown) shown.ladder.levels = levels;
      const now = rowValues();
      for (const level of sent)
        if (
          JSON.stringify(now[String(level)]) ===
          JSON.stringify(levels[String(level)])
        )
          dirty.delete(level);
      window.dispatchEvent(new Event("recurse-ladder-changed"));
      show(
        "ok",
        "Saved. Applies to new agents and agents whose level is chosen again.",
      );
    } catch {
      fail("Network error. Try again.");
    }
  };
  // Invariant: Each save sends every level as the rows show them then, so the
  // last save holds the last change; loads wait for queued saves.
  const save = () => queueSettingsSave(backend, saveNow);

  const buildRow = (
    index: readonly IndexedModel[],
    level: number,
    entry: { model: string; reasoning: string },
    info: LadderState["reachability"][string] | undefined,
  ): LadderRow => {
    const element = document.createElement("div");
    element.className = "row effort";
    const picker = document.createElement("div");
    picker.className = "effort-model";
    const reasoning = document.createElement("div");
    reasoning.className = "effort-reasoning";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.step = "1";
    slider.setAttribute("aria-label", `Reasoning for level ${level}`);
    const shown = document.createElement("span");
    shown.className = "effort-reasoning-value";
    shown.setAttribute("aria-hidden", "true");
    const caption = document.createElement("span");
    caption.className = "effort-reasoning-label";
    caption.textContent = "Reasoning";
    caption.setAttribute("aria-hidden", "true");
    reasoning.append(caption, slider, shown);
    const warning = document.createElement("p");
    warning.className = "hint effort-warning";
    let model = entry.model;
    let unreachable: HTMLElement | undefined;
    let choices: string[] = [];
    let offered: string[] = [];
    const paint = () => {
      const value = choices[slider.valueAsNumber] ?? "";
      const missing = !offered.includes(value);
      shown.textContent = value;
      slider.setAttribute(
        "aria-valuetext",
        missing ? `${value}, not offered for this model` : value,
      );
      warning.textContent = missing
        ? `${value} is not offered for this model.`
        : "";
      warning.hidden = !missing;
    };
    // Invariant: A stored level Pi does not offer for this model stays on the
    // slider, marked, so saving another row keeps what this one stores.
    const setReasoning = (model: string, selected: string) => {
      offered = reasoningChoices(known.get(model)?.reasoning_levels, allLevels);
      choices = offered.includes(selected)
        ? offered
        : [...offered, selected].sort(
            (a, b) => thinkingRank(a) - thinkingRank(b),
          );
      slider.max = String(choices.length - 1);
      slider.value = String(choices.indexOf(selected));
      slider.disabled = choices.length < 2;
      paint();
    };
    const box = createModelBox({
      label: `Model for level ${level}`,
      index,
      value: entry.model,
      nameOf,
      onPick: (picked) => {
        detail.close();
        if (picked.id === model) return;
        model = picked.id;
        unreachable?.remove();
        setReasoning(
          picked.id,
          clampReasoning(
            reasoningChoices(picked.reasoning_levels, allLevels),
            choices[slider.valueAsNumber] ?? "",
          ),
        );
        detail.refresh();
        showModelRoute(button, picked.route);
        dirty.add(level);
        void save();
      },
    });
    box.input.autofocus = true;
    picker.append(box.element);
    const detail = settingsDetail(
      picker,
      `Level ${level}`,
      () => nameOf(box.value()),
      { alwaysSheet: true },
    );
    const button = picker.querySelector(":scope > .settings-row")!;
    showModelRoute(button, known.get(entry.model)?.route ?? "");
    setReasoning(entry.model, entry.reasoning);
    slider.addEventListener("input", paint);
    slider.addEventListener("change", () => {
      dirty.add(level);
      void save();
    });
    element.append(picker, reasoning, warning);
    if (level === 1) {
      const note = document.createElement("p");
      note.className = "hint effort-note";
      note.textContent =
        "Used for conversation names and, by default, safety review; choose an inexpensive model such as Luna or Haiku.";
      element.append(note);
    }
    if (info && !info.reachable) {
      unreachable = document.createElement("p");
      unreachable.className = "hint effort-warning";
      unreachable.textContent = info.reason;
      element.append(unreachable);
    }
    list.insertBefore(element, safety);
    return {
      level,
      box,
      detail,
      reasoning: () => choices[slider.valueAsNumber] ?? entry.reasoning,
    };
  };
  // Invariant: Only the newest load renders, so an older reply cannot replace
  // it.
  let loads = 0;
  const loadLadder = async (): Promise<void> => {
    const load = ++loads;
    try {
      const { ladder, listed } = await readAfterSettingsSaves(
        backend,
        async () => {
          const [ladderResponse, listResponse] = await Promise.all([
            api("/api/settings/effort-levels"),
            api("/api/settings/model-list").catch(() => null),
          ]);
          return {
            ladder: (await ladderResponse.json()) as LadderState,
            listed: listResponse?.ok
              ? ((await listResponse.json()) as ModelListState)
              : null,
          };
        },
      );
      if (load !== loads) return;
      if (!listed && !dirty.size)
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
      defaultLevel = ladder.default_level;
      intro.textContent = `Each level is a model and how much it reasons. New agents start at level ${defaultLevel}.`;
      shown = { ladder, index: indexModels(models) };
      renderRows();
    } catch {
      if (!dirty.size) show("err", "Couldn't load the effort levels.");
    }
  };
  // Invariant: Rebuilt rows take the last load, except edited levels.
  const renderRows = () => {
    if (!shown) return;
    const edited = rowValues();
    const open = rows.find(
      (row) => row.box.input === document.activeElement,
    )?.level;
    for (const row of rows) row.detail.close();
    for (const element of list.querySelectorAll(":scope > .row.effort"))
      element.remove();
    rows = [];
    for (let level = 1; level <= 5; level++) {
      const key = String(level);
      const entry = dirty.has(level) ? edited[key] : shown.ladder.levels[key];
      if (!entry) continue;
      rows.push(
        buildRow(shown.index, level, entry, shown.ladder.reachability[key]),
      );
    }
    const reopened = rows.find((row) => row.level === open);
    if (reopened) {
      reopened.detail.open();
      reopened.box.input.focus();
    }
  };
  void loadLadder();
  failed
    .querySelector(".efforts-retry")!
    .addEventListener("click", () => void save());
  failed.querySelector(".efforts-discard")!.addEventListener("click", () => {
    dirty.clear();
    failed.hidden = true;
    show("", "");
    renderRows();
    void loadLadder();
  });
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
}
