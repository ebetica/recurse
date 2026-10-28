import { expect, test } from "bun:test";
import { checkFiles, findSvg } from "../checks/svg_check.ts";

const lines = (file: string, ...text: string[]) =>
  findSvg(text.join("\n"), file).map(({ line }) => line);

test("accepts empty icon slots, look-alike tags and type arguments", () => {
  expect(
    lines(
      "index.html",
      '<button aria-label="Close"><svg data-icon="CLOSE_ICON"></svg></button>',
      "<textarea id=input></textarea> <link rel=icon> <use-case>",
    ),
  ).toEqual([]);
  expect(
    lines(
      "web/app.ts",
      "const rows: Array<Line> = []; const m = new Map<string, Text>();",
      "type text = string; const values: Array<text> = [];",
      "const p = load<path>(x) as Promise<Rect[]>;",
      "const identity = <Text>(value: Text): Text => value;",
      "type Identity = <Text>(value: Text) => Text;",
      "const value: Array <Text> = []; const t = <svg>(x as unknown);",
      'el.innerHTML = icon("SEND_ICON"); import { html } from "lit";',
      "const q = /'/; const rows: Array<Line> = [];",
    ),
  ).toEqual([]);
});

test("reports SVG tags in any case, the SVG namespace and Lit svg", () => {
  expect(
    lines(
      "web/app.ts",
      'b.innerHTML = \'<SVG width="16"><path d="M4 4h16"/></SVG>\';',
      'const dot = `<circle cx="4" cy="4" r="3"/>`;',
      'document.createElementNS ("http://www.w3.org/2000/svg", "svg");',
      "return svg `${body}`;",
      'import { html, svg as s } from "lit";',
      'const url = "//cdn.example"; el.innerHTML = "<svg><path/></svg>";',
      "const t = `${a ? `//x` : b}<svg>`;",
      'const q = /"/; const icon = "<path d=\'M0 0\'/>";',
      'const u = `url("data:image/svg+xml,${encodeURIComponent(s)}")`;',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(
    lines(
      "web/app.css",
      '.x { background: url("DATA:image/svg+xml,%3Csvg%3E"); }',
    ),
  ).toEqual([1]);
  expect(
    lines(
      "index.html",
      '<SVG><PATH d="M0 0"/></SVG>',
      '<svg data-icon="SEND_ICON" class="lg"></svg>',
      '<svg data-icon="SEND_ICON"> </svg>',
    ),
  ).toEqual([1, 2, 3]);
});

test("comments, allowed lines and web/icons.ts are exempt", () => {
  expect(
    lines(
      "web/app.ts",
      'const a = 1; /* <svg viewBox="0 0 24 24"> */',
      "// an empty <svg data-icon> slot is filled by the server",
      "const b = `${c /* <path d> */}`; // <circle r=1/>",
      'const ring = `<svg width="8"></svg>`; // svg-check: allow cursor ring',
      'const u = `url("data:image/svg+xml,${ring}")`; // svg-check: allow',
    ),
  ).toEqual([]);
  expect(
    lines(
      "index.html",
      '<!-- <svg><path d="M0 0"/></svg> -->',
      ".x { color: red; } /* <rect width=4/> */",
    ),
  ).toEqual([]);
  const markup = 'export const X = `<svg><path d="M0 0"/></svg>`;';
  expect(
    checkFiles([
      { file: "web/icons.ts", text: markup },
      { file: "web/app.ts", text: markup },
    ]),
  ).toEqual(["web/app.ts:1: inline SVG <svg> belongs in web/icons.ts"]);
});
