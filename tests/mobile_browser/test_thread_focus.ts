import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  postFixture,
  rootAgentId,
  runBrowserTests,
  waitForLayout,
  type BrowserTest,
} from "./common";
declare const getComputedStyle: any;

export const tests: BrowserTest[] = [
  // Feature: #3558 Scroll Chat by half a page without leaving the agents list.
  async function test_chat_scroll_from_agents(browser, base) {
    const { marker } = await postFixture(base, "seed-bulk-thread");
    const agent = rootAgentId();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    try {
      await page.goto(`${base}#agent=${agent}`);
      await page.getByText(marker, { exact: true }).waitFor();
      await waitForLayout(page);
      const thread = page.locator("#scroll");
      const row = page.locator(`#agent-list .agent[data-id="${agent}"]`);
      await row.focus();
      await browserExpect(row).toBeFocused();
      await thread.evaluate((el) => {
        el.scrollTop = el.scrollHeight - 3 * el.clientHeight;
      });
      await waitForLayout(page);
      const halfPage = await thread.evaluate((el) => el.clientHeight / 2);
      const offset = () => thread.evaluate((el) => el.scrollTop);
      const scrollTwice = async (key: string, distance: number) => {
        for (let press = 0; press < 2; press++) {
          const before = await offset();
          await page.keyboard.down(key);
          expect(
            Math.abs((await offset()) - before - distance),
          ).toBeLessThanOrEqual(1);
          await browserExpect(row).toBeFocused();
        }
        await page.keyboard.up(key);
      };
      await page.keyboard.down("Shift");
      await scrollTwice("KeyJ", halfPage);
      await scrollTwice("KeyK", -halfPage);
      await page.keyboard.up("Shift");
      await scrollTwice("PageDown", halfPage);
      await scrollTwice("PageUp", -halfPage);
      const beforeDelete = await offset();
      await page.keyboard.press("d");
      await browserExpect(page.locator("#key-mode")).toHaveText("d … delete");
      await browserExpect(row).toBeFocused();
      await browserExpect(row).toHaveClass(/\barmed\b/);
      expect(await offset()).toBe(beforeDelete);
      await page.keyboard.press("Escape");
      await page.keyboard.press("i");
      const composer = page.locator("#input");
      await browserExpect(composer).toBeFocused();
      await waitForLayout(page);
      const beforeTyping = await offset();
      for (const [key, draft] of [
        ["Shift+J", "J"],
        ["Shift+K", "JK"],
        ["d", "JKd"],
        ["PageDown", "JKd"],
        ["PageUp", "JKd"],
      ]) {
        await page.keyboard.press(key);
        await browserExpect(composer).toBeFocused();
        await browserExpect(composer).toHaveValue(draft);
        expect(await offset()).toBe(beforeTyping);
      }
      await composer.press("Escape");
      const closeChat = page.getByRole("button", { name: "Close Chat" });
      await closeChat.click();
      await browserExpect(thread).toBeHidden();
      await row.focus();
      await page.keyboard.press("Shift+J");
      await browserExpect(thread).toBeHidden();
      await browserExpect(row).toBeFocused();
    } finally {
      await page.close();
    }
  },
  // Feature: #2595 viewport focus rings, native image drags and boxed idle footer icons.
  async function test_thread_focus_and_compact_footer(browser, base) {
    const { agent } = await postFixture(base, "seed-visible-attachments");
    const results: Array<{
      width: number;
      ring: string;
      sizes: Array<{
        width: number;
        height: number;
        background: string;
        border: string;
        icon: number;
        gap: number;
      }>;
      dragged: string | null;
      imageSelection: string;
    }> = [];
    for (const width of [1280, 412]) {
      const page = await browser.newPage({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .getByText("second-report.txt is ready.", { exact: true })
          .waitFor();
        await page.locator("#input").focus();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Enter");
        await page.locator("#scroll").focus();
        const ring = await page
          .locator("#scroll")
          .evaluate((el: any) => getComputedStyle(el).outlineStyle);
        const buttons = page.locator(".turn-foot-actions button");
        const sizes = await buttons.evaluateAll((nodes: any[]) =>
          nodes.map((el) => {
            const box = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              width: box.width,
              height: box.height,
              background: style.backgroundColor,
              border: style.borderColor,
              icon: el.querySelector("svg").getBoundingClientRect().width,
              gap: parseFloat(getComputedStyle(el.parentElement).gap),
            };
          }),
        );
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots) {
          await page
            .locator(".turn-foot-actions")
            .last()
            .screenshot({ path: `${shots}/footer-${width}.png` });
        }
        const image = page.locator(
          '#messages img[alt="second-report.txt image"]',
        );
        await image.scrollIntoViewIfNeeded();
        await image.evaluate((el: any) => el.decode());
        await image.evaluate((el: any) => {
          el.ownerDocument.addEventListener("dragstart", (event: any) => {
            el.dataset.dragStarted = String(!event.defaultPrevented);
          });
        });
        const box = (await image.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          box.x + box.width / 2 + 20,
          box.y + box.height / 2 + 20,
          { steps: 5 },
        );
        await page.mouse.up();
        const dragged = await image.getAttribute("data-drag-started");
        const imageSelection = await image.evaluate(
          (el: any) => getComputedStyle(el).userSelect,
        );
        console.log("image drag reproduction", width, dragged);
        await page
          .getByRole("button", { name: "Open in Files", exact: true })
          .click();
        const pane = page.locator(
          width === 412
            ? '.pane-col[data-pane="files"]'
            : ".pane-col.file-tab:visible",
        );
        await pane.locator(".files-detail").waitFor();
        if (width === 412)
          await page.getByRole("button", { name: "Close Files" }).click();
        else {
          const id = await pane.getAttribute("data-pane");
          const tab = page.locator(`.dv-tab[data-dock-panel="${id}"]`);
          await tab.hover();
          await tab.getByRole("button", { name: /^Close / }).click();
        }
        await page.locator("#scroll").focus();
        if (shots)
          await page.screenshot({ path: `${shots}/thread-focus-${width}.png` });
        console.log("thread focus reproduction", width, { ring, sizes });
        results.push({ width, ring, sizes, dragged, imageSelection });
        const reply = page.getByText("second-report.txt is ready.", {
          exact: true,
        });
        await reply.scrollIntoViewIfNeeded();
        await reply.click({ clickCount: 3 });
        expect(
          await page.evaluate(() =>
            (globalThis as any).getSelection()?.toString(),
          ),
        ).toContain("second-report.txt");
        await page.keyboard.press("Tab");
        await page.locator(".turn-expand").last().focus();
        expect(
          await page
            .locator(".turn-expand")
            .last()
            .evaluate((el: any) => getComputedStyle(el).outlineStyle),
        ).toBe("solid");
      } finally {
        await page.close();
      }
    }
    for (const { width, ring, sizes, dragged, imageSelection } of results) {
      for (const size of sizes) {
        expect(size.width).toBe(width === 412 ? 22 : 24);
        expect(size.height).toBe(width === 412 ? 22 : 24);
        expect(size.icon).toBe(width === 412 ? 12 : 14);
        expect(size.gap).toBe(width === 412 ? 4 : 8);
        expect(size.background).toBe("rgba(0, 0, 0, 0)");
        expect(size.border).toBe("rgba(0, 0, 0, 0)");
      }
      expect(imageSelection).toBe("none");
      expect(dragged).toBe("false");
      expect(ring).toBe("none");
    }
  },
];

if (import.meta.main) await runBrowserTests([["thread-focus", tests]]);
