// One typed source of truth for Recurse's desktop keyboard behavior. The pure
// reducer owns modal/chord semantics; app.ts performs the returned DOM actions,
// and the shortcuts pane renders the same binding metadata used for dispatch.

export const CHORD_TIMEOUT_MS = 1600;

export type KeyboardMode =
  | "normal"
  | "insert"
  | "rename"
  | "dialog"
  | "finder"
  | "pane"
  | "t-prefix"
  | "delete-pending"
  | "interrupt-pending";

export interface KeymapState {
  mode: KeyboardMode;
  deadline: number | null;
  anchorId: string | null;
}

export type KeyCommand =
  | "parent"
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
  | "toggle-pane"
  | "focus-pane"
  | "focus-thread"
  | "focus-agents"
  | "find-pull-request"
  | "pane-next"
  | "pane-previous"
  | "pane-fullscreen"
  | "close-pane"
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
    command: "toggle-pane",
    description: "open / close pane",
  },
  {
    keys: ["p"],
    command: "focus-pane",
    description: "focus pane (open if closed)",
  },
  {
    keys: ["P"],
    command: "find-pull-request",
    description: "find pull request in Changes",
  },
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
  id: "normal" | "insert" | "prefix" | "pane";
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
      { keys: ["j"], command: "pane-next", description: "next pane" },
      { keys: ["k"], command: "pane-previous", description: "previous pane" },
      {
        keys: ["z"],
        command: "pane-fullscreen",
        description: "toggle fullscreen",
      },
      { keys: ["o"], command: "toggle-pane", description: "open / close pane" },
      {
        keys: ["p"],
        command: "focus-thread",
        description: "focus message thread",
      },
      {
        keys: ["Escape"],
        command: "focus-agents",
        description: "focus agents list (leave pane open)",
      },
      {
        keys: ["h"],
        command: "close-pane",
        description: "close pane / back to agents",
      },
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
  mode: "t-prefix" | "delete-pending" | "interrupt-pending",
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

  if (
    context.commentAvailable &&
    !chordPending(state) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    normalBinding(event.key)?.command === "comment"
  )
    return event.repeat ? result(state, null, true) : action("comment");

  if (context.target === "pane") {
    const paneState = initialKeymapState("pane");
    if (event.ctrlKey || event.metaKey || event.altKey)
      return result(paneState, null, false);
    // Invariant: o toggles visibility from either focus context. p moves focus
    // between thread and pane without changing an open pane's layout; Escape
    // returns to agents leaving the pane open. h still closes the pane.
    if (event.key === "Escape") return action("focus-agents");
    if (event.key === "P")
      return event.repeat
        ? result(paneState, null, true)
        : action("find-pull-request");
    if (event.key === "p" || event.key === "o")
      return event.repeat
        ? result(paneState, null, true)
        : action(event.key === "p" ? "focus-thread" : "toggle-pane");
    if (event.key === "h")
      return event.repeat
        ? result(paneState, null, true)
        : action("close-pane");
    // Invariant: j/k switch between the available right-side panes. Arrows are
    // deliberately left native so the mouse/trackpad/arrow keys still scroll
    // pane content.
    if (event.key === "j") return result(paneState, "pane-next", true);
    if (event.key === "k") return result(paneState, "pane-previous", true);
    if (event.key === "z")
      return event.repeat
        ? result(paneState, null, true)
        : result(paneState, "pane-fullscreen", true);
    if (event.key === "G")
      return event.repeat
        ? result(paneState, null, true)
        : action("scroll-bottom");
    return result(paneState, null, false);
  }

  // Invariant: Dialogs, rename fields, and unrelated editors are hard focus
  // boundaries. Escape only cancels the local layer.
  if (context.target !== "chrome" && context.target !== "composer") {
    if (event.key === "Escape") return action("cancel-local");
    if (context.target === "rename" && event.key === "Enter")
      return action("commit-rename");
    if (context.target === "control")
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
  if (
    ["toggle-pane", "focus-pane"].includes(binding.command) &&
    !context.paneAvailable
  )
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
      return "Find agent";
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
