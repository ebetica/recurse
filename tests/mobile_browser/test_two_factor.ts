import { expect } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { themePalettes } from "../../src/themes";
import { tmpdir } from "node:os";
import type { Locator } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { authenticatorCode } from "../backend/totp_support";
import {
  captureErrors,
  closeWithRoutes,
  LOGIN,
  openSettingsPanel,
  runBrowserTests,
  startServer,
  stopServer,
  type BrowserTest,
} from "./common";

async function hitCorners(control: Locator, expected = true): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  expect(
    await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [box.left + 8, box.right - 8].every((x) =>
        [box.top + 8, box.bottom - 8].every((y) =>
          element.contains(element.ownerDocument.elementFromPoint(x, y)),
        ),
      );
    }),
  ).toBe(expected);
}

export const tests: BrowserTest[] = [
  // Feature: #3385 Optional authenticator setup and password-plus-code sign-in work on phones and desktop.
  async function test_two_factor_sign_in(browser) {
    for (const [name, width] of [
      ["phone", 390],
      ["desktop", 1280],
    ] as const) {
      const server = await startServer({ auth: true });
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: name === "phone",
        hasTouch: name === "phone",
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const now = 1_700_000_000;
      const setAuthTime = async (now: number) => {
        expect(
          (
            await page.request.post(`${server.base}__browser-test/auth-clock`, {
              data: { now },
            })
          ).status(),
        ).toBe(200);
      };
      let releaseEnable = () => {};
      let releasePoll = () => {};
      try {
        const custom = {
          ...themePalettes[0]!,
          name: "Protected sign-in CSS",
          css: "#brand > img, [data-theme-protected], .setup-key, .recovery-codes, [data-theme-protected] button { visibility: hidden !important; }",
        };
        await mkdir(join(server.data, "data/config"), { recursive: true });
        await writeFile(
          join(server.data, "data/config/themes.json"),
          JSON.stringify({ theme: custom.name, custom: [custom] }),
        );
        await page.goto(server.base);
        await page.getByLabel("Password", { exact: true }).fill(LOGIN);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        ]);
        await page.locator(".agent").first().waitFor();
        await hitCorners(page.locator("#brand > img"), false);
        await setAuthTime(now);
        await openSettingsPanel(page);
        await page.locator('#settings-nav button[data-cat="account"]').click();
        await page
          .getByRole("button", { name: /^Two-factor sign-in / })
          .click();
        const editor = page.getByRole("region", {
          name: "Two-factor sign-in",
          exact: true,
        });
        await browserExpect(
          page.locator('[data-theme-protected="two-factor-sign-in"]'),
        ).toHaveCount(1);
        await editor.getByLabel("Current password").fill(LOGIN);
        const setup = editor.getByRole("button", {
          name: "Set up two-factor sign-in",
          exact: true,
        });
        await hitCorners(setup);
        await setup.click();
        const link = editor.getByRole("link", {
          name: "Open authenticator app",
        });
        await browserExpect(link).toHaveAttribute(
          "href",
          /^otpauth:\/\/totp\//,
        );
        const secret = await editor.locator(".setup-key").textContent();
        expect(secret).toBeTruthy();
        await hitCorners(link);
        await hitCorners(editor.locator(".setup-key"));
        const screenshotRoot = process.env.RECURSE_AGENT_TMPDIR ?? tmpdir();
        await page.screenshot({
          path: join(screenshotRoot, `two-factor-setup-${name}.png`),
          fullPage: true,
        });
        const enableGate = new Promise<void>((resolve) => {
          releaseEnable = resolve;
        });
        const pollGate = new Promise<void>((resolve) => {
          releasePoll = resolve;
        });
        let enableStarted!: () => void;
        const enabling = new Promise<void>((resolve) => {
          enableStarted = resolve;
        });
        let pollStarted!: () => void;
        const polling = new Promise<void>((resolve) => {
          pollStarted = resolve;
        });
        let capturePoll = false;
        await page.route(
          `${server.base}api/settings/two-factor`,
          async (route) => {
            if (
              route.request().method() === "POST" &&
              route.request().postDataJSON().action === "enable"
            ) {
              capturePoll = true;
              enableStarted();
              await enableGate;
            }
            await route.continue();
          },
        );
        await page.route(`${server.base}api/backends`, async (route) => {
          if (!capturePoll || route.request().method() !== "GET")
            return route.continue();
          capturePoll = false;
          const headers = await route.request().allHeaders();
          pollStarted();
          await pollGate;
          const response = await route.fetch({ headers });
          expect(response.status()).toBe(401);
          await route.fulfill({ response });
        });
        await editor
          .getByLabel("Authenticator or recovery code")
          .fill(authenticatorCode(secret!, now));
        const enable = editor.getByRole("button", {
          name: "Turn on two-factor sign-in",
          exact: true,
        });
        await hitCorners(enable);
        await enable.click();
        await enabling;
        await page.evaluate(() =>
          (globalThis as any).dispatchEvent(
            new Event("recurse:refresh-remotes"),
          ),
        );
        await polling;
        const enabled = page.waitForResponse(
          (response) =>
            response.url() === `${server.base}api/settings/two-factor` &&
            response.request().method() === "POST",
        );
        releaseEnable();
        expect((await enabled).status()).toBe(200);
        const checked = page.waitForResponse(
          `${server.base}api/status?session-check`,
        );
        releasePoll();
        expect((await checked).status()).toBe(200);
        await browserExpect(editor.locator(".recovery-codes")).toBeVisible();
        expect(
          (await editor.locator(".recovery-codes").textContent())!.split("\n"),
        ).toHaveLength(10);
        expect(await editor.locator(".setup-key").count()).toBe(0);
        await hitCorners(editor.locator(".recovery-codes"));
        await editor.getByRole("button", { name: "Done", exact: true }).click();
        await hitCorners(
          editor.getByRole("button", {
            name: "Turn off two-factor sign-in",
            exact: true,
          }),
        );
        await page
          .getByRole("button", {
            name:
              name === "phone" ? "Close Two-factor sign-in" : "Back to Account",
            exact: true,
          })
          .click();
        await setAuthTime(now + 30);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.getByRole("button", { name: "Log out", exact: true }).click(),
        ]);
        await browserExpect(
          page.getByLabel("Authenticator or recovery code"),
        ).toBeVisible();
        await page.screenshot({
          path: join(screenshotRoot, `two-factor-sign-in-${name}.png`),
          fullPage: true,
        });
        await hitCorners(
          page.getByRole("button", { name: "Sign in", exact: true }),
        );
        await page.getByLabel("Password", { exact: true }).fill(LOGIN);
        await page
          .getByLabel("Authenticator or recovery code")
          .fill(authenticatorCode(secret!, now + 30));
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        ]);
        await page.locator(".agent").first().waitFor();
        expect(errors).toEqual([]);
      } finally {
        releaseEnable();
        releasePoll();
        await closeWithRoutes(page);
        await context.close();
        await stopServer(server);
      }
    }
  },
];

if (import.meta.main) await runBrowserTests([["two-factor", tests]]);
