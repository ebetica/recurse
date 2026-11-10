import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureErrors, runBrowserTests, type BrowserTest } from "./common";
declare const getComputedStyle: any;
declare const localStorage: any;
declare const Storage: any;
declare const window: any;
declare const navigator: any;
declare const dispatchEvent: any;

export const tests: BrowserTest[] = [
  // Regression: #3101 Cmd+Enter stages each box before sending the batch; #2887 fitted tall phone images stay above the compact comment bar.
  async function test_tall_phone_image_fit(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.addInitScript(
        "Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })",
      );
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
      const deliveries: string[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith(`/api/conversations/${demo}/deliver`))
          deliveries.push(request.postDataJSON().content);
      });
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
      await page.keyboard.down("Meta");
      await page.mouse.down();
      await page.mouse.move(
        fitted.x + fitted.width * 0.6,
        fitted.y + fitted.height * 0.4,
        { steps: 4 },
      );
      await page.mouse.up();
      await page.keyboard.up("Meta");
      const draft = pane.locator(".report-comment-popover");
      const input = draft.locator("textarea");
      await input.pressSequentially("Keep this region");
      expect(await image.boundingBox()).toEqual(fitted);
      await input.press("Meta+Enter");
      await draft.waitFor({ state: "hidden" });
      expect(
        await pane.locator(".report-sendbar-count").textContent(),
      ).toContain("1 comment");
      expect(deliveries).toEqual([]);
      if (!(await pane.locator(".report-comments").isVisible()))
        await pane.locator(".report-sendbar-count").click();
      await pane.locator(".report-comments").waitFor({ state: "visible" });
      expect(await image.boundingBox()).toEqual(fitted);
      expect(
        await pane.locator(".report-sendbar-send").getAttribute("title"),
      ).toContain("⌘+Enter");
      await pane.locator(".report-sendbar-count").click();
      await page.keyboard.down("Meta");
      await page.mouse.move(
        fitted.x + fitted.width * 0.3,
        fitted.y + fitted.height * 0.55,
      );
      await page.mouse.down();
      await page.mouse.move(
        fitted.x + fitted.width * 0.7,
        fitted.y + fitted.height * 0.75,
        { steps: 4 },
      );
      await page.mouse.up();
      await page.keyboard.up("Meta");
      await input.fill("Also this region");
      await input.press("Meta+Enter");
      await draft.waitFor({ state: "hidden" });
      expect(
        await pane.locator(".report-sendbar-count").textContent(),
      ).toContain("2 comments");
      expect(deliveries).toEqual([]);
      const delivered = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${demo}/deliver`),
      );
      await page.keyboard.press("Meta+Enter");
      await pane.waitFor({ state: "detached" });
      const content = (await delivered).postDataJSON().content as string;
      expect(content).toContain("Keep this region");
      expect(content).toContain("Also this region");
      expect(deliveries).toEqual([content]);
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 2" })
        .waitFor();
    } finally {
      await page.close();
    }
  },
  // Regression: #3213 reveal the lazy crop preview's frame before waiting for its image.
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
      const deliveries: string[] = [];
      page.on("request", (request) => {
        if (request.url().endsWith(`/api/conversations/${demo}/deliver`))
          deliveries.push(request.postDataJSON().content);
      });
      await page.goto(`${base}#agent=${demo}`);
      await page.waitForFunction(
        "document.querySelector('#conv-title')?.textContent === 'Published quadrant image'",
      );
      const imagePreview = page
        .locator("#messages")
        .getByRole("button", { name: "Open quadrants.png", exact: true });
      await imagePreview.click();
      const pane = page.locator(".image-popout");
      await pane
        .locator(".files-detail img")
        .evaluate((image: any) => image.decode());
      const sourceUrl = await pane
        .locator(".files-detail img")
        .evaluate((image: any) => image.currentSrc);
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-popout-desktop.png`,
        });
      const sidebar = pane.locator(".image-comment-sidebar");
      await sidebar
        .getByText("Ctrl-drag to comment", { exact: true })
        .waitFor();
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
      const cropWorker = page.waitForEvent("worker", {
        predicate: (worker) => worker.url().startsWith("blob:"),
      });
      const pen = await page.context().newCDPSession(page);
      const penX = fitted.x + fitted.width * 0.3;
      const penY = fitted.y + fitted.height * 0.3;
      await pen.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: penX,
        y: penY,
        pointerType: "pen",
      });
      await sidebar.getByText("Hold to comment", { exact: true }).waitFor();
      await pen.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: penX,
        y: penY,
        button: "left",
        buttons: 1,
        clickCount: 1,
        pointerType: "pen",
      });
      await pane.locator("mark.files-box-start").waitFor();
      await pen.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: penX + 30,
        y: penY + 30,
        button: "left",
        buttons: 1,
        pointerType: "pen",
      });
      await pen.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: penX + 30,
        y: penY + 30,
        button: "left",
        buttons: 0,
        clickCount: 1,
        pointerType: "pen",
      });
      await cropWorker;
      const escapeDraft = pane.locator(".report-comment-popover");
      await escapeDraft.locator("textarea").fill("Keep this draft");
      await page.keyboard.press("Escape");
      await escapeDraft.waitFor({ state: "hidden" });
      expect(await pane.isVisible()).toBeTrue();
      await page.waitForFunction(
        "document.activeElement?.getAttribute('aria-label') === 'Close image'",
      );
      expect(await pane.locator(".report-comment-input").inputValue()).toBe(
        "Keep this draft",
      );
      await page.keyboard.press("Escape");
      await pane.waitFor({ state: "detached" });
      await imagePreview.click();
      await pane
        .locator(".files-detail img")
        .evaluate((image: any) => image.decode());
      await pane.locator(".report-sendbar-count").click();
      expect(await pane.locator(".report-comment-input").inputValue()).toBe(
        "Keep this draft",
      );
      await pane.locator(".report-comment-del").click();
      await page.mouse.move(
        fitted.x + fitted.width / 2,
        fitted.y + fitted.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(fitted.x + fitted.width / 2, 2);
      await page.mouse.up();
      await page.keyboard.down("Control");
      await page.mouse.move(viewport.x + 5, viewport.y + 50);
      await page.mouse.down();
      await page.mouse.move(viewport.x + 5, 2);
      await page.mouse.up();
      await page.keyboard.up("Control");
      await page.mouse.move(
        fitted.x + fitted.width * 0.9,
        fitted.y + fitted.height * 0.1,
      );
      await page.mouse.wheel(0, -70);
      await page.waitForFunction(
        "new DOMMatrix(getComputedStyle(document.querySelector('.files-image-frame')).transform).a > 2",
      );
      expect(await page.evaluate<number>("visualViewport.scale")).toBe(1);
      const afterWheel = await pane
        .locator(".files-image-frame")
        .getAttribute("style");
      await page.mouse.move(
        fitted.x + fitted.width * 0.85,
        fitted.y + fitted.height * 0.15,
      );
      expect(
        await pane.locator(".files-image-frame").getAttribute("style"),
      ).toBe(afterWheel);
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
      for (const dx of [20, -20]) {
        await page.mouse.move(panX, panY);
        await page.mouse.down();
        await page.mouse.move(panX + dx, panY, { steps: 4 });
        await page.mouse.up();
        if (dx === 20)
          expect(await zoomFrame.getAttribute("style")).not.toBe(beforePan);
        expect(await zoomFrame.locator("mark.report-cbox").count()).toBe(0);
      }
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
      await page.keyboard.down("Control");
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
      await page.keyboard.up("Control");
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
      await input.press("Control+Enter");
      await popover.waitFor({ state: "hidden" });
      expect(
        await pane.locator(".report-sendbar-count").textContent(),
      ).toContain("1 comment");
      expect(deliveries).toEqual([]);
      expect(await geometry()).toEqual(fixed);
      await pane.locator(".report-sendbar-count").click();
      await pane.locator(".report-comments").waitFor({ state: "visible" });
      await pane
        .locator(".report-comment-input")
        .fill("Only the green region edited");
      expect(await geometry()).toEqual(fixed);
      for (let index = 0; index < 7; index++) {
        await page.keyboard.down("Control");
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
        await page.keyboard.up("Control");
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
      await page.keyboard.down("Control");
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
      await page.keyboard.up("Control");
      await input.fill("Keep this region, but widen the entrance.");
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-comments-desktop-1200.png`,
        });
      await input.press("Control+Enter");
      await popover.waitFor({ state: "hidden" });
      expect(
        await pane.locator(".report-sendbar-count").textContent(),
      ).toContain("2 comments");
      expect(deliveries).toEqual([]);
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-comments-desktop-two-staged.png`,
        });
      let failUpload = true;
      let admittedCrop = "";
      let releaseUpload!: () => void;
      let uploadStarted!: () => void;
      const gate = new Promise<void>((resolve) => (releaseUpload = resolve));
      const started = new Promise<void>((resolve) => (uploadStarted = resolve));
      await page.route("**/api/attachments", async (route) => {
        if (
          route.request().postData()?.includes("quadrants-box-2.jpg") &&
          failUpload
        ) {
          failUpload = false;
          uploadStarted();
          await gate;
          const admitted = await route.fetch();
          expect(admitted.ok()).toBeTrue();
          admittedCrop = ((await admitted.json()) as { url: string }).url;
          await route.fulfill({ status: 500, body: "Upload response lost" });
        } else await route.continue();
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
      await page.keyboard.press("Control+Enter");
      await started;
      await pane.waitFor({ state: "detached" });
      await page
        .getByRole("status")
        .filter({ hasText: "Sending 2 comments" })
        .waitFor();
      releaseUpload();
      const failure = page.locator("[data-comment-send]").getByRole("alert");
      await failure.waitFor();
      expect(await page.locator("[data-comment-send]").textContent()).toContain(
        "Only the green region",
      );
      const replacement = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 400; canvas.height = 320;
        const context = canvas.getContext('2d');
        context.fillStyle = '#ff0000'; context.fillRect(0, 0, 400, 320);
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      await page.route(sourceUrl, (route) =>
        route.fulfill({
          contentType: "image/png",
          body: Buffer.from(replacement, "base64"),
        }),
      );
      page.once("dialog", (dialog) => void dialog.accept());
      await page.reload();
      await failure.waitFor();
      expect(await page.locator("[data-comment-send]").textContent()).toContain(
        "Only the green region",
      );
      await failure.getByRole("button", { name: "Retry" }).click();
      const content = (await delivered).postDataJSON().content as string;
      const coordinates =
        /- box 1, x=(\d+) y=(\d+) w=(\d+) h=(\d+) px in the 400×320 original \(x,y = top-left\), attached as quadrants-box-1\.jpg:/.exec(
          content,
        );
      expect(coordinates).not.toBeNull();
      for (const [index, expected] of [240, 32, 120, 96].entries())
        expect(
          Math.abs(Number(coordinates![index + 1]) - expected),
        ).toBeLessThanOrEqual(1);
      const fallback =
        /- box 2, x=(\d+) y=(\d+) w=(\d+) h=(\d+) px in the 400×320 original \(x,y = top-left\), attached as quadrants-box-2\.jpg:/.exec(
          content,
        );
      expect(fallback).not.toBeNull();
      for (const [index, expected] of [220, 32, 140, 96].entries())
        expect(
          Math.abs(Number(fallback![index + 1]) - expected),
        ).toBeLessThanOrEqual(1);
      expect(content).toContain("Only the green region");
      expect(content).toContain("Keep this region, but widen the entrance.");
      expect(deliveries).toEqual([content]);
      expect(content).toContain(`![quadrants-box-2.jpg](${admittedCrop})`);
      expect(content).not.toContain("box x=");
      const cropUrl = /!\[quadrants-box-1\.jpg\]\(([^)]+)\)/.exec(content)?.[1];
      expect(cropUrl).toBeDefined();
      await pane.waitFor({ state: "detached" });
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 2" })
        .waitFor();
      const image = page.locator('#messages img[alt="quadrants-box-1.jpg"]');
      await image.locator("..").scrollIntoViewIfNeeded();
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
            data[i] > 5 ||
            data[i + 1] < 250 ||
            data[i + 2] > 5 ||
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
  // Regression: #2937 storage failure leaves the comment draft visible without a ghost send.
  async function test_outbox_storage_failure_keeps_draft(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 844 },
    });
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Keep this draft when storage is full");
      await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        const locks = navigator.locks;
        const request = locks.request;
        let release!: () => void;
        let sendKey = "";
        const gate = new Promise<void>((resolve) => (release = resolve));
        locks.request = function (name: string, callback: any) {
          sendKey = name;
          return request.call(this, name, async (lock: any) => {
            await gate;
            return callback(lock);
          });
        };
        (globalThis as any).restoreCommentStorage = () => {
          Storage.prototype.setItem = original;
          locks.request = request;
          release();
          return request.call(locks, sendKey, () => {});
        };
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith("recurse-comment-outbox-v1:"))
            throw new Error("Storage full");
          return original.call(this, key, value);
        };
      });
      let deliveries = 0;
      page.on("request", (request) => {
        if (request.url().endsWith(`/api/conversations/${demo}/deliver`))
          deliveries++;
      });
      await input.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
      const retry = pane.getByRole("button", {
        name: "Couldn’t save comments — retry",
      });
      await retry.waitFor();
      expect(await pane.isVisible()).toBeTrue();
      expect(await pane.locator(".report-comment-input").inputValue()).toBe(
        "Keep this draft when storage is full",
      );
      expect(await page.locator("[data-comment-send]").count()).toBe(0);
      expect(deliveries).toBe(0);
      await page.evaluate("globalThis.restoreCommentStorage()");
      expect(await page.locator("[data-comment-send]").count()).toBe(0);
      expect(deliveries).toBe(0);
      await retry.click();
      await pane.waitFor({ state: "detached" });
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 1" })
        .waitFor();
      expect(deliveries).toBe(1);
    } finally {
      await page.close();
    }
  },
  // Regression: #2937 storage deletions during batched restore must not skip a pending send.
  async function test_restore_after_storage_keys_shift(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 844 },
    });
    const source = await context.newPage();
    const page = await context.newPage();
    try {
      const png = await source.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await source.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await source.goto(`${base}#agent=${demo}`);
      await source.locator("#conv-title").waitFor();
      await source.evaluate((recipient) => {
        localStorage.clear();
        const prefix = "recurse-comment-outbox-v1:";
        for (let i = 0; i < 140; i++) {
          const clientId = `c-fixture-${i.toString(36)}`;
          localStorage.setItem(
            prefix + clientId,
            JSON.stringify({
              recipient,
              clientId,
              text: `Restored ${clientId}`,
              snapshot: `Restored ${clientId}`,
              count: 1,
              sinceOffset: 0,
              crops: [],
            }),
          );
        }
      }, demo);
      await page.addInitScript(() => {
        let reads = 0;
        (globalThis as any).commentScanKeys = [];
        Storage.prototype.key = function (index: number) {
          const key = Object.keys(this).sort()[index] ?? null;
          if (++reads <= 64) (globalThis as any).commentScanKeys.push(key);
          return key;
        };
        const originalTimeout = window.setTimeout.bind(window);
        let held = false;
        window.setTimeout = ((
          callback: any,
          delay?: number,
          ...args: any[]
        ) => {
          if (reads >= 64 && !held && delay === 0) {
            held = true;
            (globalThis as any).commentScanHeld = true;
            (globalThis as any).releaseCommentScan = () =>
              originalTimeout(callback, delay, ...args);
            return 0;
          }
          return originalTimeout(callback, delay, ...args);
        }) as typeof window.setTimeout;
        addEventListener("storage", (event: any) => {
          if (event.newValue === null)
            (globalThis as any).commentScanDeletion = true;
        });
      });
      await page.goto(`${base}#agent=${demo}`);
      await page.waitForFunction("globalThis.commentScanHeld === true");
      const scanned: string[] = await page.evaluate(
        "globalThis.commentScanKeys",
      );
      await source.evaluate(
        (removed) => localStorage.removeItem(removed),
        scanned[0]!,
      );
      await page.waitForFunction("globalThis.commentScanDeletion === true");
      const after: string[] = await page.evaluate(() =>
        Array.from({ length: localStorage.length }, (_, index) =>
          localStorage.key(index),
        ),
      );
      const target = after
        .slice(0, 64)
        .find(
          (key) =>
            key.startsWith("recurse-comment-outbox-v1:") &&
            !scanned.includes(key),
        );
      expect(target).toBeDefined();
      await page.evaluate("globalThis.releaseCommentScan()");
      const pending = page.locator(
        `[data-comment-send="${target!.slice("recurse-comment-outbox-v1:".length)}"]`,
      );
      await pending.getByRole("button", { name: "Retry" }).click();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 0" })
        .waitFor();
      await pending.waitFor({ state: "detached" });
    } finally {
      await context.close();
    }
  },
  // Regression: #2937 already-open tabs reconcile comment sends without sending them.
  async function test_open_tab_reconciles_comment_send(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 844 },
    });
    const page = await context.newPage();
    const other = await context.newPage();
    let releaseUpload!: () => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => (uploadStarted = resolve));
    const release = new Promise<void>((resolve) => (releaseUpload = resolve));
    let releaseRetry!: () => void;
    let retryStarted!: () => void;
    const retry = new Promise<void>((resolve) => (retryStarted = resolve));
    const retryGate = new Promise<void>((resolve) => (releaseRetry = resolve));
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await page.goto(`${base}#agent=${demo}`);
      await other.goto(`${base}#agent=${demo}`);
      await other.locator("#conv-title").waitFor();
      let otherDeliveries = 0;
      other.on("request", (request) => {
        if (request.url().endsWith(`/api/conversations/${demo}/deliver`))
          otherDeliveries++;
      });
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Reconcile this crop");
      let failUpload = true;
      await page.route(`${base}api/attachments`, async (route) => {
        if (!failUpload) {
          retryStarted();
          await retryGate;
          return route.continue();
        }
        failUpload = false;
        uploadStarted();
        await release;
        await route.fulfill({ status: 500 });
      });
      await input.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
      await started;
      const pending = other.locator("[data-comment-send]");
      await pending
        .getByText("Reconcile this crop", { exact: false })
        .waitFor();
      await pending
        .getByRole("status")
        .getByText("Waiting for another tab…")
        .waitFor();
      expect(await pending.getByRole("button").count()).toBe(0);
      expect(
        await other.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          (globalThis as any).dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBeTrue();
      releaseUpload();
      await page.locator("[data-comment-send]").getByRole("alert").waitFor();
      await pending.getByRole("alert").waitFor();
      await other.evaluate(() => {
        (globalThis as any).addEventListener("storage", (event: any) => {
          if (event.key?.startsWith("recurse-comment-outbox-v1:"))
            (globalThis as any).commentStorageEvents =
              ((globalThis as any).commentStorageEvents || 0) + 1;
        });
      });
      const original = await page.evaluate(() => {
        const localStorage = (globalThis as any).localStorage;
        const key = Object.keys(localStorage).find((key) =>
          key.startsWith("recurse-comment-outbox-v1:"),
        )!;
        const value = localStorage.getItem(key)!;
        const data = JSON.parse(value);
        data.text = "Wrong crop identity";
        data.crops[0].token = "different-crop";
        localStorage.setItem(key, JSON.stringify(data));
        return { key, value };
      });
      await other.waitForFunction("globalThis.commentStorageEvents >= 1");
      expect(await pending.textContent()).not.toContain("Wrong crop identity");
      await page.evaluate(({ key, value }) => {
        const data = JSON.parse(value);
        data.text = "Updated in the first tab";
        (globalThis as any).localStorage.setItem(key, JSON.stringify(data));
      }, original);
      await pending
        .getByText("Updated in the first tab", { exact: false })
        .waitFor();
      await page.evaluate(
        ({ key, value }) =>
          (globalThis as any).localStorage.setItem(key, value),
        original,
      );
      await pending
        .getByText("Reconcile this crop", { exact: false })
        .waitFor();
      await page
        .locator("[data-comment-send]")
        .getByRole("button", { name: "Retry" })
        .click();
      await retry;
      await pending
        .getByRole("status")
        .getByText("Waiting for another tab…")
        .waitFor();
      expect(await pending.getByRole("button").count()).toBe(0);
      releaseRetry();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 1" })
        .waitFor();
      await pending.waitFor({ state: "detached" });
      expect(otherDeliveries).toBe(0);
      expect(
        await other.evaluate(() => {
          const event = new Event("beforeunload", { cancelable: true });
          (globalThis as any).dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBeFalse();
    } finally {
      releaseUpload();
      releaseRetry();
      await context.close();
    }
  },
  // Regression: #2937 another tab cannot discard crops while a send is active.
  async function test_other_tab_waits_for_active_send(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 844 },
    });
    const page = await context.newPage();
    let releaseUpload!: () => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Keep this crop");
      await page.route(`${base}api/attachments`, async (route) => {
        uploadStarted();
        await release;
        await route.continue();
      });
      await input.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
      await started;
      const other = await context.newPage();
      await other.goto(`${base}#agent=${demo}`);
      const pending = other.locator("[data-comment-send]");
      await pending.getByRole("status").waitFor();
      expect(await pending.getByRole("button").count()).toBe(0);
      releaseUpload();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 1" })
        .waitFor();
      await pending.waitFor({ state: "detached" });
      const sentImage = page.locator(
        '#messages img[alt="quadrants-box-1.jpg"]',
      );
      await sentImage.waitFor();
      expect(
        (
          await page.request.get(
            new URL((await sentImage.getAttribute("src"))!, base).href,
          )
        ).ok(),
      ).toBeTrue();
    } finally {
      releaseUpload();
      await context.close();
    }
  },
  // Regression: #2937 a crop upload that never reached the server can be retried after expiry.
  async function test_retry_expired_crop(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 844 },
    });
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      await page.route(`${base}api/attachments`, (route) => route.abort());
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Retry the expired crop");
      await input.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
      const failure = page.locator("[data-comment-send]").getByRole("alert");
      await failure.getByRole("button", { name: "Retry" }).waitFor();
      const oldKey = await page.evaluate<string>(`(() => {
        const key = Object.keys(localStorage).find(item => item.startsWith('recurse-comment-outbox-v1:'));
        const data = JSON.parse(localStorage.getItem(key));
        const oldKey = data.crops[0].key;
        data.crops[0].expires = Date.now() - 1000;
        localStorage.setItem(key, JSON.stringify(data));
        return oldKey;
      })()`);
      await page.unroute(`${base}api/attachments`);
      const cancelled = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          response.url().includes(`/attachment-crops/${oldKey}?`),
      );
      await failure.getByRole("button", { name: "Retry" }).click();
      expect((await cancelled).ok()).toBeTrue();
      await page.locator("[data-comment-send]").waitFor({ state: "detached" });
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 1" })
        .waitFor();
    } finally {
      await page.close();
    }
  },
  // Regression: #3020 without Web Locks image comments retain their crop through the shared database lock.
  async function test_browser_without_locks(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 844 },
    });
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await page.addInitScript(
        "Object.defineProperty(navigator, 'locks', { value: undefined }); Object.defineProperty(crypto, 'randomUUID', { value: undefined })",
      );
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Keep this crop without Web Locks");
      await input.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
      await page.locator("[data-comment-send]").waitFor({ state: "detached" });
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 1" })
        .waitFor();
      const sent = page.locator('#messages img[alt="quadrants-box-1.jpg"]');
      await sent.waitFor();
      await sent.evaluate((image: any) => image.decode());
    } finally {
      await page.close();
    }
  },
  // Regression: #2937 blocked storage still permits a text-only send without leaving an admitted retry.
  async function test_crop_database_unavailable(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 844 },
    });
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await page.addInitScript(`(() => {
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, version) => { if (name === 'recurse-comment-crops') throw new DOMException('Unavailable', 'SecurityError'); return open(name, version); };
      })()`);
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Comment without image");
      await input.press("Control+Enter");
      await page.keyboard.press("Control+Enter");
      await pane.waitFor({ state: "detached" });
      const failure = page.locator("[data-comment-send]").getByRole("alert");
      const delivery = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${demo}/deliver`),
      );
      await failure
        .getByRole("button", { name: "Send without images" })
        .click();
      expect((await delivery).postDataJSON().content).toContain(
        "Comment without image",
      );
      await page.locator("[data-comment-send]").waitFor({ state: "detached" });
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 0" })
        .waitFor();
    } finally {
      await page.close();
    }
  },
  // Regression: #2937 an interrupted crop save never substitutes pixels from a changed source.
  async function test_reload_before_crop_is_saved(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 844 },
    });
    try {
      const png = await page.evaluate<string>(`(() => {
        const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      const { demo } = (await seeded.json()) as { demo: string };
      await page.goto(`${base}#agent=${demo}`);
      await page.locator('#messages img[alt="quadrants.png"]').click();
      const pane = page.locator(".image-popout");
      const image = pane.locator(".files-detail img");
      await image.evaluate((element: any) => element.decode());
      const box = (await image.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const input = pane.locator(".report-comment-popover textarea");
      await input.fill("Keep the comment");
      await page.evaluate(
        `IDBObjectStore.prototype.put = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); }`,
      );
      await pane.getByRole("button", { name: "Close image" }).focus();
      await page.keyboard.press("Control+Enter");
      await pane.waitFor({ state: "detached" });
      await page.locator("[data-comment-send]").getByRole("alert").waitFor();
      page.on("dialog", (dialog) => void dialog.accept());
      await page.reload();
      const failure = page.locator("[data-comment-send]").getByRole("alert");
      await failure.getByRole("button", { name: "Retry" }).click();
      await failure
        .getByText("Image could not be saved. Send without images or discard.")
        .waitFor();
      const delivery = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${demo}/deliver`),
      );
      await failure
        .getByRole("button", { name: "Send without images" })
        .click();
      const content = (await delivery).postDataJSON().content as string;
      expect(content).toContain("Keep the comment");
      expect(content).not.toContain("![");
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Acknowledged. Images: 0" })
        .waitFor();
    } finally {
      await page.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["image-box-crops", tests]]);
