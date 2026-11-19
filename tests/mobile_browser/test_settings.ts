import { expect } from "bun:test";
import {
  captureErrors,
  gotoRoot,
  routeArtifacts,
  runBrowserTests,
  startServer,
  stopServer,
  visibleAndUncovered,
  LOGIN,
  type BrowserTest,
  openSettingsPanel,
  expectHitCorners,
} from "./common";
import { fontSize, openDetail, showCategory } from "./settings_support";
import { expect as browserExpect } from "playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRelease, releaseLabel } from "../../src/release";
import { generateTheme, themePalettes } from "../../src/themes";

export const tests: BrowserTest[] = [
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
    const labels = [
      "Providers",
      "Models",
      "Agents",
      "Appearance",
      "Remotes",
      "Account",
    ];
    await browserExpect(nav).toHaveText(labels);
    for (const button of await nav.all())
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await browserExpect(page.locator("#settings-sections")).toBeHidden();
    const version = page.locator("#settings-release .settings-version");
    await browserExpect(version).toBeVisible();
    await expectHitCorners(version, 2);
    await nav.getByText("Providers", { exact: true }).tap();
    const title = page.getByRole("heading", {
      name: "Providers",
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
      nav.getByText("Providers", { exact: true }),
    ).toBeVisible();
    await browserExpect(
      page.locator('#settings-nav [data-cat="providers"]'),
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
    await openSettingsPanel(page);
    await browserExpect(nav).toHaveText(labels);
    const models = page.locator('#settings-nav button[data-cat="models"]');
    await browserExpect(models).toBeFocused();
    await browserExpect(
      page.getByRole("heading", { name: "Models", exact: true }),
    ).toBeVisible();
    await showCategory(page, "remotes");
    await page.reload();
    await openSettingsPanel(page);
    await browserExpect(
      page.locator('#settings-nav button[data-cat="remotes"]'),
    ).toBeFocused();
    await openDetail(page, /^Add a remote/);
    await browserExpect(
      page.locator(".remote-add input").first(),
    ).toBeVisible();
    for (const input of await page.locator(".remote-add input:visible").all())
      expect((await input.boundingBox())!.height).toBeLessThanOrEqual(44);
    await page.addInitScript(() => {
      const storage = (globalThis as any).Storage.prototype;
      for (const name of ["getItem", "setItem"]) {
        const original = storage[name];
        storage[name] = function (key: string, ...rest: unknown[]) {
          if (key === "recurse.settingsCategory")
            throw new DOMException("Storage is denied", "SecurityError");
          return original.call(this, key, ...rest);
        };
      }
    });
    await page.reload();
    const providers = page.locator(
      '#settings-nav button[data-cat="providers"]',
    );
    await openSettingsPanel(page);
    await browserExpect(providers).toBeFocused();
    await showCategory(page, "appearance");
    await browserExpect(
      page.getByRole("heading", {
        name: "Appearance",
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await page.locator("#settings-close").click();
    await openSettingsPanel(page);
    await browserExpect(providers).toBeFocused();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #3540 a typed app name survives the settings load.
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
    expect(await page.locator("#brand-name").isVisible()).toBe(false);
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
      await page.getByRole("button", { name: /^Name and icon\b/ }).tap();
    };
    try {
      await gotoRoot(page, base);
      const originalTitle = await page.title();
      const originalIcon = await page
        .locator('link[rel="icon"]')
        .last()
        .getAttribute("href");
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route("**/api/settings/branding", async (route) => {
        if (route.request().method() === "GET") await held;
        await route.fallback();
      });
      await open();
      const section = page.locator(".settings-section").filter({
        has: page.getByRole("heading", {
          name: "Name and icon",
          exact: true,
        }),
      });
      const name = section.getByLabel("App name", { exact: true });
      const controls = section
        .locator("form.brand-settings")
        .locator("input,button");
      await browserExpect(controls).toHaveCount(5);
      for (const control of await controls.all())
        await browserExpect(control).toBeDisabled();
      release();
      await browserExpect(name).toBeEnabled();
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
      expect(
        await page.locator("#brand-name").getAttribute("hidden"),
      ).toBeNull();
      const manifest = await (
        await page.request.get(base + "manifest.webmanifest")
      ).json();
      expect(manifest.name).toBe(customName);
      const favicon = await page
        .locator('link[rel="icon"]')
        .last()
        .getAttribute("href");
      expect(favicon).toStartWith("/app-icon?v=");
      expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
        favicon,
      ]);
      for (const link of await page.locator('link[rel="icon"]').all())
        expect(await link.getAttribute("href")).toBe(favicon);
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
        await expectHitCorners(control);
      }
      await section.locator('[name="reset-name"]').tap();
      await section.getByRole("status").filter({ hasText: "Saved." }).waitFor();
      await section.locator('[name="reset-icon"]').tap();
      await section.getByRole("status").filter({ hasText: "Saved." }).waitFor();
      await page.reload();
      expect(await page.title()).toBe(originalTitle);
      expect(await page.locator("#brand-name").isVisible()).toBe(false);
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
    await openSettingsPanel(page);
    await page.locator("#settings-overlay.on").waitFor();
    const version = page.locator("#settings-release .settings-version");
    await browserExpect(version).toHaveText(
      `Recurse ${releaseLabel(await readRelease())}`,
    );
    await browserExpect(version).toBeVisible();
    await expectHitCorners(version, 2);
    await browserExpect(page.locator("#settings-nav button")).toHaveCount(6);
    await page.locator('#settings-nav button[data-cat="account"]').tap();
    expect(await page.locator("#settings-modal .signout").count()).toBe(0);
    expect(
      await page
        .getByRole("heading", {
          name: "Muse",
          exact: true,
          includeHidden: true,
        })
        .count(),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Change password", exact: true })
      .tap();
    const password = page.locator(
      '.settings-section input[type="password"]:visible',
    );
    expect(await password.first().evaluate(fontSize)).toBe("16px");
    expect((await password.first().boundingBox())!.height).toBe(44);
    await showCategory(page, "agents");
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
    const created = await context.request.post(`${base}api/conversations`, {
      data: {},
    });
    const other = String((await created.json()).id);
    await page.evaluate((cid) => {
      (globalThis as any).location.hash = `agent=${cid}`;
    }, other);
    await page.waitForURL(`**/#agent=${other}`);
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
      const open = async (category = "models") => {
        await page.locator(".agent").first().waitFor();
        await openSettingsPanel(page);
        await showCategory(page, category);
      };
      await gotoRoot(page, base);
      await open();
      const warming = page.getByRole("switch", {
        name: "Keep context cached while agents work",
        exact: true,
      });
      await browserExpect(warming).toBeEnabled();
      await browserExpect(warming).toBeChecked();
      const compacting = page.getByRole("switch", {
        name: "Compact long idle conversations before their cache expires",
        exact: true,
      });
      await browserExpect(compacting).toBeEnabled();
      await browserExpect(compacting).not.toBeChecked();
      for (const [control, hint] of [
        [
          warming,
          "Before the provider's cache expires, Recurse may resend the last request so the next reply can be faster and cheaper. Resends use tokens.",
        ],
        [
          compacting,
          "Older messages are summarized for the model; the thread keeps them.",
        ],
      ] as const) {
        await browserExpect(control).toHaveAccessibleDescription(hint);
        await browserExpect(control.locator("xpath=..")).toContainText(hint);
      }
      const minimum = page.getByRole("spinbutton", {
        name: "Minimum conversation length for idle compaction (tokens)",
      });
      await browserExpect(minimum).not.toBeVisible();
      await expectHitCorners(compacting.locator("xpath=.."));
      await compacting.check();
      await browserExpect(compacting).toBeEnabled();
      await browserExpect(minimum).toBeVisible();
      await browserExpect(minimum).toHaveValue("120000");
      await expectHitCorners(minimum, width === 412 ? 44 : 36);
      await minimum.fill("140000");
      await minimum.press("Tab");
      await browserExpect(minimum).toBeEnabled();
      await warming.uncheck();
      await browserExpect(warming).toBeEnabled();
      await page.reload({ waitUntil: "domcontentloaded" });
      await open();
      await browserExpect(warming).not.toBeChecked();
      await browserExpect(compacting).toBeChecked();
      await browserExpect(minimum).toHaveValue("140000");
      await minimum.fill("120000");
      await minimum.press("Tab");
      await browserExpect(minimum).toBeEnabled();
      await compacting.uncheck();
      await browserExpect(compacting).toBeEnabled();
      await browserExpect(minimum).not.toBeVisible();
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
      await browserExpect(maximum).toHaveValue(/./);
      const original = await maximum.inputValue();
      expect(await slider.inputValue()).toBe(original);
      for (const control of [slider, maximum]) {
        const bounds = (await control.boundingBox())!;
        await expectHitCorners(control, width === 412 ? 44 : 36);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      const card = maximum.locator("xpath=ancestor::form");
      expect(await card.getByRole("button").count()).toBe(0);
      const endpoint = "api/settings/maximum-context-window";
      const stored = async () => {
        const response = await page.request.get(base + endpoint);
        return (await response.json()).maximum_context_window;
      };
      const savedNote = card.getByText(
        "Saved. Applies when an agent process next starts.",
      );
      await page.evaluate((endpoint) => {
        const browser = globalThis as any;
        const trace: string[] = (browser.contextTrace = []);
        browser.addEventListener("pointerup", () => trace.push("release"), {
          once: true,
        });
        const send = browser.fetch;
        browser.fetch = async (input: unknown, init?: any) => {
          if (!String(input).endsWith(endpoint)) return send(input, init);
          const name =
            init?.method === "POST"
              ? `POST ${JSON.parse(init.body).maximum_context_window}`
              : "GET";
          trace.push(name);
          const response = await send(input, init);
          trace.push(`${name} done`);
          return response;
        };
      }, `/${endpoint}`);
      const trace = (): Promise<string[]> =>
        page.evaluate(() => (globalThis as any).contextTrace);
      const sent = (name: string) => [name, `${name} done`];
      const status = card.locator(".msg");
      const remount = async () => {
        await showCategory(page, "agents");
        await showCategory(page, "models");
        await openDetail(page, /^Maximum context window /);
      };
      const track = (await slider.boundingBox())!;
      const y = track.y + track.height / 2;
      await page.mouse.move(track.x + track.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(track.x + track.width * 0.75, y, { steps: 5 });
      const dragged = Number(await maximum.inputValue());
      expect(dragged).toBe(Number(await slider.inputValue()));
      await page.mouse.up();
      await savedNote.waitFor();
      expect(await trace()).toEqual(["release", ...sent(`POST ${dragged}`)]);
      expect(await stored()).toBe(dragged);
      const held: Array<() => void> = [];
      let holding = true;
      await page.route(`**/${endpoint}`, async (request) => {
        if (holding && request.request().method() === "POST")
          await new Promise<void>((resolve) => held.push(resolve));
        await request.continue();
      });
      const release = () => {
        holding = false;
        for (const resolve of held.splice(0)) resolve();
      };
      try {
        await maximum.fill("500123");
        expect(await slider.inputValue()).toBe("500123");
        await slider.focus();
        await browserExpect.poll(() => held.length).toBe(1);
        await slider.press("ArrowRight");
        expect(await maximum.inputValue()).toBe("500124");
        await browserExpect(slider).toBeFocused();
        await browserExpect(status).toHaveText("Saving…");
        held.shift()!();
        await browserExpect.poll(() => held.length).toBe(1);
        await browserExpect(status).toHaveText("Saving…");
        await remount();
        await browserExpect(slider).toBeDisabled();
        held.shift()!();
        await browserExpect(maximum).toHaveValue("500124");
        await browserExpect(slider).toBeEnabled();
        await slider.focus();
        await slider.press("ArrowRight");
        await browserExpect.poll(() => held.length).toBe(1);
        await maximum.fill("777777");
        release();
        await browserExpect.poll(stored).toBe(500125);
        await browserExpect(status).toHaveText("");
        expect(await maximum.inputValue()).toBe("777777");
      } finally {
        release();
        await page.unroute(`**/${endpoint}`);
      }
      await maximum.fill("500123");
      await maximum.press("Enter");
      await savedNote.waitFor();
      await browserExpect(maximum).toBeFocused();
      await maximum.fill("63999");
      await maximum.press("Enter");
      await browserExpect(maximum).toBeFocused();
      await browserExpect(maximum).toHaveJSProperty(
        "validationMessage",
        "Value must be greater than or equal to 64000.",
      );
      await browserExpect(status).toHaveText("");
      await remount();
      await browserExpect(maximum).toHaveValue("500123");
      await browserExpect(slider).toBeEnabled();
      expect(await trace()).toEqual([
        "release",
        ...[`POST ${dragged}`, "POST 500123", "POST 500124", "GET"].flatMap(
          sent,
        ),
        ...["POST 500125", "POST 500123", "GET"].flatMap(sent),
      ]);
      await page.reload({ waitUntil: "domcontentloaded" });
      await open();
      await openDetail(page, /^Maximum context window /);
      await browserExpect(maximum).toHaveValue("500123");
      expect(await slider.inputValue()).toBe("500123");
      await maximum.fill(original);
      await maximum.press("Tab");
      await browserExpect.poll(stored).toBe(Number(original));
      await savedNote.waitFor();
      await showCategory(page, "agents");
      await openDetail(page, /^Deleted agents' history /);
      const retention = page.getByRole("spinbutton", {
        name: "Keep deleted agents' history (days)",
      });
      await browserExpect(retention).toHaveValue(/./);
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
      await open("agents");
      await openDetail(page, /^Deleted agents' history /);
      await browserExpect(retention).toHaveValue("120");
      await retention.fill(kept);
      await history.getByRole("button", { name: "Save", exact: true }).click();
      await history
        .getByText("Saved. Applies during the next cleanup.")
        .waitFor();
      expect(errors).toEqual([]);
      await context.close();
    }
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
    const titles = page.locator("#shortcut-groups .shortcut-title");
    await shortcutGroup.waitFor();
    await titles.last().waitFor();
    await browserExpect(titles).toHaveText(
      [
        "When not typing",
        "While typing",
        "Agent actions",
        "Open pane",
        "Windows",
        "Resize",
      ],
      { useInnerText: true },
    );
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
      const customKeys = page.getByRole("heading", {
        name: "Custom model keys",
        exact: true,
      });
      await showCategory(page, "providers");
      await page
        .locator('.customkeys[aria-busy="false"]')
        .waitFor({ state: "attached" });
      await browserExpect(
        page.getByRole("button", { name: /^Claude / }),
      ).toBeVisible();
      await browserExpect(customKeys).toBeHidden();
      await writeFile(
        join(server.data, "data/config/model-providers.json"),
        JSON.stringify({
          providers: {
            "local-llm": {
              base_url: "http://127.0.0.1:9/v1",
              env_key: "LOCAL_LLM_KEY",
              wire_api: "completions",
              models: [{ id: "small" }],
            },
          },
        }),
      );
      await browserExpect
        .poll(async () =>
          Object.keys(
            await (
              await context.request.get(
                `${server.base}api/pi/custom-provider-auth`,
              )
            ).json(),
          ),
        )
        .toEqual(["local-llm"]);
      await showCategory(page, "providers");
      await browserExpect(customKeys).toBeVisible();
      await browserExpect(
        page.getByRole("button", { name: /^local-llm No key saved/ }),
      ).toBeVisible();
      const homes = page.locator(".remotes-settings .remote-incoming");
      const homesRead = homes.locator('.group[aria-busy="false"]');
      await showCategory(page, "remotes");
      await homesRead.waitFor({ state: "attached" });
      await browserExpect(homes).toBeHidden();
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
      await showCategory(page, "remotes");
      await browserExpect(homes.getByRole("button")).toHaveCount(2);
      const [titleBox, groupBox] = await Promise.all([
        page
          .getByRole("heading", { name: "Remotes", exact: true })
          .boundingBox(),
        homes.locator(".group").boundingBox(),
      ]);
      expect(Math.round(groupBox!.x)).toBe(Math.round(titleBox!.x));
      expect(groupBox!.x + groupBox!.width).toBeLessThanOrEqual(390);
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
        const reread = page.waitForResponse(
          (response) =>
            response.request().method() === "GET" &&
            response.url().endsWith("/api/backend-keys"),
        );
        await details
          .getByRole("button", { name: "Revoke access", exact: true })
          .tap();
        await browserExpect(details).toHaveCount(0);
        await reread;
        await homesRead.waitFor({ state: "attached" });
      }
      await browserExpect(homes).toBeHidden();
      await browserExpect(
        page.getByRole("button", { name: "Add a remote", exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await stopServer(server);
    }
  },
];
if (import.meta.main) await runBrowserTests([["settings", tests]]);
