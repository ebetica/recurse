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
  // Regression: #3220 Wake must replace the stalled viewing request.
  async function test_wake_reconnects_a_silent_stream(browser) {
    for (const mode of ["visible", "pageshow", "frozen", "focus"]) {
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
            if (
              !new URL(String(args[0]), w.location.href).pathname.endsWith(
                "/events",
              ) ||
              !response.body
            )
              return response;
            const reader = response.body.getReader();
            return new Response(
              new ReadableStream({
                async pull(controller) {
                  const next = await reader.read().catch((error: unknown) => {
                    w.streamClosed = true;
                    throw error;
                  });
                  if (w.stallEvents) {
                    w.streamStalled = true;
                    await new Promise(() => {});
                  }
                  if (next.done) controller.close();
                  else controller.enqueue(next.value);
                },
                cancel() {
                  w.streamClosed = true;
                  void reader.cancel().catch(() => {});
                },
              }),
              { status: response.status, headers: response.headers },
            );
          };
        });
        const { agent } = await postFixture(server.base, "seed-durable-clear");
        const page = await context.newPage();
        const viewers = new Set<object>();
        page.on("request", (request) => {
          if (new URL(request.url()).searchParams.get("viewing") === "true")
            viewers.add(request);
        });
        const closed = (request: object) => viewers.delete(request);
        page.on("requestfailed", closed);
        page.on("requestfinished", closed);
        await page.goto(`${server.base}#agent=${agent}`);
        await browserExpect.poll(() => viewers.size).toBe(1);
        await page.locator("#input").fill("First reply");
        await page.locator("#send").click();
        await page
          .getByText("Before Durable clear.", { exact: true })
          .waitFor();
        await browserExpect.poll(() => viewers.size).toBe(1);
        const stalledViewers = new Set(viewers);
        await page.evaluate((mode) => {
          (window as any).stallEvents = true;
          if (mode !== "focus") {
            Object.defineProperty(document, "hidden", {
              configurable: true,
              value: true,
            });
            document.dispatchEvent(new Event("visibilitychange"));
          }
        }, mode);
        if (mode !== "focus") {
          await page.waitForFunction("window.streamClosed === true");
          await browserExpect.poll(() => viewers.size).toBe(0);
        }
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
        if (mode === "focus")
          await page.waitForFunction("window.streamStalled === true");
        if (mode === "frozen")
          await session.send("Page.setWebLifecycleState", { state: "active" });
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
          else if (mode === "focus") window.dispatchEvent(new Event("focus"));
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
        await browserExpect
          .poll(
            () =>
              viewers.size === 1 &&
              [...viewers].every((request) => !stalledViewers.has(request)),
          )
          .toBe(true);
        if (mode === "visible") {
          await page.goBack();
          await page.locator("html.phone-list").waitFor();
          await browserExpect.poll(() => viewers.size).toBe(0);
          await page.goForward();
          await browserExpect.poll(() => viewers.size).toBe(1);
          const side = await context.newPage();
          const stream = side.waitForRequest((request) =>
            new URL(request.url()).pathname.endsWith("/events"),
          );
          await side.goto(`${server.base}?embed=1#agent=${agent}`);
          expect(
            new URL((await stream).url()).searchParams.has("viewing"),
          ).toBe(false);
          await side.close();
        }
      } finally {
        await context.close();
        await stopServer(server);
      }
    }
  },
  // Regression: #2977 a stalled first thread read must not hold every later read.
  async function test_wake_recovers_a_stalled_first_thread_read(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-clear");
    const page = await browser.newPage();
    expect(
      (
        await page.request.post(`${base}api/conversations/${agent}/deliver`, {
          data: { content: "Reply before the stalled read." },
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
    await page.addInitScript(() => {
      const w = window as any;
      const now = performance.now.bind(performance);
      w.clockOffset = 0;
      performance.now = () => now() + w.clockOffset;
    });
    let stalled: import("playwright").Route | null = null;
    let held = () => {};
    const firstRead = new Promise<void>((resolve) => (held = resolve));
    await page.route(`**/api/conversations/${agent}/view?**`, (route) => {
      if (stalled) return route.continue();
      stalled = route;
      held();
      return undefined;
    });
    try {
      await page.goto(`${base}#agent=${agent}`);
      await firstRead;
      await page.evaluate(() => {
        (window as any).clockOffset += 11_000;
        window.dispatchEvent(new Event("focus"));
      });
      await page
        .locator(".msg.assistant .content", {
          hasText: "Before Durable clear.",
        })
        .waitFor();
    } finally {
      await (stalled as import("playwright").Route | null)
        ?.abort()
        .catch(() => {});
      await page.close();
    }
  },
];
