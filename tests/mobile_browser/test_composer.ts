import { expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retire } from "../../src/utils/trash";
import type { Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  checkedHitPoint,
  checkedTap,
  expectHitCorners,
  focusComposer,
  openPage,
  postFixture,
  runBrowserTests,
  screenshot,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";
import {
  editExplorerHtml,
  openExplorer,
  seedExplorerWorkspace,
} from "./explorer_support";

// Regression: #2479 one confirm click stops the newer run despite an older lookup. (also #2410 model selection errors stay visible and retain manual retry.)
const modelSelectionError: BrowserTest = async (browser, base) => {
  for (const [index, { model, effort }] of [
    { model: "" },
    { model: "not-a-model", effort: "default" },
    { model: "fauxordinary/removed", effort: null },
  ].entries()) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 900 },
    });
    try {
      const agent = `model-selection-${index}`;
      const seeded = await context.request.post(
        `${base}__browser-test/seed-model-selection-error`,
        { data: { agent, model, effort } },
      );
      expect(seeded.ok()).toBeTrue();
      if (effort === null)
        await page.route(
          (url) => url.pathname === `/api/conversations/${agent}`,
          async (route) => {
            const response = await route.fetch();
            const detail = await response.json();
            delete detail.effort;
            await route.fulfill({ response, json: detail });
          },
        );
      const sends: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith(`/api/conversations/${agent}/deliver`)
        )
          sends.push(request.postDataJSON().content);
      });
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#input:enabled").waitFor();
      const trigger = page.locator("#model-trigger");
      const name = model || "Unknown model";
      await browserExpect(trigger).toHaveText(name);
      await browserExpect(trigger).toHaveAttribute(
        "aria-label",
        `${name}: choose effort level`,
      );
      await focusComposer(page);
      await trigger.click();
      const menu = page.locator("#model-menu:popover-open");
      await browserExpect(menu.locator("#effort-model")).toHaveText(name);
      await browserExpect(menu.getByRole("status")).toHaveText(name);
      await browserExpect(menu.getByRole("slider")).toHaveAttribute(
        "aria-valuetext",
        name,
      );
      await page.keyboard.press("Escape");
      await page
        .locator("#input")
        .fill("Keep this message while I choose a model");
      await page.locator("#input").press("Enter");
      await page.locator("#send-status.error").waitFor();
      const detail = `${model ? `Model ${model} is unavailable.` : "No model is selected for this conversation."} Pick an effort level again in the model picker. If needed, update the ladder in Settings first.`;
      expect(await page.locator("#send-status").textContent()).toBe(
        `${detail} — Retry now`,
      );
      expect(await page.locator("#send-status").textContent()).not.toContain(
        "reconnecting",
      );
      expect(await page.locator("#send-status").textContent()).not.toContain(
        "durable",
      );
      expect(sends).toEqual(["Keep this message while I choose a model"]);
      await page.locator("#send-status").click();
      await page.locator("#send-status.error").waitFor();
      expect(sends).toEqual([
        "Keep this message while I choose a model",
        "Keep this message while I choose a model",
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
};

export const tests: BrowserTest[] = [
  async function test_composer_file_mentions(browser, base, data) {
    const temporary = await mkdtemp(
      join(data, "data", "browser-composer-files-"),
    );
    let testFailed = false;
    try {
      const { root, otherRoot, pickedPath, htmlPath, htmlSource } =
        await seedExplorerWorkspace(
          temporary,
          `${base}explorer-html-probe/`,
          new URL(base).origin,
        );
      await writeFile(htmlPath, editExplorerHtml(htmlSource));
      const other = await postFixture(base, "seed-model-selection-error", {
        agent: "explorer-other",
        model: "fauxordinary/faux-1",
        workdir: otherRoot,
      });
      for (const width of [1280, 412]) {
        const fixture = await postFixture(base, "seed-model-selection-error", {
          agent: `explorer-demo-${width}`,
          model: "fauxordinary/faux-1",
          workdir: root,
        });
        const { context, page, errors } = await openPage(browser, {
          viewport: { width, height: 915 },
          touch: width === 412,
          ...(width === 1280
            ? { permissions: ["clipboard-read", "clipboard-write"] }
            : {}),
        });
        try {
          await page.goto(`${base}#agent=${fixture.agent}`, {
            waitUntil: "domcontentloaded",
          });
          await page
            .locator("#conv-title", { hasText: "Choose a model" })
            .waitFor();
          const warmSearchReply = `Explorer comment ${width} received`;
          await page.locator("#input").fill(`Reply only ${warmSearchReply}`);
          await page.locator("#send").click();
          await page
            .locator("#messages .msg.assistant", { hasText: warmSearchReply })
            .waitFor();
          await openExplorer(page, width);
          const pane = page.locator('.pane-col[data-pane="explorer"]');
          await pane.locator('.explorer-row[data-path="src"]').click();
          await pane
            .locator('.explorer-row[data-path="src/application.ts"]')
            .waitFor();
          if (width === 1280) {
            const search = pane.getByRole("combobox", { name: "Search files" });
            await search.fill("appts");
            await pane
              .locator(".explorer-result", { hasText: "src/application.ts" })
              .waitFor();
            await search.press("Enter");
            await page.locator(".pane-col.file-tab .explorer-source").waitFor();
            await page.locator(".dv-tab", { hasText: "Explorer" }).click();
            await search.press("Escape");
            await page.locator('.dv-tab[data-dock-panel="chat"]').click();
          } else {
            await pane
              .getByRole("button", { name: "Close Explorer", exact: true })
              .click();
            await pane.waitFor({ state: "hidden" });
          }
          const composer = page.locator("#input");
          const fileMenu = page.locator("#file-menu");
          await composer.fill("");
          await page.keyboard.type("# ");
          expect(await composer.inputValue()).toBe("# ");
          expect(await fileMenu.isVisible()).toBe(false);
          await composer.fill("Review #pick");
          const fileOption = fileMenu.getByRole("option", {
            name: pickedPath,
            exact: true,
          });
          await fileOption.waitFor();
          const completedFiles = await fileMenu
            .getByRole("option")
            .allTextContents();
          const lazySearchPath = `**/api/conversations/${fixture.agent}/tree/search?*`;
          const lazyRoutes = new Map<
            string,
            ReturnType<typeof Promise.withResolvers<Route>>
          >();
          for (const query of ["picking", "pickingmore"])
            lazyRoutes.set(query, Promise.withResolvers<Route>());
          await page.route(lazySearchPath, (route) => {
            const query = new URL(route.request().url()).searchParams.get("q")!;
            const held = lazyRoutes.get(query);
            if (held) return held.resolve(route);
            return route.fallback();
          });
          await composer.press("End");
          await page.keyboard.insertText("ing");
          const olderSearch = await lazyRoutes.get("picking")!.promise;
          await screenshot(page, `explorer/files-${width}`);
          await browserExpect(fileOption).toBeVisible();
          await browserExpect(fileOption).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await browserExpect(fileMenu).not.toContainText(
            /Finding files|Searching|Loading/,
          );
          const olderCancelled = page.waitForEvent("requestfailed", {
            predicate: (request) => request === olderSearch.request(),
          });
          await page.keyboard.insertText("more");
          const newerSearch = await lazyRoutes.get("pickingmore")!.promise;
          await browserExpect(fileOption).toBeVisible();
          await newerSearch.fulfill({
            json: { results: ["newer-file.ts", pickedPath] },
          });
          await browserExpect(fileMenu.getByRole("option")).toHaveCount(2);
          await browserExpect(fileOption).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await olderSearch
            .fulfill({ json: { results: ["stale-file.ts"] } })
            .catch(() => {});
          expect((await olderCancelled).failure()?.errorText).toContain(
            "ERR_ABORTED",
          );
          await browserExpect(fileMenu.getByRole("option")).toHaveText([
            "newer-file.ts",
            pickedPath,
          ]);
          await page.unroute(lazySearchPath);
          await composer.press("Escape");
          const restoredSearch = page.waitForResponse(
            (response) =>
              response
                .url()
                .includes(`/api/conversations/${fixture.agent}/tree/search?`) &&
              new URL(response.url()).searchParams.get("q") === "pick",
          );
          await composer.fill("Review #pick");
          await restoredSearch;
          await browserExpect(fileMenu.getByRole("option")).toHaveText(
            completedFiles,
          );
          await fileOption.waitFor();
          for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
            for (const key of ["Escape", "Enter"]) {
              await composer.dispatchEvent("keydown", {
                key,
                bubbles: true,
                ...composition,
              });
              expect(await fileMenu.isVisible()).toBe(true);
              expect(await composer.inputValue()).toBe("Review #pick");
            }
          }
          await composer.press("ArrowLeft");
          const menuBounds = (await fileMenu.boundingBox())!;
          const fieldBounds = (await page.locator("#composer").boundingBox())!;
          expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(
            fieldBounds.y,
          );
          expect(menuBounds.y + menuBounds.height).toBeGreaterThan(
            fieldBounds.y - fieldBounds.height,
          );
          await screenshot(page, `explorer/${width}-composer-files`);
          if (width === 1280) await fileOption.click();
          else {
            await composer.press("ArrowDown");
            await composer.press("ArrowUp");
            await composer.press("Tab");
          }
          const chosen = "Review ``" + pickedPath + "`` ";
          expect(await composer.inputValue()).toBe(chosen);
          expect(await fileMenu.isVisible()).toBe(false);
          await screenshot(page, `explorer/${width}-composer-path`);
          const pickerReply = `Composer files ${width} received`;
          const pickerMessage = `${chosen}\nReply only ${pickerReply}`;
          await composer.fill(pickerMessage);
          const pickedDelivery = page.waitForRequest(
            (request) =>
              request.method() === "POST" &&
              new URL(request.url()).pathname ===
                `/api/conversations/${fixture.agent}/deliver`,
          );
          await page.locator("#send").click();
          expect((await pickedDelivery).postDataJSON().content).toBe(
            pickerMessage,
          );
          await page
            .locator("#messages .msg.assistant")
            .filter({ hasText: pickerReply })
            .waitFor();
          if (width === 412) {
            await openExplorer(page, width);
            const folder = pane.locator(".explorer-row", { hasText: "src" });
            await folder.waitFor();
            if ((await folder.getAttribute("aria-expanded")) !== "true")
              await folder.click();
            await pane
              .locator(".explorer-row", { hasText: "application.ts" })
              .waitFor();
          }
          const held = Promise.withResolvers<Route>();
          const heldPath = `**/api/conversations/${fixture.agent}/tree/file?*`;
          await page.route(heldPath, (route) => held.resolve(route));
          await pane
            .locator(".explorer-row", { hasText: "application.ts" })
            .click();
          const pending = await held.promise;
          await composer.fill("Review #pick");
          await fileOption.waitFor();
          const cancelled = page.waitForEvent("requestfailed", {
            predicate: (request) => request === pending.request(),
          });
          const heldSearch = Promise.withResolvers<Route>();
          const searchPath = `**/api/conversations/${fixture.agent}/tree/search?*`;
          await page.route(searchPath, (route) => heldSearch.resolve(route));
          await composer.fill("#onlyhere");
          const searching = await heldSearch.promise;
          const searchCancelled = page.waitForEvent("requestfailed", {
            predicate: (request) => request === searching.request(),
          });
          await page.evaluate(
            `location.hash = ${JSON.stringify(`#agent=${other.agent}`)}`,
          );
          await pane.waitFor({ state: "detached" });
          await fileMenu.waitFor({ state: "hidden" });
          await page.waitForFunction(
            "document.querySelector('#input').value === ''",
          );
          expect(await composer.inputValue()).toBe("");
          await pending.continue().catch(() => {});
          expect((await cancelled).failure()?.errorText).toContain(
            "ERR_ABORTED",
          );
          await page.unroute(heldPath);
          await searching.continue().catch(() => {});
          expect((await searchCancelled).failure()?.errorText).toContain(
            "ERR_ABORTED",
          );
          await page.unroute(searchPath);
          await openExplorer(page, width);
          await pane
            .locator(".explorer-row", { hasText: "only-here.txt" })
            .waitFor();
          expect(
            await pane
              .locator(".explorer-row", { hasText: "application.ts" })
              .count(),
          ).toBe(0);
          if (width === 412) {
            await pane
              .getByRole("button", { name: "Close Explorer", exact: true })
              .click();
            await pane.waitFor({ state: "hidden" });
          }
          await composer.fill("#pick");
          await fileMenu
            .getByText("No matching files.", { exact: true })
            .waitFor();
          expect(await fileMenu.getByRole("option").count()).toBe(0);
          await composer.fill("#onlyhere");
          await fileMenu
            .getByRole("option", { name: "only-here.txt", exact: true })
            .waitFor();
          expect(
            (await fileMenu.getByRole("option").allTextContents()).map((text) =>
              text.trim(),
            ),
          ).toEqual(["only-here.txt"]);
          await composer.press("Escape");
          expect(await composer.inputValue()).toBe("#onlyhere");
          expect(await fileMenu.isVisible()).toBe(false);
          expect(errors).toEqual([]);
        } catch (error) {
          testFailed = true;
          throw error;
        } finally {
          try {
            await context.close();
          } catch (error) {
            if (!testFailed) throw error;
            console.error(
              "Composer file mentions context cleanup failed",
              error,
            );
          }
        }
      }
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      try {
        retire(temporary, join(tmpdir(), ".trash"));
      } catch (error) {
        if (!testFailed) throw error;
        console.error("Composer file mentions workspace cleanup failed", error);
      }
    }
  },
  async function offlineMessagesPersistAndDeliverOnce(browser, base) {
    for (const width of [1280, 412]) {
      const agent = `offline-send-${width}`;
      await postFixture(base, "seed-model-selection-error", {
        agent,
        model: "fauxordinary/faux-1",
      });
      const { context, page } = await openPage(browser, {
        viewport: { width, height: 915 },
        touch: width === 412,
      });
      const deliveries: { content: string; client_message_id: string }[] = [];
      let blocked = false;
      let dropped = false;
      await context.route(`${base}api/**`, async (route) => {
        if (blocked) return route.abort("internetdisconnected");
        if (route.request().url().endsWith(`/conversations/${agent}/deliver`)) {
          deliveries.push(route.request().postDataJSON());
          if (!dropped) {
            dropped = true;
            await route.fetch();
            return route.abort("connectionreset");
          }
        }
        return route.continue();
      });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .locator("#conv-title")
          .filter({ hasText: "Choose a model" })
          .waitFor();
        blocked = true;
        await context.setOffline(true);
        const first = `Reply only Offline first ${width}`;
        const second = `Reply only Offline second ${width}`;
        for (const content of [first, second, "Remove this offline message"]) {
          await page.locator("#input").fill(content);
          await page.locator("#send").click();
          await browserExpect(page.locator("#input")).toHaveValue("");
          await page
            .locator(".msg.user.pending")
            .filter({ hasText: content })
            .waitFor();
        }
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: "Remove this offline message" })
          .getByRole("button", { name: "Remove queued message" })
          .click();
        await browserExpect(page.locator(".msg.user.pending")).toHaveCount(2);
        await screenshot(page, `composer/offline-pending-${width}`);
        const removable = "Remove this message after reload";
        await page.locator("#input").fill(removable);
        await page.locator("#send").click();
        await browserExpect(page.locator(".msg.user.pending")).toHaveCount(3);
        blocked = true;
        await context.setOffline(false);
        const failedRead = page.waitForEvent("requestfailed", {
          predicate: (request) =>
            new URL(request.url()).pathname === `/api/conversations/${agent}`,
        });
        await page.reload();
        await failedRead;
        await waitForLayout(page);
        await browserExpect(page.locator("#messages")).not.toHaveAttribute(
          "inert",
        );
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: removable })
          .getByRole("button", { name: "Remove queued message" })
          .click();
        await browserExpect(page.locator(".msg.user.pending")).toHaveCount(2);
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: first })
          .waitFor();
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: second })
          .waitFor();
        blocked = false;
        await page.evaluate(() =>
          (globalThis as any).dispatchEvent(new Event("online")),
        );
        for (const content of [first, second]) {
          await page
            .locator("#messages .msg.user:not(.pending)")
            .filter({ hasText: content })
            .waitFor();
        }
        await page
          .getByText(second.replace("Reply only ", ""), { exact: true })
          .waitFor();
        await browserExpect(
          page.locator("#messages .msg.user.pending"),
        ).toHaveCount(0);
        await browserExpect(
          page.locator("#messages .msg.user").filter({ hasText: first }),
        ).toHaveCount(1);
        await browserExpect(
          page.locator("#messages .msg.user").filter({ hasText: second }),
        ).toHaveCount(1);
        expect(deliveries.map((send) => send.content)).toEqual([
          first,
          first,
          second,
        ]);
        expect(deliveries[0]!.client_message_id).toBe(
          deliveries[1]!.client_message_id,
        );
        await screenshot(page, `composer/offline-delivered-${width}`);
      } finally {
        await context.close();
      }
    }
  },

  // Regression: #3563 tapping the composer outside shell details keeps native textarea focus.
  async function test_tap_composer_after_shell(browser, base) {
    const { agent } = await postFixture(base, "seed-live-tools", {
      mode: "background-output",
    });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.goto(`${base}#agent=${agent}`);
      const input = page.locator("#input");
      await input.fill("Run the shell tools.");
      await checkedTap(page.locator("#send"));
      const chip = page.locator("#status-bar .shell-chip");
      const surface = page.locator(".shell-surface");
      await checkedTap(chip);
      await surface.waitFor();
      await checkedTap(page.locator("#composer-wrap"), { x: 4, y: 4 });
      await surface.waitFor({ state: "hidden" });
      await browserExpect(chip).toBeFocused();
      await checkedTap(chip);
      await surface.waitFor();
      await checkedTap(input);
      await browserExpect(input).toBeFocused();
      await surface.waitFor({ state: "hidden" });
      await input.evaluate((field) =>
        field.addEventListener(
          "blur",
          () => {
            field.dataset.blurred = "true";
          },
          { once: true },
        ),
      );
      await checkedTap(chip);
      await surface.waitFor();
      await browserExpect(input, "shell chip keeps the caret").toBeFocused();
      await checkedTap(chip);
      await surface.waitFor({ state: "hidden" });
      const { agent: child } = await postFixture(base, "seed-live-tools", {
        parent: agent,
      });
      try {
        const delivered = await page.request.post(
          `${base}api/conversations/${child}/deliver`,
          { data: { content: "Run the background check." } },
        );
        expect(delivered.ok()).toBe(true);
        const agentChip = page.locator("#status-bar .agent-chip");
        await checkedTap(agentChip);
        await page
          .getByRole("dialog", { name: "Active agents for Live tools" })
          .waitFor();
        await browserExpect(input, "agent chip keeps the caret").toBeFocused();
        await checkedTap(agentChip);
        await surface.waitFor({ state: "hidden" });
        await checkedTap(agentChip);
        await surface.waitFor();
        await postFixture(base, "durable-thinking-cleanup", { agent: child });
        await surface.waitFor({ state: "hidden" });
        await browserExpect(input).toBeFocused();
        expect(await input.getAttribute("data-blurred")).toBeNull();
      } finally {
        await postFixture(base, "durable-thinking-cleanup", { agent: child });
      }
      const thread = page.locator("#messages");
      await checkedTap(thread.locator(".activity-group-toggle"));
      await checkedTap(thread.locator(".turn-series-toggle"));
      await checkedTap(thread.locator(".turn-tool-head").first());
      await checkedTap(
        thread
          .getByRole("region", { name: "Output", exact: true })
          .locator("pre"),
      );
      await checkedTap(input);
      await browserExpect(input).toBeFocused();
      await checkedTap(chip);
      await surface.waitFor();
      await page.keyboard.press("Escape");
      await surface.waitFor({ state: "hidden" });
      await browserExpect(input).toBeFocused();
      await checkedTap(chip);
      await surface.waitFor();
      await postFixture(base, "durable-thinking-cleanup", { agent });
      await surface.waitFor({ state: "hidden" });
      await browserExpect(input).toBeFocused();
    } finally {
      await postFixture(base, "durable-thinking-cleanup", { agent });
      await page.close();
    }
  },

  // Regression: #3564 composer controls must not blur a focused phone draft.
  async function test_effort_tap_keeps_phone_caret(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-context", {});
    const page = await browser.newPage({
      viewport: { width: 390, height: 540 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.goto(`${base}#agent=${agent}`);
      const input = page.locator("#input");
      await checkedTap(input);
      await input.fill("Keep this draft and caret.");
      await input.press("Home");
      await input.evaluate((node) =>
        node.addEventListener(
          "blur",
          () => {
            node.dataset.blurred = "true";
          },
          { once: true },
        ),
      );
      const trigger = page.getByRole("button", { name: "Choose effort level" });
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        checkedTap(page.getByRole("button", { name: "Attach file" })),
      ]);
      await chooser.setFiles([]);
      await browserExpect(input, "Attach keeps the caret").toBeFocused();
      await checkedTap(trigger);
      const popup = page.getByRole("dialog", { name: "Effort level" });
      await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
      await browserExpect(popup).toBeVisible();
      await browserExpect(input, "effort pill keeps the caret").toBeFocused();
      const range = popup.getByRole("slider", { name: "Effort level" });
      await browserExpect(range).toBeEnabled();
      const box = (await range.boundingBox())!;
      const before = await range.inputValue();
      const cdp = await page.context().newCDPSession(page);
      const { min, max } = await range.evaluate((el: HTMLInputElement) => ({
        min: el.min,
        max: el.max,
      }));
      const next = before === min ? max : min;
      const start =
        14 +
        ((Number(before) - Number(min)) / (Number(max) - Number(min))) *
          (box.width - 28);
      const end = next === min ? 14 : box.width - 14;
      const modelResponse = () =>
        page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname === `/api/conversations/${agent}/model`,
        );
      const origin = await checkedHitPoint(range, {
        x: start,
        y: box.height / 2,
      });
      const point = (x: number) => [{ x: origin.x + x - start, y: origin.y }];
      const saved = modelResponse();
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [origin],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point((start + end) / 2),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(end),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      expect((await saved).ok()).toBe(true);
      await browserExpect(range).toHaveValue(next);
      await browserExpect(
        input,
        "effort slider drag keeps the caret",
      ).toBeFocused();
      await browserExpect(range).toBeEnabled();
      const mouseOrigin = await checkedHitPoint(range, {
        x: end,
        y: box.height / 2,
      });
      await page.mouse.move(mouseOrigin.x, mouseOrigin.y);
      await page.mouse.down();
      await page.mouse.move(mouseOrigin.x + start - end, mouseOrigin.y);
      await page.mouse.up();
      await browserExpect(
        input,
        "effort slider mouse drag keeps the caret on a touch device",
      ).toBeFocused();
      expect(
        await input.evaluate((node: HTMLTextAreaElement) => [
          node.selectionStart,
          node.dataset.blurred,
        ]),
      ).toEqual([0, undefined]);
    } finally {
      await page.close();
    }
  },

  // Regression: #3565 the desktop context meter is reachable before the composer receives focus.
  async function test_compact_composer_targets(browser, base) {
    const { agent, tokens } = await postFixture(base, "seed-durable-context");
    for (const width of [390, 412, 1280]) {
      const mobile = width < 700;
      const { context, page } = await openPage(browser, {
        viewport: { width, height: 915 },
        touch: mobile,
      });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .locator(`#conv-title`)
          .filter({ hasText: "Recorded Durable context" })
          .waitFor();
        await page
          .locator("#context-indicator.on")
          .waitFor({ state: "attached" });
        await waitForLayout(page);
        const composer = page.locator("#composer");
        const input = page.locator("#input");
        const buttons = [page.locator("#attach"), page.locator("#send")];
        const centerY = ({ y, height }: { y: number; height: number }) =>
          y + height / 2;
        const expectAligned = async (state: string, ...centers: number[]) => {
          centers.push(
            ...(await Promise.all(
              buttons.map(async (button) =>
                centerY((await button.boundingBox())!),
              ),
            )),
          );
          expect(
            Math.max(...centers) - Math.min(...centers),
            `${width}px ${state}: centres ${centers.join(", ")}`,
          ).toBeLessThanOrEqual(1);
        };
        const textGeometry = () =>
          input.evaluate((field) => {
            const box = field.getBoundingClientRect();
            const style =
              field.ownerDocument.defaultView!.getComputedStyle(field);
            const lineHeight = parseFloat(style.lineHeight);
            const top =
              box.top +
              parseFloat(style.borderTopWidth) +
              parseFloat(style.paddingTop);
            const bottom =
              box.bottom -
              parseFloat(style.borderBottomWidth) -
              parseFloat(style.paddingBottom);
            return {
              lineHeight,
              contentHeight: bottom - top,
            };
          });
        const expectLines = async (count: number) => {
          const { contentHeight, lineHeight } = await textGeometry();
          expect(
            Math.abs(contentHeight - count * lineHeight),
          ).toBeLessThanOrEqual(1);
        };
        await expectLines(1);
        const surrounding = (await composer.boundingBox())!;
        const expectBottomRow = async () => {
          const field = (await input.boundingBox())!;
          const [attach, send] = await Promise.all(
            buttons.map((button) => button.boundingBox()),
          );
          expect(attach!.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
          expect(send!.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
          expect(attach!.x).toBeCloseTo(field.x, 0);
          expect(send!.x + send!.width).toBeCloseTo(field.x + field.width, 0);
          await expectAligned("bottom row");
          if (mobile) {
            for (const control of [
              ...buttons,
              composer.locator("#model-trigger"),
              composer.locator("#context-indicator"),
            ])
              await expectHitCorners(control, 44, { scroll: false });
            expect(
              await input.evaluate((el) => {
                const { left, right, top, bottom } = el.getBoundingClientRect();
                return [left + 2, right - 2].every((x) =>
                  [top + 2, bottom - 2].every(
                    (y) => document.elementFromPoint(x, y) === el,
                  ),
                );
              }),
            ).toBe(true);
          }
        };
        await browserExpect(input).not.toBeFocused();
        await visibleAndUncovered(page, "#model-trigger");
        await visibleAndUncovered(page, "#context-indicator");
        await expectBottomRow();
        if (mobile) await checkedTap(input);
        else await input.click();
        await browserExpect(input).toBeFocused();
        await expectBottomRow();
        expect(await composer.boundingBox()).toEqual(surrounding);
        if (mobile) {
          await page.setViewportSize({ width, height: 613 });
          await waitForLayout(page);
          await browserExpect(input).toBeFocused();
          await expectBottomRow();
          expect(await composer.boundingBox()).toEqual({
            ...surrounding,
            y: surrounding.y - 302,
          });
          const thread = page.locator("#scroll");
          expect(
            await thread.evaluate((el) => {
              const card = document.querySelector("#composer-card")!;
              return (
                el.getBoundingClientRect().bottom <=
                card.getBoundingClientRect().top
              );
            }),
          ).toBe(true);
          await thread.evaluate((el) => {
            el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
          });
          await waitForLayout(page);
          const offset = () => thread.evaluate((el) => el.scrollTop);
          const reading = await offset();
          expect(reading).toBeGreaterThan(0);
          for (const height of [540, 613]) {
            await page.setViewportSize({ width, height });
            await waitForLayout(page);
            await browserExpect(input).toBeFocused();
            expect(await offset()).toBe(reading);
          }
          await page.setViewportSize({ width, height: 915 });
          await waitForLayout(page);
        }
        await input.blur();
        await browserExpect(input).not.toBeFocused();
        await expectBottomRow();
        expect(await composer.boundingBox()).toEqual(surrounding);
        await input.fill("One-line draft");
        await input.blur();
        await browserExpect(input).not.toBeFocused();
        await expectBottomRow();
        await expectLines(1);
        const lines = ["First line", "Second line", "Third line", "Last line"];
        const draft = lines.join("\n");
        await input.fill(draft);
        await input.blur();
        await expectBottomRow();
        if (mobile) {
          for (const edge of ["left", "right"] as const) {
            await input.blur();
            const point = await input.evaluate((el, edge) => {
              const rect = el.getBoundingClientRect();
              return {
                x: rect[edge] + (edge === "left" ? 2 : -2),
                y: rect.bottom - 2,
              };
            }, edge);
            await page.touchscreen.tap(point.x, point.y);
            await browserExpect(input).toBeFocused();
            await browserExpect(input).toHaveValue(draft);
          }
        }
        await expectLines(lines.length);
        await browserExpect(buttons[1]!).toBeEnabled();
        const response = await page.request.get(
          `${base}api/conversations/${agent}/context-usage`,
        );
        expect(response.ok()).toBe(true);
        const { context_window: max } = await response.json();
        expect(max).toBeGreaterThan(tokens);
        const usage = `Context usage: ${tokens.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} tokens used`;
        const meter = composer.getByRole("meter", { name: usage, exact: true });
        await browserExpect(meter).toBeVisible();
        await browserExpect(meter).toHaveAttribute("aria-valuemin", "0");
        await browserExpect(meter).toHaveAttribute(
          "aria-valuemax",
          String(max),
        );
        await browserExpect(meter).toHaveAttribute(
          "aria-valuenow",
          String(tokens),
        );
        const fraction = await meter.evaluate(
          (el) =>
            parseFloat(
              el.ownerDocument.defaultView!.getComputedStyle(el, "::before")
                .width,
            ) / el.getBoundingClientRect().width,
        );
        expect(fraction).toBeCloseTo(tokens / max, 3);
        await browserExpect(
          composer.locator("#context-indicator"),
        ).toHaveAttribute("title", `${usage}. Open context details (Shift+C).`);
        await browserExpect(composer.locator("#context-control")).toHaveText(
          "",
        );
        await screenshot(page, `composer/composer-context-meter-${width}`);
        await expectAligned(
          "full bottom row",
          centerY((await meter.boundingBox())!),
          centerY((await composer.locator("#model-trigger").boundingBox())!),
        );
        for (const id of ["#attach", "#send"]) {
          const control = page.locator(id);
          const box = (await control.boundingBox())!;
          for (const x of [4, box.width - 4])
            for (const y of [4, box.height - 4])
              await checkedHitPoint(control, { x, y });
          if (mobile) await expectHitCorners(control);
        }
        if (mobile) {
          const turn = await postFixture(base, "seed-focused-settle", {
            recovery: width === 412,
          });
          const release = () =>
            postFixture(base, "release", { agent: turn.agent });
          try {
            await postFixture(base, "seed-model-response", {
              agent: turn.agent,
              downgrade: false,
            });
            await page.goto("about:blank");
            await page.goto(`${base}#agent=${turn.agent}`);
            await page.getByText("NORMAL_MODEL_OK", { exact: true }).waitFor();
            const send = page.locator("#send");
            await input.fill("Check the composer controls.");
            await input.blur();
            await checkedTap(send);
            await browserExpect(send).toHaveAccessibleName(/^Stop/);
            await browserExpect(input).not.toBeFocused();
            await browserExpect(
              composer.locator("#context-indicator"),
            ).toBeVisible();
            await expectBottomRow();
            await release();
            await browserExpect(page.locator("#messages")).toContainText(
              "The focused reply is complete.",
            );
            await browserExpect(send).toHaveAccessibleName(/^Send/);
            await expectBottomRow();
          } finally {
            await release();
          }
        }
      } finally {
        await context.close();
      }
    }
  },
  modelSelectionError,
  async function earlySendWaitsForSelection(browser, base) {
    const agent = "early-send-selection";
    const { context, page, errors } = await openPage(browser);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const deliveries: { path: string; content: string }[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/deliver"))
        deliveries.push({
          path: new URL(request.url()).pathname,
          content: request.postDataJSON().content,
        });
    });
    await page.route(`${base}api/tree*`, async (route) => {
      await held;
      await route.continue();
    });
    try {
      expect(
        (
          await context.request.post(
            `${base}__browser-test/seed-model-selection-error`,
            {
              data: { agent, model: "fauxordinary/faux-1" },
            },
          )
        ).ok(),
      ).toBeTrue();
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      const input = page.locator("#input:enabled");
      await input.waitFor();
      const content = "Reply only Boot send reached the selected agent.";
      await input.fill(content);
      await input.press("Enter");
      expect(await page.locator("#send-status").textContent()).toBe(
        "Waiting for this agent to load…",
      );
      expect(await page.locator("#send-status").isVisible()).toBeTrue();
      expect(deliveries).toEqual([]);
      release();
      await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
      await page
        .getByText("Boot send reached the selected agent.", { exact: true })
        .waitFor();
      expect(deliveries).toEqual([
        { path: `/api/conversations/${agent}/deliver`, content },
      ]);
      expect(errors).toEqual([]);
    } finally {
      release();
      await context.close();
    }
  },
  async function missingSendTargetFailsFast(browser, base) {
    const agent = "missing-send-target";
    const { context, page, errors } = await openPage(browser);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const deliveries: { content: string; client_message_id: string }[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(`/conversations/${agent}/deliver`))
        deliveries.push(request.postDataJSON());
    });
    try {
      expect(
        (
          await context.request.post(
            `${base}__browser-test/seed-model-selection-error`,
            {
              data: { agent, model: "fauxordinary/faux-1" },
            },
          )
        ).ok(),
      ).toBeTrue();
      await page.goto(`${base}#agent=${agent}`);
      await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
      const holdReads = async (route: Route) => {
        if (route.request().method() === "GET") await held;
        await route.continue();
      };
      await page.route(`${base}api/tree*`, holdReads);
      await page.route(`${base}api/conversations/${agent}**`, holdReads);
      expect(
        (
          await context.request.delete(`${base}api/conversations/${agent}`)
        ).status(),
      ).toBe(202);
      let missing = false;
      for (let i = 0; !missing && i < 80; i++) {
        missing =
          (
            await context.request.get(`${base}api/conversations/${agent}/view`)
          ).status() === 404;
        if (!missing) await Bun.sleep(100);
      }
      expect(missing).toBeTrue();
      const input = page.locator("#input:enabled");
      await input.fill("Keep this message for the missing agent.");
      await input.press("Enter");
      const status = page.locator("#send-status.error");
      await status.waitFor({ timeout: 8000 });
      expect(await status.textContent()).toBe(
        "This agent is no longer available. — Retry now",
      );
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].content).toBe(
        "Keep this message for the missing agent.",
      );
      const response = page.waitForResponse(
        `${base}api/conversations/${agent}/deliver`,
      );
      await status.click();
      expect((await response).status()).toBe(404);
      await status.waitFor();
      expect(deliveries.length).toBe(2);
      expect(deliveries[1]).toEqual(deliveries[0]);
      expect(errors).toEqual([]);
    } finally {
      release();
      await context.close();
    }
  },
  // Regression: #2964 a departed conversation's pending row read cannot replace a draft.
  async function test_draft_survives_departed_conversation_rows(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-clear");
    const page = await browser.newPage();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let requested = () => {};
    const rowRequested = new Promise<void>((resolve) => (requested = resolve));
    await page.route(
      (url) => url.pathname === `/api/conversations/${agent}/events`,
      (route) => route.abort(),
    );
    await page.route(`**/api/conversations/${agent}/view?**`, async (route) => {
      requested();
      await held;
      await route.continue();
    });
    try {
      expect(
        (
          await page.request.post(`${base}api/conversations/${agent}/deliver`, {
            data: { content: "Reply before I start a new draft." },
          })
        ).ok(),
      ).toBeTrue();
      await browserExpect
        .poll(async () =>
          (
            await page.request.get(`${base}api/conversations/${agent}/view`)
          ).text(),
        )
        .toContain("Before Durable clear.");
      const metadata = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/conversations/${agent}`,
      );
      await page.goto(`${base}#agent=${agent}`);
      await (await metadata).finished();
      await rowRequested;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const browser = globalThis as any;
            browser.requestAnimationFrame(() =>
              browser.requestAnimationFrame(() => resolve()),
            );
          }),
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("t");
      await page.keyboard.press("t");
      const draftHeading = page.getByRole("heading", { name: "New agent" });
      await draftHeading.waitFor();
      await page.locator("#input").fill("Keep my new draft");
      const rows = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${agent}/view`,
      );
      release();
      expect(await (await rows).text()).toContain("Before Durable clear.");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const browser = globalThis as any;
            browser.requestAnimationFrame(() =>
              browser.requestAnimationFrame(() => resolve()),
            );
          }),
      );
      await browserExpect(draftHeading).toBeVisible();
      expect(await page.locator("#input").inputValue()).toBe(
        "Keep my new draft",
      );
    } finally {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["composer", tests]]);
