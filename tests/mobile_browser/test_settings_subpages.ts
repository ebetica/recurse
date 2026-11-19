import { expect } from "bun:test";
import type { Locator } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  gotoRoot,
  openSettingsPanel,
  runBrowserTests,
  type BrowserTest,
  expectHitCorners,
} from "./common";

async function centreHits(target: Locator): Promise<boolean> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(
      element.ownerDocument.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      ),
    );
  });
}

export const tests: BrowserTest[] = [
  // Regression: #3538 a phone-width resize keeps focus in the open detail; #3537 typed history days survive the settings load. (also Feature #3480 desktop Settings rows open sub-pages with a back link.)
  async function test_desktop_settings_rows_open_sub_pages(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    try {
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      const row = page.getByRole("button", {
        name: /^Deleted agents' history /,
      });
      const mcp = page.getByRole("button", { name: /^MCP servers / });
      const days = page.getByRole("spinbutton", {
        name: "Keep deleted agents' history (days)",
      });
      const title = page.getByRole("heading", {
        name: "Agents",
        exact: true,
      });
      const back = page.getByRole("button", {
        name: "Back to Agents",
        exact: true,
      });
      await browserExpect(row).toHaveAccessibleName(
        "Deleted agents' history 90 days",
      );
      await browserExpect(row).toBeVisible();
      await browserExpect(days).toBeHidden();
      await expectHitCorners(row);
      await row.click();
      await browserExpect(back).toBeFocused();
      await browserExpect(back).toHaveText("Agents");
      await expectHitCorners(back);
      await browserExpect(
        page.getByRole("heading", {
          name: "Deleted agents' history",
          level: 2,
        }),
      ).toBeVisible();
      await browserExpect(days).toBeVisible();
      const category = page.locator('.settings-cat[data-cat="agents"]');
      const mcpRow = category
        .locator(".settings-row")
        .filter({ hasText: /^MCP servers/ });
      await browserExpect(mcpRow).toBeAttached();
      await browserExpect(mcpRow).toBeHidden();
      await browserExpect(category.locator(":scope > header h2")).toBeHidden();
      await browserExpect(mcp).toHaveCount(0);
      await browserExpect(title).toHaveCount(0);
      await mcpRow.evaluate((element) => (element as any).focus());
      await browserExpect(back).toBeFocused();
      const subPage = page.locator("dialog.settings-subpage[open]");
      expect(
        await category.evaluate((pane) => {
          const box = pane.getBoundingClientRect();
          const bottom = Math.min(box.bottom, (globalThis as any).innerHeight);
          const sheet = pane.querySelector("dialog.settings-subpage[open]")!;
          return [0.1, 0.5, 0.9].every((x) =>
            [0.1, 0.5, 0.9].every((y) =>
              sheet.contains(
                pane.ownerDocument.elementFromPoint(
                  box.left + box.width * x,
                  box.top + (bottom - box.top) * y,
                ),
              ),
            ),
          );
        }),
      ).toBe(true);
      await browserExpect(subPage).toHaveCount(1);
      const accountNav = page.locator(
        '#settings-nav button[data-cat="account"]',
      );
      await browserExpect(accountNav).toBeVisible();
      await expectHitCorners(accountNav);
      const version = page.locator("#settings-release .settings-version");
      await browserExpect(version).toHaveText(/\S/);
      await browserExpect(version).toBeVisible();
      expect(await centreHits(version)).toBe(true);
      const close = page.locator("#settings-close");
      const save = page
        .getByRole("region", { name: "Deleted agents' history", exact: true })
        .getByRole("button", { name: "Save", exact: true });
      await save.focus();
      await page.keyboard.press("Tab");
      await browserExpect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await browserExpect(save).toBeFocused();
      await page.keyboard.press("Escape");
      await browserExpect(row).toBeFocused();
      await browserExpect(days).toBeHidden();
      await browserExpect(title).toBeVisible();
      await browserExpect(mcp).toBeVisible();
      await row.click();
      await days.fill("30");
      await save.click();
      await browserExpect(
        page.getByText("Saved. Applies during the next cleanup.", {
          exact: true,
        }),
      ).toBeVisible();
      await back.click();
      await browserExpect(row).toBeFocused();
      await browserExpect(row).toHaveAccessibleName(
        "Deleted agents' history 30 days",
      );
      await page.locator('#settings-nav button[data-cat="account"]').click();
      await browserExpect(
        page.getByRole("button", { name: "Change password", exact: true }),
      ).toBeVisible();
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      await row.click();
      const left = await subPage.elementHandle();
      await accountNav.click();
      expect(await left!.evaluate((dialog) => (dialog as any).open)).toBe(
        false,
      );
      await browserExpect(page.locator("dialog[open]")).toHaveCount(0);
      await browserExpect(
        page.getByRole("heading", { name: "Account", exact: true }),
      ).toBeVisible();
      await browserExpect(
        page.getByRole("button", { name: "Change password", exact: true }),
      ).toBeVisible();
      await browserExpect(accountNav).toBeFocused();
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      await browserExpect(row).toHaveAccessibleName(
        "Deleted agents' history 30 days",
      );
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(
        "**/api/settings/deleted-agent-history",
        async (route) => {
          if (route.request().method() === "GET") await held;
          await route.fallback();
        },
      );
      await page.reload();
      await openSettingsPanel(page);
      await row.click();
      await browserExpect(days).toBeDisabled();
      release();
      await browserExpect(days).toHaveValue("30");
      await days.fill("45");
      const done = page.getByRole("button", {
        name: "Close Deleted agents' history",
        exact: true,
      });
      const sheet = page.locator("dialog.settings-sheet[open]");
      for (const [width, phone] of [
        [700, true],
        [701, false],
      ] as const) {
        await page.setViewportSize({ width, height: 800 });
        await browserExpect(phone ? done : back).toBeVisible();
        await browserExpect(phone ? back : done).toBeHidden();
        await browserExpect(sheet).toHaveCount(1);
        expect(await sheet.evaluate((dialog) => dialog.matches(":modal"))).toBe(
          phone,
        );
        await browserExpect(days).toBeVisible();
        await browserExpect(days).toHaveValue("45");
        await browserExpect(days).toBeFocused();
      }
    } finally {
      await context.close();
    }
  },
];

if (import.meta.main) await runBrowserTests([["settings-subpages", tests]]);
