import { expect } from "bun:test";
import {
  getBuiltinClassifierModels,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
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
  startNewAgent,
  expectHitCorners,
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
  id: "anthropic/test-sonnet",
  label: "Claude Sonnet 5",
  route: "Claude",
  context_window: 1_000_000,
  reasoning_levels: null,
};
const LIST_SOL = {
  id: "openai-codex/test-sol",
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
  options: { levels: LadderEntry[]; list: object[]; defaultLevel?: number },
) {
  const levels = Object.fromEntries(
    options.levels.map((entry, i) => [String(i + 1), entry]),
  );
  const listed = new Set(
    options.list.map((model) => (model as { id: string }).id),
  );
  const ladder = {
    default_level: options.defaultLevel ?? 3,
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
    get models() {
      return [
        ...new Set(Object.values(levels).map((entry) => entry.model)),
      ].map((id) => ({ id, label: id, context_window: null }));
    },
    reasoning: ALL_LEVELS,
  };
  const holds: Record<string, Promise<void> | undefined> = {};
  let failure: string | null = null;
  const events: string[] = [];
  const saved: {
    default_level: number;
    levels: Record<string, LadderEntry>;
  }[] = [];
  await page.route(`${base}api/settings/effort-levels`, async (route) => {
    if (route.request().method() === "POST" && failure)
      return route.fulfill({ status: 500, json: { detail: failure } });
    if (route.request().method() === "POST") {
      events.push("POST");
      const body = route.request().postDataJSON();
      saved.push(body);
      await holds.POST;
      Object.assign(levels, body.levels);
    } else {
      events.push("GET");
      await holds.GET;
    }
    return route.fulfill({ json: ladder });
  });
  await page.route(`${base}api/settings/model-list`, (route) => {
    events.push("LIST");
    return route.fulfill({
      json: { models: options.list, reasoning: ALL_LEVELS },
    });
  });
  return {
    saved,
    levels,
    events,
    ladderReads: () => events.filter((event) => event === "GET").length,
    listReads: () => events.filter((event) => event === "LIST").length,
    failSaves(detail: string | null) {
      failure = detail;
    },
    hold(method: "GET" | "POST") {
      const { promise, resolve } = Promise.withResolvers<void>();
      holds[method] = promise;
      return () => {
        if (method === "POST") events.push("released");
        holds[method] = undefined;
        resolve();
      };
    },
  };
}

async function listCapacity(listbox: Locator): Promise<number> {
  return listbox.evaluate((el) => {
    const max = parseFloat((globalThis as any).getComputedStyle(el).maxHeight);
    const row = (el as any).querySelector("[role=option]").offsetHeight;
    return Math.floor(max / row);
  });
}

async function openLadderSettings(page: Page): Promise<void> {
  await page.locator(".agent").first().waitFor({ state: "attached" });
  await openSettingsPanel(page);
  await page.locator('#settings-nav button[data-cat="models"]').click();
}

function effortLevels(page: Page): Locator {
  return page.locator(".settings-section").filter({
    has: page.getByRole("heading", { name: "Effort levels", exact: true }),
  });
}

function effortLevel(page: Page, level: number) {
  const name = new RegExp(`^Level ${level} `);
  const row = effortLevels(page)
    .locator(".row.effort")
    .filter({ has: page.getByRole("button", { name }) });
  return {
    row,
    model: row.getByRole("button", { name }),
    reasoning: row.getByRole("slider", {
      name: `Reasoning for level ${level}`,
      exact: true,
    }),
  };
}

const LEVEL_ONE_HELP =
  "Used for conversation names and, by default, safety review; choose an inexpensive model such as Luna or Haiku.";

async function openDetail(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name }).click();
}

async function closeDetails(page: Page): Promise<void> {
  const sheets = page.locator("dialog.settings-sheet[open]");
  const name =
    page.viewportSize()!.width <= 700 ? /^Close / : /^(Close|Back to) /;
  while (await sheets.count())
    await sheets.last().getByRole("button", { name }).click();
}

const expectModalSheet = (page: Page, name: string) =>
  browserExpect(page.locator("dialog:modal")).toHaveAccessibleName(name);

async function openLevel(page: Page, level: number): Promise<void> {
  await closeDetails(page);
  await effortLevel(page, level).model.click();
  await expectModalSheet(page, `Level ${level}`);
  await browserExpect(
    page.getByRole("combobox", { name: `Model for level ${level}` }),
  ).toBeFocused();
}

async function expectLevelOneHelp(page: Page): Promise<void> {
  await browserExpect(
    effortLevels(page).getByText(LEVEL_ONE_HELP, { exact: true }),
  ).toBeVisible();
}

async function showCategory(page: Page, cat: string): Promise<void> {
  await closeDetails(page);
  const back = page.locator(".settings-cat:not([hidden]) .settings-back");
  if (await back.isVisible()) await back.click();
  await page.locator(`#settings-nav button[data-cat="${cat}"]`).click();
}

async function expectLadderSaves(
  page: Page,
  saved: unknown[],
  count: number,
): Promise<void> {
  await browserExpect.poll(() => saved.length).toBe(count);
  await browserExpect(
    effortLevels(page).getByText(
      "Saved. Applies to new agents and agents whose level is chosen again.",
      { exact: true },
    ),
  ).toBeVisible();
}

const subscriptionToken = () => ({
  access_token: `h.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct" },
    }),
  ).toString("base64url")}.s`,
  refresh_token: "sk-test-cref",
  expires_in: 7200,
});

export const tests: BrowserTest[] = [
  // Feature: #3396 the safety model choice persists through Settings reloads.
  async function test_safety_review_model_choice(browser, _base) {
    const server = await startServer();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 915 },
      hasTouch: true,
    });
    const errors = captureErrors(page);
    const endpoint = `${server.base}api/settings/safety-review-model`;
    const luna = getBuiltinModels("openai-codex").find(
      (model) => model.name === "GPT-6 Luna",
    )!;
    const decisions = getBuiltinClassifierModels("openai").find(
      (model) => model.id === luna.id,
    )!;
    const jev = getBuiltinClassifierModels("openrouter").find(
      (model) => model.name === "TypeSafe: Jev 1.14",
    )!;
    const jevId = `${jev.provider}/${jev.id}`;
    const jevLabel = `${jev.name} · classifier`;
    const decisionsId = `${decisions.provider}/${decisions.id}`;
    const decisionsLabel = `${decisions.name} · classifier`;
    const lunaId = `${luna.provider}/${luna.id}`;
    const readChoice = async () => {
      const response = await page.request.get(endpoint);
      expect(response.ok()).toBe(true);
      return response.json();
    };
    const ladder = effortLevels(page);
    const row = (label: string, route = "") =>
      ladder.getByRole("button", {
        name: `Safety review ${label}${route && ` ${route}`}`,
        exact: true,
      });
    const finder = page.getByRole("dialog", {
      name: "Safety review",
      exact: true,
    });
    const search = finder.getByRole("combobox", {
      name: "Safety review model",
    });
    const defaultOption = finder.getByRole("option", {
      name: "Same as level 1",
      exact: true,
    });
    const savedStatus = ladder
      .getByRole("status")
      .and(page.getByText("Saved. Applies to the next run.", { exact: true }));
    const posts: unknown[] = [];
    page.on("request", (request) => {
      if (request.url() === endpoint && request.method() === "POST")
        posts.push(request.postDataJSON());
    });
    const saveChoice = async (
      pick: () => Promise<void>,
      model: string | null,
    ) => {
      const saved = page.waitForResponse(
        (response) =>
          response.url() === endpoint && response.request().method() === "POST",
      );
      await pick();
      const response = await saved;
      expect(response.ok()).toBe(true);
      expect(response.request().postDataJSON()).toEqual({ model });
      await browserExpect(savedStatus).toBeVisible();
    };
    const savePlatformKey = async () => {
      const response = await page.request.post(
        `${server.base}api/pi/codex-auth/api-key`,
        { data: { key: "browser-test-decisions-key" } },
      );
      expect(response.ok()).toBeTrue();
    };
    try {
      await gotoRoot(page, server.base);
      await writeFile(
        join(server.data, "settings", "pi-agent", "auth.json"),
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "test-access",
            refresh: "test-refresh",
            expires: Date.now() + 3600_000,
            accountId: "test-subscription",
          },
        }),
        { mode: 0o600 },
      );
      expect(
        (
          await page.request.post(
            `${server.base}api/pi/openrouter-auth/api-key`,
            {
              data: { key: "browser-test-safety-model" },
            },
          )
        ).ok(),
      ).toBe(true);
      await savePlatformKey();
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      await openLadderSettings(page);
      const settings = page.locator("#settings-modal");
      await browserExpect(
        settings.getByRole("button", { name: "Safety", exact: true }),
      ).toHaveCount(0);
      await row("Same as level 1").click();
      await expectModalSheet(page, "Safety review");
      await browserExpect(search).toHaveAttribute("aria-expanded", "true");
      await browserExpect(defaultOption).toBeVisible();
      const benchmarkText =
        /\d+\s*\/\s*\d+ correct|Not tested|has allowed risky actions in testing/i;
      await browserExpect(settings).not.toContainText(benchmarkText);
      await search.press("Enter");
      await browserExpect(finder).toBeHidden();
      expect(posts).toEqual([]);
      await row("Same as level 1").click();
      await search.fill("jv114");
      await browserExpect(defaultOption).toHaveCount(0);
      const classifier = finder
        .getByRole("group", { name: "OpenRouter", exact: true })
        .getByRole("option", { name: jevLabel, exact: true });
      await browserExpect(classifier).toBeVisible();
      await browserExpect(classifier).not.toContainText(benchmarkText);
      await saveChoice(() => classifier.click(), jevId);
      await browserExpect(row(jevLabel, "OpenRouter")).toBeVisible();
      await browserExpect(settings).not.toContainText(benchmarkText);
      await page.reload();
      await openLadderSettings(page);
      expect((await readChoice()).model).toBe(jevId);
      await openLevel(page, 1);
      const effort = page.getByRole("dialog", { name: "Level 1", exact: true });
      await effort.getByRole("combobox").fill("gpt-6 luna");
      for (const route of ["ChatGPT subscription", "OpenAI API key"]) {
        const group = effort.getByRole("group", { name: route, exact: true });
        await browserExpect(
          group.getByText(route, { exact: true }),
        ).toBeVisible();
        await browserExpect(
          group.getByRole("option", { name: luna.name, exact: true }),
        ).toBeVisible();
      }
      await closeDetails(page);
      await row(jevLabel, "OpenRouter").click();
      await browserExpect(settings).not.toContainText(benchmarkText);
      await search.fill("gpt-6 luna");
      const subscription = finder
        .getByRole("group", { name: "ChatGPT subscription", exact: true })
        .getByRole("option", { name: luna.name, exact: true });
      const apiGroup = finder.getByRole("group", {
        name: "OpenAI API key",
        exact: true,
      });
      const sharedId = finder
        .getByRole("option")
        .and(finder.locator(`[data-id="${decisionsId}"]`));
      const apiKey = sharedId.and(
        apiGroup.getByRole("option", {
          name: decisionsLabel,
          exact: true,
        }),
      );
      const expectBothRoutes = async () => {
        for (const route of ["ChatGPT subscription", "OpenAI API key"])
          await browserExpect(
            finder.getByText(route, { exact: true }),
          ).toBeVisible();
        await browserExpect(subscription).toBeVisible();
        await browserExpect(sharedId).toHaveCount(1);
        await browserExpect(apiKey).toBeVisible();
      };
      await expectBothRoutes();
      if (shots)
        await page.screenshot({ path: `${shots}/openai-finder-1280.png` });
      await saveChoice(() => apiKey.click(), decisionsId);
      await browserExpect(
        row(decisionsLabel, "OpenAI API key").getByText("OpenAI API key", {
          exact: true,
        }),
      ).toBeVisible();
      expect(
        (
          await page.request.post(
            `${server.base}api/pi/codex-auth/api-key/remove`,
          )
        ).ok(),
      ).toBeTrue();
      await page.reload();
      await openLadderSettings(page);
      const unavailable = row(`${decisionsId} (unavailable)`, "OpenAI API key");
      await browserExpect(
        unavailable.getByText("OpenAI API key", { exact: true }),
      ).toBeVisible();
      await unavailable.click();
      await search.fill("gpt-6 luna");
      await browserExpect(
        finder.getByText("ChatGPT subscription", { exact: true }),
      ).toBeVisible();
      await browserExpect(subscription).toBeVisible();
      await browserExpect(apiGroup).toHaveCount(0);
      await saveChoice(() => subscription.click(), lunaId);
      await savePlatformKey();
      const lunaRow = row(luna.name, "ChatGPT subscription");
      await browserExpect(lunaRow).toBeVisible();
      await browserExpect(settings).not.toContainText(benchmarkText);
      await page.setViewportSize({ width: 412, height: 915 });
      await page.goto("about:blank");
      await gotoRoot(page, server.base);
      await openLadderSettings(page);
      expect((await readChoice()).model).toBe(lunaId);
      for (const chosen of [lunaRow, effortLevel(page, 1).model])
        await browserExpect(
          chosen.getByText("ChatGPT subscription", { exact: true }),
        ).toBeVisible();
      await browserExpect(effortLevel(page, 1).model).toHaveAccessibleName(
        `Level 1 ${luna.name} ChatGPT subscription`,
      );
      await openLevel(page, 1);
      await closeDetails(page);
      await expectHitCorners(lunaRow);
      await lunaRow.tap();
      await expectModalSheet(page, "Safety review");
      await browserExpect(settings).not.toContainText(benchmarkText);
      await expectHitCorners(search);
      await expectHitCorners(defaultOption);
      await search.fill("gpt-6 luna");
      await expectBothRoutes();
      if (shots)
        await page.screenshot({ path: `${shots}/openai-finder-412.png` });
      await search.fill("jv114");
      await page.setViewportSize({ width: 1280, height: 915 });
      await browserExpect(search).toHaveValue("jv114");
      await browserExpect(search).toBeFocused();
      await expectModalSheet(page, "Safety review");
      await finder
        .getByRole("button", { name: "Close Safety review", exact: true })
        .click();
      await browserExpect(finder).toBeHidden();
      await lunaRow.click();
      await browserExpect(search).toHaveAttribute("aria-expanded", "true");
      await page.setViewportSize({ width: 412, height: 915 });
      await writeFile(
        join(server.data, "data", "config", "safety-review-model.json"),
        JSON.stringify({ model: "" }),
      );
      await browserExpect
        .poll(async () => (await readChoice()).invalid)
        .toBe(true);
      await page.reload();
      await openLadderSettings(page);
      await row("Invalid saved choice").tap();
      await browserExpect(
        finder.getByText("Choose a model to restore safety review.", {
          exact: true,
        }),
      ).toBeVisible();
      await saveChoice(() => defaultOption.tap(), null);
      await browserExpect(row("Same as level 1")).toBeVisible();
      expect(await readChoice()).toMatchObject({ model: null, invalid: false });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await stopServer(server);
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
  // Regression: #3344 Keep ladder metadata aligned with changed levels.
  async function test_settings_model_list_update_keeps_saved_ladder_picks(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const entry = { model: LIST_OPUS.id, reasoning: "high" };
    const fresh = { model: LIST_FRESH.id, reasoning: "high" };
    const fillers = Array.from({ length: 60 }, (_, i) => ({
      ...LIST_FRESH,
      id: `openrouter/vendor/filler-${i + 1}`,
      label: `Filler ${i + 1}`,
    }));
    const routes = await routeLadder(page, base, {
      levels: [entry, entry, entry, entry, entry],
      list: [LIST_OPUS, { ...LIST_FRESH, reasoning_levels: null }, ...fillers],
    });
    const unread = {
      updating: false,
      updated_at: null,
      count: null,
      error: null,
    };
    const updating = { ...unread, updating: true };
    const failed = {
      ...unread,
      count: 449,
      error:
        "openrouter: Unable to connect. Is the computer able to access the url?",
    };
    let status: object = unread;
    let posts = 0;
    await page.route(`${base}api/settings/model-list-update`, (route) => {
      if (route.request().method() === "POST") {
        posts++;
        status = updating;
        return route.fulfill({ status: 202, json: updating });
      }
      return route.fulfill({ json: status });
    });
    const ladderUrl = `${base}api/settings/effort-levels`;
    const composerRead = Promise.withResolvers<void>();
    let holdComposer = false;
    await page.route(ladderUrl, async (route) => {
      if (route.request().method() === "GET" && holdComposer) {
        holdComposer = false;
        await composerRead.promise;
      }
      return route.fallback();
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await startNewAgent(page);
    await openLadderSettings(page);
    const line = page.locator(".model-list-status");
    const level = (n: number) => effortLevel(page, n).model;
    const reasoning = (n: number) => effortLevel(page, n).reasoning;
    await browserExpect(line).toHaveText(
      "The model list has not been read yet.",
    );
    await browserExpect(line).toBeVisible();
    await browserExpect(level(2)).toHaveAccessibleName(
      `Level 2 ${LIST_OPUS.label} ${LIST_OPUS.route}`,
    );
    await browserExpect(
      effortLevels(page).getByRole("button", { name: "Save", exact: true }),
    ).toHaveCount(0);
    const readsBefore = routes.ladderReads();
    await openLevel(page, 2);
    const box = page.getByRole("combobox", { name: "Model for level 2" });
    await box.fill("fresh");
    holdComposer = true;
    const composerAsked = page.waitForRequest(
      (request) => request.url() === ladderUrl && request.method() === "GET",
    );
    await box.press("Enter");
    const composerRequest = await composerAsked;
    await expectLadderSaves(page, routes.saved, 1);
    const freshName = `Level 2 ${LIST_FRESH.label} ${LIST_FRESH.route}`;
    await browserExpect(level(2)).toHaveAccessibleName(freshName);
    await openLevel(page, 2);
    const listbox = page.getByRole("listbox", { name: "Model for level 2" });
    await browserExpect(listbox.getByRole("option")).toHaveCount(50);
    await browserExpect(listbox.locator(".model-box-group-head")).toHaveText([
      /^Claude\s*1$/,
      /^OpenRouter\s*49 of 61$/,
    ]);
    const chosen = `.model-box-option[data-id="${LIST_FRESH.id}"]`;
    await browserExpect(listbox.locator(chosen)).toHaveAccessibleDescription(
      "Current model",
    );
    await browserExpect(listbox.locator(chosen)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await visibleAndUncovered(page, `${chosen}:visible`);
    await closeDetails(page);
    const sonnet = { model: LIST_SONNET.id, reasoning: "low" };
    routes.levels["3"] = sonnet;
    composerRead.resolve();
    await (await composerRequest.response())!.finished();
    await browserExpect(page.locator("#model-trigger")).toContainText(
      LIST_SONNET.id,
    );
    const refreshedList = page.waitForResponse(
      `${base}api/settings/model-list`,
    );
    const update = page.getByRole("button", { name: /^Update model list/ });
    await update.click();
    await browserExpect(line).toHaveText("Updating the model list…");
    await browserExpect(line).toBeVisible();
    status = failed;
    await browserExpect(line).toHaveText(
      "Could not update: openrouter: Unable to connect. Is the computer able to access the url? Using the current list.",
    );
    await browserExpect(line).toBeVisible();
    await browserExpect(line).toHaveClass(/\berr\b/);
    expect(posts).toBe(1);
    await (await refreshedList).finished();
    await browserExpect(level(3)).toHaveAccessibleName(
      `Level 3 ${LIST_SONNET.id}`,
    );
    await browserExpect(reasoning(3)).toHaveAttribute("aria-valuetext", "low");
    expect(routes.listReads()).toBe(2);
    expect(routes.ladderReads()).toBeGreaterThan(readsBefore);
    await browserExpect(level(2)).toHaveAccessibleName(freshName);
    await browserExpect(update).toBeEnabled();
    expect(routes.saved).toEqual([
      {
        default_level: 3,
        levels: { "1": entry, "2": fresh, "3": entry, "4": entry, "5": entry },
      },
    ]);
    routes.failSaves("Disk is full.");
    const failure = effortLevels(page).getByText("Disk is full.", {
      exact: true,
    });
    await reasoning(4).press("ArrowRight");
    await browserExpect(failure).toBeVisible();
    await browserExpect(reasoning(4)).toHaveAttribute(
      "aria-valuetext",
      "xhigh",
    );
    expect(routes.levels["4"]).toEqual(entry);
    const elsewhere = { model: LIST_SONNET.id, reasoning: "max" };
    routes.levels["5"] = elsewhere;
    const reloaded = page.waitForResponse(`${base}api/settings/model-list`);
    await update.click();
    await browserExpect(line).toHaveText("Updating the model list…");
    status = failed;
    await (await reloaded).finished();
    await browserExpect(level(5)).toHaveAccessibleName(
      `Level 5 ${LIST_SONNET.id}`,
    );
    await browserExpect(reasoning(4)).toHaveAttribute(
      "aria-valuetext",
      "xhigh",
    );
    await browserExpect(failure).toBeVisible();
    routes.failSaves(null);
    const retry = effortLevels(page).getByRole("button", {
      name: "Retry",
      exact: true,
    });
    const discard = effortLevels(page).getByRole("button", {
      name: "Discard changes",
      exact: true,
    });
    await retry.click();
    await expectLadderSaves(page, routes.saved, 2);
    await browserExpect(retry).toBeHidden();
    const retried = {
      "1": entry,
      "2": fresh,
      "3": sonnet,
      "4": { ...entry, reasoning: "xhigh" },
      "5": elsewhere,
    };
    expect(routes.saved[1]).toEqual({ default_level: 3, levels: retried });
    routes.failSaves("Disk is full.");
    await reasoning(4).press("ArrowRight");
    await browserExpect(failure).toBeVisible();
    await browserExpect(reasoning(4)).toHaveAttribute("aria-valuetext", "max");
    routes.failSaves(null);
    const releaseReads = routes.hold("GET");
    await discard.click();
    for (const cleared of [failure, retry, discard])
      await browserExpect(cleared).toBeHidden();
    await browserExpect(reasoning(4)).toHaveAttribute(
      "aria-valuetext",
      "xhigh",
    );
    await reasoning(1).evaluate((el) => el.setAttribute("data-stale", ""));
    releaseReads();
    await browserExpect(
      effortLevel(page, 1).row.locator("[data-stale]"),
    ).toHaveCount(0);
    await reasoning(1).press("ArrowLeft");
    await expectLadderSaves(page, routes.saved, 3);
    expect(routes.saved[2]!.levels).toEqual({
      ...retried,
      "1": { ...entry, reasoning: "medium" },
    });
    const release = routes.hold("POST");
    await reasoning(1).press("ArrowLeft");
    await browserExpect.poll(() => routes.saved.length).toBe(4);
    await reasoning(4).press("ArrowLeft");
    status = { ...failed, error: null };
    const remounted = Promise.all([
      page.waitForRequest(`${base}api/settings/model-list-update`),
      page.waitForRequest(`${base}api/settings/safety-review-model`),
    ]);
    await page.locator('#settings-nav button[data-cat="providers"]').click();
    await page.locator('#settings-nav button[data-cat="models"]').click();
    await remounted;
    await browserExpect(line).toHaveText("449 models in the current list.");
    await browserExpect(line).toBeVisible();
    await browserExpect(line).not.toHaveClass(/\berr\b/);
    release();
    await browserExpect(reasoning(1)).toHaveAttribute("aria-valuetext", "low");
    await browserExpect(reasoning(4)).toHaveAttribute("aria-valuetext", "high");
    const low = { ...retried, "1": { ...entry, reasoning: "low" } };
    expect(routes.saved.slice(3)).toEqual([
      { default_level: 3, levels: low },
      { default_level: 3, levels: { ...low, "4": entry } },
    ]);
    const afterRelease = routes.events
      .slice(routes.events.indexOf("released"))
      .filter((event) => event !== "GET");
    expect(afterRelease.slice(0, 3)).toEqual(["released", "POST", "LIST"]);
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
    const opus = { model: LIST_OPUS.id, reasoning: "high" };
    const gone = { model: "anthropic/test-gone", reasoning: "minimal" };
    const offOpus = { model: LIST_OPUS.id, reasoning: "off" };
    const listRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/settings/model-list"))
        listRequests.push(request.url());
    });
    const routes = await routeLadder(page, base, {
      levels: [gone, offOpus, opus, opus, opus],
      list: [LIST_OPUS, LIST_SONNET, LIST_SOL, LIST_FRESH],
      defaultLevel: 4,
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    expect(listRequests).toEqual([]);
    await page.locator("#settings-btn").click();
    await page.locator('#settings-nav button[data-cat="models"]').click();
    const box = (level: number) =>
      page.locator(`input[aria-label="Model for level ${level}"]`);
    const reasoning = (level: number) => effortLevel(page, level).reasoning;
    await expectLevelOneHelp(page);
    await browserExpect(
      effortLevels(page).getByText("New agents start at level 4."),
    ).toBeVisible();
    await openLevel(page, 1);
    expect(routes.listReads()).toBe(1);
    expect(await box(1).getAttribute("placeholder")).toBe(gone.model);
    await browserExpect(box(1)).toHaveAttribute("aria-expanded", "true");
    await page
      .getByText(`level 1 model ${gone.model} is not in Pi's model list`)
      .waitFor();
    await closeDetails(page);
    await browserExpect(reasoning(2)).toHaveAttribute(
      "aria-valuetext",
      "off, not offered for this model",
    );
    await browserExpect(
      effortLevels(page).getByText("off is not offered for this model.", {
        exact: true,
      }),
    ).toBeVisible();
    await openLevel(page, 3);
    const listbox = page.getByRole("listbox", { name: "Model for level 3" });
    expect(await listbox.getByRole("option").count()).toBe(4);
    expect(await listCapacity(listbox)).toBeGreaterThanOrEqual(6);
    const activeId = await box(3).getAttribute("aria-activedescendant");
    expect(
      await page.locator(`[id="${activeId}"]`).getAttribute("data-id"),
    ).toBe(LIST_OPUS.id);
    await browserExpect(listbox.locator(".model-box-group-head")).toHaveText([
      /^Claude\s*2$/,
      /^ChatGPT subscription\s*1$/,
      /^OpenRouter\s*1$/,
    ]);
    const current = listbox
      .getByRole("group", { name: LIST_OPUS.route, exact: true })
      .getByRole("option", { name: LIST_OPUS.label, exact: true });
    const sol = listbox
      .getByRole("group", { name: LIST_SOL.route, exact: true })
      .getByRole("option", { name: LIST_SOL.label, exact: true });
    const expectOneCurrent = async () => {
      await browserExpect(listbox.getByRole("option")).toHaveText(
        [
          `${LIST_OPUS.label}\n✓`,
          LIST_SONNET.label,
          LIST_SOL.label,
          LIST_FRESH.label,
        ],
        { useInnerText: true },
      );
      await browserExpect(listbox.locator(".model-box-current")).toHaveCount(1);
      await browserExpect(current.locator(".model-box-current")).toBeVisible();
      await browserExpect(current).toHaveAccessibleDescription("Current model");
    };
    await expectOneCurrent();
    await box(3).press("ArrowDown");
    await box(3).press("ArrowDown");
    const crossed = await box(3).getAttribute("aria-activedescendant");
    await browserExpect(sol).toHaveAttribute("id", crossed!);
    await visibleAndUncovered(
      page,
      `.model-box-option[data-id="${LIST_SOL.id}"]:visible`,
    );
    await expectOneCurrent();
    await browserExpect(sol).toHaveAccessibleDescription(LIST_SOL.id);
    await box(3).fill("gpt");
    expect(
      await listbox
        .getByRole("option")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-id"))),
    ).toEqual([LIST_SOL.id]);
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
    await browserExpect(reasoning(3)).toHaveAttribute("aria-valuetext", "off");
    await browserExpect(reasoning(3)).toBeDisabled();
    await expectLadderSaves(page, routes.saved, 1);
    await openLevel(page, 4);
    await box(4).fill("claude");
    await box(4).press("ArrowDown");
    await box(4).press("Enter");
    expect(await box(4).inputValue()).toBe("Claude Sonnet 5");
    await browserExpect(reasoning(4)).toHaveAttribute("max", "6");
    await browserExpect(reasoning(4)).toHaveAttribute("aria-valuetext", "high");
    await expectLadderSaves(page, routes.saved, 2);
    await openLevel(page, 5);
    await box(5).fill("gpt");
    await box(5).press("Enter");
    await browserExpect(reasoning(5)).toHaveAttribute("aria-valuetext", "high");
    await expectLadderSaves(page, routes.saved, 3);
    await reasoning(5).press("ArrowRight");
    await browserExpect(reasoning(5)).toHaveAttribute(
      "aria-valuetext",
      "xhigh",
    );
    await expectLadderSaves(page, routes.saved, 4);
    let levels = { "1": gone, "2": offOpus, "3": opus, "4": opus, "5": opus };
    const payloads = [
      { "3": { model: LIST_FRESH.id, reasoning: "off" } },
      { "4": { model: LIST_SONNET.id, reasoning: "high" } },
      { "5": { model: LIST_SOL.id, reasoning: "high" } },
      { "5": { model: LIST_SOL.id, reasoning: "xhigh" } },
    ].map((change) => ({
      default_level: 4,
      levels: (levels = { ...levels, ...change }),
    }));
    expect(routes.saved).toEqual(payloads);
    const announced = [await reasoning(2).getAttribute("aria-valuetext")];
    for (let step = 0; step < 5; step++) {
      await reasoning(2).press("ArrowRight");
      announced.push(await reasoning(2).getAttribute("aria-valuetext"));
    }
    expect(announced).toEqual([
      "off, not offered for this model",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    await reasoning(2).press("Home");
    await browserExpect(reasoning(2)).toHaveAttribute(
      "aria-valuetext",
      "off, not offered for this model",
    );
    await expectLadderSaves(page, routes.saved, 10);
    expect(routes.saved.at(-1)).toEqual(payloads[3]);
    await openLevel(page, 1);
    await box(1).press("Escape");
    await browserExpect(box(1)).toHaveAttribute("aria-expanded", "false");
    await browserExpect(
      page.getByRole("region", { name: "Level 1", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await browserExpect(
      page.getByRole("region", { name: "Level 1", exact: true }),
    ).toBeHidden();
    expect(await page.locator("#settings-overlay.on").count()).toBe(1);
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
    const opus = { model: LIST_OPUS.id, reasoning: "high" };
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
    await expectLevelOneHelp(page);
    const two = effortLevel(page, 2);
    await browserExpect(two.model).toHaveAccessibleName(
      `Level 2 ${LIST_OPUS.label} ${LIST_OPUS.route}`,
    );
    await browserExpect(
      two.row.getByText("Reasoning", { exact: true }),
    ).toBeVisible();
    await expectHitCorners(two.reasoning);
    await browserExpect(two.reasoning).toBeInViewport({ ratio: 1 });
    await expectHitCorners(two.model);
    await two.model.tap();
    const sheet = page.getByRole("region", { name: "Level 2", exact: true });
    const box = sheet.getByRole("combobox", { name: "Model for level 2" });
    await box.waitFor();
    const bounds = (await box.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(await box.evaluate(fontSize)).toBe("16px");
    expect(await box.getAttribute("autocapitalize")).toBe("off");
    expect(await box.getAttribute("autocorrect")).toBe("off");
    await box.tap();
    await page.keyboard.type("fre");
    const listbox = page.getByRole("listbox", { name: "Model for level 2" });
    const freshRow = `.model-box-option[data-id="${LIST_FRESH.id}"]`;
    const option = listbox.locator(freshRow);
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
    await visibleAndUncovered(page, `${freshRow}:visible`);
    await option.tap();
    await browserExpect(two.model).toHaveAccessibleName(
      `Level 2 ${LIST_FRESH.label} ${LIST_FRESH.route}`,
    );
    await browserExpect(
      two.model.getByText(LIST_FRESH.route, { exact: true }),
    ).toBeVisible();
    await browserExpect(two.reasoning).toHaveAttribute("aria-valuetext", "off");
    await expectLadderSaves(page, routes.saved, 1);
    expect(routes.saved[0]!.levels["2"]).toEqual({
      model: LIST_FRESH.id,
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
    await page.route(`${base}api/settings/effort-levels`, async (route) => {
      const response = await route.fetch();
      return route.fulfill({
        json: { ...(await response.json()), models: [] },
      });
    });
    const outside = {
      id: "fauxordinary/outside-ladder",
      label: "Model from the list",
      route: "Test",
      context_window: null,
      reasoning_levels: null,
    };
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const started = page.waitForRequest(`${base}api/settings/model-list`);
    await page.route(`${base}api/settings/model-list`, async (route) => {
      await gate;
      return route.fulfill({
        json: { models: [outside], reasoning: ALL_LEVELS },
      });
    });
    expect(
      (
        await page.request.post(
          `${base}__browser-test/seed-model-selection-error`,
          {
            data: { agent: "model-name-outside", model: outside.id },
          },
        )
      ).ok(),
    ).toBeTrue();
    try {
      await page.goto(`${base}#agent=model-name-outside`);
      await page
        .locator('.agent.selected[data-id="model-name-outside"]')
        .waitFor({ state: "attached" });
      await started;
      const model = page.locator("#model-trigger .model-name");
      await browserExpect(model).toBeVisible();
      await browserExpect(model).toHaveText("Effort");
      const width = await model.evaluate(
        (node) => node.getBoundingClientRect().width,
      );
      release();
      await browserExpect(model).toHaveText(outside.label);
      expect(
        await model.evaluate((node) => node.getBoundingClientRect().width),
      ).toBe(width);
      expect(errors).toEqual([]);
    } finally {
      release();
      await closeWithRoutes(context);
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
      await page.locator('#settings-nav button[data-cat="providers"]').tap();
      const signIn = async (title: string, name: string) => {
        await closeDetails(page);
        await page
          .locator(
            `.provider[data-provider="${title.toLowerCase()}"] > .settings-detail > button.settings-row`,
          )
          .tap();
        const section = page.getByRole("region", { name: title, exact: true });
        const isClaude = title === "Claude";
        const card = (heading: string) =>
          section.locator("section").filter({
            has: page.getByRole("heading", { name: heading, exact: true }),
          });
        const keyCard = isClaude ? section : card("API key");
        const subCard = isClaude ? section : card("ChatGPT subscription");
        const edit = keyCard.getByRole("button", {
          name: isClaude ? "API key" : "Add API key",
          exact: true,
        });
        await edit.tap();
        const save = keyCard.getByRole("button", {
          name: "Save key",
          exact: true,
        });
        await browserExpect(save).toBeVisible();
        const saveKey = async () => {
          await keyCard
            .getByLabel("OpenAI API key")
            .fill("browser-test-openai-key");
          await save.tap();
          await browserExpect(
            keyCard.getByText("Saved", { exact: true }),
          ).toBeVisible();
        };
        if (!isClaude) await saveKey();
        await subCard
          .getByRole("button", {
            name: isClaude ? "Subscription" : "Sign in",
            exact: true,
          })
          .tap();
        await browserExpect(keyCard.locator(".keypanel")).toBeHidden();
        const open = subCard.getByRole("link", {
          name: `Open ${name} sign-in`,
        });
        const answer = subCard.getByRole("textbox", {
          name: `Address after signing in to ${name}`,
        });
        const finish = subCard.getByRole("button", { name: "Finish sign-in" });
        for (const control of [open, answer, finish]) {
          await expectHitCorners(control);
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
        return { section, state, subCard, keyCard, edit, saveKey };
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
      const { subCard, keyCard } = chatgpt;
      const command = subCard.locator(".localfb pre");
      await browserExpect(command).toContainText("code=chatgpt-code");
      await browserExpect(subCard.locator(".paste-sign-in")).toHaveCount(0);
      await subCard
        .getByRole("textbox", { name: "Command output" })
        .fill(JSON.stringify(subscriptionToken()));
      await subCard
        .locator(".localfb")
        .getByRole("button", { name: "Finish sign-in" })
        .tap();
      await browserExpect(
        subCard.getByText("Logged in with your ChatGPT subscription."),
      ).toBeVisible();
      await browserExpect(subCard.locator(".localfb")).toBeHidden();
      const removeSub = subCard.getByRole("button", {
        name: "Remove subscription",
        exact: true,
      });
      const removeKey = keyCard.getByRole("button", {
        name: "Remove API key",
        exact: true,
      });
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      for (const width of [412, 1280]) {
        await page.setViewportSize({ width, height: 915 });
        await browserExpect(
          subCard.getByText("Signed in", { exact: true }),
        ).toBeVisible();
        await browserExpect(
          keyCard.getByText("Saved", { exact: true }),
        ).toBeVisible();
        for (const button of [removeSub, removeKey])
          await expectHitCorners(button);
        if (shots)
          await page.screenshot({
            path: `${shots}/openai-provider-${width}.png`,
          });
      }
      await removeKey.click();
      await browserExpect(
        keyCard.getByText("Not saved", { exact: true }),
      ).toBeVisible();
      await browserExpect(
        subCard.getByText("Signed in", { exact: true }),
      ).toBeVisible();
      await chatgpt.edit.click();
      await chatgpt.saveKey();
      await removeSub.click();
      await browserExpect(
        subCard.getByText("Not signed in", { exact: true }),
      ).toBeVisible();
      await browserExpect(
        keyCard.getByText("Saved", { exact: true }),
      ).toBeVisible();

      expect(requests.map((request) => [request.path, request.code])).toEqual([
        ["/claude/token", "claude-code"],
        ["/codex/token", "chatgpt-code"],
      ]);
      expect(requests[0]!.code_verifier).toBe(claude.state!);
      expect(errors).toEqual([]);
    } finally {
      for (const path of ["auth", "codex-auth"])
        await page.request.post(`${base}api/pi/${path}/logout`);
      await page.request.post(`${base}api/pi/codex-auth/api-key/remove`);
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
      const codex = `${base}api/pi/codex-auth`;
      expect((await page.request.post(`${codex}/login-url`)).ok()).toBeTrue();
      expect(
        (
          await page.request.post(`${codex}/token-json`, {
            data: { token: JSON.stringify(subscriptionToken()) },
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
      await page.locator('#settings-nav button[data-cat="providers"]').click();
      await browserExpect(
        page.getByRole("button", { name: /^Claude / }),
      ).toBeVisible();
      await browserExpect(page.locator("dialog[open]")).toHaveCount(0);
      const time = String.raw`(?:\w{3} )?\d\d:\d\d`;
      for (const title of ["Claude", "OpenAI", "OpenRouter"]) {
        await closeDetails(page);
        await openDetail(page, new RegExp(`^${title} `));
        const section = page.getByRole("region", { name: title, exact: true });
        await browserExpect(section).toBeVisible();
        if (title === "OpenAI") {
          await browserExpect(
            section.getByRole("button", {
              name: "Replace API key",
              exact: true,
            }),
          ).toBeVisible();
          await browserExpect(
            section.getByRole("button", {
              name: "Remove API key",
              exact: true,
            }),
          ).toBeVisible();
          continue;
        }
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
      await closeDetails(page);
      for (const width of [1280, 412]) {
        await page.setViewportSize({ width, height: 915 });
        for (const [title, left] of [
          ["Claude", ["38", "82"]],
          ["OpenAI", ["59", "93"]],
        ] as const) {
          await closeDetails(page);
          const section = page.getByRole("region", {
            name: title,
            exact: true,
          });
          await browserExpect(section).toBeHidden();
          await openDetail(page, new RegExp(`^${title} `));
          await browserExpect(
            page.getByRole("dialog", { name: title, exact: true }),
          ).toBeVisible();
          if (width === 412) await expectModalSheet(page, title);
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
      await expectModalSheet(page, "OpenAI");
      const openai = page.getByRole("region", { name: "OpenAI", exact: true });
      const counters = openai.locator(".usage-text");
      const beforeRemoval = await counters.allTextContents();
      await openai
        .getByRole("button", { name: "Remove API key", exact: true })
        .click();
      await browserExpect(
        openai.getByText("Not saved", { exact: true }),
      ).toBeVisible();
      await browserExpect(counters).toHaveText(beforeRemoval);
      await openai
        .getByRole("button", { name: "Add API key", exact: true })
        .click();
      await openai
        .getByLabel("OpenAI API key")
        .fill("browser-test-platform-key");
      await openai
        .getByRole("button", { name: "Save key", exact: true })
        .click();
      await browserExpect(
        openai.getByText("Saved", { exact: true }),
      ).toBeVisible();
      await browserExpect(counters).toHaveText(beforeRemoval);
      for (const counter of await counters.all())
        await browserExpect(counter).toBeVisible();
      await page
        .getByRole("button", { name: "Close OpenAI", exact: true })
        .click();
      await openDetail(page, /^Claude /);
      const claude = page.getByRole("region", { name: "Claude", exact: true });
      await claude
        .getByRole("button", { name: "API key", exact: true })
        .click();
      const key = claude.getByLabel("Anthropic API key");
      await key.fill("unsaved-test-key");
      await page.setViewportSize({ width: 1280, height: 915 });
      await browserExpect(
        page.getByRole("button", { name: "Back to Providers", exact: true }),
      ).toBeVisible();
      await browserExpect(page.locator("dialog:modal")).toHaveCount(0);
      await browserExpect(key).toBeVisible();
      await browserExpect(key).toHaveValue("unsaved-test-key");
      expect(errors).toEqual([]);
    } finally {
      for (const path of ["auth", "codex-auth"])
        await page.request.post(`${base}api/pi/${path}/logout`);
      await page.request.post(`${base}api/pi/codex-auth/api-key/remove`);
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["settings", tests]]);
