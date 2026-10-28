import { expect } from "bun:test";
declare const document: any;
declare const getSelection: any;
declare const PointerEvent: any;
declare const requestAnimationFrame: any;
declare const Document: any;

import {
  captureErrors,
  gotoRoot,
  mockConversation,
  turn,
  type BrowserTest,
} from "./common";

const reply = (n: number) =>
  [1, 2, 3, 4, 5, 6]
    .map((i) => `Paragraph ${i} of reply ${n} wraps across lines on a phone.`)
    .join("\n\n");

const thread = {
  id: "main",
  title: "Long selection",
  parent: null,
  status: "idle",
  turns: Array.from({ length: 12 }, (_, n) =>
    turn(`long-${n}`, `Question ${n}`, reply(n), { cursor: n * 100 }),
  ),
};

async function dragPastEdge(page: any, edge: "top" | "bottom"): Promise<any> {
  return page.evaluate(async (edge: "top" | "bottom") => {
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const scroll = document.querySelector("#scroll");
    scroll.scrollTop = scroll.scrollHeight / 2 - scroll.clientHeight / 2;
    await frame();
    const view = scroll.getBoundingClientRect();
    const paragraphs = [...document.querySelectorAll("#messages .content p")];
    const start: any = paragraphs.find((p: any) => {
      const box = p.getBoundingClientRect();
      return box.top > view.top + 200 && box.bottom < view.bottom - 200;
    });
    const offscreen = paragraphs
      .filter((p: any) => {
        const box = p.getBoundingClientRect();
        return edge === "top" ? box.bottom < view.top : box.top > view.bottom;
      })
      .map((p: any) => p.textContent);
    const chrome = document.querySelector(
      edge === "top" ? "#conv-title" : "#composer-wrap .lbl",
    ).firstChild;
    start.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
    );
    const selection = getSelection();
    selection.setBaseAndExtent(start.firstChild, 4, start.firstChild, 9);
    const tops = [scroll.scrollTop];
    let strayEnd = false;
    for (let move = 0; move < 40; move++) {
      selection.extend(chrome, 1);
      await frame().then(frame);
      tops.push(scroll.scrollTop);
      strayEnd ||= !document
        .querySelector("#messages")
        .contains(selection.focusNode);
    }
    const screens = scroll.scrollHeight / scroll.clientHeight;
    return { tops, strayEnd, text: selection.toString(), offscreen, screens };
  }, edge);
}

export const tests: BrowserTest[] = [
  async function test_touch_selection_scrolls_past_thread_edges(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await mockConversation(page, base, "main", () => thread);
    await gotoRoot(page, base);
    await page.locator("#messages .content p").first().waitFor();
    for (const [pass, edge] of (["top", "bottom", "top"] as const).entries()) {
      if (pass === 2)
        await page.evaluate(
          () => delete Document.prototype.caretPositionFromPoint,
        );
      const run = await dragPastEdge(page, edge);
      expect(run.screens).toBeGreaterThan(3);
      expect(run.strayEnd).toBe(false);
      expect(run.text).not.toContain("Long selection");
      expect(run.text).not.toContain("Safety review");
      for (let i = 1; i < run.tops.length; i++) {
        const step = run.tops[i] - run.tops[i - 1];
        expect(edge === "top" ? -step : step).toBeGreaterThan(0);
        expect(Math.abs(step)).toBeLessThanOrEqual(48);
      }
      const nearest = edge === "top" ? run.offscreen.at(-1) : run.offscreen[0];
      expect(run.text).toContain(nearest.slice(0, 30));
    }
    expect(errors).toEqual([]);
  },
];
