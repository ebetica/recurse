import { expect } from "bun:test";
import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  openPage,
  postFixture,
  runBrowserTests,
  screenshot,
  waitForLayout,
  type BrowserTest,
} from "./common";

async function visibleFieldSizes(
  page: Page,
): Promise<Array<{ field: string; size: number }>> {
  return page
    .locator(
      'textarea, select, input:not([type="button"], [type="submit"], [type="reset"], [type="image"], [type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="hidden"])',
    )
    .filter({ visible: true })
    .evaluateAll((fields) =>
      fields.map((field) => ({
        field: field.id || field.className,
        size: parseFloat(
          field.ownerDocument.defaultView!.getComputedStyle(field).fontSize,
        ),
      })),
    );
}

function paint(control: Locator) {
  return control.evaluate((el) => {
    const style = el.ownerDocument.defaultView!.getComputedStyle(el);
    return { background: style.backgroundColor, filter: style.filter };
  });
}

async function tapPaint(page: Page, cid: string) {
  await page.locator("#menu-btn").tap();
  const settings = page.locator("#sidebar:not([inert]) #settings-btn");
  const settingsResting = await paint(settings);
  await settings.tap();
  await page.getByRole("button", { name: "Close settings" }).tap();
  expect(await paint(settings)).toEqual(settingsResting);
  await page.locator(`.agent[data-id="${cid}"]`).tap();
  const attach = page.locator("#attach");
  await attach.scrollIntoViewIfNeeded();
  const box = (await attach.boundingBox())!;
  const resting = await paint(attach);
  const touch = await page.context().newCDPSession(page);
  const hold = async () => {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    await browserExpect.poll(() => paint(attach)).not.toEqual(resting);
  };
  await hold();
  await Promise.all([
    page.waitForEvent("filechooser"),
    touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    }),
  ]);
  expect(await paint(attach)).toEqual(resting);
  await page.mouse.move(0, 0);
  expect(await paint(attach)).toEqual(resting);
  await hold();
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchCancel",
    touchPoints: [],
  });
  expect(await paint(attach)).toEqual(resting);
}

export const tests: BrowserTest[] = [
  // Regression: #3693 touch fields must not zoom and Attach must show feedback only while pressed.
  async function test_touch_fields_and_tap_feedback(browser, base) {
    const { cid } = await postFixture(base, "seed-changes-base");
    const { context, page } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
    });
    try {
      await page.goto(`${base}#agent=${cid}`);
      await page
        .getByText("Show the branch's changes", { exact: true })
        .waitFor();
      await waitForLayout(page);
      const composer = page.locator("#input");
      await composer.tap();
      await browserExpect(composer).toBeFocused();
      expect(
        await composer.evaluate(
          (el) => el.ownerDocument.defaultView!.visualViewport!.scale,
        ),
      ).toBe(1);
      await screenshot(page, "touch-feedback/412-composer-focused");
      const composerFields = await visibleFieldSizes(page);
      await browserExpect(page.locator("#attach")).toHaveCSS(
        "-webkit-tap-highlight-color",
        "rgba(0, 0, 0, 0)",
      );
      await tapPaint(page, cid);
      await composer.fill("/revive");
      await page
        .locator("#skill-menu .skill-option.action", { hasText: "/revive" })
        .tap();
      await page.locator("#agent-finder-query").waitFor();
      const finderFields = await visibleFieldSizes(page);
      await page.keyboard.press("Escape");
      await page.locator("#pane-fab").tap();
      await page.locator('.pane-menu-item[data-pane="diff"]').tap();
      const pane = page.locator('.pane-col[data-pane="diff"]');
      await pane.locator(".diff-row.add > .diff-num").last().tap();
      await pane.locator(".diff-line-input").waitFor();
      const commentFields = await visibleFieldSizes(page);
      expect(composerFields.some(({ field }) => field === "input")).toBe(true);
      expect(
        finderFields.some(({ field }) => field === "agent-finder-query"),
      ).toBe(true);
      expect(
        commentFields.some(({ field }) => field.includes("diff-line-input")),
      ).toBe(true);
      const fields = [...composerFields, ...finderFields, ...commentFields];
      expect(fields.filter(({ size }) => size < 16)).toEqual([]);
    } finally {
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["touch-feedback", tests]]);
