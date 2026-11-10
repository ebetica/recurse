import { expect } from "bun:test";
import { mkdir, rename } from "node:fs/promises";
import {
  gotoRoot,
  postFixture,
  runBrowserTests,
  startNewAgent,
  waitForLayout,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3208 Initial desktop sizing must preserve native composer input and caret.
  async function test_composer_typing_after_desktop_mount(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let releaseDock!: () => void;
    const dockStyle = new Promise<void>((resolve) => (releaseDock = resolve));
    await page.route("**/static/dockview.css", async (route) => {
      await dockStyle;
      await route.continue();
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    const input = page.locator("#input");
    try {
      await input.selectText();
      const mounted = page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const document = (globalThis as any).document;
            const observer = new (globalThis as any).MutationObserver(() => {
              if (!document.querySelector("#dock #main")) return;
              observer.disconnect();
              resolve();
            });
            observer.observe(document.body, { childList: true, subtree: true });
          }),
      );
      releaseDock();
      await mounted;
      await page.keyboard.insertText("/revive");
      await page
        .locator("#skill-menu .skill-option.action", { hasText: "/revive" })
        .waitFor();
      expect(await input.inputValue()).toBe("/revive");
      expect(await input.evaluate((node: any) => node.selectionStart)).toBe(7);
    } finally {
      releaseDock();
      await context.close();
    }
  },
  // Regression: #3231 Imported browser history must support a later fake-provider reply.
  async function test_imported_artifact_history_can_continue(browser, base) {
    await postFixture(base, "seed-artifact-app");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = await context.newPage();
      await gotoRoot(page, base);
      const input = page.locator("#input");
      await input.fill("Reply only Imported history can continue.");
      await input.press("Enter");
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "Imported history can continue." })
        .waitFor();
    } finally {
      await context.close();
    }
  },
  // Regression: #2314 #3239 #3241 Window keys preserve native input and useful badges.
  async function test_pane_focus_and_visibility_keys(browser, base) {
    await postFixture(base, "seed-model-selection-error", {
      agent: "dock-focus-send",
      model: "fauxordinary/faux-1",
    });
    await postFixture(base, "seed-artifact-app");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let releaseDock!: () => void;
    const dockStyle = new Promise<void>((resolve) => (releaseDock = resolve));
    await page.route("**/static/dockview.css", async (route) => {
      await dockStyle;
      await route.continue();
    });
    await gotoRoot(page, base);
    const pane = page.locator('.pane-col[data-pane="report"]');
    await pane.waitFor();
    const thread = page.locator("#scroll");
    const focusThread = async () => {
      await thread.evaluate((node: any) => {
        node.tabIndex = -1;
        node.focus();
      });
    };
    const focused = async (selector: string) => {
      await page.waitForFunction(
        (selector) =>
          (globalThis as any).document.activeElement?.matches(selector),
        selector,
      );
    };
    const input = page.locator("#input");
    try {
      await input.fill("Keep this draft while desktop windows load");
      await input.evaluate((input: any) => input.setSelectionRange(5, 9));
    } finally {
      releaseDock();
    }
    await page.locator("#dock #main").waitFor();
    await focused("#input");
    expect(await input.inputValue()).toBe(
      "Keep this draft while desktop windows load",
    );
    expect(
      await input.evaluate((input: any) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([5, 9]);
    await input.fill("");
    await page.locator('#dock .dv-tab[data-dock-panel="chat"]').waitFor();
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    const explorer = page.locator('.pane-col[data-pane="explorer"]');
    await explorer.waitFor();
    const modeBadge = page.locator("#key-mode");
    await page.locator("#model-trigger").click();
    await page.locator("#model-menu").waitFor();
    await focused("#model-menu");
    expect(await modeBadge.isVisible()).toBeFalse();
    await page.keyboard.press("Escape");
    await page.locator("#model-menu").waitFor({ state: "hidden" });
    const fileSearch = explorer.locator("#explorer-search");
    await fileSearch.focus();
    expect(await modeBadge.isVisible()).toBeFalse();
    await page.keyboard.type("z");
    expect(await fileSearch.inputValue()).toBe("z");
    await fileSearch.fill("");
    const windows = await page.locator("#dock .dv-groupview").count();
    const cursor = await page
      .locator('.agent[aria-selected="true"]')
      .getAttribute("data-id");
    await thread.click({ position: { x: 24, y: 160 } });
    await page.keyboard.press("j");
    await page.waitForFunction(
      (before) =>
        (globalThis as any).document
          .querySelector('.agent[aria-selected="true"]')
          ?.getAttribute("data-id") !== before,
      cursor,
    );
    expect(await page.locator("#key-mode").innerText()).toBe("Normal");
    expect(await modeBadge.isVisible()).toBeTrue();
    expect(await page.locator("#dock .dv-groupview").count()).toBe(windows);
    await page.keyboard.press("k");
    await page.keyboard.press("i");
    await focused("#input");
    await page.locator("#input").fill("Keep this draft while windows move");
    await page
      .locator("#input")
      .evaluate((input: any) => input.setSelectionRange(5, 9));
    const explorerTab = page.locator(
      '#dock .dv-tab[data-dock-panel="explorer"]',
    );
    const group = explorerTab.locator(
      "xpath=ancestor::div[contains(@class, 'dv-groupview')]",
    );
    const box = (await group.boundingBox())!;
    await explorerTab.dragTo(page.locator("body"), {
      targetPosition: { x: box.x + box.width / 2, y: box.y + box.height - 12 },
    });
    await page.waitForFunction(
      (count) =>
        (globalThis as any).document.querySelectorAll("#dock .dv-groupview")
          .length > count,
      windows,
    );
    await focused("#input");
    expect(await page.locator("#input").inputValue()).toBe(
      "Keep this draft while windows move",
    );
    expect(
      await page
        .locator("#input")
        .evaluate((input: any) => [input.selectionStart, input.selectionEnd]),
    ).toEqual([5, 9]);
    await explorerTab.click();
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    expect(await page.locator("#key-mode").innerText()).toBe("Pane");
    await page.keyboard.press("h");
    expect(await explorer.isVisible()).toBeTrue();
    await page.keyboard.press("q");
    await explorer.waitFor({ state: "detached" });
    expect(await pane.isVisible()).toBeTrue();
    await page.locator("#input").fill("");
    await pane.locator(".pane-body").focus();
    await focusThread();
    await page.keyboard.press("g");
    await page.keyboard.press("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(
      await pane.evaluate(
        (el: any) => (globalThis as any).getComputedStyle(el).outlineStyle,
      ),
    ).toBe("none");
    expect(
      await pane
        .locator(".pane-body")
        .evaluate(
          (el: any) => (globalThis as any).getComputedStyle(el).outlineStyle,
        ),
    ).toBe("none");
    expect(await pane.isVisible()).toBeTrue();
    const go = async (key: string) => {
      await page.keyboard.press("g");
      await page.locator("#window-key-hints").waitFor({ state: "visible" });
      await page.keyboard.press(key);
      await page.locator("#window-key-hints").waitFor({ state: "hidden" });
    };
    const arrange = async (key: string) => {
      await page.keyboard.press("w");
      await page.locator("#window-key-hints").waitFor({ state: "visible" });
      await page.keyboard.press(key);
      await page.locator("#window-key-hints").waitFor({ state: "hidden" });
    };
    const tab = (id: string) =>
      page.locator(`#dock .dv-tab[data-dock-panel="${id}"]`);
    const windowBox = async (id: string) =>
      (await tab(id)
        .locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]")
        .boundingBox())!;
    const shot = async (name: string) => {
      const dir = process.env.RECURSE_SCREENSHOT_DIR;
      if (dir) {
        await mkdir(dir, { recursive: true });
        await page.screenshot({ path: `${dir}/1280-window-${name}.png` });
      }
    };
    await page.keyboard.press("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    const appCounter = pane.frameLocator("iframe").locator("#count");
    await appCounter.click();
    expect(await appCounter.innerText()).toBe("1");
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("z");
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    await appCounter.focus();
    await page.keyboard.press("z");
    await page
      .locator('.pane-col[data-pane="report"]:not(.fullscreen)')
      .waitFor();
    await focusThread();
    await page.keyboard.press("z");
    expect(await page.locator("#main").getAttribute("class")).toContain(
      "fullscreen",
    );
    await input.focus();
    await page.keyboard.type("z");
    expect(await input.inputValue()).toBe("z");
    expect(await page.locator("#main").getAttribute("class")).toContain(
      "fullscreen",
    );
    await input.fill("");
    await page.locator("#main button:visible:enabled").first().focus();
    await page.keyboard.press("z");
    expect(await page.locator("#main").getAttribute("class")).not.toContain(
      "fullscreen",
    );
    await pane.locator(".pane-body").focus();
    await go("h");
    await focused("#scroll");
    await go("l");
    await focused('.pane-col[data-pane="report"] .pane-body');
    await appCounter.click();
    expect(await appCounter.innerText()).toBe("2");
    await arrange("Shift+H");
    expect((await windowBox("report")).x).toBeLessThan(
      (await windowBox("chat")).x,
    );
    await go("h");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await page.locator("#key-mode").textContent()).toBe("Pane");
    await appCounter.click();
    expect(await appCounter.innerText()).toBe("3");
    await arrange("Shift+L");
    expect((await windowBox("report")).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    expect(await appCounter.innerText()).toBe("3");
    await focused('.pane-col[data-pane="report"] .pane-body');
    await arrange("t");
    await arrange("Shift+H");
    await arrange("Shift+L");
    expect((await windowBox("report")).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    await shot("focus-artifacts");
    await go("h");
    await focused("#scroll");
    await shot("focus-chat");
    await page.keyboard.press("p");
    await focused("#input");
    expect(await input.inputValue()).toBe("p");
    await input.fill("");
    await page.keyboard.type("gh wL gp");
    expect(await input.inputValue()).toBe("gh wL gp");
    await input.fill("");
    await page.keyboard.press("Escape");
    await focusThread();
    await go("l");
    await focused('.pane-col[data-pane="report"] .pane-body');
    await go("p");
    await focused("#scroll");
    await go("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    const tipsClose = tab("tips").getByRole("button");
    if (await tipsClose.count()) {
      await tab("tips").hover();
      await tipsClose.click();
    }
    await focusThread();
    await arrange("v");
    await page
      .getByText("Next window opens to the right", { exact: true })
      .waitFor();
    await tab("report").locator(".dock-tab-icon").click();
    expect(
      await page
        .getByText("Next window opens to the right", { exact: true })
        .isVisible(),
    ).toBeTrue();
    await page.keyboard.press("Escape");
    expect(await page.locator(".dock-opening-hint:visible").count()).toBe(0);
    await focusThread();
    await arrange("v");
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await focused("#explorer-search");
    await page.keyboard.press("Escape");
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    expect((await windowBox("explorer")).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    expect(await page.locator(".dock-opening-hint:visible").count()).toBe(0);
    await arrange("q");
    await explorer.waitFor({ state: "detached" });
    await focusThread();
    await arrange("s");
    await page.getByText("Next window opens below", { exact: true }).waitFor();
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await focused("#explorer-search");
    await page.keyboard.press("Escape");
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    expect((await windowBox("explorer")).y).toBeGreaterThan(
      (await windowBox("chat")).y,
    );
    await pane.locator("iframe").waitFor({ state: "attached" });
    const retainedFrame = await pane.locator("iframe").elementHandle();
    await arrange("e");
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    expect((await windowBox("explorer")).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    await arrange("e");
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    expect((await windowBox("explorer")).y).toBeGreaterThan(
      (await windowBox("chat")).y,
    );
    const heightBefore = (await windowBox("explorer")).height;
    await arrange("r");
    expect(await page.locator("#key-mode").textContent()).toBe("Resize");
    await page.keyboard.press("j");
    await page.waitForFunction(
      (height) =>
        (globalThis as any).document
          .querySelector('#dock .dv-tab[data-dock-panel="explorer"]')
          .closest(".dv-groupview")
          .getBoundingClientRect().height > height,
      heightBefore,
    );
    const taller = (await windowBox("explorer")).height;
    await page.keyboard.press("k");
    await page.waitForFunction(
      (height) =>
        (globalThis as any).document
          .querySelector('#dock .dv-tab[data-dock-panel="explorer"]')
          .closest(".dv-groupview")
          .getBoundingClientRect().height < height,
      taller,
    );
    await page.keyboard.press("Escape");
    expect(await page.locator("#key-mode").textContent()).toBe("Pane");
    await arrange("t");
    expect(await page.locator("#dock .dv-groupview").count()).toBe(2);
    await arrange("t");
    expect(await page.locator("#dock .dv-groupview").count()).toBe(1);
    await arrange("e");
    expect(await page.locator("#dock .dv-groupview").count()).toBe(3);
    const chatDrop = (await tab("chat").boundingBox())!;
    await tab("explorer").dragTo(tab("chat"), {
      targetPosition: { x: chatDrop.width - 2, y: chatDrop.height / 2 },
    });
    await tab("report").locator(".dock-tab-icon").click();
    await go("h");
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    await go("h");
    await focused("#scroll");
    await go("l");
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    await go("l");
    await focused('.pane-col[data-pane="report"] .pane-body');
    for (const [left, right, down, up] of [
      ["h", "l", "j", "k"],
      ["Shift+H", "Shift+L", "Shift+J", "Shift+K"],
    ]) {
      await arrange("t");
      await arrange(left);
      expect((await windowBox("report")).x).toBeLessThan(
        (await windowBox("chat")).x,
      );
      await arrange(right);
      expect((await windowBox("report")).x).toBeGreaterThan(
        (await windowBox("chat")).x,
      );
      await arrange("t");
      await appCounter.focus();
      await arrange(down);
      expect((await windowBox("report")).y).toBeGreaterThan(
        (await windowBox("chat")).y,
      );
      await tab("chat").locator(".dock-tab-icon").click();
      await go("j");
      await focused('.pane-col[data-pane="report"] .pane-body');
      await go("k");
      await focused("#scroll");
      await go("j");
      await appCounter.focus();
      await arrange(up);
      expect((await windowBox("report")).y).toBeLessThan(
        (await windowBox("chat")).y,
      );
    }
    await arrange("t");
    await arrange("e");
    await tab("explorer").locator(".dock-tab-icon").click();
    await arrange("q");
    await explorer.waitFor({ state: "detached" });
    await pane.locator(".pane-body").focus();
    const beforeOnly = await page
      .locator("#dock .dv-groupview")
      .evaluateAll((groups) =>
        groups.map((group) => {
          const box = group.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height].map(Math.round);
        }),
      );
    await arrange("o");
    expect(await page.locator("#dock .dv-groupview:visible").count()).toBe(1);
    await arrange("o");
    expect(
      await page.locator("#dock .dv-groupview").evaluateAll((groups) =>
        groups.map((group) => {
          const box = group.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height].map(Math.round);
        }),
      ),
    ).toEqual(beforeOnly);
    await tab("chat").locator(".dock-tab-icon").click();
    await arrange("o");
    await arrange("f");
    await page.locator("#main.fullscreen").waitFor();
    const fullChat = await page.locator("#main").boundingBox();
    expect(fullChat!.width).toBe(1280);
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () => !!(globalThis as any).document.activeElement.closest("#main"),
      ),
    ).toBeTrue();
    await focusThread();
    await arrange("f");
    expect(await page.locator("#main").getAttribute("class")).not.toContain(
      "fullscreen",
    );
    expect(await page.locator("#dock .dv-groupview:visible").count()).toBe(1);
    await arrange("o");
    await input.fill("Keep this draft through window layout changes");
    await input.evaluate((node: any) => node.setSelectionRange(5, 9));
    await page.keyboard.press("Escape");
    await pane.locator(".pane-body").focus();
    await arrange("t");
    await arrange("=");
    await arrange("e");
    expect((await windowBox("report")).y).not.toBe((await windowBox("chat")).y);
    expect((await windowBox("report")).x).toBe((await windowBox("chat")).x);
    await arrange("e");
    expect((await windowBox("report")).x).not.toBe((await windowBox("chat")).x);
    await arrange("=");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(
      await pane
        .locator("iframe")
        .evaluate((node, retained) => node === retained, retainedFrame),
    ).toBeTrue();
    expect(await appCounter.innerText()).toBe("3");
    expect(await input.inputValue()).toBe(
      "Keep this draft through window layout changes",
    );
    expect(
      await input.evaluate((node: any) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([5, 9]);
    await input.fill("");
    await pane.locator(".pane-body").focus();
    await go("p");
    await focused("#scroll");
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("o");
    await focused("#pane-finder-query");
    const finderQuery = page.locator("#pane-finder-query");
    for (const [width, height] of [
      [1280, 800],
      [1920, 1080],
      [1280, 600],
      [1280, 400],
    ]) {
      await page.setViewportSize({ width, height });
      const queryBox = (await finderQuery.boundingBox())!;
      expect(queryBox.y).toBeGreaterThan(height * 0.25);
      expect(queryBox.y).toBeLessThan(height * 0.5);
      const finderBox = (await page.locator("#pane-finder").boundingBox())!;
      expect(finderBox.y).toBeGreaterThanOrEqual(0);
      expect(finderBox.y + finderBox.height).toBeLessThanOrEqual(height);
      const dir = process.env.RECURSE_SCREENSHOT_DIR;
      if (dir && height >= 800) {
        await mkdir(dir, { recursive: true });
        await page.screenshot({
          path: `${dir}/${width}x${height}-pane-finder.png`,
        });
      }
      await finderQuery.fill("arfs");
      await page
        .locator("#pane-finder .pane-option", { hasText: "Artifacts" })
        .waitFor();
      expect((await finderQuery.boundingBox())!.y).toBe(queryBox.y);
      await finderQuery.fill("");
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(await pane.isVisible()).toBeTrue();
    expect(
      await page
        .getByRole("option", { name: "Chat Open", exact: true })
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator("#pane-finder .pane-option", { hasText: "Artifacts" })
        .textContent(),
    ).toContain("Open");
    await page.keyboard.press("Escape");
    await focused("#scroll");
    expect(await page.locator("#key-mode").textContent()).toBe("Normal");
    await go("p");
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await focusThread();
    await page.keyboard.press("o");
    await page.locator("#pane-finder-query").fill("arfs");
    await page.keyboard.press("Enter");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("x");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await page.locator("#input").inputValue()).toBe("");
    await page.keyboard.press("i");
    await focused("#input");
    await page.keyboard.press("Escape");
    await focusThread();
    await go("p");
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await focusThread();
    await page.keyboard.press("o");
    expect(
      await page.locator("#pane-finder .pane-option").first().textContent(),
    ).toContain("Explorer");
    await page.keyboard.press("Enter");
    await focused("#explorer-search");
    await page.keyboard.press("Escape");
    await focused('.pane-col[data-pane="explorer"] .pane-body');
    await page.keyboard.press("q");
    await explorer.waitFor({ state: "detached" });
    await focusThread();
    await page.keyboard.press("o");
    await page.locator("#pane-finder-query").fill("arfs");
    await page.keyboard.press("Enter");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("Escape");
    await focused(".agent");
    expect(await pane.isVisible()).toBeTrue();
    await focusThread();
    await go("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    await page.keyboard.press("z");
    await pane.locator('.fs[aria-pressed="true"]').waitFor();
    await page.keyboard.press("o");
    await finderQuery.fill("Chat");
    await page.keyboard.press("Enter");
    await focused("#scroll");
    expect(await pane.getAttribute("class")).not.toContain("fullscreen");
    await go("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    await arrange("o");
    expect(await page.locator("#dock .dv-groupview:visible").count()).toBe(1);
    await page.keyboard.press("o");
    await finderQuery.fill("Chat");
    await page.keyboard.press("Enter");
    await focused("#scroll");
    expect(await page.locator("#dock .dv-groupview:visible").count()).toBe(2);
    await go("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await pane.getAttribute("class")).not.toContain("fullscreen");
    await page.keyboard.press("z");
    await pane.locator('.fs[aria-pressed="true"]').waitFor();
    await page.keyboard.press("Escape");
    await focused(".agent");
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    const sidebar = page.locator("#sidebar");
    await page.keyboard.press("Shift+H");
    expect(await sidebar.isVisible()).toBeFalse();
    await focused("#scroll");
    await page.keyboard.press("Shift+H");
    expect(await sidebar.isVisible()).toBeTrue();
    await focused("#scroll");
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("Shift+H");
    expect(await sidebar.isVisible()).toBeFalse();
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("Shift+H");
    expect(await sidebar.isVisible()).toBeTrue();
    await focused('.pane-col[data-pane="report"] .pane-body');
    await page.keyboard.press("i");
    await focused("#input");
    expect(await pane.getAttribute("class")).not.toContain("fullscreen");
    expect(await page.locator("#key-mode").textContent()).toBe("Insert");
    await page.keyboard.press("Escape");
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("h");
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await focused(".agent");
    await page.locator('.rail-btn[data-pane="report"]').click();
    const reportTab = page.locator('#dock .dv-tab[data-dock-panel="report"]');
    const chatTab = page.locator('#dock .dv-tab[data-dock-panel="chat"]');
    await reportTab.dragTo(chatTab);
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelectorAll("#dock .dv-groupview")
          .length === 1,
    );
    await reportTab.click();
    await focused('.pane-col[data-pane="report"] .pane-body');
    await page.keyboard.press("o");
    await focused("#pane-finder-query");
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("Escape");
    await focused('.pane-col[data-pane="report"] .pane-body');
    await page.keyboard.press("Escape");
    await focused(".agent");
    await page.keyboard.press("f");
    await focused("#agent-finder-query");
    const agentQueryBox = (await page
      .locator("#agent-finder-query")
      .boundingBox())!;
    expect(agentQueryBox.y).toBeGreaterThan(800 * 0.25);
    expect(agentQueryBox.y).toBeLessThan(800 * 0.5);
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("Escape");
    await focused(".agent");
    await page.keyboard.press("i");
    await focused("#input");
    expect(await pane.isVisible()).toBeFalse();
    await page.waitForFunction(() => {
      const title = (globalThis as any).document.querySelector(
        '#dock .dv-tab[data-dock-panel="report"] .dv-default-tab-content',
      );
      return title && title.getBoundingClientRect().width > 0;
    });
    await reportTab.hover();
    await reportTab
      .getByRole("button", { name: "Close Artifacts", exact: true })
      .click();
    await pane.waitFor({ state: "detached" });
    await page.goto(`${base}#agent=dock-focus-send`);
    await page.locator('.agent.selected[data-id="dock-focus-send"]').waitFor();
    const finderDraft = "Keep this draft when Chat reopens from the finder";
    const chatVisits = await page.evaluate(
      () =>
        (
          JSON.parse(
            (globalThis as any).localStorage.getItem("recurse.pane-history") ||
              "[]",
          ) as any[]
        ).find((entry) => entry.id === "chat")?.count || 0,
    );
    await input.fill(finderDraft);
    await input.press("Escape");
    await page.locator('#dock .dv-tab[data-dock-panel="chat"] button').click();
    await page.locator(".dock-parking #main").waitFor({ state: "attached" });
    await page.keyboard.press("o");
    await focused("#pane-finder-query");
    expect(await page.locator(".dock-parking #main").count()).toBe(1);
    await finderQuery.fill("Chat");
    const chatOption = page.getByRole("option", { name: "Chat", exact: true });
    await chatOption.waitFor();
    expect(await chatOption.locator(".agent-option-relation").count()).toBe(0);
    await page.keyboard.press("Enter");
    await focused("#scroll");
    await chatTab.waitFor();
    expect(await chatTab.getAttribute("class")).toContain("dv-active-tab");
    expect(await input.inputValue()).toBe(finderDraft);
    await page.keyboard.press("o");
    await finderQuery.fill("Chat");
    await page
      .getByRole("option", { name: "Chat Open", exact: true })
      .waitFor();
    expect(
      await page.locator("#pane-finder .pane-option-icon").innerHTML(),
    ).toBe(await chatTab.locator(".dock-tab-icon").innerHTML());
    await finderQuery.fill("");
    expect(
      await page.evaluate(
        () =>
          (
            JSON.parse(
              (globalThis as any).localStorage.getItem(
                "recurse.pane-history",
              ) || "[]",
            ) as any[]
          ).find((entry) => entry.id === "chat")?.count || 0,
      ),
    ).toBeGreaterThan(chatVisits);
    const screenshotDir = process.env.RECURSE_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({
        path: `${screenshotDir}/1280x800-chat-finder.png`,
      });
    }
    await page.keyboard.press("Escape");
    await page.locator('#dock .dv-tab[data-dock-panel="chat"] button').click();
    await page.keyboard.press("f");
    await focused("#agent-finder-query");
    expect(await page.locator(".dock-parking #main").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("i");
    await focused("#input");
    await page.locator("#input").fill("Reply only Docked chat can send.");
    await page.locator("#input").press("Enter");
    await page
      .locator(".msg.assistant")
      .filter({ hasText: "Docked chat can send." })
      .waitFor();
    const splitLayout = [["chat"], ["explorer"]];
    const tabbedLayout = [["chat", "explorer"]];
    const waitLayout = (expected: string[][]) =>
      page.waitForFunction((expected) => {
        const groups = [
          ...(globalThis as any).document.querySelectorAll(
            "#dock .dv-groupview",
          ),
        ].map((group: any) =>
          [...group.querySelectorAll(".dv-tab[data-dock-panel]")].map(
            (tab: any) => tab.dataset.dockPanel,
          ),
        );
        return JSON.stringify(groups.sort()) === JSON.stringify(expected);
      }, expected);
    const storedLayout = (
      owner: string,
      expected: string[][],
      maximized?: boolean,
      minChatWidth?: number,
    ) =>
      page.waitForFunction(
        ({ owner, expected, maximized, minChatWidth }) => {
          const storage = (globalThis as any).localStorage;
          return Object.keys(storage).some((key) => {
            if (!key.startsWith("recurse.conversationUiState.local.v1.slot."))
              return false;
            const record = JSON.parse(storage.getItem(key));
            if (record.owner !== owner) return false;
            const layout = record.panes?.["window-layout"]?.value;
            if (!layout?.grid) return false;
            if (
              maximized !== undefined &&
              Array.isArray(layout.grid.maximizedNode?.location) !== maximized
            )
              return false;
            const groups: string[][] = [];
            let chatWidth = 0;
            const visit = (node: any) => {
              if (node.type === "branch") node.data.forEach(visit);
              else {
                groups.push(node.data.views);
                if (node.data.views.includes("chat")) chatWidth = node.size;
              }
            };
            visit(layout.grid.root);
            return (
              JSON.stringify(groups.sort()) === JSON.stringify(expected) &&
              (minChatWidth === undefined || chatWidth > minChatWidth)
            );
          });
        },
        { owner, expected, maximized, minChatWidth },
      );
    const joinExplorer = async () => {
      const bounds = (await chatTab.boundingBox())!;
      await explorerTab.dragTo(chatTab, {
        targetPosition: { x: bounds.width - 2, y: bounds.height / 2 },
      });
      await waitLayout(tabbedLayout);
      await chatTab.locator(".dock-tab-icon").click();
    };
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await joinExplorer();
    await input.fill("B layout draft");
    await page.locator('.agent[data-id="main"]').click();
    await page.locator('.agent.selected[data-id="main"]').waitFor();
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await waitLayout(splitLayout);
    await page.locator('.agent[data-id="dock-focus-send"]').click();
    await page.locator('.agent.selected[data-id="dock-focus-send"]').waitFor();
    await waitLayout(tabbedLayout);
    expect(await input.inputValue()).toBe("B layout draft");
    await storedLayout("dock-focus-send", tabbedLayout);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout(tabbedLayout);
    await page.locator('.agent[data-id="main"]').click();
    await page.locator('.agent.selected[data-id="main"]').waitFor();
    await waitLayout(splitLayout);
    await storedLayout("main", splitLayout);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout(splitLayout);
    const widthBeforeSash = (await windowBox("chat")).width;
    const sash = (await page
      .locator("#dock .dv-sash:visible")
      .first()
      .boundingBox())!;
    const sashX = sash.x + sash.width / 2;
    const sashY = sash.y + sash.height / 2;
    await page.mouse.move(sashX, sashY);
    await page.mouse.down();
    await page.mouse.move(sashX + 64, sashY, { steps: 3 });
    await page.mouse.up();
    await storedLayout("main", splitLayout, undefined, widthBeforeSash + 40);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout(splitLayout);
    expect((await windowBox("chat")).width).toBeGreaterThan(
      widthBeforeSash + 40,
    );
    await shot("conversation-a");
    await page.locator('.agent[data-id="dock-focus-send"]').click();
    await page.locator('.agent.selected[data-id="dock-focus-send"]').waitFor();
    await waitLayout(tabbedLayout);
    for (const kind of [
      "renderer",
      "legacy-renderer",
      "hidden-group",
      "hidden-window",
      "oversized",
    ]) {
      console.log("Window layout corruption:", kind);
      await storedLayout(
        "dock-focus-send",
        kind === "renderer" ? tabbedLayout : splitLayout,
      );
      await page.locator('.agent[data-id="main"]').click();
      await waitLayout(splitLayout);
      await page.evaluate(
        ({ owner, kind }) => {
          const storage = (globalThis as any).localStorage;
          for (const key of Object.keys(storage)) {
            if (!key.startsWith("recurse.conversationUiState.local.v1.slot."))
              continue;
            const record = JSON.parse(storage.getItem(key));
            if (record.owner !== owner) continue;
            const layout =
              record.panes?.["window-layout"]?.value ||
              (record.key === "window-layout" ? record.value : null);
            if (!layout?.panels?.explorer) continue;
            if (kind === "renderer")
              layout.panels.explorer.contentComponent = "unregistered-renderer";
            else if (kind === "legacy-renderer")
              layout.panels.explorer.view = {
                content: { id: "unregistered-renderer" },
                tab: { id: "tab" },
              };
            else if (kind === "oversized")
              layout.panels.explorer.title = "x".repeat(32_001);
            else {
              const nodes = [layout.grid.root];
              while (nodes.length) {
                const node = nodes.pop();
                if (node.type === "branch") nodes.push(...node.data);
                else if (
                  node.data.views.includes(
                    kind === "hidden-group" ? "explorer" : "chat",
                  )
                ) {
                  if (kind === "hidden-group") node.data.hideHeader = true;
                  else node.visible = false;
                }
              }
            }
            storage.setItem(key, JSON.stringify(record));
          }
        },
        { owner: "dock-focus-send", kind },
      );
      const response = await page.reload({ waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      await waitLayout(splitLayout);
      await page.locator('.agent[data-id="dock-focus-send"]').click();
      await page
        .locator('.agent.selected[data-id="dock-focus-send"]')
        .waitFor();
      await waitLayout(splitLayout);
      await thread.waitFor();
      await chatTab.waitFor();
      await explorerTab.waitFor();
      expect(await explorerTab.getAttribute("aria-label")).toBe("Explorer");
      await explorerTab.click();
      await chatTab.click();
    }
    await joinExplorer();
    await storedLayout("dock-focus-send", tabbedLayout);
    await page.setViewportSize({ width: 390, height: 844 });
    await focused('.pane-col[data-pane="explorer"] .pane-title');
    await page.keyboard.press("o");
    await finderQuery.fill("Chat");
    await page.getByRole("option", { name: "Chat", exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await focused("#scroll");
    await explorer.waitFor({ state: "detached" });
    await page.keyboard.press("o");
    await finderQuery.fill("Chat");
    await page
      .getByRole("option", { name: "Chat Open", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator(".msg.assistant")
      .filter({ hasText: "Docked chat can send." })
      .waitFor();
    expect(await page.locator("#dock").count()).toBe(0);
    await input.fill("B layout draft");
    await input.evaluate((node: any) => node.setSelectionRange(2, 8));
    expect(
      await input.evaluate((node: any) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([2, 8]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitLayout(tabbedLayout);
    await focused("#input");
    expect(await input.inputValue()).toBe("B layout draft");
    expect(
      await input.evaluate((node: any) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([2, 8]);
    await shot("conversation-b");
    const { demo: autoOwner } = await postFixture(base, "seed-files-auto-open");
    const publishAutomatic = async () =>
      ((await postFixture(base, "republish-auto-open")) as { draft: number })
        .draft;
    await page.locator(`.agent[data-id="${autoOwner}"]`).click();
    await page.locator('.rail-btn[data-pane="files"]').waitFor();
    const automaticFiles = page.locator(".pane-col.file-tab");
    expect(await automaticFiles.count()).toBe(0);
    await page
      .locator("#conv-title", { hasText: "Auto-opened files" })
      .waitFor();
    await page.keyboard.press("w");
    await page.keyboard.press("o");
    await storedLayout(autoOwner, [["chat"]], true);
    const autoHeading = automaticFiles.locator(
      ".files-detail .files-markdown h1",
    );
    const autoFirst = await publishAutomatic();
    await autoHeading
      .filter({ hasText: `Draft ${autoFirst}` })
      .waitFor({ state: "attached" });
    for (let version = 0; version < 2; version++) {
      const latest = await publishAutomatic();
      await automaticFiles
        .locator('select[aria-label="Version"] option', {
          hasText: `Version ${latest}`,
        })
        .waitFor({ state: "attached" });
      expect(await autoHeading.textContent()).toBe(`Draft ${autoFirst}`);
      expect(await automaticFiles.count()).toBe(1);
      expect(await tab("chat").getAttribute("class")).toContain(
        "dv-active-tab",
      );
    }
    await page.keyboard.press("i");
    await focused("#input");
    await page.locator('.agent[data-id="main"]').click();
    await automaticFiles.waitFor({ state: "detached" });
    const autoFourth = await publishAutomatic();
    const autoResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/conversations/${autoOwner}?`) &&
        response.url().includes("focused=1"),
    );
    await page.locator(`.agent[data-id="${autoOwner}"]`).click();
    await page
      .getByRole("button", { name: "Open report.md in Files" })
      .nth(autoFourth - 1)
      .waitFor();
    await (await autoResponse).finished();
    expect(await automaticFiles.count()).toBe(0);
    await waitLayout([["chat"]]);
    await storedLayout(autoOwner, [["chat"]], true);
    await storedLayout("dock-focus-send", tabbedLayout);
    await page.locator('.agent[data-id="main"]').click();
    await waitLayout(splitLayout);
    await page.locator('#dock .dv-tab[data-dock-panel="chat"] button').click();
    await page.locator(".dock-parking #main").waitFor({ state: "attached" });
    await storedLayout("main", [["explorer"]]);
    const storagePage = await context.newPage();
    const version = await storagePage.goto(`${base}api/version`);
    expect(version?.status()).toBe(200);
    expect(version?.headers()["content-type"]).toContain("application/json");
    await page.evaluate(() => {
      const browser = globalThis as any;
      browser.layoutStorageChanged = false;
      const changed = (event: any) => {
        if (
          event.key?.startsWith("recurse.conversationUiState.local.v1.slot.") &&
          event.newValue &&
          JSON.parse(event.newValue).owner === "dock-focus-send"
        ) {
          browser.layoutStorageChanged = true;
          browser.removeEventListener("storage", changed);
        }
      };
      browser.addEventListener("storage", changed);
    });
    await storagePage.evaluate(() => {
      const storage = (globalThis as any).localStorage;
      for (const key of Object.keys(storage)) {
        if (!key.startsWith("recurse.conversationUiState.local.v1.slot."))
          continue;
        const record = JSON.parse(storage.getItem(key));
        if (record.owner !== "dock-focus-send") continue;
        const layout =
          record.panes?.["window-layout"]?.value ||
          (record.key === "window-layout" ? record.value : null);
        if (!layout?.panels?.explorer) continue;
        layout.panels.side = layout.panels.explorer;
        delete layout.panels.explorer;
        layout.panels.side.id = "side";
        layout.panels.side.title = "Side conversations";
        const nodes = [layout.grid.root];
        while (nodes.length) {
          const node = nodes.pop();
          if (node.type === "branch") nodes.push(...node.data);
          else {
            node.data.views = node.data.views.map((id: string) =>
              id === "explorer" ? "side" : id,
            );
            if (node.data.activeView === "explorer")
              node.data.activeView = "side";
          }
        }
        storage.setItem(key, JSON.stringify(record));
      }
    });
    await page.waitForFunction(() => (globalThis as any).layoutStorageChanged);
    await storagePage.close();
    await page.locator('.agent[data-id="dock-focus-send"]').click();
    await page.locator('.agent.selected[data-id="dock-focus-send"]').waitFor();
    await page
      .locator(".msg.assistant")
      .filter({ hasText: "Docked chat can send." })
      .waitFor({ state: "attached" });
    await thread.waitFor();
    await page.setViewportSize({ width: 1024, height: 800 });
    await storedLayout("dock-focus-send", [["chat", "side"]]);
    await page.setViewportSize({ width: 1280, height: 800 });
    const fileFixture = (await postFixture(
      base,
      "seed-published-markdown",
    )) as {
      demo: string;
      id: string;
      payload: string;
    };
    const visitFiles = async (cid: string) => {
      await page.locator(`.agent[data-id="${cid}"]`).click();
      await page.waitForURL(`${base}#agent=${cid}`);
      await page
        .locator("#conv-freshness:not(.on)")
        .waitFor({ state: "attached" });
    };
    await visitFiles(fileFixture.demo);
    await page
      .getByRole("button", { name: "Open report.md in Files" })
      .waitFor();
    await focusThread();
    await arrange("v");
    await page.getByRole("button", { name: "Open report.md in Files" }).click();
    const filePane = page.locator(".pane-col.file-tab:visible");
    await filePane.locator(".files-markdown h1").waitFor();
    const filePanelId = (await filePane.getAttribute("data-pane"))!;
    const fileBody = await filePane.locator(".pane-body").elementHandle();
    const fileLayout = [["chat"], [filePanelId]].sort();
    await waitLayout(fileLayout);
    await page.getByRole("button", { name: "Open report.md in Files" }).click();
    expect(
      await filePane
        .locator(".pane-body")
        .evaluate((node, prior) => node === prior, fileBody),
    ).toBeTrue();
    expect(
      await filePane
        .getByRole("button", { name: "All files", exact: true })
        .count(),
    ).toBe(0);
    await storedLayout(fileFixture.demo, fileLayout);
    await page.reload();
    await filePane.locator(".files-markdown h1").waitFor();
    await waitLayout(fileLayout);
    expect((await windowBox(filePanelId)).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    await visitFiles("main");
    expect(await tab(filePanelId).count()).toBe(0);
    await visitFiles(fileFixture.demo);
    await filePane.locator(".files-markdown h1").waitFor();
    await waitLayout(fileLayout);
    await rename(fileFixture.payload, fileFixture.payload + ".missing");
    try {
      await visitFiles("main");
      await visitFiles(fileFixture.demo);
      const metadata = page.waitForResponse((response) =>
        response.url().includes(`/conversations/${fileFixture.demo}/files?`),
      );
      await page.reload();
      await (await metadata).finished();
      await page.locator('.rail-btn[data-pane="files"]').waitFor();
      await waitLayout([["chat"]]);
      expect(await tab(filePanelId).count()).toBe(0);
      await storedLayout(fileFixture.demo, fileLayout);
    } finally {
      await rename(fileFixture.payload + ".missing", fileFixture.payload);
    }
    await visitFiles("main");
    await visitFiles(fileFixture.demo);
    await filePane.locator(".files-markdown h1").waitFor();
    await waitLayout(fileLayout);
    expect(await filePane.getAttribute("data-pane")).toBe(filePanelId);
    await shot("published-files");
    await focusThread();
    await arrange("e");
    expect((await windowBox(filePanelId)).y).toBeGreaterThan(
      (await windowBox("chat")).y,
    );
    await arrange("t");
    await waitLayout([["chat", filePanelId]]);
    await tab(filePanelId).click();
    await arrange("q");
    await waitLayout([["chat"]]);
    const joinedChat = await tab("chat")
      .locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]")
      .elementHandle();
    const { demo: splitOwner } = await postFixture(
      base,
      "seed-published-versions",
    );
    await visitFiles(splitOwner);
    await waitLayout([["chat"]]);
    expect(
      await tab("chat")
        .locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]")
        .evaluate((node, prior) => node === prior, joinedChat),
    ).toBeTrue();
    await page
      .getByRole("button", { name: "Open report.md in Files" })
      .last()
      .click();
    await filePane.locator(".files-markdown h1").waitFor();
    const splitFile = (await filePane.getAttribute("data-pane"))!;
    await waitLayout([["chat", splitFile]]);
    await arrange("e");
    await waitLayout([["chat"], [splitFile]].sort());
    expect((await windowBox(splitFile)).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await explorer.waitFor();
    await input.fill("Keep this draft when all panes close");
    await input.evaluate((node: any) => node.setSelectionRange(5, 9));
    await page.keyboard.press("Escape");
    await tab(splitFile).click();
    await arrange("o");
    await arrange("Shift+Q");
    await waitLayout([["chat"]]);
    expect(await page.locator("#dock .pane-col").count()).toBe(0);
    expect(await input.inputValue()).toBe(
      "Keep this draft when all panes close",
    );
    expect(
      await input.evaluate((node: any) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([5, 9]);
    await storedLayout(splitOwner, [["chat"]], false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout([["chat"]]);
    expect(await input.inputValue()).toBe(
      "Keep this draft when all panes close",
    );
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await explorer.waitFor();
    await focusThread();
    await arrange("Shift+Q");
    await waitLayout([["chat"]]);
    await waitForLayout(page);
    expect(
      await thread.evaluate(
        (node: any) => node === (globalThis as any).document.activeElement,
      ),
    ).toBeTrue();
    await startNewAgent(page);
    await page.locator(".draft-row.cursor").waitFor();
    await input.fill(finderDraft);
    await input.press("Escape");
    await focusThread();
    await arrange("q");
    await chatTab.waitFor({ state: "detached" });
    await page.keyboard.press("o");
    await focused("#pane-finder-query");
    expect(await page.locator("#pane-finder .pane-option").count()).toBe(1);
    await page.getByRole("option", { name: "Chat", exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await focused("#scroll");
    await chatTab.waitFor();
    expect(await input.inputValue()).toBe(finderDraft);
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["pane-hotkeys", tests]]);
