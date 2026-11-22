import { expect } from "bun:test";
import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
declare const window: any;
declare const MutationObserver: any;
import {
  captureErrors,
  expectHitCorners,
  focusComposer,
  postFixture,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { renderThemeCss, themeDefaults, themePalettes } from "../../src/themes";
import type { TreeUpdate } from "../../src/web/tree_protocol";

const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
const sleeping = () =>
  Bun.spawnSync(["pgrep", "-x", "-f", "sleep 31[.]25"]).stdout.toString();

async function startSleepingTurn(page: Page, base: string, agent: string) {
  await page.goto(`${base}#agent=${agent}`);
  await page.locator("#input").fill("Sleep a while.");
  await page.locator("#send").click();
  await page.locator(".working.live-panel").waitFor();
  await browserExpect.poll(sleeping).not.toBe("");
}

export const tests: BrowserTest[] = [
  // Feature: #3331 Imported Pi history keeps recorded times and inline tool details.
  async function test_imported_pi_history(browser, base) {
    const { agent } = await postFixture(base, "import-recorded-pi");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = captureErrors(page);
    try {
      await page.goto(`${base}#agent=${agent}`);
      const reply =
        'The bash command printed "one", "two", and "three" (with a 2-second pause before "three"), and notes.txt contains the two lines "alpha" and "beta".';
      await page.getByText(reply, { exact: true }).waitFor();
      const view = await page.request.get(
        `${base}api/conversations/${agent}/view?limit=100`,
      );
      expect(view.status()).toBe(200);
      const { blocks } = await view.json();
      expect(
        blocks
          .filter((row: any) => row.role === "assistant" && row.kind === "text")
          .map((row: any) => row.model_time_ms),
      ).toEqual([8068, 8068]);
      const calls = blocks.filter((row: any) => row.kind === "tool_call");
      expect(
        calls.map((row: any) => ({
          name: row.name,
          args: row.args,
          result: row.result,
          artifact: row.artifact_id,
        })),
      ).toEqual([
        {
          name: "bash",
          args: "printf 'one\\ntwo\\n'; sleep 2; echo three",
          result: "one\ntwo\nthree\n",
          artifact: undefined,
        },
        {
          name: "read",
          args: '{"path":"notes.txt"}',
          result: "alpha\nbeta\n",
          artifact: undefined,
        },
      ]);
      await page
        .getByRole("button", { name: "Expand all", exact: true })
        .click();
      await page.getByText("Thought for 8s", { exact: false }).waitFor();
      for (const [input, output] of [
        ["notes.txt", "alpha\nbeta\n"],
        ["printf 'one\\ntwo\\n'; sleep 2; echo three", "one\ntwo\nthree\n"],
      ]) {
        const tool = page.locator(".turn-tool", { hasText: input });
        expect(await tool.locator(".turn-tool-detail").innerText()).toBe(input);
        await tool.locator(".turn-tool-head").click();
        const detail = tool.locator('.tool-payload[aria-label="Output"] pre');
        await detail.waitFor();
        expect(await detail.innerText()).toBe(output);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
  // Regression: #2317 #2515 #3565 show distinct Durable context categories after #2281/#2299; Shift+C preserves desktop layout; #3615 keeps the last text line close to the controls.
  async function test_recorded_durable_context_split(browser, base) {
    const { agent, tokens } = await postFixture(base, "seed-durable-context");
    expect(tokens).toBeGreaterThan(0);
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.goto(`${base}#agent=${agent}`);
      await page
        .locator("#conv-title")
        .filter({ hasText: "Recorded Durable context" })
        .waitFor();
      const expectCompactGap = async (page: Page) => {
        const gaps = await page.locator("#input").evaluate((field) => {
          const { paddingTop, lineHeight } = getComputedStyle(field);
          const lineBottom =
            field.getBoundingClientRect().top +
            parseFloat(paddingTop) +
            parseFloat(lineHeight);
          return ["#send", "#model-trigger"].map(
            (selector) =>
              field.ownerDocument
                .querySelector(selector)!
                .getBoundingClientRect().top - lineBottom,
          );
        });
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
        expect(
          Math.max(...gaps),
          `${page.viewportSize()!.width}px: placeholder to Send and effort pill`,
        ).toBeLessThanOrEqual(14);
      };
      await focusComposer(page);
      await page.locator("#context-indicator.on").waitFor();
      await waitForLayout(page);
      await expectCompactGap(page);
      const touch = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
      });
      try {
        await touch.goto(`${base}#agent=${agent}`);
        await touch.locator("#context-indicator.on").waitFor();
        await waitForLayout(touch);
        expect(
          await touch.evaluate(() => matchMedia("(pointer: coarse)").matches),
        ).toBe(true);
        await expectCompactGap(touch);
        for (const touchPage of [page, touch]) {
          for (const selector of [
            "#attach",
            "#send",
            "#context-indicator",
            "#model-trigger",
          ])
            await expectHitCorners(touchPage.locator(selector), 44, {
              centerOnHitArea: touchPage === touch,
            });
        }
        const field = touch.locator("#input");
        const draft = "Keep this draft.";
        await field.fill(draft);
        for (const edge of ["left", "right"] as const) {
          await field.blur();
          const point = await field.evaluate((el, edge) => {
            const rect = el.getBoundingClientRect();
            return {
              x: rect[edge] + (edge === "left" ? 2 : -2),
              y: rect.bottom - 2,
            };
          }, edge);
          await touch.touchscreen.tap(point.x, point.y);
          await browserExpect(field).toBeFocused();
          await browserExpect(field).toHaveValue(draft);
        }
      } finally {
        await touch.close();
      }
      await page.locator("#context-indicator").click();
      const desktop = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      try {
        await desktop.goto(`${base}#agent=${agent}`);
        await desktop
          .locator("#context-indicator.on")
          .waitFor({ state: "attached" });
        await waitForLayout(desktop);
        await expectCompactGap(desktop);
        await visibleAndUncovered(desktop, "#context-indicator");
        const composer = desktop.locator("#composer");
        const card = await composer.boundingBox();
        await desktop.keyboard.press("Shift+C");
        await visibleAndUncovered(desktop, "#context-close");
        expect(
          await desktop
            .locator("#context-close")
            .evaluate(
              (button) => button.ownerDocument.activeElement === button,
            ),
        ).toBeTrue();
        await browserExpect(desktop.locator("#conv-controls")).toBeVisible();
        expect(await composer.boundingBox()).toEqual(card);
        await desktop.keyboard.press("Escape");
        await visibleAndUncovered(desktop, "#context-indicator");
        expect(await composer.boundingBox()).toEqual(card);
      } finally {
        await desktop.close();
      }
      const body = page.locator("#context-body");
      await body
        .getByText("The total is provider-reported.", { exact: false })
        .waitFor();
      if (shots)
        await page.screenshot({ path: `${shots}/durable-context-split.png` });
      expect(await body.innerText()).not.toContain("split is unavailable");
      expect(await body.innerText()).toContain("split is estimated");
      expect(await body.locator(".turn-usage-totals").innerText()).toContain(
        tokens.toLocaleString("en-US"),
      );
      expect(
        await body.locator(".turn-usage-legend > span").allTextContents(),
      ).toEqual([
        "System",
        "User prompts",
        "Messages",
        "Tool calls",
        "Tool outputs",
      ]);
      for (const name of ["Material Dark", "Solarized Light"]) {
        await page.addStyleTag({
          content: renderThemeCss(themePalettes.find((p) => p.name === name)!),
        });
        const colors = await body
          .locator(".turn-usage-dot")
          .evaluateAll((dots) =>
            dots.map(
              (dot) => window.getComputedStyle(dot).backgroundColor as string,
            ),
          );
        expect(new Set(colors).size).toBe(5);
        const rgb = colors.map((color) => color.match(/\d+/g)!.map(Number));
        for (let i = 0; i < rgb.length; i++)
          for (let j = i + 1; j < rgb.length; j++)
            expect(
              Math.hypot(...rgb[i]!.map((v, k) => v - rgb[j]![k]!)),
            ).toBeGreaterThan(80);
        if (shots)
          for (const width of [412, 1280]) {
            await page.setViewportSize({ width, height: 915 });
            await page.screenshot({
              path: `${shots}/context-${name.replaceAll(" ", "-")}-${width}.png`,
            });
          }
      }
      expect(
        await body.locator(".turn-usage-bar").getAttribute("aria-label"),
      ).toContain("estimated split");
    } finally {
      await page.close();
    }
  },

  // Regression: #2333 live timer updates must not prevent pending platform notes painting. (also #2514 collapsed agent headers never preview the delivered message.)
  async function test_agent_steer_keeps_running_panel_and_waiting_disclosure(
    browser,
    base,
  ) {
    const { agent, sender } = await postFixture(
      base,
      "seed-durable-queued-agent",
    );
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = captureErrors(page);
    try {
      await page.goto(`${base}#agent=${agent}`);
      await page.request.post(`${base}api/conversations/${agent}/deliver`, {
        data: { content: "Run the command." },
      });
      await page.locator(".working.live-panel").waitFor();
      let runningTool = false;
      for (let i = 0; !runningTool && i < 100; i++) {
        const view = await (
          await page.request.get(`${base}api/conversations/${agent}/view`)
        ).json();
        runningTool = view.blocks.some((row: any) => row.running);
        if (!runningTool) await Bun.sleep(50);
      }
      expect(runningTool).toBeTrue();
      const delivered = await page.request.post(
        `${base}api/conversations/${agent}/deliver`,
        {
          headers: { "x-recurse-agent": sender },
          data: {
            content:
              "(turn started by your message)\nCHILD_REPORT: the requested checks passed.",
          },
        },
      );
      expect(delivered.ok()).toBeTrue();
      const waiting = page.locator(".pending.agent .agent-message-row");
      await waiting.waitFor();
      expect(await waiting.getAttribute("aria-expanded")).toBe("false");
      expect(await waiting.innerText()).toContain("Waiting…");
      expect(await waiting.innerText()).not.toContain("CHILD_REPORT");
      expect(await waiting.locator(".agent-message-preview").count()).toBe(0);
      expect(await waiting.innerText()).not.toContain("turn started");
      expect(await page.locator(".msg.user.pending").count()).toBe(0);
      expect(await page.locator(".live-panel-box.is-queued").count()).toBe(0);
      expect(await page.locator(".working.live-panel").count()).toBe(1);
      await waiting.tap();
      await page
        .locator(".pending.agent .agent-message-content", {
          hasText: "CHILD_REPORT",
        })
        .waitFor();
      expect(await page.locator(".pending.agent").innerText()).not.toContain(
        "turn started",
      );
      await postFixture(base, "durable-platform-note");
      const platform = page.locator(".pending.agent .platform-interruption");
      await platform.waitFor();
      expect(await platform.innerText()).toContain("Platform message");
      expect(
        await platform
          .locator(".agent-message-row")
          .getAttribute("aria-expanded"),
      ).toBe("false");
      expect(await platform.locator(".agent-message-body").count()).toBe(0);
      expect(await page.locator(".msg.user.pending").count()).toBe(0);
      await page.getByText("PARENT_COMPLETE", { exact: true }).waitFor();
      await page
        .locator(".pending.agent")
        .first()
        .waitFor({ state: "detached" });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },

  // Regression: #2275 Durable inspector resolves stored entry, not 404
  async function test_parent_input_inspector_reads_durable_entry(
    browser,
    base,
  ) {
    const { agent, delivered, stored } = await postFixture(
      base,
      "seed-durable-inspector",
    );
    for (const mobile of [true, false]) {
      const page = await browser.newPage({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const errors = captureErrors(page);
      try {
        await page.goto(`${base}#agent=${agent}`);
        const message = page
          .locator(".agent-message")
          .filter({ hasText: "INSPECT_PARENT_INPUT" });
        const response = page.waitForResponse((r) =>
          r.url().includes(`/api/conversations/${agent}/turn-prompt?`),
        );
        await message.locator(".agent-message-inspect").click();
        expect((await response).status()).toBe(200);
        await page.getByText("User input as stored", { exact: true }).waitFor();
        expect(await page.locator("#prompt-body pre").innerText()).toBe(stored);
        expect(stored).not.toBe(delivered);
        expect(await page.locator("#prompt-body").innerText()).not.toContain(
          "Couldn't load",
        );
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  },

  // Regression: #2205 #3569 events clear Stop, the live panel and the running border while reads are held.
  async function test_durable_stop_clears_from_the_events_frame(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-stop");
    const page = await browser.newPage();
    const runningCard = page.locator("#composer-card[data-turn-running]");
    await startSleepingTurn(page, base, agent);
    await browserExpect(runningCard).toHaveCount(1);
    let holding = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    page.on("request", (r) => void (holding ||= r.url().endsWith("/deliver")));
    const reads = RegExp(`/api/conversations/${agent}[?]`);
    await page.route(reads, async (route) => {
      if (holding) await held;
      await route.fallback();
    });
    let releaseStop = () => {};
    const stopHeld = new Promise<void>((resolve) => (releaseStop = resolve));
    await page.route(
      `${base}api/conversations/${agent}/deliver`,
      async (route) => {
        await stopHeld;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await page.locator("#send.stop").click();
      await page.locator("#send.stop.armed").click();
      await browserExpect(
        page.locator("#live-bar .working.stopping"),
      ).toContainText("Interrupting this turn…");
      await browserExpect(runningCard).toHaveCount(0);
      releaseStop();
      for (const shown of [
        "#conv-status.running",
        "#send.stop",
        `#agent-list .agent[data-id="${agent}"] .working, #conv-titlebar .working, #composer-wrap .working`,
      ])
        await page.waitForFunction(
          (selector) => !document.querySelector(selector),
          shown,
          { timeout: 8_000 },
        );
      await browserExpect(runningCard).toHaveCount(0);
      expect(sleeping()).toBe("");
    } finally {
      releaseStop();
      release();
      await page.close();
    }
  },

  // Regression: #2430 quick Stop must not leave the admitted send looking queued after chrome is idle.
  async function test_quick_stop_clears_thread_with_reads_free(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-stop", {
      agent: "durable-stop-quick",
    });
    const page = await browser.newPage();
    try {
      await startSleepingTurn(page, base, agent);
      await page.locator("#send.stop").click();
      await page.locator("#send.stop.armed").click();
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        `#conv-status.running, #send.stop, #agent-list .agent[data-id="${agent}"] .working`,
        { timeout: 8_000 },
      );
      expect(await page.locator("#live-bar .working").count()).toBe(0);
      expect(
        await page
          .locator("#messages")
          .getByText("Sleep a while.", { exact: true })
          .count(),
      ).toBe(1);
      expect(sleeping()).toBe("");
    } finally {
      await page.close();
    }
  },

  // Regression: #2172 cleared Durable view paints later messages (also #2357 confirmed Clear cannot retain the prior session's context count.)
  async function test_durable_message_after_clear_is_visible_without_reload(
    browser,
    base,
  ) {
    const { agent } = await postFixture(base, "seed-durable-clear");
    const page = await browser.newPage();
    const errors = captureErrors(page);
    let releaseContext!: () => void;
    let releaseTree!: () => void;
    const heldContext = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    const heldTree = new Promise<void>((resolve) => {
      releaseTree = resolve;
    });
    try {
      await page.route(
        `${base}api/conversations/${agent}/context-usage`,
        async (route) => {
          const response = await route.fetch();
          await heldContext;
          await route.fulfill({ response });
        },
      );
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#input").waitFor();
      const deliver = async (id: string) => {
        const response = await page.request.post(
          `${base}api/conversations/${agent}/deliver`,
          {
            data: { content: id, client_message_id: id },
          },
        );
        expect(response.ok()).toBeTrue();
      };
      await deliver("before-clear");
      await page.getByText("Before Durable clear.", { exact: true }).waitFor();
      await page.locator("#conv-status.running").waitFor({ state: "detached" });
      await focusComposer(page);
      const tokens = page.locator("#context-indicator");
      await browserExpect(tokens).toBeVisible();
      await browserExpect(tokens).toHaveAttribute(
        "aria-label",
        /^Latest provider context: .*tokens used/,
      );
      await page.route(`${base}api/tree`, async (route) => {
        const response = await route.fetch();
        await heldTree;
        await route.fulfill({ response });
      });
      await page.locator("#input").fill("/clear");
      page.once("dialog", (dialog) => void dialog.accept());
      const cleared = page.waitForResponse(
        `${base}api/conversations/${agent}/clear`,
      );
      await page
        .locator("#skill-menu .skill-option.action", { hasText: "/clear" })
        .click();
      expect((await cleared).ok()).toBeTrue();
      await page
        .getByText("Before Durable clear.", { exact: true })
        .waitFor({ state: "detached" });
      await focusComposer(page);
      await browserExpect(page.locator("#context-control")).toBeHidden();
      await deliver("after-clear");
      await page
        .getByText("After Durable clear.", { exact: true })
        .waitFor({ timeout: 10_000 });
      const freshView = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${agent}/view`,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
      expect((await (await freshView).json()).status).toBe("ready");
      await waitForLayout(page);
      await page.locator(`#agent-list .agent[data-id="${agent}"]`).click();
      await waitForLayout(page);
      await focusComposer(page);
      await browserExpect(page.locator("#context-control")).toBeHidden();
      expect(
        await page.getByText("Before Durable clear.", { exact: true }).count(),
      ).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      releaseContext();
      releaseTree();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  },

  async function test_durable_refused_turn_is_left_out_and_resent(
    browser,
    base,
  ) {
    for (const kind of ["refusal", "overloaded"]) {
      const { agent } = await postFixture(base, "seed-durable-rejected", {
        agent: `durable-rejected-${kind}`,
        kind,
      });
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      const errors = captureErrors(page);
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#input").waitFor();
      const send = async (id: string, content: string) => {
        const response = await page.request.post(
          `${base}api/conversations/${agent}/deliver`,
          { data: { content, client_message_id: id } },
        );
        expect(response.ok()).toBeTrue();
      };
      await send(`${kind}-1`, "First question");
      await page.getByText("First answer.", { exact: true }).waitFor();
      await page.locator("#conv-status.running").waitFor({ state: "detached" });
      await send(`${kind}-2`, "Rejected question");
      const note = page.locator(".msg.assistant .error-note");
      await note
        .filter({ hasText: kind === "overloaded" ? "(4 attempts)" : "refused" })
        .waitFor({ timeout: 30_000 });
      expect(await note.count()).toBe(1);
      expect(await page.getByText("the model will see it").count()).toBe(0);
      if (kind === "refusal") {
        const refused = page.locator(".activity-boundary.refused");
        await refused.waitFor();
        expect(await refused.locator(".refused-note").innerText()).toContain(
          "The model refused to complete the request.",
        );
        expect(
          await refused.getByText("Rejected question", { exact: true }).count(),
        ).toBe(1);
      } else {
        expect(await page.locator(".activity-boundary.refused").count()).toBe(
          0,
        );
        expect(await note.innerText()).toBe(
          `Provider ${agent} returned a server error. Try again. (4 attempts)`,
        );
      }
      for (const [name, options] of [
        ["desktop", { viewport: { width: 1280, height: 800 } }],
        [
          "phone",
          {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
          },
        ],
      ] as const) {
        if (!shots) break;
        const view = await browser.newPage(options);
        await view.goto(`${base}#agent=${agent}`, {
          waitUntil: "domcontentloaded",
        });
        await view.locator(".msg.assistant .error-note").waitFor();
        await view.screenshot({
          path: `${shots}/durable-rejected-${kind}-${name}.png`,
        });
        if (kind === "refusal" && name === "desktop") {
          await view.addStyleTag({
            content: renderThemeCss(
              themePalettes.find((p) => p.name === themeDefaults.light)!,
            ),
          });
          await view.screenshot({
            path: `${shots}/durable-rejected-${kind}-${name}-light.png`,
          });
        }
        await view.close();
      }
      if (kind === "refusal") {
        await page.locator("#input").fill("Draft");
        await page.getByRole("button", { name: "Resend" }).click();
        expect(await page.locator("#input").inputValue()).toBe(
          "Draft\n\nRejected question",
        );
        await page.locator("#input").fill("Next question");
      } else await page.locator("#input").fill("Next question");
      await page.locator("#input").press("Enter");
      await page
        .getByText(
          kind === "refusal"
            ? "The rejected question is not in my context."
            : "The rejected question is in my context.",
          { exact: true },
        )
        .waitFor({ timeout: 10_000 });
      expect(errors).toEqual([]);
      await page.close();
    }
  },

  // Regression: #2357 running controls remain above Thinking with no usage through live updates. (also #2357 and #3115 older backends retain the last count and reserved width during a usage refresh.)
  async function test_durable_turn_streams_and_reloads(browser, base) {
    const { agent } = await postFixture(base, "seed-durable");
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
    });
    const errors = captureErrors(page);
    const eventCodings = new Set<string>();
    page.on("response", (response) => {
      if (response.url().includes(`/api/conversations/${agent}/events`))
        eventCodings.add(response.headers()["content-encoding"] ?? "identity");
    });
    await page.goto(`${base}#agent=${agent}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("#composer, textarea").first().waitFor();
    const contextButton = page.locator("#context-indicator");
    const contextLabel = () => contextButton.getAttribute("aria-label");
    await page.route(`${base}api/tree`, async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      type ContextRow = { id: string; agent?: { context?: unknown } };
      const tree = (await response.json()) as
        | ContextRow[]
        | TreeUpdate<ContextRow>;
      const rows = Array.isArray(tree)
        ? tree
        : "changed" in tree
          ? tree.changed
          : [];
      for (const row of rows)
        if (row.id === agent && row.agent) delete row.agent.context;
      await route.fulfill({ response, json: tree });
    });
    let previous!: string;
    let tokenWidth!: number;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCaptured = false;
    await page.route(
      `${base}api/conversations/${agent}/context-usage`,
      async (route) => {
        const label = await contextLabel();
        if (!label || refreshCaptured) {
          await route.continue();
          return;
        }
        refreshCaptured = true;
        previous = label;
        await contextButton.waitFor();
        tokenWidth = await contextButton.evaluate(
          (node) => node.getBoundingClientRect().width,
        );
        const response = await route.fetch();
        await page.evaluate(() => {
          Object.assign(window, { contextRefreshHeld: true });
        });
        await refreshGate;
        await route.fulfill({ response });
      },
    );
    const sent = await page.request.post(
      `${base}api/conversations/${agent}/deliver`,
      { data: { content: "List the files.", client_message_id: "durable-1" } },
    );
    expect(sent.ok()).toBe(true);
    await page.getByText("List the files.", { exact: true }).waitFor();
    await page
      .locator(".working .live-label", { hasText: "Listing the files" })
      .waitFor({ timeout: 10_000 });
    if (shots) await page.screenshot({ path: `${shots}/running-footer.png` });
    await page.evaluate(() => {
      const samples: unknown[] = [];
      const sample = () => {
        const block = document.querySelector(".activity-boundary.current");
        if (!block) throw new Error("Running block disappeared");
        const footer = block.querySelector(".turn-foot");
        const working = document.querySelector("#live-bar .working");
        samples.push({
          controls: Boolean(footer?.querySelector(".turn-expand")),
          usage: Boolean(footer?.querySelector(".turn-tokens")),
          above: Boolean(
            footer &&
            working &&
            footer.getBoundingClientRect().bottom <=
              working.getBoundingClientRect().top,
          ),
        });
      };
      sample();
      const observer = new MutationObserver(sample);
      observer.observe(document.querySelector("#messages")!, {
        childList: true,
        subtree: true,
      });
      Object.assign(window, {
        footerSamples: samples,
        footerObserver: observer,
      });
    });
    await page.locator(".activity-group-toggle").first().click();
    await page.locator(".turn-series-toggle").first().click();
    await page.locator(".turn-tool").first().click();
    await page.getByText("tick 1").first().waitFor({ timeout: 10_000 });
    await focusComposer(page);
    await contextButton.waitFor();
    if (shots)
      await page.screenshot({ path: `${shots}/durable-tool-running.png` });
    await page.getByText("tick 2").first().waitFor({ timeout: 10_000 });
    await page.waitForFunction(
      () =>
        (window as unknown as { contextRefreshHeld?: boolean })
          .contextRefreshHeld,
    );
    if (shots) await page.screenshot({ path: `${shots}/context-refresh.png` });
    const duringRefresh = await contextLabel();
    const duringWidth = await contextButton.evaluate(
      (node) => node.getBoundingClientRect().width,
    );
    releaseRefresh();
    expect(previous).toMatch(
      /^Latest provider context: .+ tokens used(?:; context limit unavailable)?\. Open context details\.$/,
    );
    expect(duringRefresh).toBe(previous);
    expect(duringWidth).toBe(tokenWidth);
    await page.unrouteAll({ behavior: "wait" });
    const samples = await page.evaluate(() => {
      const captured = window as unknown as {
        footerSamples: unknown[];
        footerObserver: { disconnect(): void };
      };
      captured.footerObserver.disconnect();
      return captured.footerSamples;
    });
    expect(samples.length).toBeGreaterThan(1);
    expect(samples).toEqual(
      samples.map(() => ({ controls: true, usage: false, above: true })),
    );
    await postFixture(base, "release", { agent, gate: "reply" });
    await page
      .getByText("Durable answer: the command", { exact: false })
      .first()
      .waitFor();
    expect(
      await page
        .getByText("This sentence streams slowly so the live answer shows.")
        .count(),
    ).toBe(0);
    const partial = await (
      await page.request.get(`${base}api/conversations/${agent}/view?limit=50`)
    ).json();
    const next = await page.evaluate(
      async ({ url, id }) => {
        const abort = new AbortController();
        const response = await fetch(url, {
          headers: { "Last-Event-ID": id },
          signal: abort.signal,
        });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (
          !/"text_from": ?[1-9]/.test(text) &&
          !/"turn_status":"(?!running)/.test(text)
        ) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        abort.abort();
        return text;
      },
      {
        url: `${base}api/conversations/${agent}/events?text_deltas=true`,
        id: `${partial.instance_id}:${partial.revision}`,
      },
    );
    expect(next).toMatch(/"text_from": ?[1-9]/);
    if (shots)
      await page.screenshot({ path: `${shots}/durable-streaming.png` });
    await page
      .getByText("This sentence streams slowly so the live answer shows.", {
        exact: false,
      })
      .first()
      .waitFor({ timeout: 15_000 });
    expect(eventCodings).toContain("gzip");
    const answer = page
      .locator(".msg.assistant .content", { hasText: "Durable answer" })
      .first();
    expect((await answer.innerText()).trim()).toBe(
      "Durable answer: the command printed two ticks. " +
        "It ran in the work directory. ".repeat(12) +
        "This sentence streams slowly so the live answer shows.",
    );
    await page.locator("#conv-status.running").waitFor({ state: "detached" });
    const block = page
      .locator("#messages > .activity-boundary")
      .filter({ hasText: "Durable answer" });
    const foot = block.locator(".turn-foot");
    await foot.waitFor();
    const view = await (
      await page.request.get(`${base}api/conversations/${agent}/view?limit=50`)
    ).json();
    const replies = view.blocks.filter((b: any) => b.usage);
    expect(replies.length).toBe(2);
    const total = replies.reduce(
      (sum: number, b: any) =>
        sum +
        b.usage.input +
        b.usage.output +
        b.usage.cacheRead +
        b.usage.cacheWrite,
      0,
    );
    const title = await foot.locator(".turn-tokens").getAttribute("title");
    const shown = /^View activity token usage: ([\d.]+)k model tokens$/.exec(
      title ?? "",
    );
    expect(Math.abs(Number(shown?.[1]) * 1000 - total)).toBeLessThan(50);
    const groups = block.locator(".activity-group-toggle");
    const states = () =>
      groups.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-expanded")),
      );
    expect(await states()).toEqual(["true"]);
    await groups.first().click();
    expect(await states()).toEqual(["false"]);
    await foot.locator(".turn-expand").click();
    expect(await states()).toEqual(["true"]);
    await block.locator(".turn-tool").first().waitFor();
    expect(await block.locator(".turn-thinking-toggle").count()).toBe(1);
    if (shots) await page.screenshot({ path: `${shots}/durable-expanded.png` });
    await foot.locator(".turn-expand").click();
    expect(await states()).toEqual(["false"]);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#scroll").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("v");
    expect(await states()).toEqual(["true"]);
    await page.keyboard.press("v");
    expect(await states()).toEqual(["false"]);
    await page.reload();
    await page
      .getByText("This sentence streams slowly so the live answer shows.", {
        exact: false,
      })
      .first()
      .waitFor();
    await page.getByText("List the files.", { exact: true }).waitFor();
    await page.context().setOffline(true);
    const again = await fetch(`${base}api/conversations/${agent}/deliver`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Again.",
        client_message_id: "durable-2",
      }),
    });
    expect(again.ok).toBe(true);
    await Bun.sleep(1500);
    await page.context().setOffline(false);
    await page
      .getByText("Second durable answer.", { exact: true })
      .waitFor({ timeout: 20_000 });
    if (shots) {
      const open = async (name: string) => {
        await page.screenshot({ path: `${shots}/${name}-final.png` });
        await page.locator(".activity-group-toggle").first().click();
        await page.locator(".turn-series-toggle").first().click();
        await page.screenshot({ path: `${shots}/${name}-open.png` });
      };
      await open("durable");
    }
    expect(errors).toEqual([]);
  },
];
