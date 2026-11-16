import { expect } from "bun:test";
import { runBrowserTests, waitForLayout, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2405 async predicates returned before real layout settled.
  async function test_layout_waits_for_the_real_animation_to_settle(browser) {
    const page = await browser.newPage();
    const result = await page.waitForFunction(async () => false);
    expect(await result.jsonValue()).toBeFalse();
    await result.dispose();
    await page.setContent(
      '<div id="scroll"><button id="probe" style="width:40px;transition:width 800ms linear">Probe</button></div>',
    );
    for (const width of [240, 40, 240]) {
      await page.evaluate((width) => {
        const probe = (globalThis as any).document.querySelector("#probe");
        probe.getBoundingClientRect();
        probe.style.width = `${width}px`;
      }, width);
      await page.waitForFunction(() =>
        (globalThis as any).document
          .querySelector("#probe")
          .getAnimations()
          .some((animation: any) => animation.playState === "running"),
      );
      const blocked = page.evaluate(() => {
        const { performance } = globalThis as any;
        const end = performance.now() + 50;
        while (performance.now() < end);
      });
      await waitForLayout(page);
      await blocked;
      expect(
        await page
          .locator("#probe")
          .evaluate((node) => node.getBoundingClientRect().width),
      ).toBe(width);
      expect(
        await page
          .locator("#probe")
          .evaluate((node) =>
            node
              .getAnimations()
              .some((animation: any) => animation.playState === "running"),
          ),
      ).toBeFalse();
    }
  },
];

if (import.meta.main) await runBrowserTests([["layout-wait", tests]]);
