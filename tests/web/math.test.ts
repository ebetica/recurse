import { expect, test } from "bun:test";
import katex from "katex";
import { renderMath } from "../../web/math.js";

test("renders untrusted commands as text and bounds rendered output", () => {
  const unsafe = renderMath(
    katex,
    "\\href{javascript:alert(1)}{x}",
    false,
    "\\(unsafe\\)",
  );
  expect(unsafe).not.toContain("javascript:");
  const long = "\\(x" + "a".repeat(8_193) + "\\)";
  expect(renderMath(katex, long, false, long)).toBe(
    "\\(x" + "a".repeat(8_193) + "\\)",
  );
});
