import { expect, test } from "bun:test";
import { findLayers } from "../checks/z_check.ts";

const values = (text: string) =>
  findLayers(text).map(({ line, value }) => `${line}:${value}`);

test("accepts the layer tokens, in-layer steps and resets", () => {
  const css = [
    ".a { z-index: var(--z-raised); } .b { z-index: var(--z-chrome); }",
    ".c { z-index: var(--z-drawer); } .d { z-index: var(--z-menu); }",
    ".e { z-index: var(--z-dialog); } .f { z-index: var(--z-toast); }",
    ".g { z-index: calc(var(--z-drawer) + 4); } .h { z-index: calc(var(--z-dialog) + 1); }",
    ".i { z-index: 0; } .j { z-index: auto; } .k { Z-INDEX: inherit !important; }",
    '  Object.assign(el.style, { zIndex: "var(--z-menu)" });',
    "  el.style.zIndex = 0; el.style.zIndex = layer;",
    "/* was z-index: 30; */ .m { z-index: 99; } /* z-check: allow */",
  ].join("\n");
  expect(values(css)).toEqual([]);
});

test("reports raw numbers, unknown tokens and out-of-range steps", () => {
  const text = [
    "#pane-menu { position: fixed; z-index: 25; }",
    ".x { z-index: var(--z-modal); }",
    ".y { z-index: calc(var(--z-drawer) + 5); }",
    ".z { z-index: calc(var(--z-menu) - 1); }",
    '<div style="z-index:9">x</div>',
    '  Object.assign(el.style, { zIndex: "40" });',
    "  el.style.zIndex = 2147483647;",
    ".w { z-index: -1; } .v { z-index: var(--z-menu, 30); }",
    ".u { z-index: var(--z-MENU); } .t { z-index: calc(var(--z-menu)+1); }",
    "  el.style.zIndex = 0x28; el.style.zIndex = 0.5;",
    '  el.style.setProperty("z-index", "25");',
  ].join("\n");
  expect(values(text)).toEqual([
    "1:25",
    "2:var(--z-modal)",
    "3:calc(var(--z-drawer) + 5)",
    "4:calc(var(--z-menu) - 1)",
    "5:9",
    "6:40",
    "7:2147483647",
    "8:-1",
    "8:var(--z-menu, 30)",
    "9:var(--z-MENU)",
    "9:calc(var(--z-menu)+1)",
    "10:0x28",
    "10:0.5",
    "11:25",
  ]);
});
