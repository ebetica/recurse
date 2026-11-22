import { expect } from "bun:test";
import { EFFORT_LEVELS } from "../../src/effort_levels";
import type { Locator, Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  captureErrors,
  checkedHitPoint,
  checkedTap,
  expectHitCorners,
  focusComposer,
  gotoRoot,
  mockConversation,
  postFixture,
  routeArtifacts,
  runBrowserTests,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { runConv, tree } from "./fixtures";

async function expectVisuallyHidden(status: Locator) {
  await browserExpect(status).toHaveCSS("position", "absolute");
  await browserExpect(status).toHaveCSS("clip", "rect(0px, 0px, 0px, 0px)");
}

const fixtureEntry = (level: number) => ({
  model: level < 4 ? "test/model-b" : "test/model-a",
  reasoning: ["low", "medium", "high", "max", "xhigh", "max"][level - 1],
});
const ladder = {
  default_level: 3,
  levels: Object.fromEntries(
    EFFORT_LEVELS.map((level) => [level, fixtureEntry(level)]),
  ),
  reachability: Object.fromEntries(
    EFFORT_LEVELS.map((level) => [
      level,
      {
        ...fixtureEntry(level),
        reachable: true,
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
const pollStop = (read: () => unknown, message: string) =>
  browserExpect.poll(read, { message, intervals: [20] });

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

// Regression: #2479 one confirm click stops the newer run despite an older lookup. (also #2410 model selection errors stay visible and retain manual retry.)
const modelSelectionError: BrowserTest = async (browser, base) => {
  for (const [index, { model, effort }] of [
    { model: "" },
    { model: "not-a-model", effort: "default" },
    { model: "fauxordinary/removed", effort: null },
  ].entries()) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    try {
      const agent = `model-selection-${index}`;
      const seeded = await context.request.post(
        `${base}__browser-test/seed-model-selection-error`,
        { data: { agent, model, effort } },
      );
      expect(seeded.ok()).toBeTrue();
      const page = await context.newPage();
      if (effort === null)
        await page.route(
          (url) => url.pathname === `/api/conversations/${agent}`,
          async (route) => {
            const response = await route.fetch();
            const detail = await response.json();
            delete detail.effort;
            await route.fulfill({ response, json: detail });
          },
        );
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
      await browserExpect(trigger).toHaveText(name);
      await browserExpect(trigger).toHaveAttribute(
        "aria-label",
        `${name}: choose effort level`,
      );
      await focusComposer(page);
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

  // Regression: #3563 tapping the composer outside shell details keeps native textarea focus.
  async function test_tap_composer_after_shell(browser, base) {
    const { agent } = await postFixture(base, "seed-live-tools", {
      mode: "background-output",
    });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.goto(`${base}#agent=${agent}`);
      const input = page.locator("#input");
      await input.fill("Run the shell tools.");
      await checkedTap(page.locator("#send"));
      const chip = page.locator("#live-bar .shell-chip");
      const surface = page.locator(".shell-surface");
      await checkedTap(chip);
      await surface.waitFor();
      await checkedTap(page.locator("#composer-wrap"), { x: 4, y: 4 });
      await surface.waitFor({ state: "hidden" });
      await browserExpect(chip).toBeFocused();
      await checkedTap(chip);
      await surface.waitFor();
      await checkedTap(input);
      await browserExpect(input).toBeFocused();
      await surface.waitFor({ state: "hidden" });
      await input.evaluate((field) =>
        field.addEventListener(
          "blur",
          () => {
            field.dataset.blurred = "true";
          },
          { once: true },
        ),
      );
      await checkedTap(chip);
      await surface.waitFor();
      await browserExpect(input, "shell chip keeps the caret").toBeFocused();
      await checkedTap(chip);
      await surface.waitFor({ state: "hidden" });
      const { agent: child } = await postFixture(base, "seed-live-tools", {
        parent: agent,
      });
      try {
        const delivered = await page.request.post(
          `${base}api/conversations/${child}/deliver`,
          { data: { content: "Run the background check." } },
        );
        expect(delivered.ok()).toBe(true);
        const agentChip = page.locator("#live-bar .agent-chip");
        await checkedTap(agentChip);
        await page
          .getByRole("dialog", { name: "Active agents for Live tools" })
          .waitFor();
        await browserExpect(input, "agent chip keeps the caret").toBeFocused();
        await checkedTap(agentChip);
        await surface.waitFor({ state: "hidden" });
        await checkedTap(agentChip);
        await surface.waitFor();
        await postFixture(base, "durable-thinking-cleanup", { agent: child });
        await surface.waitFor({ state: "hidden" });
        await browserExpect(input).toBeFocused();
        expect(await input.getAttribute("data-blurred")).toBeNull();
      } finally {
        await postFixture(base, "durable-thinking-cleanup", { agent: child });
      }
      const thread = page.locator("#messages");
      await checkedTap(thread.locator(".activity-group-toggle"));
      await checkedTap(thread.locator(".turn-series-toggle"));
      await checkedTap(thread.locator(".turn-tool-head").first());
      await checkedTap(
        thread
          .getByRole("region", { name: "Output", exact: true })
          .locator("pre"),
      );
      await checkedTap(input);
      await browserExpect(input).toBeFocused();
      await checkedTap(chip);
      await surface.waitFor();
      await page.keyboard.press("Escape");
      await surface.waitFor({ state: "hidden" });
      await browserExpect(input).toBeFocused();
      await checkedTap(chip);
      await surface.waitFor();
      await postFixture(base, "durable-thinking-cleanup", { agent });
      await surface.waitFor({ state: "hidden" });
      await browserExpect(input).toBeFocused();
    } finally {
      await postFixture(base, "durable-thinking-cleanup", { agent });
      await page.close();
    }
  },

  // Regression: #3564 composer controls must not blur a focused phone draft.
  async function test_effort_tap_keeps_phone_caret(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-context", {});
    const page = await browser.newPage({
      viewport: { width: 390, height: 540 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.goto(`${base}#agent=${agent}`);
      const input = page.locator("#input");
      await checkedTap(input);
      await input.fill("Keep this draft and caret.");
      await input.press("Home");
      await input.evaluate((node) =>
        node.addEventListener(
          "blur",
          () => {
            node.dataset.blurred = "true";
          },
          { once: true },
        ),
      );
      const trigger = page.getByRole("button", { name: "Choose effort level" });
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        checkedTap(page.getByRole("button", { name: "Attach file" })),
      ]);
      await chooser.setFiles([]);
      await browserExpect(input, "Attach keeps the caret").toBeFocused();
      await checkedTap(trigger);
      const popup = page.getByRole("dialog", { name: "Effort level" });
      await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
      await browserExpect(popup).toBeVisible();
      await browserExpect(input, "effort pill keeps the caret").toBeFocused();
      const range = popup.getByRole("slider", { name: "Effort level" });
      await browserExpect(range).toBeEnabled();
      const box = (await range.boundingBox())!;
      const before = await range.inputValue();
      const cdp = await page.context().newCDPSession(page);
      const { min, max } = await range.evaluate((el: HTMLInputElement) => ({
        min: el.min,
        max: el.max,
      }));
      const next = before === min ? max : min;
      const start =
        14 +
        ((Number(before) - Number(min)) / (Number(max) - Number(min))) *
          (box.width - 28);
      const end = next === min ? 14 : box.width - 14;
      const modelResponse = () =>
        page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname === `/api/conversations/${agent}/model`,
        );
      const origin = await checkedHitPoint(range, {
        x: start,
        y: box.height / 2,
      });
      const point = (x: number) => [{ x: origin.x + x - start, y: origin.y }];
      const saved = modelResponse();
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [origin],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point((start + end) / 2),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(end),
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      expect((await saved).ok()).toBe(true);
      await browserExpect(range).toHaveValue(next);
      await browserExpect(
        input,
        "effort slider drag keeps the caret",
      ).toBeFocused();
      await browserExpect(range).toBeEnabled();
      const mouseOrigin = await checkedHitPoint(range, {
        x: end,
        y: box.height / 2,
      });
      await page.mouse.move(mouseOrigin.x, mouseOrigin.y);
      await page.mouse.down();
      await page.mouse.move(mouseOrigin.x + start - end, mouseOrigin.y);
      await page.mouse.up();
      await browserExpect(
        input,
        "effort slider mouse drag keeps the caret on a touch device",
      ).toBeFocused();
      expect(
        await input.evaluate((node: HTMLTextAreaElement) => [
          node.selectionStart,
          node.dataset.blurred,
        ]),
      ).toEqual([0, undefined]);
    } finally {
      await page.close();
    }
  },

  // Regression: #3565 the desktop context meter is reachable before the composer receives focus.
  async function test_compact_composer_targets(browser, base) {
    const { agent, tokens } = await postFixture(base, "seed-durable-context");
    for (const width of [390, 412, 1280]) {
      const mobile = width < 700;
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      try {
        const page = await context.newPage();
        await page.goto(`${base}#agent=${agent}`);
        await page
          .locator(`#conv-title`)
          .filter({ hasText: "Recorded Durable context" })
          .waitFor();
        await page
          .locator("#context-indicator.on")
          .waitFor({ state: "attached" });
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
            };
          });
        const expectLines = async (count: number) => {
          const { contentHeight, lineHeight } = await textGeometry();
          expect(
            Math.abs(contentHeight - count * lineHeight),
          ).toBeLessThanOrEqual(1);
        };
        await expectLines(1);
        const surrounding = (await composer.boundingBox())!;
        const expectBottomRow = async () => {
          const field = (await input.boundingBox())!;
          const [attach, send] = await Promise.all(
            buttons.map((button) => button.boundingBox()),
          );
          expect(attach!.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
          expect(send!.y).toBeGreaterThanOrEqual(field.y + field.height - 1);
          expect(attach!.x).toBeCloseTo(field.x, 0);
          expect(send!.x + send!.width).toBeCloseTo(field.x + field.width, 0);
          await expectAligned("bottom row");
          if (mobile) {
            for (const button of buttons) await expectHitCorners(button);
            expect(
              await input.evaluate((el) => {
                const { left, right, top, bottom } = el.getBoundingClientRect();
                return [left + 2, right - 2].every((x) =>
                  [top + 2, bottom - 2].every(
                    (y) => document.elementFromPoint(x, y) === el,
                  ),
                );
              }),
            ).toBe(true);
          }
        };
        if (mobile) {
          await expectAligned(
            "collapsed placeholder",
            (await textGeometry()).firstLine,
            centerY(surrounding),
          );
          for (const button of buttons) await expectHitCorners(button);
          await input.tap();
        } else {
          await visibleAndUncovered(page, "#context-indicator");
          await expectBottomRow();
          await input.click();
          expect(await composer.boundingBox()).toEqual(surrounding);
        }
        await expectBottomRow();
        await input.fill("One-line draft");
        await input.blur();
        await browserExpect(input).not.toBeFocused();
        await expectBottomRow();
        await expectLines(1);
        const lines = ["First line", "Second line", "Third line", "Last line"];
        const draft = lines.join("\n");
        await input.fill(draft);
        await input.blur();
        await expectBottomRow();
        if (mobile) {
          for (const edge of ["left", "right"] as const) {
            await input.blur();
            const point = await input.evaluate((el, edge) => {
              const rect = el.getBoundingClientRect();
              return {
                x: rect[edge] + (edge === "left" ? 2 : -2),
                y: rect.bottom - 2,
              };
            }, edge);
            await page.touchscreen.tap(point.x, point.y);
            await browserExpect(input).toBeFocused();
            await browserExpect(input).toHaveValue(draft);
          }
        }
        await expectLines(lines.length);
        await browserExpect(buttons[1]!).toBeEnabled();
        const response = await page.request.get(
          `${base}api/conversations/${agent}/context-usage`,
        );
        expect(response.ok()).toBe(true);
        const { context_window: max } = await response.json();
        expect(max).toBeGreaterThan(tokens);
        const usage = `Context usage: ${tokens.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} tokens used`;
        const meter = composer.getByRole("meter", { name: usage, exact: true });
        await browserExpect(meter).toBeVisible();
        await browserExpect(meter).toHaveAttribute("aria-valuemin", "0");
        await browserExpect(meter).toHaveAttribute(
          "aria-valuemax",
          String(max),
        );
        await browserExpect(meter).toHaveAttribute(
          "aria-valuenow",
          String(tokens),
        );
        const fraction = await meter.evaluate(
          (el) =>
            parseFloat(
              el.ownerDocument.defaultView!.getComputedStyle(el, "::before")
                .width,
            ) / el.getBoundingClientRect().width,
        );
        expect(fraction).toBeCloseTo(tokens / max, 3);
        await browserExpect(
          composer.locator("#context-indicator"),
        ).toHaveAttribute("title", `${usage}. Open context details (Shift+C).`);
        await browserExpect(composer.locator("#context-control")).toHaveText(
          "",
        );
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({
            path: `${shots}/composer-context-meter-${width}.png`,
          });
        await expectAligned(
          "full bottom row",
          centerY((await meter.boundingBox())!),
          centerY((await composer.locator("#model-trigger").boundingBox())!),
        );
        for (const id of ["#attach", "#send"]) {
          const control = page.locator(id);
          const box = (await control.boundingBox())!;
          for (const x of [4, box.width - 4])
            for (const y of [4, box.height - 4])
              await checkedHitPoint(control, { x, y });
          if (width < 700) await expectHitCorners(control);
        }
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

  async function test_phone_effort_chip_names_the_model_variant(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-context");
    for (const width of [320, 360, 390, 412]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await page.locator("#input").tap();
        const trigger = page.locator("#model-trigger");
        const name = trigger.locator(".model-name");
        await browserExpect(trigger).toHaveText("Opus 5.5 Medium");
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          /^Level \d: Claude Opus 5\.5 · Medium: /,
        );
        await visibleAndUncovered(page, "#context-indicator");
        await visibleAndUncovered(page, "#model-trigger .model-name");
        await expectHitCorners(trigger);
        await expectHitCorners(page.locator("#context-indicator"));
        await browserExpect(
          page.getByRole("switch", { name: /^Safety review/ }),
        ).toBeHidden();
        const { scrollWidth, clientWidth } = await name.evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      } finally {
        await page.close();
      }
    }
  },

  // Regression: #3565 desktop composer controls stay visible across focus and effort keyboard shortcuts.
  async function test_effort_ladder_rejected_switch_reverts(browser, base) {
    for (const width of [1280, 412, 390]) {
      const { agent, model, effort } = await postFixture(
        base,
        "seed-recorded-effort-choice",
      );
      const shown = model.replace(/^Claude /, "");
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
        const recordedLabel = `${model} · Low`;
        const recordedAction = `Level 3: ${recordedLabel}: choose effort level`;
        await browserExpect(name).toHaveText(shown);
        await browserExpect(trigger.locator("svg")).toHaveCount(0);
        await browserExpect(trigger).toHaveText(`${shown} Low`);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        await waitForLayout(page);
        const row = page.locator("#conv-controls");
        const input = page.locator("#input");
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        const initialCard = await composer.boundingBox();
        const checkRow = async () => {
          await visibleAndUncovered(page, "#model-trigger");
          expect((await row.boundingBox())!.y).toBeGreaterThanOrEqual(
            await input.evaluate((el) => el.getBoundingClientRect().bottom),
          );
          if (!mobile)
            expect(await composer.boundingBox()).toEqual(initialCard);
        };
        if (mobile) await browserExpect(row).toBeHidden();
        else await checkRow();
        if (shots)
          await page.screenshot({
            path: `${shots}/composer-unfocused-${width}.png`,
          });
        if (mobile) await input.tap();
        else await input.click();
        await browserExpect(input).toBeFocused();
        await checkRow();
        if (shots)
          await page.screenshot({
            path: `${shots}/composer-focused-${width}.png`,
          });
        if (mobile) {
          await input.fill("Keep this draft when the picker closes.");
          await checkedTap(trigger);
          await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
          await browserExpect(menu).toBeVisible();
          await browserExpect(input).toBeFocused();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setTouchEmulationEnabled", {
            enabled: false,
          });
          await page.waitForFunction(
            () => !window.matchMedia("(pointer: coarse)").matches,
          );
          await input.evaluate((field) =>
            field.addEventListener(
              "blur",
              () => {
                field.dataset.blurred = "true";
              },
              { once: true },
            ),
          );
          await page.keyboard.press("Escape");
          await browserExpect(
            input,
            "Escape dismisses effort without blurring the draft",
          ).toBeFocused();
          await browserExpect(menu).toBeHidden();
          expect(await input.getAttribute("data-blurred")).toBeNull();
          await browserExpect(input).toHaveValue(
            "Keep this draft when the picker closes.",
          );
          await cdp.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 1,
          });
          await page.waitForFunction(
            () => window.matchMedia("(pointer: coarse)").matches,
          );
          await input.fill("");
        } else {
          await input.blur();
          await checkRow();
          await page.locator(".prompt-banner-row").focus();
          await page.keyboard.press("Tab");
          await browserExpect(page.locator("#scroll-btn")).toBeFocused();
          await checkRow();
          await page.keyboard.press("Tab");
          await browserExpect(input).toBeFocused();
          await checkRow();
          await page.keyboard.press("Tab");
          await browserExpect(page.locator("#attach")).toBeFocused();
          await page.keyboard.press("Tab");
          await browserExpect(trigger).toBeFocused();
          await page.keyboard.press("Enter");
          await browserExpect(menu).toBeFocused();
          await page.keyboard.press("Tab");
          await browserExpect(range).toBeFocused();
          await page.keyboard.press("Tab");
          await browserExpect(
            menu.getByRole("switch", { name: /^Safety review/ }),
          ).toBeFocused();
          await page.keyboard.press("Escape");
          await browserExpect(trigger).toBeFocused();
          await trigger.blur();
          await checkRow();
          for (const shortcut of ["e", "Shift+M"]) {
            await page.keyboard.press(shortcut);
            await browserExpect(trigger).toHaveAttribute(
              "aria-expanded",
              "true",
            );
            await visibleAndUncovered(page, "#effort-range");
            await checkRow();
            await page.keyboard.press("Escape");
            await browserExpect(trigger).toBeFocused();
            await trigger.blur();
            await checkRow();
          }
          await focusComposer(page);
        }
        const chipLayout = await trigger.evaluate((el, touch) => {
          const { left, right, top, bottom, height } =
            el.getBoundingClientRect();
          const x = (left + right) / 2;
          const y = top + height / 2;
          const hit = (x: number, y: number) =>
            el.contains(el.ownerDocument.elementFromPoint(x, y));
          const textRects = (selector: string) => {
            const text = el.ownerDocument.createRange();
            text.selectNodeContents(el.querySelector(selector)!);
            return [...text.getClientRects()].filter((rect) => rect.width > 0);
          };
          const [model] = textRects(".model-name");
          const suffix = textRects(".effort-reasoning-text");
          return {
            endCorners: [left + 16, right - 16].flatMap((x) =>
              (touch ? [y - 21, y + 21] : [top + 3, bottom - 3]).map((y) =>
                hit(x, y),
              ),
            ),
            minimumCorners:
              !touch ||
              [x - 21, x + 21].every((x) =>
                [y - 21, y + 21].every((y) => hit(x, y)),
              ),
            centeredText:
              Math.abs(model!.left - left - (right - suffix[0]!.right)) < 1,
            reasoningOnModelLine:
              suffix.length === 1 &&
              suffix.every(
                (rect) =>
                  model &&
                  rect.top < model.bottom &&
                  rect.bottom > model.top &&
                  rect.left >= left &&
                  rect.right <= right &&
                  rect.top >= top &&
                  rect.bottom <= bottom &&
                  [rect.left + 1, rect.right - 1].every((x) =>
                    hit(x, rect.top + rect.height / 2),
                  ),
              ),
          };
        }, mobile);
        expect(chipLayout).toEqual({
          endCorners: [true, true, true, true],
          minimumCorners: true,
          centeredText: true,
          reasoningOnModelLine: true,
        });
        if (mobile) await trigger.tap();
        else await trigger.click();
        await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
        await visibleAndUncovered(page, "#effort-range");
        await visibleAndUncovered(page, "#send");
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
        const dots = menu.locator(".effort-stops > span");
        await browserExpect(dots).toHaveCount(EFFORT_LEVELS.length);
        const points = await dots.evaluateAll((dots) =>
          dots.map((dot) => {
            const box = dot.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            return {
              x,
              y,
              left: box.left,
              right: box.right,
              nonempty: box.width > 0 && box.height > 0,
              control: dot.ownerDocument.elementFromPoint(x, y)?.id,
            };
          }),
        );
        expect(
          points.every(
            (dot, i) =>
              dot.nonempty && (i === 0 || points[i - 1]!.right < dot.left),
          ),
        ).toBeTrue();
        expect(points.map(({ control }) => control)).toEqual(
          EFFORT_LEVELS.map(() => "effort-range"),
        );
        expect(points[0]!.y).toBeGreaterThan(
          await label.evaluate((el) => el.getBoundingClientRect().bottom),
        );
        await browserExpect(label).toHaveText(`${model} Low`);
        await visibleAndUncovered(page, "#effort-model");
        const status = menu.getByRole("status");
        await browserExpect
          .poll(() => status.ariaSnapshot())
          .toBe(`- status: ${JSON.stringify(`Level 3: ${recordedLabel}`)}`);
        await expectVisuallyHidden(status);
        await browserExpect(range).toHaveValue("3");
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${recordedLabel}`,
        );
        if (mobile) {
          await expectHitCorners(range, 44, {
            horizontalInset: 3,
            exact: true,
            scroll: false,
          });
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
        const pendingLabel = `${choice3} · Medium`;
        const previewLabel = `${choice5} · Xhigh`;
        if (shots)
          await page.screenshot({ path: `${shots}/effort-open-${width}.png` });
        await range.evaluate((el) => {
          (el as HTMLInputElement).value = "5";
        });
        await range.dispatchEvent("input");
        await browserExpect(range).toHaveValue("5");
        await browserExpect(label).toHaveText(`${choice5} Xhigh`);
        await browserExpect(status).toHaveText(`Level 5: ${previewLabel}`);
        await expectVisuallyHidden(status);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 5: ${previewLabel}`,
        );
        await browserExpect(trigger).toHaveText(`${shown} Low`);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
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
        await browserExpect(trigger).toHaveText(`${shown} Low`);
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          recordedAction,
        );
        await browserExpect(menu).toBeVisible();
        await browserExpect(label).toHaveText(`${model} Low`);
        await browserExpect(status).toHaveText(`Level 3: ${recordedLabel}`);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${recordedLabel}`,
        );
        await browserExpect
          .poll(() => composer.boundingBox())
          .toEqual(geometry);
        expect(posts).toEqual([{ level: 5 }]);

        rejectChange = false;
        const { x, y } = points[2]!;
        const [accepted] = await Promise.all([
          modelResponse(),
          mobile ? page.touchscreen.tap(x, y) : page.mouse.click(x, y),
          browserExpect(label).toHaveText(`${choice3} Medium`),
        ]);
        expect(accepted.status()).toBe(200);
        expect((await accepted.json()).pending_model).toEqual({
          level: 3,
          model: at3.model,
          effort: at3.reasoning,
        });
        await browserExpect(range).toBeEnabled();
        await browserExpect(trigger).toHaveClass(/pending/);
        await browserExpect(trigger).toHaveText(
          `${choice3.replace(/^Claude /, "")} Medium`,
        );
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          `Level 3: ${pendingLabel}: switches on your next message; choose effort level`,
        );
        await browserExpect(label).toHaveText(`${choice3} Medium`);
        if (shots)
          await page.screenshot({
            path: `${shots}/effort-pending-${width}.png`,
          });
        await browserExpect(status).toHaveText(`Level 3: ${pendingLabel}`);
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 3: ${pendingLabel}`,
        );
        expect(posts).toEqual([{ level: 5 }, { level: 3 }]);
        if (width === 390) {
          const ladderUrl = `${base}api/settings/effort-levels`;
          const saveLevels = async (levels: typeof live.levels) => {
            const update = await page.request.post(ladderUrl, {
              data: { levels, default_level: live.default_level },
            });
            expect(update.ok()).toBeTrue();
          };
          await page.keyboard.press("Escape");
          try {
            await saveLevels({
              ...live.levels,
              "3": { ...at3, reasoning: "high" },
            });
            await page.reload();
            await focusComposer(page);
            await trigger.tap();
            await range.dispatchEvent("input");
            await browserExpect(label).toHaveText(`${choice3} High`);
            await page.keyboard.press("Escape");
            await trigger.tap();
            await browserExpect(trigger).toHaveText(
              `${choice3.replace(/^Claude /, "")} Medium`,
            );
            await browserExpect(label).toHaveText(`${choice3} Medium`);
            await browserExpect(range).toHaveAttribute(
              "aria-valuetext",
              `Level 3: ${pendingLabel}`,
            );
          } finally {
            await saveLevels(live.levels);
          }
          const fifth = (await dots.nth(4).boundingBox())!;
          const [switched] = await Promise.all([
            modelResponse(),
            page.touchscreen.tap(
              fifth.x + fifth.width / 2,
              fifth.y + fifth.height / 2,
            ),
          ]);
          expect(switched.ok()).toBeTrue();
          await browserExpect(range).toHaveValue("5");
          await browserExpect(label).toHaveText(`${choice5} Xhigh`);
          expect(posts).toEqual([{ level: 5 }, { level: 3 }, { level: 5 }]);

          await page.keyboard.press("Escape");
          await page.setViewportSize({ width, height: 300 });
          await input.fill("Draft line\n".repeat(14));
          await trigger.tap();
          await browserExpect(trigger).toHaveAttribute("aria-expanded", "true");
          await visibleAndUncovered(page, "#effort-model");
          await visibleAndUncovered(page, "#effort-range");
        }
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
    const shown = "Test B with a name longer than the chip and the page";
    const long = `Anthropic: ${shown}`;
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    await page.route(`${base}api/settings/effort-levels`, (route) =>
      route.fulfill({
        json: {
          ...ladder,
          levels: {
            ...ladder.levels,
            5: { model: "test/model-c", reasoning: "max" },
            6: { model: "test/model-d", reasoning: "max" },
          },
          reachability: {
            ...ladder.reachability,
            5: {
              model: "test/model-c",
              reasoning: "max",
              reachable: true,
              reason: "",
            },
            6: {
              model: "test/model-d",
              reasoning: "max",
              reachable: true,
              reason: "",
            },
          },
          models: [
            { id: "test/model-d", label: "Gemini 3.5 Flash" },
            { id: "test/model-a", label: "GPT-6 Sol" },
            { id: "test/model-b", label: long },
            { id: "test/model-c", label: "GPT-6.2 Sol" },
          ],
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
    await browserExpect(chip).toHaveText(shown);
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
    await browserExpect(label).toHaveText("GPT-6 Sol");
    await browserExpect(status).toHaveText("Level 4: GPT-6 Sol");
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      "Level 4: GPT-6 Sol",
    );
    await browserExpect(chip).toHaveText("6 Sol");
    await browserExpect(trigger).toHaveAttribute(
      "aria-label",
      "Level 4: GPT-6 Sol: choose effort level",
    );
    await range.press("ArrowRight");
    await browserExpect(chip).toHaveText("6.2 Sol");
    await browserExpect(trigger).toHaveAttribute(
      "aria-label",
      "Level 5: GPT-6.2 Sol: choose effort level",
    );
    await range.press("ArrowRight");
    await browserExpect(chip).toHaveText("Gemini 3.5 Flash");
    await range.press("ArrowLeft");
    await range.press("ArrowLeft");
    await browserExpect(chip).toHaveText("6 Sol");
    await menu.focus();
    await page.keyboard.press("j");
    await browserExpect(menu).toBeFocused();
    await browserExpect(label).toHaveText("GPT-6.2 Sol");
    await browserExpect
      .poll(() => status.ariaSnapshot())
      .toBe('- status: "Level 5: GPT-6.2 Sol"');
    await expectVisuallyHidden(status);
    await browserExpect(range).toHaveAttribute(
      "aria-valuetext",
      "Level 5: GPT-6.2 Sol",
    );
    await page.keyboard.press("k");
    await browserExpect(status).toHaveText("Level 4: GPT-6 Sol");
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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
if (import.meta.main) await runBrowserTests([["composer", tests]]);
