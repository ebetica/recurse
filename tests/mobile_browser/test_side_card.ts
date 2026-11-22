import { expect } from "bun:test";
import { runBrowserTests, type BrowserTest } from "./common";

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
    await page.locator("#input").fill("/btw Reply only Side card answer");
    await page.locator("#input").press("Enter");
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
  },
];
if (import.meta.main) await runBrowserTests([["side-card", tests]]);
