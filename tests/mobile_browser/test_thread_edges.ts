import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { idleConv, row, tree } from "./fixtures";
import {
  checkedTap,
  expectHitCorners,
  gotoRoot,
  mockConversation,
  runBrowserTests,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";

const rows = Array.from({ length: 24 }, (_, i) =>
  row(
    `r${i}`,
    i % 2 ? "assistant" : "user",
    `Message ${i}: enough words to wrap onto a second line on a phone screen.` +
      (i === 23 ? "\n\n```text\nCopy this reply.\n```" : ""),
  ),
);
const opacities = `(() => ({
  top: getComputedStyle(document.querySelector("#topbar"), "::after").opacity,
  bottom: getComputedStyle(document.querySelector("#composer-wrap"), "::before").opacity,
}))()`;

// Regression: #3565 focusing the desktop composer leaves the card and reading position unchanged.
const threadEdges: BrowserTest = async (browser, base) => {
  for (const mobile of [true, false]) {
    for (const running of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile
          ? { width: 412, height: 915 }
          : { width: 1280, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      const conv = running
        ? { ...idleConv(rows), status: "running", active_run: "run-edges" }
        : idleConv(rows);
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [
            { ...tree()[0], status: conv.status, active_run: conv.active_run },
          ],
        }),
      );
      await mockConversation(page, base, "main", () => conv);
      await gotoRoot(page, base);
      await page.locator("#safety-row.on").waitFor({ state: "attached" });
      if (running) await page.locator(".working .status-bar-label").waitFor();
      else await page.getByText("Message 23:", { exact: false }).waitFor();
      await page.waitForFunction(
        `(() => { const s = document.querySelector("#scroll"); return s.scrollHeight > s.clientHeight * 1.5 && s.scrollHeight - s.scrollTop - s.clientHeight <= 1; })()`,
      );
      const gap = await page.evaluate(`(() => {
        const items = [...document.querySelector("#messages").children].filter((e) => e.getBoundingClientRect().height > 0);
        const below = document.querySelector("#status-bar:not([hidden])") ?? document.querySelector("#composer");
        return Math.round(below.getBoundingClientRect().top - items[items.length - 1].getBoundingClientRect().bottom);
      })()`);
      expect(gap as number).toBeGreaterThanOrEqual(12);
      expect(gap as number).toBeLessThanOrEqual(16);
      await page.waitForFunction(
        `(() => { const o = ${opacities}; return o.top === "1" && o.bottom === "0"; })()`,
      );
      const thread = page.locator("#scroll");
      const offset = () => thread.evaluate((el) => el.scrollTop);
      const input = page.locator("#input");
      const controls = page.locator("#conv-controls");
      await visibleAndUncovered(page, "#model-trigger");
      await thread.evaluate((el) => (el.scrollTop -= 80));
      await waitForLayout(page);
      const unfocusedOffset = await offset();
      const composer = page.locator("#composer");
      const card = await composer.boundingBox();
      await input.evaluate((el) => el.focus({ preventScroll: true }));
      await browserExpect(controls).toBeVisible();
      await waitForLayout(page);
      if (!mobile) expect(await composer.boundingBox()).toEqual(card);
      expect(await offset()).toBe(unfocusedOffset);
      await input.fill("Keep the draft caret");
      await input.blur();
      await waitForLayout(page);
      await browserExpect(controls).toBeVisible();
      const before = await input.evaluate((el: HTMLTextAreaElement) => {
        const scrollTop = el.ownerDocument.querySelector("#scroll")!.scrollTop;
        el.setSelectionRange(9, 9);
        el.focus({ preventScroll: true });
        return scrollTop;
      });
      await visibleAndUncovered(page, "#model-trigger");
      await waitForLayout(page);
      expect(await offset()).toBe(before);
      expect(
        await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart),
      ).toBe(9);
      await input.fill("");
      if (!mobile && !running) {
        const copy = page.locator(".code-wrap .copy-btn");
        await thread.hover();
        await page.mouse.wheel(0, 900);
        await page.waitForFunction(
          `(() => { const s = document.querySelector("#scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight <= 1; })()`,
        );
        await copy.hover();
        await page.mouse.down();
        await waitForLayout(page);
        await visibleAndUncovered(page, "#model-trigger");
        await page.mouse.up();
        await browserExpect(copy).toHaveAccessibleName("Code copied");
        await visibleAndUncovered(page, "#model-trigger");
        expect(await composer.boundingBox()).toEqual(card);
      } else await input.blur();
      await thread.evaluate((el) => (el.scrollTop = 0));
      await page.waitForFunction(
        `(() => { const o = ${opacities}; return o.top === "0" && o.bottom === "1"; })()`,
      );
      if (!mobile) {
        const latest = page.locator("#scroll-btn");
        await visibleAndUncovered(page, "#scroll-btn");
        const { x, y, width, height } = (await latest.boundingBox())!;
        await page.mouse.move(x + width / 2, y + height / 2);
        await page.mouse.down();
        await waitForLayout(page);
        await visibleAndUncovered(page, "#model-trigger");
        expect(await composer.boundingBox()).toEqual(card);
        await page.mouse.up();
        await page.waitForFunction(
          `(() => { const s = document.querySelector("#scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight <= 1; })()`,
        );
      }
      await context.close();
    }
  }
};

const longCode = `echo ${"wide-token ".repeat(30)}END`;

// Regression: #3732 a phone Copy pill covered one-line code text; #3736 the code bar was 48px tall at 390 (5ce65a18f).
const codeHeaderClearOfCode: BrowserTest = async (browser, base) => {
  for (const width of [390, 412, 1280]) {
    const touch = width < 1000;
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: touch,
      hasTouch: touch,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await mockConversation(page, base, "main", () =>
      idleConv([
        row("u", "user", "Show one line."),
        row(
          "a",
          "assistant",
          "Run:\n\n```sh\n" +
            longCode +
            "\n```\n\n```\nplain\n```\n\n```<img/src=x/onerror=alert(1)>\nodd\n```" +
            "\n\n```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n```",
        ),
      ]),
    );
    await gotoRoot(page, base);
    const block = page.locator(".code-wrap").first();
    const pre = block.locator("pre");
    const copy = block.getByRole("button", { name: "Copy code" });
    const expand = block.getByRole("button", { name: "Expand code" });
    await pre.waitFor();
    expect(await block.locator(".code-lang").innerText()).toBe("Shell");
    expect(
      await page.locator(".code-wrap").nth(1).locator(".code-lang").innerText(),
    ).toBe("Text");
    const odd = page.locator(".code-wrap").nth(2).locator(".code-lang");
    expect(await odd.innerText()).toBe("<img/src=x/onerror=alert(1)>");
    expect(await odd.locator("img").count()).toBe(0);
    for (const scroll of [0, 200, 100000]) {
      await pre.evaluate((el, left) => (el.scrollLeft = left), scroll);
      await waitForLayout(page);
      const overlap = await pre.evaluate((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const text = {
          left: r.left + parseFloat(s.paddingLeft),
          right: r.right - parseFloat(s.paddingRight),
          top: r.top + parseFloat(s.paddingTop),
          bottom: r.bottom - parseFloat(s.paddingBottom),
        };
        return [
          ...el.parentElement!.querySelectorAll(".code-head button"),
        ].some((button) => {
          const b = button.getBoundingClientRect();
          return (
            b.left < text.right &&
            b.right > text.left &&
            b.top < text.bottom &&
            b.bottom > text.top
          );
        });
      });
      expect(overlap, `Copy covers code at ${width} scroll ${scroll}`).toBe(
        false,
      );
    }
    expect(
      await page.locator(".code-wrap").nth(3).locator(".code-lang").innerText(),
    ).toBe("TypeScript");
    const compact = await page
      .locator(".code-wrap")
      .nth(3)
      .evaluate((wrap) => {
        const pre = wrap.querySelector("pre")!;
        const s = getComputedStyle(pre);
        const lines =
          pre.clientHeight -
          parseFloat(s.paddingTop) -
          parseFloat(s.paddingBottom);
        return {
          bar: wrap.querySelector(".code-head")!.getBoundingClientRect().height,
          pitch: lines / 4 / parseFloat(s.fontSize),
          gap:
            pre.getBoundingClientRect().top +
            parseFloat(s.paddingTop) -
            wrap.querySelector(".code-head")!.getBoundingClientRect().bottom,
        };
      });
    expect(compact.bar, `bar height at ${width}`).toBeLessThanOrEqual(32);
    expect(compact.pitch, `code line pitch at ${width}`).toBeLessThanOrEqual(
      1.45,
    );
    expect(compact.gap, `gap above code at ${width}`).toBeLessThanOrEqual(10);
    if (!touch) {
      await context.close();
      continue;
    }
    await expectHitCorners(copy, 44, { centerOnHitArea: true });
    await expectHitCorners(expand, 44, { centerOnHitArea: true });
    await checkedTap(copy);
    await block.getByRole("button", { name: "Code copied" }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      longCode + "\n",
    );
    await checkedTap(expand);
    const viewer = page.getByRole("dialog", { name: "Code viewer" });
    await browserExpect(viewer.locator("pre")).toHaveText(longCode);
    await viewer.getByRole("button", { name: "Close code" }).tap();
    await viewer.waitFor({ state: "detached" });
    await context.close();
  }
};

export const tests = [threadEdges, codeHeaderClearOfCode];
if (import.meta.main) await runBrowserTests([["thread-edges", tests]]);
