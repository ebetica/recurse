import { expect, test } from "bun:test";
import { checkFiles, findRadii } from "../checks/radius_check.ts";

const values = (text: string) =>
  findRadii(text).map(({ line, value }) => `${line}:${value}`);

test("accepts the scale, pills, circles, inherit and tokens", () => {
  const css = [
    ".kbd { border-radius: 6px; } .btn { border-radius: 8px; }",
    ".card { border-radius: 10px; } .dialog { border-radius: 14px; }",
    ".chip { border-radius: 999px; } .dot { border-radius: 50%; }",
    ".sheet { border-radius: 14px 14px 0 0; } .img { border-radius: inherit; }",
    ".x { border-top-left-radius: var(--corner) !important; }",
    ".y { border-radius: var(--corner, 8px) 6px / 50%; --border-radius: 12px; }",
    ".z { border-radius: var(--corner, var(--fallback)); }",
    '  el.style.setProperty("border-radius", `${r}px`);',
    '  el.style.setProperty("border-radius", "5" + unit);',
  ].join("\n");
  expect(values(css)).toEqual([]);
});

test("reports off-scale lengths in CSS, markup and TypeScript styles", () => {
  const text = [
    ".menu { padding: 6px; border-radius: 12px; }",
    ".bubble { border-radius: 15px 15px 4px 15px; }",
    ".tail { border-bottom-right-radius: 4px; }",
    '<p style="border-radius:7px">x</p>',
    '  Object.assign(el.style, { width: "20px", borderRadius: "4px" });',
    ".wrap { border-radius: 6px",
    "  12px; }",
    ".pin { border-radius: 9px !important; }",
    'chip.style.borderRadius = "5px";',
    "  el.style.setProperty(",
    '    "border-radius",',
    '    "5px",',
    "  );",
    ".up { BORDER-RADIUS: 7px; }",
    '  el.style.setProperty("border-radius", "5px", "important");',
    '  el.style.setProperty("border-radius", `6px',
    "    12px`);",
    ".x { border-radius: 5px; }",
  ].join("\n");
  expect(values(text)).toEqual([
    "1:12px",
    "2:15px 15px 4px 15px",
    "3:4px",
    "4:7px",
    "5:4px",
    "6:6px 12px",
    "8:9px !important",
    "9:5px",
    "12:5px",
    "14:7px",
    "15:5px",
    "16:6px 12px",
    "18:5px",
  ]);
});

test("comments and allowed marks are exempt", () => {
  const text = [
    "/* was border-radius: 12px; */ .menu { border-radius: 10px; }",
    "<!-- border-radius: 3px -->",
    '// was borderRadius: "12px"',
    'const n = 1;// borderRadius: "12px"',
    'const url = "http://x"; el.style.borderRadius = "8px";',
    ".dot { border-radius: 2px; } /* radius-check: allow a mark, not a corner */",
  ].join("\n");
  expect(values(text)).toEqual([]);
  expect(
    checkFiles([{ file: "web/app.css", text: ".x { border-radius: 5px; }" }]),
  ).toEqual([
    "web/app.css:1: border radius 5px is off the 6/8/10/14px, 999px, 50% scale",
  ]);
});
