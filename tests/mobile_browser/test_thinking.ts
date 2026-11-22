import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { captureErrors, postFixture, type BrowserTest } from "./common";
import recordedThinking from "./fixtures/thinking-stream.json";

function withThinkingCleanup(
  test: BrowserTest,
  agent = "durable-thinking",
): BrowserTest {
  const wrapped: BrowserTest = async (...args) => {
    try {
      await test(...args);
    } finally {
      await postFixture(args[1], "durable-thinking-cleanup", { agent });
    }
  };
  Object.defineProperty(wrapped, "name", { value: test.name });
  return wrapped;
}

const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;

// Regression: #3518 keep the latest thought and its disclosure through tools, replies and the end of a run.
const test_last_thinking_survives_wait_and_reload: BrowserTest = async (
  browser,
  base,
) => {
  for (const thinking of [
    "claude",
    "chatgpt",
    "claude-redacted",
    "chatgpt-encrypted",
  ]) {
    for (const width of [1280, 390]) {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          isMobile: width === 390,
          hasTouch: width === 390,
          colorScheme,
        });
        const errors = captureErrors(page);
        let agent = "";
        let idleAgent = "";
        try {
          const theme = await page.request.post(`${base}api/settings/theme`, {
            data: { theme: "Tokyo Night", appearance: colorScheme },
          });
          expect(theme.ok()).toBeTrue();
          const seed = await page.request.post(
            `${base}__browser-test/seed-live-tools`,
            { data: { thinking } },
          );
          agent = (await seed.json()).agent;
          const release = (gate: string, cid = agent) =>
            postFixture(base, "release", { agent: cid, gate });
          const send = async (text: string) => {
            await page.locator("#input").fill(text);
            await page.locator("#send").click();
          };
          const expectIdle = async (cid: string) => {
            await browserExpect
              .poll(async () => {
                const view = await page.request.get(
                  `${base}api/conversations/${cid}/view`,
                );
                expect(view.ok()).toBeTrue();
                return (await view.json()).turn_status;
              })
              .toBe("idle");
          };
          await page.goto(`${base}#agent=${agent}`);
          await send("Check the background work.");
          const bar = page.locator("#live-bar");
          const summary = bar.locator(".live-thinking-summary");
          const titleLine = bar.locator(".live-thinking-title");
          const disclosure = bar.locator(".live-thinking-copy");
          const expectTitle = async (title: string) => {
            await browserExpect(titleLine).toHaveText(title);
            await browserExpect(bar.locator(".live-thinking-head")).toHaveText(
              /^Waiting/,
            );
          };
          const expectDisclosure = (expanded: boolean) =>
            browserExpect(disclosure).toHaveAttribute(
              "aria-expanded",
              String(expanded),
            );
          const prose =
            "I am waiting for the command to finish before checking its result.";
          const title = thinking.startsWith("chatgpt")
            ? prose
            : "Checking the background work";
          const thought = page
            .locator(".turn-thinking-toggle")
            .filter({ hasText: title });
          const thoughtBody = page
            .locator(".turn-thinking-body")
            .filter({ hasText: prose });
          const expectThreadOpen = async () => {
            await browserExpect(thought).toHaveAttribute(
              "aria-expanded",
              "true",
            );
            await browserExpect(thoughtBody).toBeVisible();
          };
          const expectSameThought = async () => {
            await expectTitle(title);
            await browserExpect(summary).toHaveText(prose);
            await expectThreadOpen();
          };
          await bar.locator(".shell-chip").waitFor();
          await expectTitle(title);
          await page.reload();
          await bar.locator(".shell-chip").waitFor();
          await expectTitle(title);
          const shots = process.env.LAST_THINKING_SCREENSHOTS;
          const screenshot = async (mode: string) => {
            if (shots)
              await page.screenshot({
                path: `${shots}/${thinking}-${width}-${colorScheme}-${mode}.png`,
                animations: "disabled",
              });
          };
          await expectDisclosure(false);
          await screenshot("collapsed");
          if (width === 390) {
            expect(
              await disclosure.evaluate((button) => {
                const rect = button.getBoundingClientRect();
                const mid = (rect.top + rect.bottom) / 2;
                return [rect.left + 1, rect.right - 1].every((x) =>
                  [mid - 21, mid + 21].every((y) =>
                    button.contains(document.elementFromPoint(x, y)),
                  ),
                );
              }),
            ).toBeTrue();
            await disclosure.tap();
          } else {
            await disclosure.press("Enter");
          }
          await expectDisclosure(true);
          await browserExpect(summary).toHaveText(prose);
          await screenshot("expanded");
          const openThread = async () => {
            await page.locator(".activity-group-toggle").first().click();
            const commands = page.locator(".turn-series-toggle").first();
            await browserExpect(commands).toHaveAttribute(
              "aria-expanded",
              "false",
            );
            await browserExpect(thought).toHaveText(/^Thought for \d+s · /, {
              useInnerText: true,
            });
            await commands.click();
            await browserExpect(thought).toHaveCount(1);
          };
          await openThread();
          await expectThreadOpen();
          await thought.click();
          await browserExpect(thought).toHaveAttribute(
            "aria-expanded",
            "false",
          );
          await browserExpect(thoughtBody).toHaveCount(0);
          await thought.click();
          await expectSameThought();
          await release("first-tool");
          await page
            .getByText("The first command finished.", { exact: true })
            .waitFor();
          const secondDetails = page.getByTitle(
            "Show activity: Running 1 command",
            {
              exact: true,
            },
          );
          await browserExpect(secondDetails).toHaveText("Command details");
          await browserExpect(secondDetails).toHaveAccessibleName(
            "Show command details",
          );
          await secondDetails.click();
          const secondTool = page.locator(".turn-tool").filter({
            has: page
              .locator(".turn-tool-detail")
              .filter({ hasText: "Second command" }),
          });
          await secondTool.locator(".turn-tool-head").press("Enter");
          const stdout = secondTool.locator(
            'section[aria-label="Output"] > pre, section[aria-label$="output payload" i] > pre',
          );
          await browserExpect(stdout).toContainText("Second command started");
          await browserExpect(stdout).not.toContainText(
            "Second command finished",
          );
          await expectSameThought();
          await release("second-tool");
          await browserExpect(stdout).toContainText("Second command finished");
          await expectSameThought();
          const untitledNotes = page.getByRole("note", {
            name: "Thought",
            exact: true,
          });
          const unavailable =
            thinking === "claude-redacted" || thinking === "chatgpt-encrypted";
          await browserExpect(untitledNotes).toHaveCount(0);
          await release("reply");
          if (unavailable) {
            const committed = page.locator(".msg.assistant").filter({
              has: page.getByText("The unreadable step finished.", {
                exact: true,
              }),
            });
            await browserExpect(committed).toHaveAttribute(
              "data-message-offset",
              /^\d+$/,
            );
            await expectSameThought();
            await browserExpect(untitledNotes).toBeVisible();
            await untitledNotes.getByRole("button").click();
            await browserExpect(
              untitledNotes.getByText("Thinking unavailable.", { exact: true }),
            ).toBeVisible();
            await release("after-unreadable");
          } else {
            await browserExpect(untitledNotes).toBeVisible();
            await expectSameThought();
            await page.reload();
            await expectTitle(title);
            await disclosure.click();
            await openThread();
            await expectSameThought();
          }
          if (width === 390) {
            await disclosure.tap();
            await expectDisclosure(false);
          }
          await release("thinking-content");
          if (width === 390) {
            await expectTitle("Reviewing the command result");
            await expectDisclosure(false);
            await browserExpect(summary).toHaveCount(0);
            await disclosure.tap();
          }
          const expectNewThought = async () => {
            await expectTitle("Reviewing the command result");
            await browserExpect(summary).toHaveText(
              "The command finished; I am checking the result.",
            );
            await expectThreadOpen();
          };
          await expectNewThought();
          await release("finish");
          const reply = page
            .locator(".msg.assistant")
            .filter({ hasText: "Live tools finished." });
          await browserExpect(reply).toHaveAttribute(
            "data-message-offset",
            /^\d+$/,
          );
          await browserExpect(
            page.locator("#conv-status.running"),
          ).toBeVisible();
          await expectNewThought();
          await release("after-run");
          await browserExpect(
            page.locator(".live-panel-box.is-waiting"),
          ).toBeVisible();
          await browserExpect(titleLine).toHaveCount(0);
          await browserExpect(summary).toHaveCount(0);
          await release("background");
          await expectIdle(agent);
          const idleSeed = await postFixture(base, "seed-live-thinking-idle");
          idleAgent = idleSeed.agent;
          await page.goto(`${base}?direct-idle#agent=${idleAgent}`);
          await browserExpect(page.locator("#conv-title")).toHaveText(
            "Thinking before idle",
          );
          await send("Finish without background work.");
          await expectTitle("Checking before idle");
          await browserExpect(
            page.locator("#conv-status.running"),
          ).toBeVisible();
          await bar.locator(".live-thinking-copy").click();
          await browserExpect(summary).toHaveText(
            "I will finish without background work.",
          );
          await browserExpect(bar.locator(".shell-chip")).toHaveCount(0);
          await release("idle-finish", idleAgent);
          await page
            .getByText("Finished without background work.", { exact: true })
            .waitFor();
          await expectIdle(idleAgent);
          await browserExpect(page.locator(".live-panel-box")).toHaveCount(0);
          await browserExpect(titleLine).toHaveCount(0);
          await browserExpect(summary).toHaveCount(0);
          expect(errors).toEqual([]);
        } finally {
          try {
            await Promise.all(
              [agent, idleAgent]
                .filter(Boolean)
                .map((cid) =>
                  postFixture(base, "durable-thinking-cleanup", { agent: cid }),
                ),
            );
          } finally {
            await page.close();
          }
        }
      }
    }
  }
};

// Regression: #3536 a committed unreadable-only thought shows Waiting, even after reload.
const test_unreadable_thinking_waits_after_commit_and_reload: BrowserTest =
  async (browser, base) => {
    const { agent } = await postFixture(base, "seed-live-thinking-idle", {
      redacted: true,
    });
    const page = await browser.newPage();
    try {
      await page.goto(`${base}#agent=${agent}`);
      await page.locator("#input").fill("Finish without background work.");
      await page.locator("#send").click();
      const committed = page.locator(".msg.assistant").filter({
        has: page.getByText("The unreadable step finished.", { exact: true }),
      });
      const waiting = async () => {
        await browserExpect(committed).toHaveAttribute(
          "data-message-offset",
          /^\d+$/,
        );
        await browserExpect(page.locator("#conv-status.running")).toBeVisible();
        await browserExpect(
          page.locator("#live-bar .live-thinking-title"),
        ).toHaveText("Waiting");
      };
      await waiting();
      await page.reload();
      await waiting();
    } finally {
      try {
        await postFixture(base, "durable-thinking-cleanup", { agent });
      } finally {
        await page.close();
      }
    }
  };

export const tests: BrowserTest[] = [
  withThinkingCleanup(
    // Regression: #2274 thinking stays readable across tool commit (also #2357 expanded thinking remains whole in page flow.; #2357 collapsed handover must fetch stored prose, not keep reading offset=-1.; #2357 expanded groups must not duplicate running summaries.)
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
          offsets.push(
            Number(new URL(request.url()).searchParams.get("offset")),
          );
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
        await page.locator(".turn-series-toggle").first().waitFor();
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
      await page
        .locator("#input")
        .fill("Replay the recorded streaming thought.");
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
      await page.waitForFunction(
        (text) =>
          document
            .querySelector<HTMLElement>(".live-thinking-summary")
            ?.innerText.replace(/\s+/g, " ")
            .trim() === text,
        recordedThinking.thinking.replace(/\s+/g, " ").trim(),
      );
      await sample("collapsed-live");
      await openGroup();
      await sample("expanded-live");
      await page.locator(".activity-group-hide").first().click();
      const readsBeforeCommit = offsets.length;
      await postFixture(base, "release", { agent, gate: "commit" });
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
        await summary.evaluate(
          (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
        ),
      ).toBeLessThanOrEqual(1);
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
      await summary
        .getByText("Now running the sample command.", { exact: false })
        .waitFor();
      await sample("expanded-committed");
      expect(storedReadWhileCollapsed).toBeTrue();
      expect(samples).toEqual([
        { state: "collapsed-live", thoughts: 1, running: 0, completed: 0 },
        { state: "expanded-live", thoughts: 1, running: 0, completed: 0 },
        { state: "collapsed-committed", thoughts: 1, running: 1, completed: 0 },
        { state: "expanded-committed", thoughts: 2, running: 1, completed: 0 },
      ]);
      expect(await thought.getAttribute("aria-expanded")).toBe("true");
      expect((await body.innerText()).trim()).toBe(
        recordedThinking.thinking.replace(/\s+/g, " "),
      );
      expect((await summary.innerText()).trim()).toBe(
        recordedThinking.thinking.trim(),
      );
      expect(await page.locator("#conv-status.running").count()).toBe(1);
      await postFixture(base, "release", { agent, gate: "reply" });
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
  ),

  // Regression: #2423 a failed thinking case must not leave a working agent for the next case.
  async function test_failed_thinking_case_leaves_no_working_agent(
    browser,
    base,
    data,
    serverPid,
  ) {
    const page = await browser.newPage();
    const failing = withThinkingCleanup(async () => {
      await postFixture(base, "seed-durable-thinking", {
        agent: "durable-thinking-failure",
      });
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
  test_last_thinking_survives_wait_and_reload,
  test_unreadable_thinking_waits_after_commit_and_reload,
];
