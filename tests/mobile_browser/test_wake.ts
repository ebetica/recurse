import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
declare const window: any;
declare const document: any;
declare const PageTransitionEvent: any;
import {
  postFixture,
  startServer,
  stopServer,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2612 waking must not trust a silently stalled focused stream.
  async function test_wake_reconnects_a_silent_stream(browser) {
    for (const mode of ["visible", "pageshow", "frozen"]) {
      const server = await startServer();
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        await context.addInitScript(() => {
          const w = window as any;
          const original = window.fetch;
          window.fetch = async (...args: Parameters<typeof fetch>) => {
            const response = await original(...args);
            if (!String(args[0]).endsWith("/events") || !response.body)
              return response;
            const reader = response.body.getReader();
            return new Response(
              new ReadableStream({
                async pull(controller) {
                  const next = await reader.read();
                  if (w.stallEvents) {
                    w.streamStalled = true;
                    await new Promise(() => {});
                  }
                  if (next.done) controller.close();
                  else controller.enqueue(next.value);
                },
                cancel() {
                  void reader.cancel().catch(() => {});
                },
              }),
              { status: response.status, headers: response.headers },
            );
          };
        });
        const { agent } = await postFixture(server.base, "seed-durable-clear");
        const page = await context.newPage();
        await page.goto(`${server.base}#agent=${agent}`);
        await page.locator("#input").fill("First reply");
        await page.locator("#send").click();
        await page
          .getByText("Before Durable clear.", { exact: true })
          .waitFor();
        await page.evaluate(() => {
          (window as any).stallEvents = true;
          Object.defineProperty(document, "hidden", {
            configurable: true,
            value: true,
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        const session = await context.newCDPSession(page);
        if (mode === "frozen")
          await session.send("Page.setWebLifecycleState", { state: "frozen" });
        expect(
          (
            await page.request.post(
              `${server.base}api/conversations/${agent}/deliver`,
              { data: { content: "Second reply while hidden" } },
            )
          ).ok(),
        ).toBeTrue();
        await browserExpect
          .poll(async () =>
            (
              await page.request.get(
                `${server.base}api/conversations/${agent}/view`,
              )
            ).text(),
          )
          .toContain("After Durable clear.");
        if (mode === "frozen")
          await session.send("Page.setWebLifecycleState", { state: "active" });
        await page.waitForFunction("window.streamStalled === true");
        expect(
          await page.getByText("After Durable clear.", { exact: true }).count(),
        ).toBe(0);
        const report = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/ui-timing") &&
            response
              .request()
              .postDataJSON()
              .some((item: { label: string }) => item.label === "wake:painted"),
        );
        void report.catch(() => {});
        await page.evaluate((mode) => {
          (window as any).stallEvents = false;
          Object.defineProperty(document, "hidden", {
            configurable: true,
            value: false,
          });
          if (mode === "pageshow")
            window.dispatchEvent(
              new PageTransitionEvent("pageshow", { persisted: true }),
            );
          else document.dispatchEvent(new Event("visibilitychange"));
        }, mode);
        await page
          .getByText("After Durable clear.", { exact: true })
          .waitFor({ timeout: 1000 });
        const response = await report;
        expect(response.status()).toBe(204);
        const timing = response
          .request()
          .postDataJSON()
          .find((item: { label: string }) => item.label === "wake:painted");
        expect(timing.conversation_id).toBe(agent);
        // test-check-allow: T6 Wake latency is the requested observable behaviour, measured after real reply paint.
        expect(timing.ms).toBeLessThan(1000);
      } finally {
        await context.close();
        await stopServer(server);
      }
    }
  },
];
