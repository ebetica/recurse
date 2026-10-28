import { describe, expect, test } from "bun:test";
import { shortCwd } from "../../web/diff/model.js";

describe("thin diff model", () => {
  test("shortCwd shortens only the home prefix", () => {
    const home = process.env["HOME"] || "";
    expect(shortCwd(null)).toBe("");
    if (home) {
      expect(shortCwd(home + "/code/recurse")).toBe("~/code/recurse");
      expect(shortCwd(home)).toBe("~");
    }
    expect(shortCwd("/tmp/other")).toBe("/tmp/other");
  });
});
