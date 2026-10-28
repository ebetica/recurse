import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
declare const document: any;

import {
  captureErrors,
  gotoRoot,
  mockConversation,
  postFixture,
  runBrowserTests,
  turn,
  type BrowserTest,
} from "./common";

const shots =
  process.env.RECURSE_SCREENSHOT_DIR ??
  join(
    process.env.RECURSE_AGENT_TMPDIR ?? process.env.TMPDIR ?? tmpdir(),
    "recurse-selection-comment-shots",
  );

async function shot(page: any, name: string): Promise<void> {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, name) });
}

async function selectWithMouse(
  page: any,
  paragraph: any,
  method: string,
): Promise<void> {
  const box = (await paragraph.boundingBox())!;
  if (method === "drag") {
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
  } else {
    await page.mouse.click(box.x + 15, box.y + box.height / 2, {
      clickCount: method === "double" ? 2 : 3,
    });
  }
}

const thread = {
  id: "main",
  title: "Selection comments",
  parent: null,
  status: "idle",
  kind: null,
  msg_count: 2,
  window_cursor: 0,
  turns: [
    turn(
      "selection-comment",
      "Explain this",
      "The highlighted answer can be discussed directly.\nSelect this sentence.",
    ),
  ],
  draft: null,
};

async function selectContent(
  page: any,
  content: any,
  touch: boolean,
  handles = false,
): Promise<void> {
  if (!touch) {
    await content.selectText();
    return;
  }
  const offerHiddenDuringSelection = await page.evaluate((handles: boolean) => {
    const browser = globalThis as any;
    const root = browser.document.querySelector(".msg.assistant .content");
    if (!root) throw new Error("agent content is not rendered");
    const range = browser.document.createRange();
    range.selectNodeContents(root);
    if (handles) {
      const text = root.querySelector("p").firstChild;
      const start = text.textContent.indexOf("highlighted");
      range.setStart(text, start);
      range.setEnd(text, start + "highlighted".length);
    }
    const selection = browser.window.getSelection();
    selection.removeAllRanges();
    root.dispatchEvent(
      new browser.PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 17,
        pointerType: "touch",
        isPrimary: true,
      }),
    );
    selection.addRange(range);
    browser.document.dispatchEvent(
      new browser.Event("selectionchange", { bubbles: true }),
    );
    const offerHidden = browser.document.querySelector(
      ".selection-comment-offer",
    ).hidden;
    root.dispatchEvent(
      new browser.PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 17,
        pointerType: "touch",
        isPrimary: true,
      }),
    );
    return offerHidden;
  }, handles);
  expect(offerHiddenDuringSelection).toBe(true);
}

async function runSelectionComment(
  browser: any,
  base: string,
  mobile: boolean,
): Promise<void> {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 412, height: 844 }
      : { width: 1280, height: 800 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  try {
    const page = await context.newPage();
    const errors = captureErrors(page);
    await mockConversation(page, base, "main", () => thread);
    const deliveries: string[] = [];
    await page.route(
      `${base}api/conversations/main/deliver`,
      async (route: any) => {
        deliveries.push(route.request().postDataJSON().content);
        await route.fulfill({ json: { message_id: "selection-delivery" } });
      },
    );
    await gotoRoot(page, base);
    const content = page.locator(".msg.assistant .content").first();
    await content.waitFor();
    const composer = page.locator("#input");
    if (!mobile) {
      await page.locator("#scroll").evaluate((element: any) => {
        element.tabIndex = -1;
        element.focus();
      });
      await page.keyboard.press("c");
      expect(await composer.inputValue()).toBe("");
      expect(
        await composer.evaluate(
          (element: any) => element === document.activeElement,
        ),
      ).toBe(false);
      expect(
        await page.locator(".selection-comment-offer:visible").count(),
      ).toBe(0);
    }
    await selectContent(page, content, mobile);
    const comment = page.getByRole("button", { name: "Comment", exact: true });
    await comment.click();
    if (!mobile) {
      const clickedQuote = await composer.inputValue();
      await composer.fill("");
      await page.keyboard.press("Escape");
      await selectContent(page, content, false);
      await comment.waitFor();
      await page.keyboard.press("c");
      expect(await composer.inputValue()).toBe(clickedQuote);
      expect(
        await composer.evaluate(
          (element: any) => element === document.activeElement,
        ),
      ).toBe(true);
      await page.keyboard.press("c");
      expect(await composer.inputValue()).toBe(`${clickedQuote}c`);
      await page.keyboard.press("Backspace");
    }
    const emptyQuote =
      "> The highlighted answer can be discussed directly. Select this sentence.\n";
    const emptyState = await composer.evaluate((element: any) => ({
      value: element.value,
      caret: element.selectionStart,
    }));
    expect(
      await composer.evaluate((element: any) => element.selectionEnd),
    ).toBe(emptyState.caret);
    await composer.fill("Existing draft");
    await selectContent(page, content, mobile, mobile);
    const offer = page.getByRole("button", { name: "Comment", exact: true });
    await offer.waitFor();
    expect(await offer.getAttribute("aria-label")).toBe("Comment");
    await shot(
      page,
      mobile ? "selection-comment-phone.png" : "selection-comment-desktop.png",
    );
    if (mobile) {
      const geometry = await page.evaluate(() => {
        const browser = globalThis as any;
        const range = browser.window.getSelection().getRangeAt(0);
        const rects = (Array.from(range.getClientRects()) as any[]).filter(
          (rect) => rect.width && rect.height,
        );
        const first = rects[0]!;
        const last = rects[rects.length - 1]!;
        const button = document
          .querySelector(".selection-comment-offer")!
          .getBoundingClientRect();
        return {
          button: {
            top: button.top,
            bottom: button.bottom,
            left: button.left,
            right: button.right,
          },
          selectionBottom: range.getBoundingClientRect().bottom,
          center: (first.left + last.right) / 2,
          handles: [
            {
              left: first.left - 14,
              right: first.left + 14,
              top: first.bottom,
              bottom: first.bottom + 28,
            },
            {
              left: last.right - 14,
              right: last.right + 14,
              top: last.bottom,
              bottom: last.bottom + 28,
            },
          ],
        };
      });
      expect(
        geometry.button.top - geometry.selectionBottom,
      ).toBeGreaterThanOrEqual(36);
      expect((geometry.button.left + geometry.button.right) / 2).toBeCloseTo(
        geometry.center,
        0,
      );
      for (const handle of geometry.handles) {
        const button = geometry.button;
        expect(
          button.left < handle.right &&
            button.right > handle.left &&
            button.top < handle.bottom &&
            button.bottom > handle.top,
        ).toBe(false);
      }

      await content.evaluate((element: any) => {
        element.style.position = "fixed";
        element.style.top = "780px";
        element.style.width = "380px";
      });
      await selectContent(page, content, true, true);
      await offer.waitFor();
      const position = await page.evaluate(() => {
        const browser = globalThis as any;
        const selection = browser.window
          .getSelection()
          .getRangeAt(0)
          .getBoundingClientRect();
        const button = document
          .querySelector(".selection-comment-offer")
          .getBoundingClientRect();
        return {
          selectionTop: selection.top,
          top: button.top,
          bottom: button.bottom,
        };
      });
      expect(position.top).toBeGreaterThanOrEqual(8);
      expect(position.bottom).toBeLessThanOrEqual(position.selectionTop - 64);
      await shot(page, "selection-comment-phone-bottom.png");
      await content.evaluate((element: any) =>
        element.removeAttribute("style"),
      );
    }
    await selectContent(page, content, mobile);
    if (mobile) await offer.tap();
    else await offer.click();
    const quoted =
      "Existing draft\n\n> The highlighted answer can be discussed directly. Select this sentence.\n";
    expect(emptyState).toEqual({ value: emptyQuote, caret: emptyQuote.length });
    expect(await composer.inputValue()).toBe(quoted);
    expect(
      await composer.evaluate((element: any) => ({
        focused: document.activeElement === element,
        start: element.selectionStart,
        end: element.selectionEnd,
      })),
    ).toEqual({ focused: true, start: quoted.length, end: quoted.length });
    await shot(
      page,
      mobile
        ? "selection-composer-phone-after.png"
        : "selection-composer-desktop-after.png",
    );
    await page.keyboard.type("Please expand this.");
    expect(await composer.inputValue()).toBe(`${quoted}Please expand this.`);
    const delivered = page.waitForResponse(
      `${base}api/conversations/main/deliver`,
    );
    await page.locator("#send").click();
    await delivered;
    await page.waitForFunction("document.querySelector('#input').value === ''");
    const sent = `${quoted}Please expand this.`;
    expect(deliveries).toEqual([sent]);
    await mockConversation(page, base, "main", () => ({
      ...thread,
      turns: [turn("sent-comment", deliveries[0]!, "Expanded answer.")],
    }));
    await page.reload();
    const message = page.locator(".msg.user .bubble").last();
    await message.waitFor();
    expect(await message.innerText()).toBe(sent);
    expect(await message.locator("blockquote").count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

async function testSelectionCommentReplacement(
  browser: any,
  base: string,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });
  try {
    const page = await context.newPage();
    const errors = captureErrors(page);
    await mockConversation(page, base, "main", () => thread);
    await gotoRoot(page, base);
    const content = page.locator(".msg.assistant .content").first();
    await content.waitFor();
    await selectContent(page, content, false);
    const offer = page.getByRole("button", { name: "Comment", exact: true });
    await offer.waitFor();
    await page.evaluate(() => {
      const current = document.querySelector(".msg.assistant .content");
      current?.replaceWith(current.cloneNode(true));
    });
    await page.waitForFunction(
      "document.querySelector('.selection-comment-offer')?.hidden === true",
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}

export const tests: BrowserTest[] = [
  // Regression: #2600 a final Artifact paragraph also ends past nonselectable chrome. (also Feature #2377 font-scale changes reach selection-comment coverage and preserve toolbar spacing.; #2600 reopening the current Artifact must keep its paragraphs attached.)
  async function test_selection_comments_artifact_mouse_clicks(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      await postFixture(base, "seed-pane-reading");
      const page = await context.newPage();
      await gotoRoot(page, base);
      await page
        .getByRole("link", { name: "Reading document", exact: true })
        .click();
      const paragraph = page.locator(".report-doc p").last();
      await paragraph.waitFor();
      const original = await paragraph.elementHandle();
      await page
        .getByRole("link", { name: "Reading document", exact: true })
        .click();
      await paragraph.scrollIntoViewIfNeeded();
      const popover = page.locator(".report-comment-popover");
      for (const method of ["drag", "double", "triple"]) {
        await selectWithMouse(page, paragraph, method);
        const selected = await page.evaluate(() =>
          String((globalThis as any).getSelection()),
        );
        expect(selected.trim()).not.toBe("");
        await popover.waitFor();
        if (method === "triple")
          await shot(page, "selection-triple-artifact.png");
        expect(
          await page.evaluate(() => String((globalThis as any).getSelection())),
        ).toBe(selected);
        if (method !== "triple") {
          await popover
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          continue;
        }
        await page.locator(".msg.assistant .content").first().selectText();
        const threadOffer = page.locator(".selection-comment-offer");
        await threadOffer.waitFor();
        expect(await popover.isVisible()).toBe(true);
        await page.keyboard.press("c");
        const composer = page.locator("#input");
        expect(await composer.inputValue()).toContain("> Reading document");
        expect(
          await composer.evaluate(
            (element: any) => element === document.activeElement,
          ),
        ).toBe(true);
        expect(await page.locator(".report-comment").count()).toBe(0);
        await composer.fill("");
        await page.keyboard.press("Escape");
        await selectWithMouse(page, paragraph, "triple");
        await popover.waitFor();
        await popover.locator("textarea").fill("Discuss this paragraph.");
        await popover
          .getByRole("button", { name: "Comment", exact: true })
          .click();
        const quote = page.locator(".report-comment-quote");
        await quote.waitFor();
        expect(await quote.textContent()).toBe(selected.trimEnd());
      }
      expect(
        await original!.evaluate(
          (node: { isConnected: boolean }) => node.isConnected,
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  },
  // Regression: #2600 Chromium extends triple-click ranges past nonselectable chrome.
  async function test_selection_comments_mouse_clicks(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      await postFixture(base, "seed-durable-clear");
      const page = await context.newPage();
      await page.goto(`${base}#agent=durable-clear`);
      await page.locator("#input").fill("Explain this.");
      await page.locator("#send").click();
      const paragraph = page.getByText("Before Durable clear.", {
        exact: true,
      });
      await paragraph.waitFor();
      const offer = page.locator(".selection-comment-offer");
      const composer = page.locator("#input");
      for (const method of ["drag", "double", "triple"]) {
        await selectWithMouse(page, paragraph, method);
        const selected = await page.evaluate(() =>
          String((globalThis as any).getSelection()),
        );
        expect(selected.trim()).not.toBe("");
        if (method === "triple") {
          expect(selected.trimEnd()).toBe("Before Durable clear.");
          await shot(page, "selection-triple-desktop.png");
        }
        await offer.waitFor();
        expect(
          await page.evaluate(() => String((globalThis as any).getSelection())),
        ).toBe(selected);
        await offer.click();
        expect(await composer.inputValue()).toBe(`> ${selected.trimEnd()}\n`);
        await composer.fill("");
      }
      await composer.fill("Continue.");
      await page.locator("#send").click();
      await page.getByText("After Durable clear.", { exact: true }).waitFor();
    } finally {
      await context.close();
    }
  },
  async function test_selection_comments_replacement_invalidates_offer(
    browser,
    base,
  ) {
    await testSelectionCommentReplacement(browser, base);
  },
  async function test_selection_comments_desktop(browser, base) {
    await runSelectionComment(browser, base, false);
  },
  async function test_selection_comments_mobile(browser, base) {
    await runSelectionComment(browser, base, true);
  },
];

if (import.meta.main) await runBrowserTests([["selection-comments", tests]]);
