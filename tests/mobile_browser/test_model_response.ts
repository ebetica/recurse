import { expect } from "bun:test";
import type { Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { loadRecording } from "../backend/fixtures/model_response/replay";
import {
  captureErrors,
  closeWithRoutes,
  expectHitCorners,
  focusComposer,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3249 #2408 #3565 report the served model, reject pre-clear data, and keep warnings reachable in narrow Chat windows.
  async function test_recorded_stream_changed_served_model_chip(browser, base) {
    const recording = await loadRecording();
    const reasoningValues = /\b(off|minimal|low|medium|high|xhigh|max)\b/i;
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = captureErrors(page);
    const desktop = await browser.newPage({
      viewport: { width: 1280, height: 915 },
    });
    let agent: string;
    const seed = async (downgrade: boolean, agent?: string) => {
      const result = await page.request.post(
        `${base}__browser-test/seed-model-response`,
        { data: { downgrade, agent } },
      );
      expect(result.ok()).toBeTrue();
      return (await result.json()) as { agent: string; entryId: number };
    };
    const screenshots = async (name: string, checkRow = false) => {
      await desktop.goto(`${base}#agent=${agent}`);
      await desktop
        .locator(".msg.assistant")
        .filter({ hasText: "NORMAL_MODEL_OK" })
        .first()
        .waitFor();
      for (const [view, width] of [
        [page, 412],
        [desktop, 1280],
      ] as const) {
        if (checkRow) {
          await view.locator("#downgrade-chip").waitFor();
          await focusComposer(view);
          const layout = await view.locator("#conv-controls").evaluate((row) =>
            [...row.querySelectorAll("button")]
              .map((item) => item.getBoundingClientRect())
              .filter((r) => r.width > 0)
              .map((r) => ({ center: r.top + r.height / 2, right: r.right })),
          );
          expect(
            Math.max(...layout.map((r) => r.center)) -
              Math.min(...layout.map((r) => r.center)),
          ).toBeLessThanOrEqual(2);
          for (const bounds of layout)
            expect(bounds.right).toBeLessThanOrEqual(width);
          const lines = await view
            .locator("#conv-controls button:visible")
            .evaluateAll((buttons) =>
              buttons.map((button) => {
                const range = button.ownerDocument.createRange();
                range.selectNodeContents(
                  button.querySelector(".lbl") ?? button,
                );
                const rects = [...range.getClientRects()].filter(
                  (rect) => rect.width > 0,
                );
                return (
                  rects.length === 0 ||
                  Math.max(...rects.map((rect) => rect.top)) <
                    Math.min(...rects.map((rect) => rect.bottom))
                );
              }),
            );
          expect(lines.every(Boolean)).toBeTrue();
        }
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await view.screenshot({
            path: `${shots}/model-${name}-${width}.png`,
          });
      }
    };
    try {
      agent = (await seed(false)).agent;
      await page.goto(`${base}#agent=${agent}`);
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "NORMAL_MODEL_OK" })
        .waitFor();
      const chip = page.locator("#downgrade-chip");
      expect(await chip.isVisible()).toBeFalse();
      await screenshots("before");
      const anchors = () =>
        page.locator("#composer").evaluate((composer) =>
          ["#attach", "#context-indicator", "#model-trigger", "#send"].map(
            (selector) => {
              const { x, y, width, height } = composer
                .querySelector(selector)!
                .getBoundingClientRect();
              return { selector, x, y, width, height };
            },
          ),
        );
      const phoneWidth = (width: number) =>
        page.setViewportSize({ width, height: 915 });
      await focusComposer(page);
      await visibleAndUncovered(page, "#context-indicator");
      const beforeWarning = await anchors();
      await phoneWidth(390);
      const beforeWarning390 = await anchors();
      await phoneWidth(412);
      const original = await seed(true, agent);
      await chip.waitFor();
      await browserExpect(
        page.getByRole("button", {
          name: "Model downgraded — details",
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await chip.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [-21, 21].flatMap((x) =>
            [-21, 21].map((y) =>
              element.contains(
                element.ownerDocument.elementFromPoint(
                  box.x + box.width / 2 + x,
                  box.y + box.height / 2 + y,
                ),
              ),
            ),
          );
        }),
      ).toEqual([true, true, true, true]);
      expect((await chip.getAttribute("class")) ?? "").not.toContain("seen");
      await screenshots("after", true);
      expect(await anchors()).toEqual(beforeWarning);
      await phoneWidth(390);
      const afterWarning390 = await anchors();
      const centers = afterWarning390.map(({ y, height }) => y + height / 2);
      const chipBox = (await chip.boundingBox())!;
      centers.push(chipBox.y + chipBox.height / 2);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(
        1,
      );
      expect(afterWarning390).toEqual(beforeWarning390);
      await phoneWidth(412);
      await page.locator("#input").blur();
      const controlsWithLayout = await page
        .locator("#conv-controls :is(#context-indicator, #model-trigger)")
        .evaluateAll((controls) =>
          controls
            .filter((control) => {
              const { width, height } = control.getBoundingClientRect();
              return width > 0 && height > 0;
            })
            .map((control) => control.id),
        );
      expect(controlsWithLayout).toEqual([]);
      await visibleAndUncovered(page, "#downgrade-chip");
      await chip.click();
      const catalog = await (
        await page.request.get(`${base}api/models`)
      ).json();
      const name = (id: string) =>
        catalog.models.find(
          (model: { id: string; label: string }) =>
            model.id === `${recording.provider}/${id}`,
        )?.label ?? id;
      const explanation = `Model changed: requested ${name(recording.requestedModel)} → served ${name(recording.servedModel)}`;
      const popover = page.getByRole("dialog", {
        name: "Provider model downgrade",
      });
      await popover.getByText(explanation, { exact: true }).waitFor();
      await browserExpect(popover).not.toContainText(reasoningValues);
      await popover.locator(".model-response-row time").waitFor();
      expect(await chip.getAttribute("class")).toContain("seen");
      await page.keyboard.press("Escape");
      await browserExpect(chip).toBeFocused();
      await page.reload();
      await chip.waitFor();
      expect(await chip.getAttribute("class")).toContain("seen");
      const viewUrl = `${base}api/conversations/${agent}/view`;
      const oldView = await (await page.request.get(viewUrl)).json();
      const oldSession = oldView.session;
      await page.locator("#input").fill("/clear");
      page.once("dialog", (dialog) => void dialog.accept());
      const cleared = page.waitForResponse(
        `${base}api/conversations/${agent}/clear`,
      );
      await page
        .locator("#skill-menu .skill-option.action", { hasText: "/clear" })
        .click();
      expect((await cleared).ok()).toBeTrue();
      await page
        .locator(".msg.assistant")
        .first()
        .waitFor({ state: "detached" });
      let clearReads = 0;
      const staleView = (route: Route) => {
        if (
          route.request().headers()["x-browser-state-check"] !==
          "cleared-session"
        )
          return route.fallback();
        clearReads++;
        return clearReads === 1
          ? route.fulfill({ json: oldView })
          : route.fallback();
      };
      await page.route(viewUrl, staleView);
      await browserExpect
        .poll(
          () =>
            page.evaluate(
              async ({ url, session }) => {
                const view = (await (
                  await fetch(url, {
                    headers: { "x-browser-state-check": "cleared-session" },
                  })
                ).json()) as {
                  status: string;
                  session?: string;
                };
                return (
                  view.status === "ready" &&
                  typeof view.session === "string" &&
                  view.session !== session
                );
              },
              { url: viewUrl, session: oldSession },
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(clearReads).toBeGreaterThan(1);
      await page.unroute(viewUrl, staleView);
      await seed(false, agent);
      const afterClear = await seed(true, agent);
      expect(afterClear.entryId).toBe(original.entryId);
      await page.locator("#downgrade-chip:not(.seen)").waitFor();
      await seed(false, agent);
      await chip.waitFor({ state: "hidden" });
      await page.locator(".turn-tokens.activity-usage").last().click();
      await page.locator("#prompt-overlay.on").waitFor();
      expect(await page.locator("#prompt-body").innerText()).toContain(
        explanation,
      );
      const rows = page.locator("#prompt-body .model-response-row");
      expect(await rows.count()).toBe(3);
      expect(await rows.locator("time").count()).toBe(3);
      expect(await rows.locator(".model-response-tokens").count()).toBe(3);
      await browserExpect(
        rows.filter({ hasText: reasoningValues }),
      ).toHaveCount(0);
      expect((await rows.allInnerTexts()).join(" ")).not.toContain(
        "requested unknown",
      );
      const body = page.locator("#prompt-body");
      expect(
        await body.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBeTrue();
      const bar = await body.locator(".turn-usage-bar").first().boundingBox();
      expect(bar!.y + bar!.height).toBeLessThan(915);
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      if (shots)
        await page.screenshot({ path: `${shots}/turn-usage-after-412.png` });
      await page.locator("#prompt-close").click();
      const result = await page.request.post(
        `${base}__browser-test/seed-model-response`,
        {
          data: { downgrade: true, run: true },
        },
      );
      expect(result.ok()).toBeTrue();
      const fake = (await result.json()) as { agent: string };
      for (const view of [page, desktop])
        await view.route(`${base}api/models**`, async (route) => {
          const catalog = await (await route.fetch()).json();
          await route.fulfill({
            json: {
              ...catalog,
              models: [
                ...catalog.models,
                { id: `${fake.agent}/faux-1`, label: "Faux Model" },
                { id: `${fake.agent}/faux-served`, label: "Served model" },
              ],
            },
          });
        });
      await page.goto(`${base}?served-model#agent=${fake.agent}`);
      await page.locator("#safety-row.on").waitFor({ state: "attached" });
      await focusComposer(page);
      const pill = page.locator("#model-trigger");
      const pillWidth = () =>
        pill.evaluate((node) => node.getBoundingClientRect().width);
      const fullWidth = await pillWidth();
      await page.locator("#input").fill("Reply with NORMAL_MODEL_OK.");
      await page.locator("#send").click();
      await page
        .getByRole("button", {
          name: "Model downgraded — details",
          exact: true,
        })
        .waitFor();
      await focusComposer(page);
      expect(await pillWidth()).toBe(fullWidth);
      for (const width of [390, 361, 360, 320]) {
        await page.setViewportSize({ width, height: 915 });
        await focusComposer(page);
        expect(await pillWidth()).toBe(fullWidth);
        await visibleAndUncovered(page, "#model-trigger .model-name");
        for (const control of [
          "#context-indicator",
          "#downgrade-chip",
          "#model-trigger",
        ])
          await expectHitCorners(page.locator(control));
      }
      await page.setViewportSize({ width: 412, height: 915 });
      const servedExplanation =
        "Model changed: requested Faux Model → served Served model";
      await page.locator("#downgrade-chip").click();
      await popover.getByText(servedExplanation, { exact: true }).waitFor();
      await browserExpect(popover).not.toContainText(/Reasoning changed/);
      await browserExpect(popover).not.toContainText(reasoningValues);
      await page.keyboard.press("Escape");
      await page.locator("#input").fill("Reply with REASONING_MISMATCH_OK.");
      await page.locator("#send").click();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "REASONING_MISMATCH_OK" })
        .waitFor();
      for (const [view, appearance] of [
        [page, "dark"],
        [desktop, "dark"],
        [desktop, "light"],
      ] as const) {
        expect(
          (
            await view.request.post(`${base}api/settings/theme`, {
              data: { theme: "Tokyo Night", appearance },
            })
          ).ok(),
        ).toBeTrue();
        await view.goto(`${base}?served-model#agent=${fake.agent}`);
        const warning = view.getByRole("button", {
          name: "Model downgraded — details",
          exact: true,
        });
        await warning.waitFor();
        const iconShots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (iconShots)
          await view.screenshot({
            path: `${iconShots}/downgrade-icon-${view.viewportSize()!.width}-${appearance}.png`,
          });
        await warning.click();
        const details = view.getByRole("dialog", {
          name: "Provider model downgrade",
        });
        await details.getByText(servedExplanation, { exact: true }).waitFor();
        await details.getByText("Reasoning changed", { exact: true }).waitFor();
        await browserExpect(details).not.toContainText(reasoningValues);
        await view.keyboard.press("Escape");
        await view.locator(".turn-tokens.activity-usage").last().click();
        await browserExpect(
          view.locator("#prompt-body .turn-usage-selector"),
        ).toHaveText("Conversation model · Served model");
        await view.locator("#prompt-body .turn-usage-bar").waitFor();
        const row = view.locator("#prompt-body .model-response-row");
        await browserExpect(row).toContainText(servedExplanation);
        await browserExpect(row).toContainText("Reasoning changed");
        await browserExpect(row).not.toContainText(reasoningValues);
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await view.screenshot({
            path: `${shots}/downgrade-usage-${view.viewportSize()!.width}-${appearance}.png`,
          });
        await view.locator("#prompt-close").click();
      }
      await desktop.goto(`${base}#agent=${agent}`);
      await desktop.locator("#model-trigger").click();
      await desktop
        .getByRole("switch", { name: "Safety review, on", exact: true })
        .click();
      const safetySaved = desktop.waitForResponse(
        `${base}api/conversations/${agent}/safety`,
      );
      await desktop
        .getByRole("button", { name: "Turn off safety review", exact: true })
        .click();
      expect((await safetySaved).ok()).toBeTrue();
      await seed(true, agent);
      await desktop.reload();
      await desktop.locator("#downgrade-chip").waitFor();
      await desktop
        .getByRole("button", { name: "Safety review off", exact: true })
        .waitFor();
      await desktop.locator('.rail-btn[data-pane="explorer"]').click();
      const sash = desktop.locator("#dock .dv-sash:visible:not([inert])");
      await sash.waitFor();
      const split = (await sash.boundingBox())!;
      const main = desktop.locator("#main");
      const left = (await main.boundingBox())!.x;
      const y = split.y + split.height / 2;
      await desktop.mouse.move(split.x + split.width / 2, y);
      await desktop.mouse.down();
      await desktop.mouse.move(left + 145, y);
      await desktop.mouse.up();
      await waitForLayout(desktop);
      expect((await main.boundingBox())!.width).toBeLessThan(170);
      const cdp = await desktop.context().newCDPSession(desktop);
      for (const touch of [false, true]) {
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: touch,
        });
        await desktop.waitForFunction(
          (touch) => window.matchMedia("(pointer: coarse)").matches === touch,
          touch,
        );
        for (const id of [
          "attach",
          "safety-warning",
          "downgrade-chip",
          "context-indicator",
          "model-trigger",
          "send",
        ]) {
          await visibleAndUncovered(desktop, `#${id}`);
          await expectHitCorners(desktop.locator(`#${id}`), touch ? 44 : 24, {
            centerOnHitArea: touch,
          });
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      await desktop.close();
    }
  },

  // Feature: #2381 model names wait for metadata.
  async function test_model_names_wait_for_metadata(browser, base) {
    const recording = await loadRecording();
    const seeded = await browser.newPage();
    const seed = async (downgrade: boolean, agent?: string) =>
      (await (
        await seeded.request.post(`${base}__browser-test/seed-model-response`, {
          data: { downgrade, agent },
        })
      ).json()) as { agent: string };
    const { agent } = await seed(false);
    await seed(true, agent);
    await seeded.close();
    const catalog = [
      {
        id: `${recording.provider}/${recording.requestedModel}`,
        label: "Requested model",
      },
      {
        id: `${recording.provider}/${recording.servedModel}`,
        label: "Served model",
      },
    ];
    for (const known of [true, false])
      for (const width of [412, 1280]) {
        const phone = width === 412;
        const page = await browser.newPage({
          viewport: { width, height: 915 },
          isMobile: phone,
          hasTouch: phone,
        });
        const errors = captureErrors(page);
        const gate = () => {
          let open!: () => void;
          const opened = new Promise<void>((resolve) => (open = resolve));
          return { open, opened };
        };
        const ladderGate = gate();
        const namesGate = gate();
        let ladderName: string | undefined;
        await page.route(
          `${base}api/settings/effort-levels**`,
          async (route) => {
            await ladderGate.opened;
            const body = await (await route.fetch()).json();
            const models = known
              ? body.models
              : body.models.map((model: { id: string }) => ({
                  ...model,
                  label: model.id,
                }));
            ladderName = models.find(
              (model: { id: string }) => model.id === body.levels["3"].model,
            )?.label;
            await route.fulfill({ json: { ...body, models } });
          },
        );
        await page.route(`${base}api/models**`, async (route) => {
          await namesGate.opened;
          const body = await (await route.fetch()).json();
          await route.fulfill({
            json: { ...body, models: known ? catalog : [] },
          });
        });
        try {
          await page.goto(`${base}#agent=${agent}`);
          const chip = page.locator("#downgrade-chip");
          await chip.waitFor();
          await chip.click();
          const popover = page.getByRole("dialog", {
            name: "Provider model downgrade",
          });
          await popover.waitFor();
          const trigger = page.locator("#model-trigger");
          const name = trigger.locator(".model-name");
          const firstLine = () =>
            popover.locator(".model-response-warning").first().innerText();
          await browserExpect(name).toHaveText("Effort");
          await browserExpect(trigger).toHaveAttribute(
            "aria-label",
            "Level 3: Effort: choose effort level",
          );
          expect(await firstLine()).toBe(
            "Model changed: requested … → served …",
          );
          const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
          if (shots && known)
            await page.screenshot({
              path: `${shots}/model-names-loading-${width}.png`,
            });
          const ladderRead = page.waitForResponse(
            `${base}api/settings/effort-levels**`,
          );
          ladderGate.open();
          await ladderRead;
          expect(ladderName).toBeDefined();
          await browserExpect(name).toHaveText(
            ladderName!.replace(/^Claude /, ""),
          );
          await browserExpect(trigger).toHaveAttribute(
            "aria-label",
            `Level 3: ${ladderName} · Medium: choose effort level`,
          );
          expect(await firstLine()).toBe(
            "Model changed: requested … → served …",
          );
          namesGate.open();
          await popover
            .getByText(
              known
                ? "Model changed: requested Requested model → served Served model"
                : `Model changed: requested ${recording.requestedModel} → served ${recording.servedModel}`,
              { exact: true },
            )
            .waitFor();
          if (shots)
            await page.screenshot({
              path: `${shots}/model-names-${known ? "known" : "unknown"}-${width}.png`,
            });
          expect(errors).toEqual([]);
        } finally {
          ladderGate.open();
          namesGate.open();
          await closeWithRoutes(page);
        }
      }
  },
];
