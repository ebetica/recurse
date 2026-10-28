import { expect } from "bun:test";
import type { Route } from "playwright";
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  routeArtifacts,
  runBrowserTests,
  type BrowserTest,
} from "./common";

const ladder = {
  default_level: 3,
  levels: Object.fromEntries(
    [1, 2, 3, 4, 5].map((level) => [
      String(level),
      {
        model: level % 2 ? "test/model-b" : "test/model-a",
        reasoning: ["low", "medium", "high", "max", "xhigh"][level - 1],
      },
    ]),
  ),
  reachability: Object.fromEntries(
    [1, 2, 3, 4, 5].map((level) => [
      String(level),
      {
        reachable: true,
        model: level % 2 ? "test/model-b" : "test/model-a",
        reasoning: ["low", "medium", "high", "max", "xhigh"][level - 1],
        reason: "",
      },
    ]),
  ),
  models: [
    { id: "test/model-a", label: "Test A" },
    { id: "test/model-b", label: "Test B" },
  ],
  reasoning: ["low", "medium", "high", "xhigh", "max"],
};
const tree = (status = "running") => [
  {
    id: "main",
    parent: null,
    updated: 1,
    title: "Coordinator",
    status,
    kind: null,
    children: 0,
    queued: 0,
    preview: "",
    muted: false,
  },
];
const running = (
  status = "running",
  active_run: string | null = "run-browser",
) => ({
  id: "main",
  title: "Coordinator",
  parent: null,
  status,
  kind: null,
  active_run,
  msg_count: 0,
  window_cursor: 0,
  turns: [],
  pending: [],
});
const waitValue = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
};

async function runTokenlessStopLookupRace(
  browser: any,
  base: string,
  staleFirst: boolean,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  const posts: any[] = [];
  const runningState = running("running", null);
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
        { ...tree()[0], active_run: null, children: 1 },
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
    route.fulfill({ json: running("idle", null) }),
  );
  await page.route(`${base}api/conversations/main**`, (route: Route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.pathname !== "/api/conversations/main")
      return route.continue();
    const purpose = requestUrl.searchParams.get("purpose");
    const focused = requestUrl.searchParams.get("focused") === "1";
    const traced = requestUrl.searchParams.has("switch_trace");
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
      return route.fulfill({ json: runningState });
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
    await waitValue(() => phase.name === "a-held", "first held lookup");
    await page.evaluate("void fetch('/api/conversations/main?focused=1')");
    await waitValue(() => phase.heldPoll.length === 1, "held polling lookup");
    await phase.heldPoll[0].fulfill({ json: runningState });
    phase.pollReleased = true;
    await page.locator('.agent[data-id="other"]').click();
    await page.locator('.agent[data-id="main"]').click();
    phase.name = "b-tokenless";
    await page.locator("#send.stop").waitFor();
    phase.name = "hold-c";
    await page.locator("#send").click();
    await waitValue(() => phase.name === "c-held", "replacement lookup");
    expect(phase.pollReleased).toBeTrue();
    await page.waitForFunction(
      "document.querySelector('#send')?.getAttribute('aria-label') === 'Confirm stop this agent'",
    );
    expect(posts).toHaveLength(0);
    await page.locator("#send").click();
    await waitValue(() => posts.length === 1, "tokenless race Stop");
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

// Regression: #2479 one confirm click stops the newer run despite an older lookup. (also #2410 model selection errors stay visible and retain manual retry.)
const modelSelectionError: BrowserTest = async (browser, base) => {
  for (const [index, model] of [
    "",
    "not-a-model",
    "fauxordinary/removed",
  ].entries()) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    try {
      const agent = `model-selection-${index}`;
      const seeded = await context.request.post(
        `${base}__browser-test/seed-model-selection-error`,
        { data: { agent, model } },
      );
      expect(seeded.ok()).toBeTrue();
      const page = await context.newPage();
      const errors = captureErrors(page);
      const sends: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().endsWith(`/api/conversations/${agent}/deliver`)
        )
          sends.push(request.postDataJSON().content);
      });
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#input:enabled").waitFor();
      await page
        .locator("#input")
        .fill("Keep this message while I choose a model");
      await page.locator("#input").press("Enter");
      await page.locator("#send-status.error").waitFor();
      const detail = `${model ? `Model ${model} is unavailable.` : "No model is selected for this conversation."} Pick another effort level in the model picker, or fix its model in Settings > Effort ladder.`;
      expect(await page.locator("#send-status").textContent()).toBe(
        `${detail} — Retry now`,
      );
      expect(await page.locator("#send-status").textContent()).not.toContain(
        "reconnecting",
      );
      expect(await page.locator("#send-status").textContent()).not.toContain(
        "durable",
      );
      expect(sends).toEqual(["Keep this message while I choose a model"]);
      await page.locator("#send-status").click();
      await page.locator("#send-status.error").waitFor();
      expect(sends).toEqual([
        "Keep this message while I choose a model",
        "Keep this message while I choose a model",
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
};

export const tests: BrowserTest[] = [
  async function compactComposerTargets(browser, base) {
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.locator("#input").fill("A message");
      const composer = (await page.locator("#composer").boundingBox())!;
      const input = (await page.locator("#input").boundingBox())!;
      expect(composer.height - input.height).toBeLessThanOrEqual(10);
      for (const selector of ["#attach", "#send"]) {
        const button = page.locator(selector);
        const box = (await button.boundingBox())!;
        expect(box.width).toBe(28);
        expect(box.height).toBe(28);
      }
      expect(input.x - composer.x).toBeLessThanOrEqual(42);
      await page.locator("#input").fill("More text\n".repeat(5));
      expect(
        (await page.locator("#composer").boundingBox())!.height,
      ).toBeGreaterThan(composer.height);
      await context.close();
    }
  },
  modelSelectionError,
  async function earlySendWaitsForSelection(browser, base) {
    const agent = "early-send-selection";
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = captureErrors(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const deliveries: { path: string; content: string }[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/deliver"))
        deliveries.push({
          path: new URL(request.url()).pathname,
          content: request.postDataJSON().content,
        });
    });
    await page.route(`${base}api/tree*`, async (route) => {
      await held;
      await route.continue();
    });
    try {
      expect(
        (
          await context.request.post(
            `${base}__browser-test/seed-model-selection-error`,
            {
              data: { agent, model: "fauxordinary/faux-1" },
            },
          )
        ).ok(),
      ).toBeTrue();
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      const input = page.locator("#input:enabled");
      await input.waitFor();
      const content = "Reply only Boot send reached the selected agent.";
      await input.fill(content);
      await input.press("Enter");
      expect(await page.locator("#send-status").textContent()).toBe(
        "Waiting for this agent to load…",
      );
      expect(await page.locator("#send-status").isVisible()).toBeTrue();
      expect(deliveries).toEqual([]);
      release();
      await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
      await page
        .getByText("Boot send reached the selected agent.", { exact: true })
        .waitFor();
      expect(deliveries).toEqual([
        { path: `/api/conversations/${agent}/deliver`, content },
      ]);
      expect(errors).toEqual([]);
    } finally {
      release();
      await context.close();
    }
  },
  async function missingSendTargetFailsFast(browser, base) {
    const agent = "missing-send-target";
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = captureErrors(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const deliveries: { content: string; client_message_id: string }[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith(`/conversations/${agent}/deliver`))
        deliveries.push(request.postDataJSON());
    });
    try {
      expect(
        (
          await context.request.post(
            `${base}__browser-test/seed-model-selection-error`,
            {
              data: { agent, model: "fauxordinary/faux-1" },
            },
          )
        ).ok(),
      ).toBeTrue();
      await page.goto(`${base}#agent=${agent}`);
      await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
      const holdReads = async (route: Route) => {
        if (route.request().method() === "GET") await held;
        await route.continue();
      };
      await page.route(`${base}api/tree*`, holdReads);
      await page.route(`${base}api/conversations/${agent}**`, holdReads);
      expect(
        (
          await context.request.delete(`${base}api/conversations/${agent}`)
        ).status(),
      ).toBe(202);
      let missing = false;
      for (let i = 0; !missing && i < 80; i++) {
        missing =
          (
            await context.request.get(`${base}api/conversations/${agent}/view`)
          ).status() === 404;
        if (!missing) await Bun.sleep(100);
      }
      expect(missing).toBeTrue();
      const input = page.locator("#input:enabled");
      await input.fill("Keep this message for the missing agent.");
      await input.press("Enter");
      const status = page.locator("#send-status.error");
      await status.waitFor({ timeout: 8000 });
      expect(await status.textContent()).toBe(
        "This agent is no longer available. — Retry now",
      );
      expect(deliveries.length).toBe(1);
      expect(deliveries[0].content).toBe(
        "Keep this message for the missing agent.",
      );
      const response = page.waitForResponse(
        `${base}api/conversations/${agent}/deliver`,
      );
      await status.click();
      expect((await response).status()).toBe(404);
      await status.waitFor();
      expect(deliveries.length).toBe(2);
      expect(deliveries[1]).toEqual(deliveries[0]);
      expect(errors).toEqual([]);
    } finally {
      release();
      await context.close();
    }
  },
  // Regression: #2248 pre-startup composer text survives selection (also Feature #2749 compact composer height follows text instead of its controls.; #2440 a boot-time Enter waits visibly, then reaches the real selection.; #2440 a real deleted target returns404 without the transient retry ladder.)
  async function test_input_typed_before_boot_survives_selection(
    browser,
    base,
  ) {
    const page = await browser.newPage();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/static/app.js?*", async (route) => {
      await held;
      await route.continue();
    });
    try {
      await page.goto(base, { waitUntil: "commit" });
      await page.locator("#input").fill("Composer draft survives refresh");
      release();
      await page.locator(".agent.selected").waitFor();
      expect(await page.locator("#input").inputValue()).toBe(
        "Composer draft survives refresh",
      );
      expect(await page.locator("#send").isEnabled()).toBeTrue();
    } finally {
      release();
      await page.close();
    }
  },
  // Regression: #2248 pre-tree composer text survives selection
  async function test_input_typed_before_first_tree_survives_selection(
    browser,
    base,
  ) {
    const page = await browser.newPage();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/tree", async (route) => {
      await held;
      await route.continue();
    });
    try {
      await gotoRoot(page, base);
      await page.locator("#input").fill("Composer draft survives refresh");
      release();
      await page.locator(".agent.selected").waitFor();
      expect(await page.locator("#input").inputValue()).toBe(
        "Composer draft survives refresh",
      );
      expect(await page.locator("#send").isEnabled()).toBeTrue();
    } finally {
      release();
      await page.close();
    }
  },

  async function test_effort_ladder_rejected_switch_reverts(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    await page.route(`${base}api/settings/effort-levels`, (route) =>
      route.fulfill({ json: ladder }),
    );
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.waitForFunction(
      "document.querySelector('#model-trigger .model-name').textContent === 'Test B'",
    );
    await page.locator("#model-trigger").tap();
    await page.waitForFunction(
      "document.querySelector('#model-menu').matches(':popover-open')",
    );
    expect(await page.locator("#effort-range").inputValue()).toBe("3");
    expect(await page.locator("#effort-value").innerText()).toBe("high");
    expect(await page.locator("#effort-model").innerText()).toBe("Test B high");
    const composer = await page.locator("#composer").boundingBox();
    const box = await page.locator("#model-menu").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(366);
    expect(composer).not.toBeNull();
    expect(await page.locator("#model-trigger").innerText()).toContain(
      "Test B",
    );
    await page.route(`${base}api/conversations/*/model`, (route) =>
      route.fulfill({ status: 409 }),
    );
    const preview = await page.evaluate(
      "const range=document.querySelector('#effort-range'); range.value='5'; range.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#effort-value').textContent",
    );
    expect(preview).toBe("max");
    await page.evaluate(
      "document.querySelector('#effort-range').dispatchEvent(new Event('change',{bubbles:true}))",
    );
    await page.waitForFunction(
      "document.querySelector('#effort-range').value === '3'",
    );
    expect(await page.locator("#effort-value").innerText()).toBe("high");
    expect(await page.locator("#model-trigger").innerText()).toContain(
      "Test B",
    );
    expect(await page.locator("#model-menu").isVisible()).toBeTrue();
    expect(await page.locator("#composer").boundingBox()).toEqual(composer);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Feature: #2009 draft effort picker remains visibly accessible
  async function test_effort_picker_and_draft_level(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    await page.route(`${base}api/settings/effort-levels`, (route) =>
      route.fulfill({ json: ladder }),
    );
    await page.route(`${base}api/conversations`, (route) =>
      route.fulfill({ status: 422, body: "test" }),
    );
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    await page.keyboard.press("t");
    await page.locator("#draft-model-host").waitFor();
    await page.waitForFunction(
      "document.querySelector('#effort-model').textContent === 'Test B high'",
    );
    await page.locator("#model-trigger").click();
    expect(await page.locator("#model-menu").isVisible()).toBeTrue();
    expect(await page.locator("#model-trigger").isVisible()).toBeTrue();
    expect(await page.locator("#effort-range").inputValue()).toBe("3");
    expect(await page.locator("#effort-value").innerText()).toBe("high");
    expect(await page.locator("#effort-model").innerText()).toBe("Test B high");
    await page.keyboard.press("Escape");
    await page.locator("#model-trigger").click();
    await page.locator("#effort-range").focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      "document.querySelector('#effort-range').value === '4'",
    );
    expect(await page.locator("#effort-value").innerText()).toBe("xhigh");
    expect(await page.locator("#effort-model").innerText()).toBe("Test A max");
    await page.locator("#input").fill("Use the selected effort level");
    const req = page.waitForRequest(`${base}api/conversations`);
    await page.locator("#send").click();
    const request = await req;
    expect(request.postDataJSON().level).toBe(4);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2009 confirmed Stop stays pending until its response
  async function test_stop_request_id_fallback_dispatches_once(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const posts: any[] = [];
    let heldStop: Route | null = null;
    const diagnostics: any[] = [];
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({ json: tree() }),
    );
    await mockConversation(page, base, "main", () => running());
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
    await waitValue(
      () => posts.length === 1,
      "Stop request without randomUUID",
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
    await waitValue(
      () => diagnostics.some((row) => row.event === "request_id_fallback"),
      "fallback diagnostics",
    );
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const posts: any[] = [];
    let resolved = "run-old";
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({ json: tree() }),
    );
    await page.route(`${base}api/conversations/main**`, (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.pathname !== "/api/conversations/main")
        return route.continue();
      return route.fulfill({
        json: running("running", resolved),
      });
    });
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
    await waitValue(() => posts.length === 1, "stale-run Stop");
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const stops: any[] = [];
    const steers: any[] = [];
    let state = running();
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({ json: tree(state.status) }),
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
    await waitValue(() => steers.length === 1, "working-turn steer");
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
    state = running("running", "run-mobile-2");
    await stop.waitFor({ timeout: 5_000 });
    await stop.click();
    expect(await stop.getAttribute("aria-label")).toBe(
      "Confirm stop this agent",
    );
    await stop.click();
    await waitValue(() => stops.length === 1, "confirmed mobile Stop");
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_errored_active_run_remains_keyboard_stoppable(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const stops: any[] = [];
    await page.route(`${base}api/tree`, (route) =>
      route.fulfill({
        json: [
          { ...tree("error")[0], id: "main" },
          { ...tree("idle")[0], id: "other", title: "Other" },
        ],
      }),
    );
    await mockConversation(page, base, "main", () =>
      running("error", "run-reader-error"),
    );
    await mockConversation(page, base, "other", () => ({
      ...running("idle", null),
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
    await waitValue(() => stops.length === 1, "errored-run keyboard Stop");
    expect(stops[0].run_id).toBe("run-reader-error");
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_tokenless_stop_lookup_race(browser, base) {
    await runTokenlessStopLookupRace(browser, base, true);
  },
  async function test_tokenless_stop_lookup_race_b_wins(browser, base) {
    await runTokenlessStopLookupRace(browser, base, false);
  },
];
if (import.meta.main) await runBrowserTests([["composer", tests]]);
