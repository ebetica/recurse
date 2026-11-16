import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  type BrowserTest,
  captureErrors,
  postFixture,
  runBrowserTests,
} from "./common";
declare const requestAnimationFrame: any;

export const tests: BrowserTest[] = [
  // Regression: #3327 desktop images fill and center in docked and fullscreen panes.
  async function test_desktop_image_fills_pane_and_fullscreen(browser, base) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = captureErrors(page);
    const fixtures: Array<{ demo: string; shape: string }> = [];
    for (const [shape, width, height] of [
      ["landscape", 2400, 1500],
      ["portrait", 1500, 2400],
      ["small", 40, 25],
    ] as const) {
      const png = await page.evaluate(
        ({ width, height, shape }) => {
          const canvas = (globalThis as any).document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, width, height);
          context.fillStyle = "#2680a0";
          context.fillRect(
            width * 0.1,
            height * 0.2,
            width * 0.35,
            height * 0.6,
          );
          context.fillStyle = "#50a060";
          context.fillRect(
            width * 0.55,
            height * 0.35,
            width * 0.35,
            height * 0.45,
          );
          context.font = `${height * 0.06}px sans-serif`;
          context.fillText(
            `${shape}: ${width} × ${height}`,
            width * 0.1,
            height * 0.13,
          );
          return canvas.toDataURL("image/png").split(",")[1];
        },
        { width, height, shape },
      );
      const seeded = await page.request.post(
        `${base}__browser-test/seed-posted-quadrants`,
        {
          headers: { "Content-Type": "image/png" },
          data: Buffer.from(png, "base64"),
        },
      );
      expect(seeded.ok()).toBeTrue();
      fixtures.push({ ...(await seeded.json()), shape });
    }
    const measurements: Array<{ name: string; error: number }> = [];
    for (const size of [
      { width: 2000, height: 1193 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size);
      for (const { demo, shape } of fixtures) {
        await page.goto(`${base}#agent=${demo}`, {
          waitUntil: "domcontentloaded",
        });
        const listTab = page.locator('.dv-tab[data-dock-panel="files"]');
        if (await listTab.count()) await listTab.click();
        else await page.locator('.rail-btn[data-pane="files"]').click();
        await page
          .locator(".files-card")
          .getByRole("button", { name: "Open quadrants.png", exact: true })
          .click();
        const pane = page.locator(".pane-col.file-tab:visible");
        const image = pane.locator(".files-image");
        await image.evaluate((image: any) => image.decode());
        for (const fullscreen of [false, true]) {
          if (fullscreen) {
            await pane.locator(".pane-body").focus();
            await page.keyboard.press("z");
            await browserExpect(pane).toHaveClass(/fullscreen/);
          }
          const error = await image.evaluate((image: any) => {
            const rect = image.getBoundingClientRect();
            const frame = image.parentElement.getBoundingClientRect();
            const viewport = image.closest(".image-zoom-viewport");
            const area = viewport.getBoundingClientRect();
            const body = image.closest(".pane-body").getBoundingClientRect();
            const header = image
              .closest(".files-detail")
              .querySelector(".files-detail-bar")
              .getBoundingClientRect();
            const scale = Math.min(
              area.width / image.naturalWidth,
              (body.bottom - header.bottom) / image.naturalHeight,
            );
            return Math.max(
              Math.abs(rect.left - frame.left),
              Math.abs(rect.top - frame.top),
              Math.abs(rect.width - frame.width),
              Math.abs(rect.height - frame.height),
              Math.abs(area.top - header.bottom),
              Math.abs(area.bottom - body.bottom),
              Math.abs(rect.width - image.naturalWidth * scale),
              Math.abs(rect.height - image.naturalHeight * scale),
              Math.abs(rect.left + rect.width / 2 - area.left - area.width / 2),
              Math.abs(
                rect.top + rect.height / 2 - (header.bottom + body.bottom) / 2,
              ),
            );
          });
          measurements.push({
            name: `${size.width} ${shape} ${fullscreen}`,
            error,
          });
          if (
            shape === "landscape" &&
            process.env.RECURSE_BROWSER_SCREENSHOT_DIR
          )
            await page.screenshot({
              path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-fit-${size.width}-${fullscreen ? "fullscreen" : "docked"}.png`,
            });
          if (fullscreen) {
            await pane
              .getByRole("button", { name: "Exit fullscreen", exact: true })
              .click();
            await browserExpect(pane).not.toHaveClass(/fullscreen/);
          }
        }
      }
    }
    for (const { name, error } of measurements)
      expect(error, name).toBeLessThanOrEqual(1);
    const pane = page.locator(".pane-col.file-tab:visible");
    const image = pane.locator(".files-image");
    const fitted = (await image.boundingBox())!;
    const drawBox = async () => {
      const rect = (await image.boundingBox())!;
      await page.mouse.move(
        rect.x + rect.width * 0.2,
        rect.y + rect.height * 0.2,
      );
      await page.keyboard.down("Control");
      await page.mouse.down();
      await page.mouse.move(
        rect.x + rect.width * 0.4,
        rect.y + rect.height * 0.4,
        { steps: 4 },
      );
      await page.mouse.up();
      await page.keyboard.up("Control");
    };
    await drawBox();
    const draft = page.locator(".report-comment-popover");
    await draft.locator("textarea").waitFor();
    for (const scale of [1, 2, 1]) {
      if (scale === 2)
        await pane
          .locator(".image-zoom-viewport")
          .dblclick({ position: { x: fitted.width * 0.8, y: 30 } });
      else if (await pane.locator(".image-zoom-reset").isVisible())
        await pane.locator(".image-zoom-reset").click();
      const alignment = await image.evaluate((image: any) => {
        const rect = image.getBoundingClientRect();
        const mark = image.parentElement
          .querySelector("mark.report-cbox")
          .getBoundingClientRect();
        return {
          x: (mark.left - rect.left) / rect.width,
          y: (mark.top - rect.top) / rect.height,
          w: mark.width / rect.width,
          h: mark.height / rect.height,
        };
      });
      expect(alignment.x).toBeCloseTo(0.2, 2);
      expect(alignment.y).toBeCloseTo(0.2, 2);
      expect(alignment.w).toBeCloseTo(0.2, 2);
      expect(alignment.h).toBeCloseTo(0.2, 2);
      const zoom = await image.evaluate(
        (image: any) => image.getBoundingClientRect().width,
      );
      expect(zoom).toBeCloseTo(fitted.width * scale, 0);
    }
    for (let index = 0; index < 6; index++) {
      if (index) await drawBox();
      await draft.locator("textarea").fill(`Region ${index + 1}`);
      await draft.locator("textarea").press("Control+Enter");
      await draft.waitFor({ state: "hidden" });
    }
    const comments = pane.locator(".report-comments");
    expect(
      await comments.evaluate(
        (list: any) => list.scrollHeight > list.clientHeight,
      ),
    ).toBeTrue();
    await comments.locator("textarea").last().scrollIntoViewIfNeeded();
    expect(
      await comments.evaluate((list: any) => list.scrollTop),
    ).toBeGreaterThan(0);
    const imageBox = (await image.boundingBox())!;
    const commentBox = (await comments.boundingBox())!;
    expect(imageBox.height).toBeGreaterThan(0);
    expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(commentBox.y + 1);
    const send = pane.locator(".report-sendbar-send");
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-comments-docked.png`,
      });
    expect(
      await send.evaluate((button: any) => {
        const rect = button.getBoundingClientRect();
        return [rect.left + 8, rect.right - 8].every((x) =>
          [rect.top + 8, rect.bottom - 8].every((y) =>
            button.contains(
              (globalThis as any).document.elementFromPoint(x, y),
            ),
          ),
        );
      }),
    ).toBeTrue();
    await send.click();
    await page
      .locator(".msg.assistant")
      .filter({ hasText: "Acknowledged. Images: 6" })
      .waitFor();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Feature: #3364 wheel zoom, pan and single-step gallery gestures preserve #2742 cached previews.
  async function test_large_image_gallery_keeps_previews(browser, base) {
    const fixture = (await postFixture(base, "seed-large-image-gallery")) as {
      demo: string;
    };
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.clock.install();
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("#messages .agent-attachment-preview").first().click();
    const viewer = page.locator(".image-popout");
    await viewer.locator(".files-position", { hasText: "of 30" }).waitFor();
    const previous = viewer.getByRole("button", {
      name: "Previous image",
      exact: true,
    });
    while (await previous.isEnabled()) await previous.click();
    const firstName = await viewer
      .locator(".files-detail")
      .getAttribute("aria-label");
    await viewer
      .getByRole("button", { name: "Next image", exact: true })
      .click();
    const secondName = await viewer
      .locator(".files-detail")
      .getAttribute("aria-label");
    await previous.click();
    for (const direction of ["Next image", "Previous image"]) {
      const button = viewer.getByRole("button", {
        name: direction,
        exact: true,
      });
      while (await button.isEnabled()) {
        await viewer
          .locator("img[src]")
          .evaluate((image: any) => image.decode());
        await button.click();
        expect(
          await viewer
            .getByRole("button", { name: "Reload preview", exact: true })
            .count(),
        ).toBe(0);
      }
    }
    expect(
      await viewer.locator(".files-detail").getAttribute("aria-label"),
    ).toBe(firstName);
    const image = viewer.locator(".files-image");
    await image.evaluate((image: any) => image.decode());
    const fitted = (await image.boundingBox())!;
    const pointer = {
      x: fitted.x + fitted.width * 0.6,
      y: fitted.y + fitted.height * 0.4,
    };
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, 70);
    await page.clock.runFor(16);
    expect(await image.boundingBox()).toEqual(fitted);
    await browserExpect(viewer.locator(".files-detail")).toHaveAttribute(
      "aria-label",
      firstName!,
    );
    await page.mouse.wheel(0, -70);
    await browserExpect
      .poll(async () => (await image.boundingBox())!.width)
      .toBeGreaterThan(fitted.width * 2);
    const zoomed = (await image.boundingBox())!;
    expect((pointer.x - zoomed.x) / zoomed.width).toBeCloseTo(0.6, 2);
    expect((pointer.y - zoomed.y) / zoomed.height).toBeCloseTo(0.4, 2);
    await page.mouse.wheel(35, 25);
    await browserExpect
      .poll(async () => (await image.boundingBox())!.x)
      .toBeCloseTo(zoomed.x - 35, 0);
    const panned = (await image.boundingBox())!;
    expect(panned.y).toBeCloseTo(zoomed.y - 25, 0);
    expect(panned.width).toBeCloseTo(zoomed.width, 0);
    await page.mouse.wheel(10000, 0);
    await browserExpect
      .poll(async () => (await image.boundingBox())!.x)
      .toBeLessThan(panned.x);
    const edge = (await image.boundingBox())!;
    await page.mouse.wheel(10000, 0);
    expect((await image.boundingBox())!.x).toBeCloseTo(edge.x, 0);
    await browserExpect(viewer.locator(".files-detail")).toHaveAttribute(
      "aria-label",
      firstName!,
    );
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -30);
    await page.keyboard.up("Control");
    await browserExpect
      .poll(async () => (await image.boundingBox())!.width)
      .toBeGreaterThan(zoomed.width);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 1000);
    await page.keyboard.up("Control");
    await browserExpect
      .poll(async () => (await image.boundingBox())!.width)
      .toBeCloseTo(fitted.width, 0);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    for (const [delta, name] of [
      [80, secondName],
      [-80, firstName],
    ] as const) {
      await page.clock.fastForward(300);
      for (let event = 0; event < 3; event++) {
        await page.mouse.wheel(delta, 0);
        await page.clock.runFor(16);
      }
      await browserExpect(viewer.locator(".files-detail")).toHaveAttribute(
        "aria-label",
        name!,
      );
      await image.evaluate((image: any) => image.decode());
      expect((await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);
    }
    await page.clock.resume();
    const pane = page.locator('.pane-col[data-pane="files"]');
    await viewer
      .getByRole("button", { name: "Open in Files", exact: true })
      .click();
    const file = page.locator(".pane-col.file-tab:visible");
    await file.locator(".files-detail").waitFor();
    if (!(await pane.isVisible()))
      await page.locator('.rail-btn[data-pane="files"]').click();
    await pane.locator(".files-thumb").first().click();
    await file.locator(".files-image").evaluate((image: any) => image.decode());
    await file
      .getByRole("button", { name: "Previous file", exact: true })
      .click();
    const previousFile = await file
      .locator(".files-detail")
      .getAttribute("aria-label");
    await file.getByRole("button", { name: "Next file", exact: true }).click();
    const tabViewport = (await file
      .locator(".image-zoom-viewport")
      .boundingBox())!;
    await page.mouse.move(
      tabViewport.x + tabViewport.width / 2,
      tabViewport.y + tabViewport.height / 2,
    );
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    for (let event = 0; event < 3; event++) {
      await page.mouse.wheel(-80, 0);
      await page.clock.runFor(16);
    }
    await browserExpect(file.locator(".files-detail")).toHaveAttribute(
      "aria-label",
      previousFile!,
    );
    await page.clock.resume();
    await page.locator('.dv-tab[data-dock-panel="chat"]').click();
    await page.locator("#messages .agent-attachment-preview").first().click();
    await viewer
      .locator(".files-image")
      .evaluate((image: any) => image.decode());
    const box = (await viewer.locator(".image-zoom-viewport").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -70);
    await page.keyboard.up("Control");
    await page.waitForFunction(
      "new DOMMatrix(getComputedStyle(document.querySelector('.image-popout .files-image-frame')).transform).a > 1.5",
    );
    const url = page.url();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    expect(page.url()).toBe(url);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator("#dock").waitFor({ state: "detached" });
    if (!(await pane.isVisible()))
      await page
        .getByRole("button", { name: "All files", exact: true })
        .click();
    await pane.locator(".files-thumb").first().click();
    await viewer
      .getByRole("button", { name: "Close image", exact: true })
      .click();
    await viewer.waitFor({ state: "detached" });
    expect(await pane.locator(".files-card").first().isVisible()).toBeTrue();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #3103 keeps submitted comments in view; preserves #2966 downloads, #2862 drafts, #2858 gestures, #2859 standalone uploads and #2978 compact labels.
  async function test_published_images_touch_gallery(browser, base) {
    const fixture = (await postFixture(
      base,
      "seed-published-image-navigation",
    )) as { demo: string };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.addInitScript(() => {
      Object.defineProperty((globalThis as any).navigator, "share", {
        configurable: true,
        value: undefined,
      });
    });
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    const images = page.locator("#messages .agent-attachment-preview");
    await images.nth(5).waitFor();
    const pane = page.locator('.pane-col[data-pane="files"]');
    const viewer = page.locator(".image-popout");
    const detail = viewer.locator(".files-detail");
    const position = viewer.locator(".files-position");
    await page.locator('#messages img[alt="operator.png"]').tap();
    await viewer.locator('.files-detail[aria-label="operator.png"]').waitFor();
    expect(await pane.count()).toBe(0);
    await viewer
      .getByRole("button", { name: "Open in Files", exact: true })
      .tap();
    await pane.locator('.files-detail[aria-label="operator.png"]').waitFor();
    await pane.getByRole("button", { name: "All files" }).tap();
    await pane.locator(".files-card").nth(6).waitFor();
    const order = await pane
      .locator(".files-card")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("aria-label")),
      );
    expect(order).toHaveLength(7);
    expect(order.slice(0, 3)).toEqual([
      "operator.png",
      "published-2.png",
      "next-reply.png",
    ]);
    order.splice(order.indexOf("operator.png"), 1);
    order.reverse();
    await pane.getByRole("button", { name: "Close Files" }).tap();
    await pane.waitFor({ state: "detached" });
    const middleImage = images.locator('img[alt="published-3.png"]').first();
    const opened = await middleImage.getAttribute("alt");
    const originalSource = await middleImage.getAttribute("src");
    await middleImage.tap();
    const start = order.indexOf(opened);
    await viewer.locator(`.files-detail[aria-label="${opened}"]`).waitFor();
    expect(await pane.count()).toBe(0);
    expect(await position.textContent()).toBe(`${start + 1} of 6`);
    await detail.locator("img[src]").waitFor();
    expect(await detail.locator("img").getAttribute("src")).toBe(
      originalSource!.replace(/\/thumbnail$/, "/preview"),
    );
    const download = viewer.getByRole("button", {
      name: "Download",
      exact: true,
    });
    expect(await download.isVisible()).toBeTrue();
    const downloadBox = (await download.boundingBox())!;
    expect(downloadBox.width).toBeGreaterThanOrEqual(44);
    expect(downloadBox.height).toBeGreaterThanOrEqual(44);
    const originalUrl = originalSource!.replace(/\/thumbnail$/, "");
    const original = await (
      await context.request.get(new URL(originalUrl, base).href)
    ).body();
    const requested = page.waitForRequest(new URL(originalUrl, base).href);
    const downloaded = page.waitForEvent("download");
    await download.tap();
    const saved = await downloaded;
    expect(saved.suggestedFilename()).toBe(opened!);
    expect((await requested).url()).toBe(new URL(originalUrl, base).href);
    expect(await Bun.file((await saved.path())!).bytes()).toEqual(
      new Uint8Array(original),
    );
    await page.evaluate(() => {
      const browser = globalThis as any;
      Object.defineProperty(browser.navigator, "canShare", {
        configurable: true,
        value: ({ files }: any) =>
          files.length === 1 && files[0] instanceof browser.File,
      });
      Object.defineProperty(browser.navigator, "share", {
        configurable: true,
        value: async ({ files }: any) => {
          browser.sharedImage = {
            name: files[0].name,
            type: files[0].type,
            bytes: Array.from(new Uint8Array(await files[0].arrayBuffer())),
          };
        },
      });
    });
    await download.tap();
    await page.waitForFunction("window.sharedImage");
    expect(
      await page.evaluate<{ name: string; type: string; bytes: number[] }>(
        "window.sharedImage",
      ),
    ).toEqual({
      name: opened!,
      type: "image/png",
      bytes: Array.from(original),
    });
    const shown = () => detail.getAttribute("aria-label");
    const touch = await context.newCDPSession(page);
    const dragBox = async (from: { x: number; y: number }, hold = false) => {
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [from],
      });
      if (hold) await viewer.locator("mark.files-box-start").waitFor();
      for (const offset of [10, 30])
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: from.x + offset, y: from.y + offset }],
        });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    const doubleTap = async (at: { x: number; y: number }) => {
      const start = Date.now() / 1000;
      for (const [type, offset] of [
        ["touchStart", 0],
        ["touchEnd", 0.05],
        ["touchStart", 0.15],
        ["touchEnd", 0.2],
      ] as const)
        await touch.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: type === "touchStart" ? [at] : [],
          timestamp: start + offset,
        });
    };
    const swipe = async (dx: number, dy = 0) => {
      await page.waitForFunction(
        "document.querySelector('.files-detail img')?.naturalWidth > 0",
      );
      const box = (await detail.locator("img").boundingBox())!;
      const viewport = await page.evaluate<{ width: number; height: number }>(
        "({ width: visualViewport.width, height: visualViewport.height })",
      );
      const from = {
        x: Math.min(box.x + box.width / 2, viewport.width - 10),
        y: Math.min(box.y + box.height / 2, viewport.height - 10),
      };
      await touch.send("Input.synthesizeScrollGesture", {
        x: from.x,
        y: from.y,
        xDistance: dx,
        yDistance: dy,
        gestureSourceType: "touch",
        preventFling: true,
      });
    };
    await swipe(-100);
    expect(await shown()).toBe(order[start + 1]);
    expect(await position.textContent()).toBe(`${start + 2} of 6`);
    await swipe(100);
    expect(await shown()).toBe(order[start]);
    await swipe(0, 100);
    expect(await shown()).toBe(order[start]);
    await viewer.getByRole("button", { name: "Next image" }).tap();
    expect(await shown()).toBe(order[start + 1]);
    await page.keyboard.press("ArrowLeft");
    expect(await shown()).toBe(order[start]);
    await page.keyboard.press("ArrowRight");
    expect(await shown()).toBe(order[start + 1]);
    await viewer.getByRole("button", { name: "Previous image" }).tap();
    expect(await shown()).toBe(order[start]);
    const hint = viewer.getByText("Hold to comment", { exact: true });
    await hint.waitFor();
    expect(
      await viewer
        .getByRole("button", { name: "Submit comments", exact: true })
        .innerText(),
    ).toBe("Submit");
    expect(
      await hint.evaluate((element: any) => {
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
    ).toBe(1);
    const frame = viewer.locator(".files-image-frame");
    const box = (await frame.boundingBox())!;
    let center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: center.x - 20, y: center.y, id: 1 },
        { x: center.x + 20, y: center.y, id: 2 },
      ],
    });
    for (let spread = 25; spread <= 70; spread += 5)
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: center.x - spread, y: center.y, id: 1 },
          { x: center.x + spread, y: center.y, id: 2 },
        ],
      });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    const transform = () =>
      frame.evaluate(
        (node) =>
          (globalThis as any).getComputedStyle(node).transform as string,
      );
    const scale = () =>
      frame.evaluate((node) => {
        const browser = globalThis as any;
        return new browser.DOMMatrix(browser.getComputedStyle(node).transform)
          .a as number;
      });
    expect(await scale()).toBeGreaterThan(2);
    expect(await page.evaluate<number>("visualViewport.scale")).toBe(1);
    const before = await transform();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: center.x - 20, y: center.y, id: 1 },
        { x: center.x + 20, y: center.y, id: 2 },
      ],
    });
    for (const offset of [10, 30, 60])
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: center.x - 20 - offset, y: center.y, id: 1 },
          { x: center.x + 20 - offset, y: center.y, id: 2 },
        ],
      });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    expect(await transform()).not.toBe(before);
    expect(await frame.locator("mark.report-cbox").count()).toBe(0);
    expect(await shown()).toBe(order[start]);
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-zoom-mobile.png`,
      });
    await doubleTap(center);
    await browserExpect.poll(scale).toBe(1);
    await doubleTap(center);
    await browserExpect.poll(scale).toBe(2);
    const beforeOneFinger = await transform();
    await dragBox(center);
    expect(await transform()).not.toBe(beforeOneFinger);
    expect(await frame.locator("mark.report-cbox").count()).toBe(0);
    expect(await shown()).toBe(order[start]);
    const heldTransform = await transform();
    const zoomedBox = (await frame.boundingBox())!;
    await dragBox(center, true);
    await page.locator(".report-comment-popover textarea").waitFor();
    expect(await transform()).toBe(heldTransform);
    const mark = (await frame.locator("mark.report-cbox").boundingBox())!;
    expect(mark.width).toBeCloseTo(30, 0);
    expect(mark.height).toBeCloseTo(30, 0);
    const coordinates = await frame
      .locator("mark.report-cbox")
      .evaluate((node: any) => ({
        x: parseFloat(node.style.left) / 100,
        y: parseFloat(node.style.top) / 100,
        w: parseFloat(node.style.width) / 100,
        h: parseFloat(node.style.height) / 100,
      }));
    expect(coordinates.x).toBeCloseTo(
      (center.x - zoomedBox.x) / zoomedBox.width,
      3,
    );
    expect(coordinates.y).toBeCloseTo(
      (center.y - zoomedBox.y) / zoomedBox.height,
      3,
    );
    expect(coordinates.w).toBeCloseTo(30 / zoomedBox.width, 3);
    expect(coordinates.h).toBeCloseTo(30 / zoomedBox.height, 3);
    const popover = page.locator(".report-comment-popover");
    await popover.getByRole("button", { name: "Cancel", exact: true }).tap();
    await viewer.getByRole("button", { name: "Fit image", exact: true }).tap();
    const commentedBox = (await frame.boundingBox())!;
    center = {
      x: commentedBox.x + commentedBox.width / 2,
      y: commentedBox.y + commentedBox.height / 2,
    };
    await page.mouse.move(center.x, center.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -70);
    await page.keyboard.up("Control");
    await page.waitForFunction(
      "new DOMMatrix(getComputedStyle(document.querySelector('.files-image-frame')).transform).a > 1.5",
    );
    expect(await page.evaluate<number>("visualViewport.scale")).toBe(1);
    await viewer.getByRole("button", { name: "Fit image", exact: true }).tap();
    await page.mouse.dblclick(center.x, center.y);
    expect(await scale()).toBe(2);
    await page.mouse.dblclick(center.x, center.y);
    expect(await scale()).toBe(1);
    for (let index = start + 1; index < order.length; index++) {
      await swipe(-100);
      expect(await shown()).toBe(order[index]);
    }
    await swipe(-100);
    expect(await shown()).toBe(order[5]);
    expect(await position.textContent()).toBe("6 of 6");
    expect(
      await viewer.getByRole("button", { name: "Next image" }).isDisabled(),
    ).toBeTrue();
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-viewer-phone.png`,
      });
    await viewer
      .getByRole("button", { name: "Close image", exact: true })
      .tap();
    await viewer.waitFor({ state: "detached" });
    expect(await images.nth(1).isVisible()).toBeTrue();
    await images.nth(1).tap();
    await viewer.waitFor();
    await page.goBack();
    await viewer.waitFor({ state: "detached" });
    await images.nth(1).tap();
    await viewer.waitFor();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    await images.nth(1).tap();
    await viewer
      .locator(".files-image")
      .evaluate((image: any) => image.decode());
    const outside = (await viewer
      .locator(".image-zoom-viewport")
      .boundingBox())!;
    await page.touchscreen.tap(outside.x + 2, outside.y + 2);
    await viewer.waitFor({ state: "detached" });
    await images.nth(1).tap();
    await viewer
      .locator(".files-image")
      .evaluate((image: any) => image.decode());
    const sendBox = (await frame.boundingBox())!;
    const sendFrom = {
      x: sendBox.x + sendBox.width / 2,
      y: sendBox.y + sendBox.height / 2,
    };
    const geometry = async () => ({
      rect: await frame.boundingBox(),
      transform: await transform(),
    });
    const fittedGeometry = await geometry();
    const input = popover.locator("textarea");
    await dragBox(sendFrom, true);
    expect(await geometry()).toEqual(fittedGeometry);
    const emptyInputHeight = (await input.boundingBox())!.height;
    await input.fill("Keep the courtyard.\nLeave the planting unchanged.");
    expect((await input.boundingBox())!.height).toBeGreaterThan(
      emptyInputHeight,
    );
    await input.fill("");
    expect((await input.boundingBox())!.height).toBe(emptyInputHeight);
    await input.fill(
      Array(20).fill("Keep this region, but widen the entrance.").join("\n"),
    );
    expect(await geometry()).toEqual(fittedGeometry);
    expect(
      await input.evaluate(
        (element: any) => element.scrollHeight > element.clientHeight,
      ),
    ).toBeTrue();
    const draftBeforeKeyboard = (await popover.boundingBox())!;
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForFunction(
      "visualViewport.height === 500 && document.querySelector('.report-comment-popover').getBoundingClientRect().bottom <= visualViewport.offsetTop + visualViewport.height",
    );
    expect(await geometry()).toEqual(fittedGeometry);
    const raisedDraft = (await popover.boundingBox())!;
    expect(raisedDraft.y).toBeLessThan(draftBeforeKeyboard.y);
    expect(raisedDraft.y + raisedDraft.height).toBeLessThanOrEqual(500);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      "visualViewport.height === 844 && document.querySelector('.report-comment-popover').getBoundingClientRect().bottom > 500",
    );
    expect(await geometry()).toEqual(fittedGeometry);
    await input.fill(
      "Keep this region, but widen the entrance.\nLeave the planting unchanged.",
    );
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-comments-phone-typing-390.png`,
      });
    await popover.getByRole("button", { name: "Comment", exact: true }).tap();
    await viewer.locator(".report-comment").waitFor({ state: "attached" });
    expect(await geometry()).toEqual(fittedGeometry);
    const bar = viewer.locator(".report-bar");
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(60);
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/image-comments-phone-idle-390.png`,
      });
    for (let index = 0; index < 6; index++) {
      await dragBox(sendFrom, true);
      await input.fill(`Additional mobile note ${index}`);
      await popover.getByRole("button", { name: "Comment", exact: true }).tap();
      expect(await geometry()).toEqual(fittedGeometry);
    }
    const count = viewer.locator(".report-sendbar-count");
    await count.tap();
    const list = viewer.locator(".report-comments");
    expect(
      await list.evaluate(
        (element: any) => element.scrollHeight > element.clientHeight,
      ),
    ).toBeTrue();
    const listBox = (await list.boundingBox())!;
    const listTouch = { x: listBox.x + 2, y: listBox.y + listBox.height / 2 };
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [listTouch],
    });
    for (const offset of [20, 50, 90, 150])
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: listTouch.x, y: listTouch.y - offset }],
      });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      "document.querySelector('.image-popout .report-comments').scrollTop > 0",
    );
    await list.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          let last = element.scrollTop;
          const settle = () => {
            const next = element.scrollTop;
            if (next === last) resolve();
            else {
              last = next;
              requestAnimationFrame(settle);
            }
          };
          requestAnimationFrame(() => requestAnimationFrame(settle));
        }),
    );
    expect(await geometry()).toEqual(fittedGeometry);
    expect(await viewer.evaluate((element: any) => element.scrollTop)).toBe(0);
    const targets = await viewer
      .locator("button:visible")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const { width, height } = button.getBoundingClientRect();
          return { width, height };
        }),
      );
    expect(
      targets.every(({ width, height }) => width >= 44 && height >= 44),
    ).toBeTrue();
    await viewer
      .getByRole("button", { name: "Clear comments", exact: true })
      .tap();
    expect(await count.getAttribute("aria-expanded")).toBe("false");
    expect(await count.isDisabled()).toBeTrue();
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(60);
    expect(await geometry()).toEqual(fittedGeometry);
    await touch.send("Emulation.setCPUThrottlingRate", { rate: 40 });
    await doubleTap(sendFrom);
    await browserExpect.poll(scale).toBe(2);
    await touch.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const zoomedGeometry = await geometry();
    await dragBox(sendFrom, true);
    await input.fill("Zoomed mobile image note");
    expect(await geometry()).toEqual(zoomedGeometry);
    await popover.getByRole("button", { name: "Comment", exact: true }).tap();
    expect(await geometry()).toEqual(zoomedGeometry);
    await viewer
      .getByRole("button", { name: "Submit comments", exact: true })
      .tap();
    await viewer.waitFor({ state: "detached" });
    const sent = page.locator("#messages .msg.user", {
      hasText: "Zoomed mobile image note",
    });
    await sent.waitFor();
    await page
      .locator("#messages .msg.assistant", { hasText: "Acknowledged." })
      .waitFor();
    await page.waitForFunction(() => {
      const browser = globalThis as any;
      const sent = Array.from(
        browser.document.querySelectorAll("#messages .msg.user"),
      ).find((node: any) =>
        node.textContent?.includes("Zoomed mobile image note"),
      ) as any;
      const box = sent?.getBoundingClientRect();
      return box && box.bottom > 0 && box.top < browser.innerHeight;
    });
    expect(await sent.isVisible()).toBeTrue();
    const sentBox = (await sent.boundingBox())!;
    expect(sentBox.y + sentBox.height).toBeGreaterThan(0);
    expect(sentBox.y).toBeLessThan(844);
    const lastAgentImage = images.locator('img[alt="published-2.png"]').last();
    await lastAgentImage.tap();
    await viewer
      .locator('.files-detail[aria-label="published-2.png"]')
      .waitFor();
    await swipe(-100);
    expect(await shown()).toBe("published-2.png");
    await viewer
      .getByRole("button", { name: "Close image", exact: true })
      .tap();
    const crop = sent.locator('img[alt$="-box-1.jpg"]');
    await crop.tap();
    expect(await shown()).toBe(await crop.getAttribute("alt"));
    expect(await position.count()).toBe(0);
    expect(
      await viewer.getByRole("button", { name: "Previous image" }).count(),
    ).toBe(0);
    expect(
      await viewer.getByRole("button", { name: "Next image" }).count(),
    ).toBe(0);
    await swipe(100);
    await swipe(-100);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    expect(await shown()).toBe(await crop.getAttribute("alt"));
    expect(await pane.count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["image-swipe", tests]]);
