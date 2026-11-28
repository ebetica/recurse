import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { expect as browserExpect, type Locator } from "playwright/test";

declare const getComputedStyle: any;
import {
  captureErrors,
  checkedTap,
  expectHitCorners,
  gotoRoot,
  mockConversation,
  postFixture,
  screenshot,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { row } from "./fixtures";
import recorded from "./fixtures/activity-lines.json";
import thinking from "./fixtures/activity-thinking.json";

export function expectActivityRowCorners(row: Locator) {
  return expectHitCorners(row, 44, { horizontalInset: 1, verticalInset: 1 });
}

async function expectSingleSpacedActivity(rows: Locator) {
  const spacing = await rows.evaluateAll((buttons) => {
    const reply = buttons[0]!.ownerDocument.querySelector(
      ".msg.assistant > .content p",
    )!;
    const replyPitch = Number.parseFloat(getComputedStyle(reply).lineHeight);
    const measured = buttons.map((button) => ({
      row: button.getBoundingClientRect(),
      labelTop: button.lastElementChild!.getBoundingClientRect().top,
    }));
    return measured.slice(1).map(({ row, labelTop }, index) => {
      const previous = measured[index]!;
      return {
        rowGap: row.top - previous.row.bottom,
        pitchDifference: labelTop - previous.labelTop - replyPitch,
      };
    });
  });
  for (const { rowGap, pitchDifference } of spacing) {
    expect(
      Math.abs(rowGap),
      "gap between collapsed activity rows",
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(pitchDifference),
      "activity row pitch versus reply line pitch",
    ).toBeLessThanOrEqual(1);
  }
  for (const row of await rows.all()) await expectActivityRowCorners(row);
}

// Regression: #3672 expanded activity has even single-line rows on phones and desktops and folds shell completions into command details.
export const testExpandedActivityCard: BrowserTest = async (browser, base) => {
  const phone = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  };
  const page = await browser.newPage(phone);
  const desktop = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const { agent, gate } = await postFixture(base, "seed-activity-card");
  const readView = async (id: string) =>
    (
      await page.request.get(`${base}api/conversations/${id}/view?limit=100`)
    ).json();
  try {
    const wake = await postFixture(base, "seed-activity-card", {
      agentWake: true,
    });
    await page.goto(`${base}#agent=${wake.agent}`);
    await page
      .getByText("The sample results agree.", { exact: true })
      .waitFor();
    await page.locator(".activity-group-toggle").tap();
    const wakeCard = page.locator(".activity-group-body");
    const wakeRows = wakeCard.locator(
      ":scope > :is(.agent-message, .turn-thinking, .turn-series) > button",
    );
    await browserExpect(wakeRows).toHaveText([
      /^\s*Message from Sample reviewer\s*child agent\s*$/,
      /^\s*Thought for \d+s\s*$/,
      "Poked 1 agent",
    ]);
    for (const viewport of [phone.viewport, { width: 412, height: 915 }]) {
      await page.setViewportSize(viewport);
      await waitForLayout(page);
      await expectSingleSpacedActivity(wakeRows);
    }
    await page.setViewportSize(phone.viewport);
    await waitForLayout(page);
    const message = wakeRows.first();
    await checkedTap(message, { x: 1, y: 1 });
    await browserExpect(message).toHaveAttribute("aria-expanded", "true");
    await browserExpect(wakeRows.nth(1)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    const messageBody = wakeCard.locator(".agent-message-body");
    await browserExpect(messageBody).toContainText("I compared both samples.");
    expect(
      await messageBody.evaluate(
        (body) =>
          body.parentElement!.nextElementSibling!.getBoundingClientRect().top -
          body.getBoundingClientRect().bottom,
      ),
    ).toBeGreaterThan(2);
    await page.goto(`${base}#agent=${agent}`);
    await page
      .locator("#conv-title", { hasText: "Review command results" })
      .waitFor();
    await page.locator("#input").fill("Check the sample results.");
    await page.locator("#send").click();
    await browserExpect
      .poll(async () => {
        const { blocks } = await readView(agent);
        return blocks.some(
          (block: { name: string | null }) => block.name === "wait",
        );
      })
      .toBe(true);
    await writeFile(gate, "ready");
    await page
      .getByText("The sample results agree.", { exact: true })
      .waitFor();
    await page.locator(".activity-group-toggle").tap();
    await page.mouse.move(0, 0);
    await desktop.goto(`${base}#agent=${agent}`);
    await desktop.locator(".activity-group-toggle").click();
    await desktop.mouse.move(0, 0);
    for (const [screen, width] of [
      [page, 390],
      [page, 412],
      [desktop, 1280],
      [desktop, 390],
    ] as const) {
      await screen.setViewportSize({
        width,
        height: width === 1280 ? 800 : width === 412 ? 915 : 844,
      });
      await waitForLayout(screen);
      const card = screen.locator(".activity-group-body");
      const rows = card.locator(
        ":scope > .turn-thinking > button, :scope > .turn-series > button",
      );
      expect(
        await rows
          .allTextContents()
          .then((labels) => labels.map((text) => text.trim())),
      ).toEqual([
        expect.stringMatching(/^Thought for \d+s$/),
        "Ran 1 command, waited, 1 background shell finished",
        expect.stringMatching(/^Thought for \d+s$/),
        "Ran 1 command",
      ]);
      await browserExpect(
        card.getByText(/Background shell finished · /),
      ).toHaveCount(0);
      const styles = await rows.evaluateAll((buttons) =>
        buttons.map((button) => {
          const label = button.lastElementChild!;
          const range = button.ownerDocument.createRange();
          range.selectNodeContents(label);
          const { color, fontWeight } = getComputedStyle(button);
          const { lineHeight, textOverflow } = getComputedStyle(label);
          return {
            style: { color, fontWeight, lineHeight },
            lines: new Set(
              Array.from(range.getClientRects(), (rect) => rect.top),
            ).size,
            overflow: textOverflow,
          };
        }),
      );
      expect(
        styles.every((row) => row.lines === 1 && row.overflow === "ellipsis"),
      ).toBe(true);
      expect(styles.map((row) => row.style)).toEqual(
        styles.map(() => styles[0]!.style),
      );
      await expectSingleSpacedActivity(rows);
      await screenshot(screen, `activity-card-${width}`);
      await expectHitCorners(
        card.getByRole("button", { name: "Hide activity" }),
      );
    }
    const card = page.locator(".activity-group-body");
    const command = card.getByRole("button", {
      name: /Ran 1 command, waited, 1 background shell finished/,
    });
    await checkedTap(command, { x: 1, y: 1 });
    await browserExpect(command).toHaveAttribute("aria-expanded", "true");
    await browserExpect(
      card.getByText(/Background shell finished.*· exit 0 · \d+s/),
    ).toBeVisible();
    await browserExpect(card.locator("pre")).toContainText(
      "Sample comparison complete",
    );

    const isolated = await postFixture(base, "seed-activity-card", {
      isolated: true,
    });
    const isolatedPage = await browser.newPage(phone);
    try {
      await isolatedPage.goto(`${base}#agent=${isolated.agent}`);
      await isolatedPage
        .locator("#input")
        .fill("Start the background comparison.");
      await isolatedPage.locator("#send").click();
      const reply = isolatedPage.getByText(
        "The background comparison is running.",
        {
          exact: true,
        },
      );
      await reply.waitFor();
      await browserExpect
        .poll(async () => (await readView(isolated.agent)).turn_status)
        .toBe("idle");
      await writeFile(isolated.gate, "ready");
      await isolatedPage
        .getByRole("button", {
          name: /Ran 1 command, 1 background shell finished/,
        })
        .tap();
      const standalone = isolatedPage.getByRole("button", {
        name: /^Show details: Background shell finished · exit 0 · (?:\d+[hm])*\d+s/,
      });
      await browserExpect(standalone).toBeVisible();
      expect(
        await standalone
          .locator("span")
          .last()
          .evaluate((label) => {
            const range = label.ownerDocument.createRange();
            range.selectNodeContents(label);
            const style = getComputedStyle(label);
            return {
              lines: new Set(
                Array.from(range.getClientRects(), (rect) => rect.top),
              ).size,
              clipped:
                label.scrollWidth > label.clientWidth &&
                style.overflowX === "hidden",
              ellipsis: style.textOverflow === "ellipsis",
            };
          }),
      ).toEqual({ lines: 1, clipped: true, ellipsis: true });
      await expectActivityRowCorners(standalone);
      await checkedTap(standalone, { x: 1, y: 1 });
      const output = isolatedPage.locator(".shell-notice pre");
      await browserExpect(output).toBeVisible();
      await browserExpect(output).toContainText(
        "Background comparison finished",
      );
    } finally {
      await writeFile(isolated.gate, "ready");
      await isolatedPage.close();
    }
  } finally {
    await writeFile(gate, "ready");
    await Promise.all([page.close(), desktop.close()]);
  }
};

export const testRecordedActivityLines: BrowserTest = async (browser, base) => {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      const rows = (entries: typeof recorded.tools) =>
        entries.map((entry) =>
          row(entry.id, entry.role, entry.text ?? "", entry),
        );
      const thread = {
        id: "main",
        title: "Coordinator",
        parent: null,
        kind: null,
        status: "idle",
        active_run: null as string | null,
        rows: rows(recorded.tools),
      };
      let liveThinkingText = "**Drafting**\nfirst live thought";
      await mockConversation(page, base, "main", () => thread);
      await page.route(`${base}api/conversations/main/thinking?*`, (route) =>
        route.fulfill({
          json: { text: liveThinkingText, live: true },
        }),
      );
      await gotoRoot(page, base);
      const footer = page.locator(".turn-summary.total");
      await page.locator(".activity-group-summary").waitFor();
      expect(await footer.count()).toBe(0);
      expect(
        await page.locator(".activity-group-summary .turn-summary").innerText(),
      ).toBe("Ran 2 commands, waited");
      expect(await page.locator(".turn-series-summary").count()).toBe(0);
      await page.locator(".activity-group-toggle").click();
      const eye = page.locator(".activity-group-toggle");
      const series = page.locator(".turn-series-toggle");
      expect(await series.count()).toBe(1);
      expect(await series.locator("span").last().innerText()).toBe(
        "Ran 2 commands, waited",
      );
      expect(await footer.count()).toBe(0);
      expect(await page.locator(".turn-tool").count()).toBe(0);
      await series.click();
      expect(await page.locator(".turn-tool").count()).toBe(3);
      await series.click();
      expect(await page.locator(".turn-tool").count()).toBe(0);
      await series.click();
      expect(await page.locator(".turn-tool").count()).toBe(3);
      const publish = page.locator(".turn-tool").nth(1);
      await publish.locator(".turn-tool-head").click();
      expect(await publish.locator(".tool-payload").innerText()).toContain(
        recorded.tools[3].args!,
      );

      thread.status = "running";
      thread.active_run = "recorded-running";
      thread.rows = rows(recorded.running);
      await page.reload();
      await page
        .getByText(recorded.running[0].text!, { exact: true })
        .waitFor();
      await page.locator(".working").waitFor();
      expect(await footer.count()).toBe(0);
      expect(await page.locator(".turn-series-summary").count()).toBe(0);
      await page.locator(".activity-group-toggle").click();
      expect(await series.count()).toBe(1);
      expect(await series.locator("span").last().innerText()).toBe(
        "Ran 2 commands",
      );
      expect(await footer.count()).toBe(0);
      expect(await page.locator(".working").count()).toBe(1);

      thread.status = "idle";
      thread.active_run = null;
      thread.rows = [
        ...thinking.map((entry) =>
          row(entry.id, entry.role, entry.text ?? "", entry),
        ),
        row("terminal-thought", "assistant", "", {
          thinking_title: "Checking the final result",
          model_time_ms: 8000,
        }),
      ];
      await page.reload();
      await eye.click();
      expect(await series.count()).toBe(1);
      const latest = page.getByRole("button", {
        name: "Thought for 7s",
        exact: true,
      });
      await browserExpect(latest).toBeVisible();
      const terminal = page.getByRole("button", {
        name: "Thought for 8s",
        exact: true,
      });
      await browserExpect(terminal).toBeVisible();
      const unreadable = page.getByRole("button", {
        name: "Thought for 10s",
        exact: true,
      });
      await browserExpect(unreadable).toHaveCount(0);
      if (mobile) {
        await expectActivityRowCorners(latest);
        await checkedTap(latest, { x: 1, y: 1 });
      } else {
        await latest.press("Enter");
      }
      await browserExpect(latest).toHaveAttribute("aria-expanded", "true");
      await browserExpect(series).toHaveAttribute("aria-expanded", "false");
      await browserExpect(page.locator(".turn-tool")).toHaveCount(0);
      await series.click();
      await browserExpect(page.locator(".turn-thinking")).toHaveCount(4);
      await browserExpect(unreadable).toBeVisible();
      await browserExpect(terminal).toBeVisible();
      await browserExpect(latest).toHaveAttribute("aria-expanded", "true");
      await series.click();
      await browserExpect(page.locator(".turn-thinking")).toHaveCount(2);
      await browserExpect(latest).toHaveAttribute("aria-expanded", "true");
      expect(await footer.count()).toBe(0);
      await series.click();
      expect(await page.locator(".turn-tool-name").allTextContents()).toEqual([
        "Wait",
        "Wait",
        "Read",
        "Search",
        "Update",
      ]);
      expect(await page.locator(".turn-tool").nth(2).innerText()).toContain(
        "sample.ts",
      );
      expect(await page.locator(".turn-tool").nth(3).innerText()).toContain(
        "sample-output",
      );
      expect(
        await page
          .locator(".turn-series .turn-thinking")
          .evaluateAll((elements: any[]) =>
            elements.map((element) => ({
              heading: element
                .querySelector(".turn-thinking-line")
                .textContent.trim(),
              nextTool:
                element.nextElementSibling.querySelector(".turn-tool-name")
                  .textContent,
            })),
          ),
      ).toEqual([
        { heading: "Thought for 6s", nextTool: "Wait" },
        { heading: "Thought for 7s", nextTool: "Search" },
        { heading: "Thought for 10s", nextTool: "Update" },
      ]);
      thread.status = "running";
      thread.active_run = "live-run";
      thread.rows = [
        row("live-user", "user", "continue"),
        row("prior-call", "tool", "", {
          kind: "tool_call",
          name: "wait",
          stat: { kind: "other" },
        }),
        row("live-step", "assistant", "", {
          live: true,
          thinking_title: "Drafting",
          has_thinking: true,
          live_thinking: true,
          thinking_elapsed_ms: 4200,
        }),
      ];
      await page.reload();
      const statusBar = page.locator(".status-bar-box");
      await statusBar.waitFor();
      expect(await statusBar.innerText()).toContain("Drafting");
      expect(
        (
          await statusBar.locator(".status-bar-thinking-head").innerText()
        ).startsWith("Thinking ·"),
      ).toBeTrue();
      thread.rows.at(-1)!.thinking_title = "Analyzing settings and artifacts";
      await page.reload();
      await statusBar.waitFor();
      expect(
        await statusBar.locator(".status-bar-thinking-title").innerText(),
      ).toBe("Analyzing settings and artifacts");
      const pillLayout = await statusBar.evaluate((element) => {
        const title = element.querySelector(".status-bar-thinking-title")!;
        const elapsed = element.querySelector(".thinking-elapsed")!;
        const style = getComputedStyle(element);
        const innerRight =
          element.getBoundingClientRect().right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        return {
          rightGap: innerRight - elapsed.getBoundingClientRect().right,
          titleWidth: title.clientWidth,
          titleContentWidth: title.scrollWidth,
        };
      });
      expect(pillLayout.rightGap).toBeGreaterThanOrEqual(0);
      expect(pillLayout.rightGap).toBeLessThanOrEqual(16);
      expect(pillLayout.titleContentWidth).toBeLessThanOrEqual(
        pillLayout.titleWidth,
      );
      thread.rows.at(-1)!.thinking_title = "Drafting";
      await page.reload();
      await statusBar.waitFor();
      expect(await page.locator(".status-bar-thinking-summary").count()).toBe(
        0,
      );
      await statusBar.locator(".status-bar-thinking-copy").click();
      const liveSummary = page.locator(".status-bar-thinking-summary");
      await browserExpect(liveSummary).toBeVisible();
      await browserExpect
        .poll(() => liveSummary.innerText())
        .toBe("first live thought");
      await statusBar.locator(".status-bar-thinking-copy").click();
      liveThinkingText =
        "**Drafting**\nThe model is gathering the latest repository context before it chooses the smallest safe change. This long paragraph has no internal newlines and should keep its newest sentence visible.\n\nIt then compares the focused browser behavior with the settled thread and records the latest checkpoint so the operator can read what is happening now.";
      await page.reload();
      await page.locator(".status-bar-box").waitFor();
      await page.locator(".status-bar-box .status-bar-thinking-copy").click();
      await browserExpect(liveSummary).toBeVisible();
      await browserExpect
        .poll(() => liveSummary.innerText())
        .toBe(liveThinkingText.split("\n").slice(1).join("\n"));
      expect(
        await liveSummary.evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      ).toBeLessThanOrEqual(1);
      await page.locator(".status-bar-box .status-bar-thinking-copy").click();
      expect(await page.locator(".status-bar-thinking-summary").count()).toBe(
        0,
      );
      await page.locator(".activity-group-toggle").click();
      expect(await page.locator(".live-thinking-step").count()).toBe(0);
      const closedPill = page.locator(".status-bar-box");
      const liveToggle = closedPill.locator(".status-bar-thinking-copy");
      expect(await liveToggle.getAttribute("aria-expanded")).toBe("false");
      await liveToggle.click();
      expect(await liveToggle.getAttribute("aria-expanded")).toBe("true");
      expect(await closedPill.innerText()).toContain("The model is gathering");
      expect(await closedPill.innerText()).toContain("checkpoint");
      await liveToggle.click();
      expect(await liveToggle.getAttribute("aria-expanded")).toBe("false");
      const pillBox = async () => {
        await waitForLayout(page);
        const box = await page.locator(".status-bar-box").boundingBox();
        if (!box) throw new Error("status bar is not laid out");
        return { width: box.width, height: box.height };
      };
      const initialBox = await pillBox();

      thread.rows = [
        ...thread.rows,
        row("live-call", "tool", "", {
          kind: "tool_call",
          name: "read",
          stat: { kind: "read", lines: 1, from: 1, to: 1 },
          live: true,
        }),
      ];
      await page.reload();
      const toolStartBox = await pillBox();
      expect(toolStartBox).toEqual(initialBox);
      await page.locator(".activity-group-toggle").click();
      await series.click();
      expect(
        await page
          .locator(".turn-thinking-toggle .turn-thinking-line")
          .innerText(),
      ).toBe("Thought for 4s");
      thread.rows.at(-1)!.live = false;
      await page.reload();
      const toolEndBox = await pillBox();
      expect(toolEndBox).toEqual(initialBox);
      thread.rows = [
        row("live-user-no-time", "user", "continue"),
        row("live-step-no-time", "assistant", "", {
          live: true,
          thinking_title: "Drafting",
          has_thinking: true,
          live_thinking: true,
        }),
      ];
      await page.reload();
      const noTimePill = page.locator(".status-bar-box");
      await noTimePill.waitFor();
      expect(await noTimePill.innerText()).toContain("Drafting");
      expect(await noTimePill.innerText()).not.toContain("0s");
      thread.rows.push(
        row("live-step-2", "assistant", "", {
          live: true,
          thinking_title: "Reviewing",
          has_thinking: true,
          live_thinking: true,
          thinking_elapsed_ms: 5100,
        }),
      );
      await page.reload();
      const titleChangeBox = await pillBox();
      expect(titleChangeBox).toEqual(initialBox);
      expect(await page.locator(".status-bar-box").innerText()).toContain(
        "Reviewing",
      );
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
};
