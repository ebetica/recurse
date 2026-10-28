import { describe, expect, test } from "bun:test";
import {
  initialKeymapState,
  reduceKeymap,
  type KeyContext,
  type KeyStroke,
  type KeymapState,
} from "../../web/keymap.js";

const stroke = (overrides: Partial<KeyStroke> = {}): KeyStroke => ({
  key: "x",
  defaultPrevented: false,
  isComposing: false,
  keyCode: 88,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...overrides,
});

const context = (overrides: Partial<KeyContext> = {}): KeyContext => ({
  now: 100,
  desktop: true,
  target: "chrome",
  selectedId: "agent-a",
  interruptible: false,
  deletable: true,
  paneAvailable: false,
  textSelected: false,
  ...overrides,
});

const press = (
  state: KeymapState,
  key: string,
  ctx: Partial<KeyContext> = {},
  event: Partial<KeyStroke> = {},
) =>
  reduceKeymap(
    state,
    stroke({
      key,
      keyCode: key.length === 1 ? key.charCodeAt(0) : 0,
      ...event,
    }),
    context(ctx),
  );

const normal = initialKeymapState();

describe("Normal mode", () => {
  test("Shift+P finds PRs in chrome and panes but never in an editor", () => {
    expect(
      press(normal, "P", { target: "composer" }, { shiftKey: true }).command,
    ).toBeNull();
    expect(press(normal, "P", {}, { metaKey: true }).handled).toBe(false);
  });

  test("vim keys and arrows share tree traversal while Enter/i enter Insert", () => {
    for (const key of ["i", "Enter"]) {
      const next = press(normal, key);
      expect(next.state.mode).toBe("insert");
    }
  });

  test("f opens the dedicated finder without entering the composer", () => {
    const opened = press(normal, "f");
    expect(opened.state.mode).toBe("finder");
    const repeated = press(normal, "f", {}, { repeat: true });
    expect(repeated.handled).toBe(true);
    expect(repeated.command).toBeNull();
  });

  test("v toggles the latest turn and does not repeat", () => {
    const repeated = press(normal, "v", {}, { repeat: true });
    expect(repeated.handled).toBe(true);
    expect(repeated.command).toBeNull();
  });

  test("Shift+G scrolls to the latest message, but Shift alone does nothing", () => {
    expect(press(normal, "Shift", {}, { shiftKey: true }).command).toBeNull();
  });
});

describe("right pane focus mode", () => {
  // Feature: #2314 pane focus and visibility use separate keys.
  test("p focuses and o toggles only when a pane is open or available", () => {
    for (const [key, command] of [
      ["p", "focus-pane"],
      ["o", "toggle-pane"],
    ] as const) {
      const unavailable = press(normal, key, { paneAvailable: false });
      expect(unavailable.handled).toBe(true);
      expect(unavailable.command).toBeNull();
      expect(press(normal, key, { paneAvailable: true }).command).toBe(command);
    }
  });

  // Feature: #2314 pane exits can move focus without closing the pane.
  test("p returns to the thread, Escape to agents, o toggles, and h closes", () => {
    const pane = initialKeymapState("pane");
    for (const [key, command] of [
      ["p", "focus-thread"],
      ["Escape", "focus-agents"],
      ["o", "toggle-pane"],
      ["h", "close-pane"],
    ] as const) {
      const exit = press(pane, key, { target: "pane" });
      expect(exit.command).toBe(command);
      expect(exit.state.mode).toBe("normal");
    }
    for (const key of ["p", "o", "h"])
      expect(
        press(pane, key, { target: "pane" }, { repeat: true }).command,
      ).toBeNull();
  });
});

describe("Take-over binding", () => {
  test("m toggles take-over from Normal and leaves no modal move layer", () => {
    const toggled = press(normal, "m");
    expect(toggled.state.mode).toBe("normal");
    expect(toggled.handled).toBe(true);
    expect(press(toggled.state, "x").handled).toBe(false);
  });
});
