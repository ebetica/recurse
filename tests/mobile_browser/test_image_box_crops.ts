import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureErrors, runBrowserTests, type BrowserTest } from "./common";
declare const getComputedStyle: any;

export const tests: BrowserTest[] = [
  // Regression: #2887 fitted tall phone images stay above the compact comment bar.
  async function test_tall_phone_image_fit(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 1600; canvas.height = 4439;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      expect(seeded.ok()).toBeTrue();
      const { demo } = (await seeded.json()) as { demo: string };
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const fitted = (await image.boundingBox())!;
      const bar = (await pane.locator(".image-comment-sidebar").boundingBox())!;
      expect(fitted.y + fitted.height).toBeLessThanOrEqual(bar.y);
      await page.mouse.move(
        fitted.x + fitted.width * 0.2,
        fitted.y + fitted.height * 0.2,
      );
      await page.mouse.down();
      await page.mouse.move(
        fitted.x + fitted.width * 0.6,
        fitted.y + fitted.height * 0.4,
        { steps: 4 },
      );
      await page.mouse.up();
      const draft = pane.locator(".report-comment-popover");
      const input = draft.locator("textarea");
      await input.pressSequentially("Keep this region");
      expect(await image.boundingBox()).toEqual(fitted);
      await draft.getByRole("button", { name: "Comment", exact: true }).click();
      await pane.locator(".report-sendbar-count").click();
      await pane.locator(".report-comments").waitFor({ state: "visible" });
      expect(await image.boundingBox()).toEqual(fitted);
    } finally {
      await page.close();
    }
  },
  // Regression: #2891 desktop image comments start compact, expand for drafts and send zoomed crops with original coordinates.
  async function test_published_image_box_crop(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 844 },
    });
    const errors = captureErrors(page);
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 400; canvas.height = 320;
        const context = canvas.getContext('2d');
        for (const [x, y, color] of [[0, 0, '#ff0000'], [200, 0, '#00ff00'], [0, 160, '#0000ff'], [200, 160, '#ffff00']]) {
          context.fillStyle = color; context.fillRect(x, y, 200, 160);
        }
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      expect(seeded.ok()).toBeTrue();
      const { demo } = (await seeded.json()) as { demo: string };
      await page.goto(`${base}#agent=${demo}`);
      await page.waitForFunction(
        "document.querySelector('#conv-title')?.textContent === 'Published quadrant image'",
      );
      await page.locator('.rail-btn[data-pane="files"]').click();
      const files = page.locator('.pane-col[data-pane="files"]');
      await files
        .getByRole("button", { name: "Open quadrants.png", exact: true })
        .click();
      const pane = page.locator(".image-popout");
      await pane
        .locator(".files-detail img")
        .evaluate((image: any) => image.decode());
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-popout-desktop.png`,
        });
      const sidebar = pane.locator(".image-comment-sidebar");
      const compact = (await sidebar.boundingBox())!;
      expect(compact.height).toBeLessThan(100);
      expect(await pane.locator(".report-comments").isVisible()).toBe(false);
      const fitted = (await pane.locator(".files-image-frame").boundingBox())!;
      const viewport = (await pane
        .locator(".image-zoom-viewport")
        .boundingBox())!;
      expect(fitted.width).toBeGreaterThan(400);
      expect(fitted.y + fitted.height).toBeLessThanOrEqual(compact.y);
      expect(fitted.width / fitted.height).toBeCloseTo(400 / 320, 3);
      await page.mouse.move(
        fitted.x + fitted.width * 0.9,
        fitted.y + fitted.height * 0.1,
      );
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -70);
      await page.keyboard.up("Control");
      await page.waitForFunction(
        "new DOMMatrix(getComputedStyle(document.querySelector('.files-image-frame')).transform).a > 2",
      );
      expect(await page.evaluate<number>("visualViewport.scale")).toBe(1);
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-zoom-desktop.png`,
        });
      const frame = (await pane.locator(".files-image-frame").boundingBox())!;
      expect(
        (fitted.x + fitted.width * 0.9 - frame.x) / frame.width,
      ).toBeCloseTo(0.9, 2);
      expect(
        (fitted.y + fitted.height * 0.1 - frame.y) / frame.height,
      ).toBeCloseTo(0.1, 2);
      const zoomFrame = pane.locator(".files-image-frame");
      const beforePan = await zoomFrame.getAttribute("style");
      const panX = viewport.x + viewport.width / 2;
      const panY = viewport.y + viewport.height / 2;
      await page.keyboard.down("Shift");
      for (const dx of [20, -20]) {
        await page.mouse.move(panX, panY);
        await page.mouse.down();
        await page.mouse.move(panX + dx, panY, { steps: 4 });
        await page.mouse.up();
        if (dx === 20)
          expect(await zoomFrame.getAttribute("style")).not.toBe(beforePan);
        expect(await zoomFrame.locator("mark.report-cbox").count()).toBe(0);
      }
      await page.keyboard.up("Shift");
      const geometry = () =>
        pane.evaluate((element: any) =>
          [
            ".files-detail img",
            ".files-image-frame",
            ".image-zoom-viewport",
          ].map((selector) => {
            const node = element.querySelector(selector);
            const { x, y, width, height } = node.getBoundingClientRect();
            return {
              x,
              y,
              width,
              height,
              transform: getComputedStyle(node).transform,
            };
          }),
        );
      const fixed = await geometry();
      await page.mouse.move(
        frame.x + frame.width * 0.6,
        frame.y + frame.height * 0.1,
      );
      await page.mouse.down();
      await page.mouse.move(
        frame.x + frame.width * 0.9,
        frame.y + frame.height * 0.4,
        { steps: 8 },
      );
      await page.mouse.up();
      expect(await geometry()).toEqual(fixed);
      expect((await sidebar.boundingBox())!.height).toBeGreaterThan(
        compact.height,
      );
      const popover = page.locator(".report-comment-popover");
      const input = popover.locator("textarea");
      await input.fill("Only the green region");
      expect((await popover.boundingBox())!.y).toBeGreaterThan(844 / 2);
      await input.click();
      expect(
        await input.evaluate(
          (element: any) => element === element.ownerDocument.activeElement,
        ),
      ).toBe(true);
      await pane
        .getByRole("button", { name: "Close image", exact: true })
        .focus();
      await page.keyboard.press("c");
      expect(
        await input.evaluate(
          (element: any) => element === element.ownerDocument.activeElement,
        ),
      ).toBe(true);
      expect(await input.inputValue()).toBe("Only the green region");
      expect(await pane.locator(".report-comment").count()).toBe(0);
      await popover
        .getByRole("button", { name: "Comment", exact: true })
        .click();
      expect(await geometry()).toEqual(fixed);
      await pane.locator(".report-sendbar-count").click();
      await pane.locator(".report-comments").waitFor({ state: "visible" });
      await pane
        .locator(".report-comment-input")
        .fill("Only the green region edited");
      expect(await geometry()).toEqual(fixed);
      for (let index = 0; index < 7; index++) {
        await page.mouse.move(
          frame.x + frame.width * 0.62,
          frame.y + frame.height * 0.12,
        );
        await page.mouse.down();
        await page.mouse.move(
          frame.x + frame.width * 0.85,
          frame.y + frame.height * 0.35,
          { steps: 4 },
        );
        await page.mouse.up();
        await input.fill(`Additional green-region comment ${index}`);
        expect(await geometry()).toEqual(fixed);
        const draft = (await popover.boundingBox())!;
        expect(draft.x).toBeGreaterThanOrEqual(viewport.x);
        expect(draft.x + draft.width).toBeLessThanOrEqual(
          viewport.x + viewport.width,
        );
        expect(draft.y + draft.height).toBeLessThanOrEqual(844);
        await popover
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        expect(await geometry()).toEqual(fixed);
      }
      const list = pane.locator(".report-comments");
      expect(
        await list.evaluate(
          (element: any) => element.scrollHeight > element.clientHeight,
        ),
      ).toBe(true);
      await list.hover();
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(
        "document.querySelector('.image-popout .report-comments').scrollTop > 0",
      );
      expect(await geometry()).toEqual(fixed);
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-comments-desktop-list-scroll.png`,
        });
      while ((await pane.locator(".report-comment").count()) > 1)
        await pane.locator(".report-comment-del").last().click();
      await pane
        .getByRole("button", { name: "Fit image", exact: true })
        .click();
      await page.mouse.move(
        fitted.x + fitted.width * 0.55,
        fitted.y + fitted.height * 0.1,
      );
      await page.mouse.down();
      await page.mouse.move(
        fitted.x + fitted.width * 0.9,
        fitted.y + fitted.height * 0.4,
        { steps: 4 },
      );
      await page.mouse.up();
      await input.fill("Keep this region, but widen the entrance.");
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-comments-desktop-1200.png`,
        });
      await popover
        .getByRole("button", { name: "Comment", exact: true })
        .click();
      await page.route("**/api/attachments", async (route) => {
        if (route.request().postData()?.includes("quadrants-box-2.png"))
          await route.fulfill({ status: 500, body: "Crop upload failed" });
        else await route.continue();
      });
      const shots = join(
        process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(),
        "box-crops",
      );
      await mkdir(shots, { recursive: true });
      await page.screenshot({
        path: join(shots, "published-image-comment.png"),
      });
      const delivered = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${demo}/deliver`),
      );
      await pane
        .getByRole("button", { name: "Submit comments", exact: true })
        .click();
      const content = (await delivered).postDataJSON().content as string;
      const coordinates =
        /- box 1, x=(\d+) y=(\d+) w=(\d+) h=(\d+) px in the 400×320 original \(x,y = top-left\), attached as quadrants-box-1\.png:/.exec(
          content,
        );
      expect(coordinates).not.toBeNull();
      for (const [index, expected] of [240, 32, 120, 96].entries())
        expect(
          Math.abs(Number(coordinates![index + 1]) - expected),
        ).toBeLessThanOrEqual(1);
      const fallback =
        /- box 2, x=(\d+) y=(\d+) w=(\d+) h=(\d+) px in the 400×320 original \(x,y = top-left\) \(crop unavailable; coordinates only\):/.exec(
          content,
        );
      expect(fallback).not.toBeNull();
      for (const [index, expected] of [220, 32, 140, 96].entries())
        expect(
          Math.abs(Number(fallback![index + 1]) - expected),
        ).toBeLessThanOrEqual(1);
      expect(content).toContain("Only the green region");
      expect(content).not.toContain("box x=");
      const cropUrl = /!\[quadrants-box-1\.png\]\(([^)]+)\)/.exec(content)?.[1];
      expect(cropUrl).toBeDefined();
      await pane.waitFor({ state: "detached" });
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged." })
        .waitFor();
      const image = page.locator('#messages img[alt="quadrants-box-1.png"]');
      await image.waitFor();
      expect(await image.getAttribute("src")).toContain(cropUrl!);
      const pixels = await image.evaluate(async (image: any) => {
        await image.decode();
        const canvas = image.ownerDocument.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const data = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let wrong = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            data[i] !== 0 ||
            data[i + 1] !== 255 ||
            data[i + 2] !== 0 ||
            data[i + 3] !== 255
          )
            wrong++;
        return { width: canvas.width, height: canvas.height, wrong };
      });
      expect(Math.abs(pixels.width - 120)).toBeLessThanOrEqual(2);
      expect(Math.abs(pixels.height - 96)).toBeLessThanOrEqual(2);
      expect(pixels.wrong).toBe(0);
      await page.screenshot({ path: join(shots, "published-image-sent.png") });
      expect(errors).toEqual([]);
    } catch (error) {
      const shots = join(
        process.env.RECURSE_AGENT_TMPDIR ?? tmpdir(),
        "box-crops",
      );
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: join(shots, "failure.png") });
      await Bun.write(join(shots, "failure.html"), await page.content());
      throw error;
    } finally {
      await page.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["image-box-crops", tests]]);
