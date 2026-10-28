import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import captured from "../backend/fixtures/pull_request_diff.json";
import {
  captureErrors,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [false, true].map(
  (mobile) =>
    async function test_pr_diff(browser, base) {
      const context = await browser.newContext({
        viewport: { width: mobile ? 412 : 1280, height: 844 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      if (!mobile)
        await context.addInitScript(() =>
          (globalThis as any).localStorage.setItem("recurse.panesWidth", "390"),
        );
      const page = await context.newPage();
      const errors = captureErrors(page);
      const { demo } = await postFixture(base, "seed-files-pane");
      const theme = await page.request.post(`${base}api/settings/theme`, {
        data: { theme: "Solarized Dark" },
      });
      expect(theme.status()).toBe(200);
      const delivered: string[] = [];
      let contents = 0;
      let metadataReady = false;
      let body = captured.pr.body;
      await page.route(`**/api/conversations/${demo}/**`, (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        if (path.endsWith("/prs"))
          return route.fulfill({
            json: {
              prs: [
                {
                  ...captured.pr,
                  body: metadataReady ? body : null,
                  state: metadataReady ? captured.pr.state : null,
                  metadata: metadataReady ? "ready" : "pending",
                },
              ],
              refreshing: !metadataReady && !mobile,
            },
          });
        if (path.endsWith("/diff/candidates"))
          return route.fulfill({
            json: { branches: [], commits: [], tags: [] },
          });
        if (path.endsWith("/diff"))
          return route.fulfill({
            json: url.searchParams.get("pr")
              ? captured.summary
              : captured.working,
          });
        if (path.endsWith("/diff/files")) {
          if (url.searchParams.has("contents")) contents++;
          expect(url.searchParams.get("pr")).toBe(captured.pr.url);
          return route.fulfill({ json: captured.file });
        }
        if (path.endsWith("/deliver")) {
          delivered.push(JSON.parse(route.request().postData()!).content);
          return route.fulfill({ json: { steer: false } });
        }
        return route.continue();
      });
      const diffReady = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/conversations/${demo}/diff` &&
          !url.searchParams.has("pr")
        );
      });
      await page.goto(`${base}#agent=${demo}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#conv-title").waitFor();
      if (mobile) {
        await diffReady;
        await page.locator("#pane-fab").tap();
        await page.locator('.pane-menu-item[data-pane="diff"]').tap();
        await page.locator(".diff-base-btn").click();
      } else {
        await page.locator('.rail-btn[data-pane="diff"]').waitFor();
        await page.locator("#input").focus();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Shift+P");
      }
      const pane = page.locator('.pane-col[data-pane="diff"]');
      const input = pane.locator(".diff-base-input");
      await input.waitFor();
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(resolve))",
      );
      expect(
        await input.evaluate(
          (element) => element === element.ownerDocument.activeElement,
        ),
      ).toBe(true);
      if (mobile) {
        const bar = pane.locator(".pane-powerbar");
        expect(await bar.locator(".pane-powerbar-overflow").isVisible()).toBe(
          false,
        );
        expect(await bar.locator(".x").isVisible()).toBe(false);
        const [inputBox, applyBox, cancelBox] = await Promise.all([
          input.boundingBox(),
          pane.locator(".diff-base-apply").boundingBox(),
          pane.locator(".diff-base-cancel").boundingBox(),
        ]);
        expect(inputBox!.width).toBeGreaterThan(
          applyBox!.width + cancelBox!.width,
        );
      }
      await input.fill("thinksum");
      const option = pane.getByRole("option", { name: /#2069/ });
      await option.waitFor();
      expect(await pane.locator(".diff-base-repo").allTextContents()).toEqual([
        "ebetica/recurse",
      ]);
      expect(await option.textContent()).toBe("#2069 · " + captured.pr.title);
      const selectedMetadata = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith(`/conversations/${demo}/prs`),
      );
      if (mobile) await option.tap();
      else {
        await input.press("ArrowDown");
        await input.press("Enter");
      }
      expect((await (await selectedMetadata).json()).refreshing).toBe(!mobile);
      await pane.locator(".diff-row.add").first().waitFor();
      metadataReady = true;
      expect(contents).toBe(0);
      const shot = async (view: string) => {
        const dir = process.env.RECURSE_SCREENSHOT_DIR;
        if (!dir) return;
        await mkdir(dir, { recursive: true });
        await page.screenshot({
          path: join(dir, `pr-${view}-${mobile ? "mobile" : "desktop"}.png`),
        });
      };
      if (process.env.RECURSE_DESCRIPTION_BASELINE)
        await shot("description-before");
      const title = pane.getByRole("heading", { name: captured.pr.title });
      await title.waitFor();
      expect(await title.locator("a").getAttribute("href")).toBe(
        captured.pr.url,
      );
      const description = pane.locator(".diff-pr-body");
      expect(await description.locator("h2").first().textContent()).toBe(
        "Summary",
      );
      expect(await description.locator("code").count()).toBeGreaterThan(0);
      const height = await description.evaluate((element) => {
        const browser = globalThis as any;
        const bottom = element.getBoundingClientRect().bottom;
        const walker = browser.document.createTreeWalker(
          element,
          browser.NodeFilter.SHOW_TEXT,
        );
        const lines: Array<{ top: number; bottom: number }> = [];
        let partial = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = browser.document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.height && rect.top < bottom - 0.5) {
              lines.push({ top: rect.top, bottom: rect.bottom });
              if (rect.bottom > bottom + 0.5) partial = true;
            }
          }
        }
        const bands: typeof lines = [];
        for (const rect of lines.sort((a, b) => a.top - b.top)) {
          const previous = bands.at(-1);
          if (previous && rect.top < previous.bottom) {
            previous.bottom = Math.max(previous.bottom, rect.bottom);
          } else {
            bands.push(rect);
          }
        }
        return {
          collapsed: element.clientHeight,
          full: element.scrollHeight,
          lines: bands.length,
          partial,
        };
      });
      expect(height.lines).toBe(6);
      expect(height.partial).toBe(false);
      expect(height.full).toBeGreaterThan(height.collapsed);
      const more = pane.getByRole("button", { name: "Show more", exact: true });
      await more.waitFor();
      expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await more.locator('svg[aria-hidden="true"]').count()).toBe(1);
      await shot("description-collapsed");
      if (mobile) await more.tap();
      else {
        await more.focus();
        await more.press("Enter");
      }
      const less = pane.getByRole("button", { name: "Show less", exact: true });
      expect(await less.getAttribute("aria-expanded")).toBe("true");
      expect((await description.boundingBox())!.height).toBeGreaterThan(
        height.collapsed,
      );
      await pane.getByLabel("Changes options", { exact: true }).click();
      await pane.getByRole("button", { name: "Split", exact: true }).click();
      expect(await less.getAttribute("aria-expanded")).toBe("true");
      await title.scrollIntoViewIfNeeded();
      await shot("description-expanded");
      await less.click();
      await title.scrollIntoViewIfNeeded();
      expect(await more.getAttribute("aria-expanded")).toBe("false");
      expect(await pane.locator(".diff-base-btn").textContent()).toContain(
        "vs main",
      );
      for (const mode of ["Unified", "Split"]) {
        await pane.getByLabel("Changes options", { exact: true }).click();
        await pane.getByRole("button", { name: mode, exact: true }).click();
        const patch = pane.locator(".diff-patch").first();
        const result = await patch.evaluate((element) => {
          const lines = [...element.querySelectorAll(".diff-line")];
          const line = lines.find((line) =>
            line.textContent?.includes("matchAll"),
          )!;
          const browser = globalThis as any;
          const range = browser.document.createRange();
          const walker = browser.document.createTreeWalker(
            line,
            browser.NodeFilter.SHOW_TEXT,
          );
          let last = walker.nextNode()!;
          for (let next = walker.nextNode(); next; next = walker.nextNode())
            last = next;
          range.setStart(last, last.textContent!.length - 1);
          range.setEnd(last, last.textContent!.length);
          const frame = element.getBoundingClientRect();
          const before = range.getBoundingClientRect().right;
          element.scrollLeft = element.scrollWidth;
          return {
            before,
            after: range.getBoundingClientRect().right,
            left: frame.left,
            right: frame.right,
            scrollLeft: element.scrollLeft,
            rowWidths: [
              ...element.querySelectorAll(".diff-row.add, .diff-cell.add"),
            ].map((row) => row.getBoundingClientRect().width),
          };
        });
        expect(result.before).toBeGreaterThan(result.right);
        expect(result.scrollLeft).toBeGreaterThan(0);
        expect(result.after).toBeLessThanOrEqual(result.right);
        expect(result.after).toBeGreaterThan(result.left);
        expect(new Set(result.rowWidths).size).toBe(1);
        expect(result.rowWidths[0]).toBeGreaterThan(result.right - result.left);
        await shot(mode.toLowerCase() + "-scrolled");
      }
      await pane.getByLabel("Changes options", { exact: true }).click();
      await pane.getByRole("button", { name: "Unified", exact: true }).click();
      await pane.locator(".diff-base-btn").click();
      expect(await option.textContent()).toBe(
        "#2069 · " + captured.pr.title + " · merged",
      );
      await shot("picker");
      await pane.locator(".diff-base-cancel").click();
      await pane.locator(".diff-row.add .diff-num").first().click();
      await pane.locator(".diff-line-input").fill("Check this PR change.");
      const editorFits = await pane
        .locator(".diff-line-input")
        .evaluate((input) => {
          const patch = input.closest(".diff-patch")!;
          patch.scrollLeft = patch.scrollWidth;
          const frame = patch.getBoundingClientRect();
          const editor = input.getBoundingClientRect();
          return editor.left >= frame.left && editor.right <= frame.right;
        });
      expect(editorFits).toBe(true);
      await pane.locator(".diff-sendbar-send").click();
      await page.waitForFunction(
        "document.querySelector('.diff-sendbar-label')?.textContent?.trim() === '0 comments'",
      );
      expect(delivered[0]).toContain("PR: #2069");
      expect(delivered[0]).toContain(captured.pr.url);
      await pane.locator(".diff-base-btn").click();
      await pane.getByRole("option", { name: /Working directory/ }).click();
      await pane.locator(".diff-base-btn", { hasText: "vs auto" }).waitFor();
      expect(await pane.locator(".diff-pr").count()).toBe(0);
      expect(await pane.locator(".diff-file").count()).toBe(0);
      expect(await pane.locator(".diff-pr-summary").count()).toBe(0);
      body = captured.pr.body
        .split("\n")
        .find((line) => line.startsWith("- "))!
        .slice(2);
      await pane.locator(".diff-base-btn").click();
      await pane.getByRole("option", { name: /#2069/ }).click();
      await page.waitForFunction(
        (expected) =>
          (globalThis as any).document
            .querySelector('.pane-col[data-pane="diff"] .diff-pr-body')
            ?.textContent.trim() === expected,
        body,
      );
      await pane.locator(".diff-pr-more").waitFor({ state: "detached" });
      expect(
        await description.evaluate(
          (element) =>
            (globalThis as any).getComputedStyle(element, "::after").content,
        ),
      ).toBe("none");
      await shot("description-short");
      expect(errors).toEqual([]);
      await context.close();
    },
);
if (import.meta.main) await runBrowserTests([["pr-diff", tests]]);
