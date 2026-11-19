import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
declare const window: any;
declare const document: any;
declare const PageTransitionEvent: any;
import {
  postFixture,
  startServer,
  stopServer,
  waitForLayout,
  rootAgentId,
  type BrowserTest,
} from "./common";
import { standalonePhone } from "./standalone";

export const tests: BrowserTest[] = [
  // Regression: #3407 a same-session view rebuild must not remount settled replies or diagrams.
  async function test_wake_keeps_settled_nodes_after_view_eviction(
    _browser,
    base,
  ) {
    const { demo } = await postFixture(base, "seed-theme-surfaces");
    const phone = await standalonePhone(base);
    const { page, context, session } = phone;
    const viewers = new Set<object>();
    page.on("request", (request) => {
      if (new URL(request.url()).searchParams.get("viewing") === "true")
        viewers.add(request);
    });
    const closed = (request: object) => viewers.delete(request);
    page.on("requestfinished", closed);
    page.on("requestfailed", closed);
    try {
      await page.goto(`${base}#agent=${demo}`);
      await page.locator(".mermaid-host svg").waitFor();
      await page.locator("#input").fill("Reply only Wake diagram ready.");
      await page.locator("#send").click();
      await page.getByText("Wake diagram ready.", { exact: true }).waitFor();
      await page.locator("#conv-status.running").waitFor({ state: "detached" });
      await page.locator("#input").blur();
      await page.locator("#scroll").evaluate((element) => {
        element.dispatchEvent(new Event("recurse:reader-scroll"));
        element.scrollTop = 0;
      });
      await waitForLayout(page);
      expect(
        await page.evaluate<boolean>(
          "matchMedia('(display-mode: standalone)').matches",
        ),
      ).toBe(true);
      const svg = await page.locator(".mermaid-host svg").elementHandle();
      const reply = await page
        .getByText("Wake diagram ready.", { exact: true })
        .elementHandle();
      const before = await (
        await page.request.get(`${base}api/conversations/${demo}/view`)
      ).json();
      const cover = await context.newPage();
      await cover.bringToFront();
      await page.waitForFunction("document.hidden");
      await browserExpect.poll(() => viewers.size).toBe(0);
      await session.send("Page.setWebLifecycleState", { state: "frozen" });
      let next = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < 205) {
            const number = next++;
            const created = await page.request.post(
              `${base}api/conversations`,
              {
                data: {
                  parent: rootAgentId(),
                  title: `Wake cache pressure ${number}`,
                },
              },
            );
            expect(created.ok()).toBeTrue();
            const { id } = await created.json();
            expect(
              (
                await page.request.get(`${base}api/conversations/${id}/view`)
              ).ok(),
            ).toBeTrue();
          }
        }),
      );
      const painted = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/ui-timing") &&
          response
            .request()
            .postDataJSON()
            .some((entry: { label: string }) => entry.label === "wake:painted"),
      );
      await session.send("Page.setWebLifecycleState", { state: "active" });
      await page.bringToFront();
      await painted;
      await waitForLayout(page);
      const after = await (
        await page.request.get(`${base}api/conversations/${demo}/view`)
      ).json();
      expect(after.instance_id).not.toBe(before.instance_id);
      expect(after.session).toBe(before.session);
      expect(await svg!.evaluate((element) => element.isConnected)).toBeTrue();
      expect(
        await reply!.evaluate((element) => element.isConnected),
      ).toBeTrue();
      expect(
        (
          await page.request.post(`${base}api/conversations/${demo}/clear`)
        ).ok(),
      ).toBeTrue();
      await page
        .getByText("Wake diagram ready.", { exact: true })
        .waitFor({ state: "detached" });
      await page.locator("#input").fill("Reply only New session after wake.");
      await page.locator("#send").click();
      await page
        .getByText("New session after wake.", { exact: true })
        .waitFor();
      const cleared = await (
        await page.request.get(`${base}api/conversations/${demo}/view`)
      ).json();
      expect(cleared.session).not.toBe(after.session);
      expect(await svg!.evaluate((element) => element.isConnected)).toBeFalse();
      expect(
        await reply!.evaluate((element) => element.isConnected),
      ).toBeFalse();
    } finally {
      await phone.close();
    }
  },
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
  // Regression: #3409 failed or older fallback reads must not replace newer ready events.
  async function test_wake_ignores_view_results_older_than_ready_events(
    _browser,
    base,
  ) {
    const { demo } = await postFixture(base, "seed-theme-surfaces");
    for (const mode of ["failed", "older"] as const) {
      const phone = await standalonePhone(base);
      const { page, context, session } = phone;
      let releaseRead!: () => void;
      const gate = new Promise<void>((resolve) => (releaseRead = resolve));
      let readArrived!: () => void;
      let readFailed!: (error: unknown) => void;
      const arrived = new Promise<void>((resolve, reject) => {
        readArrived = resolve;
        readFailed = reject;
      });
      void arrived.catch(() => {});
      let armed = false;
      let heldRoute: import("playwright").Route | undefined;
      try {
        await page.goto(`${base}#agent=${demo}`);
        await page.locator(".mermaid-host svg").waitFor();
        await page.locator("#input").fill(`Reply only Before ${mode} wake.`);
        await page.locator("#send").click();
        await page.getByText(`Before ${mode} wake.`, { exact: true }).waitFor();
        await page
          .locator("#conv-status.running")
          .waitFor({ state: "detached" });
        await waitForLayout(page);
        const svg = await page.locator(".mermaid-host svg").elementHandle();
        await page.route(
          `**/api/conversations/${demo}/view?**`,
          async (route) => {
            if (!armed || heldRoute) return route.continue();
            heldRoute = route;
            let response: import("playwright").APIResponse | undefined;
            try {
              if (mode === "older") {
                const url = new URL(route.request().url());
                url.searchParams.set("since", "-1");
                response = await route.fetch({ url: url.toString() });
                const snapshot = await response.json();
                expect(snapshot.status).toBe("ready");
                expect(snapshot.reset).toBeTrue();
              }
            } catch (error) {
              readFailed(error);
              await route.abort();
              return;
            }
            readArrived();
            await gate;
            if (response) await route.fulfill({ response });
            else
              await route.fulfill({
                status: 503,
                json: { detail: "Sleeping read failed" },
              });
          },
        );
        const cover = await context.newPage();
        await cover.bringToFront();
        await page.waitForFunction("document.hidden");
        await session.send("Page.setWebLifecycleState", { state: "frozen" });
        const painted = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/ui-timing") &&
            response
              .request()
              .postDataJSON()
              .some(
                (entry: { label: string }) => entry.label === "wake:painted",
              ),
        );
        void painted.catch(() => {});
        armed = true;
        await session.send("Page.setWebLifecycleState", { state: "active" });
        await page.bringToFront();
        await arrived;
        await painted;
        if (mode === "older") {
          await page
            .locator("#input")
            .fill(`Reply only Ready after ${mode} wake.`);
          await page.locator("#send").click();
        }
        const reply = page.getByText(
          mode === "older"
            ? `Ready after ${mode} wake.`
            : `Before ${mode} wake.`,
          { exact: true },
        );
        await reply.waitFor();
        await page
          .locator("#conv-status.running")
          .waitFor({ state: "detached" });
        await waitForLayout(page);
        const replyNode = await reply.elementHandle();
        await page.evaluate(() => {
          const w = window as any;
          w.wakeInsertedError = false;
          new w.MutationObserver((changes: any[]) => {
            for (const change of changes)
              for (const node of change.addedNodes)
                if (
                  node instanceof w.Element &&
                  (node.matches(".history-unavailable") ||
                    node.querySelector(".history-unavailable"))
                )
                  w.wakeInsertedError = true;
          }).observe(document.querySelector("#messages")!, {
            childList: true,
            subtree: true,
          });
        });
        const oldResult = page.waitForResponse(
          (response) => response.request() === heldRoute?.request(),
        );
        releaseRead();
        await (await oldResult).finished();
        await waitForLayout(page);
        expect(
          await page.evaluate<boolean>("window.wakeInsertedError"),
        ).toBeFalse();
        expect(await page.locator(".history-unavailable").count()).toBe(0);
        expect(
          await svg!.evaluate((element) => element.isConnected),
        ).toBeTrue();
        expect(
          await replyNode!.evaluate((element) => element.isConnected),
        ).toBeTrue();
      } finally {
        releaseRead();
        await page.unrouteAll({ behavior: "wait" });
        await phone.close();
      }
    }
  },
];
