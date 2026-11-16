import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { renderThemeCss, themePalettes } from "../../src/themes";
import {
  gotoRoot,
  mockConversation,
  postFixture,
  rootAgentId,
  runBrowserTests,
  themeColors,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { idleConv, row, tree } from "./fixtures";

async function screenshot(page: Page, name: string) {
  const dir = process.env.RECURSE_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const stage = process.env.RECURSE_SCREENSHOT_STAGE || "after";
  await page.screenshot({ path: `${dir}/${stage}-${name}.png` });
}

async function assertTouchTarget(page: Page, selector: string) {
  const hits = await page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [-19, 19].flatMap((x) =>
      [-19, 19].map((y) =>
        element.contains(
          element.ownerDocument.elementFromPoint(
            box.x + box.width / 2 + x,
            box.y + box.height / 2 + y,
          ),
        ),
      ),
    );
  });
  expect({ selector, hits }).toEqual({
    selector,
    hits: [true, true, true, true],
  });
}

export const tests: BrowserTest[] = [
  // Regression: #2297 desktop actions must remain reachable without overflow. (also Feature #2310 viewport changes move actions between phone and desktop hosts.; #2363 parent navigation can replace rail buttons during box reads.)
  async function test_desktop_rail_actions_and_pane_cycling(browser, base) {
    await postFixture(base, "seed-artifact-app");
    const { demo } = await postFixture(base, "seed-published-sizes");
    await postFixture(base, "seed-artifact-app", { agent: demo });
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
      });
      const page = await context.newPage();
      await page.goto(`${base}#agent=${demo}`);
      await page.locator("#trash-btn.on").waitFor({ state: "attached" });
      await page
        .locator('#pane-menu-panels [data-pane="files"]')
        .waitFor({ state: "attached" });
      await page
        .locator('#pane-menu-panels [data-pane="report"]')
        .waitFor({ state: "attached" });
      await screenshot(page, `${width}-rail`);
      if (width === 412) {
        await page.locator("#pane-fab").click();
        expect(await page.locator("#pane-menu #takeover-btn").isVisible()).toBe(
          true,
        );
        await screenshot(page, `${width}-rail-menu`);
        await context.close();
        continue;
      }
      expect(await page.locator("#pane-fab").isVisible()).toBe(false);
      const actions = page.locator("#pane-rail > button");
      expect(
        await actions.evaluateAll((els) => els.map((el) => el.id)),
      ).toEqual(["new-top", "share-link-btn", "takeover-btn"]);
      expect(
        await page
          .locator("#agent-list-foot > button")
          .evaluateAll((els) => els.map((el) => el.id)),
      ).toEqual(["settings-btn", "trash-btn"]);
      expect(
        await page
          .locator("#agent-list-foot")
          .getByRole("button", { name: "Delete", exact: true })
          .count(),
      ).toBe(1);
      expect(
        await page.locator("#settings-btn .settings-label").isVisible(),
      ).toBe(false);
      expect(
        await page.locator('#pane-rail [aria-label="Agents"]').count(),
      ).toBe(0);
      for (const selector of ["#settings-btn", "#trash-btn"])
        await assertTouchTarget(page, selector);
      const newBox = (await page.locator("#new-top").boundingBox())!;
      const linkBox = (await page.locator("#share-link-btn").boundingBox())!;
      expect({
        column: Math.abs(
          newBox.x + newBox.width / 2 - (linkBox.x + linkBox.width / 2),
        ),
        gap: linkBox.y - (newBox.y + newBox.height),
      }).toEqual({ column: 0, gap: 0 });
      const railStates = (selector: string) =>
        page.evaluate(
          (selector) =>
            [...(globalThis as any).document.querySelectorAll(selector)]
              .filter((button) => button.getClientRects().length)
              .map((button) => {
                button.scrollIntoView({ block: "nearest" });
                const style = (globalThis as any).getComputedStyle(button);
                const box = button.getBoundingClientRect();
                const badge = button
                  .querySelector(".rail-count")
                  ?.getBoundingClientRect();
                const x = box.left + box.width / 2;
                const y = box.top + box.height / 2;
                const hits = (dx: number, dy: number) => {
                  const hit = button.ownerDocument.elementFromPoint(
                    x + dx,
                    y + dy,
                  );
                  return button.contains(hit) && !hit.closest(".rail-count");
                };
                const edge = box.width / 2 - 2;
                return {
                  circle:
                    Math.abs(box.width - box.height) < 0.5 &&
                    [
                      [0, 0],
                      [-21, 0],
                      [21, 0],
                      [0, -21],
                      [0, 21],
                    ].every(([dx, dy]) => hits(dx, dy)) &&
                    [
                      [-edge, -edge],
                      [edge, -edge],
                      [-edge, edge],
                      [edge, edge],
                    ].every(([dx, dy]) => !hits(dx, dy)),
                  filled: style.backgroundColor !== "rgba(0, 0, 0, 0)",
                  active: button.classList.contains("active"),
                  badge: badge && [
                    badge.right - box.right,
                    badge.bottom - box.bottom,
                  ],
                };
              }),
          selector,
        );
      const railState = async (selector: string) =>
        (await railStates(selector))[0];
      for (const button of await railStates("#pane-rail button"))
        expect(button).toMatchObject({ circle: true, filled: button.active });
      const files = '#pane-rail .rail-btn[data-pane="files"]';
      if ((await page.locator(files).getAttribute("aria-expanded")) === "true")
        await page.locator(files).click();
      await page.mouse.move(0, 0);
      const resting = await railState(files);
      expect(resting).toMatchObject({ circle: true, filled: false });
      expect(resting.badge).toBeTruthy();
      await page.locator(files).hover();
      expect(await railState(files)).toEqual({ ...resting, filled: true });
      await page.mouse.move(0, 0);
      await page.locator("#new-top").focus();
      await page.keyboard.press("Tab");
      expect(
        await page
          .locator("#share-link-btn")
          .evaluate((el) => el.matches(":focus-visible")),
      ).toBe(true);
      expect(await railState("#share-link-btn")).toMatchObject({
        circle: true,
        filled: true,
      });
      await page.locator("#share-link-btn").hover();
      await page.mouse.down();
      expect(await railState("#share-link-btn")).toMatchObject({
        circle: true,
        filled: true,
      });
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await page.locator(files).click();
      await page.locator(`${files}.active`).waitFor();
      await page.mouse.move(0, 0);
      expect(await railState(files)).toEqual({
        ...resting,
        filled: true,
        active: true,
      });
      await page.setViewportSize({ width: 1280, height: 320 });
      for (const button of await railStates("#pane-rail button"))
        expect(button.circle).toBe(true);
      await page.setViewportSize({ width: 1280, height: 915 });
      await page.evaluate(
        () =>
          new Promise((done) => {
            const frame = (globalThis as any).requestAnimationFrame;
            frame(() => frame(done));
          }),
      );
      expect(
        await page.evaluate(() => {
          const doc = (globalThis as any).document;
          const box = (el: any) => el.getBoundingClientRect();
          const hit = (x: number, y: number, selector: string) =>
            !!doc.elementFromPoint(x, y)?.closest(selector);
          const sidebar = box(doc.querySelector("#sidebar"));
          const rail = box(doc.querySelector("#pane-rail"));
          const windows = [...doc.querySelectorAll("#dock .dv-groupview")]
            .map(box)
            .sort((a, b) => a.left - b.left);
          const edges = [sidebar, ...windows, rail];
          const y = 915 / 2;
          return {
            windows: windows.length,
            gaps: edges.slice(1).map((next, i) => next.left - edges[i].right),
            spans: edges.map((edge) => [edge.top, edge.bottom]),
            sidebarCorners: [
              [0, 0],
              [sidebar.right - 1, 914],
            ].every(([x, y]) => hit(x, y, "#sidebar")),
            windowCorners: windows.every(
              (w) =>
                hit(w.left + 5, 0, ".dv-groupview") &&
                hit(w.right - 5, 0, ".dv-groupview") &&
                hit(w.left + 5, 914, ".dv-render-overlay") &&
                hit(w.right - 5, 914, ".dv-render-overlay"),
            ),
            grips: [
              ...[-6, 2, 3].map((dx) =>
                hit(sidebar.right + dx, y, ".resize-grip.sb"),
              ),
              ...[-2, 1].map((dx) => hit(windows[1].left + dx, y, ".dv-sash")),
            ],
          };
        }),
      ).toEqual({
        windows: 2,
        gaps: [0, 0, 0],
        spans: [
          [0, 915],
          [0, 915],
          [0, 915],
          [0, 915],
        ],
        sidebarCorners: true,
        windowCorners: true,
        grips: [true, true, false, true, true],
      });
      await page.setViewportSize({ width: 1280, height: 240 });
      const agentList = page.locator("#agent-list");
      await agentList.hover();
      await page.mouse.wheel(0, 200);
      await page.waitForFunction(
        () =>
          (globalThis as any).document.querySelector("#agent-list").scrollTop,
      );
      expect(
        await agentList.evaluate((list) => {
          const box = list.getBoundingClientRect();
          const track = (list.offsetWidth - list.clientWidth) / 2;
          return {
            overflows: list.scrollHeight > list.clientHeight,
            trackClear:
              track > 0 &&
              [...Array(track).keys()].every(
                (i) =>
                  list.ownerDocument.elementFromPoint(
                    box.right - 1 - i,
                    box.top + box.height / 2,
                  ) === list,
              ),
          };
        }),
      ).toEqual({ overflows: true, trackClear: true });
      await page.setViewportSize({ width: 1280, height: 915 });
      await page.locator("#main .msg").first().click();
      await page.keyboard.press("w");
      await page.locator("#window-key-hints").waitFor({ state: "visible" });
      await page.keyboard.press("f");
      await page.locator("#main.fullscreen #top-actions #new-top").waitFor();
      await assertTouchTarget(page, "#new-top");
      await page.keyboard.press("w");
      await page.locator("#window-key-hints").waitFor({ state: "visible" });
      await page.keyboard.press("f");
      await page.locator("#pane-rail > #new-top:first-child").waitFor();
      await page.keyboard.press("t");
      await page.locator("#pane-rail.prefix-on").waitFor();
      expect(
        await page.locator("#new-top").evaluate((button) => {
          const box = button.getBoundingClientRect();
          const hint = (globalThis as any).getComputedStyle(button, "::after");
          return [1, 3].every((quarter) =>
            button.contains(
              button.ownerDocument.elementFromPoint(
                box.right + 4 - (parseFloat(hint.width) * quarter) / 4,
                box.bottom + 4 - (parseFloat(hint.height) * quarter) / 4,
              ),
            ),
          );
        }),
      ).toBe(true);
      await page.keyboard.press("Escape");
      const first = page.locator("#pane-rail [data-pane]").first();
      const childTop = (await first.boundingBox())!.y;
      expect(
        await page
          .locator("#pane-rail-panels")
          .evaluate(
            (el) => (globalThis as any).getComputedStyle(el).borderTopWidth,
          ),
      ).toBe("1px");
      await page.locator("#trash-btn").click();
      expect(await page.locator("#trash-btn").getAttribute("class")).toContain(
        "armed",
      );
      expect(await page.locator(".hold-tip.on").isVisible()).toBe(true);
      expect(
        await page
          .locator("#agent-list-foot")
          .getByRole("button", {
            name: "Confirm delete agent and descendants",
            exact: true,
          })
          .count(),
      ).toBe(1);
      await page.locator("#takeover-btn").click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document
            .getElementById("takeover-btn")
            .getAttribute("aria-pressed") === "true",
      );
      expect(
        await page.locator("#trash-btn").getAttribute("class"),
      ).not.toContain("armed");
      await page.locator("#takeover-btn").click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document
            .getElementById("takeover-btn")
            .getAttribute("aria-pressed") === "false",
      );
      const ids = await page
        .locator("#pane-rail [data-pane]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-pane")));
      expect(ids.length).toBeGreaterThanOrEqual(3);
      expect(ids[0]).toBe("chat");
      const second = page.locator(`#pane-rail [data-pane="${ids[1]}"]`);
      if ((await second.getAttribute("aria-expanded")) === "false")
        await second.click();
      await page.locator(`.pane-col[data-pane="${ids[1]}"] .pane-body`).focus();
      const focusedWindow = (id: string) =>
        page.waitForFunction((id) => {
          const active = (globalThis as any).document.activeElement;
          return (
            (active?.closest(".pane-col")?.dataset.pane ||
              (active?.closest("#main") ? "chat" : undefined)) === id
          );
        }, id);
      for (let index = 0; index < Math.min(9, ids.length); index++) {
        expect(
          await page
            .locator(`#pane-rail [data-pane="${ids[index]}"]`)
            .getAttribute("title"),
        ).toContain(`(g${index + 1})`);
        await page.keyboard.press("g");
        await page.keyboard.press(String(index + 1));
        await focusedWindow(ids[index]!);
        if (ids[index] === "explorer") await page.keyboard.press("Escape");
        expect(
          await page.locator("#trash-btn").getAttribute("class"),
        ).not.toContain("armed");
      }
      for (const key of ["j", "k"]) {
        await page.keyboard.press(key);
        expect(
          await page.evaluate(
            () =>
              (globalThis as any).document.activeElement?.closest(".pane-col")
                ?.dataset.pane,
          ),
        ).toBe(ids[Math.min(8, ids.length - 1)]);
      }
      await page.locator('.rail-btn[data-pane="report"]').click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document.activeElement?.closest(".pane-col")
            ?.dataset.pane === "report",
      );
      await page.keyboard.press("o");
      await page.locator("#pane-finder-query").fill("Files");
      await screenshot(page, `${width}-pane-finder`);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          (globalThis as any).document.activeElement?.closest(".pane-col")
            ?.dataset.pane === "files",
      );
      expect(await page.locator(".pane-col").count()).toBeGreaterThan(1);
      const strip = page
        .locator('#dock .dv-tab[data-dock-panel="files"]')
        .locator("..");
      expect(
        await strip.evaluate((strip) => {
          const bounds = strip.getBoundingClientRect();
          const title = strip.querySelector(
            ".dv-active-tab .dv-default-tab-content",
          )!;
          const pane = strip.ownerDocument.querySelector(
            '.pane-col[data-pane="files"]',
          )!;
          return {
            activeTitleFull: title.clientWidth >= title.scrollWidth,
            emptyHeaderHeight: pane
              .querySelector(".pane-head")!
              .getBoundingClientRect().height,
            windowActions: strip.ownerDocument.querySelectorAll(
              '.dock-window-actions[data-dock-panel="files"] .fs',
            ).length,
            unfocusedFlashes: strip.ownerDocument.querySelectorAll(
              "#dock .dock-flash:not(.dock-focused)",
            ).length,
            clippedTabs: Array.from(strip.children)
              .filter((tab: any) => {
                const box = tab.getBoundingClientRect();
                return box.left < bounds.left || box.right > bounds.right;
              })
              .map((tab: any) => tab.getAttribute("data-dock-panel")),
          };
        }),
      ).toEqual({
        activeTitleFull: true,
        emptyHeaderHeight: 0,
        windowActions: 1,
        unfocusedFlashes: 0,
        clippedTabs: [],
      });
      await page.keyboard.press("Shift+H");
      await page.locator("#sidebar").waitFor({ state: "hidden" });
      await page.waitForFunction(() => {
        const strip = (globalThis as any).document.querySelector(
          '#dock .dv-tab[data-dock-panel="files"]',
        )?.parentElement;
        return (
          strip &&
          !strip.classList.contains("dock-compact") &&
          Array.from(strip.querySelectorAll(".dv-default-tab-content")).every(
            (title: any) => title.clientWidth >= title.scrollWidth,
          )
        );
      });
      await screenshot(page, `1280-full-titles`);
      await page.keyboard.press("Shift+H");
      await page.locator("#sidebar").waitFor({ state: "visible" });
      await page.waitForFunction(() =>
        (globalThis as any).document
          .querySelector('#dock .dv-tab[data-dock-panel="files"]')
          ?.parentElement.classList.contains("dock-compact"),
      );
      expect(
        await strip.locator(".dv-inactive-tab").evaluateAll((tabs) =>
          tabs.map((tab) => ({
            name: tab.getAttribute("aria-label"),
            tooltip: tab
              .querySelector(".dv-default-tab")!
              .getAttribute("title"),
            titleWidth: tab
              .querySelector(".dv-default-tab-content")!
              .getBoundingClientRect().width,
          })),
        ),
      ).toEqual([
        { name: "Artifacts", tooltip: "Artifacts", titleWidth: 0 },
        { name: "Explorer", tooltip: "Explorer", titleWidth: 0 },
      ]);
      await page.setViewportSize({ width: 740, height: 915 });
      await page.waitForFunction(() => {
        const strip = (globalThis as any).document.querySelector(
          '#dock .dv-tab[data-dock-panel="files"]',
        )?.parentElement;
        return strip && strip.scrollWidth > strip.clientWidth;
      });
      const stripBox = (await strip.boundingBox())!;
      await page.mouse.move(
        stripBox.x + stripBox.width / 2,
        stripBox.y + stripBox.height / 2,
      );
      await page.mouse.wheel(0, 1000);
      await page.waitForFunction(() => {
        const tab = (globalThis as any).document.querySelector(
          '#dock .dv-tab[data-dock-panel="explorer"]',
        );
        const strip = tab?.parentElement;
        return (
          strip?.scrollLeft > 0 &&
          tab.getBoundingClientRect().right <=
            strip.getBoundingClientRect().right
        );
      });
      const scrolled = await strip.evaluate((node) => node.scrollLeft);
      const panel = page.locator('.dock-panel[data-dock-panel="files"]');
      const height = await panel.evaluate((node) => node.clientHeight);
      await page.setViewportSize({ width: 740, height: 916 });
      await page.waitForFunction(
        (height) =>
          (globalThis as any).document.querySelector(
            '.dock-panel[data-dock-panel="files"]',
          )?.clientHeight ===
          height + 1,
        height,
      );
      expect(await strip.evaluate((node) => node.scrollLeft)).toBe(scrolled);
      await page.mouse.wheel(0, -1000);
      await page.waitForFunction(() => {
        const strip = (globalThis as any).document.querySelector(
          '#dock .dv-tab[data-dock-panel="files"]',
        )?.parentElement;
        return strip?.scrollLeft === 0;
      });
      await page.setViewportSize({ width, height: 915 });
      await page.waitForFunction(() => {
        const strip = (globalThis as any).document.querySelector(
          '#dock .dv-tab[data-dock-panel="files"]',
        )?.parentElement;
        if (!strip) return false;
        const bounds = strip.getBoundingClientRect();
        return Array.from(strip.children).every((tab: any) => {
          const box = tab.getBoundingClientRect();
          return box.left >= bounds.left && box.right <= bounds.right;
        });
      });
      const fullscreen = page.locator(
        '.dock-window-actions[data-dock-panel="files"] .fs',
      );
      const nativeFullscreen = await fullscreen.elementHandle();
      await fullscreen.focus();
      await page.keyboard.press("Escape");
      expect(
        await page.locator('.pane-col[data-pane="files"]').isVisible(),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => !!(globalThis as any).document.activeElement?.closest(".agent"),
        ),
      ).toBe(true);
      await fullscreen.focus();
      await page.keyboard.press("Enter");
      const fullPane = page.locator('.pane-col[data-pane="files"].fullscreen');
      await fullPane.waitFor();
      expect(
        await fullPane
          .getByRole("button", { name: "Exit fullscreen", exact: true })
          .evaluate(
            (button, original) => button === original,
            nativeFullscreen,
          ),
      ).toBe(true);
      expect(
        await fullPane
          .getByRole("button", { name: "Exit fullscreen", exact: true })
          .evaluate((button) => button.ownerDocument.activeElement === button),
      ).toBe(true);
      await page.keyboard.press("Enter");
      await fullscreen.waitFor({ state: "visible" });
      expect(
        await fullscreen.evaluate(
          (button) =>
            button.ownerDocument.activeElement === button &&
            button.getAttribute("aria-pressed") === "false",
        ),
      ).toBe(true);
      await page
        .locator('#dock .dv-tab[data-dock-panel="report"] .dock-tab-icon')
        .click();
      expect(
        await page
          .locator('.dock-window-actions[data-dock-panel="report"] .fs')
          .count(),
      ).toBe(1);
      expect(await fullscreen.count()).toBe(0);
      await page
        .locator('#dock .dv-tab[data-dock-panel="files"] .dock-tab-icon')
        .click();
      expect(
        await fullscreen.evaluate(
          (button, original) => button === original,
          nativeFullscreen,
        ),
      ).toBe(true);
      await page.mouse.move(640, 400);
      await screenshot(page, `desktop-windows`);
      await page
        .locator('#dock .dv-tab[data-dock-panel="report"] .dock-tab-icon')
        .click();
      await page
        .locator('.dock-window-actions[data-dock-panel="report"] .fs')
        .focus();
      await page.keyboard.press("q");
      await page
        .locator('.pane-col[data-pane="report"]')
        .waitFor({ state: "detached" });
      expect(await page.locator('.pane-col[data-pane="files"]').count()).toBe(
        1,
      );
      await fullscreen.focus();
      await page.setViewportSize({ width: 412, height: 915 });
      await page
        .locator("#pane-menu #trash-btn")
        .waitFor({ state: "attached" });
      expect(await page.locator("#pane-menu #trash-btn").count()).toBe(1);
      expect(await page.locator(".pane-col").count()).toBe(1);
      expect(await page.locator(".dock-window-actions").count()).toBe(0);
      expect(
        await page
          .locator('.pane-col[data-pane="files"] .pane-head .fs')
          .evaluate(
            (button, original) => button === original,
            nativeFullscreen,
          ),
      ).toBe(true);
      expect(
        await page.locator(".pane-col.mobile-active").getAttribute("data-pane"),
      ).toBe("files");
      await screenshot(page, `phone-overlay`);
      await page.locator(".pane-col.mobile-active .pane-head .x").click();
      await page.locator("#panes").waitFor({ state: "hidden" });
      expect(await page.locator("#main").isVisible()).toBeTrue();
      await page.setViewportSize({ width, height: 915 });
      await page
        .locator("#agent-list-foot #trash-btn")
        .waitFor({ state: "attached" });
      expect(await page.locator("#agent-list-foot #trash-btn").count()).toBe(1);
      await browserExpect
        .poll(() => page.locator("#agent-list-foot #settings-btn").count())
        .toBe(1);
      const nodes = (await (
        await page.request.get(`${base}api/tree`)
      ).json()) as Array<{ id: string; parent: string | null }>;
      const parent = nodes.find((node) => node.id === demo)?.parent;
      if (!parent) throw new Error("Published fixture parent is missing");
      await page.locator('#pane-rail [data-pane="files"]').click();
      await fullscreen.focus();
      await page.evaluate((id) => {
        (globalThis as any).location.hash = `agent=${encodeURIComponent(id)}`;
      }, parent);
      await page.locator("#takeover-btn.on").waitFor({ state: "hidden" });
      await page.locator('#pane-rail [data-pane="report"]').waitFor();
      expect(
        await page.evaluate(
          () => !!(globalThis as any).document.activeElement?.closest(".agent"),
        ),
      ).toBe(true);
      const parentBox = await page.waitForFunction(() => {
        const button = (globalThis as any).document.querySelector(
          "#pane-rail [data-pane]",
        );
        if (!button) return false;
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? { y: box.y } : false;
      });
      const parentGeometry = await parentBox.jsonValue();
      await parentBox.dispose();
      if (!parentGeometry) throw new Error("Parent rail button is not visible");
      expect(childTop - parentGeometry.y).toBe(44);
      expect(
        await page.locator("#agent-list-foot #trash-btn").isVisible(),
      ).toBe(true);
      await screenshot(page, `${width}-rail-root`);
      await context.close();
    }
  },
  // Regression: #2861 conversation actions dismiss the phone menu after activation.
  async function test_takeover_single_activation_and_enabled_menu(
    browser,
    base,
  ) {
    for (const width of [412]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      let parent: string | null = "parent";
      let takenOver = false;
      const pins: boolean[] = [];
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [{ ...tree()[0], parent, taken_over: takenOver }],
        }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv(),
        parent,
        taken_over: takenOver,
      }));
      await page.route(`${base}api/conversations/main/take-over`, (route) => {
        takenOver = route.request().postDataJSON().taken_over;
        pins.push(takenOver);
        return route.fulfill({ json: { taken_over: takenOver } });
      });
      await gotoRoot(page, base);
      await page.locator("#pane-fab").click();
      await screenshot(page, `${width}-enabled-menu`);
      if (width === 412) await page.locator("#takeover-btn").tap();
      else await page.locator("#takeover-btn").click();
      await page
        .locator("#takeover-btn.active:not(:disabled)")
        .waitFor({ state: "attached" });
      expect(pins).toEqual([true]);
      expect(await page.locator("#pane-menu.on").count()).toBe(0);
      await page.locator("#pane-fab").tap();
      expect(await page.locator(".hold-tip.on").count()).toBe(0);
      expect(await page.locator("#takeover-btn").innerText()).toBe(
        "Hand back control",
      );
      if (width === 412) await page.locator("#takeover-btn").tap();
      else await page.locator("#takeover-btn").click();
      await page
        .locator("#takeover-btn:not(.active):not(:disabled)")
        .waitFor({ state: "attached" });
      expect(pins).toEqual([true, false]);
      expect(await page.locator("#pane-menu.on").count()).toBe(0);
      await page.locator("#pane-fab").tap();
      await page.mouse.move(0, 900);
      const styles = await page.evaluate(() => {
        const ids = ["trash-btn", "takeover-btn", "share-link-btn", "pane-fab"];
        return ids.map((id) => {
          const el = (globalThis as any).document.getElementById(id);
          const css = (globalThis as any).getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            color: css.color,
            background: css.backgroundColor,
            border: css.borderWidth,
            x: box.x,
            width: box.width,
            height: box.height,
          };
        });
      });
      expect(styles[0].color).toBe(styles[2].color);
      expect(styles[1].color).toBe(styles[0].color);
      expect(styles[1].background).toBe(styles[0].background);
      for (const style of styles)
        expect(style.height).toBeGreaterThanOrEqual(44);
      expect(
        await page.locator("#takeover-btn svg [stroke-dasharray]").count(),
      ).toBe(0);
      parent = null;
      await page.reload();
      await page.locator("#conv-title").waitFor();
      await page.locator("#pane-fab").click();
      expect(await page.locator("#takeover-btn").isVisible()).toBe(false);
      await context.close();
    }
  },
  async function test_overflow_slide_actions(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({ json: [{ ...tree()[0], parent: "parent" }] }),
    );
    await mockConversation(page, base, "main", () => ({
      ...idleConv(),
      parent: "parent",
    }));
    let deletes = 0;
    let pins = 0;
    await page.route(`${base}api/conversations/main`, (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deletes++;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route(`${base}api/conversations/main/take-over`, (route) => {
      pins++;
      return route.fulfill({ json: { taken_over: true } });
    });
    await gotoRoot(page, base);
    const cdp = await context.newCDPSession(page);
    const slide = async (selector: string, hot = true, cancel = false) => {
      const button = (await page.locator("#pane-fab").boundingBox())!;
      const x = button.x + button.width / 2;
      const y = button.y + button.height / 2;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await page.locator("#pane-menu.on").waitFor();
      const item = (await page.locator(selector).boundingBox())!;
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: x + ((item.x + item.width / 2 - x) * i) / 8,
              y: y + ((item.y + item.height / 2 - y) * i) / 8,
            },
          ],
        });
      }
      await page.waitForFunction(
        ({ selector, hot }) => {
          const document = (globalThis as any).document;
          return hot
            ? document.querySelector(`${selector}.hot`) !== null
            : document.querySelector("#pane-menu .hot") === null;
        },
        { selector, hot },
      );
      expect(await page.locator(`${selector}.hot`).count()).toBe(hot ? 1 : 0);
      await cdp.send("Input.dispatchTouchEvent", {
        type: cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    };
    await slide("#trash-btn", true, true);
    expect(await page.locator("#trash-btn.armed").count()).toBe(0);
    expect(deletes).toBe(0);
    await slide("#scroll", false);
    expect(await page.locator("#trash-btn.armed").count()).toBe(0);
    expect(deletes).toBe(0);
    await slide("#takeover-btn");
    await page
      .locator("#takeover-btn.active:not(:disabled)")
      .waitFor({ state: "attached" });
    expect(pins).toBe(1);
    await slide("#trash-btn");
    expect(await page.locator("#trash-btn.armed").count()).toBe(1);
    expect(deletes).toBe(0);
    const deleted = page.waitForResponse(
      (response) =>
        response.url() === `${base}api/conversations/main` &&
        response.request().method() === "DELETE",
    );
    await slide("#trash-btn");
    await deleted;
    expect(deletes).toBe(1);
    await context.close();
  },
  // Regression: #2861 confirmed Delete must not leave the conversation actions menu open.
  async function test_overflow_touch_tap_delete(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({ json: tree() }),
    );
    await mockConversation(page, base, "main", () => idleConv());
    let deletes = 0;
    await page.route(`${base}api/conversations/main`, (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deletes++;
      return route.fulfill({ json: { ok: true } });
    });
    await gotoRoot(page, base);
    const cdp = await context.newCDPSession(page);
    const tap = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    await tap("#pane-fab");
    await page.locator("#pane-menu.on").waitFor();
    await page.locator("#trash-btn").focus();
    await page.keyboard.press("Escape");
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
    await tap("#pane-fab");
    await page.locator("#pane-backdrop").tap({ position: { x: 10, y: 500 } });
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
    await tap("#pane-fab");
    await tap("#trash-btn");
    await page.locator("#trash-btn.armed").waitFor();
    expect(await page.locator("#trash-btn.armed").count()).toBe(1);
    expect(deletes).toBe(0);
    const deletion = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === "/api/conversations/main",
    );
    await tap("#trash-btn");
    await (await deletion).finished();
    expect(deletes).toBe(1);
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
    expect(await page.locator("#pane-backdrop.on").count()).toBe(0);
    expect(await page.locator("#pane-fab").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await context.close();
  },
  // Regression: #3250 Phone menus paint above the header fade; #3233 header geometry waits for mounted desktop Chat.
  async function test_single_row_header(browser, base) {
    await postFixture(base, "seed-artifact-app", { reader: "long" });
    for (const [width, height, theme] of [
      [412, 915, "Material Dark"],
      [412, 915, "GitHub Light"],
      [390, 844, "Material Dark"],
      [390, 844, "GitHub Light"],
      [390, 280, "Material Dark"],
      [390, 280, "GitHub Light"],
      [1280, 900, "Material Dark"],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: width === 412 ? 2.6 : 1,
        hasTouch: width < 700,
        isMobile: width < 700,
        ...(width === 412
          ? {
              userAgent:
                "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
            }
          : {}),
      });
      const page = await context.newPage();
      const title = "A conversation name long enough to truncate on a phone";
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [
            {
              ...tree()[0],
              title,
              parent: "parent",
              status: "running",
              children: 2,
            },
            { ...tree("parent")[0], title: "Parent", children: 1 },
          ],
        }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv([
          row(
            "a1",
            "assistant",
            "Header menu reading content.\n\n".repeat(50) +
              "```text\n" +
              "horizontal content ".repeat(100) +
              "\n```",
          ),
        ]),
        title,
        parent: "parent",
        status: "running",
        active_run: "header-run",
      }));
      await mockConversation(page, base, "parent", () => ({
        ...idleConv(),
        id: "parent",
        title: "Parent",
      }));
      let deletes = 0;
      await page.route(`${base}api/conversations/main`, (route) => {
        if (route.request().method() !== "DELETE") return route.fallback();
        deletes++;
        return route.fulfill({ json: { ok: true } });
      });
      await gotoRoot(page, base);
      await page.locator("#conv-status.running").waitFor();
      await page.evaluate(
        (css) => {
          (globalThis as any).document.querySelector("#theme").textContent =
            css;
        },
        renderThemeCss(
          themePalettes.find((palette) => palette.name === theme)!,
        ),
      );
      const shot = (stage: string) =>
        screenshot(
          page,
          `${width}x${height}-${theme.replaceAll(" ", "-")}-${stage}`,
        );
      await waitForLayout(page);
      const assertHeaderRow = async (ids: string[]) => {
        const boxes = await Promise.all(
          ids.map((id) => page.locator(id).boundingBox()),
        );
        const header = (await page.locator("#topbar").boundingBox())!;
        expect(header.height).toBe(48);
        for (const box of boxes) {
          expect(box).toBeTruthy();
          expect(
            Math.abs(box!.y + box!.height / 2 - (header.y + header.height / 2)),
          ).toBeLessThan(2);
        }
        for (let i = 1; i < boxes.length; i++)
          expect(boxes[i]!.x).toBeGreaterThanOrEqual(
            boxes[i - 1]!.x + boxes[i - 1]!.width,
          );
      };
      await assertHeaderRow(
        width < 700
          ? ["#up-top", "#conv-status", "#conv-title"]
          : ["#up-top", "#conv-status", "#conv-title", "#chip-kids"],
      );
      if (width < 700) {
        expect(
          await page
            .locator("#conv-title")
            .evaluate((el) => el.scrollWidth > el.clientWidth),
        ).toBe(true);
      }
      for (const id of [
        "#up-top",
        "#conv-title",
        ...(width < 700 ? ["#menu-btn", "#pane-fab"] : []),
      ])
        await assertTouchTarget(page, id);
      await shot("closed");
      if (width === 1280) {
        expect(
          await page.locator("#menu-btn").getAttribute("aria-expanded"),
        ).toBe("true");
        const sidebarHeader = await page.locator("#brand").boundingBox();
        expect(await page.locator("#menu-btn").isVisible()).toBe(false);
        await page.locator("#input").blur();
        await page.keyboard.press("w");
        await page.locator("#window-key-hints").waitFor({ state: "visible" });
        await page.keyboard.press("f");
        await page.locator("#main.fullscreen #top-actions #new-top").waitFor();
        await assertHeaderRow([
          "#up-top",
          "#conv-status",
          "#conv-title",
          "#chip-kids",
          "#new-top",
        ]);
        await assertTouchTarget(page, "#new-top");
        await shot("chat-fullscreen");
        await page.keyboard.press("w");
        await page.locator("#window-key-hints").waitFor({ state: "visible" });
        await page.keyboard.press("f");
        await page.locator("#pane-rail > #new-top:first-child").waitFor();
        await page.keyboard.press("Shift+H");
        expect(await page.locator("#sidebar").isVisible()).toBe(false);
        await assertTouchTarget(page, "#menu-btn");
        expect(
          await page.locator("#menu-btn").getAttribute("aria-expanded"),
        ).toBe("false");
        expect((await page.locator("#topbar").boundingBox())!.height).toBe(48);
        await shot("sidebar-collapsed");
        await page.locator("#menu-btn").click();
        expect(await page.locator("#brand").boundingBox()).toEqual(
          sidebarHeader,
        );
        expect(
          await page.locator("#menu-btn").getAttribute("aria-expanded"),
        ).toBe("true");
        expect(await page.locator("#pane-fab").isVisible()).toBe(false);
        expect(await page.locator("#menu-btn").isVisible()).toBe(false);
        expect(
          await page.locator("#agent-list-foot #trash-btn").isVisible(),
        ).toBe(true);
        await context.close();
        continue;
      }
      await page.locator("#scroll.content-above").waitFor();
      if (width === 412)
        await (
          await context.newCDPSession(page)
        ).send(
          "Emulation.setSafeAreaInsetsOverride" as any,
          {
            insets: { top: 40, topMax: 40, bottom: 24, bottomMax: 24 },
          } as any,
        );
      await page.locator("#pane-fab").click();
      expect(
        await page.locator("#pane-menu.on").evaluate((menu) => {
          const document = menu.ownerDocument;
          const header = document.querySelector("#topbar")!;
          const box = menu.getBoundingClientRect();
          const more = document.querySelector("#pane-fab")!;
          const button = more.getBoundingClientRect();
          return {
            moreHits: more.contains(
              document.elementFromPoint(
                button.left + button.width / 2,
                button.top + button.height / 2,
              ),
            ),
            nearRightEdge:
              document.documentElement.clientWidth - box.right <= 16,
            aboveHeader:
              Number((globalThis as any).getComputedStyle(menu).zIndex) >
              Number((globalThis as any).getComputedStyle(header).zIndex),
            belowHeader: box.top >= header.getBoundingClientRect().bottom,
            topEdgeHits: [
              box.left + 12,
              box.left + box.width / 2,
              box.right - 12,
            ].map((x) =>
              menu.contains(document.elementFromPoint(x, box.top + 3)),
            ),
          };
        }),
      ).toEqual({
        moreHits: true,
        nearRightEdge: true,
        aboveHeader: true,
        belowHeader: true,
        topEdgeHits: [true, true, true],
      });
      await assertTouchTarget(page, "#trash-btn");
      const menuTop = (await page.locator("#pane-menu").boundingBox())!.y;
      const items = page.locator("#pane-menu .pane-menu-item:visible");
      const iconBoxes = [];
      for (const item of await items.all()) {
        await item.scrollIntoViewIfNeeded();
        const id = await item.getAttribute("id");
        await assertTouchTarget(
          page,
          id
            ? `#${id}`
            : `#pane-menu [data-pane="${await item.getAttribute("data-pane")}"]`,
        );
        const icon = item.locator("svg");
        expect(await icon.count()).toBe(1);
        expect(await icon.getAttribute("aria-hidden")).toBe("true");
        iconBoxes.push((await icon.boundingBox())!);
      }
      for (const box of iconBoxes) {
        expect(box.width).toBe(16);
        expect(box.height).toBe(16);
        expect(box.x).toBe(iconBoxes[0].x);
      }
      if (height === 280) {
        expect(
          await page.locator("#pane-menu").evaluate((menu) => menu.scrollTop),
        ).toBeGreaterThan(0);
        expect((await page.locator("#pane-menu").boundingBox())!.y).toBe(
          menuTop,
        );
        const menuBottom = await page
          .locator("#pane-menu")
          .evaluate((menu) => menu.getBoundingClientRect().bottom);
        expect(menuBottom).toBeLessThanOrEqual(height);
      }
      await page.locator("#pane-fab").click();
      await page.locator("#pane-menu").waitFor({ state: "hidden" });
      await page.locator("#pane-fab").click();
      await assertTouchTarget(page, "#trash-btn");
      const labels = await items.allTextContents();
      expect(labels.slice(0, 3).map((s) => s.trim())).toEqual([
        "Delete",
        "Take control",
        "Share link",
      ]);
      expect(
        await page
          .locator("#pane-menu-panels .pane-menu-item")
          .allTextContents(),
      ).toEqual(labels.slice(3));
      await shot("menu");
      await page.locator("#trash-btn").click();
      expect(deletes).toBe(0);
      expect(await page.locator("#trash-btn").innerText()).toBe(
        "Confirm delete agent and descendants",
      );
      expect(await page.locator(".hold-tip.on").count()).toBe(0);
      const itemBox = (await page.locator("#trash-btn").boundingBox())!;
      const label = page.locator("#trash-btn .action-label");
      const labelBox = (await label.boundingBox())!;
      expect(labelBox.x).toBeGreaterThanOrEqual(itemBox.x);
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(
        itemBox.x + itemBox.width,
      );
      expect(
        await label.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await shot("confirmation");
      const deleted = page.waitForResponse(
        (response) =>
          response.url() === `${base}api/conversations/main` &&
          response.request().method() === "DELETE",
      );
      await page.locator("#trash-btn").click();
      await deleted;
      expect(deletes).toBe(1);
      await context.close();
    }
  },
  async function test_live_count_icons(browser, base) {
    const observed: { text: string; icons: number }[] = [];
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [
            { ...tree()[0], children: 4, status: "running" },
            ...Array.from({ length: 4 }, (_, i) => ({
              ...tree()[0],
              id: `child-${i}`,
              parent: "main",
              title: `Child ${i}`,
              status: "running",
            })),
          ],
        }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv(),
        status: "running",
        active_run: "live-header-run",
        shells: {
          status: "ready",
          active_count: 1,
          background_count: 1,
          items: [],
        },
      }));
      await gotoRoot(page, base);
      await page.locator(".live-panel .shell-chip").waitFor();
      await screenshot(page, `${width}-live`);
      for (const [selector, label] of [
        [".shell-chip", "1 active shell"],
        [".agent-chip", "4 active agents"],
      ]) {
        const chip = page.locator(`.live-panel ${selector}`);
        expect(await chip.getAttribute("aria-label")).toContain(label);
        expect(await chip.getAttribute("title")).toContain(label);
        observed.push({
          text: (await chip.innerText()).trim(),
          icons: await chip.locator("svg[aria-hidden=true]").count(),
        });
      }
      await context.close();
    }
    expect(observed).toEqual([
      { text: "1", icons: 1 },
      { text: "4", icons: 1 },
      { text: "1", icons: 1 },
      { text: "4", icons: 1 },
    ]);
  },
  async function test_last_turn_state_badge(browser, base) {
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({ json: [{ ...tree()[0], children: 2 }] }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv(),
        status: "interrupted",
      }));
      await gotoRoot(page, base);
      const state = page.getByRole("img", {
        name: "interrupted — context kept",
      });
      await state.waitFor();
      await screenshot(page, `${width}-state`);
      expect(await state.getAttribute("id")).toBe("chip-state");
      expect((await state.innerText()).trim()).toBe("");
      expect(await state.locator("svg[aria-hidden=true]").count()).toBe(1);
      const box = (await state.boundingBox())!;
      expect(box.width).toBe(box.height);
      const kids = (await page
        .locator(width === 412 ? "#conv-title" : "#chip-kids")
        .boundingBox())!;
      if (width !== 412) expect(box.height).toBe(kids.height);
      expect(box.y + box.height / 2).toBeCloseTo(kids.y + kids.height / 2, 0);
      const [warn] = await themeColors(page, "var(--warn)");
      expect(
        await state.evaluate(
          (el) => (globalThis as any).getComputedStyle(el).color,
        ),
      ).toBe(warn);
      await context.close();
    }
  },
  async function test_mobile_sidebar_parent_control(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({
        json: [
          { ...tree()[0], parent: "parent" },
          { ...tree("parent")[0], title: "Parent", children: 1 },
        ],
      }),
    );
    await mockConversation(page, base, "main", () => ({
      ...idleConv([
        row(
          "a1",
          "assistant",
          "```text\n" + "long line ".repeat(100) + "\n```",
        ),
      ]),
      parent: "parent",
    }));
    await mockConversation(page, base, "parent", () => ({
      ...idleConv(),
      id: "parent",
      title: "Parent",
    }));
    await gotoRoot(page, base);
    await page.locator(".content pre").waitFor();
    await page.locator("#menu-btn").tap();
    expect(await page.locator("#up-top.on").count()).toBe(1);
    await page.locator("#sidebar .agent.selected").tap();
    await page.locator("#up-top").tap();
    await page.waitForFunction(
      "document.querySelector('#conv-title')?.textContent === 'Parent'",
    );
    expect(await page.locator("#up-top.on").count()).toBe(0);
    await context.close();
  },
  // Regression: #3354 A closed desktop Chat must have a visible way back. (also Feature #3372 closed windows reopen where they were.)
  async function test_closed_chat_reopens(browser, base) {
    const { demo } = await postFixture(base, "seed-published-sizes");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const root = rootAgentId();
    await gotoRoot(page, base);
    await waitForLayout(page);
    const chatTab = page.locator('#dock .dv-tab[data-dock-panel="chat"]');
    const chatButton = page.locator(
      '#pane-rail-panels .rail-btn[data-pane="chat"]',
    );
    const parked = page.locator(".dock-parking #main");
    const focused = (selector: string) =>
      page.waitForFunction(
        (selector) =>
          (globalThis as any).document.activeElement?.matches(selector),
        selector,
      );
    const closeChat = async () => {
      await chatTab.getByRole("button").click();
      await parked.waitFor({ state: "attached" });
      await chatButton.and(page.locator('[aria-expanded="false"]')).waitFor();
    };
    const reopened = async () => {
      await page
        .locator('#dock .dock-panel[data-dock-panel="chat"] #main')
        .waitFor();
      await chatButton.and(page.locator('[aria-expanded="true"]')).waitFor();
    };
    expect(
      await page
        .locator("#pane-rail-panels .rail-btn")
        .first()
        .getAttribute("data-pane"),
    ).toBe("chat");
    expect(await chatButton.getAttribute("title")).toBe("Chat (g1)");
    await closeChat();
    expect(
      await chatButton.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return [
          [0, 0],
          [-21, 0],
          [21, 0],
          [0, -21],
          [0, 21],
        ].every(([dx, dy]) =>
          button.contains(
            button.ownerDocument.elementFromPoint(x + dx, y + dy),
          ),
        );
      }),
    ).toBeTrue();
    await screenshot(page, "1280x800-chat-closed");
    await chatButton.click();
    await reopened();
    await focused("#scroll");
    await page.keyboard.press("w");
    await page.keyboard.press("q");
    await parked.waitFor({ state: "attached" });
    await page.keyboard.press("g");
    await page.keyboard.press("1");
    await reopened();
    await focused("#scroll");
    await closeChat();
    await page.locator(`.agent[data-id="${root}"]`).click();
    await reopened();
    await closeChat();
    await page.locator("#new-top").click();
    await reopened();
    await focused("#input");
    await gotoRoot(page, base);
    await page.locator(`.agent.selected[data-id="${root}"]`).waitFor();
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await page.locator('#dock .dv-tab[data-dock-panel="explorer"]').waitFor();
    await closeChat();
    await page.reload();
    await page.locator('#dock .dv-tab[data-dock-panel="explorer"]').waitFor();
    await reopened();
    const tab = (id: string) =>
      page.locator(`#dock .dv-tab[data-dock-panel="${id}"]`);
    const tips = page.locator('#pane-rail .rail-btn[data-pane="tips"]');
    await tips.click();
    await tab("tips").waitFor();
    const windows = () =>
      page.evaluate(async () => {
        const win = globalThis as any;
        await new Promise((done) =>
          win.requestAnimationFrame(() => win.requestAnimationFrame(done)),
        );
        return [...win.document.querySelectorAll("#dock .dv-groupview")]
          .map((group: any) => {
            const { left, top, width, height } = group.getBoundingClientRect();
            const tabs = [...group.querySelectorAll(".dv-tab")];
            const ids = tabs.map((tab: any) => tab.dataset.dockPanel).join();
            return { ids, box: [left, top, width, height] as number[] };
          })
          .sort((a: any, b: any) => a.box[0] - b.box[0]);
      });
    const [first] = await windows();
    await tab("chat").click();
    await page.keyboard.type("wrlll");
    await page.keyboard.press("Enter");
    const placed = await windows();
    expect(placed[0]!.box[2]).toBeGreaterThan(first!.box[2]! + 20);
    const places = async () => {
      const now = await windows();
      const moved = now.some((window, index) =>
        window.box.some(
          (v, side) => Math.abs(v - placed[index]!.box[side]!) > 1,
        ),
      );
      return { ids: now.map((window) => window.ids), moved };
    };
    const unmoved = { ids: ["chat", "tips", "explorer"], moved: false };
    expect(await places()).toEqual(unmoved);
    await closeChat();
    await page.keyboard.type("g1");
    await reopened();
    expect(await places()).toEqual(unmoved);
    await tab("tips").getByRole("button").click();
    await tab("tips").waitFor({ state: "detached" });
    await tips.click();
    await tab("tips").waitFor();
    expect(await places()).toEqual(unmoved);
    for (const id of [demo, root]) {
      await closeChat();
      await page.locator(`.agent[data-id="${id}"]`).click();
      await page.locator(`.agent.selected[data-id="${id}"]`).waitFor();
      await reopened();
    }
    await tab("explorer").waitFor();
    expect(await places()).toEqual(unmoved);
    await closeChat();
    await tab("tips").getByRole("button").click();
    await tab("tips").waitFor({ state: "detached" });
    await chatButton.click();
    await reopened();
    expect((await places()).ids).toEqual(["chat", "explorer"]);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["header", tests]]);
