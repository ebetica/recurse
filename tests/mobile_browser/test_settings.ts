import { expect } from "bun:test";
import {
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  routeArtifacts,
  runBrowserTests,
  startServer,
  stopServer,
  visibleAndUncovered,
  LOGIN,
  type BrowserTest,
  openSettingsPanel,
} from "./common";
import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRelease, releaseLabel } from "../../src/release";
import { generateTheme, themePalettes } from "../../src/themes";

const LIST_OPUS = {
  id: "anthropic/claude-opus-5-5",
  label: "Claude Opus 5.5",
  route: "Claude",
  context_window: 1_000_000,
  reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
};
const LIST_SONNET = {
  id: "anthropic/claude-sonnet-5",
  label: "Claude Sonnet 5",
  route: "Claude",
  context_window: 1_000_000,
  reasoning_levels: null,
};
const LIST_SOL = {
  id: "openai-codex/gpt-6-sol",
  label: "GPT-6 Sol",
  route: "ChatGPT subscription",
  context_window: 272_000,
  reasoning_levels: ["off", "low", "medium", "high", "xhigh"],
};
const LIST_FRESH = {
  id: "openrouter/vendor/fresh",
  label: "Fresh",
  route: "OpenRouter",
  context_window: 128_000,
  reasoning_levels: ["off"] as string[] | null,
};
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type LadderEntry = { model: string; reasoning: string };

const fontSize = (el: unknown) =>
  (globalThis as any).getComputedStyle(el).fontSize;

async function routeLadder(
  page: Page,
  base: string,
  options: { levels: LadderEntry[]; list: object[] },
) {
  const levels = Object.fromEntries(
    options.levels.map((entry, i) => [String(i + 1), entry]),
  );
  const listed = new Set(
    options.list.map((model) => (model as { id: string }).id),
  );
  const ladder = {
    default_level: 3,
    levels,
    reachability: Object.fromEntries(
      options.levels.map((entry, i) => [
        String(i + 1),
        listed.has(entry.model)
          ? { ...entry, reachable: true, reason: "" }
          : {
              ...entry,
              reachable: false,
              reason: `level ${i + 1} model ${entry.model} is not in Pi's model list`,
            },
      ]),
    ),
    models: [...new Set(options.levels.map((entry) => entry.model))].map(
      (id) => ({ id, label: id, context_window: null }),
    ),
    reasoning: ALL_LEVELS,
  };
  let ladderReads = 0;
  let listReads = 0;
  const saved: {
    default_level: number;
    levels: Record<string, LadderEntry>;
  }[] = [];
  await page.route(`${base}api/settings/effort-levels`, (route) => {
    if (route.request().method() === "POST")
      saved.push(route.request().postDataJSON());
    else ladderReads++;
    return route.fulfill({ json: ladder });
  });
  await page.route(`${base}api/settings/model-list`, (route) => {
    listReads++;
    return route.fulfill({
      json: { models: options.list, reasoning: ALL_LEVELS },
    });
  });
  return {
    saved,
    levels,
    ladderReads: () => ladderReads,
    listReads: () => listReads,
  };
}

async function listCapacity(listbox: Locator): Promise<number> {
  return listbox.evaluate((el) => {
    const max = parseFloat((globalThis as any).getComputedStyle(el).maxHeight);
    const row = (el as any).querySelector("[role=option]").offsetHeight;
    return Math.floor(max / row);
  });
}

async function openLadder(page: Page, base: string): Promise<void> {
  await gotoRoot(page, base);
  await page.locator(".agent").first().waitFor();
  await openSettingsPanel(page);
  await page.locator('#settings-nav button[data-cat="models"]').click();
  await openDetail(page, /^Effort ladder /);
}

const LEVEL_ONE_HELP =
  "Used for safety review and conversation names; choose an inexpensive model such as Luna or Haiku.";

async function openDetail(page: Page, name: RegExp): Promise<void> {
  if (page.viewportSize()!.width <= 700)
    await page.getByRole("button", { name }).click();
}

async function closeDetails(page: Page): Promise<void> {
  const sheets = page.locator("dialog.settings-sheet[open]");
  while (await sheets.count())
    await sheets
      .last()
      .getByRole("button", { name: /^Close / })
      .click();
}

async function closeLevel(page: Page): Promise<void> {
  const current = page.locator(
    'dialog.settings-sheet[open][aria-label^="Level "]',
  );
  if (await current.count())
    await current.getByRole("button", { name: /^Close / }).click();
}

async function openLevel(page: Page, level: number): Promise<void> {
  await closeLevel(page);
  await openDetail(page, new RegExp(`^Level ${level} `));
  if (page.viewportSize()!.width > 700)
    await page
      .getByRole("combobox", { name: `Model for level ${level}`, exact: true })
      .focus();
}

async function expectLevelOneHelp(page: Page): Promise<void> {
  await openLevel(page, 1);
  const sheet = page.getByRole("region", { name: "Level 1", exact: true });
  await browserExpect(
    sheet.getByText(LEVEL_ONE_HELP, { exact: true }),
  ).toBeVisible();
  await closeLevel(page);
}

async function showCategory(page: Page, cat: string): Promise<void> {
  await closeDetails(page);
  const back = page.locator(".settings-cat:not([hidden]) .settings-back");
  if (await back.isVisible()) await back.click();
  await page.locator(`#settings-nav button[data-cat="${cat}"]`).click();
}

async function saveLadder(page: Page, tap = false): Promise<void> {
  await closeLevel(page);
  const save = page
    .getByRole("region", { name: "Effort ladder", exact: true })
    .getByRole("button", { name: "Save", exact: true });
  if (tap) await save.tap();
  else await save.click();
  await page.getByText("Saved. Applies to new turns.").waitFor();
}

export const tests: BrowserTest[] = [
  // Regression: #2904 skipped updates do not offer an update button.
  async function test_skipped_updates_hide_button(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    try {
      const status = await (
        await page.request.get(base + "api/settings/update")
      ).json();
      expect(status.skipped).toBeTruthy();
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.locator("#settings-btn").click();
      await openDetail(page, /^Software update/);
      await page
        .locator(".update-status")
        .getByText(status.skipped, { exact: true })
        .waitFor();
      expect(await page.locator(".update-now").isVisible()).toBeFalse();
    } finally {
      await context.close();
    }
  },
  async function test_settings_category_list_back_and_deep_links(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await openSettingsPanel(page);
    await page.locator("#settings-overlay.on").waitFor();
    const nav = page.locator("#settings-nav button");
    await browserExpect(nav).toHaveText([
      "Account",
      "Appearance",
      "Authentication",
      "Models",
      "MCPs",
    ]);
    for (const button of await nav.all())
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await browserExpect(page.locator("#settings-sections")).toBeHidden();
    await page.locator("#settings-release").waitFor();
    await visibleAndUncovered(page, "#settings-release");
    await nav.getByText("Authentication", { exact: true }).tap();
    const title = page.getByRole("heading", {
      name: "Authentication",
      exact: true,
    });
    await browserExpect(title).toBeVisible();
    await browserExpect(page.locator("#settings-nav")).toBeHidden();
    await browserExpect(
      page.locator(
        '.provider[data-provider="claude"] > .settings-detail > button.settings-row',
      ),
    ).toBeVisible();
    const back = page.getByRole("button", { name: "Back to all settings" });
    await browserExpect(back).toBeFocused();
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await back.tap();
    await browserExpect(title).toBeHidden();
    await browserExpect(
      nav.getByText("Authentication", { exact: true }),
    ).toBeVisible();
    await browserExpect(
      page.locator('#settings-nav [data-cat="auth"]'),
    ).toBeFocused();
    const url = page.url();
    await nav.getByText("Models", { exact: true }).tap();
    await browserExpect(back).toBeFocused();
    await page.goBack();
    await browserExpect(nav.first()).toBeVisible();
    await page.goBack();
    await page.locator("#settings-overlay.on").waitFor({ state: "detached" });
    expect(page.url()).toBe(url);
    await openSettingsPanel(page);
    await page.locator("#settings-close").tap();
    await page.waitForFunction("!history.state?.settings");
    expect(page.url()).toBe(url);
    await openSettingsPanel(page);
    await nav.getByText("Models", { exact: true }).tap();
    await page.waitForFunction("history.state?.settings === 2");
    await page.reload();
    await page.waitForFunction("!history.state?.settings");
    expect(page.url()).toBe(url);
    await page.locator(".agent").first().waitFor({ state: "attached" });
    await page.evaluate(() =>
      (globalThis as any).dispatchEvent(
        new CustomEvent("recurse:open-settings", { detail: "account" }),
      ),
    );
    await browserExpect(
      page.getByRole("button", { name: "Change password", exact: true }),
    ).toBeVisible();
    await browserExpect(page.locator("#settings-nav")).toBeHidden();
    await browserExpect(
      page.getByRole("button", { name: "Back to all settings" }),
    ).toBeFocused();
    await page.locator("#settings-close").tap();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() =>
      (globalThis as any).dispatchEvent(
        new CustomEvent("recurse:open-settings", { detail: "models" }),
      ),
    );
    const models = page.locator('#settings-nav button[data-cat="models"]');
    await browserExpect(models).toBeFocused();
    await browserExpect(
      page.getByRole("heading", { name: "Models", exact: true }),
    ).toBeVisible();
    await showCategory(page, "account");
    await openDetail(page, /^Add a remote$/);
    await browserExpect(
      page.locator(".remote-add input").first(),
    ).toBeVisible();
    for (const input of await page.locator(".remote-add input:visible").all())
      expect((await input.boundingBox())!.height).toBeLessThanOrEqual(44);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_phone_settings_branding_name_and_icon(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.locator("#menu-btn").tap();
    await page.locator("#sidebar.open").waitFor();
    const mark = page.locator("#brand img");
    expect(await mark.isVisible()).toBe(true);
    expect(await mark.getAttribute("src")).toBe("/static/brand/mark.svg");
    await page.waitForFunction(
      "document.querySelector('#brand img')?.complete && document.querySelector('#brand img').naturalWidth > 0",
    );
    expect(
      await mark.evaluate((image) => image.getBoundingClientRect().width),
    ).toBe(24);
    await page.locator("#sidebar .agent").first().tap();
    const customName = "My __APP__ __VERSION__ __THEME__ __ERROR__ __VALUE__";
    const open = async () => {
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="appearance"]').tap();
      await page.getByRole("button", { name: /^Name and icon / }).tap();
    };
    try {
      await gotoRoot(page, base);
      const originalTitle = await page.title();
      const originalIcon = await page
        .locator('link[rel="icon"]')
        .last()
        .getAttribute("href");
      await open();
      const section = page.locator(".settings-section").filter({
        has: page.getByRole("heading", {
          name: "Name and icon",
          exact: true,
        }),
      });
      const name = section.getByLabel("App name", { exact: true });
      await name.fill(customName);
      await section
        .getByRole("button", { name: "Save name", exact: true })
        .tap();
      await section.getByRole("status").filter({ hasText: "Saved." }).waitFor();
      const uploaded = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/settings/branding/icon") &&
          response.status() === 200,
      );
      await section.locator('input[type="file"]').setInputFiles({
        name: "icon.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>window.brandIconScriptRan=true</script><rect width="24" height="24" fill="red"/></svg>',
        ),
      });
      await uploaded;
      await page.reload();
      await page.locator("#settings-btn").waitFor({ state: "attached" });
      expect(await page.title()).toBe(customName);
      expect(await page.locator("#brand-name").textContent()).toBe(customName);
      const favicon = await page
        .locator('link[rel="icon"]')
        .last()
        .getAttribute("href");
      expect(favicon).toStartWith("/app-icon?v=");
      expect(await page.locator("#brand img").getAttribute("src")).toBe(
        favicon,
      );
      expect(
        await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),
      ).toBe(favicon);
      await page.waitForFunction(
        "document.querySelector('#brand img')?.naturalWidth > 0",
      );
      const direct = await context.newPage();
      await direct.goto(base + favicon!.slice(1));
      expect(
        await direct.evaluate(() =>
          Boolean((globalThis as any).brandIconScriptRan),
        ),
      ).toBe(false);
      await direct.close();
      await open();
      const editor = page.getByRole("region", {
        name: "Name and icon",
        exact: true,
      });
      for (const control of await editor.locator("input,button").all()) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
      await section.locator('[name="reset-name"]').tap();
      await section.getByRole("status").filter({ hasText: "Saved." }).waitFor();
      await section.locator('[name="reset-icon"]').tap();
      await section.getByRole("status").filter({ hasText: "Saved." }).waitFor();
      await page.reload();
      expect(await page.title()).toBe(originalTitle);
      expect(await page.locator("#brand-name").textContent()).toBe(
        originalTitle,
      );
      expect(
        await page.locator('link[rel="icon"]').last().getAttribute("href"),
      ).toBe(originalIcon);
      expect(await page.locator("#brand img").getAttribute("src")).toBe(
        "/static/brand/mark.svg",
      );
      expect(errors).toEqual([]);
    } finally {
      await context.request.post(base + "api/settings/branding", {
        data: { name: null, icon: null },
      });
      await context.close();
    }
  },
  async function test_mobile_settings_open_from_list(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      permissions: ["notifications"],
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.addInitScript(() => {
      const calls: unknown[] = [];
      (globalThis as any).pushSubscribes = calls;
      const notification = (globalThis as any).Notification;
      const request = notification.requestPermission;
      notification.requestPermission = async () => {
        const answer = await request.call(notification);
        calls.push(answer);
        return answer;
      };
      const manager = (globalThis as any).PushManager.prototype;
      const subscribe = manager.subscribe;
      manager.subscribe = async function (options: any) {
        calls.push({
          userVisibleOnly: options.userVisibleOnly,
          key: [...new Uint8Array(options.applicationServerKey)],
        });
        try {
          const made = await subscribe.call(this, options);
          calls.push("subscribed");
          return made;
        } catch (error) {
          calls.push(String(error));
          throw error;
        }
      };
    });
    await routeArtifacts(page, base);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.route(`${base}api/settings/update`, (route) =>
      route.fulfill({
        json: {
          release: { version: "0.1.0", commit: "abc1234" },
          skipped: null,
          checking: false,
          channel: "release",
          installed: "v0.1.0",
          available: "v0.2.0",
          checked_at: 1,
          error: null,
          update: null,
        },
      }),
    );
    await openSettingsPanel(page);
    await page.locator("#settings-overlay.on").waitFor();
    await page.locator("#settings-release").waitFor();
    expect(await page.locator("#settings-release").innerText()).toBe(
      `Recurse ${releaseLabel(await readRelease())}`,
    );
    await visibleAndUncovered(page, "#settings-release");
    await page.locator('#settings-nav button[data-cat="account"]').tap();
    await page.getByRole("button", { name: /^Software update/ }).tap();
    const updateNow = page.getByRole("button", { name: "Update now" });
    await updateNow.scrollIntoViewIfNeeded();
    expect(await page.locator(".update-status").innerText()).toBe(
      "Recurse v0.2.0 is available (installed: v0.1.0, newest release).",
    );
    await visibleAndUncovered(page, ".update-now");
    await closeDetails(page);
    expect(await page.locator("#settings-nav button").count()).toBe(5);
    expect(await page.locator("#settings-modal .signout").count()).toBe(3);
    expect(
      await page
        .getByRole("heading", {
          name: "Muse",
          exact: true,
          includeHidden: true,
        })
        .count(),
    ).toBe(0);
    const [titleBox, groupBox] = await Promise.all([
      page.getByRole("heading", { name: "Account", exact: true }).boundingBox(),
      page.locator(".settings-section .group:visible").first().boundingBox(),
    ]);
    expect(Math.round(groupBox!.x)).toBe(Math.round(titleBox!.x));
    expect(groupBox!.x + groupBox!.width).toBeLessThanOrEqual(390);
    await page
      .getByRole("button", { name: "Change password", exact: true })
      .tap();
    const password = page.locator(
      '.settings-section input[type="password"]:visible',
    );
    expect(await password.first().evaluate(fontSize)).toBe("16px");
    expect((await password.first().boundingBox())!.height).toBe(44);
    await closeDetails(page);
    const notify = page.getByRole("switch", {
      name: "Notify me when a top-level agent finishes",
    });
    const notifyRow = page.locator(".settings-section label.check:visible");
    expect((await notifyRow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.waitForFunction(
      "!document.querySelector('input[name=notify]').disabled",
    );
    expect(await notify.isChecked()).toBeFalse();
    await notifyRow.tap();
    await page.waitForFunction(
      "globalThis.pushSubscribes.length === 3 && !document.querySelector('input[name=notify]').disabled",
    );
    const subscribed = await page.evaluate(async () => {
      const nav = (globalThis as any).navigator;
      const registration = await nav.serviceWorker.getRegistration("/");
      const key = (
        (await (await fetch("/api/settings/notifications")).json()) as any
      ).public_key as string;
      return {
        worker: new URL(registration.active.scriptURL).pathname,
        scope: new URL(registration.scope).pathname,
        key: [...atob(key.replace(/-/g, "+").replace(/_/g, "/"))].map((char) =>
          char.charCodeAt(0),
        ),
        calls: (globalThis as any).pushSubscribes,
      };
    });
    expect(subscribed).toEqual({
      worker: "/push-worker.js",
      scope: "/",
      key: subscribed.key,
      calls: [
        "granted",
        { userVisibleOnly: true, key: subscribed.key },
        "AbortError: Registration failed - permission denied",
      ],
    });
    expect(subscribed.key.length).toBe(65);
    expect(await notify.isChecked()).toBeFalse();
    expect(
      await page.locator(".settings-section .msg.err:visible").textContent(),
    ).toBe("Registration failed - permission denied");
    const other = String(
      (
        await page.evaluate(
          async () =>
            (
              await fetch("/api/conversations", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              })
            ).json() as Promise<any>,
        )
      ).id,
    );
    const worker = context
      .serviceWorkers()
      .find((each) => each.url().endsWith("/push-worker.js"))!;
    await worker.evaluate(
      (cid) => (globalThis as any).openAgent(cid).catch(() => undefined),
      other,
    );
    await page.waitForFunction(
      (cid) =>
        new URLSearchParams((globalThis as any).location.hash.slice(1)).get(
          "agent",
        ) === cid,
      other,
    );
    await page.getByRole("button", { name: "Back to all settings" }).tap();
    await page.locator('#settings-nav button[data-cat="models"]').tap();
    expect(
      await page
        .locator('#settings-nav button[data-cat="models"]')
        .getAttribute("class"),
    ).toContain("on");
    expect(
      await page.getByRole("heading", { name: "Change password" }).isVisible(),
    ).toBeFalse();
    expect(
      await page
        .getByRole("button", { name: /^Maximum context window / })
        .isVisible(),
    ).toBeTrue();
    await page.locator("#settings-close").tap();
    await page.waitForFunction(
      "!document.querySelector('#settings-overlay')?.classList.contains('on')",
    );
    expect(page.url()).toContain(other);
    await page.goBack();
    await page.waitForFunction(
      (cid) =>
        !(globalThis as any).location.hash.includes(cid) &&
        !(globalThis as any).history.state?.settings,
      other,
    );
    await page.goForward();
    await page.waitForFunction(
      (cid) =>
        (globalThis as any).location.hash.includes(cid) &&
        !(globalThis as any).history.state?.settings,
      other,
    );
    expect(errors).toEqual([
      expect.stringContaining(
        "does not support the Push API in incognito mode",
      ),
    ]);
    await context.close();
  },
  // Feature: #2320 context slider and exact typed values share the persisted setting.
  async function test_settings_context_window(browser, base) {
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const open = async () => {
        await page.locator(".agent").first().waitFor();
        await openSettingsPanel(page);
        await page.locator('#settings-nav button[data-cat="models"]').click();
      };
      await gotoRoot(page, base);
      await open();
      const warming = page.getByRole("switch", {
        name: "Keep prompt cache warm while agents work",
      });
      await browserExpect(warming).toBeEnabled();
      await browserExpect(warming).toBeChecked();
      await warming.uncheck();
      await browserExpect(warming).toBeEnabled();
      await page.reload({ waitUntil: "domcontentloaded" });
      await open();
      await browserExpect(warming).not.toBeChecked();
      await warming.check();
      await browserExpect(warming).toBeEnabled();
      await openDetail(page, /^Maximum context window /);
      const maximum = page.getByRole("spinbutton", {
        name: "Maximum context window (tokens)",
      });
      const slider = page.getByRole("slider", {
        name: "Maximum context window slider (tokens)",
      });
      expect(await slider.count()).toBe(1);
      await page.waitForFunction(
        "document.querySelector('#maximum-context-window').value !== ''",
      );
      const original = await maximum.inputValue();
      expect(await slider.inputValue()).toBe(original);
      for (const control of [slider, maximum]) {
        const bounds = (await control.boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(width === 412 ? 44 : 36);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await slider.fill("500000");
      expect(await maximum.inputValue()).toBe("500000");
      await maximum.fill("500123");
      expect(await slider.inputValue()).toBe("500123");
      await slider.focus();
      await slider.press("ArrowRight");
      expect(await maximum.inputValue()).toBe("500124");
      expect(await slider.inputValue()).toBe("500124");
      expect(
        await maximum.evaluate(
          (el) =>
            (el as unknown as { validity: { valid: boolean } }).validity.valid,
        ),
      ).toBeTrue();
      const card = maximum.locator("xpath=ancestor::form");
      await maximum.fill("63999");
      await card.getByRole("button", { name: "Save", exact: true }).click();
      expect(
        await maximum.evaluate(
          (el) =>
            (el as unknown as { validity: { rangeUnderflow: boolean } })
              .validity.rangeUnderflow,
        ),
      ).toBeTrue();
      expect(await card.locator(".msg").innerText()).toBe("");
      await maximum.fill("500123");
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await page
        .getByText("Saved. Applies when an agent process next starts.")
        .waitFor();
      await page.reload({ waitUntil: "domcontentloaded" });
      await open();
      await openDetail(page, /^Maximum context window /);
      await page.waitForFunction(
        "document.querySelector('#maximum-context-window').value === '500123'",
      );
      expect(await slider.inputValue()).toBe("500123");
      await maximum.fill(original);
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await page
        .getByText("Saved. Applies when an agent process next starts.")
        .waitFor();
      await showCategory(page, "account");
      await openDetail(page, /^Deleted agents' history /);
      const retention = page.getByRole("spinbutton", {
        name: "Keep deleted agents' history (days)",
      });
      await page.waitForFunction(
        "document.querySelector('#deleted-agent-history')?.value !== ''",
      );
      const kept = await retention.inputValue();
      expect(Number(kept)).toBe(90);
      const history = retention.locator("xpath=ancestor::form");
      await retention.fill("120");
      await history.getByRole("button", { name: "Save", exact: true }).click();
      await history
        .getByText("Saved. Applies during the next cleanup.")
        .waitFor();
      expect(
        await (
          await page.request.get(base + "api/settings/deleted-agent-history")
        ).json(),
      ).toEqual({ days: 120 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await open();
      await showCategory(page, "account");
      await openDetail(page, /^Deleted agents' history /);
      await page.waitForFunction(
        "document.querySelector('#deleted-agent-history')?.value === '120'",
      );
      await retention.fill(kept);
      await history.getByRole("button", { name: "Save", exact: true }).click();
      await history
        .getByText("Saved. Applies during the next cleanup.")
        .waitFor();
      expect(errors).toEqual([]);
      await context.close();
    }
  },
  async function test_settings_model_list_update_keeps_unsaved_ladder_picks(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const entry = { model: "anthropic/claude-opus-5-5", reasoning: "high" };
    const routes = await routeLadder(page, base, {
      levels: [entry, entry, entry, entry, entry],
      list: [LIST_OPUS, { ...LIST_FRESH, reasoning_levels: null }],
    });
    const idle = { updating: false, updated_at: null, count: 449, error: null };
    let status: object = idle;
    let posts = 0;
    await page.route(`${base}api/settings/model-list-update`, (route) => {
      if (route.request().method() === "POST") {
        posts++;
        status = {
          updating: false,
          updated_at: null,
          count: 449,
          error:
            "openrouter: Unable to connect. Is the computer able to access the url?",
        };
        return route.fulfill({
          status: 202,
          json: { ...idle, updating: true },
        });
      }
      return route.fulfill({ json: status });
    });
    await openLadder(page, base);
    const line = page.locator(".model-list-status");
    await page.getByText("449 models in Pi's list.").waitFor();
    const readsBefore = routes.ladderReads();
    await openLevel(page, 2);
    const box = page.getByRole("combobox", { name: "Model for level 2" });
    await box.click();
    await box.fill("fresh");
    await box.press("Enter");
    expect(await box.inputValue()).toBe("Fresh");
    const sonnet = { model: "anthropic/claude-sonnet-5", reasoning: "low" };
    routes.levels["3"] = sonnet;
    const refreshedList = page.waitForResponse(
      `${base}api/settings/model-list`,
    );
    await closeLevel(page);
    await page.getByRole("button", { name: /^Update model list/ }).click();
    await page
      .getByText(
        "Could not update: openrouter: Unable to connect. Is the computer able to access the url? Using Pi's current list.",
      )
      .waitFor();
    expect(await line.getAttribute("class")).toContain("err");
    expect(posts).toBe(1);
    await (await refreshedList).finished();
    await page.waitForFunction(
      () =>
        (
          (globalThis as any).document.querySelector(
            'input[aria-label="Model for level 3"]',
          ) as { value: string }
        ).value === "anthropic/claude-sonnet-5",
    );
    expect(routes.listReads()).toBe(2);
    expect(routes.ladderReads()).toBeGreaterThan(readsBefore);
    await browserExpect(
      page.locator('input[aria-label="Model for level 2"]'),
    ).toHaveValue("Fresh");
    await browserExpect(
      page.getByRole("button", { name: /^Update model list/ }),
    ).toBeEnabled();
    await saveLadder(page);
    expect(routes.saved).toHaveLength(1);
    const levels = routes.saved[0]!.levels;
    expect(levels["2"]).toEqual({
      model: "openrouter/vendor/fresh",
      reasoning: "high",
    });
    expect(levels["1"]).toEqual(entry);
    expect(levels["3"]).toEqual(sonnet);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_settings_model_box_keyboard_picks_and_restores(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const opus = { model: "anthropic/claude-opus-5-5", reasoning: "high" };
    const gone = { model: "anthropic/claude-gone", reasoning: "minimal" };
    const offOpus = { model: "anthropic/claude-opus-5-5", reasoning: "off" };
    const listRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/settings/model-list"))
        listRequests.push(request.url());
    });
    const routes = await routeLadder(page, base, {
      levels: [gone, offOpus, opus, opus, opus],
      list: [LIST_OPUS, LIST_SONNET, LIST_SOL, LIST_FRESH],
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    expect(listRequests).toEqual([]);
    await page.locator("#settings-btn").click();
    await page.locator('#settings-nav button[data-cat="models"]').click();
    await openDetail(page, /^Effort ladder /);
    const box = (level: number) =>
      page.locator(`input[aria-label="Model for level ${level}"]`);
    const reasoning = (level: number) =>
      page.getByLabel(`Reasoning for level ${level}`);
    await expectLevelOneHelp(page);
    await openLevel(page, 1);
    expect(routes.listReads()).toBe(1);
    expect(await box(1).getAttribute("placeholder")).toBe(
      "anthropic/claude-gone",
    );
    await browserExpect(box(1)).toHaveAttribute("aria-expanded", "true");
    await page
      .getByText(
        "level 1 model anthropic/claude-gone is not in Pi's model list",
      )
      .waitFor();
    const levelTexts = (level: number) =>
      reasoning(level)
        .locator("option")
        .evaluateAll((options) => options.map((o) => o.textContent));
    expect(await levelTexts(2)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "off (not offered for this model)",
    ]);
    expect(await reasoning(2).inputValue()).toBe("off");
    await openLevel(page, 3);
    await box(3).click();
    expect(await box(3).getAttribute("aria-expanded")).toBe("true");
    const listbox = page.getByRole("listbox", { name: "Model for level 3" });
    expect(await listbox.getByRole("option").count()).toBe(4);
    expect(await listCapacity(listbox)).toBeGreaterThanOrEqual(6);
    const activeId = await box(3).getAttribute("aria-activedescendant");
    expect(
      await page.locator(`[id="${activeId}"]`).getAttribute("data-id"),
    ).toBe("anthropic/claude-opus-5-5");
    const first = listbox.getByRole("option").first();
    expect(await first.innerText()).toContain("Claude Opus 5.5");
    expect(await first.innerText()).toContain("anthropic/claude-opus-5-5");
    expect(await first.innerText()).toContain("Claude");
    expect(await first.innerText()).toContain("1M");
    await box(3).fill("gpt");
    expect(
      await listbox
        .getByRole("option")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-id"))),
    ).toEqual(["openai-codex/gpt-6-sol"]);
    await box(3).press("ArrowDown");
    await box(3).press("Escape");
    expect(await box(3).inputValue()).toBe("Claude Opus 5.5");
    expect(await box(3).getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator("#settings-overlay.on").count()).toBe(1);
    await box(3).fill("sol");
    await box(3).press("Tab");
    expect(await box(3).inputValue()).toBe("Claude Opus 5.5");
    expect(await listbox.isVisible()).toBeFalse();
    await box(3).click();
    await box(3).fill("frsh");
    await box(3).press("Enter");
    expect(await box(3).inputValue()).toBe("Fresh");
    expect(await levelTexts(3)).toEqual(["off"]);
    expect(await reasoning(3).inputValue()).toBe("off");
    await openLevel(page, 4);
    await box(4).click();
    await box(4).fill("claude");
    await box(4).press("ArrowDown");
    await box(4).press("Enter");
    expect(await box(4).inputValue()).toBe("Claude Sonnet 5");
    expect(await levelTexts(4)).toHaveLength(7);
    expect(await reasoning(4).inputValue()).toBe("high");
    await openLevel(page, 5);
    await box(5).click();
    await box(5).fill("gpt");
    await box(5).press("Enter");
    expect(await reasoning(5).inputValue()).toBe("high");
    await saveLadder(page);
    expect(routes.saved).toEqual([
      {
        default_level: 3,
        levels: {
          "1": gone,
          "2": offOpus,
          "3": { model: "openrouter/vendor/fresh", reasoning: "off" },
          "4": { model: "anthropic/claude-sonnet-5", reasoning: "high" },
          "5": { model: "openai-codex/gpt-6-sol", reasoning: "high" },
        },
      },
    ]);
    await openLevel(page, 1);
    await box(1).click();
    await box(1).press("Escape");
    expect(await page.locator("#settings-overlay.on").count()).toBe(1);
    await browserExpect(
      page.getByRole("region", { name: "Level 1", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      "!document.querySelector('#settings-overlay')?.classList.contains('on')",
    );
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_mobile_model_box_lists_inline_and_picks_on_tap(
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
    const opus = { model: "anthropic/claude-opus-5-5", reasoning: "high" };
    const routes = await routeLadder(page, base, {
      levels: [opus, opus, opus, opus, opus],
      list: [LIST_OPUS, LIST_SONNET, LIST_SOL, LIST_FRESH],
    });
    await routeArtifacts(page, base);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await openSettingsPanel(page);
    await page.locator("#settings-overlay.on").waitFor();
    await page.locator('#settings-nav button[data-cat="models"]').tap();
    await page.getByRole("button", { name: /^Effort ladder / }).tap();
    await expectLevelOneHelp(page);
    await openLevel(page, 2);
    const sheet = page.getByRole("region", { name: "Level 2", exact: true });
    const box = sheet.getByRole("combobox", { name: "Model for level 2" });
    await box.waitFor();
    const select = page.getByLabel("Reasoning for level 2");
    for (const control of [box, select]) {
      const bounds = (await control.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    }
    expect(await box.evaluate(fontSize)).toBe("16px");
    expect(await box.getAttribute("autocapitalize")).toBe("off");
    expect(await box.getAttribute("autocorrect")).toBe("off");
    await box.tap();
    await page.keyboard.type("fre");
    const listbox = page.getByRole("listbox", { name: "Model for level 2" });
    const option = listbox.locator('[data-id="openrouter/vendor/fresh"]');
    await option.waitFor();
    const [listBox, optionBox] = await Promise.all([
      listbox.boundingBox(),
      option.boundingBox(),
    ]);
    expect(
      await listbox.evaluate(
        (el) => (globalThis as any).getComputedStyle(el).position,
      ),
    ).toBe("static");
    const scrolledInputBox = await box.boundingBox();
    expect(listBox!.y).toBeGreaterThanOrEqual(
      scrolledInputBox!.y + scrolledInputBox!.height,
    );
    expect(optionBox!.height).toBeGreaterThanOrEqual(44);
    expect(await listCapacity(listbox)).toBeGreaterThanOrEqual(4);
    await visibleAndUncovered(
      page,
      '.model-box-option[data-id="openrouter/vendor/fresh"]:visible',
    );
    await option.tap();
    expect(await box.inputValue()).toBe("Fresh");
    expect(await select.inputValue()).toBe("off");
    await saveLadder(page, true);
    expect(routes.saved[0]!.levels["2"]).toEqual({
      model: "openrouter/vendor/fresh",
      reasoning: "off",
    });
    expect(routes.saved[0]!.levels["1"]).toEqual(opus);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2357 loading friendly model metadata never flashes a raw id or resizes its slot.
  async function test_composer_names_a_model_outside_the_ladder(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const entry = { model: "anthropic/claude-opus-5-5", reasoning: "high" };
    await routeLadder(page, base, {
      levels: [entry, entry, entry, entry, entry],
      list: [{ ...LIST_OPUS, label: "Opus from the list" }],
    });
    await page.route(`${base}api/settings/effort-levels`, async (route) => {
      const response = await route.fetch();
      return route.fulfill({
        json: { ...(await response.json()), models: [] },
      });
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = page.waitForRequest(`${base}api/settings/model-list`);
    await page.route(`${base}api/settings/model-list`, async (route) => {
      await gate;
      await route.fallback();
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await started;
    const model = page.locator("#model-trigger .model-name");
    const width = await model.evaluate(
      (node) => node.getBoundingClientRect().width,
    );
    const before = await model.innerText();
    release();
    expect(before).toBe("Effort");
    await page.waitForFunction(
      "document.querySelector('#model-trigger .model-name').textContent === 'Opus from the list'",
    );
    expect(
      await model.evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(width);
    expect(errors).toEqual([]);
    await closeWithRoutes(context);
  },
  async function test_shortcut_pane_default_closed_persists_and_keymap_active(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.locator("#shortcut-pane").waitFor();
    expect(
      await page.evaluate("!document.getElementById('shortcut-pane').open"),
    ).toBeTrue();
    const shortcutGroup = page
      .locator("#shortcut-groups .shortcut-group")
      .first();
    await shortcutGroup.waitFor({ state: "attached" });
    expect(await shortcutGroup.isVisible()).toBeFalse();
    const storedPane = await page.evaluate(
      "localStorage.getItem('recurse.shortcutsPaneOpen')",
    );
    expect(storedPane === null || storedPane === "closed").toBeTrue();
    const composer = page.locator("#input");
    await page.evaluate("document.getElementById('input')?.blur()");
    await page.keyboard.press("j");
    expect(await composer.inputValue()).toBe("");
    await page.locator("#shortcut-pane > summary").click();
    expect(
      await page.evaluate("document.getElementById('shortcut-pane').open"),
    ).toBeTrue();
    await page.waitForFunction(
      "localStorage.getItem('recurse.shortcutsPaneOpen') === 'open'",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".agent").first().waitFor();
    await page.waitForFunction("document.getElementById('shortcut-pane').open");
    await shortcutGroup.waitFor();
    expect(await page.locator("#key-mode").isVisible()).toBeTrue();
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_dummy_auth(browser, _base) {
    const server = await startServer({ auth: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const light = themePalettes.find((p) => p.name === "GitHub Light")!;
    const tokens = generateTheme(light);
    const rgb = (hex: string) =>
      `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
    const colors = () =>
      page.evaluate(() => {
        const browser = globalThis as any;
        const style = (selector: string) =>
          browser.getComputedStyle(browser.document.querySelector(selector));
        return [
          style("body").backgroundColor,
          style("form").backgroundColor,
          style("button").backgroundColor,
          style("button").color,
        ];
      });
    const themed = [
      rgb(tokens.bg!),
      rgb(tokens.panel!),
      rgb(tokens.accent!),
      rgb(tokens["text-on-accent"]!),
    ];
    try {
      const themesFile = join(server.data, "data/config/themes.json");
      for (const corrupt of [false, true]) {
        if (corrupt) {
          await mkdir(join(server.data, "data/config"), { recursive: true });
          await writeFile(themesFile, "{not json");
        } else expect(await Bun.file(themesFile).exists()).toBe(false);
        const shown = await page.goto(server.base);
        expect(shown?.status()).toBe(401);
        await page.locator('input[name="password"]').waitFor();
        expect(await page.locator("form button").textContent()).toBe("Sign in");
      }
      await writeFile(themesFile, JSON.stringify({ theme: "GitHub Light" }));
      const response = await page.goto(server.base);
      expect(response?.status()).toBe(401);
      expect(await colors()).toEqual(themed);
      await page.locator('input[name="password"]').fill("wrong");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "commit" }),
        page.locator('input[name="password"]').press("Enter"),
      ]);
      await page.locator(".err", { hasText: "Wrong password" }).waitFor();
      expect(await colors()).toEqual(themed);
      await page.locator('input[name="password"]').fill(LOGIN);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "commit" }),
        page.locator("form button").click(),
      ]);
      await page.waitForLoadState("domcontentloaded");
      await page.locator(".agent").first().waitFor();
      await page.waitForFunction(
        "!document.querySelector('#messages')?.classList.contains('stale')",
      );
      await page.locator("#sidebar.open .agent.selected").click();
      await page.locator("#input").waitFor();
      await visibleAndUncovered(page, "#messages");
      await visibleAndUncovered(page, "#input");
      expect(await page.locator("#messages").isVisible()).toBeTrue();
      expect(await page.locator("#input").isVisible()).toBeTrue();
      await openSettingsPanel(page);
      await showCategory(page, "account");
      const homes = page.locator(".remotes-settings .remote-incoming");
      await homes.getByText("No homes have access.", { exact: true }).waitFor();
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const minted = await context.request.post(
          `${server.base}api/backend-keys`,
          {
            data: { password: LOGIN, name: "browser-home" },
          },
        );
        expect(minted.status()).toBe(200);
        ids.push(((await minted.json()) as { id: string }).id);
      }
      await page.locator("#settings-close").tap();
      await openSettingsPanel(page);
      await showCategory(page, "account");
      for (const id of ids) {
        const address = `@browser-home\\.${id.slice(0, 6)}`;
        await homes
          .getByRole("button", {
            name: new RegExp(`^browser-home ${address} · last seen never`),
          })
          .tap();
        const details = page.getByRole("region", {
          name: "browser-home",
          exact: true,
        });
        await browserExpect(
          details.getByText(
            new RegExp(
              `^Created .+ · last seen never · agents here reach it as ${address}$`,
            ),
          ),
        ).toBeVisible();
        await details
          .getByRole("button", { name: "Revoke access", exact: true })
          .tap();
        await browserExpect(details).toHaveCount(0);
      }
      await homes.getByText("No homes have access.", { exact: true }).waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await stopServer(server);
    }
  },
  // Feature: #2963 subscription sign-in opens the provider and takes the pasted address.
  async function test_subscription_sign_in_pastes_the_redirect_address(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    for (const [authorize, callback, code] of [
      [
        "https://claude.ai/oauth/authorize",
        "http://localhost:53692/callback",
        "claude-code",
      ],
      [
        "https://auth.openai.com/oauth/authorize",
        "http://localhost:1455/auth/callback",
        "chatgpt-code",
      ],
    ]) {
      await context.route(`${authorize}**`, (route) => {
        const state = new URL(route.request().url()).searchParams.get("state");
        const target = `${callback}?code=${code}&state=${state}`;
        return route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(target)})</script>`,
        });
      });
      await context.route(`${callback}**`, (route) =>
        route.fulfill({ status: 404, body: "unreachable" }),
      );
    }
    const page = await context.newPage();
    const errors = captureErrors(page);
    const requests: Record<string, string>[] = [];
    const replies: [number, string][] = [
      [
        200,
        JSON.stringify({
          access_token: "sk-test-acc",
          refresh_token: "sk-test-ref",
          expires_in: 3600,
        }),
      ],
      [429, "slow"],
    ];
    const tokens = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (call) => {
        requests.push({
          path: new URL(call.url).pathname,
          ...Object.fromEntries(new URLSearchParams(await call.text())),
        });
        const [status, body] = replies.shift() ?? [500, "no reply"];
        return new Response(body, { status });
      },
    });
    const account = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
      }),
    ).toString("base64url");
    const chatgptToken = JSON.stringify({
      access_token: `h.${account}.s`,
      refresh_token: "sk-test-cref",
      expires_in: 7200,
    });
    try {
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.request.post(`${base}__browser-test/subscription-token-urls`, {
        data: {
          claude: `${tokens.url}claude/token`,
          chatgpt: `${tokens.url}codex/token`,
        },
      });
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="auth"]').tap();
      const signIn = async (title: string, name: string) => {
        await closeDetails(page);
        await page
          .locator(
            `.provider[data-provider="${title.toLowerCase()}"] > .settings-detail > button.settings-row`,
          )
          .tap();
        const section = page.getByRole("region", { name: title, exact: true });
        const subscription = section.getByRole("button", {
          name: "Subscription",
        });
        await section.getByRole("button", { name: "API key" }).tap();
        await browserExpect(section.locator("button.primary")).toHaveText(
          "Save key",
        );
        await subscription.tap();
        await browserExpect(section.locator(".keypanel")).toBeHidden();
        const open = section.getByRole("link", {
          name: `Open ${name} sign-in`,
        });
        const answer = section.getByRole("textbox", {
          name: `Address after signing in to ${name}`,
        });
        const finish = section.getByRole("button", { name: "Finish sign-in" });
        for (const control of [open, answer, finish]) {
          await control.waitFor();
          expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(
            44,
          );
        }
        await browserExpect(open).toBeFocused();
        const [provider] = await Promise.all([
          context.waitForEvent("page"),
          open.tap(),
        ]);
        await provider.waitForURL(/^http:\/\/localhost:\d+\/.*\?code=/);
        const state = new URL(provider.url()).searchParams.get("state");
        await answer.fill(provider.url());
        await provider.close();
        await finish.tap();
        return { section, state };
      };

      const claude = await signIn("Claude", "Claude");
      await browserExpect(
        claude.section.getByText("Logged in with your Claude subscription."),
      ).toBeVisible();
      await browserExpect(
        page.locator(
          '.provider[data-provider="claude"] > .settings-detail > button.settings-row .settings-row-value',
        ),
      ).toHaveText("Subscription · signed in");
      await browserExpect(claude.section.locator(".paste-sign-in")).toHaveCount(
        0,
      );

      const chatgpt = await signIn("OpenAI", "ChatGPT");
      const command = chatgpt.section.locator(".localfb pre");
      await browserExpect(command).toContainText("code=chatgpt-code");
      await browserExpect(
        chatgpt.section.locator(".paste-sign-in"),
      ).toHaveCount(0);
      await chatgpt.section
        .getByRole("textbox", { name: "Command output" })
        .fill(chatgptToken);
      await chatgpt.section
        .locator(".localfb")
        .getByRole("button", { name: "Finish sign-in" })
        .tap();
      await browserExpect(
        chatgpt.section.getByText("Logged in with your ChatGPT subscription."),
      ).toBeVisible();
      await browserExpect(chatgpt.section.locator(".localfb")).toBeHidden();

      expect(requests.map((request) => [request.path, request.code])).toEqual([
        ["/claude/token", "claude-code"],
        ["/codex/token", "chatgpt-code"],
      ]);
      expect(requests[0]!.code_verifier).toBe(claude.state!);
      expect(errors).toEqual([]);
    } finally {
      for (const path of ["auth", "codex-auth"])
        await page.request.post(`${base}api/pi/${path}/logout`);
      await context.close();
      await tokens.stop(true);
    }
  },
  // Feature: #2932 response-header usage limits show under each login.
  async function test_usage_limits_from_response_headers(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const at = (hours: number) =>
      String(Math.floor(Date.now() / 1000) + hours * 3600);
    try {
      for (const path of ["auth", "codex-auth"])
        expect(
          (
            await page.request.post(`${base}api/pi/${path}/api-key`, {
              data: { key: "browser-test-inline-key" },
            })
          ).ok(),
        ).toBeTrue();
      for (const [name, headers] of [
        [
          "anthropic-sse",
          {
            "anthropic-ratelimit-unified-status": "allowed",
            "anthropic-ratelimit-unified-5h-status": "allowed",
            "anthropic-ratelimit-unified-5h-utilization": "0.62",
            "anthropic-ratelimit-unified-5h-reset": at(2),
            "anthropic-ratelimit-unified-7d-status": "allowed",
            "anthropic-ratelimit-unified-7d-utilization": "0.18",
            "anthropic-ratelimit-unified-7d-reset": at(72),
            "anthropic-ratelimit-unified-representative-claim": "five_hour",
            "anthropic-ratelimit-unified-reset": at(2),
          },
        ],
        [
          "openai-codex-sse",
          {
            "x-codex-primary-used-percent": "41",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": at(1),
            "x-codex-secondary-used-percent": "7",
            "x-codex-secondary-window-minutes": "10080",
            "x-codex-secondary-reset-at": at(120),
          },
        ],
      ] as const) {
        const chat = await context.newPage();
        const chatErrors = captureErrors(chat);
        const seeded = await chat.request.post(
          `${base}__browser-test/seed-provider-replay`,
          { data: { name, headers } },
        );
        const { agent } = await seeded.json();
        await chat.goto(`${base}#agent=${agent}`);
        await chat.locator("#input").fill("Public usage message.");
        await chat.locator("#send").click();
        await chat.getByText("RECORDED_PROVIDER_OK", { exact: true }).waitFor();
        await browserExpect(chat.locator("#send.stop")).toHaveCount(0);
        const status = await chat.request.post(
          `${base}__browser-test/provider-replay-status`,
          { data: { agent, close: true } },
        );
        expect(await status.json()).toEqual({ requests: 1, failures: [] });
        expect(chatErrors).toEqual([]);
        await chat.close();
      }
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.locator("#settings-btn").click();
      await page.locator('#settings-nav button[data-cat="auth"]').click();
      const time = String.raw`(?:\w{3} )?\d\d:\d\d`;
      for (const title of ["Claude", "OpenAI", "OpenRouter"]) {
        const section = page.getByRole("region", { name: title, exact: true });
        await browserExpect(section).toBeVisible();
        await browserExpect(
          section.getByRole("button", { name: "API key", exact: true }),
        ).toBeVisible();
        if (title !== "OpenRouter") {
          await browserExpect(
            section.getByRole("button", { name: /^Subscription/ }),
          ).toBeVisible();
          await browserExpect(
            section.getByRole("button", { name: "Log out", exact: true }),
          ).toBeVisible();
        }
      }
      await browserExpect(page.locator("dialog[open]")).toHaveCount(0);
      for (const width of [1280, 412]) {
        await page.setViewportSize({ width, height: 915 });
        for (const [title, left] of [
          ["Claude", ["38", "82"]],
          ["OpenAI", ["59", "93"]],
        ] as const) {
          await closeDetails(page);
          const provider = page.locator(
            `.provider[data-provider="${title.toLowerCase()}"]`,
          );
          const section = page.getByRole("region", {
            name: title,
            exact: true,
          });
          if (width === 412) {
            await browserExpect(section).toBeHidden();
            await provider
              .locator(":scope > .settings-detail > button.settings-row")
              .click();
            await browserExpect(
              page.getByRole("dialog", { name: title, exact: true }),
            ).toBeVisible();
          }
          await browserExpect(section.locator(".usage-name")).toHaveText([
            "5-hour",
            "Weekly",
          ]);
          await browserExpect(section.locator(".usage-text")).toHaveText(
            left.map(
              (percent) => new RegExp(`^${percent}% left, resets ${time}$`),
            ),
          );
          expect(
            await section
              .getByRole("progressbar")
              .evaluateAll((bars) =>
                bars.map((bar) => bar.getAttribute("aria-valuenow")),
              ),
          ).toEqual([...left]);
          await browserExpect(
            section.locator(".usage-limits .hint"),
          ).toHaveText(new RegExp(`^As of ${time}$`));
        }
      }
      await page
        .getByRole("button", { name: "Close OpenAI", exact: true })
        .click();
      await page
        .locator(
          '.provider[data-provider="claude"] > .settings-detail > button.settings-row',
        )
        .click();
      const claude = page.getByRole("region", { name: "Claude", exact: true });
      await claude
        .getByRole("button", { name: "API key", exact: true })
        .click();
      const key = claude.getByLabel("Anthropic API key");
      await key.fill("unsaved-test-key");
      await page.setViewportSize({ width: 1280, height: 915 });
      await browserExpect(page.locator("dialog[open]")).toHaveCount(0);
      await browserExpect(key).toBeVisible();
      await browserExpect(key).toHaveValue("unsaved-test-key");
      expect(errors).toEqual([]);
    } finally {
      for (const path of ["auth", "codex-auth"])
        await page.request.post(`${base}api/pi/${path}/logout`);
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["settings", tests]]);
