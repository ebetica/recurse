import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { gotoRoot, runBrowserTests, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2433 wait for the real comment button to be actionable.
  async function test_changes_comment_bar(browser, base) {
    for (const width of [1280, 390]) {
      for (const lines of [2, 100]) {
        const context = await browser.newContext({
          viewport: { width, height: width === 1280 ? 800 : 844 },
        });
        const page = await context.newPage();
        const content = Array.from(
          { length: lines },
          (_, i) => `Review line ${i + 1}`,
        );
        await page.route("**/api/conversations/**/diff**", (route) =>
          route.fulfill({
            json: route.request().url().includes("/files")
              ? {
                  available: true,
                  path: "review.txt",
                  patch: `diff --git a/review.txt b/review.txt\n--- a/review.txt\n+++ b/review.txt\n@@ -1,${lines} +1,${lines} @@\n${content.map((line) => `-Old ${line}`).join("\n")}\n${content.map((line) => `+${line}`).join("\n")}\n`,
                  truncated: false,
                  oldContent:
                    content.map((line) => `Old ${line}`).join("\n") + "\n",
                  newContent: content.join("\n") + "\n",
                  contentsTruncated: false,
                  contentsBinary: false,
                }
              : {
                  available: true,
                  base: "HEAD",
                  version: `review-${lines}`,
                  files: [
                    {
                      path: "review.txt",
                      additions: lines,
                      deletions: lines,
                      status: "modified",
                    },
                  ],
                  untracked: [],
                },
          }),
        );
        await gotoRoot(page, base);
        expect(await page.locator(".pane-col").count()).toBe(0);
        expect(
          await page
            .locator("#topbar")
            .evaluate((node) => node.getBoundingClientRect().y),
        ).toBeGreaterThanOrEqual(0);
        if (width === 390) {
          await page.locator("#pane-fab").click();
          await page.locator('.pane-menu-item[data-pane="diff"]').click();
        } else await page.locator('.rail-btn[data-pane="diff"]').click();
        await page
          .locator('.diff-row.add[data-line="1"] .diff-add-comment')
          .click();
        await page
          .locator(".diff-line-input")
          .fill("Please review this change");
        const bar = page.locator(".diff-sendbar.on");
        await bar.waitFor();
        const pane = page.locator('.pane-body[data-pane="diff"]');
        const scroller = page.locator(
          width === 390 ? '.pane-col[data-pane="diff"]' : ".diff-list",
        );
        if (lines === 100) {
          await pane.focus();
          expect(
            await page
              .locator(".diff-list")
              .evaluate((node) => node === node.ownerDocument.activeElement),
          ).toBe(true);
          const before = await scroller.evaluate((node) => node.scrollTop);
          await page.keyboard.press("PageDown");
          await page.waitForFunction(
            ({ start, selector }) =>
              (globalThis as any).document.querySelector(selector).scrollTop >
              start,
            {
              start: before,
              selector:
                width === 390 ? '.pane-col[data-pane="diff"]' : ".diff-list",
            },
          );
        }
        await scroller.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        const paneBox = (await (
          width === 390 ? scroller : pane
        ).boundingBox())!;
        const barBox = (await bar.boundingBox())!;
        const gap = paneBox.y + paneBox.height - barBox.y - barBox.height;
        console.log(`Changes ${width}px/${lines} lines: footer gap ${gap}px`);
        expect(Math.abs(gap)).toBeLessThanOrEqual(2);
        const last = page.locator(`.diff-row.add[data-line="${lines}"]`);
        const lastBox = (await last.boundingBox())!;
        expect(lastBox.y).toBeGreaterThanOrEqual(paneBox.y);
        expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);
        const codeBox = (await last.locator(".diff-line").boundingBox())!;
        await page.mouse.move(codeBox.x + 8, codeBox.y + codeBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(codeBox.x + 150, codeBox.y + codeBox.height / 2, {
          steps: 10,
        });
        await page.mouse.up();
        expect(await page.evaluate("getSelection().toString()")).toContain(
          `Review line ${lines}`,
        );
        const dir = process.env.RECURSE_SCREENSHOT_DIR;
        if (dir) {
          await mkdir(dir, { recursive: true });
          await page.screenshot({
            path: `${dir}/changes-${lines === 2 ? "short" : "long"}-${width}.png`,
          });
        }
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator(".diff-sendbar-clear").click();
        await bar.waitFor({ state: "hidden" });
        await scroller.evaluate((node) => {
          node.scrollTop = 0;
        });
        await page.locator('.pane-col[data-pane="diff"] .pane-head .x').click();
        await page.locator(".pane-col").waitFor({ state: "detached" });
        expect(
          await page
            .locator("#topbar")
            .evaluate((node) => node.getBoundingClientRect().y),
        ).toBeGreaterThanOrEqual(0);
        expect(
          await page
            .locator("body")
            .evaluate((node) => node.classList.contains("pane-chrome-hidden")),
        ).toBe(false);
        await context.close();
      }
    }
  },
];
if (import.meta.main) await runBrowserTests([["changes-comment-bar", tests]]);
