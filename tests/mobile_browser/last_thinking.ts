import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { captureErrors, postFixture, type BrowserTest } from "./common";

// Regression: #3518 keep the latest thought and its disclosure through tools, replies and the end of a run.
export const test_last_thinking_survives_wait_and_reload: BrowserTest = async (
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
            browserExpect
              .poll(() =>
                disclosure.evaluate((button) => {
                  const bounds = button
                    .querySelector(".disclosure-caret path")
                    ?.getBoundingClientRect();
                  if (!bounds?.width || !bounds.height) return null;
                  return [
                    button.getAttribute("aria-expanded"),
                    bounds.width > bounds.height,
                  ];
                }),
              )
              .toEqual([String(expanded), expanded]);
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
            await page.locator(".turn-series-toggle").first().click();
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
          await release("thinking-content");
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
export const test_unreadable_thinking_waits_after_commit_and_reload: BrowserTest =
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
