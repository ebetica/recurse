import { expect } from "bun:test";
import type { Locator, Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  postFixture,
  routeArtifacts,
  runBrowserTests,
  waitForLayout,
  type BrowserTest,
} from "./common";

async function expectVisuallyHidden(status: Locator) {
  await browserExpect(status).toHaveCSS("position", "absolute");
  await browserExpect(status).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
}

const ladder = {
  default_level: 3,
  levels: Object.fromEntries(
    [1, 2, 3, 4, 5].map((level) => [
      String(level),
      {
        model: level < 4 ? "test/model-b" : "test/model-a",
        reasoning: ["low", "medium", "high", "max", "xhigh"][level - 1],
      },
    ]),
  ),
  reachability: Object.fromEntries(
    [1, 2, 3, 4, 5].map((level) => [
      String(level),
      {
        reachable: true,
        model: level < 4 ? "test/model-b" : "test/model-a",
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
      const trigger = page.locator("#model-trigger");
      const name = model || "Unknown model";
      await browserExpect(trigger.locator(".model-name")).toHaveText(name);
      await browserExpect(trigger).toHaveAttribute(
        "aria-label",
        `${name}: choose effort level`,
      );
      await trigger.click();
      const menu = page.locator("#model-menu:popover-open");
      await browserExpect(menu.locator("#effort-model")).toHaveText(name);
      await browserExpect(menu.getByRole("status")).toHaveText(name);
      await browserExpect(menu.getByRole("slider")).toHaveAttribute(
        "aria-valuetext",
        name,
      );
      await page.keyboard.press("Escape");
      await page
        .locator("#input")
        .fill("Keep this message while I choose a model");
      await page.locator("#input").press("Enter");
      await page.locator("#send-status.error").waitFor();
      const detail = `${model ? `Model ${model} is unavailable.` : "No model is selected for this conversation."} Pick an effort level again in the model picker. If needed, update the ladder in Settings first.`;
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
  async function offlineMessagesPersistAndDeliverOnce(browser, base) {
    for (const width of [1280, 412]) {
      const agent = `offline-send-${width}`;
      await postFixture(base, "seed-model-selection-error", {
        agent,
        model: "fauxordinary/faux-1",
      });
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      const deliveries: { content: string; client_message_id: string }[] = [];
      let blocked = false;
      let dropped = false;
      await context.route(`${base}api/**`, async (route) => {
        if (blocked) return route.abort("internetdisconnected");
        if (route.request().url().endsWith(`/conversations/${agent}/deliver`)) {
          deliveries.push(route.request().postDataJSON());
          if (!dropped) {
            dropped = true;
            await route.fetch();
            return route.abort("connectionreset");
          }
        }
        return route.continue();
      });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page
          .locator("#conv-title")
          .filter({ hasText: "Choose a model" })
          .waitFor();
        blocked = true;
        await context.setOffline(true);
        const first = `Reply only Offline first ${width}`;
        const second = `Reply only Offline second ${width}`;
        for (const content of [first, second, "Remove this offline message"]) {
          await page.locator("#input").fill(content);
          await page.locator("#send").click();
          await browserExpect(page.locator("#input")).toHaveValue("");
          await page
            .locator(".msg.user.pending")
            .filter({ hasText: content })
            .waitFor();
        }
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: "Remove this offline message" })
          .getByRole("button", { name: "Remove queued message" })
          .click();
        await browserExpect(page.locator(".msg.user.pending")).toHaveCount(2);
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({
            path: `${shots}/offline-pending-${width}.png`,
          });
        const removable = "Remove this message after reload";
        await page.locator("#input").fill(removable);
        await page.locator("#send").click();
        await browserExpect(page.locator(".msg.user.pending")).toHaveCount(3);
        blocked = true;
        await context.setOffline(false);
        const failedRead = page.waitForEvent("requestfailed", {
          predicate: (request) =>
            new URL(request.url()).pathname === `/api/conversations/${agent}`,
        });
        await page.reload();
        await failedRead;
        await waitForLayout(page);
        await browserExpect(page.locator("#messages")).not.toHaveAttribute(
          "inert",
        );
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: removable })
          .getByRole("button", { name: "Remove queued message" })
          .click();
        await browserExpect(page.locator(".msg.user.pending")).toHaveCount(2);
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: first })
          .waitFor();
        await page
          .locator(".msg.user.pending")
          .filter({ hasText: second })
          .waitFor();
        blocked = false;
        await page.evaluate(() =>
          (globalThis as any).dispatchEvent(new Event("online")),
        );
        for (const content of [first, second]) {
          await page
            .locator("#messages .msg.user:not(.pending)")
            .filter({ hasText: content })
            .waitFor();
        }
        await page
          .getByText(second.replace("Reply only ", ""), { exact: true })
          .waitFor();
        await browserExpect(
          page.locator("#messages .msg.user.pending"),
        ).toHaveCount(0);
        await browserExpect(
          page.locator("#messages .msg.user").filter({ hasText: first }),
        ).toHaveCount(1);
        await browserExpect(
          page.locator("#messages .msg.user").filter({ hasText: second }),
        ).toHaveCount(1);
        expect(deliveries.map((send) => send.content)).toEqual([
          first,
          first,
          second,
        ]);
        expect(deliveries[0]!.client_message_id).toBe(
          deliveries[1]!.client_message_id,
        );
        if (shots)
          await page.screenshot({
            path: `${shots}/offline-delivered-${width}.png`,
          });
      } finally {
        await context.close();
      }
    }
  },

  async function compactComposerTargets(browser, base) {
    for (const width of [412, 1280]) {
      const mobile = width === 412;
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      try {
        const page = await context.newPage();
        await gotoRoot(page, base);
        await page.locator(".agent.selected").waitFor({ state: "attached" });
        await waitForLayout(page);
        const composer = page.locator("#composer");
        const input = page.locator("#input");
        const buttons = [page.locator("#attach"), page.locator("#send")];
        const centerY = ({ y, height }: { y: number; height: number }) =>
          y + height / 2;
        const expectAligned = async (state: string, ...centers: number[]) => {
          centers.push(
            ...(await Promise.all(
              buttons.map(async (button) =>
                centerY((await button.boundingBox())!),
              ),
            )),
          );
          expect(
            Math.max(...centers) - Math.min(...centers),
            `${width}px ${state}: centres ${centers.join(", ")}`,
          ).toBeLessThanOrEqual(1);
        };
        const textGeometry = () =>
          input.evaluate((field) => {
            const box = field.getBoundingClientRect();
            const style =
              field.ownerDocument.defaultView!.getComputedStyle(field);
            const lineHeight = parseFloat(style.lineHeight);
            const top =
              box.top +
              parseFloat(style.borderTopWidth) +
              parseFloat(style.paddingTop);
            const bottom =
              box.bottom -
              parseFloat(style.borderBottomWidth) -
              parseFloat(style.paddingBottom);
            return {
              lineHeight,
              contentHeight: bottom - top,
              firstLine: top + lineHeight / 2,
              lastLine: bottom - lineHeight / 2,
            };
          });
        for (const text of ["", "A typical one-line message"]) {
          await input.fill(text);
          const { firstLine, contentHeight, lineHeight } = await textGeometry();
          expect(Math.abs(contentHeight - lineHeight)).toBeLessThanOrEqual(1);
          const box = (await composer.boundingBox())!;
          await expectAligned(
            text ? "typed" : "placeholder",
            firstLine,
            centerY(box),
          );
        }
        const surrounding = (await composer.boundingBox())!;
        const field = (await input.boundingBox())!;
        expect(surrounding.height - field.height).toBeLessThanOrEqual(10);
        expect(field.x - surrounding.x).toBeLessThanOrEqual(42);
        expect(field.width / surrounding.width).toBeGreaterThan(0.75);
        const singleLine = await textGeometry();
        for (const button of buttons) {
          await browserExpect(button).toBeEnabled();
          if (mobile) {
            expect(
              await button.evaluate((el) => {
                const { x, y, width, height } = el.getBoundingClientRect();
                const insetCorners = [-21.5, 21.5];
                return insetCorners.every((dx) =>
                  insetCorners.every((dy) =>
                    el.contains(
                      el.ownerDocument.elementFromPoint(
                        x + width / 2 + dx,
                        y + height / 2 + dy,
                      ),
                    ),
                  ),
                );
              }),
              `${button} should be hit at all four inset corners`,
            ).toBeTrue();
          }
        }
        const lines = ["First line", "Second line", "Third line", "Last line"];
        await input.fill(lines.join("\n"));
        const { lastLine, contentHeight, lineHeight } = await textGeometry();
        expect(
          Math.abs(
            contentHeight -
              singleLine.contentHeight -
              (lines.length - 1) * lineHeight,
          ),
        ).toBeLessThanOrEqual(1);
        await expectAligned("multiline last line", lastLine);
        expect((await composer.boundingBox())!.height).toBeGreaterThan(
          surrounding.height,
        );
      } finally {
        await context.close();
      }
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
    for (const width of [1280, 412, 390]) {
      const { agent, model, effort } = await postFixture(
        base,
        "seed-recorded-effort-choice",
      );
      const modelUrl = `${base}api/conversations/${agent}/model`;
      const mobile = width !== 1280;
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 915 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const posts: unknown[] = [];
      let rejectChange = true;
      await page.route(modelUrl, (route) => {
        const request = route.request();
        if (request.method() !== "POST") return route.fallback();
        posts.push(request.postDataJSON());
        return rejectChange ? route.fulfill({ status: 409 }) : route.continue();
      });
      const modelResponse = () =>
        page.waitForResponse(
          (r) => r.url() === modelUrl && r.request().method() === "POST",
        );
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor({
          state: "attached",
        });
        const trigger = page.locator("#model-trigger");
        const name = trigger.locator(".model-name");
        const menu = page.locator("#model-menu:popover-open");
        const range = menu.getByRole("slider", {
          name: "Effort level",
          exact: true,
        });
        const label = menu.locator("#effort-model");
        const composer = page.locator("#composer");
        const recordedAction = `Level 3: ${model}: choose effort level`;
        await browserExpect(name).toHaveText(model);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        await waitForLayout(page);
        expect(
          await trigger.evaluate((el, touch) => {
            const { left, right, top, bottom, height } =
              el.getBoundingClientRect();
            const center = top + height / 2;
            const ys = touch
              ? [center - 21, center + 21]
              : [top + 3, bottom - 3];
            const inset = touch ? 6 : 3;
            return [left + inset, right - inset].every((x) =>
              ys.every((y) =>
                el.contains(el.ownerDocument.elementFromPoint(x, y)),
              ),
            );
          }, mobile),
        ).toBeTrue();
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots && width !== 390)
          await page.screenshot({ path: `${shots}/effort-chip-${width}.png` });
        if (mobile) await trigger.tap();
        else await trigger.click();
        await browserExpect(menu).toBeVisible();
        if (mobile) {
          await browserExpect
            .poll(() =>
              menu.evaluate((el) => {
                const box = el.getBoundingClientRect();
                const viewport = el.ownerDocument.documentElement;
                return (
                  box.left >= 12 &&
                  box.right <= viewport.clientWidth - 12 &&
                  box.top >= 0 &&
                  box.bottom <= viewport.clientHeight
                );
              }),
            )
            .toBe(true);
        }
        await browserExpect(label).toHaveText(model);
        const status = menu.getByRole("status");
        await browserExpect
          .poll(() => status.ariaSnapshot())
          .toBe(`- status: ${JSON.stringify(`Level 3: ${model}`)}`);
        await expectVisuallyHidden(status);
        await browserExpect(range).toHaveValue("3");
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${model}`,
        );
        if (mobile) {
          expect(
            await range.evaluate((el) => {
              const { left, right, top, height } = el.getBoundingClientRect();
              return [left + 3, right - 3].every((x) =>
                [-21, 21].every(
                  (dy) =>
                    el.ownerDocument.elementFromPoint(
                      x,
                      top + height / 2 + dy,
                    ) === el,
                ),
              );
            }),
          ).toBeTrue();
        }
        const response = await page.request.get(
          `${base}api/settings/effort-levels`,
        );
        expect(response.ok()).toBeTrue();
        const live = (await response.json()) as typeof ladder;
        const at3 = live.levels["3"]!;
        const at5 = live.levels["5"]!;
        expect(at3.model).not.toBe(model);
        expect(at3.reasoning).not.toBe(effort);
        expect(at5.model).not.toBe(model);
        const labelFor = (selector: string) =>
          live.models.find(({ id }) => id === selector)!.label;
        const choice3 = labelFor(at3.model);
        const choice5 = labelFor(at5.model);
        if (shots && width !== 390)
          await page.screenshot({ path: `${shots}/effort-open-${width}.png` });
        await range.evaluate((el) => {
          (el as HTMLInputElement).value = "5";
        });
        await range.dispatchEvent("input");
        await browserExpect(range).toHaveValue("5");
        await browserExpect(label).toHaveText(choice5);
        await browserExpect(status).toHaveText(`Level 5: ${choice5}`);
        await expectVisuallyHidden(status);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 5: ${choice5}`,
        );
        await browserExpect(name).toHaveText(model);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        if (shots && width !== 390)
          await page.screenshot({ path: `${shots}/effort-moved-${width}.png` });
        await waitForLayout(page);
        await browserExpect(menu).toBeVisible();
        const geometry = await composer.boundingBox();
        expect(geometry).not.toBeNull();
        expect(posts).toEqual([]);
        const [rejected] = await Promise.all([
          modelResponse(),
          range.dispatchEvent("change"),
        ]);
        expect(rejected.status()).toBe(409);
        await browserExpect(range).toHaveValue("3");
        await browserExpect(trigger).not.toHaveClass(/pending/);
        await browserExpect(name).toHaveText(model);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        await browserExpect(menu).toBeVisible();
        await browserExpect(label).toHaveText(model);
        await browserExpect(status).toHaveText(`Level 3: ${model}`);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${model}`,
        );
        await browserExpect
          .poll(() => composer.boundingBox())
          .toEqual(geometry);
        expect(posts).toEqual([{ level: 5 }]);

        rejectChange = false;
        const [accepted] = await Promise.all([
          modelResponse(),
          mobile ? range.tap() : range.click(),
          browserExpect(label).toHaveText(choice3),
        ]);
        expect(accepted.status()).toBe(200);
        expect((await accepted.json()).pending_model).toEqual({
          level: 3,
          model: at3.model,
          effort: at3.reasoning,
        });
        await browserExpect(range).toBeEnabled();
        await browserExpect(trigger).toHaveClass(/pending/);
        await browserExpect(name).toHaveText(choice3);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          `Level 3: ${choice3}: switches on your next message; choose effort level`,
        );
        await browserExpect(label).toHaveText(choice3);
        await browserExpect(status).toHaveText(`Level 3: ${choice3}`);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${choice3}`,
        );
        expect(posts).toEqual([{ level: 5 }, { level: 3 }]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Feature: #2009 draft effort picker remains visibly accessible
  async function test_effort_picker_and_draft_level(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 800 },
    });
    const long =
      "Anthropic: Test B with a name longer than the chip and the page";
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    await page.route(`${base}api/settings/effort-levels`, (route) =>
      route.fulfill({
        json: {
          ...ladder,
          models: [ladder.models[0], { id: "test/model-b", label: long }],
        },
      }),
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
    const trigger = page.locator("#model-trigger");
    const chip = trigger.locator(".model-name");
    const input = page.locator("#input");
    const fits = (field: Locator) =>
      field.evaluate(
        (node) =>
          node.clientHeight > 0 && node.scrollHeight <= node.clientHeight,
      );
    const height = () => input.evaluate((node) => node.clientHeight);
    await browserExpect(chip).toHaveText(long);
    await browserExpect.poll(() => fits(input)).toBe(true);
    const oneLine = await height();
    for (const width of [1100, 750, 412]) {
      await page.setViewportSize({ width, height: 800 });
      await browserExpect
        .poll(() =>
          chip.evaluate((name) => {
            const r = name.getBoundingClientRect();
            return (
              name.scrollWidth <= name.clientWidth &&
              [r.left + 2, r.right - 2].every((x) =>
                [r.top + 2, r.bottom - 2].every((y) =>
                  name.contains(name.ownerDocument.elementFromPoint(x, y)),
                ),
              )
            );
          }),
        )
        .toBe(true);
      await browserExpect.poll(() => fits(input)).toBe(true);
    }
    await input.evaluate((field: any) => {
      field.placeholder =
        "Describe the first task for this agent, then press Enter to send it";
    });
    await browserExpect.poll(() => fits(input)).toBe(true);
    expect(await height()).toBeGreaterThan(oneLine);
    await page.setViewportSize({ width: 1100, height: 800 });
    await browserExpect.poll(height).toBe(oneLine);
    await browserExpect.poll(() => fits(input)).toBe(true);
    expect(
      await page
        .locator(".draft-hello > *")
        .first()
        .evaluate((n) => n.tagName),
    ).toBe("H2");
    await browserExpect(trigger).toHaveAttribute(
      "aria-label",
      `Level 3: ${long}: choose effort level`,
    );
    await trigger.click();
    const menu = page.getByRole("dialog", {
      name: "Effort level",
      exact: true,
    });
    const range = menu.getByRole("slider");
    const label = menu.locator("#effort-model");
    const status = menu.getByRole("status");
    await browserExpect(trigger).toBeVisible();
    await browserExpect(range).toHaveValue("3");
    await browserExpect(label).toHaveText(long);
    await browserExpect(status).toHaveText(`Level 3: ${long}`);
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      `Level 3: ${long}`,
    );
    await page.keyboard.press("Escape");
    await trigger.click();
    await range.press("ArrowRight");
    await browserExpect(range).toHaveValue("4");
    await browserExpect(label).toHaveText("Test A");
    await browserExpect(status).toHaveText("Level 4: Test A");
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      "Level 4: Test A",
    );
    await browserExpect(chip).toHaveText("Test A");
    await browserExpect(trigger).toHaveAttribute(
      "aria-label",
      "Level 4: Test A: choose effort level",
    );
    await menu.focus();
    await page.keyboard.press("j");
    await browserExpect(menu).toBeFocused();
    await browserExpect(label).toHaveText("Test A");
    await browserExpect
      .poll(() => status.ariaSnapshot())
      .toBe('- status: "Level 5: Test A"');
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      "Level 5: Test A",
    );
    await page.keyboard.press("k");
    await browserExpect(status).toHaveText("Level 4: Test A");
    await page.locator("#input").fill("Use the selected effort level");
    const req = page.waitForRequest(`${base}api/conversations`);
    await page.locator("#send").click();
    const request = await req;
    expect(request.postDataJSON().level).toBe(4);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2964 a departed conversation's pending row read cannot replace a draft.
  async function test_draft_survives_departed_conversation_rows(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-clear");
    const page = await browser.newPage();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let requested = () => {};
    const rowRequested = new Promise<void>((resolve) => (requested = resolve));
    await page.route(
      (url) => url.pathname === `/api/conversations/${agent}/events`,
      (route) => route.abort(),
    );
    await page.route(`**/api/conversations/${agent}/view?**`, async (route) => {
      requested();
      await held;
      await route.continue();
    });
    try {
      expect(
        (
          await page.request.post(`${base}api/conversations/${agent}/deliver`, {
            data: { content: "Reply before I start a new draft." },
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
      const metadata = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/conversations/${agent}`,
      );
      await page.goto(`${base}#agent=${agent}`);
      await (await metadata).finished();
      await rowRequested;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const browser = globalThis as any;
            browser.requestAnimationFrame(() =>
              browser.requestAnimationFrame(() => resolve()),
            );
          }),
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("t");
      await page.keyboard.press("t");
      await page.locator("#draft-model-host").waitFor();
      await page.locator("#input").fill("Keep my new draft");
      const rows = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${agent}/view`,
      );
      release();
      expect(await (await rows).text()).toContain("Before Durable clear.");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const browser = globalThis as any;
            browser.requestAnimationFrame(() =>
              browser.requestAnimationFrame(() => resolve()),
            );
          }),
      );
      expect(await page.locator("#draft-model-host").isVisible()).toBeTrue();
      expect(await page.locator("#input").inputValue()).toBe(
        "Keep my new draft",
      );
    } finally {
      release();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.close();
    }
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
    await mockConversation(page, base, "main", () =>
      running("running", resolved),
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
  // Regression: #3217 Keep newer reads on the replacement run.
  async function test_tokenless_stop_lookup_race(browser, base) {
    await runTokenlessStopLookupRace(browser, base, true);
  },
  async function test_tokenless_stop_lookup_race_b_wins(browser, base) {
    await runTokenlessStopLookupRace(browser, base, false);
  },
];
if (import.meta.main) await runBrowserTests([["composer", tests]]);
