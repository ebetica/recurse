import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import type { Locator } from "playwright";
import { EFFORT_LEVELS } from "../../src/effort_levels";
import {
  captureErrors,
  checkedTap,
  closeWithRoutes,
  expectHitCorners,
  focusComposer,
  gotoRoot,
  openPage,
  postFixture,
  routeArtifacts,
  runBrowserTests,
  screenshot,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { ALL_REASONING_LEVELS as ALL_LEVELS } from "./fixtures";

async function expectVisuallyHidden(status: Locator) {
  await browserExpect(status).toHaveCSS("position", "absolute");
  await browserExpect(status).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
}

const fixtureEntry = (level: number) => ({
  model: level < 4 ? "test/model-b" : "test/model-a",
  reasoning: ["low", "medium", "high", "max", "xhigh", "max"][level - 1],
});
const ladder = {
  default_level: 3,
  levels: Object.fromEntries(
    EFFORT_LEVELS.map((level) => [level, fixtureEntry(level)]),
  ),
  reachability: Object.fromEntries(
    EFFORT_LEVELS.map((level) => [
      level,
      {
        ...fixtureEntry(level),
        reachable: true,
        reason: "",
      },
    ]),
  ),
  models: [
    { id: "test/model-a", label: "Test A" },
    { id: "test/model-b", label: "Test B" },
  ],
  reasoning: ["low", "medium", "high", "xhigh", "max"],
};
export const tests: BrowserTest[] = [
  async function test_phone_effort_chip_names_the_model_variant(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-context");
    for (const width of [320, 360, 390, 412]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page.locator("#input").tap();
        const trigger = page.locator("#model-trigger");
        const name = trigger.locator(".model-name");
        await browserExpect(trigger).toHaveText("Opus 5.5 Medium");
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          /^Level \d: Claude Opus 5\.5 · Medium: /,
        );
        await visibleAndUncovered(page, "#context-indicator");
        await visibleAndUncovered(page, "#model-trigger .model-name");
        await expectHitCorners(trigger);
        await expectHitCorners(page.locator("#context-indicator"));
        await browserExpect(
          page.getByRole("switch", { name: /^Safety review/ }),
        ).toBeHidden();
        const { scrollWidth, clientWidth } = await name.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      } finally {
        await page.close();
      }
    }
  },

  // Regression: #3565 desktop composer controls stay visible across focus and effort keyboard shortcuts.
  async function test_effort_ladder_rejected_switch_reverts(browser, base) {
    for (const width of [1280, 412, 390]) {
      const { agent, model, effort } = await postFixture(
        base,
        "seed-recorded-effort-choice",
      );
      const shown = model.replace(/^Claude /, "");
      const modelUrl = `${base}api/conversations/${agent}/model`;
      const mobile = width !== 1280;
      const { context, page, errors } = await openPage(browser, {
        viewport: { width, height: width === 390 ? 844 : 915 },
        touch: mobile,
      });
      const posts: unknown[] = [];
      let rejectChange = true;
      await page.route(modelUrl, (route) => {
        const request = route.request();
        if (request.method() !== "POST") return route.fallback();
        posts.push(request.postDataJSON());
        return rejectChange ? route.fulfill({ status: 409 }) : route.continue();
      });
      const modelResponse = () =>
        page.waitForResponse(
          (r) => r.url() === modelUrl && r.request().method() === "POST",
        );
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor({
          state: "attached",
        });
        const trigger = page.locator("#model-trigger");
        const name = trigger.locator(".model-name");
        const menu = page.locator("#model-menu:popover-open");
        const range = menu.getByRole("slider", {
          name: "Effort level",
          exact: true,
        });
        const label = menu.locator("#effort-model");
        const composer = page.locator("#composer");
        const recordedLabel = `${model} · Low`;
        const recordedAction = `Level 3: ${recordedLabel}: choose effort level`;
        await browserExpect(name).toHaveText(shown);
        await browserExpect(trigger.locator("svg")).toHaveCount(0);
        await browserExpect(trigger).toHaveText(`${shown} Low`);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        await waitForLayout(page);
        const row = page.locator("#conv-controls");
        const input = page.locator("#input");
        const initialCard = await composer.boundingBox();
        const checkRow = async () => {
          await visibleAndUncovered(page, "#model-trigger");
          expect((await row.boundingBox())!.y).toBeGreaterThanOrEqual(
            await input.evaluate((el) => el.getBoundingClientRect().bottom),
          );
          expect(await composer.boundingBox()).toEqual(initialCard);
        };
        await checkRow();
        await screenshot(page, `composer/composer-unfocused-${width}`);
        if (mobile) await input.tap();
        else await input.click();
        await browserExpect(input).toBeFocused();
        await checkRow();
        await screenshot(page, `composer/composer-focused-${width}`);
        if (mobile) {
          await input.fill("Keep this draft when the picker closes.");
          await checkedTap(trigger);
          await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
          await browserExpect(menu).toBeVisible();
          await browserExpect(input).toBeFocused();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setTouchEmulationEnabled", {
            enabled: false,
          });
          await page.waitForFunction(
            () => !window.matchMedia("(pointer: coarse)").matches,
          );
          await input.evaluate((field) =>
            field.addEventListener(
              "blur",
              () => {
                field.dataset.blurred = "true";
              },
              { once: true },
            ),
          );
          await page.keyboard.press("Escape");
          await browserExpect(
            input,
            "Escape dismisses effort without blurring the draft",
          ).toBeFocused();
          await browserExpect(menu).toBeHidden();
          expect(await input.getAttribute("data-blurred")).toBeNull();
          await browserExpect(input).toHaveValue(
            "Keep this draft when the picker closes.",
          );
          await cdp.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 1,
          });
          await page.waitForFunction(
            () => window.matchMedia("(pointer: coarse)").matches,
          );
          await input.fill("");
        } else {
          await input.blur();
          await checkRow();
          await page.locator(".prompt-banner-row").focus();
          await page.keyboard.press("Tab");
          await browserExpect(page.locator("#scroll-btn")).toBeFocused();
          await checkRow();
          await page.keyboard.press("Tab");
          await browserExpect(input).toBeFocused();
          await checkRow();
          await page.keyboard.press("Tab");
          await browserExpect(page.locator("#attach")).toBeFocused();
          await page.keyboard.press("Tab");
          await browserExpect(trigger).toBeFocused();
          await page.keyboard.press("Enter");
          await browserExpect(menu).toBeFocused();
          await page.keyboard.press("Tab");
          await browserExpect(range).toBeFocused();
          await page.keyboard.press("Tab");
          await browserExpect(
            menu.getByRole("switch", { name: /^Safety review/ }),
          ).toBeFocused();
          await page.keyboard.press("Escape");
          await browserExpect(trigger).toBeFocused();
          await trigger.blur();
          await checkRow();
          for (const shortcut of ["e", "Shift+M"]) {
            await page.keyboard.press(shortcut);
            await browserExpect(trigger).toHaveAttribute(
              "aria-expanded",
              "true",
            );
            await visibleAndUncovered(page, "#effort-range");
            await checkRow();
            await page.keyboard.press("Escape");
            await browserExpect(trigger).toBeFocused();
            await trigger.blur();
            await checkRow();
          }
          await focusComposer(page);
        }
        const chipLayout = await trigger.evaluate((el, touch) => {
          const { left, right, top, bottom, height } =
            el.getBoundingClientRect();
          const x = (left + right) / 2;
          const y = top + height / 2;
          const hit = (x: number, y: number) =>
            el.contains(el.ownerDocument.elementFromPoint(x, y));
          const textRects = (selector: string) => {
            const text = el.ownerDocument.createRange();
            text.selectNodeContents(el.querySelector(selector)!);
            return [...text.getClientRects()].filter((rect) => rect.width > 0);
          };
          const [model] = textRects(".model-name");
          const suffix = textRects(".effort-reasoning-text");
          return {
            endCorners: [left + 16, right - 16].flatMap((x) =>
              (touch ? [y - 21, y + 21] : [top + 3, bottom - 3]).map((y) =>
                hit(x, y),
              ),
            ),
            minimumCorners:
              !touch ||
              [x - 21, x + 21].every((x) =>
                [y - 21, y + 21].every((y) => hit(x, y)),
              ),
            centeredText:
              Math.abs(model!.left - left - (right - suffix[0]!.right)) < 1,
            reasoningOnModelLine:
              suffix.length === 1 &&
              suffix.every(
                (rect) =>
                  model &&
                  rect.top < model.bottom &&
                  rect.bottom > model.top &&
                  rect.left >= left &&
                  rect.right <= right &&
                  rect.top >= top &&
                  rect.bottom <= bottom &&
                  [rect.left + 1, rect.right - 1].every((x) =>
                    hit(x, rect.top + rect.height / 2),
                  ),
              ),
          };
        }, mobile);
        expect(chipLayout).toEqual({
          endCorners: [true, true, true, true],
          minimumCorners: true,
          centeredText: true,
          reasoningOnModelLine: true,
        });
        if (mobile) await trigger.tap();
        else await trigger.click();
        await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
        await visibleAndUncovered(page, "#effort-range");
        await visibleAndUncovered(page, "#send");
        if (mobile) {
          await browserExpect
            .poll(() =>
              menu.evaluate((el) => {
                const box = el.getBoundingClientRect();
                const viewport = el.ownerDocument.documentElement;
                return (
                  box.left >= 12 &&
                  box.right <= viewport.clientWidth - 12 &&
                  box.top >= 0 &&
                  box.bottom <= viewport.clientHeight
                );
              }),
            )
            .toBe(true);
        }
        const dots = menu.locator(".effort-stops > span");
        await browserExpect(dots).toHaveCount(EFFORT_LEVELS.length);
        const points = await dots.evaluateAll((dots) =>
          dots.map((dot) => {
            const box = dot.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            return {
              x,
              y,
              left: box.left,
              right: box.right,
              nonempty: box.width > 0 && box.height > 0,
              control: dot.ownerDocument.elementFromPoint(x, y)?.id,
            };
          }),
        );
        expect(
          points.every(
            (dot, i) =>
              dot.nonempty && (i === 0 || points[i - 1]!.right < dot.left),
          ),
        ).toBeTrue();
        expect(points.map(({ control }) => control)).toEqual(
          EFFORT_LEVELS.map(() => "effort-range"),
        );
        expect(points[0]!.y).toBeGreaterThan(
          await label.evaluate((el) => el.getBoundingClientRect().bottom),
        );
        await browserExpect(label).toHaveText(`${model} Low`);
        await visibleAndUncovered(page, "#effort-model");
        const status = menu.getByRole("status");
        await browserExpect
          .poll(() => status.ariaSnapshot())
          .toBe(`- status: ${JSON.stringify(`Level 3: ${recordedLabel}`)}`);
        await expectVisuallyHidden(status);
        await browserExpect(range).toHaveValue("3");
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${recordedLabel}`,
        );
        if (mobile) {
          await expectHitCorners(range, 44, {
            horizontalInset: 3,
            exact: true,
            scroll: false,
          });
        }
        const response = await page.request.get(
          `${base}api/settings/effort-levels`,
        );
        expect(response.ok()).toBeTrue();
        const live = (await response.json()) as typeof ladder;
        const at3 = live.levels["3"]!;
        const at5 = live.levels["5"]!;
        expect(at3.model).not.toBe(model);
        expect(at3.reasoning).not.toBe(effort);
        expect(at5.model).not.toBe(model);
        const labelFor = (selector: string) =>
          live.models.find(({ id }) => id === selector)!.label;
        const choice3 = labelFor(at3.model);
        const choice5 = labelFor(at5.model);
        const pendingLabel = `${choice3} · Medium`;
        const previewLabel = `${choice5} · Xhigh`;
        await screenshot(page, `composer/effort-open-${width}`);
        await range.evaluate((el) => {
          (el as HTMLInputElement).value = "5";
        });
        await range.dispatchEvent("input");
        await browserExpect(range).toHaveValue("5");
        await browserExpect(label).toHaveText(`${choice5} Xhigh`);
        await browserExpect(status).toHaveText(`Level 5: ${previewLabel}`);
        await expectVisuallyHidden(status);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 5: ${previewLabel}`,
        );
        await browserExpect(trigger).toHaveText(`${shown} Low`);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        await waitForLayout(page);
        await browserExpect(menu).toBeVisible();
        const geometry = await composer.boundingBox();
        expect(geometry).not.toBeNull();
        expect(posts).toEqual([]);
        const [rejected] = await Promise.all([
          modelResponse(),
          range.dispatchEvent("change"),
        ]);
        expect(rejected.status()).toBe(409);
        await browserExpect(range).toHaveValue("3");
        await browserExpect(trigger).not.toHaveClass(/pending/);
        await browserExpect(trigger).toHaveText(`${shown} Low`);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        await browserExpect(menu).toBeVisible();
        await browserExpect(label).toHaveText(`${model} Low`);
        await browserExpect(status).toHaveText(`Level 3: ${recordedLabel}`);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${recordedLabel}`,
        );
        await browserExpect
          .poll(() => composer.boundingBox())
          .toEqual(geometry);
        expect(posts).toEqual([{ level: 5 }]);

        rejectChange = false;
        const { x, y } = points[2]!;
        const [accepted] = await Promise.all([
          modelResponse(),
          mobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y),
          browserExpect(label).toHaveText(`${choice3} Medium`),
        ]);
        expect(accepted.status()).toBe(200);
        expect((await accepted.json()).pending_model).toEqual({
          level: 3,
          model: at3.model,
          effort: at3.reasoning,
        });
        await browserExpect(range).toBeEnabled();
        await browserExpect(trigger).toHaveClass(/pending/);
        await browserExpect(trigger).toHaveText(
          `${choice3.replace(/^Claude /, "")} Medium`,
        );
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          `Level 3: ${pendingLabel}: switches on your next message; choose effort level`,
        );
        await browserExpect(label).toHaveText(`${choice3} Medium`);
        await screenshot(page, `composer/effort-pending-${width}`);
        await browserExpect(status).toHaveText(`Level 3: ${pendingLabel}`);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${pendingLabel}`,
        );
        expect(posts).toEqual([{ level: 5 }, { level: 3 }]);
        if (width === 390) {
          const ladderUrl = `${base}api/settings/effort-levels`;
          const saveLevels = async (levels: typeof live.levels) => {
            const update = await page.request.post(ladderUrl, {
              data: { levels, default_level: live.default_level },
            });
            expect(update.ok()).toBeTrue();
          };
          await page.keyboard.press("Escape");
          try {
            await saveLevels({
              ...live.levels,
              "3": { ...at3, reasoning: "high" },
            });
            await page.reload();
            await focusComposer(page);
            await trigger.tap();
            await range.dispatchEvent("input");
            await browserExpect(label).toHaveText(`${choice3} High`);
            await page.keyboard.press("Escape");
            await trigger.tap();
            await browserExpect(trigger).toHaveText(
              `${choice3.replace(/^Claude /, "")} Medium`,
            );
            await browserExpect(label).toHaveText(`${choice3} Medium`);
            await browserExpect(range).toHaveAttribute(
              "aria-valuetext",
              `Level 3: ${pendingLabel}`,
            );
          } finally {
            await saveLevels(live.levels);
          }
          const fifth = (await dots.nth(4).boundingBox())!;
          const [switched] = await Promise.all([
            modelResponse(),
            page.touchscreen.tap(
              fifth.x + fifth.width / 2,
              fifth.y + fifth.height / 2,
            ),
          ]);
          expect(switched.ok()).toBeTrue();
          await browserExpect(range).toHaveValue("5");
          await browserExpect(label).toHaveText(`${choice5} Xhigh`);
          expect(posts).toEqual([{ level: 5 }, { level: 3 }, { level: 5 }]);

          await page.keyboard.press("Escape");
          await page.setViewportSize({ width, height: 300 });
          await input.fill("Draft line\n".repeat(14));
          await trigger.tap();
          await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
          await visibleAndUncovered(page, "#effort-model");
          await visibleAndUncovered(page, "#effort-range");
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Feature: #2009 draft effort picker remains visibly accessible
  async function test_effort_picker_and_draft_level(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1100, height: 800 },
    });
    const shown = "Test B with a name longer than the chip and the page";
    const long = `Anthropic: ${shown}`;
    await routeArtifacts(page, base);
    await page.route(`${base}api/settings/effort-levels`, (route) =>
      route.fulfill({
        json: {
          ...ladder,
          levels: {
            ...ladder.levels,
            5: { model: "test/model-c", reasoning: "max" },
            6: { model: "test/model-d", reasoning: "max" },
          },
          reachability: {
            ...ladder.reachability,
            5: {
              model: "test/model-c",
              reasoning: "max",
              reachable: true,
              reason: "",
            },
            6: {
              model: "test/model-d",
              reasoning: "max",
              reachable: true,
              reason: "",
            },
          },
          models: [
            { id: "test/model-d", label: "Gemini 3.5 Flash" },
            { id: "test/model-a", label: "GPT-6 Sol" },
            { id: "test/model-b", label: long },
            { id: "test/model-c", label: "GPT-6.2 Sol" },
          ],
        },
      }),
    );
    await page.route(`${base}api/conversations`, (route) =>
      route.fulfill({ status: 422, body: "test" }),
    );
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    await page.keyboard.press("t");
    await page.locator("#draft-model-host").waitFor();
    const trigger = page.locator("#model-trigger");
    const chip = trigger.locator(".model-name");
    const input = page.locator("#input");
    const fits = (field: Locator) =>
      field.evaluate(
        (node) =>
          node.clientHeight > 0 && node.scrollHeight <= node.clientHeight,
      );
    const height = () => input.evaluate((node) => node.clientHeight);
    await browserExpect(chip).toHaveText(shown);
    await browserExpect.poll(() => fits(input)).toBe(true);
    const oneLine = await height();
    for (const width of [1100, 750, 412]) {
      await page.setViewportSize({ width, height: 800 });
      await browserExpect
        .poll(() =>
          chip.evaluate((name) => {
            const r = name.getBoundingClientRect();
            return (
              name.scrollWidth <= name.clientWidth &&
              [r.left + 2, r.right - 2].every((x) =>
                [r.top + 2, r.bottom - 2].every((y) =>
                  name.contains(name.ownerDocument.elementFromPoint(x, y)),
                ),
              )
            );
          }),
        )
        .toBe(true);
      await browserExpect.poll(() => fits(input)).toBe(true);
    }
    await input.evaluate((field: any) => {
      field.placeholder =
        "Describe the first task for this agent, then press Enter to send it";
    });
    await browserExpect.poll(() => fits(input)).toBe(true);
    expect(await height()).toBeGreaterThan(oneLine);
    await page.setViewportSize({ width: 1100, height: 800 });
    await browserExpect.poll(height).toBe(oneLine);
    await browserExpect.poll(() => fits(input)).toBe(true);
    expect(
      await page
        .locator(".draft-hello > *")
        .first()
        .evaluate((n) => n.tagName),
    ).toBe("H2");
    await browserExpect(trigger).toHaveAttribute(
      "aria-label",
      `Level 3: ${long}: choose effort level`,
    );
    await trigger.click();
    const menu = page.getByRole("dialog", {
      name: "Effort level",
      exact: true,
    });
    const range = menu.getByRole("slider");
    const label = menu.locator("#effort-model");
    const status = menu.getByRole("status");
    await browserExpect(trigger).toBeVisible();
    await browserExpect(range).toHaveValue("3");
    await browserExpect(label).toHaveText(long);
    await browserExpect(status).toHaveText(`Level 3: ${long}`);
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      `Level 3: ${long}`,
    );
    await page.keyboard.press("Escape");
    await trigger.click();
    await range.press("ArrowRight");
    await browserExpect(range).toHaveValue("4");
    await browserExpect(label).toHaveText("GPT-6 Sol");
    await browserExpect(status).toHaveText("Level 4: GPT-6 Sol");
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      "Level 4: GPT-6 Sol",
    );
    await browserExpect(chip).toHaveText("6 Sol");
    await browserExpect(trigger).toHaveAttribute(
      "aria-label",
      "Level 4: GPT-6 Sol: choose effort level",
    );
    await range.press("ArrowRight");
    await browserExpect(chip).toHaveText("6.2 Sol");
    await browserExpect(trigger).toHaveAttribute(
      "aria-label",
      "Level 5: GPT-6.2 Sol: choose effort level",
    );
    await range.press("ArrowRight");
    await browserExpect(chip).toHaveText("Gemini 3.5 Flash");
    await range.press("ArrowLeft");
    await range.press("ArrowLeft");
    await browserExpect(chip).toHaveText("6 Sol");
    await menu.focus();
    await page.keyboard.press("j");
    await browserExpect(menu).toBeFocused();
    await browserExpect(label).toHaveText("GPT-6.2 Sol");
    await browserExpect
      .poll(() => status.ariaSnapshot())
      .toBe('- status: "Level 5: GPT-6.2 Sol"');
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      "Level 5: GPT-6.2 Sol",
    );
    await page.keyboard.press("k");
    await browserExpect(status).toHaveText("Level 4: GPT-6 Sol");
    await page.locator("#input").fill("Use the selected effort level");
    const req = page.waitForRequest(`${base}api/conversations`);
    await page.locator("#send").click();
    const request = await req;
    expect(request.postDataJSON().level).toBe(4);
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
if (import.meta.main) await runBrowserTests([["composer", tests]]);
