import { expect } from "bun:test";
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  runBrowserTests,
  type BrowserTest,
} from "./common";
import { idleConv, tree } from "./fixtures";
const failed = () => [
  {
    id: "m-fail-1",
    role: "user",
    content: "nudge the release",
    error: "Pi steer was stopped before provider input",
    error_detail: "PiRPCError: Pi steer was stopped before provider input",
  },
];
const conv = (status = "idle", pending: any[] = []) => ({
  ...idleConv(),
  status,
  active_run: status === "running" ? "run-settle" : null,
  pending,
});
const open = async (
  page: any,
  base: string,
  read: () => any,
  status = "idle",
) => {
  await page.route(`${base}api/tree*`, (route: any) =>
    route.fulfill({ json: [{ ...tree()[0], status }] }),
  );
  await mockConversation(page, base, "main", read);
  await gotoRoot(page, base);
};
export const tests: BrowserTest[] = [
  async function test_failed_send_footer_390(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    let dismissed = false;
    await open(page, base, () => conv("idle", dismissed ? [] : failed()));
    await page.route(
      `${base}api/conversations/main/messages/m-fail-1`,
      (route) => {
        dismissed = true;
        return route.fulfill({ json: { ok: true } });
      },
    );
    const row = page.locator(".msg.user.pending.failed");
    await row.waitFor();
    const text = page.locator(".pending-failure-text");
    expect((await text.innerText()).trim()).toContain("Not delivered");
    expect(await text.getAttribute("title")).toBe(
      "PiRPCError: Pi steer was stopped before provider input",
    );
    expect(await row.locator(".pending-cancel").count()).toBe(0);
    expect(
      await page.evaluate(`(() => {
        const row = document.querySelector(".msg.user.pending.failed");
        const text = document.querySelector(".pending-failure-text");
        return Boolean(row && text && row.scrollWidth <= row.clientWidth + 1 && text.scrollWidth <= text.clientWidth + 40);
      })()`),
    ).toBeTrue();
    await page.locator(".pending-dismiss").click();
    await page.waitForSelector(".msg.user.pending.failed", {
      state: "detached",
      timeout: 6000,
    });
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #1784 armed Stop tip clears when the turn settles
  async function test_stop_armed_tip_clears_on_settle_390(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    let running = true;
    await open(page, base, () => conv(running ? "running" : "idle"), "running");
    const stop = page.locator("#send.stop");
    await stop.waitFor();
    await stop.tap();
    await page.waitForFunction(
      "document.querySelector('#send')?.getAttribute('aria-label') === 'Confirm stop this agent'",
    );
    expect((await page.locator(".hold-tip.on").innerText()).trim()).toBe(
      "Tap again to stop",
    );
    running = false;
    await page.waitForSelector("#send.stop", {
      state: "detached",
      timeout: 10000,
    });
    await page.waitForSelector(".hold-tip.on", {
      state: "detached",
      timeout: 2000,
    });
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #1784 Stop hover tip clears on pointer departure and Escape
  async function test_desktop_stop_hover_out(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await open(page, base, () => conv("running"), "running");
    const stop = page.locator("#send.stop");
    await stop.waitFor();
    await stop.hover();
    await page.locator(".hold-tip.on").waitFor();
    expect((await page.locator(".hold-tip.on").innerText()).trim()).toBe(
      "Tap to stop",
    );
    await page.mouse.move(640, 700);
    await page.waitForSelector(".hold-tip.on", {
      state: "detached",
      timeout: 6000,
    });
    await stop.hover();
    await page.locator(".hold-tip.on").waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".hold-tip.on", {
      state: "detached",
      timeout: 6000,
    });
    expect(errors).toEqual([]);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["failed-send-hold", tests]]);
