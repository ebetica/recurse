import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { captureErrors, postFixture, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2509 #3390 review failures and recovered requests stay inspectable.
  async function test_safety_reviewer_unavailable_and_recovers(browser, base) {
    const { agent } = await postFixture(base, "seed-safety-review");
    const pages = await Promise.all(
      [412, 1280].map((width) =>
        browser.newPage({
          viewport: { width, height: 915 },
          isMobile: width === 412,
          hasTouch: width === 412,
        }),
      ),
    );
    const errors = pages.map(captureErrors);
    try {
      for (const page of pages) {
        await page.goto(`${base}#agent=${agent}`);
        await browserExpect(page.locator("#safety-btn .lbl")).toHaveText(
          "Safety review",
        );
        await browserExpect(page.locator("#safety-btn")).toBeVisible();
      }
      const page = pages[0]!;
      const before = await page.locator("#input").boundingBox();
      const send = async () => {
        await page.locator("#input").fill("Run the local command.");
        await page.locator("#send").click();
      };
      await send();
      await page.getByText("SAFETY_TURN_DONE", { exact: true }).waitFor();
      for (const view of pages) {
        const warning = view.locator("#safety-unavailable");
        await browserExpect(warning).toHaveText("Unavailable");
        await browserExpect(warning).toHaveAttribute(
          "title",
          "Safety review unavailable: provider error",
        );
        expect(await view.locator("#safety-btn .lbl").innerText()).toBe(
          "Safety review",
        );
        expect(
          await view.locator("#safety-btn").getAttribute("aria-checked"),
        ).toBe("true");
        expect(
          await view.locator("#safety-btn").getAttribute("aria-label"),
        ).toBe("Safety review, on, unavailable: provider error");
        expect(await view.locator("#safety-row").innerText()).not.toContain(
          "Yolo mode",
        );
        await view.reload();
        await browserExpect(warning).toHaveText("Unavailable");
        await browserExpect(warning).toBeVisible();
        await view
          .getByRole("button", { name: "Expand all", exact: true })
          .click();
        const tool = view.locator(".turn-tool", { hasText: "SAFETY_TOOL_RAN" });
        const detail = view.waitForResponse((response) =>
          /\/tool-details\/[^/]+$/.test(new URL(response.url()).pathname),
        );
        await tool.locator('.turn-tool-head[role="button"]').click();
        await browserExpect(
          tool.getByRole("region", { name: "Output", exact: true }),
        ).toContainText(
          "HTTP 503: Mammoth rejected <b>review context</b> Use a shorter request.",
        );
        const operatorView = await detail;
        const { safety_review_failure: failure } = await operatorView.json();
        expect(failure.status).toBe(503);
        expect(failure.message).toHaveLength(200);
        expect(failure.message).not.toMatch(/[\r\n\u0085\u2028\u2029]/u);
        expect(failure.message).toStartWith(
          "Mammoth rejected <b>review context</b> Use a shorter request.",
        );
        expect(failure.message).toEndWith("decide what to do next. REDACTED");
        expect(failure.message).not.toContain("abc123");
        expect(failure.message).not.toContain("Provider response padding");
        const agentView = await view.request.get(operatorView.url(), {
          headers: { "x-recurse-agent": agent },
        });
        expect(agentView.ok()).toBe(true);
        expect((await agentView.json()).safety_review_failure).toBeUndefined();
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await view.screenshot({
            path: `${shots}/safety-unavailable-${view.viewportSize()!.width}.png`,
          });
      }
      const after = await page.locator("#input").boundingBox();
      expect(after!.y).toBe(before!.y);
      expect(after!.width).toBe(before!.width);
      await send();
      await browserExpect(
        page.getByText("SAFETY_TURN_DONE", { exact: true }),
      ).toHaveCount(2);
      for (const view of pages) {
        await browserExpect(view.locator("#safety-unavailable")).toBeHidden();
        expect(await view.locator("#safety-btn .lbl").innerText()).toBe(
          "Safety review",
        );
        expect(await view.locator("#safety-row").innerText()).not.toContain(
          "Unavailable",
        );
        expect(
          await view.locator("#safety-btn").getAttribute("aria-label"),
        ).toBe("Safety review, on");
        await view.locator(".prompt-banner-row").click();
        const capture = view.locator(".safety-review-capture");
        await browserExpect(capture).toBeVisible();
        await capture.locator("summary").click();
        const json = await capture.locator("pre").innerText();
        const review = JSON.parse(json);
        expect(JSON.stringify(review.context.messages)).toContain(
          "SAFETY_TOOL_RAN",
        );
        expect(review.reply.stopReason).toBe("stop");
        expect(review.reply.content).toEqual([{ type: "text", text: "OK" }]);
        expect(json).not.toContain("browser-test");
      }
      expect(errors).toEqual([[], []]);
    } finally {
      await Promise.all(pages.map((page) => page.close()));
    }
  },
];
