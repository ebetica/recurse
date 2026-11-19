import { expect } from "bun:test";
import type { Page, Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  gotoRoot,
  openSettingsPanel,
  runBrowserTests,
  type BrowserTest,
  expectHitCorners,
} from "./common";

const AVAILABLE = {
  release: { version: "0.1.0", commit: "abc1234" },
  skipped: null,
  checking: false,
  channel: "release",
  installed: "v0.1.0",
  available: "v0.2.0",
  checked_at: 1,
  error: null,
  update: null,
};
const AVAILABLE_TEXT =
  "Recurse v0.2.0 is available (installed: v0.1.0, newest release).";

const progress = (state: string, detail: string | null = null) => ({
  ...AVAILABLE,
  update: { state, detail },
});

async function routeUpdates(page: Page, base: string) {
  const held: Route[] = [];
  let arrived = () => {};
  await page.route(`${base}api/settings/update`, (route) => {
    held.push(route);
    arrived();
  });
  return {
    async next(method: string): Promise<Route> {
      while (!held.length)
        await new Promise<void>((resolve) => (arrived = resolve));
      const route = held.shift()!;
      expect(route.request().method()).toBe(method);
      return route;
    },
    pending: () => held.length,
  };
}

export const tests: BrowserTest[] = [
  // Regression: #2904 skipped updates do not offer an update button.
  async function test_skipped_updates_hide_button(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    try {
      const skipped = await (
        await page.request.get(base + "api/settings/update")
      ).json();
      expect(skipped.skipped).toBeTruthy();
      const updates = await routeUpdates(page, base);
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      const footer = page.locator("#settings-release");
      const status = footer.getByRole("status");
      const updateNow = footer.locator(".update-now");
      const open = async (reply: object) => {
        await page.locator("#settings-btn").click();
        const read = await updates.next("GET");
        await browserExpect(status).toHaveText("");
        await browserExpect(status).toHaveAttribute("aria-busy", "true");
        await read.fulfill(reply);
        await browserExpect(status).toHaveAttribute("aria-busy", "false");
        await browserExpect(footer.locator(".settings-version")).toBeVisible();
        await browserExpect(updateNow).toBeHidden();
      };
      await open({ json: skipped });
      await browserExpect(status).toHaveText(skipped.skipped);
      await browserExpect(status).toBeVisible();
      await page.locator('#settings-nav button[data-cat="account"]').click();
      await browserExpect(
        page.getByRole("button", { name: "Change password", exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.getByRole("heading", { name: "Updates", exact: true }),
      ).toHaveCount(0);
      const close = page.locator("#settings-close");
      await close.click();
      await open({ json: { ...skipped, skipped: null } });
      await browserExpect(status).toHaveText("");
      await close.click();
      await open({
        json: {
          ...AVAILABLE,
          installed: null,
          available: null,
          error: "install.sh --check exited 1",
        },
      });
      await browserExpect(status).toHaveText(
        "Couldn't check for updates. Run `recurse update --check` in a terminal to see why.",
      );
      await browserExpect(status).toBeVisible();
      await browserExpect(status).toHaveClass(/\berr\b/);
      await close.click();
      await open({ status: 500, json: { error: "unavailable" } });
      await browserExpect(status).toHaveText(
        "Couldn't read the update status.",
      );
      await browserExpect(status).toBeVisible();
      await browserExpect(status).toHaveClass(/\berr\b/);
      expect(updates.pending()).toBe(0);
    } finally {
      await context.close();
    }
  },
  async function test_settings_update_now_follows_the_update(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      const updates = await routeUpdates(page, base);
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await openSettingsPanel(page);
      const footer = page.locator("#settings-release");
      const status = footer.getByRole("status");
      await (await updates.next("GET")).fulfill({ json: AVAILABLE });
      await browserExpect(status).toHaveText(AVAILABLE_TEXT);
      await browserExpect(status).toBeVisible();
      const updateNow = footer.getByRole("button", {
        name: "Update now",
        exact: true,
      });
      await expectHitCorners(updateNow);
      await updateNow.focus();
      await page.keyboard.press("Enter");
      const start = await updates.next("POST");
      await browserExpect(updateNow).toHaveAttribute("aria-disabled", "true");
      await browserExpect(updateNow).toBeFocused();
      await start.fulfill({ status: 202, json: progress("updating") });
      await browserExpect(status).toHaveText("Downloading the update…");
      await browserExpect(updateNow).toHaveAttribute("aria-disabled", "true");
      await browserExpect(updateNow).toBeFocused();
      await page.keyboard.press("Enter");
      await (
        await updates.next("GET")
      ).fulfill({ json: progress("waiting", "2") });
      await browserExpect(status).toHaveText(
        "Installed. Recurse restarts into it when 2 running turn(s) finish.",
      );
      await (
        await updates.next("GET")
      ).fulfill({
        json: progress("failed", "install.sh --update exited 1"),
      });
      await browserExpect(status).toHaveText(
        "Update failed. Run `recurse update` in a terminal to see why.",
      );
      await browserExpect(status).toHaveClass(/\berr\b/);
      const tryAgain = footer.getByRole("button", {
        name: "Try again",
        exact: true,
      });
      await browserExpect(tryAgain).toHaveAttribute("aria-disabled", "false");
      await browserExpect(tryAgain).toBeFocused();
      await tryAgain.tap();
      await (
        await updates.next("POST")
      ).fulfill({ status: 202, json: progress("updating") });
      await browserExpect(status).toHaveText("Downloading the update…");
      await (
        await updates.next("GET")
      ).fulfill({
        json: { ...progress("current"), available: "v0.1.0" },
      });
      await browserExpect(status).toHaveText(
        "Already up to date: v0.1.0 (newest release).",
      );
      await browserExpect(footer.locator(".update-now")).toBeHidden();
      await browserExpect(status).toBeFocused();
      await page.locator("#settings-close").click();
      await openSettingsPanel(page);
      await (await updates.next("GET")).fulfill({ json: progress("building") });
      await browserExpect(status).toHaveText(
        "Building the new version; this one keeps running…",
      );
      const poll = await updates.next("GET");
      const cancelled = page.waitForEvent(
        "requestfailed",
        (request) => request === poll.request(),
      );
      await page.locator("#settings-close").click();
      await cancelled;
      await poll.fulfill({ json: progress("failed", "late") });
      await browserExpect(footer.locator("*")).toHaveCount(0);
      await openSettingsPanel(page);
      await (await updates.next("GET")).fulfill({ json: AVAILABLE });
      await browserExpect(status).toHaveText(AVAILABLE_TEXT);
      await browserExpect(status).toBeVisible();
      expect(updates.pending()).toBe(0);
    } finally {
      await context.close();
    }
  },
];

if (import.meta.main) await runBrowserTests([["settings-updates", tests]]);
