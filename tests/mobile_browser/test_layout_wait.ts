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
    await page.evaluate(() => {
      const probe = (globalThis as any).document.querySelector("#probe");
      probe.getBoundingClientRect();
      probe.style.width = "240px";
    });
    await page.waitForFunction(() =>
      (globalThis as any).document
        .querySelector("#probe")
        .getAnimations()
        .some((animation: any) => animation.playState === "running"),
    );
    await waitForLayout(page);
    expect(
      await page
        .locator("#probe")
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(240);
    expect(
      await page
        .locator("#probe")
        .evaluate((node) =>
          node
            .getAnimations()
            .some((animation: any) => animation.playState === "running"),
        ),
    ).toBeFalse();
  },
];

if (import.meta.main) await runBrowserTests([["layout-wait", tests]]);
