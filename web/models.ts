// Draft effort applies on creation; existing choices wait for the next turn.
// The composer's chip shows the recorded or pending choice; the popup previews it.
// Unreachable choices explain why, without duplicate controls.
// Context reuses tree usage for loaded history; pending Clear stays blank.
import { backendFor } from "./backends/backend.js";
import {
  conversationId,
  parseConversationId,
} from "./backends/conversation-id/index.js";
import { embeddedFrameHidden, state } from "./state.js";
import { $, el, phoneComposerFocused } from "./dom.js";
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
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  EFFORT_MIN_LEVEL,
  EFFORT_MAX_LEVEL,
  LEGACY_EFFORT_MAX_LEVEL,
  isEffortLevel,
} from "../src/effort_levels.js";
import {
  rowThreads,
  rowThreadContextKey,
  rowThreadClearPending,
} from "./row-thread-state/index.js";
import type { Conversation, PendingModel } from "./types.js";

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

// Progressive picker host preserves controls across mixed shell generations.
const controls = $("#model-controls");
const row = $("#model-row")!;
const compactHome = controls || row.parentElement!;
const trigger = $<HTMLButtonElement>("#model-trigger")!;
const triggerName = $<HTMLElement>("#model-trigger .model-name")!;
const triggerCaret = trigger.querySelector("svg");
const triggerReasoning = el("span", "effort-reasoning-text");
triggerName.after(triggerReasoning);
const menu = $("#model-menu")!;
const sliderBox = $("#effort-slider")!;
const stops = el("div", "effort-stops");
stops.setAttribute("aria-hidden", "true");
sliderBox.prepend(stops);
const range = $<HTMLInputElement>("#effort-range")!;
range.min = String(EFFORT_MIN_LEVEL);
const modelLine = $("#effort-model")!;
const modelLineName = el("span");
const modelLineReasoning = el("span", "effort-reasoning-text");
modelLine.append(modelLineName, modelLineReasoning);
const modelStatus = el("span", "sr-only");
modelStatus.setAttribute("role", "status");
modelLine.setAttribute("aria-hidden", "true");
modelLine.removeAttribute("role");
modelLine.removeAttribute("aria-live");
modelLine.after(modelStatus);

let mode: "draft" | "conv" = "draft";
let conv: Conversation | null = null;
let previewLevel: number | null = null;
let sliderMaximum = 0;
let touchStart: { pointerId: number; value: string } | null = null;
let ladder: Ladder | null = null;
// Owns `ladder`; switching backends drops it to avoid stale draft defaults.
let ladderLabel = "";
let loadFailed = false;
let retryTimer = 0;
const saving = new Map<string, PendingModel>();
let contextFallbackKey: string | null = null;
const contextFallbackGate = new ContextFallbackGate();
/** Latest fallback reading per session; Durable keys carry the row revision. */
const contextFallbacks = new Map<
  string,
  { key: string; used: number; max: number | null }
>();

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
    const session = contextFallbackSession(target);
    contextFallbacks.delete(session);
    contextFallbacks.set(session, {
      key,
      used: used as number,
      max:
        Number.isSafeInteger(max) && (max as number) > 0
          ? (max as number)
          : null,
    });
    if (contextFallbacks.size > 64)
      contextFallbacks.delete(contextFallbacks.keys().next().value!);
    showContextTokens(conv);
  } catch {
  } finally {
    contextFallbackGate.settled(target.id);
    if (mode === "conv" && conv?.id === target.id) showContextTokens(conv);
  }
}

function maximumLevel(): number {
  return (
    EFFORT_LEVELS.findLast((level) => entryFor(level)) ??
    (ladderLabel ? LEGACY_EFFORT_MAX_LEVEL : EFFORT_MAX_LEVEL)
  );
}

function levelOf(value: unknown, fallback: number): number {
  const level = Number(value);
  return isEffortLevel(level) && level <= maximumLevel() ? level : fallback;
}

function defaultLevel(): number {
  return ladder
    ? levelOf(ladder.default_level, DEFAULT_EFFORT_LEVEL)
    : DEFAULT_EFFORT_LEVEL;
}

function entryFor(level: number): LadderEntry | null {
  return ladder?.levels[String(level)] ?? null;
}

function reachabilityFor(level: number): LadderReachability | null {
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

const VARIANT =
  /^(?:Claude|GPT|Gemini|Muse|Grok|Llama|Qwen|DeepSeek|Mistral)(?:[- ]?(V?\d[\d.]*))?\s+(?!(?:Mini|Nano|Flash|Lite|Pro|Max)\b)(?=[A-Z][a-z])/;

/** A label without its vendor prefix, route suffix and brand: "Claude Opus
 * 5.5" gives "Opus 5.5" and "GPT-6 Astra" gives "Astra" (version "6"). */
function variantName(label: string): { name: string; version: string } {
  const bare = label
    .replace(/^[^:]{1,40}:\s+/, "")
    .replace(/\s+\([^)]*\)$/, "");
  const match = bare.match(VARIANT);
  return match
    ? { name: bare.slice(match[0].length), version: match[1] ?? "" }
    : { name: bare, version: "" };
}

/** The effort button's short name, always a part of the full name that the
 * accessible name and effort menu keep. A variant another listed model shares
 * keeps its version ("GPT-6.2 Sol" reads "6.2 Sol"); "Grok 4.5" and size
 * tiers ("Gemini 3.5 Flash") stay whole. */
function shortModelName(label: string): string {
  const { name, version } = variantName(label);
  const shared = ladder?.models.some(
    (m) => m.label && m.label !== label && variantName(m.label).name === name,
  );
  return shared && version ? `${version} ${name}` : name;
}

function pendingChoice(c: Conversation): PendingModel | null | undefined {
  return saving.get(c.id) ?? c.pending_model;
}

function pendingLevel(pending: PendingModel | null | undefined): number | null {
  if (!pending) return null;
  const direct = Number(pending.level);
  if (isEffortLevel(direct)) return direct;
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

function pendingForLevel(level: number): PendingModel {
  const entry = entryFor(level);
  return {
    model: entry?.model || "",
    effort: entry?.reasoning,
    level,
  };
}

// The committed level for the visible owner, preferring a durable pending
// choice for existing conversations until the next composer message.
function committedLevel(): number | null {
  if (mode === "draft") {
    const stored = state.draft?.level;
    if (stored == null && !ladder) return defaultLevel();
    return levelOf(stored, defaultLevel());
  }
  if (!conv) return null;
  const pending = pendingChoice(conv);
  const level = Number(conv.level);
  return pending ? pendingLevel(pending) : isEffortLevel(level) ? level : null;
}

function reasoningText(effort: string | undefined): string {
  return effort && effort !== "default"
    ? effort.charAt(0).toUpperCase() + effort.slice(1)
    : "";
}

function choiceLabel(name: string, reasoning: string): string {
  return reasoning ? `${name} · ${reasoning}` : name;
}

// The trigger names the pending choice when a switch is waiting for a message.
function paintTrigger(): void {
  const pending = mode === "conv" && conv && pendingChoice(conv);
  const level = committedLevel();
  const model =
    mode === "draft" || !conv
      ? entryFor(level ?? defaultLevel())?.model
      : pending
        ? pending.model || (level && entryFor(level)?.model)
        : conv.model;
  const label = model ? modelLabel(model) : null;
  const name = label || (!model && level === null ? "Unknown model" : "Effort");
  const reasoning =
    label && mode === "conv"
      ? reasoningText(pending ? pending.effort : conv?.effort)
      : "";
  const choice = choiceLabel(name, reasoning);
  const accessibleName = level === null ? choice : `Level ${level}: ${choice}`;
  trigger.classList.toggle("pending", !!pending);
  trigger.title = pending
    ? "Switches on your next message"
    : "Choose effort level (e or Shift+M)";
  triggerName.textContent = shortModelName(name);
  triggerReasoning.textContent = reasoning ? ` ${reasoning}` : "";
  trigger.setAttribute(
    "aria-label",
    `${accessibleName}: ${pending ? "switches on your next message; " : ""}choose effort level`,
  );
}

function syncPreview(at: number, legacyUnpicked: boolean): void {
  const recorded =
    mode === "conv" && conv && previewLevel === null
      ? (pendingChoice(conv) ?? conv)
      : null;
  const entry = legacyUnpicked ? null : entryFor(at);
  const model = recorded?.model || entry?.model;
  const label = model ? modelLabel(model) : null;
  const name = label ?? (!model && legacyUnpicked ? "Unknown model" : null);
  const reasoning =
    label && mode === "conv"
      ? reasoningText(recorded ? recorded.effort : entry?.reasoning)
      : "";
  const choice = name && choiceLabel(name, reasoning);
  const valueText = legacyUnpicked
    ? (choice ?? "Model loading")
    : `Level ${at}${choice ? `: ${choice}` : ""}`;
  range.setAttribute("aria-valuetext", valueText);
  const progress = legacyUnpicked
    ? 0
    : (at - EFFORT_MIN_LEVEL) / (Number(range.max) - EFFORT_MIN_LEVEL);
  range.style.setProperty("--fill", `${progress * 100}%`);
  stops.style.setProperty("--effort-progress", String(progress));
  for (const [i, stop] of Array.from(stops.children).entries())
    stop.classList.toggle(
      "filled",
      !legacyUnpicked && i + EFFORT_MIN_LEVEL < at,
    );
  const info = reachabilityFor(at);
  range.title = info && !info.reachable ? info.reason : "";
  const text = !ladder
    ? loadFailed
      ? "Couldn't load effort levels. New agents start at level 3; retrying…"
      : "Loading effort levels…"
    : (name ?? (model ? "Loading model name…" : ""));
  modelLineName.textContent = text;
  modelLineReasoning.textContent = ladder && reasoning ? ` ${reasoning}` : "";
  modelLine.hidden = !text;
  const status = name && ladder ? valueText : text;
  if (modelStatus.textContent !== status) modelStatus.textContent = status;
}

// A legacy conversation has a neutral track until the operator chooses a stop.
function paintSlider(disabled: boolean): void {
  const current = previewLevel ?? committedLevel();
  const maximum = maximumLevel();
  if (sliderMaximum !== maximum) {
    sliderMaximum = maximum;
    range.max = String(maximum);
    const levels = EFFORT_LEVELS.filter((level) => level <= maximum);
    stops.replaceChildren(...levels.map(() => el("span")));
    range.style.setProperty(
      "--effort-ticks",
      levels
        .map((level) => {
          const percent =
            ((level - EFFORT_MIN_LEVEL) / (maximum - EFFORT_MIN_LEVEL)) * 100;
          return `radial-gradient(circle 2.5px at clamp(1%, ${percent}%, 99%), var(--effort-tick-color) 90%, transparent)`;
        })
        .join(", "),
    );
  }
  range.value = String(current ?? defaultLevel());
  if (disabled && document.activeElement === range)
    menu.focus({ preventScroll: true });
  range.disabled = disabled;
  sliderBox.classList.toggle("legacy", current === null);
  syncPreview(range.valueAsNumber, current === null);
}

function showContextTokens(c: Conversation | null): void {
  if (c?.backend === "durable" && rowThreadClearPending(c.id)) {
    contextFallbackGate.reset();
    contextFallbackKey = null;
    showConversationContext(c, null, null);
    return;
  }
  if (c?.backend === "durable") {
    const thread = rowThreads.get(c.id);
    const cached = (
      state.nodes[c.id] ?? state.sides.find((node) => node.id === c.id)
    )?.agent?.context;
    if (
      cached &&
      (!thread ||
        (typeof cached.session === "string" &&
          cached.session === thread.sessionKey)) &&
      Number.isSafeInteger(cached.tokens) &&
      cached.tokens >= 0 &&
      (cached.window === null ||
        (Number.isSafeInteger(cached.window) && cached.window > 0))
    ) {
      contextFallbackGate.reset();
      contextFallbackKey = null;
      showConversationContextFallback(c, cached.tokens, cached.window);
      return;
    }
  }
  const label = c?.backend === "durable" ? null : conversationContextLabel(c);
  const selectedModel = c?.model;
  const contextWindow =
    conversationContextSelector(c) === selectedModel
      ? (knownModel(selectedModel ?? "")?.context_window ?? null)
      : null;
  if (c && label === null) {
    const key = contextFallbackIdentity(c);
    const held = contextFallbacks.get(contextFallbackSession(c));
    if (held) {
      showConversationContextFallback(c, held.used, held.max);
      // Invariant: Only a Durable key proves the reading is current: it
      // carries the held row revision, so a switch back reuses it.
      if (held.key === key && c.backend === "durable") return;
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
    if (stored != null && ladder) draft.level = level;
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
    previewLevel = null;
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
  row.classList.remove("conversation-effort");
  if (triggerCaret) trigger.append(triggerCaret);
  showContextTokens(null);
  mode = "draft";
  conv = null;
  useLadderOf(draft.backendLabel ?? "");
  if (isEffortLevel(initial)) draft.level = initial;
  render();
  void fetchLadder();
}

// No conversation is loaded (a draft, or an agent still being read): show no
// effort or context metadata rather than the last agent's values.
export function hideModel(): void {
  previewLevel = null;
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
  if (conv?.id !== c?.id) {
    previewLevel = null;
    touchStart = null;
    menu.hidePopover();
  }
  menu.classList.remove("draft-open");
  trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open")));
  const show = !!c;
  if (row.parentElement !== compactHome) compactHome.appendChild(row);
  controls?.classList.toggle("on", show);
  row.classList.toggle("on", show);
  row.classList.add("conversation-effort");
  triggerCaret?.remove();
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
  previewLevel = null;
  menu.classList.remove("draft-open");
  trigger.setAttribute("aria-expanded", "false");
  render();
}

export function dismissEffortMenu(): boolean {
  if (!pickerOpen()) return false;
  if (draftInline()) closeDraftMenu();
  else menu.hidePopover();
  return true;
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

let pickerInvoker = trigger;
let keepComposerFocus = false;

export function effortMenuInvoker(): HTMLButtonElement {
  return pickerInvoker.hidden ? trigger : pickerInvoker;
}

for (const invoker of [trigger, $<HTMLButtonElement>("#safety-warning")]) {
  invoker?.addEventListener("click", (event) => {
    if (pickerOpen()) return;
    pickerInvoker = invoker;
    keepComposerFocus = event.detail !== 0 && phoneComposerFocused();
  });
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

menu.addEventListener("beforetoggle", (event) => {
  previewLevel = null;
  touchStart = null;
  if (event instanceof ToggleEvent && event.newState === "open")
    paintSlider(!!conv && saving.has(conv.id));
});

menu.addEventListener("toggle", () => {
  const open = menu.matches(":popover-open");
  trigger.setAttribute("aria-expanded", String(open));
  if (!open) {
    keepComposerFocus = false;
    pickerInvoker = trigger;
    if (mode === "draft" || conv) render();
    return;
  }
  const rect = trigger.getBoundingClientRect();
  const above = mode === "conv" || rect.top > innerHeight / 2;
  const composerTop = $("#composer")?.getBoundingClientRect().top ?? rect.top;
  const top =
    mode === "conv" && composerTop >= menu.scrollHeight + 24
      ? composerTop
      : rect.top;
  menu.style.maxHeight = `${Math.max(0, (above ? top : innerHeight - rect.bottom) - 20)}px`;
  menu.style.left = `${Math.max(12, Math.min(rect.left + rect.width / 2 - menu.offsetWidth / 2, innerWidth - menu.offsetWidth - 12))}px`;
  menu.style.top = above ? "auto" : `${rect.bottom + 8}px`;
  menu.style.bottom = above ? `${innerHeight - top + 8}px` : "auto";
  if (!keepComposerFocus) menu.focus({ preventScroll: true });
});

menu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    effortMenuInvoker().focus({ preventScroll: true });
    dismissEffortMenu();
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
  previewLevel = levelOf(range.value, defaultLevel());
  paintSlider(false);
});

function reselectLevel(): void {
  if (mode === "conv" && pickerOpen() && !range.disabled)
    range.dispatchEvent(new Event("change", { bubbles: true }));
}
range.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch" && event.isPrimary)
    touchStart = { pointerId: event.pointerId, value: range.value };
});
range.addEventListener("pointercancel", (event) => {
  if (event.pointerId === touchStart?.pointerId) touchStart = null;
});
range.addEventListener("pointerup", (event) => {
  if (event.pointerId !== touchStart?.pointerId) return;
  const unchanged = range.value === touchStart.value;
  touchStart = null;
  // Invariant: Native touch emits change for a changed stop, but may emit
  // neither change nor click for an unchanged stop.
  if (unchanged) reselectLevel();
});
range.addEventListener("click", (event) => {
  if (!(event instanceof PointerEvent) || event.pointerType !== "touch")
    reselectLevel();
});
range.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  range.dispatchEvent(new Event("change", { bubbles: true }));
});

range.addEventListener("change", async () => {
  if (range.disabled) {
    render();
    return;
  }
  const level = range.valueAsNumber;
  if (!isEffortLevel(level)) {
    render();
    return;
  }
  previewLevel = null;
  if (mode === "draft") {
    if (state.draft && !state.draft.creator) state.draft.level = level;
    render();
    return;
  }
  if (!conv || saving.has(conv.id)) {
    render();
    return;
  }
  const target = conv;
  // Invariant: In-flight choices are keyed by agent so a refreshed snapshot
  // cannot erase the preview. Only the accepted choice updates the snapshot.
  const optimistic = pendingForLevel(level);
  saving.set(target.id, optimistic);
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
    if (conv?.id === target.id) conv.pending_model = accepted;
    if (state.currentConv?.id === target.id) {
      state.currentConv.pending_model = accepted;
    }
  } catch {
  } finally {
    saving.delete(target.id);
    // Invariant: Refresh may replace the object, but only the same agent
    // still owns the visible switch.
    if (mode === "conv" && conv?.id === target.id) render();
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
