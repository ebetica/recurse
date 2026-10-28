import { expect, test } from "bun:test";
import { checkFiles, findFonts } from "../checks/font_check.ts";

const values = (text: string) =>
  findFonts(text).map(
    ({ line, value, problem }) => `${line}:${problem}:${value}`,
  );

test("accepts the scale, relative sizes, keywords and the font tokens", () => {
  const css = [
    ".badge { font-size: 10.5px; } .meta { font-size: 11.5px; }",
    ".tool { font: 12.5px/1.5 var(--font-mono); } .menu { font-size: 13.5px; }",
    "body { font: 15px/1.6 var(--font-sans); } input { font-size: 16px; }",
    ".dialog h2 { font: 700 17px/1.2 inherit; } .page h2 { font-size: 20px; }",
    ".content h1 { font-size: 1.25em; } .x { font: inherit; font-size: smaller; }",
    ".code { font-family: var(--font-mono); } .y { font-size: var(--size, 12px); }",
    "  editor.style.font = `600 ${fontSize}px var(--font-sans)`;",
    ".z { font-size: var(--size, calc(12px + 1px)); } .w { font: 1rem/18px var(--font-sans); }",
    ".v { font-size: 12.50px; } .u { font: 600 13.5px/20px var(--font-sans); }",
    "  Object.assign(el.style, { font: f, width: '20px' });",
    ".t { font: 1rem/calc(18px + 2px) var(--font-sans); }",
    ".a { font-weight: 400; } .b { font-weight: 600; } .c { font-weight: 700; }",
    ".d { font-weight: normal; } .e { font-weight: bold; } .f { font-weight: inherit; }",
    ".g { font-weight: var(--weight, 650); } .h { font: bold 15px/1.4 var(--font-sans); }",
    '  Object.assign(el.style, { fontWeight: "600" });',
    ".i { font-weight: 700 !important; } .j { FONT-WEIGHT: 400; }",
    '.k { font: 15px "Family 650 Name", var(--font-sans); }',
    "  el.style.fontWeight = 600;",
  ].join("\n");
  expect(values(css)).toEqual([]);
});

test("reports weights off the 400/600/700 scale", () => {
  const text = [
    ".agent .title { font-size: 13.5px; font-weight: 550; }",
    ".kbd { font: 650 10.5px/1.2 var(--font-mono); }",
    ".copy { font: 500 11.5px/1.4 var(--font-sans); }",
    '  Object.assign(el.style, { fontWeight: "800" });',
    ".x { font-weight: bolder; } .y { font-weight:300 }",
    ".pin { font: 650 13px/1 system-ui; }",
    ".bang { font-weight:650 !important; } .frac { font-weight: 650.5; }",
    '  Object.assign(el.style, { font: "650 15px var(--font-sans)" });',
    ".up { FONT-WEIGHT: 550; }",
    "  el.style.fontWeight = 650;",
    ".it { font: italic 500 15px/1.4 var(--font-sans); }",
    '  el.style.setProperty("font-weight", "550");',
  ].join("\n");
  expect(values(text)).toEqual([
    "1:weight:550",
    "2:weight:650 10.5px/1.2 var(--font-mono)",
    "3:weight:500 11.5px/1.4 var(--font-sans)",
    "4:weight:800",
    "5:weight:bolder",
    "5:weight:300",
    "6:weight:650 13px/1 system-ui",
    "6:size:650 13px/1 system-ui",
    "7:weight:650 !important",
    "7:weight:650.5",
    '8:weight:"650 15px var(--font-sans)"',
    "9:weight:550",
    "10:weight:650",
    "11:weight:italic 500 15px/1.4 var(--font-sans)",
    "12:weight:550",
  ]);
  expect(
    checkFiles([{ file: "index.html", text: ".z { font-weight: 650; }" }]),
  ).toEqual(["index.html:1: font weight 650 is off the 400/600/700 scale"]);
});

test("reports off-scale sizes and written-out monospace and sans-serif stacks", () => {
  const text = [
    ".old { font-size: 12px; }",
    ".pin { font: 600 13px/1 system-ui; }",
    '<span style="font-size:9px">x</span>',
    '  Object.assign(el.style, { fontSize: "14px" });',
    ".code { font: 12.5px/1.5 ui-monospace, Menlo, monospace; }",
    ".diff { font-family: ui-monospace,",
    "  SFMono-Regular, monospace; }",
    'el.style.fontFamily = "monospace";',
    '.q { font-family: "SF Mono", Menlo, monospace; }',
    '  Object.assign(el.style, { font: "600 14px sans-serif" });',
    ".tiny { font-size: .5px; }",
    "  Object.assign(el.style, { font: `600 14px monospace` });",
    'body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    ".chip { font-family: system-ui; }",
    '  Object.assign(el.style, { fontFamily: "sans-serif" });',
    '  el.style.setProperty("font-family", "\\"Arial\\", sans-serif");',
  ].join("\n");
  expect(values(text)).toEqual([
    "1:size:12px",
    "2:size:600 13px/1 system-ui",
    "3:size:9px",
    "4:size:14px",
    "5:mono:12.5px/1.5 ui-monospace, Menlo, monospace",
    "6:mono:ui-monospace, SFMono-Regular, monospace",
    "8:mono:monospace",
    '9:mono:"SF Mono", Menlo, monospace',
    '10:size:"600 14px sans-serif"',
    "11:size:.5px",
    "12:size:`600 14px monospace`",
    '13:sans:15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    "14:sans:system-ui",
    "15:sans:sans-serif",
    '16:sans:"Arial", sans-serif',
  ]);
});

test("comments and allowed lines are exempt", () => {
  const text = [
    "/* was font-size: 12px; */ .menu { font-size: 13.5px; }",
    "<!-- font: 11px monospace -->",
    '// was fontSize: "12px"',
    ".nav { font-size: 28px; } /* font-check: allow arrow glyph */",
  ].join("\n");
  expect(values(text)).toEqual([]);
  expect(
    checkFiles([
      { file: "web/app.css", text: ".x { font-size: 13px; }" },
      { file: "web/diff/style.css", text: ".y { font-family: monospace; }" },
      { file: "index.html", text: ".z { font: 600 12.5px/1 system-ui; }" },
    ]),
  ).toEqual([
    "web/app.css:1: font size 13px is off the 10.5/11.5/12.5/13.5/15/16/17/20px scale",
    "web/diff/style.css:1: monospace font monospace should use var(--font-mono)",
    "index.html:1: sans-serif font 600 12.5px/1 system-ui should use var(--font-sans)",
  ]);
});
