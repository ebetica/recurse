import { expect } from "bun:test";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  LOGIN,
  gotoRoot,
  showAgentList,
  startServer,
  stopServer,
} from "./common";

export async function assertSectionSpacing(
  browser: Browser,
  home: BrowserContext,
  base: string,
  ids: { stale: string; archived: string },
): Promise<void> {
  const remote = await startServer({ auth: true });
  const remoteContext = await browser.newContext();
  try {
    const login = await fetch(remote.base + "login", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ password: LOGIN }),
    });
    expect(login.status).toBe(303);
    await remoteContext.addCookies([
      {
        name: "chat_auth",
        value: login.headers
          .get("set-cookie")!
          .split(";")[0]!
          .slice("chat_auth=".length),
        url: remote.base,
      },
    ]);
    const seeded = await remoteContext.request.post(
      remote.base + "__browser-test/seed-sidebar-sections",
    );
    expect(seeded.ok()).toBeTrue();
    const remoteIds = await seeded.json();
    for (const [context, at, pinned, archived] of [
      [home, base, ids.stale, ids.archived],
      [remoteContext, remote.base, remoteIds.stale, remoteIds.archived],
    ] as const) {
      for (const [id, tag] of [
        [pinned, "pinned"],
        [archived, "archived"],
      ])
        expect(
          (
            await context.request.post(at + "api/sidebar/tags", {
              data: { ids: [id], set: { [tag!]: null } },
            })
          ).ok(),
        ).toBeTrue();
    }
    expect(
      (
        await home.request.post(base + "api/backends", {
          data: { label: "zemingbot", url: remote.base, password: LOGIN },
        })
      ).ok(),
    ).toBeTrue();
    const visualGaps: { section: string; gap: number }[] = [];
    for (const [width, height, appearance] of [
      [412, 915, "dark"],
      [412, 915, "light"],
      [1280, 800, "dark"],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      try {
        expect(
          (
            await context.request.post(base + "api/settings/theme", {
              data: {
                theme:
                  appearance === "light" ? "GitHub Light" : "Material Dark",
              },
            })
          ).ok(),
        ).toBeTrue();
        const page = await context.newPage();
        await gotoRoot(page, base);
        await browserExpect(page.locator("html")).toHaveCSS(
          "color-scheme",
          appearance,
        );
        await showAgentList(page);
        await page
          .locator(`.agent[data-id="zemingbot/${remoteIds.fresh}"]`)
          .waitFor();
        const headers = page.locator("#agent-list .tree-section-header");
        await browserExpect(headers).toHaveCount(8);
        for (const header of await headers.all()) {
          const toggle = header.locator(".tree-section-toggle");
          if ((await toggle.getAttribute("aria-expanded")) === "false")
            await toggle.click();
        }
        await page
          .locator(`.agent[data-id="zemingbot/${remoteIds.archived}"]`)
          .waitFor();
        await page.evaluate(async () => {
          await (globalThis as any).document.fonts.ready;
        });
        await page.mouse.move(width - 1, height - 1);
        await page
          .locator("#agent-list")
          .evaluate((element) => (element.scrollTop = 0));
        if (process.env.RECURSE_SCREENSHOT_DIR)
          await page.screenshot({
            path: join(
              process.env.RECURSE_SCREENSHOT_DIR,
              `section-spacing-${width}-${appearance}.png`,
            ),
          });
        const gaps: number[] = [];
        for (const header of await headers.all()) {
          await header.scrollIntoViewIfNeeded();
          const geometry = await header.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const text = element.ownerDocument.createRange();
            text.selectNodeContents(
              element.querySelector(".tree-section-title")!,
            );
            const next = element.nextElementSibling!;
            return {
              section: element.getAttribute("data-section-key"),
              row: next.matches(".agent"),
              rowGap: next.getBoundingClientRect().top - box.bottom,
              visualGap:
                next.getBoundingClientRect().top -
                text.getBoundingClientRect().bottom,
            };
          });
          expect(geometry.row).toBeTrue();
          expect(geometry.rowGap).toBeGreaterThanOrEqual(0);
          expect(geometry.rowGap).toBeLessThanOrEqual(8);
          expect(geometry.visualGap).toBeGreaterThanOrEqual(0);
          gaps.push(geometry.visualGap);
          visualGaps.push({
            section: `${width}/${appearance}/${geometry.section}`,
            gap: geometry.visualGap,
          });
          if (width === 412) {
            for (const control of [
              header.locator(".tree-section-toggle"),
              header.locator("xpath=following-sibling::*[1]"),
            ]) {
              await control.scrollIntoViewIfNeeded();
              expect(
                await control.evaluate((element) => {
                  const box = element.getBoundingClientRect();
                  return [-21, 21].every((x) =>
                    [-21, 21].every((y) => {
                      const hit = element.ownerDocument.elementFromPoint(
                        box.x + box.width / 2 + x,
                        box.y + box.height / 2 + y,
                      );
                      return !!hit && element.contains(hit);
                    }),
                  );
                }),
              ).toBeTrue();
            }
          }
        }
        expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
      } finally {
        await context.close();
      }
    }
    for (const { section, gap } of visualGaps)
      expect(gap, section).toBeLessThanOrEqual(8);
  } finally {
    await home.request.delete(base + "api/backends/zemingbot");
    await home.request.post(base + "api/sidebar/tags", {
      data: { ids: [ids.stale], clear: ["pinned"] },
    });
    await home.request.post(base + "api/settings/theme", {
      data: { theme: "Material Dark", appearance: "dark" },
    });
    await remoteContext.close();
    await stopServer(remote);
  }
}
