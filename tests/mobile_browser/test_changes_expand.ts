import { expect } from "bun:test";
import type { Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pythonDiff from "./fixtures/diff-highlight.json";
import {
  captureErrors,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

const lines = (n: number, changed: Record<number, string> = {}): string[] =>
  Array.from({ length: n }, (_, i) => changed[i + 1] ?? `line ${i + 1} body`);
const BIG_PATCH = [
  "diff --git a/src/big.txt b/src/big.txt",
  "index 111..222 100644",
  "--- a/src/big.txt",
  "+++ b/src/big.txt",
  "@@ -27,7 +27,7 @@",
  " line 27 body",
  " line 28 body",
  " line 29 body",
  "-line 30 body",
  "+line 30 CHANGED",
  " line 31 body",
  " line 32 body",
  " line 33 body",
  "@@ -97,7 +97,7 @@",
  " line 97 body",
  " line 98 body",
  " line 99 body",
  "-line 100 body",
  "+line 100 CHANGED",
  " line 101 body",
  " line 102 body",
  " line 103 body",
].join("\n");
const SMALL_PATCH = [
  "diff --git a/src/small.txt b/src/small.txt",
  "index 111..222 100644",
  "--- a/src/small.txt",
  "+++ b/src/small.txt",
  "@@ -2,7 +2,7 @@",
  " line 2 body",
  " line 3 body",
  " line 4 body",
  "-line 5 body",
  "+line 5 CHANGED",
  " line 6 body",
  " line 7 body",
  " line 8 body",
].join("\n");
const summary = {
  available: true,
  base: "origin/main",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  files: [
    { path: "src/big.txt", additions: 2, deletions: 2, status: "modified" },
    { path: "src/small.txt", additions: 1, deletions: 1, status: "modified" },
  ],
  moreFiles: 0,
  untracked: [],
  truncated: false,
  version: "expand-fixture",
};

async function openChanges(page: Page, base: string, mobile: boolean) {
  const fixture = await postFixture(base, "seed-files-pane");
  const demo = String(fixture.demo);
  const seen = { contents: 0 };
  await page.route(`**/api/conversations/${demo}/diff*`, (route) =>
    route.fulfill({ json: summary }),
  );
  await page.route(`**/api/conversations/${demo}/diff/files*`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("contents") === "1") seen.contents++;
    const small = url.searchParams.get("path")?.includes("small");
    return route.fulfill({
      json: {
        available: true,
        path: url.searchParams.get("path"),
        patch: small ? SMALL_PATCH : BIG_PATCH,
        truncated: false,
        oldContent: lines(120).join("\n") + "\n",
        newContent:
          lines(120, { 30: "line 30 CHANGED", 100: "line 100 CHANGED" }).join(
            "\n",
          ) + "\n",
        contentsTruncated: false,
        contentsBinary: false,
      },
    });
  });
  await page.goto(`${base}#agent=${demo}`, { waitUntil: "domcontentloaded" });
  await page.locator("#conv-title").waitFor();
  if (mobile) {
    await page.evaluate("document.querySelector('#pane-fab')?.click()");
    await page.locator('.pane-menu-item[data-pane="diff"]').click();
  } else {
    await page.locator('.rail-btn[data-pane="diff"]').click();
  }
  const pane = page.locator('.pane-col[data-pane="diff"]');
  await pane.locator(".diff-file-toggle").first().waitFor();
  return { pane, seen };
}

export const tests: BrowserTest[] = [
  async function test_changes_expand_desktop(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const opened = await openChanges(page, base, false);
    const { pane } = opened;
    const big = pane.locator(".diff-file:visible", {
      hasText: "src/big.txt",
    });
    await big.locator(".diff-gap-btn:visible").first().waitFor();
    const button = (name: string) =>
      big.getByRole("button", { name, exact: true });
    expect(await button("Show the 26 lines above").count()).toBe(1);
    expect(await button("Show 40 more lines above").count()).toBe(1);
    expect(await button("Show every hidden line in this gap").count()).toBe(1);
    expect(await button("Show 40 more lines below").count()).toBe(1);
    expect(opened.seen.contents).toBe(2);
    await button("Show the 26 lines above").click();
    await big.getByText("line 1 body").waitFor({ timeout: 15000 });
    expect(await big.getByText("@@ -27,7 +27,7 @@").count()).toBe(1);
    await button("Show 40 more lines below").click();
    await big.getByText("line 34 body").waitFor({ timeout: 15000 });
    expect(opened.seen.contents).toBe(2);
    await pane.getByLabel("Changes options", { exact: true }).click();
    await pane.locator(".diff-expand-all").click();
    await pane.getByLabel("Changes options", { exact: true }).click();
    await pane
      .locator(".diff-expand-all")
      .filter({ hasText: "Collapse all" })
      .waitFor();
    await pane
      .locator(".diff-file", { hasText: "src/small.txt" })
      .locator(".diff-patch")
      .waitFor();
    await pane.getByText("line 60 body").waitFor({ timeout: 15000 });
    await pane.locator(".diff-row.add").first().waitFor();
    await pane
      .locator(".diff-expand-all")
      .filter({ hasText: "Collapse all" })
      .click();
    await pane.getByLabel("Changes options", { exact: true }).click();
    await pane
      .locator(".diff-expand-all")
      .filter({ hasText: "Expand all" })
      .waitFor();
    await page.waitForFunction(
      "!document.body.textContent?.includes('line 60 body')",
      null,
      { timeout: 15000 },
    );
    expect(await pane.locator(".diff-row.add").count()).toBeGreaterThanOrEqual(
      2,
    );
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_changes_expand_mobile(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const { pane } = await openChanges(page, base, true);
    const small = pane.locator(".diff-file:visible", {
      hasText: "src/small.txt",
    });
    await small.locator(".diff-gap-btn:visible").first().waitFor();
    await small
      .getByRole("button", { name: "Show the 1 line above", exact: true })
      .tap();
    await small.getByText("line 1 body").waitFor({ timeout: 15000 });
    expect(errors).toEqual([]);
    await context.close();
  },
];

export const highlightingTests: BrowserTest[] = [1280, 412].map(
  (width) =>
    // Regression: #2380 patch-only syntax state must not cross hidden file lines. (also #2457 a note in the code wraps inside the visible patch.)
    async function test_changes_hidden_python(browser, base) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const { demo } = await postFixture(base, "seed-files-pane");
      const theme = await page.request.post(`${base}api/settings/theme`, {
        data: { theme: "Solarized Dark" },
      });
      expect(theme.status()).toBe(200);
      await page.route(`**/api/conversations/${demo}/diff*`, (route) =>
        route.fulfill({
          json: {
            ...summary,
            files: [
              {
                path: "panels.py",
                additions: 3,
                deletions: 3,
                status: "modified",
              },
            ],
            target: { kind: "pr", id: "python-pr", number: 42 },
          },
        }),
      );
      let fullContents = false;
      await page.route(`**/api/conversations/${demo}/diff/files*`, (route) =>
        route.fulfill({
          json: {
            available: true,
            path: "panels.py",
            patch: pythonDiff.patch,
            truncated: false,
            ...(fullContents ? pythonDiff : {}),
          },
        }),
      );
      await page.goto(`${base}#agent=${demo}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#conv-title").waitFor();
      if (width === 412) {
        await page.locator("#pane-fab").click();
        await page.locator('.pane-menu-item[data-pane="diff"]').click();
      } else await page.locator('.rail-btn[data-pane="diff"]').click();
      const pane = page.locator('.pane-col[data-pane="diff"]');
      await pane.locator(".diff-expand-note").waitFor();
      const shotDir = process.env.RECURSE_SCREENSHOT_DIR;
      if (shotDir) {
        await mkdir(shotDir, { recursive: true });
        await page.screenshot({
          path: join(shotDir, `highlight-${width}.png`),
        });
      }
      for (const mode of ["Unified", "Split"]) {
        await pane.getByLabel("Changes options", { exact: true }).click();
        await pane.getByRole("button", { name: mode, exact: true }).click();
        for (const side of ["old", "new"]) {
          const rows = pane.locator(`[data-side="${side}"]`);
          const doc = rows
            .filter({ hasText: `Each panel row's ${side} fields` })
            .locator(".diff-src");
          await doc.waitFor();
          expect(await doc.locator(".hljs-string").allTextContents()).toEqual([
            `\"\"\"Each panel row's ${side} fields as the loader builds them`,
          ]);
          expect(await doc.locator(".hljs-keyword").count()).toBe(0);
          const code = rows.filter({ hasText: `return \"${side} fields\"` });
          expect(await code.locator(".hljs-keyword").textContent()).toBe(
            "return",
          );
          expect(await code.locator(".hljs-string").textContent()).toBe(
            `\"${side} fields\"`,
          );
        }
        const overhang = await page.evaluate(`(() => {
          const patch = document.querySelector('.pane-col[data-pane="diff"] .diff-patch');
          const note = patch.querySelector('.diff-expand-note');
          return note.getBoundingClientRect().right - patch.getBoundingClientRect().right;
        })()`);
        expect(overhang).toBeLessThanOrEqual(1);
      }
      fullContents = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await pane.locator(".diff-gap-btn").first().waitFor();
      for (const side of ["old", "new"]) {
        const code = pane.locator(`[data-side="${side}"]`).filter({
          hasText: `return \"${side === "old" ? "before" : "after"}\"`,
        });
        expect(await code.locator(".hljs-keyword").textContent()).toBe(
          "return",
        );
      }
      expect(errors).toEqual([]);
      await context.close();
    },
);
tests.push(...highlightingTests);

if (import.meta.main) await runBrowserTests([["changes-expand", tests]]);
