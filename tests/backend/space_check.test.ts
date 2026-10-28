import { expect, test } from "bun:test";
import { checkFiles, findSpacing } from "../checks/space_check.ts";

const values = (text: string) =>
  findSpacing(text).map(({ line, value }) => `${line}:${value}`);

test("accepts tokens, zero, hairlines, auto, percentages and font units", () => {
  const css = [
    ".btn { gap: var(--space-2); padding: 0 var(--space-4); }",
    ".x { margin: 0 auto; padding: 1px var(--space-3) 0; row-gap: 2%; }",
    ".y { margin-top: calc(-1 * var(--space-2)); column-gap: .5em; }",
    ".z { padding-bottom: max(var(--space-3), env(safe-area-inset-bottom)); }",
    ".w { margin-block: 1.2rem; padding-inline-start: var(--pad, 6px); }",
    ".v { scroll-padding: 40px; --card-padding: 12px; inset: 8px; }",
    "  Object.assign(el.style, { gap: 8, padding: `var(--space-3)` });",
    "function place(gap: number, margin = 4) { return gap + margin; }",
    ".n { margin: -1px 0 0; padding: var(--pad, max(6px, 8px)); }",
  ].join("\n");
  expect(values(css)).toEqual([]);
});

test("reports raw lengths in CSS, markup and TypeScript styles", () => {
  const text = [
    ".btn { gap: 6px; padding: 0 12px; }",
    '<div style="margin:0 0 7px">x</div>',
    ".m { margin: -3px 12px 7px; } .s { padding: max(7px, env(safe-area-inset-bottom)); }",
    '  Object.assign(el.style, { paddingLeft: "10px", rowGap: "4px" });',
    'el.style.margin = "6px 0 0";',
    '  el.style.setProperty("column-gap", "2px");',
    ".up { PADDING-TOP: 1.5px; } .geo { padding-bottom: 48px; }",
    ".neg { margin: -3px; } .neg2 { margin-top: -1.5px; } .caps { gap: 8PX; }",
    '  Object.assign(el.style, { gap: 8, padding: "12px" });',
    '  const s = { "padding": "8px" };',
  ].join("\n");
  expect(values(text)).toEqual([
    "1:6px",
    "1:0 12px",
    "2:0 0 7px",
    "3:-3px 12px 7px",
    "3:max(7px, env(safe-area-inset-bottom))",
    "4:10px",
    "4:4px",
    "5:6px 0 0",
    "6:2px",
    "7:1.5px",
    "7:48px",
    "8:-3px",
    "8:-1.5px",
    "8:8PX",
    "9:12px",
    "10:8px",
  ]);
});

test("comments and allowed lines are exempt; pending counts are exact", () => {
  const text = [
    "/* .old { padding: 7px; } */ .a { gap: var(--space-1); }",
    ".composer-room { padding-bottom: 96px; } /* space-check: allow geometry */",
    '  el.style.gap = "3px"; // was gap: 5px',
  ].join("\n");
  expect(values(text)).toEqual(["3:3px"]);
  const files = [
    { file: "web/a.css", text: ".a { gap: 6px; } .b { gap: 10px; }" },
  ];
  expect(checkFiles(files, { "web/a.css": 2 })).toEqual([]);
  expect(checkFiles(files, { "web/a.css": 3 })).toEqual([
    "web/a.css: 2 raw spacing lengths, PENDING expects 3; lower its PENDING count",
  ]);
  expect(checkFiles(files, {})).toEqual([
    "web/a.css:1: spacing 6px should use --space-1 to --space-6",
    "web/a.css:1: spacing 10px should use --space-1 to --space-6",
  ]);
});
