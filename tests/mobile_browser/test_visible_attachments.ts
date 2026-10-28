import { expect } from "bun:test";
import { postFixture, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2614 intermediate reply images disappeared inside folded activity.
  async function test_folded_reply_images_stay_visible(browser, base) {
    const { agent } = await postFixture(base, "seed-folded-images");
    for (const width of [1280, 412]) {
      const page = await browser.newPage({ viewport: { width, height: 915 } });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .getByText("platform images finished.", { exact: true })
          .waitFor();
        for (const origin of ["operator", "platform"])
          for (const part of ["first", "middle", "last"]) {
            const images = page.locator(
              `#messages img[alt="${origin}-${part}"]`,
            );
            expect(await images.count()).toBe(1);
            expect(await images.isVisible()).toBeTrue();
            await images.evaluate((el: any) => el.decode());
            expect(
              await images.evaluate(
                (el: any) => el.complete && el.naturalWidth > 0,
              ),
            ).toBeTrue();
          }
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({
            path: `${shots}/after-seed-folded-images-${width}.png`,
          });
        expect(
          await page
            .getByText("Hidden operator middle prose.", { exact: true })
            .isVisible(),
        ).toBeFalse();
        for (const toggle of await page
          .locator(".activity-group-toggle")
          .all()) {
          await toggle.click();
          for (const origin of ["operator", "platform"])
            for (const part of ["first", "middle", "last"])
              expect(
                await page
                  .locator(`#messages img[alt="${origin}-${part}"]`)
                  .count(),
              ).toBe(1);
          await toggle.click();
        }
        await page.reload();
        await page
          .getByText("platform images finished.", { exact: true })
          .waitFor();
        expect(
          await page
            .locator('#messages img[alt="operator-middle"]')
            .isVisible(),
        ).toBeTrue();
      } finally {
        await page.close();
      }
    }
  },

  // Regression: #2588 folded wake turns and message headers hid published files and uploads.
  async function test_published_wake_attachments_stay_visible(browser, base) {
    const { agent } = await postFixture(base, "seed-visible-attachments");
    const counts: number[] = [];
    const imageCounts: number[] = [];
    for (const width of [1280, 412]) {
      const page = await browser.newPage({ viewport: { width, height: 915 } });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .getByText("second-report.txt is ready.", { exact: true })
          .waitFor();
        const files = page.locator("#messages .agent-attachment-item.file");
        const images = page.locator('#messages img[alt$="report.txt image"]');
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({ path: `${shots}/attachments-${width}.png` });
        counts.push(await files.count());
        imageCounts.push(await images.count());
        for (const image of await images.all()) {
          expect(await image.isVisible()).toBeTrue();
          await image.evaluate((el: any) => el.decode());
        }
        for (const name of ["first-report.txt", "second-report.txt"])
          expect(
            await page
              .getByRole("button", {
                name: `Open ${name} in Files`,
                exact: true,
              })
              .isVisible(),
          ).toBeTrue();
        const group = page.locator(".activity-group-toggle").last();
        const message = page
          .locator(".agent-message")
          .filter({ has: page.locator('img[alt="first-report.txt image"]') });
        await message.locator(".agent-message-row").click();
        expect(
          await message
            .getByRole("button", { name: "Show message details" })
            .isVisible(),
        ).toBeTrue();
        expect(await images.count()).toBe(2);
        await message.locator(".agent-message-row").click();
        await group.click();
        expect(await files.count()).toBe(2);
        expect(await images.count()).toBe(2);
        await group.click();
        expect(await files.count()).toBe(2);
        expect(await images.count()).toBe(2);
        await page.reload();
        await page
          .getByText("second-report.txt is ready.", { exact: true })
          .waitFor();
        expect(await files.count()).toBe(2);
      } finally {
        await page.close();
      }
    }
    expect(counts).toEqual([2, 2]);
    expect(imageCounts).toEqual([2, 2]);
  },
];
