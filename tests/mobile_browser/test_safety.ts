import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  captureErrors,
  checkedTap,
  expectHitCorners,
  focusComposer,
  postFixture,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2509 #3390 #3616 review failures, recovered requests, and review costs stay visible.
  async function test_safety_reviewer_unavailable_and_recovers(browser, base) {
    const { agent } = await postFixture(base, "seed-safety-review");
    const pages = await Promise.all(
      [390, 412, 1280].map((width) =>
        browser.newPage({
          viewport: { width, height: 915 },
          isMobile: width < 700,
          hasTouch: width < 700,
        }),
      ),
    );
    const errors = pages.map(captureErrors);
    const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
    const reasonText = "Safety review unavailable: provider error";
    try {
      for (const page of pages) {
        await page.goto(`${base}#agent=${agent}`);
        await browserExpect(page.locator("#safety-btn .lbl")).toHaveText(
          "Safety review",
        );
        await page.locator("#safety-row.on").waitFor({ state: "attached" });
        await focusComposer(page);
        await browserExpect(
          page.getByRole("switch", { name: /^Safety review/ }),
        ).toBeHidden();
        await page.getByRole("button", { name: "Choose effort level" }).click();
        const popup = page.getByRole("dialog", { name: "Effort level" });
        await browserExpect(
          popup.getByRole("switch", { name: /^Safety review/ }),
        ).toBeVisible();
        await waitForLayout(page);
        await visibleAndUncovered(page, "#safety-btn");
        await browserExpect(page.locator("#safety-warning")).toBeHidden();
        if (shots)
          await page.screenshot({
            path: `${shots}/effort-review-on-${page.viewportSize()!.width}.png`,
          });
        await popup.press("Escape");
      }
      const page = pages[0]!;
      const inputBox = async () => {
        await focusComposer(page);
        await waitForLayout(page);
        return (await page.locator("#input").boundingBox())!;
      };
      const initial = await inputBox();
      const send = async () => {
        await page.locator("#input").fill("Run the local command.");
        await page.locator("#send").click();
      };
      await send();
      await page.getByText("SAFETY_TURN_DONE", { exact: true }).waitFor();
      for (const view of pages) {
        const warning = view.getByRole("button", {
          name: reasonText,
          exact: true,
        });
        await browserExpect(warning).toHaveAttribute("title", reasonText);
        await view.reload();
        await browserExpect(warning).toBeVisible();
        await browserExpect(
          view.getByRole("switch", { name: /^Safety review/ }),
        ).toBeHidden();
        await focusComposer(view);
        if (view.viewportSize()!.width < 700) {
          await expectHitCorners(warning);
          await checkedTap(warning);
          await browserExpect(view.locator("#input")).toBeFocused();
        } else await warning.click();
        const popup = view.getByRole("dialog", { name: "Effort level" });
        const toggle = popup.getByRole("switch", {
          name: "Safety review, on, unavailable: provider error",
        });
        await browserExpect(toggle).toHaveAttribute("aria-checked", "true");
        await browserExpect(toggle).toHaveAttribute(
          "title",
          /^Safety review unavailable: provider error\. /,
        );
        await browserExpect(
          popup.getByText(reasonText, { exact: true }),
        ).toBeVisible();
        await browserExpect(toggle.locator(".lbl")).toHaveText("Safety review");
        await browserExpect(toggle.locator(".lbl")).toBeVisible();
        await visibleAndUncovered(view, "#safety-btn");
        if (view.viewportSize()!.width < 700) await expectHitCorners(toggle);
        if (shots)
          await view.screenshot({
            path: `${shots}/effort-review-unavailable-${view.viewportSize()!.width}.png`,
          });
        await popup.press("Escape");
        await browserExpect(warning).toBeFocused();
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
      }
      expect(await inputBox()).toEqual(initial);
      await send();
      await page.getByText("SAFETY_RECOVERY_DONE", { exact: true }).waitFor();
      for (const view of pages) {
        await browserExpect(view.locator("#safety-btn")).toHaveAttribute(
          "aria-label",
          "Safety review, on",
        );
        await focusComposer(view);
        await browserExpect(view.locator("#safety-warning")).toBeHidden();
        await view.getByRole("button", { name: "Choose effort level" }).click();
        const popup = view.getByRole("dialog", { name: "Effort level" });
        const label = popup
          .getByRole("switch", { name: "Safety review, on" })
          .locator(".lbl");
        await browserExpect(label).toBeVisible();
        await browserExpect(label).toHaveText("Safety review");
        await browserExpect(view.locator("#model-trigger")).toHaveAttribute(
          "aria-expanded",
          "true",
        );
        await visibleAndUncovered(view, "#safety-btn");
        await browserExpect(
          popup.getByText(reasonText, { exact: true }),
        ).toBeHidden();
        await popup.press("Escape");
        if (view === page) expect(await inputBox()).toEqual(initial);
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
        await view.keyboard.press("Escape");
        const usageButton = view
          .locator(".activity-boundary")
          .filter({
            has: view.getByText("SAFETY_RECOVERY_DONE", { exact: true }),
          })
          .getByRole("button", { name: /^View activity token usage/ });
        await usageButton.waitFor();
        await usageButton.click();
        const usage = view.getByRole("dialog", { name: "Turn usage" });
        await browserExpect(
          usage.getByRole("region", { name: "Conversation model usage" }),
        ).toContainText("$0.40 cost");
        await browserExpect(
          usage.getByRole("region", { name: "Safety reviewer usage" }),
        ).toContainText("$0.20 cost");
        await browserExpect(usage.locator(".turn-usage-total-cost")).toHaveText(
          "Total cost: $0.60",
        );
        if (shots)
          await view.screenshot({
            path: `${shots}/turn-usage-review-${view.viewportSize()!.width}.png`,
          });
        await view.keyboard.press("Escape");
      }
      await focusComposer(page);
      await page.locator("#model-trigger").click();
      await page.getByRole("switch", { name: "Safety review, on" }).click();
      const safetyPath = `/api/conversations/${agent}/safety`;
      const offResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === safetyPath,
      );
      await page
        .getByRole("button", { name: "Turn off safety review", exact: true })
        .click();
      expect((await offResponse).ok()).toBe(true);
      for (const view of pages) {
        const input = view.locator("#input");
        const width = view.viewportSize()!.width;
        const warning = view.getByRole("button", {
          name: "Safety review off",
          exact: true,
        });
        await view.reload();
        await browserExpect(warning).toBeVisible();
        await waitForLayout(view);
        await visibleAndUncovered(view, "#model-trigger");
        const composer = view.locator("#composer");
        const card = await composer.boundingBox();
        if (width < 700) await checkedTap(input);
        else await focusComposer(view);
        expect(await composer.boundingBox()).toEqual(card);
        await browserExpect(
          view.getByRole("switch", { name: /^Safety review/ }),
        ).toBeHidden();
        const positions = await view.locator("#composer").evaluate((composer) =>
          [
            "#attach",
            "#safety-warning",
            "#context-mini",
            "#model-trigger",
            "#send",
          ].map((id) => {
            const { x, y, width, height } = composer
              .querySelector(id)!
              .getBoundingClientRect();
            return { left: x, right: x + width, center: y + height / 2 };
          }),
        );
        expect(
          positions.every(
            ({ right }, i) =>
              i === positions.length - 1 || right <= positions[i + 1]!.left,
          ),
        ).toBe(true);
        await visibleAndUncovered(view, "#safety-warning");
        const centers = positions.map(({ center }) => center);
        expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(
          1,
        );
        if (shots)
          await view.screenshot({
            path: `${shots}/composer-review-off-${width}.png`,
          });
        if (width < 700) await checkedTap(warning);
        else await warning.click();
        const safetyOff = view.getByRole("switch", {
          name: "Safety review off (Yolo mode)",
          checked: false,
        });
        await browserExpect(safetyOff.locator(".lbl")).toHaveText("Yolo mode");
        await browserExpect(view.locator("#model-trigger")).toHaveAttribute(
          "aria-expanded",
          "true",
        );
        if (width < 700) await expectHitCorners(safetyOff);
        if (shots)
          await view.screenshot({
            path: `${shots}/effort-review-off-${width}.png`,
          });
      }
      const input = page.locator("#input");
      await browserExpect(input).toBeFocused();
      await input.evaluate((field) =>
        field.addEventListener(
          "blur",
          () => {
            field.dataset.blurred = "true";
          },
          { once: true },
        ),
      );
      const onResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === safetyPath,
      );
      await checkedTap(
        page.getByRole("switch", {
          name: "Safety review off (Yolo mode)",
          checked: false,
        }),
      );
      expect((await onResponse).ok()).toBe(true);
      await browserExpect(
        page.getByRole("switch", { name: "Safety review, on" }),
      ).toBeVisible();
      await browserExpect(input, "safety switch keeps the caret").toBeFocused();
      expect(await input.getAttribute("data-blurred")).toBeNull();
      expect(errors).toEqual([[], [], []]);
    } finally {
      await Promise.all(pages.map((page) => page.close()));
    }
  },
];
