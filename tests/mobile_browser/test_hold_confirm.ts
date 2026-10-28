import { expect } from "bun:test";
import type { Browser, Page } from "playwright";
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  runBrowserTests,
  type BrowserTest,
} from "./common";
import { idleConv, tree } from "./fixtures";

const idle = () => ({ ...idleConv(), pending: [] });
const running = () => ({
  ...idle(),
  status: "running",
  active_run: "run-hold",
});
const open = async (
  page: any,
  base: string,
  conv: () => any,
  status = "idle",
) => {
  await page.route(`${base}api/tree*`, (route: any) =>
    route.fulfill({ json: [{ ...tree()[0], status }] }),
  );
  await mockConversation(page, base, "main", conv);
  await gotoRoot(page, base);
};
const tip = async (page: any) => {
  const locator = page.locator(".hold-tip.on");
  await locator.waitFor();
  return (await locator.innerText()).trim();
};
const hold = async (page: any, selector: string) => {
  const box = await page.locator(selector).boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  // test-check-allow: T6 Native hold input; menu Delete has no held cue.
  await page.waitForTimeout(800);
  await page.mouse.up();
};

async function holdTipPage(browser: Browser, base: string) {
  const built = await Bun.build({
    entrypoints: [new URL("../../web/hold-tip.ts", import.meta.url).pathname],
    target: "browser",
  });
  if (!built.success) throw new Error(built.logs.map(String).join("\n"));
  const source = await built.outputs[0].text();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.route(`${base}__hold-tip.js`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: source }),
    );
    await page.route(`${base}__hold-tip`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html>
<style>body{height:2000px}#anchor{position:absolute;left:300px;top:200px;width:40px;height:30px}.hold-tip{display:none;position:fixed;white-space:nowrap}.hold-tip.on{display:block}</style>
<button id="anchor" title="Original title">Act</button><button id="other">Other</button>
<script type="module">
import { attachHoldTip } from './__hold-tip.js';
const anchor = document.querySelector('#anchor');
const probe = window.holdProbe = { holds: 0, releases: 0, clicks: [], mouseLeaves: 0, consumeClicks: true };
const tip = window.holdTip = attachHoldTip(anchor, document, {
  text: () => 'Tap to stop',
  onHold: () => probe.holds++,
  onHoldEnd: () => probe.releases++,
});
anchor.addEventListener('click', () => {
  if (probe.consumeClicks) probe.clicks.push(tip.takeHoldConsumed());
});
anchor.addEventListener('mouseleave', () => probe.mouseLeaves++);
</script>`,
      }),
    );
    await page.goto(`${base}__hold-tip`);
    await page.waitForFunction("Boolean(window.holdTip)");
    return { context, page, errors };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function tipBoxes(page: Page) {
  const anchor = await page.locator("#anchor").boundingBox();
  const shown = await page.locator(".hold-tip.on").boundingBox();
  expect(anchor).toBeTruthy();
  expect(shown).toBeTruthy();
  return { anchor: anchor!, shown: shown! };
}

export const tests: BrowserTest[] = [
  async function test_stop_tap_arms_with_tip_and_hold_peeks(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const posts: unknown[] = [];
    await page.route(`${base}api/conversations/main/deliver`, (route) => {
      posts.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, status: "stopping" } });
    });
    await open(page, base, running, "running");
    const stop = page.locator("#send.stop");
    await stop.waitFor();
    await stop.hover();
    expect(await tip(page)).toBe("Tap to stop");
    await hold(page, "#send.stop");
    expect(await tip(page)).toBe("Tap to stop");
    expect(await stop.getAttribute("aria-label")).toBe("Stop this agent");
    expect(posts).toEqual([]);
    await stop.tap();
    await page.waitForFunction(
      "document.querySelector('#send')?.getAttribute('aria-label') === 'Confirm stop this agent'",
    );
    expect(await tip(page)).toBe("Tap again to stop");
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #1826 holding armed Delete disarms the next tap
  async function test_menu_delete_tap_arms_without_tip_and_hold_never_confirms(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await open(page, base, idle);
    await page.locator("#pane-fab").click();
    const trash = page.locator("#trash-btn.on");
    await trash.waitFor();
    await trash.hover();
    expect(await page.locator(".hold-tip.on").count()).toBe(0);
    await hold(page, "#trash-btn.on");
    expect(await page.locator(".hold-tip.on").count()).toBe(0);
    expect(await page.locator("#trash-btn.armed").count()).toBe(0);
    await trash.tap();
    await page.locator("#trash-btn.armed").waitFor();
    expect(await trash.innerText()).toBe(
      "Confirm delete agent and descendants",
    );
    expect(await page.locator(".hold-tip.on").count()).toBe(0);
    await hold(page, "#trash-btn.armed");
    expect(await page.locator("#trash-btn.armed").count()).toBe(0);
    expect(await trash.innerText()).toBe("Delete");
    expect(await page.locator(".hold-tip.on").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #1826 a held release fires once and consumes only its click
  async function test_hold_tip_native_release_and_click_consumption(
    browser,
    base,
  ) {
    const { context, page, errors } = await holdTipPage(browser, base);
    try {
      const anchor = page.locator("#anchor");
      await anchor.click();
      expect(await page.evaluate("window.holdProbe")).toMatchObject({
        holds: 0,
        releases: 0,
        clicks: [false],
      });
      await page.evaluate("window.holdProbe.consumeClicks = false");
      await page.mouse.down();
      await page.waitForFunction("window.holdProbe.holds === 1");
      expect(await page.evaluate<number>("window.holdProbe.releases")).toBe(0);
      await page.mouse.up();
      await page.mouse.move(0, 0);
      expect(await page.evaluate("window.holdProbe")).toMatchObject({
        holds: 1,
        releases: 1,
        clicks: [false],
      });
      expect(
        await page.evaluate<boolean>("window.holdTip.takeHoldConsumed()"),
      ).toBe(true);
      expect(
        await page.evaluate<boolean>("window.holdTip.takeHoldConsumed()"),
      ).toBe(false);
      await page.evaluate("window.holdProbe.consumeClicks = true");
      await anchor.click();
      await page.mouse.down();
      await page.waitForFunction("window.holdProbe.holds === 2");
      await page.mouse.up();
      expect(await page.evaluate<boolean[]>("window.holdProbe.clicks")).toEqual(
        [false, false, true],
      );
      await page.mouse.down();
      await page.waitForFunction("window.holdProbe.holds === 3");
      await page.locator(".hold-tip.on").waitFor({ state: "hidden" });
      expect(await anchor.getAttribute("title")).toBe("Original title");
      await page.mouse.up();
      expect(await page.evaluate("window.holdProbe")).toMatchObject({
        holds: 3,
        releases: 3,
        clicks: [false, false, true, false],
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  // Regression: #1826 title/repark and #1990 footer tip placement
  async function test_hold_tip_native_geometry_reparks_without_covering_controls(
    browser,
    base,
  ) {
    const { context, page, errors } = await holdTipPage(browser, base);
    try {
      await page.evaluate("window.holdTip.pin()");
      let { anchor, shown } = await tipBoxes(page);
      expect(shown.y + shown.height).toBeLessThan(anchor.y);
      await page.locator("#anchor").evaluate((element) => {
        const { window } = globalThis as any;
        element.style.top = "900px";
        window.scrollTo(0, 870);
      });
      await page.waitForFunction(`(() => {
        const a = document.querySelector('#anchor').getBoundingClientRect();
        const t = document.querySelector('.hold-tip.on').getBoundingClientRect();
        return t.right < a.left && Math.abs(t.top + t.height / 2 - a.top - a.height / 2) < 1;
      })()`);
      ({ anchor, shown } = await tipBoxes(page));
      expect(shown.x + shown.width).toBeLessThan(anchor.x);
      expect(shown.y + shown.height / 2).toBeCloseTo(
        anchor.y + anchor.height / 2,
        1,
      );
      expect(shown.x).toBeGreaterThanOrEqual(0);
      expect(shown.y).toBeGreaterThanOrEqual(0);
      expect(shown.y + shown.height).toBeLessThanOrEqual(844);
      await page.locator("#anchor").evaluate((element) => {
        Object.assign(element.style, {
          position: "fixed",
          left: "1245px",
          top: "760px",
        });
      });
      await page.setViewportSize({ width: 1440, height: 844 });
      await page.waitForFunction(`(() => {
        const a = document.querySelector('#anchor').getBoundingClientRect();
        const t = document.querySelector('.hold-tip.on').getBoundingClientRect();
        return t.left > a.right && Math.abs(t.top + t.height / 2 - a.top - a.height / 2) < 1;
      })()`);
      ({ anchor, shown } = await tipBoxes(page));
      expect(shown.x).toBeGreaterThan(anchor.x + anchor.width);
      expect(shown.y + shown.height / 2).toBeCloseTo(
        anchor.y + anchor.height / 2,
        1,
      );
      expect(shown.x + shown.width).toBeLessThanOrEqual(1440);
      expect(shown.y + shown.height).toBeLessThanOrEqual(844);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  // Regression: #1784 pointerleave/blur/Escape respect pinned tips
  async function test_hold_tip_native_leave_focus_and_anchor_cleanup(
    browser,
    base,
  ) {
    const { context, page, errors } = await holdTipPage(browser, base);
    try {
      const anchor = page.locator("#anchor");
      const shown = page.locator(".hold-tip.on");
      await anchor.hover();
      await shown.waitFor();
      await anchor.dispatchEvent("pointerleave", { pointerType: "pen" });
      expect(await shown.count()).toBe(0);
      expect(await page.evaluate<number>("window.holdProbe.mouseLeaves")).toBe(
        0,
      );
      await page.evaluate("window.holdTip.pin()");
      await anchor.dispatchEvent("pointerleave", { pointerType: "pen" });
      await anchor.dispatchEvent("mouseleave");
      expect(await shown.count()).toBe(1);
      await page.evaluate("window.holdTip.hide()");
      await page.mouse.move(0, 0);
      await anchor.hover();
      await anchor.focus();
      await page.keyboard.press("Tab");
      expect(await shown.count()).toBe(0);
      await page.evaluate("window.holdTip.pin()");
      await anchor.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Escape");
      expect(await shown.count()).toBe(1);
      await page.evaluate("window.holdTip.hide()");
      await page.mouse.move(0, 0);
      await anchor.hover();
      await shown.waitFor();
      await page.keyboard.press("Escape");
      expect(await shown.count()).toBe(0);
      await page.evaluate("window.holdTip.pin()");
      await anchor.evaluate((element) => element.remove());
      await page.locator(".hold-tip").waitFor({ state: "detached" });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["hold-confirm", tests]]);
