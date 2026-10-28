// Draft effort applies at creation; existing choices persist until next
// message. Running turns keep launched models. Instance ladder maps levels to
// model/ reasoning; unreachable choices explain why, without duplicate
// controls. A remote agent or draft uses that remote's ladder.
import {
  backendFor,
  conversationId,
  parseConversationId,
} from "./backends/backend.js";
import { embeddedFrameHidden, state } from "./state.js";
import { $ } from "./dom.js";
import { api } from "./api.js";
import {
  conversationContextLabel,
  conversationContextSelector,
} from "./context/tokens.js";
import {
  showConversationContext,
  showConversationContextFallback,
} from "./context-viewer.js";
import { effortStepForKey } from "./keymap.js";
import { ContextFallbackGate } from "./context/fallback.js";
import { rowThreads, rowThreadContextKey } from "./row-thread-state.js";
import type { Conversation, PendingModel } from "./types.js";

export const EFFORT_LEVELS = [1, 2, 3, 4, 5] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
// Fallback until the ladder loads: new agents start capable, not expensive.
export const DEFAULT_EFFORT_LEVEL: EffortLevel = 3;

interface LadderEntry {
  model: string;
  reasoning: string;
}

interface LadderModel {
  id: string;
  label: string;
  context_window?: number;
}

interface LadderReachability {
  reachable: boolean;
  model: string;
  reasoning: string;
  reason: string;
}

interface Ladder {
  default_level: number;
  levels: Record<string, LadderEntry>;
  reachability: Record<string, LadderReachability>;
  models: LadderModel[];
}

// Fixed stop labels low through max, independent of configured reasoning.
const EFFORT_STOP_WORDS = ["low", "medium", "high", "xhigh", "max"] as const;

// Progressive picker host preserves controls across mixed shell generations.
const controls = $("#model-controls");
const row = $("#model-row")!;
const compactHome = controls || row.parentElement!;
const trigger = $<HTMLButtonElement>("#model-trigger")!;
const triggerName = $<HTMLElement>("#model-trigger .model-name")!;
const menu = $("#model-menu")!;
const sliderBox = $("#effort-slider")!;
const range = $<HTMLInputElement>("#effort-range")!;
const value = $("#effort-value")!;
const modelLine = $("#effort-model")!;
const currentLine = $("#effort-current");

let mode: "draft" | "conv" = "draft";
let conv: Conversation | null = null;
let ladder: Ladder | null = null;
// Owns `ladder`; switching backends drops it to avoid stale draft defaults.
let ladderLabel = "";
let loadFailed = false;
let retryTimer = 0;
const saving = new Set<string>();
let contextFallbackKey: string | null = null;
const contextFallbackGate = new ContextFallbackGate();
let contextFallback: {
  session: string;
  key: string;
  used: number;
  max: number | null;
} | null = null;

function contextFallbackSession(c: Conversation): string {
  return JSON.stringify([c.id, rowThreadContextKey(c.id)]);
}

function contextFallbackIdentity(c: Conversation): string {
  if (c.backend !== "durable") return c.id;
  return JSON.stringify([
    contextFallbackSession(c),
    rowThreads.get(c.id)?.revision,
  ]);
}

async function fetchContextFallback(
  target: Conversation,
  key: string,
): Promise<void> {
  try {
    const response = await backendFor(target.id).api(
      `/api/conversations/${encodeURIComponent(target.id)}/context-usage`,
      {},
      { availability: "optional", timeoutMs: 10_000 },
    );
    if (!response.ok) return;
    const detail = (await response.json()) as {
      used_tokens?: unknown;
      context_window?: unknown;
    };
    const used = detail.used_tokens;
    const max = detail.context_window;
    if (
      !Number.isSafeInteger(used) ||
      (used as number) < 0 ||
      (max !== null &&
        max !== undefined &&
        (!Number.isSafeInteger(max) || (max as number) <= 0))
    )
      return;
    if (
      contextFallbackKey !== key ||
      mode !== "conv" ||
      conv?.id !== target.id ||
      contextFallbackIdentity(conv) !== key
    )
      return;
    contextFallback = {
      session: contextFallbackSession(target),
      key,
      used: used as number,
      max:
        Number.isSafeInteger(max) && (max as number) > 0
          ? (max as number)
          : null,
    };
    showContextTokens(conv);
  } catch {
  } finally {
    contextFallbackGate.settled(target.id);
    if (mode === "conv" && conv?.id === target.id) showContextTokens(conv);
  }
}

function isLegacyLevel(value: unknown): boolean {
  const level = Number(value);
  return (
    !Number.isInteger(level) ||
    !(EFFORT_LEVELS as readonly number[]).includes(level)
  );
}

function levelOf(value: unknown, fallback: number): EffortLevel {
  const level = Number(value);
  if (
    !Number.isInteger(level) ||
    level < EFFORT_LEVELS[0] ||
    level > EFFORT_LEVELS[EFFORT_LEVELS.length - 1]
  )
    return fallback as EffortLevel;
  return level as EffortLevel;
}

function defaultLevel(): EffortLevel {
  return ladder
    ? levelOf(ladder.default_level, DEFAULT_EFFORT_LEVEL)
    : DEFAULT_EFFORT_LEVEL;
}

function entryFor(level: EffortLevel): LadderEntry | null {
  return ladder?.levels[String(level)] ?? null;
}

function reachabilityFor(level: EffortLevel): LadderReachability | null {
  return ladder?.reachability[String(level)] ?? null;
}

// Unknown legacy model names load once from Settings; labels wait for metadata.
let listed: Map<string, LadderModel> | null = null;
let listRequested = false;
function knownModel(id: string): LadderModel | null {
  const model = ladder?.models.find((m) => m.id === id) ?? listed?.get(id);
  if (!model && id && ladder && !listRequested) {
    listRequested = true;
    void api("/api/settings/model-list")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { models: LadderModel[] } | null) => body?.models ?? [])
      .catch(() => [])
      .then((models) => {
        listed = new Map(models.map((m) => [m.id, m]));
        render();
      });
  }
  return model ?? null;
}

/** A model's display name: null while the ladder (or, for a model outside
 * it, the Settings model list) is loading, then the name, else the raw id. */
function modelLabel(id: string): string | null {
  const model = knownModel(id);
  if (model) return model.label || id;
  return ladder && listed ? id : null;
}

function describeLevel(level: EffortLevel): string {
  const entry = entryFor(level);
  if (!entry) return `Level ${level}`;
  const name = modelLabel(entry.model);
  return name
    ? `Level ${level}: ${name}, reasoning ${entry.reasoning}`
    : `Level ${level}, reasoning ${entry.reasoning}`;
}

function pendingLevel(c: Conversation): EffortLevel | null {
  const pending = c.pending_model;
  if (!pending) return null;
  const direct = Number(pending.level);
  if (
    Number.isInteger(direct) &&
    EFFORT_LEVELS.includes(direct as EffortLevel)
  ) {
    return direct as EffortLevel;
  }
  if (!ladder || typeof pending.model !== "string") return null;
  for (const level of EFFORT_LEVELS) {
    const entry = entryFor(level);
    if (
      entry?.model === pending.model &&
      (pending.effort == null ||
        pending.effort === "default" ||
        entry.reasoning === pending.effort)
    )
      return level;
  }
  return null;
}

function selectedLevel(c: Conversation): EffortLevel {
  return pendingLevel(c) ?? levelOf(c.level, defaultLevel());
}

function pendingForLevel(level: EffortLevel): PendingModel {
  const entry = entryFor(level);
  return {
    model: entry?.model || "",
    effort: entry?.reasoning,
    level,
  };
}

// The committed level for the visible owner, preferring a durable pending
// choice for existing conversations until the next composer message.
function committedLevel(): EffortLevel | null {
  if (mode === "draft") {
    const stored = state.draft?.level;
    if (stored == null && !ladder) return defaultLevel();
    return levelOf(stored, defaultLevel());
  }
  if (!conv) return null;
  return (
    pendingLevel(conv) ??
    (isLegacyLevel(conv.level) ? null : (Number(conv.level) as EffortLevel))
  );
}

// The trigger names the pending model when a switch is waiting for a message.
function paintTrigger(): void {
  let name: string;
  if (mode === "draft" || !conv) {
    const level = committedLevel() ?? defaultLevel();
    const entry = entryFor(level);
    name = `${(entry && modelLabel(entry.model)) || "Effort"} · ${EFFORT_STOP_WORDS[level - EFFORT_LEVELS[0]]}`;
  } else if (conv.pending_model) {
    const pending = conv.pending_model;
    const level = pendingLevel(conv);
    const model = pending.model || (level && entryFor(level)?.model);
    name = (model && modelLabel(model)) || "Effort";
  } else if (isLegacyLevel(conv.level)) {
    const raw = typeof conv.model === "string" ? conv.model : "";
    name = raw ? (modelLabel(raw) ?? "Effort") : "Unknown model";
  } else {
    const entry = entryFor(Number(conv.level) as EffortLevel);
    name = (entry && modelLabel(entry.model)) || "Effort";
  }
  const pending = mode === "conv" && !!conv?.pending_model;
  trigger.classList.toggle("pending", pending);
  trigger.title = pending
    ? "Switches on your next message"
    : "Choose effort level (e or Shift+M)";
  triggerName.textContent = name;
  trigger.setAttribute(
    "aria-label",
    `${name}: ${pending ? "switches on your next message; " : ""}choose effort level`,
  );
}

// Preview the slider's current stop: the fixed word for the stop beside the
// slider, the stop's "model reasoning" on the bottom line, and the orange
// fill behind the thumb. A null committed level (legacy, nothing picked yet)
// renders a neutral track with an empty word until the first drag.
function syncPreview(): void {
  const stop = levelOf(range.value, NaN as unknown as number);
  const at = EFFORT_LEVELS.includes(stop as EffortLevel)
    ? (stop as EffortLevel)
    : defaultLevel();
  const entry = entryFor(at);
  const legacyUnpicked =
    mode === "conv" &&
    conv &&
    isLegacyLevel(conv.level) &&
    sliderBox.classList.contains("legacy");
  const legacyReasoning =
    legacyUnpicked && typeof conv?.effort === "string" && conv.effort
      ? conv.effort
      : null;
  value.textContent = legacyUnpicked
    ? ""
    : EFFORT_STOP_WORDS[at - EFFORT_LEVELS[0]];
  range.setAttribute(
    "aria-valuetext",
    legacyReasoning
      ? `${modelLabel(typeof conv?.model === "string" ? conv.model : "") ?? "Model loading"}, reasoning ${legacyReasoning}`
      : describeLevel(at),
  );
  range.style.setProperty(
    "--fill",
    `${((at - EFFORT_LEVELS[0]) / (EFFORT_LEVELS[EFFORT_LEVELS.length - 1] - EFFORT_LEVELS[0])) * 100}%`,
  );
  const info = reachabilityFor(at);
  range.title = info && !info.reachable ? info.reason : "";
  if (!ladder) {
    modelLine.textContent = loadFailed
      ? "Effort ladder unavailable. New agents start at level 3; retrying…"
      : "Loading effort ladder…";
    return;
  }
  // Invariant: Legacy choices stay on their stored model until the first drag.
  // That drag previews ladder stops, never silently remaps an untouched choice.
  if (legacyUnpicked) {
    const rawModel =
      typeof conv?.model === "string" ? (conv.model as string) : "";
    const model = rawModel ? modelLabel(rawModel) : "Unknown model";
    modelLine.textContent = !model
      ? "Loading model name…"
      : legacyReasoning
        ? `${model} ${legacyReasoning}`
        : model;
    return;
  }
  const name = entry && modelLabel(entry.model);
  modelLine.textContent = !entry
    ? ""
    : name
      ? `${name} ${entry.reasoning}`
      : "Loading model name…";
}

// Paint the slider at the committed level (or the default with a neutral
// track for a legacy conversation), disabled while a switch is in flight or
// a turn owns the model.
function paintSlider(disabled: boolean): void {
  const current = committedLevel();
  const at = current ?? defaultLevel();
  range.value = String(at);
  range.disabled = disabled;
  sliderBox.classList.toggle("legacy", current === null);
  if (currentLine) {
    currentLine.hidden = mode !== "conv" || !conv?.pending_model;
    if (!currentLine.hidden && conv) {
      const model =
        typeof conv.model === "string" && conv.model
          ? (modelLabel(conv.model) ?? "…")
          : "Unknown model";
      currentLine.textContent = `Current: ${model}${conv.effort ? ` · ${conv.effort}` : ""}`;
    }
  }
  syncPreview();
}

function showContextTokens(c: Conversation | null): void {
  const label = c?.backend === "durable" ? null : conversationContextLabel(c);
  const selectedModel = c?.model;
  const contextWindow =
    conversationContextSelector(c) === selectedModel
      ? (knownModel(selectedModel ?? "")?.context_window ?? null)
      : null;
  if (c && label === null) {
    const key = contextFallbackIdentity(c);
    if (contextFallback?.session === contextFallbackSession(c)) {
      showConversationContextFallback(
        c,
        contextFallback.used,
        contextFallback.max,
      );
      if (contextFallback.key === key) return;
    } else {
      showConversationContext(c, null, null);
    }
    if (contextFallbackGate.request(key, c.id)) {
      contextFallbackKey = key;
      void fetchContextFallback(c, key);
    }
    return;
  }
  contextFallbackGate.reset();
  contextFallbackKey = null;
  contextFallback = null;
  showConversationContext(
    c,
    label,
    Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0
      ? (contextWindow as number)
      : null,
  );
}

function render(): void {
  if (mode === "draft") {
    const draft = state.draft;
    if (!draft) {
      hideModel();
      return;
    }
    const stored = draft.level;
    const level = levelOf(stored, defaultLevel());
    // Invariant: Display the default but never stamp it: an untouched draft
    // sends no level, so its backend applies its own current default.
    if (stored != null) draft.level = level;
    paintTrigger();
    paintSlider(false);
    showContextTokens(null);
    return;
  }
  if (conv) {
    // Invariant: Pending choices replace the displayed level while remaining
    // durable until the next composer message is admitted.
    const busy = saving.has(conv.id);
    paintTrigger();
    paintSlider(busy);
    showContextTokens(conv);
  }
}

// Fetch the instance ladder (levels, default, reachability). Retries in the
// background on failure; the control falls back to the default level meanwhile.
async function fetchLadder(): Promise<void> {
  clearTimeout(retryTimer);
  const label = ladderLabel;
  try {
    const response = await backendFor(conversationId(label, "ladder")).api(
      "/api/settings/effort-levels",
    );
    if (!response.ok) throw new Error("ladder unavailable");
    const loaded = (await response.json()) as Ladder;
    if (label !== ladderLabel) return;
    ladder = loaded;
    loadFailed = false;
    render();
  } catch {
    if (label !== ladderLabel) return;
    loadFailed = true;
    render();
    retryTimer = setTimeout(() => {
      if (!embeddedFrameHidden()) void fetchLadder();
    }, 3000) as unknown as number;
  }
}

// Point the control at one backend's ladder before painting its owner.
function useLadderOf(label: string): void {
  if (label === ladderLabel) return;
  ladderLabel = label;
  ladder = null;
  loadFailed = false;
}

export function showDraftModel(initial?: number | null): void {
  const draft = state.draft;
  if (!draft) {
    hideModel();
    return;
  }
  const alreadyInline = draftInline();
  menu.hidePopover();
  if (!alreadyInline) {
    menu.classList.remove("draft-open");
    trigger.setAttribute("aria-expanded", "false");
  }
  menu.style.left = "";
  menu.style.top = "";
  menu.style.bottom = "";
  menu.style.maxHeight = "";
  const host = document.querySelector<HTMLElement>("#draft-model-host");
  if (host) {
    controls?.classList.remove("on");
    host.appendChild(row);
  } else {
    // Invariant: Mixed-generation shells retain one usable legacy-host control
    // when the central host is absent, never hide it.
    compactHome.appendChild(row);
    controls?.classList.add("on");
  }
  row.classList.add("on");
  showContextTokens(null);
  mode = "draft";
  conv = null;
  useLadderOf(draft.backendLabel ?? "");
  if (initial != null && (draft.level == null || draft.level !== initial)) {
    draft.level = levelOf(initial, defaultLevel());
  }
  render();
  void fetchLadder();
}

// No conversation is loaded (a draft, or an agent still being read): show no
// effort or context metadata rather than the last agent's values.
export function hideModel(): void {
  menu.hidePopover();
  menu.classList.remove("draft-open");
  trigger.setAttribute("aria-expanded", "false");
  mode = "conv";
  conv = null;
  showContextTokens(null);
  compactHome.appendChild(row);
  controls?.classList.remove("on");
  row.classList.remove("on");
}

export function showConversationModel(c: Conversation | null): void {
  if (conv?.id !== c?.id) menu.hidePopover();
  menu.classList.remove("draft-open");
  trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open")));
  const show = !!c;
  if (row.parentElement !== compactHome) compactHome.appendChild(row);
  controls?.classList.toggle("on", show);
  row.classList.toggle("on", show);
  showContextTokens(show ? c : null);
  mode = "conv";
  conv = c || null;
  if (c) useLadderOf(parseConversationId(c.id).label);
  render();
  if (show && !ladder) void fetchLadder();
}

// The new-agent page reveals the slider box inline under its trigger. True only
// while the shared row sits in the draft host; the mixed-generation fallback
// (no host) keeps popover behaviour in the composer footer.
function draftInline(): boolean {
  return mode === "draft" && row.parentElement?.id === "draft-model-host";
}

function pickerOpen(): boolean {
  return draftInline()
    ? menu.classList.contains("draft-open")
    : menu.matches(":popover-open");
}

function closeDraftMenu(): void {
  menu.classList.remove("draft-open");
  trigger.setAttribute("aria-expanded", "false");
  render();
}

export function openEffortMenu(): void {
  if (!row.classList.contains("on")) return;
  // Invariant: The ladder file may have changed out-of-band (a direct file edit
  // dispatches no event): revalidate on every open and repaint when the load
  // lands, so the box and the trigger text track the file.
  void fetchLadder();
  if (draftInline()) {
    menu.classList.add("draft-open");
    trigger.setAttribute("aria-expanded", "true");
    menu.focus();
    return;
  }
  if (!menu.matches(":popover-open")) {
    render();
    menu.showPopover();
  }
  menu.focus();
}

trigger.addEventListener("click", (event) => {
  if (!draftInline()) return;
  event.preventDefault();
  if (pickerOpen()) {
    closeDraftMenu();
    trigger.focus();
  } else {
    openEffortMenu();
  }
});

menu.addEventListener("toggle", () => {
  const open = menu.matches(":popover-open");
  trigger.setAttribute("aria-expanded", String(open));
  if (!open) {
    if (mode === "draft" || conv) render();
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const above = mode === "conv" || rect.top > innerHeight / 2;
  menu.style.maxHeight = `${Math.max(100, (above ? rect.top : innerHeight - rect.bottom) - 20)}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.left + rect.width / 2 - menu.offsetWidth / 2, innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = above ? "auto" : `${rect.bottom + 8}px`;
  menu.style.bottom = above ? `${innerHeight - rect.top + 8}px` : "auto";
  menu.focus();
});

menu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (draftInline()) closeDraftMenu();
    else menu.hidePopover();
    trigger.focus();
    return;
  }
  if (
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return;
  const step = effortStepForKey(
    event.key,
    pickerOpen(),
    event.target === range,
  );
  if (!step) return;
  event.preventDefault();
  event.stopPropagation();
  if (range.disabled) return;
  const before = range.value;
  if (step > 0) range.stepUp();
  else range.stepDown();
  if (range.value === before) return;
  range.dispatchEvent(new Event("input", { bubbles: true }));
  range.dispatchEvent(new Event("change", { bubbles: true }));
});

range.addEventListener("input", () => {
  if (range.disabled) return;
  sliderBox.classList.remove("legacy");
  syncPreview();
});

range.addEventListener("change", async () => {
  if (range.disabled) {
    render();
    return;
  }
  const level = levelOf(range.value, NaN as unknown as number);
  if (!EFFORT_LEVELS.includes(level as EffortLevel)) {
    render();
    return;
  }
  if (mode === "draft") {
    if (state.draft && !state.draft.creator)
      state.draft.level = level as EffortLevel;
    render();
    return;
  }
  if (!conv || saving.has(conv.id)) {
    render();
    return;
  }
  const target = conv;
  const previousPending = target.pending_model
    ? { ...target.pending_model }
    : null;
  const previousRaw = target.level;
  const previous = selectedLevel(target);
  if (level === previous && !isLegacyLevel(previousRaw)) {
    render();
    return;
  }
  // Invariant: Paint the choice immediately. The stored level remains untouched
  // until a composer message is admitted; the pending value also survives a
  // refresh.
  const optimistic = pendingForLevel(level as EffortLevel);
  target.pending_model = optimistic;
  if (state.currentConv?.id === target.id) {
    state.currentConv.pending_model = optimistic;
  }
  saving.add(target.id);
  render();
  try {
    const r = await backendFor(target.id).jpost(
      "/api/conversations/" + target.id + "/model",
      {
        level,
      },
    );
    if (!r.ok) throw new Error(await r.text().catch(() => "switch failed"));
    const data = (await r.json()) as {
      model?: string;
      effort?: string;
      level?: number | null;
      pending_model?: PendingModel;
    };
    const accepted = data.pending_model || {
      model: data.model || optimistic.model,
      effort: data.effort,
      level: data.level ?? level,
    };
    target.pending_model = accepted;
    if (state.currentConv?.id === target.id) {
      state.currentConv.pending_model = accepted;
    }
  } catch {
    target.pending_model = previousPending;
    if (state.currentConv?.id === target.id) {
      state.currentConv.pending_model = previousPending;
    }
  } finally {
    saving.delete(target.id);
    // Invariant: The global control may now belong to another agent. Repaint
    // only when it still shows the switch target.
    if (mode === "conv" && conv === target) render();
  }
});

window.addEventListener("online", () => fetchLadder());
window.addEventListener("recurse-auth-changed", () => {
  ladder = null;
  loadFailed = false;
  render();
  void fetchLadder();
});
window.addEventListener("recurse-ladder-changed", () => {
  ladder = null;
  loadFailed = false;
  render();
  void fetchLadder();
});
// Revalidates every 10s; skips hidden tabs and active/focused previews.
const LADDER_REFRESH_MS = 10_000;
setInterval(() => {
  if (document.hidden || embeddedFrameHidden()) return;
  if (document.activeElement === range) return;
  if (menu.matches(":popover-open")) return;
  void fetchLadder();
}, LADDER_REFRESH_MS);
fetchLadder();
