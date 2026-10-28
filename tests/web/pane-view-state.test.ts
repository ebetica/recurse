import { describe, expect, test } from "bun:test";
import { validPaneViewStateDef } from "../../web/panes/view-state.js";
import type { PaneViewStateDef } from "../../web/types.js";

function definition(
  overrides: Partial<PaneViewStateDef> = {},
): PaneViewStateDef {
  return {
    key: "example",
    storageSlot: 2,
    version: 1,
    defaultValue: () => ({ selected: null }),
    parse: (value) => value,
    serialize: (value) => value,
    capture: () => ({ selected: "one" }),
    restore: () => {},
    ...overrides,
  };
}

describe("pane-declared view state", () => {
  test("validates bounded stable metadata", () => {
    expect(validPaneViewStateDef(definition({ key: "__proto__" }))).toBe(false);
  });
});
