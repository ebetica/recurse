import { expect } from "bun:test";
import { join } from "node:path";
import type { UiStall } from "../../src/web/timing_labels";
import { gotoRoot, startServer, stopServer, type BrowserTest } from "./common";
export const tests: BrowserTest[] = [
  async function test_interaction_timing(browser) {
    const server = await startServer();
    try {
      for (const fallback of [false, true]) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        });
        if (fallback)
          await context.addInitScript(
            "window.PerformanceObserver = undefined; crypto.randomUUID = undefined",
          );
        const page = await context.newPage();
        await gotoRoot(page, server.base);
        await page.locator(".agent").first().waitFor();
        await page.locator("#menu-btn").tap();
        if (!fallback) {
          await page.route("**/stall-probe.js?*", (route) =>
            route.fulfill({
              contentType: "application/javascript",
              body: `
      new PerformanceObserver(list => {
        for (const entry of list.getEntries())
          if (entry.name === 'click' && entry.target?.closest('#settings-btn')) window.observedTap = entry.duration;
      }).observe({type: 'event', durationThreshold: 16});
      document.getElementById('settings-btn').addEventListener('click', function stallProbe() {
        for (const end = performance.now() + 300; performance.now() < end;) {}
      });
    `,
            }),
          );
          await page.addScriptTag({
            url: new URL("stall-probe.js?private=value#fragment", server.base)
              .href,
          });
        }
        const received = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/ui-timing") &&
            response
              .request()
              .postDataJSON()
              .some(
                (item: { label: string }) =>
                  item.label === "click:settings-btn",
              ),
        );
        await page.locator("#settings-btn").tap();
        const response = await received;
        if (!fallback) {
          const stall = response
            .request()
            .postDataJSON()
            .find(
              (item: UiStall) => item.label === "main_thread_blocked",
            ) as UiStall;
          expect(stall).toBeDefined();
          expect(stall.markers.length).toBeLessThanOrEqual(8);
          expect(stall.scripts.length).toBeLessThanOrEqual(3);
          if (
            await page.evaluate(
              "PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')",
            )
          ) {
            expect(
              stall.scripts.some(
                (script) =>
                  script.sourceURL === "/stall-probe.js" &&
                  script.sourceFunctionName === "stallProbe",
              ),
            ).toBe(true);
          }
          for (const script of stall.scripts) {
            expect(script.sourceURL).not.toMatch(/[?#@]/);
            expect(script.sourceFunctionName.length).toBeLessThanOrEqual(80);
          }
        }
        expect(response.status()).toBe(204);
        const item = response
          .request()
          .postDataJSON()
          .find(
            (item: { label: string }) => item.label === "click:settings-btn",
          );
        if (!fallback)
          expect(item.ms).toBe(await page.evaluate("window.observedTap"));
        const expected = `event=ui_timing conversation_id=${item.conversation_id} label=${item.label} ms=${item.ms}`;
        const file = Bun.file(join(server.data, "data", "logs", "recurse.log"));
        let log = "";
        for (
          const deadline = Date.now() + 5000;
          Date.now() < deadline && !log.includes(expected);
        ) {
          log = await file.text();
          if (!log.includes(expected)) await Bun.sleep(50);
        }
        expect(log).toContain(expected);
        if (!fallback) {
          expect(log).toContain("event=main_thread_blocked");
          expect(log).toMatch(/script_\d_url=\/stall-probe\.js/);
          expect(log).toMatch(/script_\d_function=stallProbe/);
          expect(log).not.toContain("private=value");
        }
        await context.close();
      }
      console.log(
        "PASS: real mobile tap uses observed Event Timing or paint fallback and reaches server log",
      );
    } finally {
      await stopServer(server);
    }
  },
];
