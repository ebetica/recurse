import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { join } from "node:path";
import { gotoRoot, showAgentList, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Feature: #3166 finished dots are shared across devices and sidebar layouts.
  async function test_unread_finished_sidebar(browser, base) {
    for (const width of [1280, 412]) {
      const options = {
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      };
      const context = await browser.newContext(options);
      const other = await browser.newContext(options);
      const page = await context.newPage();
      const second = await other.newPage();
      try {
        const created = await context.request.post(`${base}api/conversations`, {
          data: {},
        });
        expect(created.ok()).toBeTrue();
        const { id } = await created.json();
        expect(
          (
            await context.request.post(
              `${base}api/conversations/${id}/rename`,
              { data: { title: "Finished agent" } },
            )
          ).ok(),
        ).toBeTrue();
        await gotoRoot(page, base);
        await showAgentList(page);
        await gotoRoot(second, base);
        await showAgentList(second);
        const selector = `#agent-list .agent[data-id="${id}"]`;
        const row = page.locator(selector);
        const dot = row.locator(".agent-unread");
        const secondDot = second.locator(selector).locator(".agent-unread");
        await row.waitFor();
        await browserExpect(dot).toHaveCount(0);
        const finish = async () => {
          expect(
            (
              await context.request.post(
                `${base}api/conversations/${id}/deliver`,
                { data: { content: "Reply only Finished unread reply" } },
              )
            ).ok(),
          ).toBeTrue();
          await browserExpect(dot).toBeVisible();
          await browserExpect(secondDot).toBeVisible();
        };
        await finish();
        await browserExpect(dot).toHaveAccessibleName(
          "Finished agent — finished, not yet viewed",
        );
        await row.scrollIntoViewIfNeeded();
        const layout = await row.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const mark = el
            .querySelector(".agent-unread")!
            .getBoundingClientRect();
          const slot = el.querySelector(".time")!.getBoundingClientRect();
          const title = el.querySelector(".title")!;
          const titleBox = title.getBoundingClientRect();
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(title);
          const text = range.getBoundingClientRect();
          const inset = Math.max(
            1,
            parseFloat(
              el.ownerDocument.defaultView!.getComputedStyle(el)
                .borderTopLeftRadius,
            ),
          );
          return {
            dotCenterX: Math.abs(
              mark.left + mark.width / 2 - (slot.left + slot.width / 2),
            ),
            dotCenterY: Math.abs(
              mark.top + mark.height / 2 - (slot.top + slot.height / 2),
            ),
            dotContained:
              mark.left >= box.left &&
              mark.right <= box.right &&
              mark.top >= box.top &&
              mark.bottom <= box.bottom,
            dotClearOfTitle:
              mark.right <= titleBox.left ||
              mark.left >= titleBox.right ||
              mark.bottom <= titleBox.top ||
              mark.top >= titleBox.bottom,
            titleUnclipped:
              text.left >= titleBox.left &&
              text.right <= titleBox.right &&
              text.top >= titleBox.top &&
              text.bottom <= titleBox.bottom,
            titleLines: range.getClientRects().length,
            touchTargetHit: [box.left + inset, box.right - inset].every((x) =>
              [-21, 21].every((y) =>
                el.contains(
                  el.ownerDocument.elementFromPoint(
                    x,
                    box.top + box.height / 2 + y,
                  ),
                ),
              ),
            ),
          };
        });
        expect(layout.dotCenterX).toBeLessThanOrEqual(1);
        expect(layout.dotCenterY).toBeLessThanOrEqual(1);
        await browserExpect(row.locator(".time-label")).toHaveCount(1);
        await browserExpect(row.locator(".time-label")).toBeHidden();
        await browserExpect(row.locator(".time")).toHaveAttribute(
          "title",
          /^Last activity /,
        );
        expect(layout.dotContained).toBeTrue();
        expect(layout.dotClearOfTitle).toBeTrue();
        expect(layout.titleUnclipped).toBeTrue();
        expect(layout.titleLines).toBe(1);
        if (width === 412) expect(layout.touchTargetHit).toBeTrue();
        if (process.env.RECURSE_SCREENSHOT_DIR)
          await page.screenshot({
            path: join(
              process.env.RECURSE_SCREENSHOT_DIR,
              `unread-sidebar-${width}.png`,
            ),
          });
        if (width === 1280) {
          await row.hover();
          expect(
            await dot.evaluate((el) => {
              const box = el.getBoundingClientRect();
              return !!el.ownerDocument
                .elementFromPoint(
                  box.left + box.width / 2,
                  box.top + box.height / 2,
                )
                ?.closest(".row-actions");
            }),
          ).toBeTrue();
          await page.mouse.move(1000, 700);
        }
        expect(
          (
            await context.request.post(
              `${base}__browser-test/save-sidebar-script`,
              {
                data: {
                  script:
                    'export default rows => [{title: "Finished", rows: rows.filter(r => r.unread)}, {title: "Viewed", rows: rows.filter(r => !r.unread)}];',
                  by: "operator",
                },
              },
            )
          ).ok(),
        ).toBeTrue();
        await page.reload();
        await showAgentList(page);
        await browserExpect(dot).toBeVisible();
        await page
          .locator('.tree-section-header[data-section="Finished"]')
          .waitFor();
        await row.click();
        await page
          .getByText("Finished unread reply", { exact: true })
          .waitFor();
        await browserExpect(secondDot).toHaveCount(0);
        await showAgentList(page);
        await browserExpect(dot).toHaveCount(0);
        await browserExpect(row.locator(".time-label")).toBeVisible();
        await page.reload();
        await showAgentList(page);
        await row.waitFor();
        await browserExpect(dot).toHaveCount(0);
        await second.reload();
        await showAgentList(second);
        await second.locator(selector).waitFor();
        await browserExpect(secondDot).toHaveCount(0);
        await gotoRoot(page, base);
        await showAgentList(page);
        await finish();
      } finally {
        await context.request.post(
          `${base}__browser-test/save-sidebar-script`,
          { data: { script: null, by: "operator" } },
        );
        await context.close();
        await other.close();
      }
    }
  },
];
