import type { DiffFile } from "@git-diff-view/core";
import { describe, expect, test } from "bun:test";
import { renderPatch, splitView } from "../../web/diff/render.js";
import pythonDiff from "../mobile_browser/fixtures/diff-highlight.json";

const PATCH = [
  "diff --git a/app.ts b/app.ts",
  "index 111..222 100644",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1,3 +1,3 @@",
  " const x = 1;",
  "-old call(arg);",
  "+new call(arg, extra);",
  " context line",
  "@@ -10,2 +10,3 @@",
  " tail one",
  "-tail two",
  "+tail two changed",
  "+const tailThree = 3;",
].join("\n");

async function build(patch: string, path: string) {
  const core = await import("@git-diff-view/core");
  const lang = core.getLang(path);
  const file: DiffFile = new core.DiffFile(
    path,
    "",
    path,
    "",
    [patch],
    lang,
    lang,
  );
  file.initTheme("dark");
  file.init();
  return { core, file };
}

describe("diff-render", () => {
  // Regression: #1789 split hunk first content line was omitted
  test("split rows pair sides with placeholders for pure additions", async () => {
    const { core, file } = await build(PATCH, "app.ts");
    const rows = splitView(core, file);
    expect(rows.length).toBe(8);
    expect(rows[0].hunk).toContain("@@ -1,3 +1,3 @@");
    expect(rows[0].left).toBeNull();
    expect(rows[0].right).toBeNull();
    expect(rows[1].left).toMatchObject({ oldNo: 1, newNo: null });
    expect(rows[1].right).toMatchObject({ oldNo: null, newNo: 1 });
    expect(rows[2].left).toMatchObject({ kind: "del", oldNo: 2 });
    expect(rows[2].right).toMatchObject({ kind: "add", newNo: 2 });
    const pure = rows[rows.length - 1];
    expect(pure.left).toBeNull();
    expect(pure.right).toMatchObject({ kind: "add", newNo: 12 });
    expect(rows[1].right?.html).toContain("hljs-keyword");
    expect(pure.right?.html).toContain("hljs-keyword");
    expect(rows[3].hunk).toBeNull();
    expect(rows[4].hunk).toContain("@@ -10,2 +10,3 @@");
  });

  // Regression: #1789 split hunk first content line was omitted
  test("split rows render every content line including hunk openers", async () => {
    const { core, file } = await build(PATCH, "app.ts");
    const rows = splitView(core, file);
    const oldNos = rows.flatMap((r) =>
      r.left?.oldNo != null ? [r.left.oldNo] : [],
    );
    const newNos = rows.flatMap((r) =>
      r.right?.newNo != null ? [r.right.newNo] : [],
    );
    expect(oldNos).toEqual([1, 2, 3, 10, 11]);
    expect(newNos).toEqual([1, 2, 3, 10, 11, 12]);
  });

  // Regression: #2380 automatic language selection must also reset at gaps.
  test("patch-only unknown extensions isolate docstrings on both sides", async () => {
    const rows = await renderPatch(
      pythonDiff.patch,
      "panels.unknown",
      "unified",
    );
    const isolated = await renderPatch(
      pythonDiff.lastHunkPatch,
      "panels.unknown",
      "unified",
    );
    expect(rows).not.toBeNull();
    expect(isolated).not.toBeNull();
    for (const line of isolated!) {
      if (!("kind" in line) || !["del", "add"].includes(line.kind)) continue;
      const combined = rows!.find(
        (row) =>
          "kind" in row &&
          row.kind === line.kind &&
          row.oldNo === line.oldNo &&
          row.newNo === line.newNo,
      );
      expect(combined).toEqual(line);
    }
  });
});
