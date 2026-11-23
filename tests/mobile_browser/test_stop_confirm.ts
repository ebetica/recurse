import { expect } from "bun:test";
import type { Browser, Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  gotoRoot,
  mockConversation,
  openPage,
  runBrowserTests,
  type BrowserTest,
} from "./common";
import { runConv, tree } from "./fixtures";

const pollStop = (read: () => unknown, message: string) =>
  browserExpect.poll(read, { message, intervals: [20] });

async function runTokenlessStopLookupRace(
  browser: Browser,
  base: string,
  staleFirst: boolean,
): Promise<void> {
  const { context, page, errors } = await openPage(browser, {
    viewport: { width: 1280, height: 800 },
  });
  const posts: any[] = [];
  const runningState = runConv("running", null);
  const oldState = { ...runningState, active_run: "run-old" };
  const replacementState = { ...runningState, active_run: "run-new" };
  const phase = {
    name: "initial",
    heldA: [] as any[],
    heldC: [] as any[],
    heldPoll: [] as any[],
    pollReleased: false,
    staleReleasedAfterCurrent: false,
  };
  await page.route(`${base}api/tree`, (route: Route) =>
    route.fulfill({
      json: [
        { ...tree("main", "running")[0], active_run: null, children: 1 },
        {
          id: "other",
          parent: "main",
          title: "Other",
          status: "idle",
          kind: null,
          children: 0,
        },
      ],
    }),
  );
  await page.route(`${base}api/conversations/other**`, (route: Route) =>
    route.fulfill({ json: runConv("idle", null) }),
  );
  await mockConversation(page, base, "main", () => runningState);
  await page.route(`${base}api/conversations/main**`, (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname !== "/api/conversations/main")
      return route.fallback();
    const purpose = requestUrl.searchParams.get("purpose");
    const focused = requestUrl.searchParams.get("focused") === "1";
    const traced =
      route.request().headers()["x-recurse-client-dispatch-ms"] !== undefined;
    if (
      phase.name === "hold-a" &&
      (purpose === "stop" || (focused && !traced))
    ) {
      phase.name = "a-held";
      phase.heldA.push(route);
      return;
    }
    if (
      purpose !== "stop" &&
      !(phase.name === "hold-c" && focused && !traced)
    ) {
      if (phase.name === "a-held" && !phase.heldPoll.length) {
        phase.heldPoll.push(route);
        return;
      }
      return route.fulfill({
        json: phase.name === "c-held" ? replacementState : runningState,
      });
    }
    if (phase.name === "initial") {
      phase.name = "idle";
      return route.fulfill({ json: runningState });
    }
    if (phase.name === "b-tokenless") {
      phase.name = "idle-b";
      return route.fulfill({ json: runningState });
    }
    if (
      phase.name === "hold-c" &&
      (purpose === "stop" || (focused && !traced))
    ) {
      phase.name = "c-held";
      if (!phase.heldC.length) {
        if (staleFirst)
          for (const held of phase.heldA) held.fulfill({ json: oldState });
        route.fulfill({ json: replacementState });
        if (!staleFirst) {
          for (const held of phase.heldA) held.fulfill({ json: oldState });
          phase.staleReleasedAfterCurrent = true;
        }
      }
      phase.heldC.push(route);
      return;
    }
    if (phase.name === "c-held" && purpose === "stop")
      return route.fulfill({ json: replacementState });
    return route.fulfill({ json: runningState });
  });
  await page.route(`${base}api/conversations/main/deliver`, (route: Route) => {
    const body = route.request().postDataJSON();
    posts.push(body);
    return route.fulfill({
      json: {
        ok: true,
        run_id: body.run_id,
        stop_id: body.stop_id,
        status: "stopping",
      },
    });
  });
  try {
    await gotoRoot(page, base);
    await page.locator("#send.stop").waitFor();
    expect(await page.locator("#send").getAttribute("aria-label")).toBe(
      "Stop this agent",
    );
    expect(await page.locator("#send.armed").count()).toBe(0);
    phase.name = "hold-a";
    await page.locator("#send").click();
    await pollStop(() => phase.name, "first held lookup").toBe("a-held");
    await page.evaluate("void fetch('/api/conversations/main?focused=1')");
    await pollStop(() => phase.heldPoll.length, "held polling lookup").toBe(1);
    await phase.heldPoll[0].fulfill({ json: runningState });
    phase.pollReleased = true;
    await page.locator('.agent[data-id="other"]').click();
    await page.locator('.agent[data-id="main"]').click();
    phase.name = "b-tokenless";
    await page.locator("#send.stop").waitFor();
    phase.name = "hold-c";
    await page.locator("#send").click();
    await pollStop(() => phase.name, "replacement lookup").toBe("c-held");
    expect(phase.pollReleased).toBeTrue();
    await page.waitForFunction(
      "document.querySelector('#send')?.getAttribute('aria-label') === 'Confirm stop this agent'",
    );
    expect(posts).toHaveLength(0);
    await page.locator("#send").click();
    await pollStop(() => posts.length, "tokenless race Stop").toBe(1);
    expect(posts[0].run_id).toBe("run-new");
    if (!staleFirst) expect(phase.staleReleasedAfterCurrent).toBeTrue();
    await page.locator("#send.stop").waitFor();
    expect(await page.locator("#send.error").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  }
}

export const tests: BrowserTest[] = [
  // Regression: #2009 confirmed Stop stays pending until its response
  async function test_stop_request_id_fallback_dispatches_once(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    const posts: any[] = [];
    let heldStop: Route | null = null;
    const diagnostics: any[] = [];
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({ json: tree("main", "running") }),
    );
    await mockConversation(page, base, "main", () => runConv());
    await page.route(`${base}api/conversations/main/deliver`, (route) => {
      const body = route.request().postDataJSON();
      posts.push(body);
      heldStop = route;
      return;
    });
    await page.route(`${base}api/stop-diagnostics**`, (route) => {
      diagnostics.push(route.request().postDataJSON());
      return route.fulfill({ status: 204 });
    });
    await page.addInitScript(
      "Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined })",
    );
    await gotoRoot(page, base);
    expect(
      String(await page.evaluate("typeof globalThis.crypto.randomUUID")),
    ).toBe("undefined");
    const stop = page.locator("#send.stop");
    await stop.waitFor();
    await stop.click();
    expect(await stop.getAttribute("aria-label")).toBe(
      "Confirm stop this agent",
    );
    expect(
      await stop.evaluate((element) => element.classList.contains("armed")),
    ).toBeTrue();
    expect(posts.length).toBe(0);
    await stop.click();
    await pollStop(() => posts.length, "Stop request without randomUUID").toBe(
      1,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      run_id: "run-browser",
      stop_id: posts[0].stop_id,
    });
    expect(posts[0].run_id).toBe("run-browser");
    expect(posts[0].stop_id).toBeTruthy();
    expect(
      await stop.evaluate((element) => element.classList.contains("stopping")),
    ).toBeTrue();
    await heldStop!.fulfill({
      json: {
        ok: true,
        run_id: "run-browser",
        stop_id: posts[0].stop_id,
        status: "stopping",
        updated: Date.now(),
      },
    });
    expect(await page.locator("#input").isDisabled()).toBeFalse();
    await page.locator("#input").fill("queued after Stop");
    expect(await page.locator("#input").inputValue()).toBe("queued after Stop");
    await pollStop(
      () => diagnostics.some((row) => row.event === "request_id_fallback"),
      "fallback diagnostics",
    ).toBe(true);
    const fallback = diagnostics.filter(
      (row) => row.event === "request_id_fallback",
    );
    expect(fallback).toHaveLength(1);
    expect(fallback[0].request_id_generator).toBe("get_random_values");
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2009 tokenless Stop targets the replacement run
  async function test_tokenless_run_replacement_stays_scoped(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
    const posts: any[] = [];
    let resolved = "run-old";
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({ json: tree("main", "running") }),
    );
    await mockConversation(page, base, "main", () =>
      runConv("running", resolved),
    );
    await page.route(`${base}api/conversations/main/deliver`, (route) => {
      const body = route.request().postDataJSON();
      posts.push(body);
      return route.fulfill(
        body.run_id === "run-old"
          ? { status: 409, json: { detail: "run replaced" } }
          : {
              json: {
                ok: true,
                run_id: body.run_id,
                stop_id: body.stop_id,
                status: "stopping",
              },
            },
      );
    });
    await gotoRoot(page, base);
    const stop = page.locator("#send.stop");
    await stop.waitFor();
    await stop.click();
    await page.waitForFunction(
      "document.querySelector('#send')?.getAttribute('aria-label') === 'Confirm stop this agent'",
    );
    resolved = "run-new";
    await stop.click();
    await pollStop(() => posts.length, "stale-run Stop").toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].run_id).toBe("run-new");
    await page.waitForFunction(
      "document.querySelector('#send')?.getAttribute('aria-label') === 'Stop this agent'",
    );
    expect(posts).toHaveLength(1);
    expect(await page.locator("#send").getAttribute("aria-label")).toBe(
      "Stop this agent",
    );
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_mobile_send_button_becomes_confirmed_stop(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
    const stops: any[] = [];
    const steers: any[] = [];
    let state = runConv();
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({ json: tree("main", state.status) }),
    );
    await mockConversation(page, base, "main", () => state);
    await page.route(`${base}api/conversations/main/deliver`, (route) => {
      const body = route.request().postDataJSON();
      if (body.run_id) {
        stops.push(body);
        return route.fulfill({
          json: {
            ok: true,
            run_id: body.run_id,
            stop_id: body.stop_id,
            status: "stopping",
          },
        });
      }
      steers.push(body);
      return route.fulfill({
        json: { message_id: "steer-mobile", steer: true },
      });
    });
    await gotoRoot(page, base);
    const stop = page.locator("#send.stop");
    await stop.waitFor();
    expect(await page.locator("#stop-btn").count()).toBe(0);
    expect(
      await page.getByRole("button", { name: "Stop this agent" }).count(),
    ).toBe(1);
    expect(await stop.getAttribute("title")).toBe("Stop this agent");
    expect(await page.locator("#send").count()).toBe(1);
    state.status = "error";
    await page.waitForFunction(
      "!document.querySelector('#conv-status')?.classList.contains('running')",
      null,
      { timeout: 5_000 },
    );
    await stop.waitFor();
    expect(await stop.getAttribute("title")).toBe("Stop this agent");
    expect(await page.locator("#conv-status").count()).toBe(1);
    state.status = "running";
    await page.waitForFunction(
      "document.querySelector('#conv-status')?.classList.contains('running')",
      null,
      { timeout: 5_000 },
    );
    await stop.click();
    expect(await stop.getAttribute("aria-label")).toBe(
      "Confirm stop this agent",
    );
    expect(
      await stop.evaluate((element) => element.classList.contains("armed")),
    ).toBeTrue();
    expect(stops).toHaveLength(0);
    await page.waitForFunction(
      "!document.querySelector('#send')?.classList.contains('armed') && document.querySelector('#send')?.getAttribute('aria-label') === 'Stop this agent'",
    );
    expect(await stop.getAttribute("aria-label")).toBe("Stop this agent");
    expect(await page.locator("#send.stop").count()).toBe(1);
    await stop.click();
    await page.keyboard.press("Escape");
    expect(await stop.getAttribute("aria-label")).toBe("Stop this agent");
    await stop.click();
    await page.locator("#input").fill("steer while working");
    const send = page.getByRole("button", { name: "Send message" });
    expect(await send.count()).toBe(1);
    expect(
      await page
        .locator("#send")
        .evaluate((e) => e.classList.contains("armed")),
    ).toBeFalse();
    await send.click();
    await pollStop(() => steers.length, "working-turn steer").toBe(1);
    expect(steers[0].content).toBe("steer while working");
    expect(stops).toHaveLength(0);
    await page.locator("#input").fill("temporary");
    await page.locator("#input").fill("");
    await stop.waitFor();
    expect(await stop.getAttribute("aria-label")).toBe("Stop this agent");
    await stop.click();
    expect(await stop.getAttribute("aria-label")).toBe(
      "Confirm stop this agent",
    );
    expect(stops).toHaveLength(0);
    state.status = "idle";
    state.active_run = null;
    await page.waitForFunction(
      "document.querySelector('#send')?.getAttribute('aria-label') === 'Send message'",
      null,
      { timeout: 5_000 },
    );
    expect(await page.locator("#send.armed").count()).toBe(0);
    state = runConv("running", "run-mobile-2");
    await stop.waitFor({ timeout: 5_000 });
    await stop.click();
    expect(await stop.getAttribute("aria-label")).toBe(
      "Confirm stop this agent",
    );
    await stop.click();
    await pollStop(() => stops.length, "confirmed mobile Stop").toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_errored_active_run_remains_keyboard_stoppable(
    browser,
    base,
  ) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    const stops: any[] = [];
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({
        json: [
          ...tree("main", "error"),
          { ...tree("other")[0], title: "Other" },
        ],
      }),
    );
    await mockConversation(page, base, "main", () =>
      runConv("error", "run-reader-error"),
    );
    await mockConversation(page, base, "other", () => ({
      ...runConv("idle", null),
      id: "other",
      title: "Other",
    }));
    await page.route(`${base}api/conversations/main/deliver`, (route) => {
      const body = route.request().postDataJSON();
      stops.push(body);
      return route.fulfill({
        json: {
          ok: true,
          run_id: body.run_id,
          stop_id: body.stop_id,
          status: "stopping",
        },
      });
    });
    await gotoRoot(page, base);
    await page.locator("#send.stop").waitFor();
    await page.locator("#input").press("Escape");
    await page.keyboard.press("j");
    expect(await page.locator(".agent.cursor").getAttribute("data-id")).toBe(
      "other",
    );
    expect(
      await page
        .locator("#sidebar [aria-current=page]")
        .getAttribute("data-id"),
    ).toBe("main");
    await page.keyboard.press("k");
    await page.locator("#send.stop").waitFor();
    await page.waitForFunction(
      "document.querySelector('#sidebar [aria-current=page]')?.getAttribute('data-id') === 'main'",
    );
    expect(
      await page
        .locator("#sidebar [aria-current=page]")
        .getAttribute("data-id"),
    ).toBe("main");
    await page.evaluate(
      "document.querySelector('#input').dispatchEvent(new FocusEvent('focusout',{bubbles:true}))",
    );
    await page.keyboard.press("q");
    expect(await page.locator("#key-mode").innerText()).toBe(
      "q again to interrupt",
    );
    await page.keyboard.press("q");
    await pollStop(() => stops.length, "errored-run keyboard Stop").toBe(1);
    expect(stops[0].run_id).toBe("run-reader-error");
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #3217 Keep newer reads on the replacement run.
  async function test_tokenless_stop_lookup_race(browser, base) {
    await runTokenlessStopLookupRace(browser, base, true);
  },
  async function test_tokenless_stop_lookup_race_b_wins(browser, base) {
    await runTokenlessStopLookupRace(browser, base, false);
  },
];
if (import.meta.main) await runBrowserTests([["hold-confirm", tests]]);
