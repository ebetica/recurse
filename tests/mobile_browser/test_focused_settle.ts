import { expect } from "bun:test";
import { URL as NodeURL } from "node:url";
import type { Page, Request } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { postFixture, type BrowserTest } from "./common";

type ReplyGate = {
  armed: boolean;
  running: boolean;
  heartbeatReady: boolean;
  terminalSeen: boolean;
  release(): void;
};

type GatedBrowser = typeof globalThis & {
  replyGate: ReplyGate;
  settleTestDocument?: string;
};

async function gateReplyStream(page: Page, path: string, recovery: boolean) {
  await page.addInitScript(
    ({ path, recovery }) => {
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        if (!response.body || new URL(response.url).pathname !== path)
          return response;
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const held: Uint8Array[] = [];
        let buffer = "";
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            start(output) {
              (globalThis as GatedBrowser).replyGate = {
                armed: false,
                running: false,
                heartbeatReady: false,
                terminalSeen: false,
                release() {
                  if (!held.length)
                    throw new Error("No frame held by the SSE gate");
                  if (!recovery) this.armed = false;
                  for (const frame of held.splice(0)) output.enqueue(frame);
                },
              };
            },
            transform(chunk, output) {
              const gate = (globalThis as GatedBrowser).replyGate;
              buffer += decoder.decode(chunk, { stream: true });
              for (let end; (end = buffer.indexOf("\n\n")) !== -1; ) {
                const frame = buffer.slice(0, end + 2);
                buffer = buffer.slice(end + 2);
                const bytes = encoder.encode(frame);
                const line = frame
                  .split("\n")
                  .find((line) => line.startsWith("data: "));
                if (line) {
                  const page = JSON.parse(line.slice(6));
                  if (page.turn_status === "running" && page.active_run)
                    gate.running = true;
                  if (gate.armed) {
                    const terminal =
                      page.turn_status === "idle" && !page.active_run;
                    if (terminal) gate.terminalSeen = true;
                    if (!recovery) held.push(bytes);
                    if (!recovery || terminal) continue;
                  }
                } else if (
                  recovery &&
                  gate.running &&
                  !gate.heartbeatReady &&
                  frame.startsWith(": heartbeat\n")
                ) {
                  held.push(bytes);
                  gate.heartbeatReady = true;
                  continue;
                }
                output.enqueue(bytes);
              }
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      };
    },
    { path, recovery },
  );
}

const run: (
  recovery: boolean,
  ...args: Parameters<BrowserTest>
) => Promise<void> = async (recovery, browser, base) => {
  const { agent } = await postFixture(base, "seed-focused-settle", {
    recovery,
  });
  const page = await browser.newPage();
  const conversation = `/api/conversations/${agent}`;
  const isEvents = (url: NodeURL) => url.pathname === `${conversation}/events`;
  const isView = (url: NodeURL) => url.pathname === `${conversation}/view`;
  const isTail = (url: NodeURL) => isView(url) && url.searchParams.has("since");
  const isMetadata = (url: NodeURL) =>
    url.pathname === conversation && url.searchParams.get("focused") === "1";
  const isIdle = async (response: {
    ok(): boolean;
    json(): Promise<unknown>;
  }) =>
    response.ok() &&
    ((await response.json()) as { status?: string }).status === "idle";
  const terminalSeen = Promise.withResolvers<void>();
  const earlyView = Promise.withResolvers<string>();
  const releaseCatchUp = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let armed = false;
  let closing = false;
  let recovering = false;
  let catchUp: Request | undefined;
  const blockedViews: string[] = [];
  try {
    await gateReplyStream(page, `${conversation}/events`, recovery);
    await page.route(isEvents, async (route) => {
      if (!armed) return route.continue();
      await finished.promise;
      await route.abort();
    });
    await page.route(isView, async (route) => {
      if (!armed) return route.continue();
      const url = new NodeURL(route.request().url());
      if (recovering && !catchUp && isTail(url)) {
        catchUp = route.request();
        await releaseCatchUp.promise;
        return closing ? route.abort() : route.continue();
      }
      blockedViews.push(url.pathname + url.search);
      earlyView.resolve(
        `requested ${isTail(url) ? "/view?since=" : "/view"} before the stream settled`,
      );
      await finished.promise;
      await route.abort();
    });
    await page.route(isMetadata, async (route) => {
      if (!armed) return route.continue();
      const response = await route.fetch();
      if (await isIdle(response)) await terminalSeen.promise;
      return closing ? route.abort() : route.fulfill({ response });
    });
    await Promise.all([
      page.waitForResponse((r) => r.ok() && isEvents(new NodeURL(r.url()))),
      page.goto(`${base}#agent=${agent}`),
    ]);
    const sent = await page.request.post(
      `${base}api/conversations/${agent}/deliver`,
      {
        data: { content: "Finish the focused reply." },
      },
    );
    expect(sent.ok()).toBeTrue();
    const stop = page.locator("#send.stop");
    await browserExpect(stop).toBeVisible();
    await page.waitForFunction((recovery) => {
      const gate = (globalThis as GatedBrowser).replyGate;
      return gate?.running && (!recovery || gate.heartbeatReady);
    }, recovery);
    await page.evaluate((agent) => {
      const browser = globalThis as GatedBrowser;
      browser.settleTestDocument = agent;
      browser.replyGate.armed = true;
    }, agent);
    armed = true;
    await Promise.all([
      page.waitForResponse(
        (r) => isMetadata(new NodeURL(r.url())) && isIdle(r),
      ),
      (async () => {
        await postFixture(base, "release", { agent });
        await page.waitForFunction(
          () => (globalThis as GatedBrowser).replyGate.terminalSeen,
        );
        terminalSeen.resolve();
      })(),
    ]);
    const first = await Promise.race([
      stop.waitFor({ state: "hidden" }).then(() => "Stop hidden"),
      earlyView.promise,
    ]);
    expect(first).toBe("Stop hidden");
    expect(blockedViews).toEqual([]);
    const answer = page.getByText("The focused reply is complete.", {
      exact: true,
    });
    const settled = page
      .locator("#messages .msg.assistant")
      .filter({ has: answer })
      .getByRole("button", { name: /^View activity token usage/ });
    await browserExpect(settled).toHaveCount(0);
    if (recovery) {
      recovering = true;
      await Promise.all([
        page.waitForResponse((r) => r.ok() && r.request() === catchUp),
        (async () => {
          await Promise.all([
            page.waitForRequest((r) => isTail(new NodeURL(r.url()))),
            page.evaluate(() =>
              (globalThis as GatedBrowser).replyGate.release(),
            ),
          ]);
          await browserExpect(settled).toHaveCount(0);
          releaseCatchUp.resolve();
        })(),
      ]);
    } else {
      await page.evaluate(() =>
        (globalThis as GatedBrowser).replyGate.release(),
      );
    }
    await browserExpect(settled).toBeVisible();
    expect(
      await page.evaluate(
        () => (globalThis as GatedBrowser).settleTestDocument,
      ),
    ).toBe(agent);
    expect(blockedViews).toEqual([]);
  } finally {
    closing = true;
    const unrouted = page.unrouteAll({ behavior: "ignoreErrors" });
    terminalSeen.resolve();
    finished.resolve();
    releaseCatchUp.resolve();
    try {
      await unrouted;
      await page.close();
    } finally {
      await postFixture(base, "release", { agent });
    }
  }
};

export const tests: BrowserTest[] = [
  // Regression: #3509 idle metadata hides Stop without rereading the held terminal SSE rows.
  async function test_idle_poll_waits_for_focused_rows(...args) {
    await run(false, ...args);
  },
  // Regression: #3509 a lost terminal frame recovers final rows even when the stream sends a heartbeat.
  async function test_missing_terminal_frame_catches_up(...args) {
    await run(true, ...args);
  },
];
