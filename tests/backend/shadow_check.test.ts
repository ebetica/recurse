import { expect, test } from "bun:test";
import { checkFiles, findShadows } from "../checks/shadow_check.ts";

const values = (text: string) =>
  findShadows(text).map(({ line, value }) => `${line}:${value}`);

test("accepts tokens, rings, inset borders, glows, none and inherit", () => {
  const css = [
    ".card { box-shadow: var(--expanded-lift); }",
    ".menu { box-shadow: var(--menu-shadow) !important; }",
    ".sel { box-shadow: inset 0 0 0 1px var(--accent-dim); }",
    ".dot { box-shadow: 0 0 0 2px var(--panel), 0 0 8px color-mix(in srgb, var(--accent) 55%, transparent); }",
    ".mark { box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), var(--dialog-shadow); }",
    ".x { box-shadow: none; } .y { box-shadow: inherit; } .z { --box-shadow: 0 4px 8px #000; }",
    ".calc { box-shadow: calc(0px) calc(0px) 8px black; }",
    ".pin { box-shadow: 0 calc(0px)!important; }",
    ".glow { text-shadow: 0 0 6px var(--accent); filter: drop-shadow(0 0 4px var(--accent)); }",
    ".lift { filter: drop-shadow(var(--lift)) blur(2px); }",
  ].join("\n");
  expect(values(css)).toEqual([]);
});

test("reports offset shadows in CSS, markup and TypeScript styles", () => {
  const text = [
    ".toast { box-shadow: 0 5px 18px color-mix(in srgb, var(--shadow) 38%, transparent); }",
    ".pill { box-shadow: 0 0 0 1px var(--border), 0 2px 4px #0008; }",
    '<div style="box-shadow:2px 0 6px black">x</div>',
    '  Object.assign(el.style, { boxShadow: "0 1px 3px rgba(0,0,0,.3)" });',
    ".wrap { box-shadow: 0",
    "  -.5rem 10px var(--shadow); }",
    'el.style.boxShadow = "inset 0 1px 0 var(--border)";',
    ".vh { box-shadow: 1vh 0 0 black; } .plus { box-shadow: +1px 0 0 black; }",
    ".fn { box-shadow: calc(1px) 0 0 black; }",
    ".pin { box-shadow: 0 1px!important; }",
    '  el.style.setProperty("box-shadow", "0 2px 4px black");',
    ".up { BOX-SHADOW: 0 2px 4px black; }",
    ".t { text-shadow: 0 1px 2px black; } .f { filter: blur(1px) drop-shadow(0 2px 4px rgb(0 0 0 / 30%)); }",
    '  Object.assign(el.style, { textShadow: "1px 1px black", filter: "drop-shadow(2px 0 0 red)" });',
  ].join("\n");
  expect(values(text)).toEqual([
    "1:0 5px 18px color-mix(in srgb, var(--shadow) 38%, transparent)",
    "2:0 0 0 1px var(--border), 0 2px 4px #0008",
    "3:2px 0 6px black",
    "4:0 1px 3px rgba(0,0,0,.3)",
    "5:0 -.5rem 10px var(--shadow)",
    "7:inset 0 1px 0 var(--border)",
    "8:1vh 0 0 black",
    "8:+1px 0 0 black",
    "9:calc(1px) 0 0 black",
    "10:0 1px!important",
    "11:0 2px 4px black",
    "12:0 2px 4px black",
    "13:0 1px 2px black",
    "13:0 2px 4px rgb(0 0 0 / 30%)",
    "14:1px 1px black",
    "14:2px 0 0 red",
  ]);
});

test("comments and allowed lines are exempt", () => {
  const text = [
    "/* was box-shadow: 0 4px 14px #000; */ .btn { box-shadow: var(--expanded-lift); }",
    "<!-- box-shadow: 0 2px 2px black -->",
    '// was boxShadow: "0 2px 2px black"',
    ".thumb { box-shadow: 0 1px 4px var(--shadow); } /* shadow-check: allow slider thumb */",
  ].join("\n");
  expect(values(text)).toEqual([]);
  expect(
    checkFiles([
      { file: "web/app.css", text: ".x { box-shadow: 0 1px 2px #000; }" },
    ]),
  ).toEqual([
    "web/app.css:1: drop shadow 0 1px 2px #000 should use --expanded-lift, --menu-shadow or --dialog-shadow",
  ]);
});
