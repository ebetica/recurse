// One typed source of truth for Recurse's desktop keyboard behavior. The pure
// reducer owns modal/chord semantics; app.ts performs the returned DOM actions,
// and the shortcuts pane renders the same binding metadata used for dispatch.
import type { PaneNavigation } from "./types.js";
import type { WindowCommand } from "./dock/commands.js";

export const CHORD_TIMEOUT_MS = 1600;

export type KeyboardMode =
  | "normal"
  | "insert"
  | "rename"
  | "dialog"
  | "finder"
  | "pane"
  | "t-prefix"
  | "g-prefix"
  | "w-prefix"
  | "resize"
  | "delete-pending"
  | "interrupt-pending";

export interface KeymapState {
  mode: KeyboardMode;
  deadline: number | null;
  anchorId: string | null;
}

export type KeyCommand =
  | "parent"
  | "toggle-agents"
  | "close-pane"
  | "next"
  | "previous"
  | "open"
  | "compose"
  | "comment"
  | "find-agent"
  | "new-agent"
  | "arm-delete"
  | "delete"
  | "rename"
  | "open-pane-finder"
  | `pane-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "scroll-pane-top"
  | "scroll-pane-bottom"
  | `window-${WindowCommand}`
  | "focus-thread"
  | "focus-agents"
  | "find-pull-request"
  | `pane-${Exclude<PaneNavigation, "top" | "bottom">}`
  | "pane-fullscreen"
  | "interrupt"
  | "commit-rename"
  | "cancel-local"
  | "take-over"
  | "choose-effort"
  | "toggle-latest-turn"
  | "scroll-bottom"
  | "invalid-chord"
  | "unavailable-stop";

export interface KeyResult {
  state: KeymapState;
  command: KeyCommand | null;
  handled: boolean;
}

export interface KeyStroke {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

export type KeyTarget =
  | "chrome"
  | "composer"
  | "rename"
  | "dialog"
  | "editor"
  | "control"
  | "window-control"
  | "finder"
  | "pane";

export interface KeyContext {
  now: number;
  desktop: boolean;
  target: KeyTarget;
  selectedId: string;
  interruptible: boolean;
  deletable: boolean;
  paneAvailable: boolean;
  textSelected: boolean;
  commentAvailable?: boolean;
}

export interface Binding {
  keys: readonly string[];
  command: KeyCommand;
  description: string;
}

// The picker calls this only from its own keyboard surface. Keeping open/focus
// state explicit prevents its vim keys from leaking into tree navigation.
export function effortStepForKey(
  key: string,
  pickerOpen: boolean,
  rangeFocused: boolean,
): -1 | 0 | 1 {
  if (!pickerOpen) return 0;
  if (key === "j") return 1;
  if (key === "k") return -1;
  if (rangeFocused) return 0;
  if (key === "ArrowRight") return 1;
  if (key === "ArrowLeft") return -1;
  return 0;
}

export const NORMAL_BINDINGS: readonly Binding[] = [
  {
    keys: ["h", "ArrowLeft"],
    command: "parent",
    description: "collapse subagents / parent",
  },
  { keys: ["H"], command: "toggle-agents", description: "show / hide agents" },
  { keys: ["j", "ArrowDown"], command: "next", description: "next agent" },
  {
    keys: ["k", "ArrowUp"],
    command: "previous",
    description: "previous agent",
  },
  {
    keys: ["l", "ArrowRight"],
    command: "open",
    description: "expand subagents / descend",
  },
  { keys: ["i", "Enter"], command: "compose", description: "write a message" },
  { keys: ["f"], command: "find-agent", description: "find an agent" },
  { keys: ["c"], command: "comment", description: "comment" },
  { keys: ["r"], command: "rename", description: "rename" },
  {
    keys: ["m"],
    command: "take-over",
    description: "take over / release this agent",
  },
  {
    keys: ["e", "M"],
    command: "choose-effort",
    description: "choose effort level",
  },
  {
    keys: ["v"],
    command: "toggle-latest-turn",
    description: "toggle all response details",
  },
  {
    keys: ["G"],
    command: "scroll-bottom",
    description: "go to the latest message",
  },
  {
    keys: ["o"],
    command: "open-pane-finder",
    description: "open a pane",
  },
  {
    keys: ["z"],
    command: "window-fullscreen",
    description: "toggle window fullscreen",
  },
  {
    keys: ["P"],
    command: "find-pull-request",
    description: "find pull request in Changes",
  },
];

const PANE_BINDINGS: readonly Binding[] = [
  { keys: ["j"], command: "pane-next", description: "next item / scroll down" },
  {
    keys: ["k"],
    command: "pane-previous",
    description: "previous item / scroll up",
  },
  { keys: ["d"], command: "pane-half-down", description: "half page down" },
  { keys: ["u"], command: "pane-half-up", description: "half page up" },
  {
    keys: ["l", "Enter"],
    command: "pane-open",
    description: "open / expand item",
  },
  { keys: ["h"], command: "pane-back", description: "back / collapse item" },
  {
    keys: ["["],
    command: "pane-previous-section",
    description: "previous file / section",
  },
  {
    keys: ["]"],
    command: "pane-next-section",
    description: "next file / section",
  },
  { keys: ["/"], command: "pane-filter", description: "filter list" },
  { keys: ["y"], command: "pane-copy", description: "copy item path / link" },
];

export const G_BINDINGS: readonly Binding[] = [
  ...Array.from(
    { length: 9 },
    (_, index): Binding => ({
      keys: [String(index + 1)],
      command: `pane-${(index + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`,
      description: `open pane ${index + 1}`,
    }),
  ),
  {
    keys: ["h"],
    command: "window-focus-left",
    description: "left window / previous tab",
  },
  { keys: ["j"], command: "window-focus-down", description: "window below" },
  { keys: ["k"], command: "window-focus-up", description: "window above" },
  {
    keys: ["l"],
    command: "window-focus-right",
    description: "right window / next tab",
  },
  { keys: ["p"], command: "window-previous", description: "previous window" },
];

export const WINDOW_BINDINGS: readonly Binding[] = [
  { keys: ["h", "H"], command: "window-move-left", description: "move left" },
  { keys: ["j", "J"], command: "window-move-down", description: "move below" },
  { keys: ["k", "K"], command: "window-move-up", description: "move above" },
  { keys: ["l", "L"], command: "window-move-right", description: "move right" },
  {
    keys: ["v"],
    command: "window-open-right",
    description: "next window to the right",
  },
  {
    keys: ["s"],
    command: "window-open-below",
    description: "next window below",
  },
  {
    keys: ["t"],
    command: "window-merge",
    description: "join sibling windows as tabs",
  },
  {
    keys: ["e"],
    command: "window-split",
    description: "split tabs / change split direction",
  },
  {
    keys: ["o"],
    command: "window-only",
    description: "only this window / restore",
  },
  {
    keys: ["f"],
    command: "window-fullscreen",
    description: "toggle fullscreen",
  },
  { keys: ["q"], command: "window-close", description: "close window / tab" },
  { keys: ["Q"], command: "window-close-all", description: "close all panes" },
  { keys: ["r"], command: "window-resize", description: "resize windows" },
  {
    keys: ["="],
    command: "window-equalize",
    description: "equal window sizes",
  },
];

const RESIZE_BINDINGS: readonly Binding[] = [
  { keys: ["h"], command: "window-resize-left", description: "narrower" },
  { keys: ["l"], command: "window-resize-right", description: "wider" },
  { keys: ["k"], command: "window-resize-up", description: "shorter" },
  { keys: ["j"], command: "window-resize-down", description: "taller" },
];

export const PREFIX_BINDINGS: readonly Binding[] = [
  { keys: ["t"], command: "new-agent", description: "new agent" },
];

export interface ShortcutItem {
  keys: readonly string[];
  description: string;
  command?: KeyCommand;
  platform?: "modifier";
  shift?: boolean;
}

export interface ShortcutGroup {
  id: "normal" | "insert" | "prefix" | "pane" | "window" | "resize";
  title: string;
  items: readonly ShortcutItem[];
}

// Help-only transitions complement action entries projected from dispatch maps.
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: "normal",
    title: "Normal",
    items: [
      ...NORMAL_BINDINGS.map(({ keys, command, description }) => ({
        keys,
        command,
        description,
      })),
      { keys: ["t", "…"], description: "agent actions" },
      { keys: ["g", "1–9"], description: "open pane by rail position" },
      { keys: ["w", "…"], description: "window layout" },
      {
        keys: ["d", "d"],
        command: "delete",
        description: "delete agent subtree",
      },
      {
        keys: ["q", "q"],
        command: "interrupt",
        description: "interrupt a running agent",
      },
    ],
  },
  {
    id: "insert",
    title: "Insert",
    items: [
      { keys: ["Enter"], description: "send (desktop)" },
      { keys: ["Shift+Enter"], description: "new line" },
      {
        keys: ["Escape"],
        command: "cancel-local",
        description: "return to Normal",
      },
    ],
  },
  {
    id: "prefix",
    title: "t prefix",
    items: PREFIX_BINDINGS.map(({ keys, command, description }) => ({
      keys: ["t", keys[0]],
      command,
      description,
    })),
  },
  {
    id: "pane",
    title: "Open pane",
    items: [
      ...PANE_BINDINGS,
      {
        keys: ["z"],
        command: "pane-fullscreen",
        description: "toggle fullscreen",
      },
      { keys: ["o"], command: "open-pane-finder", description: "open a pane" },
      { keys: ["i"], command: "compose", description: "write a message" },
      { keys: ["g", "1–9"], description: "open pane by rail position" },
      {
        keys: ["g", "g"],
        command: "scroll-pane-top",
        description: "top of pane",
      },
      {
        keys: ["G"],
        command: "scroll-pane-bottom",
        description: "bottom of pane",
      },
      {
        keys: ["Escape"],
        command: "focus-agents",
        description: "focus agents list (leave pane open)",
      },
      {
        keys: ["q"],
        command: "close-pane",
        description: "close pane / back to agents",
      },
      {
        keys: ["H"],
        command: "toggle-agents",
        description: "show / hide agents",
      },
    ],
  },
  {
    id: "window",
    title: "Windows",
    items: [
      ...G_BINDINGS.filter(({ command }) => command.startsWith("window-")).map(
        ({ keys, command, description }) => ({
          keys: ["g", keys[0]],
          command,
          description,
        }),
      ),
      ...WINDOW_BINDINGS.map(({ keys, command, description }) => ({
        keys: ["w", keys[0]],
        command,
        description,
      })),
    ],
  },
  {
    id: "resize",
    title: "Resize",
    items: [
      ...RESIZE_BINDINGS,
      { keys: ["Escape"], description: "finish resizing" },
    ],
  },
];

export const initialKeymapState = (
  mode: KeyboardMode = "normal",
): KeymapState => ({
  mode,
  deadline: null,
  anchorId: null,
});

const result = (
  state: KeymapState,
  command: KeyCommand | null,
  handled: boolean,
): KeyResult => ({ state, command, handled });

const action = (
  command: KeyCommand,
  mode: KeyboardMode = "normal",
): KeyResult => result(initialKeymapState(mode), command, true);

function normalBinding(key: string): Binding | undefined {
  return NORMAL_BINDINGS.find((binding) => binding.keys.includes(key));
}

function prefixBinding(key: string): Binding | undefined {
  return PREFIX_BINDINGS.find((binding) => binding.keys[0] === key);
}

function pending(
  mode:
    | "t-prefix"
    | "g-prefix"
    | "w-prefix"
    | "delete-pending"
    | "interrupt-pending",
  now: number,
  anchorId: string,
): KeymapState {
  return {
    mode,
    deadline: now + CHORD_TIMEOUT_MS,
    anchorId,
  };
}

function expired(state: KeymapState, context: KeyContext): boolean {
  return state.deadline !== null && context.now >= state.deadline;
}

function chordPending(state: KeymapState): boolean {
  return (
    state.mode === "t-prefix" ||
    state.mode === "g-prefix" ||
    state.mode === "w-prefix" ||
    state.mode === "delete-pending" ||
    state.mode === "interrupt-pending"
  );
}

export function reduceKeymap(
  current: KeymapState,
  event: KeyStroke,
  context: KeyContext,
): KeyResult {
  if (!context.desktop) return result(current, null, false);
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
    return result(
      chordPending(current) ? initialKeymapState() : current,
      null,
      false,
    );

  let state = current;
  if (
    expired(state, context) ||
    (state.anchorId !== null && state.anchorId !== context.selectedId)
  )
    state = initialKeymapState();

  if (context.target === "finder")
    return result(
      state.mode === "finder" ? state : initialKeymapState("finder"),
      null,
      false,
    );

  const windowTarget =
    context.target === "pane" ||
    context.target === "chrome" ||
    context.target === "window-control";
  if (state.mode === "resize" && windowTarget) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
      return result(state, null, false);
    if (event.key === "Escape" || event.key === "Enter")
      return action(
        "window-cancel",
        context.target === "pane" ? "pane" : "normal",
      );
    const binding = RESIZE_BINDINGS.find((item) =>
      item.keys.includes(event.key),
    );
    return result(state, binding?.command || null, true);
  }

  if (
    context.commentAvailable &&
    !chordPending(state) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    normalBinding(event.key)?.command === "comment"
  )
    return event.repeat ? result(state, null, true) : action("comment");

  if (
    windowTarget &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !context.textSelected
  ) {
    const windowMode = context.target === "pane" ? "pane" : "normal";
    if (state.mode === "w-prefix") {
      if (event.key === "Shift") return result(state, null, false);
      if (event.key === "Escape" || event.repeat)
        return result(initialKeymapState(windowMode), null, true);
      const binding = WINDOW_BINDINGS.find((item) =>
        item.keys.includes(event.key),
      );
      return binding
        ? action(
            binding.command,
            binding.command === "window-resize" ? "resize" : windowMode,
          )
        : action("invalid-chord");
    }
    if (event.key === "w" && !chordPending(state))
      return result(
        event.repeat
          ? state
          : pending("w-prefix", context.now, context.selectedId),
        null,
        true,
      );
    if (state.mode === "g-prefix") {
      if (event.key === "Shift") return result(state, null, false);
      if (event.key === "Escape" || event.repeat)
        return result(initialKeymapState(windowMode), null, true);
      if (event.key === "g" && context.target === "pane")
        return action("scroll-pane-top", "pane");
      const binding = G_BINDINGS.find((item) => item.keys.includes(event.key));
      return binding
        ? action(binding.command, windowMode)
        : action("invalid-chord", windowMode);
    }
    if (event.key === "g" && !chordPending(state))
      return result(
        event.repeat
          ? state
          : pending("g-prefix", context.now, context.selectedId),
        null,
        true,
      );
    if (context.target === "window-control") {
      const binding = normalBinding(event.key);
      if (binding?.command === "window-fullscreen")
        return event.repeat
          ? result(initialKeymapState(windowMode), null, true)
          : action(binding.command, windowMode);
    }
  }

  if (context.target === "pane") {
    const paneState = initialKeymapState("pane");
    if (event.ctrlKey || event.metaKey || event.altKey)
      return result(paneState, null, false);
    // Invariant: Pane keys never arm destructive agent chords.
    if (event.key === "Escape") return action("focus-agents");
    if (event.key === "P")
      return event.repeat
        ? result(paneState, null, true)
        : action("find-pull-request");
    if (event.key === "o")
      return event.repeat
        ? result(paneState, null, true)
        : action("open-pane-finder");
    if (event.key === "i") return action("compose", "insert");
    if (event.key === "q")
      return event.repeat
        ? result(paneState, null, true)
        : action("close-pane");
    if (event.key === "H")
      return event.repeat
        ? result(paneState, null, true)
        : result(paneState, "toggle-agents", true);
    const binding = PANE_BINDINGS.find((item) => item.keys.includes(event.key));
    if (binding)
      return result(
        paneState,
        event.repeat && !["j", "k", "d", "u", "[", "]"].includes(event.key)
          ? null
          : binding.command,
        true,
      );
    if (event.key === "z")
      return event.repeat
        ? result(paneState, null, true)
        : result(paneState, "pane-fullscreen", true);
    if (event.key === "G")
      return event.repeat
        ? result(paneState, null, true)
        : action("scroll-pane-bottom", "pane");
    return result(paneState, null, false);
  }

  // Invariant: Dialogs, rename fields, and unrelated editors are hard focus
  // boundaries. Escape only cancels the local layer.
  if (context.target !== "chrome" && context.target !== "composer") {
    if (event.key === "Escape") return action("cancel-local");
    if (context.target === "rename" && event.key === "Enter")
      return action("commit-rename");
    if (context.target === "control" || context.target === "window-control")
      return result(initialKeymapState(), null, false);
    return result(
      initialKeymapState(context.target === "rename" ? "rename" : "dialog"),
      null,
      false,
    );
  }

  // Invariant: Browser/system modifier combinations never fall through to
  // Normal commands or type-to-compose; they stay native (cut, find, new tab,
  // ...).
  if (event.ctrlKey || event.metaKey || event.altKey)
    return result(
      chordPending(state) ? initialKeymapState() : state,
      null,
      false,
    );

  // Invariant: The composer owns ordinary editing. Escape is the modal boundary
  // back to Normal and can never interrupt from here.
  if (context.target === "composer") {
    if (event.key === "Escape") return action("cancel-local");
    return result(initialKeymapState("insert"), null, false);
  }

  // Invariant: A selection in non-editable content suppresses Normal actions,
  // but Escape still clears modal state. This avoids navigation while
  // selecting/copying.
  if (context.textSelected && event.key !== "Escape")
    return result(
      chordPending(state) ? initialKeymapState() : state,
      null,
      false,
    );

  // Invariant: A physical Shift keydown precedes any shifted key in the t
  // prefix. Preserve that useful prefix; destructive chords cancel without
  // consuming it.
  if (event.key === "Shift")
    return result(
      state.mode === "t-prefix"
        ? state
        : chordPending(state)
          ? initialKeymapState()
          : state,
      null,
      false,
    );

  if (state.mode === "t-prefix") {
    if (event.key === "Escape") return result(initialKeymapState(), null, true);
    if (event.repeat) return result(initialKeymapState(), null, true);
    const binding = prefixBinding(event.key);
    if (event.shiftKey && !binding)
      return result(initialKeymapState(), null, false);
    return binding ? action(binding.command) : action("invalid-chord");
  }

  if (state.mode === "delete-pending") {
    if (event.key === "Escape") return result(initialKeymapState(), null, true);
    if (event.shiftKey) return result(initialKeymapState(), null, false);
    if (event.key === "d" && !event.repeat) return action("delete");
    // Invariant: An invalid second key only cancels; it is deliberately not
    // redispatched.
    return event.repeat
      ? result(initialKeymapState(), null, true)
      : action("invalid-chord");
  }

  if (state.mode === "interrupt-pending") {
    if (event.shiftKey) return result(initialKeymapState(), null, false);
    if (event.key === "q" && !event.repeat)
      return action(context.interruptible ? "interrupt" : "unavailable-stop");
    if (event.key === "Escape") return result(initialKeymapState(), null, true);
    return event.repeat
      ? result(initialKeymapState(), null, true)
      : action("invalid-chord");
  }

  // Invariant: Escape is cancellation/navigation only. Interrupt is
  // deliberately harder: qq while already in Normal on the open running agent.
  if (event.key === "Escape") return result(initialKeymapState(), null, true);
  if (event.key === "q") {
    if (event.repeat) return result(state, null, true);
    if (!context.interruptible) return action("unavailable-stop");
    return result(
      pending("interrupt-pending", context.now, context.selectedId),
      null,
      true,
    );
  }
  if (event.key === "t") {
    if (event.repeat) return result(state, null, true);
    return result(
      pending("t-prefix", context.now, context.selectedId),
      null,
      true,
    );
  }
  if (event.key === "d") {
    if (event.repeat || !context.deletable) return result(state, null, true);
    return result(
      pending("delete-pending", context.now, context.selectedId),
      "arm-delete",
      true,
    );
  }
  const binding = normalBinding(event.key);
  if (!binding) return result(state, null, false);
  if (binding.command === "open-pane-finder" && !context.paneAvailable)
    return result(state, null, true);
  if (
    event.repeat &&
    !["parent", "next", "previous", "open"].includes(binding.command)
  )
    return result(state, null, true);
  const nextMode =
    binding.command === "compose"
      ? "insert"
      : binding.command === "find-agent"
        ? "finder"
        : "normal";
  return action(binding.command, nextMode);
}

export function keymapModeLabel(state: KeymapState): string {
  switch (state.mode) {
    case "insert":
      return "Insert";
    case "rename":
      return "Rename";
    case "dialog":
      return "Dialog";
    case "finder":
      return "Finder";
    case "g-prefix":
      return "g …";
    case "w-prefix":
      return "w …";
    case "resize":
      return "Resize";
    case "pane":
      return "Pane";
    case "t-prefix":
      return "t …";
    case "delete-pending":
      return "d … delete";
    case "interrupt-pending":
      return "q again to interrupt";
    default:
      return "Normal";
  }
}

export function shouldLeaveEmptyComposer(
  event: KeyStroke,
  empty: boolean,
): boolean {
  return (
    empty &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat
  );
}

export function adjacentCursor(
  visibleIds: readonly string[],
  currentId: string,
  delta: -1 | 1,
): string | null {
  const index = visibleIds.indexOf(currentId);
  const next = index + delta;
  return index >= 0 && next >= 0 && next < visibleIds.length
    ? visibleIds[next]
    : null;
}

export function formatShortcutKey(key: string): string {
  const names: Record<string, string> = {
    ArrowLeft: "←",
    ArrowDown: "↓",
    ArrowUp: "↑",
    ArrowRight: "→",
    Enter: "Enter",
    Escape: "Esc",
  };
  return names[key] || key;
}
