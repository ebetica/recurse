import { expect } from "bun:test";
import { idleConv, row, tree } from "./fixtures";
import {
  gotoRoot,
  mockConversation,
  runBrowserTests,
  type BrowserTest,
} from "./common";

const rows = Array.from({ length: 24 }, (_, i) =>
  row(
    `r${i}`,
    i % 2 ? "assistant" : "user",
    `Message ${i}: enough words to wrap onto a second line on a phone screen.`,
  ),
);
const opacities = `(() => ({
  top: getComputedStyle(document.querySelector("#topbar"), "::after").opacity,
  bottom: getComputedStyle(document.querySelector("#composer-wrap"), "::before").opacity,
}))()`;

const threadEdges: BrowserTest = async (browser, base) => {
  for (const mobile of [true, false]) {
    for (const running of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 412, height: 915 }
          : { width: 1280, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      const conv = running
        ? { ...idleConv(rows), status: "running", active_run: "run-edges" }
        : idleConv(rows);
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [
            { ...tree()[0], status: conv.status, active_run: conv.active_run },
          ],
        }),
      );
      await mockConversation(page, base, "main", () => conv);
      await gotoRoot(page, base);
      await page.locator("#safety-row.on").waitFor();
      if (running) await page.locator(".working .live-label").waitFor();
      else await page.getByText("Message 23:", { exact: false }).waitFor();
      await page.waitForFunction(
        `(() => { const s = document.querySelector("#scroll"); return s.scrollHeight > s.clientHeight * 1.5 && s.scrollHeight - s.scrollTop - s.clientHeight <= 1; })()`,
      );
      const gap = await page.evaluate(`(() => {
        const items = [...document.querySelector("#messages").children].filter((e) => e.getBoundingClientRect().height > 0);
        return Math.round(document.querySelector("#safety-row").getBoundingClientRect().top - items[items.length - 1].getBoundingClientRect().bottom);
      })()`);
      expect(gap as number).toBeGreaterThanOrEqual(12);
      expect(gap as number).toBeLessThanOrEqual(16);
      await page.waitForFunction(
        `(() => { const o = ${opacities}; return o.top === "1" && o.bottom === "0"; })()`,
      );
      await page.locator("#scroll").evaluate((el) => (el.scrollTop = 0));
      await page.waitForFunction(
        `(() => { const o = ${opacities}; return o.top === "0" && o.bottom === "1"; })()`,
      );
      await context.close();
    }
  }
};

export const tests = [threadEdges];
if (import.meta.main) await runBrowserTests([["thread-edges", tests]]);
