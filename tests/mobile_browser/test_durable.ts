import { expect } from "bun:test";
declare const document: any;
declare const window: any;
declare const MutationObserver: any;
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  postFixture,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { row as fixtureRow } from "./fixtures";
import recorded from "./fixtures/durable-compaction-jump.json";
import recordedThinking from "./fixtures/thinking-stream.json";
import { renderThemeCss, themeDefaults, themePalettes } from "../../src/themes";

function withThinkingCleanup(
  test: BrowserTest,
  agent = "durable-thinking",
): BrowserTest {
  const wrapped: BrowserTest = async (...args) => {
    try {
      await test(...args);
    } finally {
      await postFixture(args[1], `durable-thinking-cleanup?agent=${agent}`);
    }
  };
  Object.defineProperty(wrapped, "name", { value: test.name });
  return wrapped;
}

const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;

export const tests: BrowserTest[] = [
  // Regression: #2317 Durable context categories disappeared after #2281/#2299. (also #2515 System and User prompts used near-identical blues.)
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
      await page.locator("#context-indicator").click();
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

  // Regression: #2274 thinking stays readable across tool commit (also #2357 expanded thinking remains whole in page flow.; #2357 collapsed handover must fetch stored prose, not keep reading offset=-1.; #2357 expanded groups must not duplicate thought prose or running summaries.)
  async function test_running_thought_loads_and_survives_its_commit(
    browser,
    base,
  ) {
    const { agent } = await postFixture(base, "seed-durable-thinking");
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = captureErrors(page);
    const offsets: number[] = [];
    page.on("request", (request) => {
      if (request.url().includes(`/api/conversations/${agent}/thinking?`))
        offsets.push(Number(new URL(request.url()).searchParams.get("offset")));
    });
    const storedRead = page
      .waitForResponse(
        (response) =>
          response.url().includes(`/api/conversations/${agent}/thinking?`) &&
          Number(new URL(response.url()).searchParams.get("offset")) >= 0,
        { timeout: 30_000 },
      )
      .then(
        () => true,
        () => false,
      );
    const samples: {
      state: string;
      thoughts: number;
      running: number;
      completed: number;
    }[] = [];
    const sample = async (state: string) => {
      if (shots)
        await page.screenshot({ path: `${shots}/dedupe-${state}.png` });
      const text = recordedThinking.thinking.replace(/\s+/g, " ").trim();
      const bodies = await page
        .locator(".turn-thinking-body, .live-thinking-summary")
        .allInnerTexts();
      const summaries = await page
        .locator(
          ".activity-group-summary .turn-summary, .turn-series-toggle, .live-thinking-title",
        )
        .allInnerTexts();
      samples.push({
        state,
        thoughts: bodies.filter(
          (body) => body.replace(/\s+/g, " ").trim() === text,
        ).length,
        running: summaries.filter((line) => /\bRunning\b/.test(line)).length,
        completed: summaries.filter((line) =>
          /\bRan \d+ commands?\b/.test(line),
        ).length,
      });
    };
    const openGroup = async () => {
      await page.locator(".activity-group-toggle").first().click();
      await page.locator(".activity-group.open").first().waitFor();
      for (const toggle of await page
        .locator('.turn-series-toggle[aria-expanded="false"]')
        .all())
        await toggle.click();
      for (const toggle of await page
        .locator('.turn-thinking-toggle[aria-expanded="false"]')
        .all())
        await toggle.click();
      await page.waitForFunction(
        (text) =>
          Array.from(
            document.querySelectorAll(
              '.turn-thinking-toggle[aria-expanded="true"]',
            ),
          ).every(
            (toggle: any) =>
              (
                document.getElementById(toggle.getAttribute("aria-controls"))
                  ?.innerText ?? ""
              )
                .replace(/\s+/g, " ")
                .trim() === text,
          ),
        recordedThinking.thinking.replace(/\s+/g, " ").trim(),
      );
    };
    await page.goto(`${base}#agent=${agent}`);
    await page.locator("#input").fill("Replay the recorded streaming thought.");
    await page.locator("#send").click();
    await openGroup();
    for (const toggle of await page
      .locator('.live-thinking-copy[aria-expanded="false"]')
      .all())
      await toggle.click();
    expect(offsets).toContain(-1);
    const liveText = await page.request.get(
      `${base}api/conversations/${agent}/thinking?offset=-1`,
    );
    expect(await liveText.json()).toEqual({
      text: recordedThinking.thinking,
      live: true,
    });
    const summary = page.locator(".live-thinking-summary");
    expect(
      await page
        .locator(".turn-tool")
        .first()
        .getAttribute("data-message-offset"),
    ).toBe("-1");
    await page.locator(".activity-group-hide").first().click();
    await sample("collapsed-live");
    await openGroup();
    await sample("expanded-live");
    await page.locator(".activity-group-hide").first().click();
    const readsBeforeCommit = offsets.length;
    await postFixture(base, "durable-thinking-commit");
    await page
      .locator(".activity-group-summary .turn-summary")
      .filter({ hasText: /\bRunning\b/ })
      .first()
      .waitFor();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          (globalThis as any).requestAnimationFrame(() => resolve()),
        ),
    );
    const storedReadWhileCollapsed = offsets
      .slice(readsBeforeCommit)
      .some((offset) => offset >= 0);
    for (const toggle of await page
      .locator('.live-thinking-copy[aria-expanded="false"]')
      .all())
      await toggle.click();
    await summary
      .getByText("Now running the sample command.", { exact: false })
      .waitFor();
    await sample("collapsed-committed");
    if (shots)
      await page.screenshot({ path: `${shots}/thinking-expanded.png` });
    expect((await summary.innerText()).trim()).toBe(
      recordedThinking.thinking.trim(),
    );
    expect(
      await summary.evaluate((node) => ({
        clipped: node.scrollHeight > node.clientHeight,
        top: node.scrollTop,
      })),
    ).toEqual({ clipped: false, top: 0 });
    await openGroup();
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll(".turn-tool[data-message-offset]"),
        ).some((node: any) => Number(node.dataset.messageOffset) >= 0),
      undefined,
      { timeout: 30_000 },
    );
    expect(await storedRead).toBeTrue();
    expect(offsets.some((offset) => offset >= 0)).toBeTrue();
    const storedText = await page.request.get(
      `${base}api/conversations/${agent}/thinking?offset=${offsets.find((offset) => offset >= 0)}`,
    );
    expect(await storedText.json()).toEqual({
      text: recordedThinking.thinking,
      live: false,
    });
    const thought = page.locator(".turn-thinking-toggle").first();
    const body = page.locator(".turn-thinking-body").first();
    await body
      .getByText("Now running the sample command.", { exact: false })
      .waitFor();
    for (const toggle of await page
      .locator('.live-thinking-copy[aria-expanded="false"]')
      .all())
      await toggle.click();
    await sample("expanded-committed");
    expect(storedReadWhileCollapsed).toBeTrue();
    expect(samples).toEqual([
      { state: "collapsed-live", thoughts: 1, running: 0, completed: 0 },
      { state: "expanded-live", thoughts: 1, running: 0, completed: 0 },
      { state: "collapsed-committed", thoughts: 1, running: 1, completed: 0 },
      { state: "expanded-committed", thoughts: 1, running: 1, completed: 0 },
    ]);
    expect(await thought.getAttribute("aria-expanded")).toBe("true");
    expect((await body.innerText()).trim()).toBe(
      recordedThinking.thinking.replace(/\s+/g, " "),
    );
    expect(await summary.count()).toBe(0);
    expect(await page.locator("#conv-status.running").count()).toBe(1);
    await postFixture(base, "durable-release");
    const secondThought = page.locator(".turn-thinking-toggle").nth(1);
    await secondThought.waitFor();
    expect(await thought.getAttribute("aria-expanded")).toBe("true");
    expect(await secondThought.getAttribute("aria-expanded")).toBe("false");
    await page
      .getByText("Thinking stream finished.", { exact: true })
      .waitFor();
    await page.locator("#conv-status.running").waitFor({ state: "detached" });
    const stopped = await page.request.post(
      `${base}api/conversations/${agent}/deliver`,
      { data: {} },
    );
    expect(stopped.ok()).toBeTrue();
    expect(errors).toEqual([]);
    await page.close();
  },

  // Regression: #2423 a failed thinking case must not leave a working agent for the next case.
  async function test_failed_thinking_case_leaves_no_working_agent(
    browser,
    base,
    data,
    serverPid,
  ) {
    const page = await browser.newPage();
    const failing = withThinkingCleanup(async () => {
      await postFixture(
        base,
        "seed-durable-thinking?agent=durable-thinking-failure",
      );
      await page.goto(`${base}#agent=durable-thinking-failure`);
      await page
        .locator("#input")
        .fill("Replay the recorded streaming thought.");
      await page.locator("#send").click();
      await page.locator(".working.live-panel").waitFor();
      throw new Error("deliberate thinking assertion failure");
    }, "durable-thinking-failure");
    await expect(failing(browser, base, data, serverPid)).rejects.toThrow(
      "deliberate thinking assertion failure",
    );
    await page.reload();
    await page.waitForFunction(
      () => !document.querySelector(".working"),
      undefined,
      { timeout: 8_000 },
    );
    await page.close();
  },

  // Regression: #2205 events clear Stop/panel while reads are held
  async function test_durable_stop_clears_from_the_events_frame(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-stop");
    const page = await browser.newPage();
    await page.goto(`${base}#agent=${agent}`);
    await page.locator("#input").fill("Sleep a while.");
    await page.locator("#send").click();
    await page.locator(".working.live-panel").waitFor();
    const sleeping = () =>
      Bun.spawnSync(["pgrep", "-x", "-f", "sleep 31[.]25"]).stdout.toString();
    for (let i = 0; !sleeping() && i < 100; i++) await Bun.sleep(100);
    let holding = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    page.on("request", (r) => void (holding ||= r.url().endsWith("/deliver")));
    const reads = RegExp(`/api/conversations/${agent}[?]`);
    await page.route(reads, async (route) => {
      if (holding) await held;
      await route.fallback();
    });
    await page.locator("#send.stop").click();
    await page.locator("#send.stop.armed").click();
    for (const shown of [
      "#conv-status.running",
      "#send.stop",
      `#agent-list .agent[data-id="${agent}"] .working, #conv-titlebar .working, #composer-wrap .working, #messages .working`,
    ])
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        shown,
        { timeout: 8_000 },
      );
    expect(sleeping()).toBe("");
    release();
    await page.close();
  },

  // Regression: #2430 quick Stop must not leave the admitted send looking queued after chrome is idle.
  async function test_quick_stop_clears_thread_with_reads_free(browser, base) {
    const { agent } = await postFixture(
      base,
      "seed-durable-stop?agent=durable-stop-quick",
    );
    const page = await browser.newPage();
    try {
      await page.goto(`${base}#agent=${agent}`);
      await page.locator("#input").fill("Sleep a while.");
      await page.locator("#send").click();
      await page.locator(".working.live-panel").waitFor();
      const sleeping = () =>
        Bun.spawnSync(["pgrep", "-x", "-f", "sleep 31[.]25"]).stdout.toString();
      // test-check-allow: T6 Bounded pgrep poll for the real sleeping tool.
      for (let i = 0; !sleeping() && i < 100; i++) await Bun.sleep(100);
      expect(sleeping()).not.toBe("");
      await page.locator("#send.stop").click();
      await page.locator("#send.stop.armed").click();
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        `#conv-status.running, #send.stop, #agent-list .agent[data-id="${agent}"] .working`,
        { timeout: 8_000 },
      );
      expect(await page.locator("#messages .working").count()).toBe(0);
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
    const tokens = page.locator("#context-token-label");
    await tokens.waitFor();
    expect(await tokens.innerText()).toMatch(/tokens$/);
    let releaseContext!: () => void;
    const heldContext = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    await page.route(
      `${base}api/conversations/${agent}/context-usage`,
      async (route) => {
        const response = await route.fetch();
        await heldContext;
        await route.fulfill({ response });
      },
    );
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
    const afterClear = await tokens.innerText();
    releaseContext();
    await page.unrouteAll({ behavior: "wait" });
    expect(afterClear).toBe("");
    await deliver("after-clear");
    await page
      .getByText("After Durable clear.", { exact: true })
      .waitFor({ timeout: 10_000 });
    expect(
      await page.getByText("Before Durable clear.", { exact: true }).count(),
    ).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  },

  async function test_durable_refused_turn_is_left_out_and_resent(
    browser,
    base,
  ) {
    for (const kind of ["refusal", "overloaded"]) {
      const { agent } = await postFixture(
        base,
        `seed-durable-rejected?agent=durable-rejected-${kind}&kind=${kind}`,
      );
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
          "Provider fauxfast returned a server error. Try again. (4 attempts)",
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

  // Regression: #2357 running controls remain above Thinking with no usage through live updates. (also #2357 a revision refresh keeps the last count and its reserved width.)
  async function test_durable_turn_streams_and_reloads(browser, base) {
    const { agent } = await postFixture(base, "seed-durable");
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
    });
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${agent}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("#composer, textarea").first().waitFor();
    const token = page.locator("#context-token-label");
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
        const label = await token.innerText();
        if (!label || refreshCaptured) {
          await route.continue();
          return;
        }
        refreshCaptured = true;
        previous = label;
        tokenWidth = await token.evaluate(
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
        const working = block.querySelector(".working");
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
    await token.waitFor();
    if (shots)
      await page.screenshot({ path: `${shots}/durable-tool-running.png` });
    await page.getByText("tick 2").first().waitFor({ timeout: 10_000 });
    await page.waitForFunction(
      () =>
        (window as unknown as { contextRefreshHeld?: boolean })
          .contextRefreshHeld,
    );
    if (shots) await page.screenshot({ path: `${shots}/context-refresh.png` });
    const duringRefresh = await token.innerText();
    const duringWidth = await token.evaluate(
      (node) => node.getBoundingClientRect().width,
    );
    releaseRefresh();
    expect(previous).toMatch(/tokens$/);
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
    await postFixture(base, "durable-release");
    await page
      .getByText("Durable answer: the command", { exact: false })
      .first()
      .waitFor();
    expect(
      await page
        .getByText("This sentence streams slowly so the live answer shows.")
        .count(),
    ).toBe(0);
    if (shots)
      await page.screenshot({ path: `${shots}/durable-streaming.png` });
    await page
      .getByText("This sentence streams slowly so the live answer shows.", {
        exact: false,
      })
      .first()
      .waitFor({ timeout: 15_000 });
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
      const twin = await postFixture(base, "seed-pi-twin");
      await page.goto(`${base}#agent=${twin.agent}`);
      await page.reload();
      await page.getByText("Second durable answer.", { exact: true }).waitFor();
      await open("pi-twin");
    }
    expect(errors).toEqual([]);
  },

  // Feature: #2514 compaction jumps reveal the recorded kept message.
  async function test_durable_compaction_jump_reveals_first_recorded_kept_message(
    browser,
    base,
  ) {
    const [kept, input, summary, response] = recorded;
    const rows = [
      fixtureRow("prior", "user", "Prior request"),
      fixtureRow("prior-response", "assistant", "Prior response"),
      fixtureRow(String(summary!.id), "compaction", summary!.text, {
        kind: "marker",
        meta: { compact_marker: true, firstKeptEntryId: String(summary!.head) },
      }),
      fixtureRow(String(kept!.id), "user", kept!.text, {
        origin: "agent",
        sender: "sender",
      }),
      fixtureRow("kept-response", "assistant", "Kept response"),
      fixtureRow(String(input!.id), "user", input!.text),
      fixtureRow(String(response!.id), "assistant", response!.text),
      fixtureRow("notice", "compaction-notice", "Context compacted.", {
        kind: "marker",
        meta: { summaryEntryId: String(summary!.id) },
      }),
    ];
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = captureErrors(page);
    await mockConversation(page, base, "main", () => ({
      id: "main",
      title: "Recorded compaction",
      parent: null,
      backend: "durable",
      status: "idle",
      msg_count: rows.length,
      rows,
    }));
    await gotoRoot(page, base);
    const jump = page.locator(".compaction-jump-link");
    await jump.waitFor();
    expect(await page.getByText(kept!.text, { exact: true }).count()).toBe(0);
    await jump.click();
    const target = page.locator(".file-jump-target");
    await target.waitFor();
    if (shots)
      await page.screenshot({ path: `${shots}/durable-first-kept.png` });
    expect(await target.getAttribute("data-row-id")).toBe(`row:${kept!.id}`);
    expect(await page.getByText(kept!.text, { exact: true }).isVisible()).toBe(
      true,
    );
    expect(await jump.innerText()).toBe("Jump to first kept message");
    expect(errors).toEqual([]);
    await page.close();
  },

  // Regression: #2874 returning restores the reader's row or the bottom.
  async function test_durable_jump_pages_past_compaction(browser, base) {
    for (const width of [390, 1280]) {
      const mobile = width === 390;
      const { agent } = await postFixture(base, "seed-durable-history", {
        agent: `durable-history-${width}`,
        neighbours: 8,
      });
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        hasTouch: mobile,
        isMobile: mobile,
      });
      const errors = captureErrors(page);
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText("Answer 69", { exact: true }).waitFor();
      const jump = page.locator(".compaction-jump-link");
      await jump.waitFor();
      if (shots)
        await page.screenshot({ path: `${shots}/durable-notice-${width}.png` });
      await jump.click();
      await page
        .locator(".file-jump-target:not(.compacted-activity)")
        .waitFor();
      const divider = page.locator(".compacted-activity");
      expect(await divider.locator(".disclosure-body").count()).toBe(0);
      await divider.locator(".compacted-head").click();
      await divider.locator(".disclosure-body").waitFor({ timeout: 15_000 });
      await divider
        .getByText("Summary of turns 0-19.", { exact: false })
        .first()
        .waitFor();
      const top = async (text: string) =>
        (await page.getByText(text, { exact: true }).boundingBox())!.y;
      const at = (await divider.boundingBox())!.y;
      expect(at).toBeLessThan(await top("Answer 40"));
      expect(await page.getByText("Answer 25", { exact: true }).count()).toBe(
        1,
      );
      if (shots)
        await page.screenshot({
          path: `${shots}/durable-summary-${width}.png`,
        });
      const open = async (id: string, title: string) => {
        if (mobile) await page.locator("#menu-btn").click();
        await page.locator(`.agent[data-id="${id}"]`).click();
        await page.locator("#conv-title", { hasText: title }).waitFor();
        await page
          .locator("#conv-freshness:not(.on)")
          .waitFor({ state: "attached" });
      };
      await postFixture(base, "durable-history-more", {
        agent,
        from: 70,
        to: 71,
        report: true,
      });
      await postFixture(base, "durable-history-more", {
        agent,
        from: 71,
        to: 76,
      });
      const turn = page.locator(".activity-boundary", { hasText: "Answer 70" });
      await turn.locator(".activity-group-toggle").click();
      const report = await turn
        .locator(".agent-message[data-row-id]")
        .getAttribute("data-row-id");
      const reader = page.locator(`#scroll [data-row-id="${report}"]`);
      const readerTop = () =>
        reader.evaluate(
          (row) =>
            row.getBoundingClientRect().top -
            document.querySelector("#scroll").getBoundingClientRect().top,
        );
      await reader.evaluate((row) => {
        row.scrollIntoView({ block: "start" });
        document.querySelector("#scroll").scrollTop += 4;
      });
      await waitForLayout(page);
      const left = await readerTop();
      for (let n = 0; n < 8; n += 1)
        await open(`${agent}-${n}`, `Neighbour ${n}`);
      await postFixture(base, "durable-history-more", {
        agent,
        from: 76,
        to: 128,
        compact: true,
      });
      await open(agent, "Durable history");
      await page.getByText("Answer 127", { exact: true }).waitFor();
      await reader.waitFor();
      await waitForLayout(page);
      expect(await readerTop()).toBeCloseTo(left, 0);
      const fromBottom = () =>
        page.evaluate(() => {
          const scroll = document.querySelector("#scroll");
          return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
        });
      await page.locator("#scroll-btn.visible").click();
      await page.waitForFunction(() => {
        const scroll = document.querySelector("#scroll");
        return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 1;
      });
      await open("main", "Agent");
      await postFixture(base, "durable-history-more", {
        agent,
        from: 128,
        to: 130,
      });
      await open(agent, "Durable history");
      await page.getByText("Answer 129", { exact: true }).waitFor();
      await waitForLayout(page);
      expect(await fromBottom()).toBeLessThan(1);
      expect(errors).toEqual([]);
      await page.close();
    }
  },

  async function test_durable_operator_compact_two_places(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-compactable");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${agent}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText("Reply 29", { exact: true }).waitFor();
    const composer = page.locator("#input");
    await composer.fill("/compact");
    await page
      .locator("#skill-menu .skill-option.action", { hasText: "/compact" })
      .waitFor();
    const response = page.waitForResponse(
      `${base}api/conversations/${agent}/compact`,
    );
    await composer.press("Escape");
    await composer.press("Enter");
    expect((await response).ok()).toBe(true);
    const compacting = page.locator(".thread-marker", {
      hasText: "Compacting…",
    });
    await compacting.waitFor({ timeout: 10_000 });
    expect(await compacting.count()).toBe(1);
    if (shots)
      await page.screenshot({ path: `${shots}/durable-compacting.png` });
    await postFixture(base, "durable-summary-release");
    const jump = page.locator(".compaction-jump-link");
    await jump.waitFor({ timeout: 15_000 });
    await compacting.waitFor({ state: "detached" });
    const notice = (await jump.boundingBox())!.y;
    expect(notice).toBeGreaterThan(
      (await page.getByText("Reply 29", { exact: true }).boundingBox())!.y,
    );
    expect(
      await page
        .getByText("Your context was just compacted", {
          exact: false,
        })
        .count(),
    ).toBe(0);
    if (shots)
      await page.screenshot({ path: `${shots}/durable-compact-notice.png` });
    await jump.click();
    await page.locator(".file-jump-target:not(.compacted-activity)").waitFor();
    const divider = page.locator(".compacted-activity");
    expect(await divider.locator(".disclosure-body").count()).toBe(0);
    await divider.locator(".compacted-head").click();
    await divider.locator(".disclosure-body").waitFor({ timeout: 15_000 });
    await divider
      .getByText("Summary of the early tasks.", { exact: false })
      .first()
      .waitFor();
    expect((await divider.boundingBox())!.y).toBeLessThan(
      (await page.getByText("Reply 29", { exact: true }).boundingBox())!.y,
    );
    if (shots) {
      await divider.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `${shots}/durable-compact-summary.png` });
    }
    expect(errors).toEqual([]);
  },
];

for (const [index, test] of tests.entries())
  if (test.name === "test_running_thought_loads_and_survives_its_commit")
    tests[index] = withThinkingCleanup(test);
