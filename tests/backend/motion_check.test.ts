import { expect, test } from "bun:test";
import { findMotion } from "../checks/motion_check.ts";

const values = (text: string) =>
  findMotion(text).map(({ line, value }) => `${line}:${value}`);

test("accepts tokens, zero, none, loops and marked lines", () => {
  const css = [
    ".a { transition: opacity var(--motion-fast), transform",
    "  var(--motion-move) ease; }",
    ".b { animation: reveal-in var(--motion-enter) ease-out both; }",
    ".c { animation-duration: var(--motion-fast); transition: none; }",
    ".d { transition: opacity 0s; animation: pulse 1.2s infinite; }",
    ".e { animation-delay: .4s; transition-property: opacity; }",
    ".h { animation: pulse 1.2s infinite, spin calc(2s) linear infinite; }",
    '  row.style.transition = "transform var(--motion-move) ease";',
    ".f { animation: jump 1.8s ease-out; } /* motion-check: allow */",
    "/* was transition: opacity .15s; */ .g { opacity: 1; }",
    "  el.style.setProperty(",
    '    "transition",',
    '    "opacity .2s", // motion-check: allow',
    "  );",
  ].join("\n");
  expect(values(css)).toEqual([]);
});

test("reports time literals and unknown motion tokens", () => {
  const text = [
    ".a { transition: color .12s, border-color .12s; }",
    ".b { transition: opacity var(--motion-fast),",
    "  transform 200ms; }",
    ".c { animation: fade 1s ease-out both; }",
    ".d { animation-duration: 100ms; }",
    ".e { transition: opacity var(--motion-slow); }",
    '  row.style.transition = "transform .18s ease";',
    '  Object.assign(el.style, { transitionDuration: "2s" });',
    '<div style="transition: opacity .2s">x</div>',
    ".f { animation: pulse 1.2s infinite, fade 2s both; }",
    ".g { transition: infinite .2s; }",
    `  const a = { "transition": "opacity .2s", 'animationDuration': '2s' };`,
    '  el.style.setProperty("transition", "opacity .2s");',
    ".up { TRANSITION: opacity .2s; }",
    "  el.style.setProperty(",
    '    "transition",',
    '    "opacity .2s",',
    "  );",
  ].join("\n");
  expect(values(text)).toEqual([
    "1:color .12s, border-color .12s",
    "2:opacity var(--motion-fast), transform 200ms",
    "4:fade 1s ease-out both",
    "5:100ms",
    "6:opacity var(--motion-slow)",
    "7:transform .18s ease",
    "8:2s",
    "9:opacity .2s",
    "10:pulse 1.2s infinite, fade 2s both",
    "11:infinite .2s",
    "12:opacity .2s",
    "12:2s",
    "13:opacity .2s",
    "14:opacity .2s",
    "17:opacity .2s",
  ]);
});
