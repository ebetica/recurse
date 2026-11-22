import { expect } from "bun:test";
import {
  getBuiltinClassifierModels,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import {
  captureErrors,
  closeWithRoutes,
  focusComposer,
  gotoRoot,
  routeArtifacts,
  runBrowserTests,
  startServer,
  stopServer,
  visibleAndUncovered,
  type BrowserTest,
  openSettingsPanel,
  startNewAgent,
  expectHitCorners,
} from "./common";
import { closeDetails, expectModalSheet, fontSize } from "./settings_support";
import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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
      const safetyBadge = (await lunaRow
        .getByText("ChatGPT subscription", {
          exact: true,
        })
        .boundingBox())!;
      const safetyModel = (await lunaRow
        .getByText(luna.name, {
          exact: true,
        })
        .boundingBox())!;
      expect(safetyBadge.x + safetyBadge.width).toBeLessThan(safetyModel.x);
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
    const models = [
      LIST_OPUS,
      LIST_OPUS,
      LIST_SOL,
      LIST_SONNET,
      LIST_FRESH,
      LIST_SOL,
    ];
    const routes = await routeLadder(page, base, {
      levels: models.map(({ id }) => ({
        model: id,
        reasoning: id === LIST_FRESH.id ? "off" : "high",
      })),
      list: [LIST_OPUS, LIST_SONNET, LIST_SOL, LIST_FRESH],
    });
    await routeArtifacts(page, base);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await openSettingsPanel(page);
    await page.locator("#settings-overlay.on").waitFor();
    await page.locator('#settings-nav button[data-cat="models"]').tap();
    await expectLevelOneHelp(page);
    const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
    for (const width of [1280, 921, 920, 412, 390]) {
      await page.setViewportSize({ width, height: 915 });
      const columns: [number, number, number][] = [];
      for (const [i, { label, route }] of models.entries()) {
        const { model, reasoning } = effortLevel(page, i + 1);
        await browserExpect(model).toHaveAccessibleName(
          `Level ${i + 1} ${label} ${route}`,
        );
        const badge = (await model
          .getByText(route, { exact: true })
          .boundingBox())!;
        const name = model.getByText(label, { exact: true });
        const nameStart = await name.evaluate((el) => {
          const text = el.firstChild!;
          const range = el.ownerDocument.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 1);
          return range.getBoundingClientRect().left;
        });
        const slider = (await reasoning.boundingBox())!;
        expect(badge.x + badge.width).toBeLessThan(nameStart);
        expect(
          await name.evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBeTrue();
        columns.push([badge.x, nameStart, slider.x]);
        if (width === 920 || width === 921) {
          const button = (await model.boundingBox())!;
          if (width === 920) {
            expect(
              slider.y,
              "Slider below the model at 920 px",
            ).toBeGreaterThanOrEqual(button.y + button.height);
          } else {
            expect(
              slider.x,
              "Slider after the model at 921 px",
            ).toBeGreaterThanOrEqual(button.x + button.width);
            expect(slider.y).toBeLessThan(button.y + button.height);
            expect(slider.y + slider.height).toBeGreaterThan(button.y);
          }
        }
      }
      expect(
        columns,
        `Aligned badge, name text, and slider at ${width} px`,
      ).toEqual(models.map(() => columns[0]));
      if (shots)
        await page.screenshot({ path: `${shots}/effort-levels-${width}.png` });
    }
    const two = effortLevel(page, 2);
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
    await expectHitCorners(box);
    const bounds = (await box.boundingBox())!;
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
    const listBox = await listbox.boundingBox();
    expect(
      await listbox.evaluate(
        (el) => (globalThis as any).getComputedStyle(el).position,
      ),
    ).toBe("static");
    const scrolledInputBox = await box.boundingBox();
    expect(listBox!.y).toBeGreaterThanOrEqual(
      scrolledInputBox!.y + scrolledInputBox!.height,
    );
    expect(await listCapacity(listbox)).toBeGreaterThanOrEqual(4);
    await visibleAndUncovered(page, `${freshRow}:visible`);
    await expectHitCorners(option);
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
    expect(routes.saved[0]!.levels).not.toHaveProperty("6");
    expect(errors).toEqual([]);
    await context.close();
  },
  // Feature: #3544 Setting and selecting a sixth effort level works through the first turn.
  async function test_effort_six_in_settings_and_new_agent(browser, base) {
    for (const width of [1280, 412, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width !== 1280,
        hasTouch: width !== 1280,
      });
      const page = await context.newPage();
      await gotoRoot(page, base);
      await openLadderSettings(page);
      const sixth = effortLevel(page, 6).model;
      await browserExpect(
        effortLevels(page).locator(".row.effort"),
      ).toHaveCount(6);
      await sixth.scrollIntoViewIfNeeded();
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      if (shots)
        await page.screenshot({
          path: `${shots}/effort-six-settings-${width}.png`,
        });
      await page.locator("#settings-close").click();
      await startNewAgent(page);
      const trigger = page.locator("#model-trigger");
      await browserExpect(trigger).toHaveAttribute(
        "aria-label",
        /^Level 3: (?!Effort:)/,
      );
      await trigger.click();
      const slider = page.getByRole("slider", {
        name: "Effort level",
        exact: true,
      });
      await slider.press("End");
      await browserExpect(slider).toHaveValue("6");
      await slider.press("Home");
      await browserExpect(slider).toHaveValue("1");
      for (const level of [2, 3, 4, 5, 6]) {
        await slider.press("ArrowRight");
        await browserExpect(slider).toHaveValue(String(level));
      }
      await browserExpect(trigger).toHaveAttribute("aria-label", /^Level 6:/);
      if (shots)
        await page.screenshot({
          path: `${shots}/effort-six-draft-${width}.png`,
        });
      await slider.press("Escape");
      await page.locator("#input").fill("Reply only Sixth level confirmed.");
      const created = page.waitForResponse(
        (response) =>
          response.url() === `${base}api/conversations` &&
          response.request().method() === "POST",
      );
      await page.locator("#send").click();
      const response = await created;
      expect(response.ok()).toBe(true);
      const { id, level } = await response.json();
      expect(level).toBe(6);
      await browserExpect(
        page
          .locator("#messages")
          .getByText("Sixth level confirmed.", { exact: true }),
      ).toBeVisible();
      const turn = await page.request.get(
        `${base}api/conversations/${id}/prompt`,
      );
      expect(turn.ok()).toBe(true);
      expect(JSON.stringify((await turn.json()).request)).toContain(
        "This conversation runs at effort level 6",
      );
      await context.close();
    }
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
      const pill = page.locator("#model-trigger");
      const model = pill.locator(".model-name");
      await focusComposer(page);
      await visibleAndUncovered(page, "#model-trigger .model-name");
      await browserExpect(model).toHaveText("Effort");
      const width = () =>
        pill.evaluate((node) => node.getBoundingClientRect().width);
      const loadingWidth = await width();
      release();
      await browserExpect(model).toHaveText(outside.label);
      expect(await width()).toBe(loadingWidth);
      expect(errors).toEqual([]);
    } finally {
      release();
      await closeWithRoutes(context);
    }
  },
];
if (import.meta.main)
  await runBrowserTests([["settings-effort-levels", tests]]);
