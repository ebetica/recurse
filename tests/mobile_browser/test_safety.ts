import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { captureErrors, postFixture, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2509 fail-open reviews were invisible beside the composer toggle.
  async function test_safety_reviewer_unavailable_and_recovers(browser, base) {
    const { agent } = await postFixture(base, "seed-safety-review");
    const pages = await Promise.all(
      [412, 1280].map((width) =>
        browser.newPage({
          viewport: { width, height: 915 },
          isMobile: width === 412,
          hasTouch: width === 412,
        }),
      ),
    );
    const errors = pages.map(captureErrors);
    try {
      for (const page of pages) {
        await page.goto(`${base}#agent=${agent}`);
        await browserExpect(page.locator("#safety-btn .lbl")).toHaveText(
          "Safety review",
        );
        await browserExpect(page.locator("#safety-btn")).toBeVisible();
      }
      const page = pages[0]!;
      const before = await page.locator("#input").boundingBox();
      const send = async () => {
        await page.locator("#input").fill("Run the local command.");
        await page.locator("#send").click();
      };
      await send();
      await page.getByText("SAFETY_TURN_DONE", { exact: true }).waitFor();
      for (const view of pages) {
        const warning = view.locator("#safety-unavailable");
        await browserExpect(warning).toHaveText("Unavailable");
        await browserExpect(warning).toHaveAttribute(
          "title",
          "Safety review unavailable: provider error",
        );
        expect(await view.locator("#safety-btn .lbl").innerText()).toBe(
          "Safety review",
        );
        expect(
          await view.locator("#safety-btn").getAttribute("aria-checked"),
        ).toBe("true");
        expect(
          await view.locator("#safety-btn").getAttribute("aria-label"),
        ).toBe("Safety review, on, unavailable: provider error");
        expect(await view.locator("#safety-row").innerText()).not.toContain(
          "Yolo mode",
        );
        await view.reload();
        await browserExpect(warning).toHaveText("Unavailable");
        await browserExpect(warning).toBeVisible();
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await view.screenshot({
            path: `${shots}/safety-unavailable-${view.viewportSize()!.width}.png`,
          });
      }
      const after = await page.locator("#input").boundingBox();
      expect(after!.y).toBe(before!.y);
      expect(after!.width).toBe(before!.width);
      await send();
      await browserExpect(
        page.getByText("SAFETY_TURN_DONE", { exact: true }),
      ).toHaveCount(2);
      for (const view of pages) {
        await browserExpect(view.locator("#safety-unavailable")).toBeHidden();
        expect(await view.locator("#safety-btn .lbl").innerText()).toBe(
          "Safety review",
        );
        expect(await view.locator("#safety-row").innerText()).not.toContain(
          "Unavailable",
        );
        expect(
          await view.locator("#safety-btn").getAttribute("aria-label"),
        ).toBe("Safety review, on");
      }
      expect(errors).toEqual([[], []]);
    } finally {
      await Promise.all(pages.map((page) => page.close()));
    }
  },
];
