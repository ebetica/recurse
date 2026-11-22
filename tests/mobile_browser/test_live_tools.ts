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
        await page.goto(`${base}#agent=${agent}`);
        await page.locator("#input").fill("Check the sample output.");
        await page.locator("#send").click();
        const bar = page.locator("#live-bar .live-panel");
        const line = bar.locator(".live-thinking-title");
        const copy = bar.locator(".live-thinking-copy");
        const summary = bar.locator(".live-thinking-summary");
        const toolStatus = bar.locator(".live-tool-status");
        const group = page.locator(".activity-group-toggle");
        const thought = page
          .locator(".turn-thinking")
          .filter({ hasText: title });
        const tap = async (control: Locator) => {
          if (!phone) return control.click();
          await expectHitCorners(control);
          await checkedTap(control);
        };
        const expectAlongside = async () => {
          const running = phone ? "running 2 commands" : "running 1 command";
          await browserExpect(
            bar.filter({ has: page.getByText(title, { exact: true }) }).filter({
              has: page.getByRole("button", {
                name: new RegExp(`^${running}$`, "i"),
              }),
            }),
          ).toBeVisible();
          await expectHitCorners(toolStatus, phone ? 44 : 36);
        };
        await browserExpect(line).toHaveText("Thinking");
        await release("thinking-start");
        await browserExpect(line).toHaveText(title);
        await browserExpect(bar.locator(".live-thinking-head")).toContainText(
          "Thinking ·",
        );
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
          await expectAlongside();
          const shellChip = bar.locator(".shell-chip");
          const agentChip = bar.locator(".agent-chip");
          await browserExpect(shellChip).toBeVisible();
          await browserExpect(agentChip).toBeVisible();
          await expectHitCorners(shellChip);
          await expectHitCorners(agentChip);
          await page.setViewportSize({ width, height: 800 });
        }
        await expectAlongside();
        await group.click();
        const thoughtToggle = thought.getByRole("button", {
          name: /^Thought for \d+s · I found the sample/,
        });
        await tap(thoughtToggle);
        await browserExpect(thoughtToggle).toHaveAttribute(
          "aria-expanded",
          "false",
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
        await tap(toolStatus);
        await browserExpect(bar.locator(".live-tool-body")).toBeVisible();
        await browserExpect(summary).toHaveText(detail);
        await tap(toolStatus);
        await browserExpect(bar.locator(".live-tool-body")).toHaveCount(0);
        await tap(copy);
        await writeFile(commandGate, "ready");
        await browserExpect(toolStatus).toHaveCount(0);
        await browserExpect(bar.locator(".live-thinking-head")).toContainText(
          "Waiting ·",
        );
        await browserExpect(line).toHaveText(title);
        await browserExpect(page.locator("#send.stop")).toBeVisible();
        await release();
        await page
          .getByText("The sample output is ready.", { exact: true })
          .waitFor();
        if (child)
          await browserExpect(
            bar.locator(".is-waiting .live-label"),
          ).toHaveText("Waiting…");
        else await browserExpect(bar).toHaveCount(0);
        await browserExpect(line).toHaveCount(0);
        await page.reload();
        await group.click();
        await tap(thoughtToggle);
        await browserExpect(thought.locator(".turn-thinking-body")).toHaveText(
          `${title} ${detail}`,
          { useInnerText: true },
        );
      } finally {
        await Promise.all(
          [commandGate, backgroundGate].map((path) => writeFile(path, "ready")),
        );
        if (child)
          await postFixture(base, "durable-thinking-cleanup", { agent: child });
        for (const gate of ["thinking-start", "thinking-tool", undefined])
          await release(gate);
        await page.close();
      }
    }
  },
  // Regression: #3563 #3565 #3566 #3569 the bar stays joined, empty details stay closed, prose does not resize the panel, desktop controls stay visible, and only an active turn marks the card.
  async function test_thinking_and_waiting_stay_in_composer(browser, base) {
    const screenshots = process.env.LIVE_PANEL_SCREENSHOTS;
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
      const { agent } = await postFixture(base, "seed-live-thinking-idle", {
        long: true,
      });
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
        const panel = page.locator(".live-panel-box");
        const toggle = panel.getByRole("button", {
          name: /Checking sample output/,
        });
        const summary = panel.locator(".live-thinking-summary");
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
            "live bar touches the composer",
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
        const label = panel.locator(".live-label");
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
  // Regression: #2779 truncated titles retain trailing spaces regardless of TMPDIR length. (also Feature #2335 expanded tools need full commands and latest streamed output.; #2343 runtime precedes long commands; visible bar owns running counts.; #2411 latest shell output waits for the initial live panel checks.; #2343 the visible bar owns the running count, not the turn summary.)
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
      try {
        ({ agent, outputGate } = await (
          await post("__browser-test/seed-live-tools", { mode })
        ).json());
        await page.goto(`${base}#agent=${agent}`);
        await page.locator("#composer").waitFor();
        await post(`api/conversations/${agent}/deliver`, {
          content: "Run tools.",
        });
        const bar = page.locator(".working .live-label");
        await bar.filter({ hasText: "Running" }).waitFor();
        await bar.click();
        const body = page.locator(".live-tool-body");
        await body.waitFor();
        const rows = body.locator(".live-tool-row");
        expect(await rows.count()).toBe(mode === "many-output" ? 3 : 1);
        expect(
          await page
            .locator(".turn-summary")
            .filter({ hasText: /[Rr]unning \d+ command/ })
            .count(),
        ).toBe(0);
        const title = await bar.locator(".live-thinking-title").textContent();
        expect(title).toBe(
          mode === "many-output"
            ? "Running 3 commands"
            : mode === "secret-output"
              ? "Running command"
              : `Running ${(await rows.first().locator("code").innerText()).slice(0, 2000)}`,
        );
        expect(title).not.toMatch(/\b(?:Ran|Preparing|Thinking)\b/);
        expect(await rows.locator('[role="timer"]').count()).toBe(
          await rows.count(),
        );
        if (mode !== "secret-output") {
          await rows.first().locator("pre").waitFor();
          expect(await rows.first().locator("pre").innerText()).not.toContain(
            "latest-",
          );
        }
        await writeFile(outputGate, "ready");
        if (mode !== "secret-output") {
          expect(await rows.first().locator("code").innerText()).toEndWith(
            "END_OF_COMMAND",
          );
          expect(
            (await rows.first().locator("code").innerText()).length,
          ).toBeGreaterThan(2000);
          await rows
            .first()
            .locator("pre")
            .filter({
              hasText: mode === "background-output" ? "latest-1" : "latest-0",
            })
            .waitFor();
          const tail = await rows.first().locator("pre").innerText();
          expect(tail.trim().split("\n").length).toBeLessThanOrEqual(5);
          expect(tail).not.toContain("line-1\n");
          await rows.first().locator("pre").click();
          await page.evaluate(() => {
            const doc = (globalThis as any).document;
            const range = doc.createRange();
            range.selectNodeContents(doc.querySelector(".live-tool-row pre"));
            doc.getSelection().removeAllRanges();
            doc.getSelection().addRange(range);
          });
          expect(
            await page.evaluate(() =>
              (globalThis as any).getSelection().toString(),
            ),
          ).toContain("latest-");
          expect(await bar.getAttribute("aria-expanded")).toBe("true");
        } else {
          await body.getByText("Output withheld", { exact: true }).waitFor();
          expect(await body.innerText()).not.toContain("sk-example");
          expect(await bar.getAttribute("title")).not.toContain("sk-example");
          expect(await body.locator("code").innerText()).toBe(
            "Command withheld",
          );
        }
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({
            path: `${shots}/live-tools-${width}-${mode}-expanded.png`,
          });
        if (mode === "background-output") {
          expect(await page.locator(".turn-summary").allInnerTexts()).toContain(
            "Ran 1 command",
          );
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
        await bar.click();
        await body.waitFor({ state: "hidden" });
        expect(
          (await page.locator(".live-panel-box").boundingBox())!.height,
        ).toBe(34);
        expect(errors).toEqual([]);
      } finally {
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
