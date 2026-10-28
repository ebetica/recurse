import { expect } from "bun:test";
import type { Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { loadRecording } from "../backend/fixtures/model_response/replay";
import { captureErrors, closeWithRoutes, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2408 a recorded pre-clear response must not end the wait.
  async function test_recorded_stream_changed_served_model_chip(browser, base) {
    const recording = await loadRecording();
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
      expect(await page.locator("#safety-btn .lbl").innerText()).toBe(
        "Safety review",
      );
      expect(await page.locator("#safety-btn").getAttribute("aria-label")).toBe(
        "Safety review, on",
      );
      await screenshots("before");
      const original = await seed(true, agent);
      await chip.waitFor();
      expect(await chip.innerText()).toBe("Downgraded");
      expect((await chip.getAttribute("class")) ?? "").not.toContain("seen");
      await screenshots("after", true);
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
      expect(await popover.innerText()).toContain(explanation);
      await popover.locator(".model-response-row time").waitFor();
      expect(await chip.getAttribute("class")).toContain("seen");
      await page.keyboard.press("Escape");
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
      await page.locator("#safety-btn").click();
      await page
        .locator("#safety-btn .lbl")
        .filter({ hasText: /^Yolo mode$/ })
        .waitFor();
      expect(await page.locator("#safety-btn").getAttribute("aria-label")).toBe(
        "Safety review off (Yolo mode)",
      );
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
        let ladder: { models: { id: string; label: string }[] } | undefined;
        await page.route(
          `${base}api/settings/effort-levels**`,
          async (route) => {
            await ladderGate.opened;
            const body = await (await route.fetch()).json();
            ladder ??= body;
            await route.fulfill({
              json: {
                ...body,
                models: known
                  ? body.models
                  : body.models.map((model: { id: string }) => ({
                      ...model,
                      label: model.id,
                    })),
              },
            });
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
          const trigger = page.locator("#model-trigger .model-name");
          const firstLine = () =>
            popover.locator(".model-response-warning").first().innerText();
          expect(await trigger.innerText()).toBe("Effort");
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
          const names = ladder!.models.map((model) =>
            known ? model.label : model.id,
          );
          await page.waitForFunction(
            `${JSON.stringify(names)}.includes(document.querySelector("#model-trigger .model-name")?.textContent)`,
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
