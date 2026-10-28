import { expect } from "bun:test";

declare const document: any;
declare const getComputedStyle: any;
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  type BrowserTest,
} from "./common";
import { row } from "./fixtures";
import recorded from "./fixtures/activity-lines.json";
import thinking from "./fixtures/activity-thinking.json";

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
      thread.rows = thinking.map((entry) =>
        row(entry.id, entry.role, entry.text ?? "", entry),
      );
      await page.reload();
      await eye.click();
      expect(await series.count()).toBe(1);
      expect(await page.locator(".turn-thinking").count()).toBe(0);
      expect(
        await page.locator(".turn-thinking-series-title").innerText(),
      ).toBe("Checking the sample output");
      await series.click();
      expect(await page.locator(".turn-thinking").count()).toBe(2);
      await series.click();
      expect(await page.locator(".turn-thinking").count()).toBe(0);
      expect(
        await page.locator(".turn-thinking-series-title").innerText(),
      ).toBe("Checking the sample output");
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
        await page.locator(".turn-thinking").evaluateAll((elements: any[]) =>
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
        {
          heading: "Thought for 6s · Planning the sample task",
          nextTool: "Wait",
        },
        {
          heading: "Thought for 7s · Checking the sample output",
          nextTool: "Search",
        },
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
      const livePill = page.locator(".live-panel-box");
      await livePill.waitFor();
      expect(await livePill.innerText()).toContain("Drafting");
      thread.rows.at(-1)!.thinking_title = "Analyzing settings and artifacts";
      await page.reload();
      await livePill.waitFor();
      expect(await livePill.locator(".live-thinking-title").innerText()).toBe(
        "Analyzing settings and artifacts",
      );
      const pillLayout = await livePill.evaluate((element) => {
        const title = element.querySelector(".live-thinking-title")!;
        const elapsed = element.querySelector(".live-thinking-elapsed")!;
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
      await livePill.waitFor();
      expect(await page.locator(".live-thinking-summary").count()).toBe(0);
      await livePill.locator(".live-thinking-copy").click();
      const liveSummary = page.locator(".live-thinking-summary");
      await liveSummary.waitFor();
      expect(await liveSummary.innerText()).toBe(liveThinkingText);
      await livePill.locator(".live-thinking-copy").click();
      liveThinkingText =
        "**Drafting**\nThe model is gathering the latest repository context before it chooses the smallest safe change. This long paragraph has no internal newlines and should keep its newest sentence visible.\n\nIt then compares the focused browser behavior with the settled thread and records the latest checkpoint so the operator can read what is happening now.";
      await page.reload();
      await page.locator(".live-panel-box").waitFor();
      await page.locator(".live-panel-box .live-thinking-copy").click();
      await liveSummary.waitFor();
      const longSummary = await liveSummary.innerText();
      expect(longSummary).toContain("checkpoint");
      expect(longSummary).toContain("happening now.");
      expect(longSummary).toBe(liveThinkingText);
      expect(
        await liveSummary.evaluate(
          (element) => element.scrollHeight <= element.clientHeight,
        ),
      ).toBeTrue();
      await page.locator(".live-panel-box .live-thinking-copy").click();
      expect(await page.locator(".live-thinking-summary").count()).toBe(0);
      await page.locator(".activity-group-toggle").click();
      expect(await page.locator(".live-thinking-step").count()).toBe(0);
      const closedPill = page.locator(".live-panel-box");
      const liveToggle = closedPill.locator(".live-thinking-copy");
      expect(await liveToggle.getAttribute("aria-expanded")).toBe("false");
      await liveToggle.click();
      expect(await liveToggle.getAttribute("aria-expanded")).toBe("true");
      expect(await closedPill.innerText()).toContain("The model is gathering");
      expect(await closedPill.innerText()).toContain("checkpoint");
      await liveToggle.click();
      expect(await liveToggle.getAttribute("aria-expanded")).toBe("false");
      const pillBox = async () => {
        const box = await page.locator(".live-panel-box").boundingBox();
        if (!box) throw new Error("live pill is not laid out");
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
      ).toMatch(/^Thought for 4s · Drafting$/);
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
      const noTimePill = page.locator(".live-panel-box");
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
      expect(await page.locator(".live-panel-box").innerText()).toContain(
        "Reviewing",
      );
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
};
