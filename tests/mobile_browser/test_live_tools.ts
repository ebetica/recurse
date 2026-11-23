import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { expect as browserExpect, type Locator } from "playwright/test";
import {
  captureErrors,
  checkedTap,
  expectHitCorners,
  postFixture,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3617 streamed thinking stays visible with running tools and clears when the turn ends.
  async function test_thinking_stays_visible_with_running_tools(browser, base) {
    const title =
      "I found the sample in the second results file. I’ll check its output against the reference before reporting any differences.";
    const detail = "I’ll compare the fields in the same order.";
    for (const width of [412, 1280]) {
      const phone = width === 412;
      const page = await browser.newPage({
        viewport: { width, height: 800 },
        isMobile: phone,
        hasTouch: phone,
      });
      const { agent, commandGate, backgroundGate } = await postFixture(
        base,
        "seed-sticky-thinking",
        { crowded: phone },
      );
      let child: string | undefined;
      const release = (gate?: string) =>
        postFixture(base, "release", { agent, gate });
      try {
        await page.clock.install();
        await page.goto(`${base}#agent=${agent}`);
        await page.locator("#input").fill("Check the sample output.");
        await page.locator("#send").click();
        const bar = page.locator("#status-bar .status-bar");
        const line = bar.locator(".status-bar-thinking-title");
        const copy = bar.locator(".status-bar-thinking-copy");
        const summary = bar.locator(".status-bar-thinking-summary");
        const group = page.locator(".activity-group-toggle");
        const thought = page.locator(".turn-thinking");
        const thoughtToggle = thought.getByRole("button");
        const tap = async (control: Locator) => {
          if (!phone) return control.click();
          await expectHitCorners(control);
          await checkedTap(control);
        };
        const expectToolsInTranscript = async () => {
          await page.clock.fastForward(3_000);
          await browserExpect(bar).not.toContainText(
            /running \d+ (?:commands?|tools?)/i,
          );
          await browserExpect(bar.getByRole("button")).toHaveCount(
            phone ? 3 : 1,
          );
          await browserExpect(line).toHaveText(title);
          await browserExpect(group).toContainText(/running \d+ commands?/i);
        };
        await browserExpect(line).toHaveText("Thinking");
        await release("thinking-start");
        await browserExpect(line).toHaveText(title);
        await browserExpect(
          bar.locator(".status-bar-thinking-head"),
        ).toContainText("Thinking ·");
        await tap(copy);
        await browserExpect(summary).toHaveText(detail);
        await tap(copy);
        await release("thinking-tool");
        await page
          .getByText("I’ve checked the source file.", { exact: true })
          .waitFor();
        if (phone) {
          ({ agent: child } = await postFixture(base, "seed-live-tools", {
            parent: agent,
          }));
          const delivery = await page.request.post(
            `${base}api/conversations/${child}/deliver`,
            {
              data: { content: "Check the reference." },
            },
          );
          expect(delivery.ok()).toBeTrue();
          await page.setViewportSize({ width: 320, height: 800 });
          const shellChip = bar.locator(".shell-chip");
          const agentChip = bar.locator(".agent-chip");
          await browserExpect(shellChip).toBeVisible();
          await browserExpect(agentChip).toBeVisible();
          await expectToolsInTranscript();
          await expectHitCorners(shellChip);
          await expectHitCorners(agentChip);
          await page.setViewportSize({ width, height: 800 });
        } else {
          await expectToolsInTranscript();
        }
        await group.click();
        await tap(thoughtToggle);
        await browserExpect(thoughtToggle).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        await browserExpect(thoughtToggle).toHaveText(/^Thought for \d+s$/, {
          useInnerText: true,
        });
        await browserExpect(thoughtToggle).toHaveAccessibleName(
          /^Thought for \d+s$/,
        );
        await browserExpect(thought.locator(".turn-thinking-body")).toHaveCount(
          0,
        );
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots) {
          await waitForLayout(page);
          await page.mouse.move(0, 0);
          await page.screenshot({
            path: `${shots}/summarized-thinking-${width}.png`,
            animations: "disabled",
          });
        }
        await tap(copy);
        await browserExpect(summary).toHaveText(detail);
        await tap(copy);
        await writeFile(commandGate, "ready");
        await browserExpect(
          bar.locator(".status-bar-thinking-head"),
        ).toContainText("Waiting ·");
        await browserExpect(line).toHaveText(title);
        await browserExpect(page.locator("#send.stop")).toBeVisible();
        await release();
        await page
          .getByText("The sample output is ready.", { exact: true })
          .waitFor();
        if (child)
          await browserExpect(
            bar.locator(".is-waiting .status-bar-label"),
          ).toHaveText("Waiting…");
        else await browserExpect(bar).toHaveCount(0);
        await browserExpect(line).toHaveCount(0);
        const conversationUrl = `${base}api/conversations/${agent}`;
        const rows = `${conversationUrl}/view?**`;
        let holdRows = false;
        let gateReleased = false;
        if (!phone) {
          await page.route(`${conversationUrl}/events?**`, (route) =>
            route.abort(),
          );
          await page.route(rows, async (route) => {
            if (gateReleased) return route.continue();
            if (holdRows) return route.abort();
            const response = await route.fetch();
            if (holdRows) return route.abort();
            return route.fulfill({ response });
          });
        }
        await page.reload();
        await group.click();
        await tap(thoughtToggle);
        await browserExpect(thought.locator(".turn-thinking-body")).toHaveText(
          `${title} ${detail}`,
          { useInnerText: true },
        );
        if (!phone) {
          holdRows = true;
          await page.locator("#input").fill("Check another sample.");
          const admitted = page.waitForResponse(async (response) => {
            if (
              !response.url().startsWith(`${conversationUrl}?`) ||
              !response.ok()
            )
              return false;
            const state = (await response.json()) as {
              active_run_start?: number | null;
            };
            return state.active_run_start != null;
          });
          await Promise.all([admitted, page.locator("#send").click()]);
          await browserExpect(line).toHaveText("Starting agent…");
          await browserExpect(page.locator(".status-bar")).toHaveCount(1);
          await browserExpect(
            page.locator("#messages .status-bar"),
          ).toHaveCount(0);
          await browserExpect(thoughtToggle).toHaveAccessibleName(
            /^Thought for \d+s$/,
          );
          holdRows = false;
          gateReleased = true;
          await release("accept-next");
          await browserExpect(line).toHaveText("Thinking");
          await browserExpect(page.locator(".status-bar")).toHaveCount(1);
          await release("next-turn");
          await page.getByText("Checked again.", { exact: true }).waitFor();
        }
      } finally {
        await Promise.all(
          [commandGate, backgroundGate].map((path) => writeFile(path, "ready")),
        );
        if (child)
          await postFixture(base, "durable-thinking-cleanup", { agent: child });
        for (const gate of [
          "thinking-start",
          "thinking-tool",
          undefined,
          "accept-next",
          "next-turn",
        ])
          await release(gate);
        if (!phone) await page.unrouteAll({ behavior: "wait" });
        await page.close();
      }
    }
  },
  // Regression: #3563 #3565 #3566 #3569 the bar stays joined, empty details stay closed, prose does not resize the panel, desktop controls stay visible, and only an active turn marks the card.
  async function test_thinking_and_waiting_stay_in_composer(browser, base) {
    const screenshots = process.env.STATUS_BAR_SCREENSHOTS;
    const phoneWidth = screenshots ? 412 : 390;
    for (const [width, appearance] of [
      [phoneWidth, "dark"],
      [phoneWidth, "light"],
      [1280, "dark"],
      [1280, "light"],
    ] as const) {
      const phone = width === phoneWidth;
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: phone,
        hasTouch: phone,
      });
      const { agent } = await postFixture(
        base,
        "seed-status-bar-thinking-idle",
        {
          long: true,
        },
      );
      const release = (gate: string) =>
        postFixture(base, "release", { agent, gate });
      try {
        const theme = await page.request.post(`${base}api/settings/theme`, {
          data: { theme: "Tokyo Night", appearance },
        });
        expect(theme.ok()).toBeTrue();
        await page.goto(`${base}#agent=${agent}`);
        const input = page.locator("#input");
        const runningCard = page.locator("#composer-card[data-turn-running]");
        await input.fill("Check the sample output.");
        const send = page.locator("#send");
        if (phone) await checkedTap(send);
        else await send.click();
        const panel = page.locator(".status-bar-box");
        const toggle = panel.getByRole("button", {
          name: /Checking sample output/,
        });
        const summary = panel.locator(".status-bar-thinking-summary");
        const expectJoined = async () => {
          await waitForLayout(page);
          const barBottom = await panel.evaluate(
            (el) => el.getBoundingClientRect().bottom,
          );
          const boxTop = await page
            .locator("#composer")
            .evaluate((el) => el.getBoundingClientRect().top);
          expect(
            Math.abs(boxTop - barBottom),
            "status bar touches the composer",
          ).toBeLessThanOrEqual(1);
        };
        const screenshot = async (mode: string) => {
          if (screenshots) {
            await waitForLayout(page);
            await page.screenshot({
              path: `${screenshots}/${width}-${appearance}-${mode}.png`,
              animations: "disabled",
            });
          }
        };
        const label = panel.locator(".status-bar-label");
        const expectStatusOnly = async () => {
          await browserExpect(label).toBeVisible();
          const ariaExpanded = await label.getAttribute("aria-expanded");
          if (phone) await label.tap();
          else await label.click();
          await browserExpect(summary).toHaveCount(0);
          await browserExpect(panel).not.toContainText(
            "No additional thinking.",
          );
          expect(ariaExpanded).toBeNull();
        };
        await page
          .getByText("I will compare the samples.", { exact: true })
          .waitFor();
        await expectStatusOnly();
        await screenshot("no-thinking");
        const details = page.waitForResponse((response) =>
          response.url().includes("/thinking?"),
        );
        await release("thinking-title");
        await (await details).finished();
        await browserExpect(label).toContainText("Checking");
        await expectStatusOnly();
        const interrupted = page.waitForEvent("requestfailed", (request) =>
          request.url().includes("/thinking?"),
        );
        await page.route(
          /\/thinking\?/,
          (route) => route.abort("connectionreset"),
          { times: 1 },
        );
        await interrupted;
        await release("thinking-title-tail");
        await browserExpect(label).toContainText("Checking sample output");
        await expectStatusOnly();
        await release("thinking-short");
        await toggle.waitFor();
        await browserExpect(runningCard).toHaveCount(1);
        await expectJoined();
        if (phone) {
          await checkedTap(input);
          await browserExpect(input).toBeFocused();
          for (const selector of ["#attach", "#model-trigger", "#send.stop"])
            await expectHitCorners(page.locator(selector));
          const border = () =>
            runningCard.evaluate((card) => ({
              running: card
                .getAnimations({ subtree: true })
                .some(
                  ({ effect, playState }) =>
                    playState === "running" &&
                    effect instanceof KeyframeEffect &&
                    effect.target === card,
                ),
              color: getComputedStyle(card, "::after").backgroundColor,
            }));
          expect(
            (await border()).running,
            "focused border animates",
          ).toBeTrue();
          await page.emulateMedia({ reducedMotion: "reduce" });
          const reduced = await border();
          expect(
            reduced.running,
            "reduced-motion border stays still",
          ).toBeFalse();
          expect(reduced.color).not.toBe("rgba(0, 0, 0, 0)");
          await page.emulateMedia({ reducedMotion: "no-preference" });
        }
        if (!phone) {
          await input.blur();
          for (const selector of ["#attach", "#model-trigger", "#send.stop"])
            await visibleAndUncovered(page, selector);
          const composer = page.locator("#composer");
          const card = await composer.boundingBox();
          await input.focus();
          expect(await composer.boundingBox()).toEqual(card);
        }
        if (phone) await checkedTap(toggle);
        else await toggle.click();
        await browserExpect(toggle).toHaveAttribute("aria-expanded", "true");
        await browserExpect(toggle.locator("svg")).toHaveCount(0);
        await browserExpect(panel.locator(".live-dot")).toHaveCount(0);
        await browserExpect(summary).toHaveText(
          "I will check the source and keep the output available for comparison.",
        );
        const geometry = () =>
          summary.evaluate((body) => {
            const style = getComputedStyle(body);
            return {
              panel: body.parentElement!.getBoundingClientRect().toJSON(),
              composer: document
                .querySelector("#composer")!
                .getBoundingClientRect()
                .toJSON(),
              gutter:
                (body as HTMLElement).offsetWidth -
                body.clientWidth -
                parseFloat(style.borderLeftWidth) -
                parseFloat(style.borderRightWidth),
              contentWidth:
                body.clientWidth -
                parseFloat(style.paddingInlineStart) -
                parseFloat(style.paddingInlineEnd),
            };
          });
        await waitForLayout(page);
        const shortGeometry = await geometry();
        expect(await summary.evaluate((body) => body.scrollHeight)).toBe(
          await summary.evaluate((body) => body.clientHeight),
        );
        await screenshot("short");
        await release("thinking-overflow");
        await browserExpect(summary).toContainText("one more set of records");
        const scroll = () =>
          summary.evaluate((body) => ({
            fromBottom: body.scrollHeight - body.clientHeight - body.scrollTop,
            top: body.scrollTop,
            lines:
              body.clientHeight / parseFloat(getComputedStyle(body).lineHeight),
          }));
        const first = await scroll();
        expect(first.lines).toBeCloseTo(6, 0);
        expect(first.top).toBeGreaterThan(0);
        expect(first.fromBottom).toBeLessThanOrEqual(1);
        expect(await geometry()).toEqual(shortGeometry);
        if (!phone)
          expect(
            shortGeometry.gutter,
            "desktop gutter before overflow",
          ).toBeGreaterThan(0);
        await screenshot("overflow");
        await release("thinking-content");
        await browserExpect(summary).toContainText(
          "records that crossed the boundary",
        );
        const appended = await scroll();
        expect(appended.top).toBeGreaterThan(first.top);
        expect(appended.fromBottom).toBeLessThanOrEqual(1);
        expect(await geometry()).toEqual(shortGeometry);
        if (phone) {
          await summary.hover();
          await page.mouse.wheel(0, -appended.top);
        } else {
          await toggle.press("Enter");
          await browserExpect(summary).toHaveCount(0);
          await toggle.press("Enter");
          const clearance = await toggle.evaluate((button) => {
            const style = getComputedStyle(button);
            const frame = button.getBoundingClientRect();
            const offset = parseFloat(style.outlineOffset);
            if (!parseFloat(style.outlineWidth)) return -Infinity;
            const walker = document.createTreeWalker(
              button,
              NodeFilter.SHOW_TEXT,
            );
            const range = document.createRange();
            const gaps: number[] = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent?.trim()) continue;
              range.selectNodeContents(node);
              const text = range.getBoundingClientRect();
              gaps.push(
                text.left - frame.left + offset,
                frame.right - text.right + offset,
                text.top - frame.top + offset,
                frame.bottom - text.bottom + offset,
              );
            }
            return gaps.length ? Math.min(...gaps) : -Infinity;
          });
          expect(
            clearance,
            "keyboard outline clears the header text",
          ).toBeGreaterThan(0);
          await page.keyboard.press("Tab");
          await browserExpect(summary).toBeFocused();
          await page.keyboard.press("Home");
        }
        await browserExpect.poll(async () => (await scroll()).top).toBe(0);
        await release("thinking-tail");
        await browserExpect(summary).toContainText("all records are present.");
        expect(await summary.textContent()).toMatch(
          /^I will check the source[\s\S]+all records are present\.$/,
        );
        expect((await scroll()).top).toBe(0);
        if (phone) await page.setViewportSize({ width, height: 540 });
        if (phone) await checkedTap(input);
        else await input.click();
        await browserExpect(input).toBeFocused();
        if (phone) {
          await input.evaluate((field) =>
            field.addEventListener(
              "blur",
              () => {
                field.dataset.blurred = "true";
              },
              { once: true },
            ),
          );
          for (const expanded of [false, true]) {
            await checkedTap(toggle);
            await browserExpect(toggle).toHaveAttribute(
              "aria-expanded",
              String(expanded),
            );
            await browserExpect(
              input,
              "live disclosure keeps the caret",
            ).toBeFocused();
          }
          expect(await input.getAttribute("data-blurred")).toBeNull();
        }
        await browserExpect(panel.locator(".shell-chip")).toBeVisible();
        await expectJoined();
        await browserExpect(label).toContainText("Waiting");
        await browserExpect(
          runningCard,
          "turn still active while Waiting",
        ).toHaveCount(1);
        const beforeReplacement = await geometry();
        await release("idle-finish");
        await browserExpect(summary).toHaveText("The samples agree.");
        await browserExpect(label).toHaveAttribute("aria-expanded", "true");
        expect(await geometry()).toEqual(beforeReplacement);
        await release("thinking-replaced");
        await page
          .getByText("Sample output checked.", { exact: true })
          .waitFor();
        await panel.and(page.locator(".is-waiting")).waitFor();
        await browserExpect(label).toHaveText("Waiting…");
        await browserExpect(summary).toHaveCount(0);
        await browserExpect(
          runningCard,
          "only background work remains",
        ).toHaveCount(0);
        await browserExpect(input).toBeFocused();
        await expectJoined();
      } finally {
        await postFixture(base, "durable-thinking-cleanup", { agent });
        await page.close();
      }
    }
  },
  // Regression: #2854 folded summaries omitted nested script writes and commands, including calls past the display cap. (also Regression #2341 script labels and expanded read diagnostics exposed internal wording.)
  async function test_script_labels_and_plain_read_diagnostics(browser, base) {
    const page = await browser.newPage();
    let agent = "";
    try {
      ({ agent } = await (
        await page.request.post(
          `${base}__browser-test/seed-script-read-diagnostics`,
        )
      ).json());
      await page.goto(`${base}#agent=${agent}`);
      await page.locator("#composer").waitFor();
      await page.request.post(`${base}api/conversations/${agent}/deliver`, {
        data: { content: "Read the file and run scripts." },
      });
      await page
        .getByText("Script and read finished.", { exact: true })
        .waitFor();
      const group = page.locator(".activity-group-toggle").first();
      expect(await group.innerText()).toContain("ran 2 commands");
      expect(await group.innerText()).toContain("Wrote 1 file");
      expect(await group.innerText()).toContain("used 102 other tools");
      await group.click();
      const series = page.locator(".turn-series-toggle").first();
      expect(await series.innerText()).toContain("ran 2 commands");
      expect(await series.innerText()).toContain("Wrote 1 file");
      expect(await series.innerText()).toContain("used 102 other tools");
      await series.click();
      const read = page
        .locator(".turn-tool", {
          has: page.locator(".turn-tool-head", { hasText: "Read" }),
        })
        .first();
      await read.locator(".turn-tool-head").click();
      await browserExpect(
        read.locator('.tool-payload[aria-label="Full arguments"] pre'),
      ).toContainText("café-🌱.txt");
      await read
        .locator(".tool-payload")
        .filter({ hasText: "more lines" })
        .waitFor();
      const visible = await read.innerText();
      expect(visible).not.toContain("<harness>");
      expect(visible).not.toContain("[info]");
      const scripts = page.locator(".turn-tool-name", {
        hasText: "Ran a script",
      });
      await scripts.first().waitFor();
      expect(await scripts.allTextContents()).toEqual([
        "Ran a script · 101 probe/echo, 2 bash, +1 more",
        "Ran a script",
      ]);
    } finally {
      try {
        const cleanup = await page.request.post(
          `${base}__browser-test/clear-script-read-diagnostics`,
          { data: { agent } },
        );
        expect(cleanup.ok()).toBeTrue();
      } finally {
        await page.close();
      }
    }
  },
  // Regression: #2343 runtime precedes long commands; #2411 latest shell output waits for the initial activity checks. (also Feature #2335 expanded tools need full commands and latest streamed output.)
  async function test_expanded_live_tools_show_latest_safe_output(
    browser,
    base,
  ) {
    for (const [width, mode] of [
      [412, "output"],
      [412, "many-output"],
      [412, "secret-output"],
      [412, "background-output"],
      [1280, "background-output"],
    ] as const) {
      const page = await browser.newPage({
        viewport: { width, height: 915 },
      });
      const post = (path: string, data?: object) =>
        page.request.post(`${base}${path}`, { data });
      const errors = captureErrors(page);
      let agent = "";
      let outputGate = "";
      let finishGate: string | undefined;
      let commands: string[] = [];
      const withheldCommand = async (withOutput: boolean) => {
        const response = await page.request.get(
          `${base}api/conversations/${agent}/view`,
        );
        expect(response.ok()).toBeTrue();
        const { blocks } = (await response.json()) as {
          blocks: {
            name: string | null;
            args: string;
            result: string | null;
            running?: boolean;
          }[];
        };
        return blocks.some(
          (row) =>
            row.name === "bash" &&
            row.args === "Command withheld" &&
            !row.running &&
            Boolean(row.result) === withOutput,
        );
      };
      try {
        ({ agent, outputGate, commands, finishGate } = await (
          await post("__browser-test/seed-live-tools", { mode })
        ).json());
        await page.goto(`${base}#agent=${agent}`);
        await page.locator("#composer").waitFor();
        await post(`api/conversations/${agent}/deliver`, {
          content: "Run tools.",
        });
        if (finishGate) {
          await browserExpect.poll(() => withheldCommand(false)).toBe(true);
          await postFixture(base, "release", { agent, gate: "tool-preparing" });
        }
        const bar = page.getByRole("group", {
          name: "Status bar",
          exact: true,
        });
        const count = mode === "many-output" ? 3 : 1;
        const running = new RegExp(`running ${count} commands?`, "i");
        const activity = page
          .locator(".activity-group-toggle")
          .filter({ hasText: running });
        await browserExpect(activity).toBeVisible();
        await browserExpect(bar).toBeVisible();
        await browserExpect(bar).not.toContainText(
          /running|END_OF_COMMAND|sk-example/i,
        );
        const runningLabels = page
          .locator(
            ".activity-group-summary .turn-summary:visible, .turn-series-toggle:visible",
          )
          .filter({ hasText: running });
        await browserExpect(runningLabels).toHaveCount(1);
        if (mode !== "background-output" || width === 1280) {
          const foreground = mode === "background-output" ? 1 : 0;
          if (foreground)
            await browserExpect(activity).toContainText("Ran 1 command");
          await activity.click();
          const series = page.getByTitle(
            /^Show activity: .*running \d+ command/i,
          );
          await series.click();
          await browserExpect(runningLabels).toHaveCount(1);
          await browserExpect(runningLabels).toHaveClass("turn-series-toggle");
          const rows = page.locator(".turn-series-body .turn-tool");
          const command = commands[foreground]!;
          const row = foreground
            ? rows.filter({ hasText: command })
            : rows.first();
          if (!foreground) await browserExpect(rows).toHaveCount(count);
          const toggle = row.getByRole("button");
          await toggle.press("Enter");
          const detail = row.getByRole("region", { name: "Full tool detail" });
          const output = detail.locator('section[aria-label="Output"] pre');
          await browserExpect(output).toContainText(
            "Beginning of command output",
          );
          if (mode !== "secret-output") {
            const fullCommand = detail
              .getByRole("region", { name: /Full (command|arguments)/ })
              .locator("pre");
            await fullCommand.waitFor();
            expect(await fullCommand.textContent()).toBe(command);
          }
          await writeFile(outputGate, "ready");
          if (finishGate) {
            const expectRedactedRow = async () => {
              await browserExpect(row).not.toContainText("sk-example123456789");
              await browserExpect(toggle).not.toHaveAccessibleName(
                /sk-example123456789/,
              );
              await browserExpect(
                row.locator(".turn-tool-detail"),
              ).toHaveAttribute("title", "Command withheld");
            };
            await browserExpect(output).toHaveText("Output withheld");
            await expectRedactedRow();
            await writeFile(finishGate, "ready");
            await browserExpect.poll(() => withheldCommand(true)).toBe(true);
            await expectRedactedRow();
          } else {
            const latest = `latest-${foreground}`;
            await browserExpect(output).toContainText(latest);
            await browserExpect(output).toContainText(
              "Beginning of command output",
            );
            if (foreground)
              await browserExpect(bar.locator(".shell-chip")).toBeVisible();
            if (mode === "output") {
              const position = await output.evaluate((pre, word) => {
                pre.scrollIntoView({ block: "center", behavior: "instant" });
                pre.scrollTop = pre.scrollHeight;
                const walker = document.createTreeWalker(
                  pre,
                  NodeFilter.SHOW_TEXT,
                );
                let node: Node | null;
                while ((node = walker.nextNode())) {
                  const start = node.textContent?.indexOf(word) ?? -1;
                  if (start < 0) continue;
                  const range = document.createRange();
                  range.setStart(node, start);
                  range.setEnd(node, start + word.length);
                  const text = range.getBoundingClientRect();
                  const box = pre.getBoundingClientRect();
                  return {
                    x: text.left + text.width / 2 - box.left - pre.clientLeft,
                    y: text.top + text.height / 2 - box.top - pre.clientTop,
                  };
                }
                throw new Error("Latest output text is missing");
              }, latest);
              await output.click({ position, clickCount: 3 });
              expect(
                await page.evaluate(() =>
                  window.getSelection()?.toString().trim(),
                ),
              ).toBe(latest);
              await browserExpect(toggle).toHaveAttribute(
                "aria-expanded",
                "true",
              );
            }
          }
          await browserExpect(bar).not.toContainText(
            /latest-|Output withheld/i,
          );
        } else {
          await browserExpect(activity).toContainText("Ran 1 command");
          await writeFile(outputGate, "ready");
        }
        if (mode === "background-output") {
          const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
          await page.locator(".working .shell-chip").click();
          const shell = page.locator(".shell-surface .shell-row").first();
          await shell.waitFor();
          expect(await shell.locator(".shell-command").innerText()).toEndWith(
            "END_OF_COMMAND",
          );
          const meta = shell.locator(".shell-meta");
          expect(await meta.innerText()).toMatch(/Running[\s\S]*\d+s/);
          const metaBox = (await meta.boundingBox())!;
          const list = page.locator(".shell-surface .shell-list");
          const listBox = (await list.boundingBox())!;
          expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
          expect(metaBox.y).toBeGreaterThanOrEqual(listBox.y);
          expect(metaBox.y + metaBox.height).toBeLessThanOrEqual(
            listBox.y + listBox.height,
          );
          if (shots)
            await page.screenshot({
              path: `${shots}/live-tools-${width}-background-shell.png`,
            });
          await list.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          expect(await shell.locator(".shell-command").innerText()).toEndWith(
            "END_OF_COMMAND",
          );
          if (shots)
            await page.screenshot({
              path: `${shots}/live-tools-${width}-background-shell-command-end.png`,
            });
          await page.locator(".shell-surface-close").click();
        }
        expect(errors).toEqual([]);
      } finally {
        if (outputGate) await writeFile(outputGate, "ready");
        if (finishGate) {
          await writeFile(finishGate, "ready");
          await postFixture(base, "release", { agent, gate: "tool-preparing" });
        }
        if (agent) {
          await postFixture(base, "release", { agent, gate: "reply" });
          const view = await (
            await page.request.get(`${base}api/conversations/${agent}/view`)
          ).json();
          await post(`api/conversations/${agent}/deliver`, {
            run_id: view.active_run,
          });
        }
        await page.close();
      }
    }
  },
];
