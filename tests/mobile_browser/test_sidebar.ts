import { expect } from "bun:test";
import { join } from "node:path";
import { gotoRoot, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Feature: #2526 phone-only density must not override desktop sidebar styling.
  async function test_sidebar_compact_rows(browser, base) {
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const response = await context.request.post(
        `${base}__browser-test/seed-sidebar-compact`,
      );
      expect(response.ok()).toBe(true);
      const page = await context.newPage();
      await gotoRoot(page, base);
      if (width === 412) {
        await page.locator("#menu-btn").click();
        await page.waitForFunction(
          () =>
            (globalThis as any).document
              .querySelector("#sidebar")
              .getBoundingClientRect().x === 0,
        );
      }
      const rows = page.locator("#agent-list .agent");
      await page.waitForFunction(
        () =>
          (globalThis as any).document.querySelectorAll("#agent-list .agent")
            .length === 10,
      );
      await page.locator("#sidebar").evaluate(async () => {
        await (globalThis as any).document.fonts.ready;
      });
      if (process.env.RECURSE_SCREENSHOT_DIR)
        await page.screenshot({
          path: join(
            process.env.RECURSE_SCREENSHOT_DIR,
            `compact-sidebar-${width}.png`,
          ),
        });
      const boxes = await rows.evaluateAll((elements) =>
        elements.map((el) => {
          const rect = el.getBoundingClientRect();
          const style = (globalThis as any).getComputedStyle(
            el.querySelector(".title")!,
          );
          return {
            top: rect.top,
            height: rect.height,
            font: parseFloat(style.fontSize),
            padding: parseFloat(
              (globalThis as any).getComputedStyle(el).paddingTop,
            ),
          };
        }),
      );
      const desktopRowHeight = 12.15 * 1.6 + 2 * 4 + 2;
      for (const [index, box] of boxes.entries()) {
        if (width === 412) {
          expect(box.height).toBeGreaterThanOrEqual(30);
          expect(box.height).toBeLessThanOrEqual(34);
        } else {
          expect(box.height).toBeCloseTo(desktopRowHeight, 1);
        }
        expect(box.font).toBe(width === 412 ? 15 : 12.15);
        expect(box.padding).toBe(width === 412 ? 2 : 4);
        if (index) {
          const step = box.top - boxes[index - 1]!.top;
          if (width === 412) {
            expect(step).toBeGreaterThanOrEqual(31);
            expect(step).toBeLessThanOrEqual(36);
          } else {
            expect(step).toBeCloseTo(desktopRowHeight + 1, 1);
          }
        }
      }
      const idleMarks = page.locator(
        "#agent-list .agent-state.idle .state-mark",
      );
      expect(await idleMarks.count()).toBeGreaterThan(0);
      for (const mark of await idleMarks.all()) {
        expect(
          await mark.evaluate((element) => {
            const style = (globalThis as any).getComputedStyle(element);
            return {
              background: style.backgroundColor,
              border: style.borderStyle,
              width: style.width,
            };
          }),
        ).toEqual({
          background: "rgba(0, 0, 0, 0)",
          border: "solid",
          width: "8px",
        });
      }
      const child = page.locator('.agent[data-id="compact-sidebar-0"]');
      await child.click({
        position: { x: (await child.boundingBox())!.width - 4, y: 16 },
      });
      await page
        .locator('.agent.selected[data-id="compact-sidebar-0"]')
        .waitFor();
      await context.close();
    }
  },
  // Regression: #2696 discovery before the home tree must not freeze empty ranks.
  async function test_sidebar_prefers_operator_messages_on_hourly_resort(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const now = Date.now();
    await page.clock.setFixedTime(now);
    const seed = async (phase: number) => {
      const response = await context.request.post(
        `${base}__browser-test/seed-sidebar-order`,
        {
          data: { phase },
        },
      );
      expect(response.ok()).toBe(true);
      return (await response.json()).operator_message_at as number;
    };
    await seed(0);
    await page.addInitScript(() => {
      (globalThis as any).addEventListener("recurse:backends-change", () => {
        (globalThis as any).backendDiscoveryFinished = true;
      });
    });
    await page.route("**/api/tree", async (route) => {
      const response = await route.fetch();
      await page.waitForFunction(
        () => (globalThis as any).backendDiscoveryFinished,
      );
      await route.fulfill({ response });
    });
    await page.goto(base);
    const rows = page.locator(
      '.agent[data-id="operator-recent"], .agent[data-id="agent-active"], .agent[data-id="no-operator"]',
    );
    const order = () =>
      rows.evaluateAll((elements) =>
        elements.map((el) => el.getAttribute("data-id")),
      );
    await page.locator('.agent[data-id="operator-recent"]').waitFor();
    expect(await order()).toEqual([
      "no-operator",
      "operator-recent",
      "agent-active",
    ]);
    await page.unrouteAll({ behavior: "wait" });
    const latest = await seed(1);
    await page.waitForResponse(async (response) => {
      if (!response.url().endsWith("/api/tree")) return false;
      const nodes = await response.json();
      return nodes.some(
        (node: any) =>
          node.id === "operator-recent" && node.operator_message_at === latest,
      );
    });
    expect(await order()).toEqual([
      "no-operator",
      "operator-recent",
      "agent-active",
    ]);
    await page.clock.setFixedTime(now + 3_600_001);
    await page.waitForFunction(() => {
      const ids = Array.from(
        (globalThis as any).document.querySelectorAll(".agent"),
        (el: any) => el.dataset.id,
      );
      return ids.indexOf("operator-recent") < ids.indexOf("no-operator");
    });
    expect(await order()).toEqual([
      "operator-recent",
      "no-operator",
      "agent-active",
    ]);
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.RECURSE_SCREENSHOT_DIR, "sidebar-1280.png"),
      });
    await context.close();
  },
  // Feature: #2869 shared tree links limit discovery and copy a subagent's root.
  async function test_shared_tree_links(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const response = await context.request.post(
      `${base}__browser-test/seed-shared-trees`,
    );
    expect(response.ok()).toBeTrue();
    const { ids } = (await response.json()) as { ids: string[] };
    const [first, child, second] = ids;
    const chosen = ids.slice(0, 4);
    const page = await context.newPage();
    const openSidebar = async () => {
      await page.locator("#menu-btn").click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document
            .querySelector("#sidebar")
            .getBoundingClientRect().x === 0,
      );
    };
    await page.goto(`${base}#trees=${first},${second}`);
    await openSidebar();
    const rows = page.locator("#agent-list .agent");
    const rowIds = () =>
      rows.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-id")).sort(),
      );
    await page.locator(`.agent[data-id="${child}"]`).waitFor();
    expect(await rowIds()).toEqual([first, child, second].sort());
    expect(
      await page.locator(`.agent.selected[data-id="${first}"]`).count(),
    ).toBe(1);
    await page.locator(`.agent[data-id="${second}"]`).click();
    await openSidebar();
    await page.locator(`.agent[data-id="${ids[3]}"]`).waitFor();
    expect(await rowIds()).toEqual([first, second, ids[3]].sort());
    await page.locator(`.agent[data-id="${first}"]`).click();
    await openSidebar();
    expect(await page.locator("#new-top").isVisible()).toBeFalse();
    expect(await page.locator("#shared-tree-status").innerText()).toBe(
      "2 shared conversations",
    );
    expect(await page.getByRole("button", { name: "Show all" }).count()).toBe(
      0,
    );
    await page.locator(`.agent[data-id="${child}"]`).click();
    await page
      .locator(`#conv-title`, { hasText: "Shared tree fixture 1" })
      .waitFor();
    expect(
      new URLSearchParams(new URL(page.url()).hash.slice(1)).get("trees"),
    ).toBe(`${first},${second}`);
    await page.reload();
    await openSidebar();
    await page.locator(`.agent.selected[data-id="${child}"]`).waitFor();
    expect(await rowIds()).toEqual([first, child, second].sort());
    await page.locator("#menu-btn").click();
    await page.locator("#input").fill("@");
    await page.locator("#agent-finder.on").waitFor();
    const options = page.locator("#agent-menu .agent-option");
    expect(await options.count()).toBe(chosen.length - 1);
    const titles = await options.allTextContents();
    for (let index = 0; index < ids.length; index++)
      expect(
        titles.some((title) => title.includes(`Shared tree fixture ${index}`)),
      ).toBe(index < chosen.length && index !== 1);
    await page.locator("#input").fill("");
    await page.locator("#agent-finder.on").waitFor({ state: "detached" });
    await page.locator("#pane-fab").tap();
    await page.locator("#pane-menu.on").waitFor();
    await page
      .getByRole("menuitem", { name: "Share link", exact: true })
      .click();
    await page
      .locator("#share-link-status", { hasText: "Link copied" })
      .waitFor();
    expect(await page.locator("#pane-menu").isVisible()).toBeFalse();
    const copied = await page.evaluate(() =>
      (globalThis as any).navigator.clipboard.readText(),
    );
    expect(copied).toBe(`${base}#trees=${first}`);
    await page.goto(copied);
    await openSidebar();
    await page.locator(`.agent[data-id="${child}"]`).waitFor();
    expect(await rowIds()).toEqual([first, child].sort());
    await context.close();
  },
];
