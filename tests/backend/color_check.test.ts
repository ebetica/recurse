import { expect, test } from "bun:test";
import { findColors } from "../checks/color_check.ts";

const literals = (file: string, text: string) =>
  findColors(file, text).map(({ line, literal }) => `${line}:${literal}`);

test("named colours in TypeScript style values are reported", () => {
  const ts = [
    'el.style.color = "red"; el.title = "red";',
    'Object.assign(el.style, { backgroundColor: "White", label: "navy" });',
    'el.style.setProperty("border-color", "black");',
    'const s = { "outline-color": `teal`, "--ring": "gold" };',
    'el.style.boxShadow = "0 0 0 1px silver";',
    'el.style.color = "var(--fg)"; el.style.fill = "none";',
    "el.style.color = `${tone}`; el.style.background = shade;",
    'el.style.color = "tan"; // color-check: allow',
    'el.style.setProperty("COLOR", "r\\u0065d"); s = { "Background-Color": "navy" };',
    "el.style.color = `\\u0020 // color-check: allow",
    "r\\u0065d`;",
    'el.style.color = "\\',
    '  blue";',
    'el.style.color = "r\\',
    'ed";',
  ].join("\n");
  expect(literals("web/x.ts", ts)).toEqual([
    "1:red",
    "2:White",
    "3:black",
    "4:teal",
    "4:gold",
    "5:silver",
    "9:red",
    "9:navy",
    "11:red",
    "13:blue",
    "14:red",
  ]);
});
