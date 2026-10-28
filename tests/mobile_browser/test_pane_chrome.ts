import { expect } from "bun:test";
import { waitForPaneScroll, waitForPaneTransition } from "./pane_layout";
import { mkdir } from "node:fs/promises";
import {
  gotoRoot,
  postFixture,
  runBrowserTests,
  waitForLayout,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  async function test_pane_chrome(browser, base) {
    const app = await postFixture(base, "seed-artifact-app?reader=long");
    const observations: Array<{
      width: number;
      pane: string;
      hidden: boolean;
      controlsHidden: boolean;
      revealed: boolean;
      worktreeControlsClear: boolean;
      stable: boolean;
      scroll: number;
      frameWidth?: number;
      paneWidth?: number;
    }> = [];
    for (const width of [412, 1280]) {
      for (const pane of ["diff", "report"]) {
        const context = await browser.newContext({
          viewport: { width, height: 915 },
        });
        const page = await context.newPage();
        const lines = Array.from(
          { length: 100 },
          (_, i) => `Review line ${i + 1}`,
        );
        await page.route("**/api/conversations/**/diff**", (route) =>
          route.fulfill({
            json: route.request().url().includes("/files")
              ? {
                  available: true,
                  path: "review.txt",
                  patch: `diff --git a/review.txt b/review.txt\n--- a/review.txt\n+++ b/review.txt\n@@ -1,100 +1,100 @@\n${lines.map((line) => `-Old ${line}`).join("\n")}\n${lines.map((line) => `+${line}`).join("\n")}\n`,
                  truncated: false,
                  oldContent:
                    lines.map((line) => `Old ${line}`).join("\n") + "\n",
                  newContent: lines.join("\n") + "\n",
                  contentsTruncated: false,
                  contentsBinary: false,
                }
              : {
                  available: true,
                  base: "origin/main",
                  cwd: app.cwd,
                  version: "chrome-review",
                  files: [
                    {
                      path: "review.txt",
                      additions: 100,
                      deletions: 100,
                      status: "modified",
                    },
                  ],
                  untracked: [],
                },
          }),
        );
        await gotoRoot(page, base);
        if (pane === "report") {
          await page.locator(`a[href="#artifact=${app.id}"]`).click();
          await page
            .frameLocator("iframe.artifact-embed-page")
            .locator("body[data-ready]")
            .waitFor();
        } else {
          if (width === 412) {
            await page.locator("#pane-fab").click();
            await page.locator('.pane-menu-item[data-pane="diff"]').click();
          } else await page.locator('.rail-btn[data-pane="diff"]').click();
          await page
            .locator('.diff-row.add[data-line="1"] .diff-add-comment')
            .click({ force: true });
          await page
            .locator(".diff-line-input")
            .fill("Keep this comment bar visible");
          await page.locator(".diff-sendbar.on").waitFor();
        }
        const body = page.locator(`.pane-col[data-pane="${pane}"] .pane-body`);
        const scrollerSelector =
          width === 412
            ? `.pane-col[data-pane="${pane}"]`
            : pane === "diff"
              ? ".diff-list"
              : `.pane-col[data-pane="${pane}"] .pane-body`;
        const scroller =
          width === 412
            ? page.locator(`.pane-col[data-pane="${pane}"]`)
            : pane === "diff"
              ? page.locator(".diff-list")
              : body;
        await waitForPaneTransition(page, `.pane-col[data-pane="${pane}"]`);
        await scroller.evaluate((node) => {
          node.scrollTop = 0;
        });
        await waitForPaneScroll(
          page,
          scrollerSelector,
          `.pane-col[data-pane="${pane}"]`,
        );
        const screenshot = async (stage: string) => {
          const dir = process.env.RECURSE_SCREENSHOT_DIR;
          if (!dir) return;
          await mkdir(dir, { recursive: true });
          await page.screenshot({
            path: `${dir}/${pane}-${width}-${stage}.png`,
          });
        };
        expect(
          await page
            .locator("#topbar")
            .evaluate((node) => node.getBoundingClientRect().y >= 0),
        ).toBe(true);
        await screenshot("top");
        const beforeHeight = await scroller.evaluate(
          (node) => node.clientHeight,
        );
        const frame = page.locator("iframe.artifact-embed-page");
        const point =
          pane === "report"
            ? (await frame.boundingBox())!
            : (await scroller.boundingBox())!;
        await page.mouse.move(
          point.x + point.width / 2,
          Math.min(700, point.y + 200),
        );
        await page.mouse.wheel(0, 600);
        await page.waitForFunction(
          ({ selector, mobile, pane }) => {
            const document = (globalThis as any).document;
            const scroller = document.querySelector(selector);
            const topbar = document.querySelector("#topbar");
            const controls = document.querySelector(
              `.pane-col[data-pane="${pane}"] .pane-powerbar`,
            );
            return (
              scroller?.scrollTop > 0 &&
              (mobile
                ? topbar.getBoundingClientRect().bottom <= 1 &&
                  controls.getBoundingClientRect().bottom <= 1
                : true)
            );
          },
          {
            selector: scrollerSelector,
            mobile: width === 412,
            pane,
          },
        );
        await waitForPaneScroll(
          page,
          scrollerSelector,
          `.pane-col[data-pane="${pane}"]`,
        );
        await screenshot("down");
        const hidden = await page
          .locator("#topbar")
          .evaluate((node) => node.getBoundingClientRect().bottom <= 1);
        const controlsHidden = await page
          .locator(`.pane-col[data-pane="${pane}"] .pane-powerbar`)
          .evaluate((node) => node.getBoundingClientRect().bottom <= 1);
        const scroll = await scroller.evaluate((node) => node.scrollTop);
        const stable =
          beforeHeight ===
          (await scroller.evaluate((node) => node.clientHeight));
        if (pane === "diff") {
          const bar = (await page.locator(".diff-sendbar.on").boundingBox())!;
          const bodyBox = (await (
            width === 412 ? scroller : body
          ).boundingBox())!;
          expect(
            Math.abs(bodyBox.y + bodyBox.height - bar.y - bar.height),
          ).toBeLessThanOrEqual(2);
        }
        await page.mouse.wheel(0, -40);
        await page.waitForFunction(() => {
          const document = (globalThis as any).document;
          const node = document.querySelector("#topbar");
          const rect = node.getBoundingClientRect();
          return (
            rect.y >= 0 &&
            node.contains(
              document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              ),
            )
          );
        });
        await waitForPaneScroll(
          page,
          scrollerSelector,
          `.pane-col[data-pane="${pane}"]`,
        );
        await screenshot("up");
        const revealed = await page.locator("#topbar").evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.y >= 0 &&
            node.contains(
              node.ownerDocument.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              ),
            )
          );
        });
        await scroller.evaluate((node) => {
          node.scrollTop = 0;
        });
        await waitForPaneScroll(
          page,
          scrollerSelector,
          `.pane-col[data-pane="${pane}"]`,
        );
        let worktreeControlsClear = true;
        if (pane === "diff" && width === 412) {
          const header = (await page
            .locator('.pane-col[data-pane="diff"] .pane-head')
            .boundingBox())!;
          const path = page.locator(".diff-cwd");
          expect(await path.getAttribute("title")).toBe(app.cwd);
          const baseBox = (await page.locator(".diff-base-btn").boundingBox())!;
          worktreeControlsClear =
            baseBox.y >= header.y &&
            baseBox.y + baseBox.height <= header.y + header.height;
          await page.getByLabel("Changes options", { exact: true }).click();
          expect(await path.isVisible()).toBe(true);
          await page.keyboard.press("Escape");
        }
        observations.push({
          width,
          pane,
          hidden,
          controlsHidden,
          revealed,
          worktreeControlsClear,
          stable,
          scroll,
          ...(pane === "report"
            ? {
                frameWidth: (await frame.boundingBox())!.width,
                paneWidth: (await body.boundingBox())!.width,
              }
            : {}),
        });
        await context.close();
      }
    }
    for (const row of observations) {
      console.log(JSON.stringify(row));
      expect(row.hidden).toBe(row.width === 412);
      if (row.width === 412) expect(row.controlsHidden).toBe(true);
      expect(row.revealed).toBe(true);
      expect(row.worktreeControlsClear).toBe(true);
      expect(row.stable).toBe(true);
      expect(row.scroll).toBeGreaterThan(0);
      if (row.frameWidth !== undefined)
        expect(Math.abs(row.frameWidth - row.paneWidth!)).toBeLessThanOrEqual(
          1,
        );
    }
  },
  async function test_viewport_artifact_size_is_bounded(browser, base) {
    const app = await postFixture(base, "seed-artifact-app?reader=viewport");
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
    });
    const page = await context.newPage();
    await gotoRoot(page, base);
    await page.locator(`a[href="#artifact=${app.id}"]`).click();
    const frame = page.locator("iframe.artifact-embed-page");
    await page
      .frameLocator("iframe.artifact-embed-page")
      .locator("body[data-ready]")
      .waitFor();
    await page.waitForFunction(
      "document.querySelector('iframe.artifact-embed-page')?.style.height !== ''",
    );
    const previewFrame = await (await frame.elementHandle())!.contentFrame();
    await previewFrame!.waitForFunction(() => {
      const browser = globalThis as any;
      return (
        browser.getComputedStyle(browser.document.documentElement).overflowY !==
        "hidden"
      );
    });
    await waitForPaneScroll(
      page,
      '.pane-col[data-pane="report"]',
      '.pane-col[data-pane="report"]',
    );
    const height = (await frame.boundingBox())!.height;
    expect(height).toBeLessThanOrEqual(915);
    await page.evaluate(() => {
      (globalThis as any).__sizeMessagesComplete = false;
      (globalThis as any).addEventListener("message", (event: any) => {
        if (event.data?.sizeMessagesComplete)
          (globalThis as any).__sizeMessagesComplete = true;
      });
    });
    await page
      .frameLocator("iframe.artifact-embed-page")
      .locator("body")
      .evaluate(() => {
        const browser = globalThis as any;
        for (const value of ["900", null, -1, Infinity, 100000000])
          browser.parent.postMessage({ recurseArtifactHeight: value }, "*");
        browser.parent.postMessage({ sizeMessagesComplete: true }, "*");
      });
    await page.evaluate(() =>
      (globalThis as any).window.postMessage(
        { recurseArtifactHeight: 999 },
        "*",
      ),
    );
    await page.waitForFunction("window.__sizeMessagesComplete");
    await waitForLayout(page);
    expect((await frame.boundingBox())!.height).toBe(height);
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
    const query = `agent=${app.owner_agent_id}&path=index.html`;
    const original = await fetch(
      `${base}api/artifacts/${app.id}/file?${query}`,
    );
    const preview = await fetch(
      `${base}api/artifacts/${app.id}/page?agent=${app.owner_agent_id}`,
    );
    expect(preview.headers.get("content-security-policy")).toBe(
      original.headers.get("content-security-policy"),
    );
    expect(await original.text()).not.toContain('id="recurse-preview-size"');
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["pane-chrome", tests]]);
