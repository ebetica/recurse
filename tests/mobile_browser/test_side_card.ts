import { expect } from "bun:test";
import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  checkedHitPoint,
  checkedTap,
  expectHitCorners,
  openPage,
  runBrowserTests,
  screenshot,
  type BrowserTest,
} from "./common";

async function holdSend(page: Page) {
  const { x, y } = await checkedHitPoint(
    page.getByRole("button", { name: "Send message" }),
  );
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x, y }],
  });
  try {
    await page.getByRole("menu", { name: "Send options" }).waitFor();
  } finally {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
  }
}

export const tests: BrowserTest[] = [
  // Feature: #3608 phone side conversations pop out as a card over their parent
  async function test_phone_side_card(browser, base) {
    const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
    const agent = "side-card-parent";
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.request.post(
      `${base}__browser-test/seed-model-selection-error`,
      { data: { agent, model: "fauxordinary/faux-1" } },
    );
    await page.goto(`${base}#agent=${agent}`);
    await page
      .locator("#input:enabled")
      .fill("Reply only Card parent ready. " + "Parent text. ".repeat(200));
    await page.locator("#input").press("Enter");
    await page
      .locator(".msg.assistant .content", { hasText: "Card parent ready" })
      .waitFor();
    const input = page.locator("#input");
    await input.press("ControlOrMeta+Enter");
    await browserExpect(page.locator("#send-status")).toHaveText(
      "/btw needs a question",
    );
    await page.getByText("Keyboard shortcuts", { exact: true }).click();
    const shortcut = page.locator("#shortcut-groups .k", {
      hasText: "ask in side chat",
    });
    await browserExpect(shortcut.locator("kbd")).toHaveText(
      /^(⌘|Ctrl\+)Enter$/,
    );
    await shortcut.scrollIntoViewIfNeeded();
    await screenshot(page, "send-btw-shortcut-1280");
    await input.fill("Reply only Side card answer");
    await input.press("ControlOrMeta+Enter");
    await page
      .frameLocator("iframe.side-frame")
      .locator(".msg.assistant .content", { hasText: "Side card answer" })
      .waitFor();
    const id = await page
      .locator("iframe.side-frame")
      .getAttribute("data-side");
    expect(await page.locator("#pane-backdrop").isVisible()).toBe(false);
    if (shots) await page.screenshot({ path: `${shots}/side-card-1280.png` });
    await page.close();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 412, height: 915 },
    ]) {
      const phone = await browser.newPage({
        viewport,
        isMobile: true,
        hasTouch: true,
      });
      await phone.goto(`${base}#agent=${agent}`);
      await phone
        .locator(".msg.assistant .content", { hasText: "Card parent ready" })
        .waitFor();
      await phone.locator("#pane-fab").tap();
      await phone.locator('.pane-menu-item[data-pane="side"]').tap();
      const side = phone.frameLocator(`iframe[data-side="${id}"]`);
      await side
        .locator(".msg.assistant .content", { hasText: "Side card answer" })
        .waitFor();
      await side.locator("#input").waitFor();
      const parent = await phone.evaluate(() => {
        const x = innerWidth / 2;
        const y =
          document.querySelector("#topbar")!.getBoundingClientRect().bottom + 8;
        const hits = document.elementsFromPoint(x, y);
        return {
          x,
          y,
          top: hits[0]?.id,
          thread: hits.some((node) => node.closest("#messages")),
        };
      });
      expect(parent).toMatchObject({ top: "pane-backdrop", thread: true });
      if (shots)
        await phone.screenshot({
          path: `${shots}/side-card-${viewport.width}.png`,
        });
      await phone.evaluate(() => {
        const browser = globalThis as any;
        const viewport = browser.visualViewport;
        const height = Object.getOwnPropertyDescriptor(
          browser.VisualViewport.prototype,
          "height",
        )!;
        Object.defineProperty(viewport, "height", {
          configurable: true,
          get: () => height.get!.call(viewport) - 340,
        });
        viewport.dispatchEvent(new browser.Event("resize"));
      });
      await phone.waitForFunction(
        "document.querySelector('#panes').getBoundingClientRect().bottom <= visualViewport.offsetTop + visualViewport.height",
      );
      const composer = (await side.locator("#input").boundingBox())!;
      const tapAt = {
        x: composer.x + composer.width / 2,
        y: composer.y + composer.height / 2,
      };
      expect(
        await phone.evaluate(
          ({ x, y }) =>
            y < visualViewport!.offsetTop + visualViewport!.height &&
            document.elementFromPoint(x, y)?.matches("iframe.side-frame"),
          tapAt,
        ),
      ).toBe(true);
      await phone.touchscreen.tap(tapAt.x, tapAt.y);
      await side.locator("#input:focus").waitFor();
      await phone.touchscreen.tap(parent.x, parent.y);
      await phone.locator("#panes.overlay").waitFor({ state: "detached" });
      expect(await phone.locator(`iframe[data-side="${id}"]`).isVisible()).toBe(
        false,
      );
      await phone.close();
    }

    const { context, page: phone } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
    });
    try {
      await phone.goto(`${base}#agent=${agent}`);
      await phone
        .locator(".msg.assistant .content", { hasText: "Card parent ready" })
        .waitFor();
      const parent = await phone.locator("#topbar").evaluate((titlebar) => ({
        x: innerWidth / 2,
        y: titlebar.getBoundingClientRect().bottom + 8,
      }));
      const draft = phone.locator("#input");
      const menu = phone.getByRole("menu", { name: "Send options" });
      const btw = menu.getByRole("menuitem", {
        name: "Ask in side chat",
        exact: true,
      });
      await checkedTap(draft);
      await holdSend(phone);
      await browserExpect(btw).toBeDisabled();
      await browserExpect(btw).toHaveAccessibleDescription(
        "/btw needs a question",
      );
      await phone.keyboard.press("Escape");
      await browserExpect(menu).toBeHidden();
      await browserExpect(draft).toBeFocused();

      const question = "Reply only Phone side answer";
      await draft.fill(question);
      await phone.locator("#file-input").setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Side questions cannot include attachments."),
      });
      const remove = phone.getByRole("button", { name: "Remove notes.txt" });
      await remove.waitFor();
      await holdSend(phone);
      await browserExpect(btw).toBeDisabled();
      await browserExpect(btw).toHaveAccessibleDescription(
        "Remove attachments to ask in side chat",
      );
      await phone.keyboard.press("Escape");
      await checkedTap(remove);
      await browserExpect(remove).toBeHidden();
      await draft.evaluate((input) => {
        const page = globalThis as any;
        page.blurs = 0;
        page.toggles = 0;
        input.addEventListener("focusout", () => page.blurs++);
        document
          .querySelector("#send-menu")!
          .addEventListener("toggle", () => page.toggles++);
        document
          .querySelector("#send-btw")!
          .addEventListener(
            "click",
            () => (page.chosen = `${document.activeElement?.id}:${page.blurs}`),
          );
      });
      const blurs = () => phone.evaluate(() => (globalThis as any).blurs);

      await holdSend(phone);
      await browserExpect(menu).toBeVisible();
      await browserExpect(btw).toHaveAccessibleDescription("");
      await browserExpect(draft).toBeFocused();
      expect(await blurs()).toBe(0);
      await browserExpect(draft).toHaveValue(question);
      await expectHitCorners(btw);
      await screenshot(phone, "send-btw-menu-412");
      await phone.touchscreen.tap(parent.x, parent.y);
      await browserExpect(menu).toBeHidden();
      await browserExpect(draft).toBeFocused();
      expect(await blurs()).toBe(0);
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR) {
        await phone.setViewportSize({ width: 390, height: 844 });
        await holdSend(phone);
        await screenshot(phone, "send-btw-menu-390");
        await phone.touchscreen.tap(parent.x, parent.y);
        await browserExpect(menu).toBeHidden();
        await phone.setViewportSize({ width: 412, height: 915 });
      }

      await holdSend(phone);
      await checkedTap(btw);
      expect(await phone.evaluate(() => (globalThis as any).chosen)).toBe(
        "input:0",
      );
      await phone
        .frameLocator("iframe.side-frame")
        .locator(".msg.assistant .content", { hasText: "Phone side answer" })
        .last()
        .waitFor();
      await browserExpect(
        phone.locator(".msg.user", { hasText: question }),
      ).toHaveCount(0);
      await phone.touchscreen.tap(parent.x, parent.y);
      await phone.locator("#panes.overlay").waitFor({ state: "detached" });
      await draft.fill("Reply only Plain phone send");
      const opened = await phone.evaluate(() => (globalThis as any).toggles);
      await checkedTap(phone.getByRole("button", { name: "Send message" }));
      await phone
        .locator(".msg.assistant .content", { hasText: "Plain phone send" })
        .waitFor();
      expect(await phone.evaluate(() => (globalThis as any).toggles)).toBe(
        opened,
      );
    } finally {
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["side-card", tests]]);
