declare const document: any;
declare const getComputedStyle: any;
import { expect } from "bun:test";
import { tree as fixtureTree } from "./fixtures";
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  runBrowserTests,
  turn,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  async function test_active_agents_use_sidebar_rows(browser, base) {
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        const recent = {
          ...fixtureTree()[0],
          updated: Date.now() / 1000 - 120,
        };
        const nodes = [
          { ...recent, title: "Coordinator", children: 2 },
          {
            ...recent,
            id: "child-1",
            parent: "main",
            title: "Header menu polish",
            status: "running",
            children: 1,
          },
          {
            ...recent,
            id: "child-2",
            parent: "child-1",
            title: "Active agents dialog",
            status: "working",
            children: 0,
          },
        ];
        await page.route(`${base}api/tree*`, (route) =>
          route.fulfill({ json: nodes }),
        );
        const stopped: any = turn("stopped", "Polish the interface", "");
        stopped.status = "interrupted";
        await mockConversation(page, base, "main", () => ({
          id: "main",
          title: "Coordinator",
          parent: null,
          status: "idle",
          active_run: null,
          msg_count: 2,
          window_cursor: 0,
          turns: [stopped],
          draft: null,
          pending: [],
        }));
        await mockConversation(page, base, "child-1", () => ({
          id: "child-1",
          title: "Header menu polish",
          parent: "main",
          status: "idle",
          active_run: null,
          msg_count: 0,
          window_cursor: 0,
          turns: [],
          draft: null,
          pending: [],
        }));
        await gotoRoot(page, base);
        await page.locator(".agent-chip").click();
        const dialog = page.getByRole("dialog", {
          name: "Active agents for Coordinator",
        });
        await dialog.waitFor();
        const close = dialog.getByRole("button", {
          name: "Close active agent details",
        });
        expect(
          await close.evaluate((el) => el === document.activeElement),
        ).toBe(true);
        if (process.env.ACTIVE_AGENTS_SCREENSHOTS) {
          await page.screenshot({
            path: `${process.env.ACTIVE_AGENTS_SCREENSHOTS}-${width}.png`,
          });
        }
        expect(await dialog.locator(".agent .agent-state").count()).toBe(2);
        expect(await dialog.locator(".shell-state").count()).toBe(0);
        expect(await dialog.locator(".kids").innerText()).toContain("1");
        const row = dialog.locator('[data-agent-id="child-1"]');
        expect(await row.locator(".time").isVisible()).toBe(true);
        if (width === 412) {
          expect(
            await dialog
              .locator(".agent")
              .evaluateAll((rows) =>
                rows.every((el) => el.getBoundingClientRect().height >= 44),
              ),
          ).toBe(true);
        }
        expect(
          await row.evaluate((el) => {
            const sidebar = document.querySelector(
              '#agent-list [data-id="child-1"]',
            );
            const properties = ["fontSize", "borderRadius"];
            return properties.every(
              (key) =>
                getComputedStyle(el)[key] === getComputedStyle(sidebar)[key],
            );
          }),
        ).toBe(true);
        const box = await close.boundingBox();
        expect(box?.width).toBe(44);
        expect(box?.height).toBe(44);
        await close.press("Tab");
        expect(await row.evaluate((el) => el === document.activeElement)).toBe(
          true,
        );
        await row.press("Shift+Tab");
        expect(
          await close.evaluate((el) => el === document.activeElement),
        ).toBe(true);
        if (width === 1280) await close.press("Escape");
        else await close.click();
        expect(await dialog.count()).toBe(0);
        expect(
          await page
            .locator(".agent-chip")
            .evaluate((el) => el === document.activeElement),
        ).toBe(true);
        await page.locator(".agent-chip").click();
        if (width === 1280) {
          await close.press("Tab");
          await row.press("Enter");
        } else {
          await row.tap();
        }
        await page.waitForURL(/#agent=child-1/);
        expect(await dialog.count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
];

if (import.meta.main) await runBrowserTests([["active-agents", tests]]);
