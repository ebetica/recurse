import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { postFixture, runBrowserTests, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  async function test_pr_references(browser, base) {
    const { checkout, plain } = await postFixture(base, "seed-pr-references");
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      await page.goto(`${base}#agent=${checkout}`);
      const links = page.locator('.msg.assistant a[href*="/pull/"]');
      await links.first().waitFor();
      expect(
        await links.evaluateAll((nodes) =>
          nodes.map(
            (a) =>
              `${a.textContent}|${a.getAttribute("href")}|${a.getAttribute("target")}|${a.getAttribute("rel")}`,
          ),
        ),
      ).toEqual([
        "#42|https://github.com/Owner/Repo/pull/42|_blank|noopener noreferrer",
      ]);
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      if (shots) {
        await mkdir(shots, { recursive: true });
        await page.screenshot({ path: `${shots}/pr-references-${width}.png` });
      }
      await page.goto(`${base}#agent=${plain}`);
      await page
        .locator(".msg.assistant .content")
        .filter({ hasText: "Review #42 from pr-plain" })
        .waitFor();
      expect(
        await page.locator('.msg.assistant a[href*="/pull/"]').count(),
      ).toBe(0);
      await page.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["pr-references", tests]]);
