import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  focusComposer,
  gotoRoot,
  openPage,
  postFixture,
  rootAgentId,
  runBrowserTests,
  screenshot,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { dockControls } from "./pane_layout";

export const tests: BrowserTest[] = [
  // Regression: #3323 Non-editing controls must not suppress desktop shortcuts.
  async function test_hotkeys_from_image_and_native_controls(browser, base) {
    const { demo } = await postFixture(base, "seed-published-image-navigation");
    const { demo: media } = await postFixture(base, "seed-published-media");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await page.goto(`${base}#agent=${demo}`);
      await waitForLayout(page);
      const image = page.locator(
        '#messages .agent-attachment-preview:has(img[alt="published-1.png"])',
      );
      const input = page.locator("#input");
      const compose = async () => {
        await page.keyboard.press("i");
        await browserExpect(input).toBeFocused();
        await browserExpect(input).toHaveValue("");
        await input.press("Escape");
      };
      await image.scrollIntoViewIfNeeded();
      const downloadControl = image.locator("..").locator("a[download]");
      expect(
        await downloadControl.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const inset = Math.min(rect.width, rect.height) / 4;
          return [rect.left + inset, rect.right - inset].every((x) =>
            [rect.top + inset, rect.bottom - inset].every((y) =>
              element.contains(element.ownerDocument.elementFromPoint(x, y)),
            ),
          );
        }),
      ).toBeTrue();
      const downloaded = page.waitForEvent("download");
      await downloadControl.click();
      await downloaded;
      await browserExpect(downloadControl).toBeFocused();
      await compose();
      await image.focus();
      await page.keyboard.press("Tab");
      await browserExpect(downloadControl).toBeFocused();
      await compose();
      await downloadControl.focus();
      await page.keyboard.press("Shift+Tab");
      await browserExpect(image).toBeFocused();
      await compose();
      await image.locator("img").click();
      const viewer = page.locator("dialog.image-popout[open]");
      await viewer.waitFor();
      const closeImage = viewer.getByRole("button", { name: "Close image" });
      await browserExpect(closeImage).toBeFocused();
      for (const key of ["Shift+J", "Shift+K", "PageDown", "PageUp"]) {
        await page.keyboard.press(key);
        await browserExpect(closeImage).toBeFocused();
      }
      await page.keyboard.press("ArrowRight");
      await browserExpect(viewer.locator(".files-name")).not.toHaveText(
        "published-1.png",
      );
      await page.keyboard.press("ArrowLeft");
      await browserExpect(viewer.locator(".files-name")).toHaveText(
        "published-1.png",
      );
      const preview = viewer.locator(".files-detail img");
      await preview.evaluate((image: any) => image.decode());
      const box = (await preview.boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, {
        steps: 4,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      const comment = viewer.locator(".report-comment-popover textarea");
      await comment.fill("Keep this image comment");
      await viewer
        .getByRole("button", { name: "Download", exact: true })
        .focus();
      await page.keyboard.press("c");
      await browserExpect(viewer).toBeVisible();
      await browserExpect(comment).toBeFocused();
      await browserExpect(comment).toHaveValue("Keep this image comment");
      await viewer.getByRole("button", { name: "Cancel", exact: true }).click();
      await compose();
      await page
        .locator("dialog.image-popout[open]")
        .waitFor({ state: "hidden" });
      for (const key of ["Enter", "Space"]) {
        await downloadControl.focus();
        await page.keyboard.press("Shift+Tab");
        await browserExpect(image).toBeFocused();
        await page.keyboard.press("g");
        await page.keyboard.press(key);
        await page.locator("dialog.image-popout[open]").waitFor();
        await compose();
      }
      await page.locator('.rail-btn[data-pane="explorer"]').click();
      const explorer = page.locator('.pane-col[data-pane="explorer"]');
      await explorer.waitFor();
      await image.click();
      await page.locator("dialog.image-popout[open]").waitFor();
      await page.keyboard.press("q");
      await page
        .locator("dialog.image-popout[open]")
        .waitFor({ state: "hidden" });
      await browserExpect(explorer).toBeVisible();
      await image.click();
      await page.locator("dialog.image-popout[open]").waitFor();
      await page.keyboard.press("f");
      await browserExpect(page.locator("#agent-finder-query")).toBeFocused();
      await page
        .locator("dialog.image-popout[open]")
        .waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await explorer.locator(".pane-body").focus();
      await browserExpect(explorer.locator(".pane-body")).toBeFocused();
      await page.keyboard.press("q");
      await explorer.waitFor({ state: "detached" });
      const chatTabClose = page
        .locator('#dock .dv-tab[data-dock-panel="chat"]')
        .getByRole("button", { name: "Close Chat", exact: true });
      await chatTabClose.focus();
      await browserExpect(chatTabClose).toBeFocused();
      await compose();
      await page.goto(`${base}#agent=${media}`);
      const chip = page.getByRole("button", { name: "Open tone.wav in Files" });
      await chip.waitFor();
      await chip.focus();
      await browserExpect(chip).toBeFocused();
      await compose();
      const fileDownload = chip.locator("..").locator("a[download]");
      await fileDownload.focus();
      await browserExpect(fileDownload).toBeFocused();
      await compose();
      await chip.click();
      const audio = page.locator(".pane-col.file-tab audio");
      await audio.focus();
      await browserExpect(audio).toBeFocused();
      await compose();
      await page.locator('.rail-btn[data-pane="explorer"]').click();
      const search = page.locator("#explorer-search");
      await search.fill("");
      await search.press("i");
      await browserExpect(search).toBeFocused();
      await browserExpect(search).toHaveValue("i");
      await input.fill("Typing stays in the composer");
      await input.press("i");
      await browserExpect(input).toHaveValue("Typing stays in the composeri");
    } finally {
      await page.close();
    }
  },
  // Regression: #3231 Imported browser history must support a later fake-provider reply.
  async function test_imported_artifact_history_can_continue(browser, base) {
    await postFixture(base, "seed-artifact-app");
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    try {
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
  // Regression: #2314 #3239 #3241 #3356 #3372 #3393 Window focus, keyboard modes, and fullscreen.
  async function test_pane_focus_and_visibility_keys(browser, base) {
    await postFixture(base, "seed-model-selection-error", {
      agent: "dock-focus-send",
      model: "fauxordinary/faux-1",
    });
    const app = await postFixture(base, "seed-artifact-app");
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    let releaseDock!: () => void;
    const dockStyle = new Promise<void>((resolve) => (releaseDock = resolve));
    await page.route("**/static/dockview.css", async (route) => {
      await dockStyle;
      await route.continue();
    });
    await page.goto(`${base}#agent=${rootAgentId()}&artifact=${app.id}`, {
      waitUntil: "domcontentloaded",
    });
    const pane = page.locator('.pane-col[data-pane="report"]');
    await pane.waitFor();
    const { thread, focusThread, focused, arrange, tab, windowBox } =
      dockControls(page);
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
    const badgeNode = (await modeBadge.elementHandle())!;
    const badgeState = async (text: string) => {
      const status = page.getByRole("status").and(modeBadge);
      await browserExpect(status).toHaveText(text);
      return status.evaluate((badge: any, held: any) => {
        const rect = badge.getBoundingClientRect();
        const top = (globalThis as any).document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return [
          badge === held,
          badge.getAttribute("aria-live"),
          Boolean(top && badge.contains(top)),
        ];
      }, badgeNode);
    };
    await focusComposer(page);
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
    expect(await badgeState("Normal")).toEqual([true, "polite", false]);
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
    expect(await badgeState("Pane")).toEqual([true, "polite", true]);
    await visibleAndUncovered(page, "#key-mode");
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
    await screenshot(page, "pane-hotkeys/1280-window-focus-artifacts");
    await go("h");
    await focused("#scroll");
    await screenshot(page, "pane-hotkeys/1280-window-focus-chat");
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
    const reportBody = pane.locator(".pane-body");
    for (const [left, right, down, up] of [
      ["h", "l", "j", "k"],
      ["Shift+H", "Shift+L", "Shift+J", "Shift+K"],
    ]) {
      await arrange("t");
      await reportBody.waitFor({ state: "visible" });
      await reportBody.focus();
      await browserExpect(reportBody).toBeFocused();
      await page.keyboard.press("w");
      await page.locator("#window-key-hints").waitFor({ state: "visible" });
      const visibility = await reportBody.evaluate((node) => {
        const previous = node.style.visibility;
        node.style.visibility = "hidden";
        return previous;
      });
      await page.waitForFunction(() => {
        const document = (globalThis as any).document;
        return document.activeElement === document.body;
      });
      await reportBody.evaluate((node, previous) => {
        node.style.visibility = previous;
      }, visibility);
      await page.keyboard.press(left);
      await page.locator("#window-key-hints").waitFor({ state: "hidden" });
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
    for (const _reopen of [false, true]) {
      await page.locator('.rail-btn[data-pane="explorer"]').click();
      await tab("explorer").waitFor();
      await tab("explorer").getByRole("button").click();
      await tab("explorer").waitFor({ state: "detached" });
    }
    await pane.locator(".pane-body").focus();
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
      if (height >= 800)
        await screenshot(page, `pane-hotkeys/${width}x${height}-pane-finder`);
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
    expect(await badgeState("Insert")).toEqual([true, "polite", false]);
    await page.keyboard.press("Escape");
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("h");
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await focused("#scroll");
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
    await screenshot(page, "pane-hotkeys/1280x800-chat-finder");
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
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["pane-hotkeys", tests]]);
