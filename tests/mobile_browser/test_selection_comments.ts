import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { waitForPaneScroll } from "./pane_layout";
import {
  expect as browserExpect,
  type Locator,
  type Page,
} from "playwright/test";

import {
  captureErrors,
  dispatchArtifactSelection,
  expectHitCorners,
  gotoRoot,
  mockConversation,
  openPage,
  postFixture,
  runBrowserTests,
  rootAgentId,
  screenshot,
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
          .querySelector(".selection-comment-offer")!
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

async function editArtifactComment(
  page: Page,
  paragraph: Locator,
  mobile: boolean,
  original: string,
  edited: string,
): Promise<void> {
  const activate = (control: Locator) =>
    mobile ? control.tap() : control.click();
  const popover = page.locator(".report-comment-popover");
  const input = popover.getByRole("textbox");
  const save = popover.getByRole("button", { name: "Save", exact: true });
  const cancel = popover.getByRole("button", { name: "Cancel", exact: true });
  const link = paragraph.getByRole("link", { name: "Read the first section" });
  const mark = paragraph.getByRole("button", {
    name: "Edit comment: Read the first section before editing.",
  });
  const submit = page.getByRole("button", {
    name: "Submit comments",
    exact: true,
  });
  await browserExpect(paragraph.locator(".report-comment-anchor")).toHaveCount(
    0,
  );
  await browserExpect(link.locator("mark.report-cmark")).toHaveText(
    "Read the first section",
  );
  await activate(mark);
  await browserExpect(popover).toBeVisible();
  await browserExpect(input).toHaveValue(original);
  await browserExpect(input).toBeFocused();
  await browserExpect(mark).toBeVisible();
  if (mobile) {
    await expectHitCorners(save);
    await expectHitCorners(cancel);
  }
  await input.fill(edited);
  await activate(save);
  await browserExpect(popover).toBeHidden();
  await browserExpect(mark).toBeFocused();
  await link.focus();
  await page.keyboard.press("Tab");
  await browserExpect(mark).toBeFocused();
  await browserExpect(mark).toHaveCSS("outline-style", "solid");
  await shot(
    page,
    mobile ? "artifact-highlight-phone.png" : "artifact-highlight-desktop.png",
  );
  await page.keyboard.press("Enter");
  await browserExpect(input).toHaveValue(edited);
  await input.fill("");
  await browserExpect(
    page.getByRole("button", { name: "Finish editing" }),
  ).toBeDisabled();
  await browserExpect(save).toBeDisabled();
  await input.press("Escape");
  await browserExpect(mark).toBeFocused();
  await browserExpect(submit).toBeEnabled();
  await page.keyboard.press("Space");
  await browserExpect(input).toHaveValue(edited);
  await input.press("Escape");
  await browserExpect(mark).toBeFocused();
  const entry = page.getByRole("button", { name: `Edit comment: ${edited}` });
  await browserExpect(entry).toContainText(edited);
  if (mobile) await expectHitCorners(entry);
  await activate(entry);
  await browserExpect(input).toHaveValue(edited);
  await input.fill("Discard this change");
  await activate(cancel);
  await browserExpect(popover).toBeHidden();
  await browserExpect(entry).toBeFocused();
  await entry.press("Enter");
  await browserExpect(input).toHaveValue(edited);
  await input.fill("Discard this too");
  await input.press("Escape");
  await browserExpect(popover).toBeHidden();
  await browserExpect(entry).toBeFocused();
  if (!mobile) {
    const stageOverlap = async (note: string, word: string) => {
      await mark.scrollIntoViewIfNeeded();
      const part = await mark.evaluate((element, word) => {
        const text = element.firstChild as Text;
        const offset = text.data.indexOf(word);
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + word.length);
        const { left, right, top, height } = range.getBoundingClientRect();
        return { left, right, y: top + height / 2 };
      }, word);
      await page.mouse.move(part.left + 1, part.y);
      await page.mouse.down();
      await page.mouse.move(part.right + 1, part.y, { steps: 5 });
      await page.mouse.up();
      await browserExpect(popover).toBeVisible();
      await input.fill(note);
      await popover
        .getByRole("button", { name: "Comment", exact: true })
        .click();
    };
    const wordNote = "Edit this word too";
    const leadInNote = "Clarify the lead-in";
    await stageOverlap(wordNote, "editing.");
    await stageOverlap(leadInNote, "before");
    const cards = page.locator(".report-comment");
    await browserExpect(cards).toHaveCount(3);
    await browserExpect(paragraph.getByRole("button")).toHaveCount(1);
    await link.focus();
    await page.keyboard.press("Tab");
    await browserExpect(mark).toBeFocused();
    await page.keyboard.press("Enter");
    await browserExpect(input).toHaveValue(edited);
    await input.press("Escape");
    const removeFor = (note: string) =>
      cards
        .filter({ hasText: note })
        .getByRole("button", { name: /^Remove comment on/ });
    for (const note of [edited, wordNote, leadInNote]) {
      const cardEditor = page.getByRole("button", {
        name: `Edit comment: ${note}`,
        exact: true,
      });
      await removeFor(note).focus();
      await page.keyboard.press("Shift+Tab");
      await browserExpect(cardEditor).toBeFocused();
      await page.keyboard.press("Enter");
      await browserExpect(input).toHaveValue(note);
      await input.press("Escape");
      await browserExpect(cardEditor).toBeFocused();
    }
    await removeFor(wordNote).click();
    await removeFor(leadInNote).click();
  }
  await browserExpect(page.locator(".report-comment")).toHaveCount(1);
  await browserExpect(page.locator(".report-sendbar-label")).toHaveText(
    "1 comment",
  );
  await paragraph.scrollIntoViewIfNeeded();
  const destination = page.getByRole("heading", {
    name: "Section 1",
    exact: true,
  });
  await browserExpect(destination).not.toBeInViewport();
  if (mobile) await link.tap();
  else await link.press("Enter");
  await browserExpect(destination).toBeInViewport();
  await browserExpect(popover).toBeHidden();
}

async function checkArtifactCommentSend(
  browser: any,
  base: string,
): Promise<void> {
  for (const mobile of [false, true]) {
    for (const moves of [true, false]) {
      for (const submit of ["button", "Control+Enter", "Meta+Enter"]) {
        const edit = moves && submit === "button";
        const markdown = edit
          ? Array.from(
              { length: 100 },
              (_, i) =>
                `## Section ${i + 1}\n\n${i === 50 ? "[Read the first section](#section-1) before editing." : `Document paragraph ${i + 1}.`}`,
            ).join("\n\n")
          : undefined;
        const item = await postFixture(base, "seed-pane-reading", { markdown });
        const context = await browser.newContext({
          viewport: { width: mobile ? 412 : 1280, height: 844 },
          isMobile: mobile,
          hasTouch: mobile,
        });
        try {
          await context.addInitScript(
            ({ moves, mac }: any) => {
              const browser = globalThis as any;
              if (!moves) delete browser.Element.prototype.moveBefore;
              Object.defineProperty(browser.navigator, "platform", {
                value: mac ? "MacIntel" : "Linux x86_64",
              });
            },
            { moves, mac: submit === "Meta+Enter" },
          );
          const page = await context.newPage();
          const errors = captureErrors(page);
          await gotoRoot(page, base);
          const link = page.locator(`a[href="#artifact=${item.id}"]`);
          await link.click();
          const paragraph = page.locator(".report-doc p").nth(50);
          await paragraph.scrollIntoViewIfNeeded();
          const paneSelector = '.pane-col[data-pane="report"]';
          const scrollerSelector = mobile
            ? paneSelector
            : `${paneSelector} .pane-body`;
          await waitForPaneScroll(page, scrollerSelector, paneSelector);
          const original = await paragraph.elementHandle();
          await page.evaluate(() => {
            (globalThis as any).__commentPageMarker = true;
          });
          const loads: string[] = [];
          const contentRequests: string[] = [];
          const deliveries: string[] = [];
          page.on("request", (request: any) => {
            if (
              request
                .url()
                .endsWith(`/api/conversations/${rootAgentId()}/deliver`)
            )
              deliveries.push(request.postDataJSON().content);
          });
          page.on("load", () => loads.push(page.url()));
          page.on("request", (request: any) => {
            if (
              /\/api\/artifacts\/[^/]+\/(file|page)$/.test(
                new URL(request.url()).pathname,
              )
            )
              contentRequests.push(request.url());
          });
          await paragraph.selectText();
          const popover = page.locator(".report-comment-popover");
          await popover.waitFor();
          const reply = `Preserved ${mobile} ${moves} ${submit}`;
          const note = `Reply only ${reply}`;
          const initial = edit ? "This note needs editing" : note;
          await popover.locator("textarea").fill(initial);
          const secondNote = `Also preserve ${mobile} ${moves} ${submit}`;
          const beforeStage = await page
            .locator(scrollerSelector)
            .evaluate((element: any) => element.scrollTop);
          if (submit === "button")
            await popover
              .getByRole("button", { name: "Comment", exact: true })
              .click();
          else {
            await popover.locator("textarea").press(submit);
            await popover.waitFor({ state: "hidden" });
            expect(deliveries).toEqual([]);
            expect(
              await page.locator(".report-sendbar-label").textContent(),
            ).toContain("1 comment");
            expect(
              await page
                .locator(scrollerSelector)
                .evaluate((element: any) => element.scrollTop),
            ).toBe(beforeStage);
            expect(
              await page
                .locator(`${paneSelector} .pane-body`)
                .evaluate((element: any) => element === document.activeElement),
            ).toBe(true);
            await paragraph.selectText();
            await popover.waitFor();
            await popover.locator("textarea").fill(secondNote);
            await popover.locator("textarea").press(submit);
            await popover.waitFor({ state: "hidden" });
            expect(deliveries).toEqual([]);
            expect(
              await page.locator(".report-sendbar-label").textContent(),
            ).toContain("2 comments");
            expect(
              await page
                .locator(scrollerSelector)
                .evaluate((element: any) => element.scrollTop),
            ).toBe(beforeStage);
            if (moves && submit === "Meta+Enter")
              await shot(
                page,
                mobile
                  ? "artifact-staged-phone.png"
                  : "artifact-staged-desktop.png",
              );
          }
          if (edit) {
            await editArtifactComment(page, paragraph, mobile, initial, note);
            await paragraph.scrollIntoViewIfNeeded();
            await waitForPaneScroll(page, scrollerSelector, paneSelector);
          }
          const scroll = await page
            .locator(scrollerSelector)
            .evaluate((element: any) => element.scrollTop);
          expect(scroll).toBeGreaterThan(0);
          const delivered = page.waitForResponse((response: any) =>
            response
              .url()
              .endsWith(`/api/conversations/${rootAgentId()}/deliver`),
          );
          if (submit === "button")
            await page
              .getByRole("button", { name: "Submit comments", exact: true })
              .click();
          else await page.keyboard.press(submit);
          expect((await delivered).ok()).toBe(true);
          expect(await page.locator(paneSelector).isVisible()).toBe(true);
          await page.locator(".msg.user", { hasText: note }).waitFor();
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0]).toContain(note);
          if (edit) {
            expect(deliveries[0]).not.toContain(initial);
            expect(deliveries[0]).not.toContain("Discard this");
            expect(
              deliveries[0]!.split("\n").filter((line) => line === note),
            ).toHaveLength(1);
          }
          if (submit !== "button") {
            expect(deliveries[0]).toContain(secondNote);
            expect(
              await page.locator(".msg.user", { hasText: secondNote }).count(),
            ).toBe(1);
          }
          expect(
            await page.evaluate(() => (globalThis as any).__commentPageMarker),
          ).toBe(true);
          await page.getByText(reply, { exact: true }).waitFor();
          expect(await paragraph.isVisible()).toBe(true);
          await paragraph.waitFor();
          await waitForPaneScroll(page, scrollerSelector, paneSelector);
          expect(
            await page.evaluate(() => (globalThis as any).__commentPageMarker),
          ).toBe(true);
          expect(
            await original!.evaluate((node: any) => node.isConnected),
          ).toBe(true);
          expect(
            await page
              .locator(scrollerSelector)
              .evaluate((element: any) => element.scrollTop),
          ).toBe(scroll);
          expect(loads).toEqual([]);
          expect(contentRequests).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    }
  }
}

export const tests: BrowserTest[] = [
  // Regression: #3128 Cmd/Ctrl+Enter stages selection comments before sending the batch; #3108 submitting Artifact comments preserves the document and reading position. (also #3064 controls stay outside native selections; #2949 Escape in the composer does not stage an Artifact selection; #2600 final paragraphs extend past chrome and reopening keeps them attached; Feature #2377 font-scale changes preserve toolbar spacing.)
  async function test_selection_comments_artifact_mouse_clicks(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    try {
      await postFixture(base, "seed-pane-reading");
      const page = await context.newPage();
      await gotoRoot(page, base);
      const keyboardQuote = "Keyboard copying includes Chat prose.";
      await page.locator("#input").fill(`Reply only ${keyboardQuote}`);
      await page.locator("#input").press("Enter");
      await page
        .locator(".msg.assistant .content", { hasText: keyboardQuote })
        .waitFor();
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
        await page.locator(".report-sendbar.on").waitFor();
        if (method === "triple") {
          await paragraph.scrollIntoViewIfNeeded();
          await shot(page, "selection-triple-artifact.png");
        }
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
        await selectWithMouse(page, paragraph, "triple");
        await page.evaluate(() =>
          (globalThis as any).getSelection().removeAllRanges(),
        );
        await page.keyboard.press("g");
        await page.keyboard.press("h");
        await page.evaluate(() =>
          (globalThis as any).navigator.clipboard.writeText("Before Chat copy"),
        );
        await page.keyboard.press("Control+a");
        const selectedByKeyboard = await page.evaluate(() =>
          String((globalThis as any).getSelection()),
        );
        expect(selectedByKeyboard.split("\n")).toContain(keyboardQuote);
        await page.keyboard.press("Control+c");
        const copiedText = await page.evaluate(() =>
          (globalThis as any).navigator.clipboard.readText(),
        );
        expect(copiedText.split("\n")).toContain(keyboardQuote);
        await page.locator(".msg.assistant .content").first().selectText();
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
        expect(await page.locator(".report-comment").count()).toBe(0);
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
    await checkArtifactCommentSend(browser, base);
  },
  // Feature: #3365 iframe releases, pointer cancellation and keyboard input cannot leave another window unselectable.
  async function test_selection_recovers_after_interrupted_drag(browser, base) {
    const quote = "Keyboard copying after an iframe release.";
    const item = await postFixture(base, "seed-pane-reading", {
      markdown: [
        "# Gesture recovery",
        quote,
        "```html-embed\n<p>Sealed selection target.</p>\n```",
      ].join("\n\n"),
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await gotoRoot(page, base);
      const source = "Start a selection in Chat.";
      await page.locator("#input").fill(`Reply only ${source}`);
      await page.locator("#input").press("Enter");
      const reply = page.locator(".msg.assistant .content p", {
        hasText: source,
      });
      await reply.waitFor();
      await page.locator(`a[href="#artifact=${item.id}"]`).click();
      const frame = page.locator("iframe.report-embed");
      await page
        .frameLocator("iframe.report-embed")
        .getByText("Sealed selection target.", { exact: true })
        .waitFor();
      expect(await frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(
        await frame.evaluate(
          (element: any) => element.contentDocument === null,
        ),
      ).toBe(true);
      const paragraph = page.locator(".report-doc p", { hasText: quote });
      const startDrag = async () => {
        await page.evaluate(() =>
          (globalThis as any).getSelection().removeAllRanges(),
        );
        await reply.scrollIntoViewIfNeeded();
        const chat = (await reply.boundingBox())!;
        await page.mouse.move(chat.x + 1, chat.y + chat.height / 2);
        await page.mouse.down();
        await page.mouse.move(chat.x + 60, chat.y + chat.height / 2, {
          steps: 4,
        });
        expect(
          await page.evaluate(() =>
            String((globalThis as any).getSelection()).trim(),
          ),
        ).not.toBe("");
      };
      const copyFromPreview = async () => {
        await page.locator('.pane-col[data-pane="report"] .pane-body').focus();
        await page.evaluate(() =>
          (globalThis as any).navigator.clipboard.writeText(
            "Before preview copy",
          ),
        );
        await page.keyboard.press("Control+a");
        const selected = await page.evaluate(() =>
          String((globalThis as any).getSelection()),
        );
        expect(selected.split("\n")).toContain(quote);
        await page.keyboard.press("Control+c");
        const copied = await page.evaluate(() =>
          (globalThis as any).navigator.clipboard.readText(),
        );
        expect(copied.split("\n")).toContain(quote);
      };
      await startDrag();
      const preview = (await frame.boundingBox())!;
      await page.mouse.move(
        preview.x + preview.width / 2,
        preview.y + preview.height / 2,
        { steps: 12 },
      );
      await page.mouse.up();
      await copyFromPreview();

      await page.evaluate(() =>
        (globalThis as any).getSelection().removeAllRanges(),
      );
      const touch = await context.newCDPSession(page);
      await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await reply.scrollIntoViewIfNeeded();
      const chat = (await reply.boundingBox())!;
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: chat.x + 10, y: chat.y + chat.height / 2 }],
      });
      await page.locator("body.dock-selection-scoped").waitFor();
      await paragraph.selectText();
      expect(
        await page.evaluate(() => String((globalThis as any).getSelection())),
      ).toBe("");
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchCancel",
        touchPoints: [],
      });
      await page.waitForFunction(
        (expected: string) =>
          String((globalThis as any).getSelection()).trim() === expected,
        quote,
      );
      await touch.send("Emulation.setTouchEmulationEnabled", {
        enabled: false,
      });
      await touch.detach();
      await copyFromPreview();

      await startDrag();
      await copyFromPreview();
      await page.mouse.up();
      expect(errors).toEqual([]);
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
  // Regression: #3641 an Artifact comment stays anchored when the dock moves its pane at phone width.
  async function test_artifact_comment_draft_survives_resize(browser, base) {
    const quote = "Keep this selected text";
    const note = "This draft survives the resize.";
    const { id } = await postFixture(base, "seed-pane-reading", {
      markdown: `# Resize draft\n\nBefore. ${quote}. After.`,
    });
    const { page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 844 },
      touch: true,
    });
    await gotoRoot(page, base);
    await page.locator('.rail-btn[data-pane="tips"]').click();
    await page.locator(`a[href="#artifact=${id}"]`).click();
    const report = '.pane-col[data-pane="report"]';
    const doc = page.locator(`#dock ${report} .report-doc`, {
      hasText: quote,
    });
    await doc.waitFor();
    await dispatchArtifactSelection(page, "touch", quote, doc);
    const popover = page.locator(".report-comment-popover");
    const field = popover.locator("textarea");
    await field.fill(note);
    await field.evaluate((element: any) => element.setSelectionRange(2, 9));
    await screenshot(page, "artifact-comment-draft-desktop");
    await page.setViewportSize({ width: 412, height: 844 });
    const phone = page.locator(`${report}.mobile-active`);
    await phone.waitFor();
    await browserExpect(popover).toBeVisible();
    await browserExpect(field).toBeFocused();
    await browserExpect(field).toHaveValue(note);
    expect(
      await field.evaluate((element: any) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([2, 9]);
    await screenshot(page, "artifact-comment-draft-phone");
    await popover.getByRole("button", { name: "Comment", exact: true }).click();
    await browserExpect(
      phone.locator(".report-doc mark.report-cmark"),
    ).toHaveText(quote);
    await browserExpect(phone.locator(".report-comment-text")).toHaveText(note);
    expect(errors).toEqual([]);
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
