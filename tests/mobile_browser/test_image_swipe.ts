import { expect } from "bun:test";
import {
  type BrowserTest,
  captureErrors,
  postFixture,
  runBrowserTests,
} from "./common";
declare const requestAnimationFrame: any;

export const tests: BrowserTest[] = [
  // Regression: #2742 revisiting images after a large gallery never requires reloading previews.
  async function test_large_image_gallery_keeps_previews(browser, base) {
    const fixture = (await postFixture(base, "seed-large-image-gallery")) as {
      demo: string;
    };
    const context = await browser.newContext();
    const page = await context.newPage();
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
    await viewer.locator("img[src]").evaluate((image: any) => image.decode());
    const pane = page.locator('.pane-col[data-pane="files"]');
    await viewer
      .getByRole("button", { name: "Open in Files", exact: true })
      .click();
    await pane.locator(".files-detail").waitFor();
    await pane.getByRole("button", { name: "All files", exact: true }).click();
    await pane.locator(".files-thumb").first().click();
    await viewer
      .locator(".files-image")
      .evaluate((image: any) => image.decode());
    const box = (await viewer.locator(".image-zoom-viewport").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -70);
    await page.keyboard.up("Control");
    await page.waitForFunction(
      "new DOMMatrix(getComputedStyle(document.querySelector('.files-image-frame')).transform).a > 1.5",
    );
    const url = page.url();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    expect(page.url()).toBe(url);
    expect(await pane.locator(".files-card").first().isVisible()).toBeTrue();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2862 keeps phone comment drafts and lists over a fixed canvas; preserves #2858 gestures and #2859 standalone uploads.
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
      originalSource,
    );
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
    await page.touchscreen.tap(center.x, center.y);
    await page.touchscreen.tap(center.x, center.y);
    expect(await scale()).toBe(1);
    await page.touchscreen.tap(center.x, center.y);
    await page.touchscreen.tap(center.x, center.y);
    expect(await scale()).toBe(2);
    const heldTransform = await transform();
    const zoomedBox = (await frame.boundingBox())!;
    await dragBox(center);
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
    await page.touchscreen.tap(sendFrom.x, sendFrom.y);
    await page.touchscreen.tap(sendFrom.x, sendFrom.y);
    expect(await scale()).toBe(2);
    const zoomedGeometry = await geometry();
    await dragBox(sendFrom);
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
    const crop = sent.locator('img[alt$="-box-1.png"]');
    await crop.tap();
    expect(await shown()).toBe(await crop.getAttribute("alt"));
    expect(await position.textContent()).toBe("1 of 1");
    expect(
      await viewer.getByRole("button", { name: "Previous image" }).isDisabled(),
    ).toBeTrue();
    expect(
      await viewer.getByRole("button", { name: "Next image" }).isDisabled(),
    ).toBeTrue();
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
