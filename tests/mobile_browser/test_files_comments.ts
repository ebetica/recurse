import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  dispatchArtifactSelection,
  postFixture,
  runBrowserTests,
  waitForLayout,
  type BrowserTest,
} from "./common";
import {
  filePage,
  fileShot,
  filesSurface,
  showFilesList,
  openListedFile,
  type Fixture,
} from "./files_support";

export const tests: BrowserTest[] = [
  // Feature: #2666 selected text in a Files text preview stages Artifact-style comments; #3365 desktop drags stay in their starting window without breaking comment anchors.
  async function test_text_file_selection_comments(browser, base) {
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    for (const width of [1280, 412]) {
      const mobile = width === 412;
      const { context, page, errors } = await filePage(
        browser,
        width,
        844,
        mobile,
      );
      await page.goto(`${base}#agent=${fixture.demo}`, {
        waitUntil: "domcontentloaded",
      });
      if (mobile) {
        const menu = page.locator('.pane-menu-item[data-pane="files"]');
        await page.waitForFunction(
          `(/Files \\(\\d+\\)/).test(document.querySelector('.pane-menu-item[data-pane="files"]')?.textContent || '')`,
        );
        const more = page.locator("#pane-fab");
        expect(await more.getAttribute("aria-label")).toBe("More actions");
        expect(await more.getAttribute("title")).toBe("More actions");
        expect(await more.locator(".badge").count()).toBe(0);
        await more.click();
        expect(await menu.innerText()).toMatch(/Files \(\d+\)/);
        await menu.click();
      } else {
        await page
          .locator("#input")
          .fill("Reply only Window selection stays in Chat.");
        await page.locator("#input").press("Enter");
        await page
          .locator(".msg.assistant .content", {
            hasText: "Window selection stays in Chat.",
          })
          .waitFor();
        await page.locator('.rail-btn[data-pane="files"]').click();
      }
      let pane = filesSurface(page);
      await openListedFile(page, "browser-notes.txt");
      const text = pane.locator(".files-detail pre", {
        hasText: "bounded browser text preview",
      });
      await text.waitFor();
      if (!mobile) {
        await page.locator(".pane-col.file-tab:visible .pane-body").focus();
        await page.keyboard.press("w");
        await page.keyboard.press("l");
        await waitForLayout(page);
        const reply = page.locator(".msg.assistant .content p", {
          hasText: "Window selection stays in Chat.",
        });
        const chat = (await reply.boundingBox())!;
        const file = (await text.boundingBox())!;
        await page.mouse.move(chat.x + 1, chat.y + chat.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          file.x + file.width - 2,
          file.y + file.height / 2,
          { steps: 20 },
        );
        await page.mouse.up();
        const selected = await page.evaluate(() =>
          String((globalThis as any).getSelection()).trim(),
        );
        expect(selected).not.toBe("");
        expect(
          await page.locator('.dock-panel[data-dock-panel="chat"]').innerText(),
        ).toContain(selected);
        expect(selected).not.toContain("bounded browser text preview");
        await page.keyboard.down("Shift");
        await page.mouse.move(file.x + 1, file.y + file.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          file.x + file.width - 2,
          file.y + file.height / 2,
          { steps: 8 },
        );
        await page.mouse.up();
        await page.keyboard.up("Shift");
        const shifted = await text.evaluate((pre: any) => {
          const selection = pre.ownerDocument.getSelection();
          const range = selection.getRangeAt(0);
          const root = pre.closest(".dock-panel");
          return {
            text: selection.toString(),
            inside:
              root.contains(range.startContainer) &&
              root.contains(range.endContainer),
          };
        });
        expect(shifted.inside).toBe(true);
        expect(shifted.text).toContain("bounded browser text preview");
        expect(shifted.text).not.toContain("Window selection stays in Chat.");
        await page.evaluate(() =>
          (globalThis as any).getSelection().removeAllRanges(),
        );
        const tab = (await page
          .locator('.dv-tab[data-dock-panel="chat"] .dv-default-tab-content')
          .boundingBox())!;
        await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          chat.x + chat.width / 2,
          chat.y + chat.height / 2,
          { steps: 12 },
        );
        await page.mouse.up();
        expect(
          await page.evaluate(() => String((globalThis as any).getSelection())),
        ).toBe("");
        await page.mouse.move(file.x + 2, file.y + file.height / 2);
        await page.mouse.down();
        await page.mouse.move(file.x + 60, file.y + file.height / 2, {
          steps: 4,
        });
        const composer = page.locator("#input");
        await composer.fill("Window editor remains editable");
        await composer.press("Control+A");
        await page.keyboard.insertText("Replaced draft");
        expect(await composer.inputValue()).toBe("Replaced draft");
        await composer.fill("");
        await page.mouse.up();
        const heading = page.locator(".tree-section-toggle").first();
        await heading.selectText();
        expect(
          await page.evaluate(() =>
            String((globalThis as any).getSelection()).trim(),
          ),
        ).toBe(
          (
            await heading
              .locator(".tree-section-title, .tree-section-count")
              .allInnerTexts()
          ).join("\n"),
        );
      }
      if (mobile) await dispatchArtifactSelection(page, "touch", "bounded");
      else {
        const range = await text.evaluate((pre: any) => {
          const node = pre.ownerDocument.createTreeWalker(pre, 4).nextNode();
          const range = pre.ownerDocument.createRange();
          const start = node.textContent.lastIndexOf("bounded");
          range.setStart(node, start);
          range.setEnd(node, start + "bounded".length);
          const rect = range.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            y: (rect.top + rect.bottom) / 2,
          };
        });
        await page.mouse.move(range.left + 1, range.y);
        await page.mouse.down();
        await page.mouse.move(range.right - 1, range.y, { steps: 8 });
        await page.mouse.up();
      }
      const popover = page.locator(".report-comment-popover");
      await popover.waitFor();
      await popover.locator("textarea").fill(`Explain this at ${width}`);
      await popover.getByRole("button", { name: "Comment" }).click();
      const card = pane.locator(".report-comment");
      await card.waitFor();
      expect(await card.locator("blockquote").textContent()).toBe("bounded");
      expect(await pane.locator("mark.report-cmark").textContent()).toBe(
        "bounded",
      );
      await fileShot(page, `files-text-comment-${width}.png`);
      let originalTabId: string | null = null;
      let longLine: string | undefined;
      if (!mobile) {
        originalTabId = await page
          .locator(".pane-col.file-tab")
          .filter({
            has: page.getByRole("article", {
              name: "browser-notes.txt",
              exact: true,
            }),
          })
          .getAttribute("data-pane");
        longLine = (await text.textContent())!.split("\n")[2]!;
        await dispatchArtifactSelection(page, "mouse", longLine, text);
        await popover.locator("textarea").fill("Explain this whole line");
        await popover.getByRole("button", { name: "Comment" }).click();
        await showFilesList(page);
        await openListedFile(page, "browser-image.png");
        const imageTab = page.locator(".pane-col.file-tab").filter({
          has: page.getByRole("article", { name: "browser-image.png" }),
        });
        const id = await imageTab.getAttribute("data-pane");
        pane = page.locator(`.pane-col[data-pane="${id}"]`);
        await pane.getByRole("button", { name: "Previous file" }).click();
        await browserExpect(pane.locator("mark.report-cmark")).toHaveText([
          "bounded",
          longLine,
        ]);
      }
      const delivered = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${fixture.demo}/deliver`),
      );
      await pane.getByRole("button", { name: "Submit comments" }).click();
      const content = (await delivered).postDataJSON().content as string;
      const [heading, ...notes] = content.split("\n\n");
      expect(heading).toMatch(
        /^Comments on file "browser-notes\.txt" \(id: [^)\s]+\):$/,
      );
      const location = mobile ? "line 1, chars 0-7" : "line 2, chars 29-36";
      const expectedNotes = [
        `- ${location}:\n> bounded\nExplain this at ${width}`,
      ];
      if (longLine)
        expectedNotes.push(
          `- line 3, chars 43-${43 + longLine.length}:\n> ${longLine.slice(0, 600)}\nExplain this whole line`,
        );
      expect(notes).toEqual(expectedNotes);
      if (!mobile) {
        await page
          .locator(`.dv-tab[data-dock-panel="${originalTabId}"]`)
          .click();
        pane = page.locator(`.pane-col[data-pane="${originalTabId}"]`);
        await browserExpect(pane).toBeVisible();
      }
      await browserExpect(pane.locator(".report-comment")).toHaveCount(0);
      await browserExpect(pane.locator("mark.report-cmark")).toHaveCount(0);
      expect(errors).toEqual([]);
      await context.close();
    }
    const { demo } = await postFixture(base, "seed-published-diff");
    const { context, page, errors } = await filePage(browser, 1280, 844);
    await page.goto(`${base}#agent=${demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("button", { name: "Open review.diff in Files" })
      .click();
    await filesSurface(page)
      .locator(".files-detail .files-diff .diff-row.add")
      .first()
      .waitFor();
    await dispatchArtifactSelection(page, "mouse", "++ new");
    const popover = page.locator(".report-comment-popover");
    await popover.locator("textarea").fill("Why add this?");
    await popover.getByRole("button", { name: "Comment" }).click();
    expect(
      await page.locator(".files-detail mark.report-cmark").textContent(),
    ).toBe("++ new");
    for (const [name, marks] of [
      ["review.patch", 0],
      ["review.diff", 1],
    ] as const) {
      await showFilesList(page);
      await openListedFile(page, name);
      await filesSurface(page)
        .locator(".files-detail .files-diff .diff-row.add")
        .first()
        .waitFor();
      await page.waitForFunction(
        ([detail, marks]: any) =>
          detail.querySelectorAll("mark.report-cmark").length === marks,
        [
          await filesSurface(page).locator(".files-detail").elementHandle(),
          marks,
        ],
      );
    }
    expect(await page.locator(".report-comment blockquote").textContent()).toBe(
      "++ new",
    );
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/conversations/${demo}/deliver`, async (route) => {
      await held;
      await route.continue();
    });
    const delivered = page.waitForResponse((response) =>
      response.url().endsWith(`/api/conversations/${demo}/deliver`),
    );
    const origin = (await page
      .locator(".pane-col.file-tab:visible")
      .getAttribute("data-pane"))!;
    await page.getByRole("button", { name: "Submit comments" }).click();
    await page.locator("[data-comment-send]").getByRole("status").waitFor();
    await page
      .locator(`.pane-col[data-pane="${origin}"] .report-bar`)
      .waitFor({ state: "hidden" });
    release();
    expect((await delivered).ok()).toBeTrue();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2693 Files touch taps need a hint and holds need visible feedback without breaking navigation.
  async function test_files_touch_scroll_pinch_and_pan(browser, base) {
    const { demo } = await postFixture(base, "seed-published-pdf");
    const { context, page, errors } = await filePage(browser, 412, 844, true);
    try {
      await page.goto(`${base}#agent=${demo}`);
      await page.getByRole("button", { name: "Open long.pdf in Files" }).tap();
      const pane = filesSurface(page);
      const detail = pane.locator(".files-detail");
      const touch = await context.newCDPSession(page);
      const drag = async (x: number, y: number, dx: number, dy: number) => {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let step = 1; step <= 10; step++)
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: x + (dx * step) / 10, y: y + (dy * step) / 10 }],
          });
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      };
      await page.evaluate(
        `document.addEventListener('touchstart', event => window.__filesGestureTargets?.push(!!event.target.closest('.report-box-frame')));`,
      );
      for (const kind of ["pdf", "image"]) {
        if (kind === "image") {
          const printer = await browser.newPage({
            viewport: { width: 400, height: 1400 },
          });
          await printer.setContent(
            '<body style="margin:0;background:linear-gradient(red,blue);height:1400px"><h1>Scrollable image</h1></body>',
          );
          const buffer = await printer.screenshot();
          await printer.close();
          await page.locator("#file-input").setInputFiles({
            name: "scrollable.png",
            mimeType: "image/png",
            buffer,
          });
          await page
            .locator('.attach-chip img[alt="scrollable.png"]')
            .waitFor({ state: "attached" });
          await pane.getByRole("button", { name: "All files" }).tap();
          await pane
            .getByRole("button", { name: "Open scrollable.png", exact: true })
            .tap();
          await page
            .locator("dialog.image-popout")
            .getByRole("button", { name: "Open in Files" })
            .tap();
          await page.waitForFunction(
            "document.querySelector('.files-detail img')?.naturalHeight === 1400",
          );
        } else {
          await pane
            .locator('.files-pdf-page[data-drawn="true"]')
            .first()
            .waitFor();
        }
        const frame = pane.locator(".report-box-frame").first();
        const scroll = await frame.evaluateHandle((element) => {
          for (let at: any = element.parentElement; at; at = at.parentElement)
            if (
              at.scrollHeight > at.clientHeight &&
              /auto|scroll/.test(
                (globalThis as any).getComputedStyle(at).overflowY,
              )
            )
              return at;
          if (element.closest(".image-zoom-viewport"))
            return element.closest(".pane-body");
          throw Error("No real Files scroll container");
        });
        const tap = (await frame.boundingBox())!;
        const at = {
          x: tap.x + tap.width / 2,
          y: Math.min(tap.y + tap.height / 2, 500),
        };
        await page.touchscreen.tap(at.x, at.y);
        await pane.locator(".files-box-hint").waitFor();
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        await fileShot(page, `files-${kind}-tap-hint.png`);
        await pane.locator(".files-box-hint").waitFor({ state: "detached" });
        await page.mouse.click(at.x, at.y);
        expect(await pane.locator(".files-box-hint").count()).toBe(0);
        await page.evaluate(
          `document.addEventListener('pointerdown', event => window.__filesHoldPointer = event.pointerId, { once: true });`,
        );
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [at],
        });
        const start = frame.locator("mark.files-box-start");
        await start.waitFor();
        const startBox = (await start.boundingBox())!;
        expect(startBox.width).toBeGreaterThanOrEqual(16);
        expect(startBox.height).toBeGreaterThanOrEqual(16);
        expect(
          await frame.evaluate((element) =>
            element.hasPointerCapture((globalThis as any).__filesHoldPointer),
          ),
        ).toBeTrue();
        await fileShot(page, `files-${kind}-hold-start.png`);
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        if (kind === "image") {
          expect((await frame.boundingBox())!.height).toBeLessThanOrEqual(
            844 * 0.65,
          );
          expect(await page.evaluate<number>("visualViewport.scale")).toBe(1);
          await scroll.dispose();
          continue;
        }
        const before = await scroll.evaluate(
          (element: any) => element.scrollTop,
        );
        const box = (await frame.boundingBox())!;
        const x = box.x + box.width / 2;
        const y = Math.min(box.y + box.height / 2, 650);
        const name = await detail.getAttribute("aria-label");
        await page.evaluate("window.__filesGestureTargets = []");
        await drag(x, y, 0, -180);
        await page.waitForFunction(
          ({ element, before }: any) => element.scrollTop > before + 50,
          { element: scroll, before },
        );
        expect(await detail.getAttribute("aria-label")).toBe(name);
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        await fileShot(page, `files-${kind}-touch-scroll.png`);
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            { x: 166, y: 420, id: 1 },
            { x: 246, y: 420, id: 2 },
          ],
        });
        for (let step = 1; step <= 10; step++)
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              { x: 166 - step * 8, y: 420, id: 1 },
              { x: 246 + step * 8, y: 420, id: 2 },
            ],
          });
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await page.waitForFunction("visualViewport.scale > 1.5");
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        const left = await page.evaluate<number>("visualViewport.offsetLeft");
        await drag(280, 420, -100, 0);
        await page.waitForFunction(
          (left) => (globalThis as any).visualViewport.offsetLeft > left + 20,
          left,
        );
        expect(await detail.getAttribute("aria-label")).toBe(name);
        expect(
          await page.evaluate<boolean[]>("window.__filesGestureTargets"),
        ).toEqual([true, true, true, true]);
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        expect(
          await page.locator(".report-comment-popover:visible").count(),
        ).toBe(0);
        await fileShot(page, `files-${kind}-pinch-pan.png`);
        await touch.send("Emulation.setPageScaleFactor", {
          pageScaleFactor: 1,
        });
        await page.waitForFunction("visualViewport.scale <= 1.01");
        await scroll.dispose();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  // Feature: #2667 a box drawn on a Files image or PDF page stages an Artifact-style comment.
  async function test_box_comments_on_images_and_pdf_pages(browser, base) {
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    const desktop = await filePage(browser, 1280, 844);
    let { page, errors } = desktop;
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator('.rail-btn[data-pane="files"]').click();
    let pane = filesSurface(page);
    await openListedFile(page, "browser-image.png");
    pane = page.locator(".pane-col.file-tab:visible");
    const drawImageBox = async () => {
      await page.waitForFunction(
        "document.querySelector('.files-detail img')?.naturalWidth > 0",
      );
      const image = (await pane.locator(".files-image-frame").boundingBox())!;
      await page.mouse.move(
        image.x + image.width * 0.2,
        image.y + image.height * 0.25,
      );
      await page.keyboard.down("Control");
      await page.mouse.down();
      await page.mouse.move(
        image.x + image.width * 0.6,
        image.y + image.height * 0.75,
        { steps: 8 },
      );
      await page.mouse.up();
      await page.keyboard.up("Control");
    };
    await drawImageBox();
    let popover = page.locator(".report-comment-popover");
    await popover.waitFor();
    await popover.locator("textarea").fill("Unsent draft");
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    expect(await pane.locator(".report-comment-input").inputValue()).toBe(
      "Unsent draft",
    );
    await page.keyboard.press("Escape");
    await pane.waitFor({ state: "detached" });
    await openListedFile(page, "browser-image.png");
    pane = page.locator(".pane-col.file-tab:visible");
    await pane
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    await pane.locator(".report-comment-input").waitFor();
    expect(await pane.locator(".report-comment-input").inputValue()).toBe(
      "Unsent draft",
    );
    await pane.locator(".report-comment-del").click();
    await drawImageBox();
    await popover.locator("textarea").fill("Unsent draft");
    await pane.getByRole("button", { name: "Previous file" }).click();
    await popover.waitFor({ state: "hidden" });
    await pane.getByRole("button", { name: "Next file" }).click();
    await pane
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    expect(await popover.isHidden()).toBeTrue();
    expect(await pane.locator("mark.report-cbox").count()).toBe(1);
    expect(await pane.locator(".report-comment-input").inputValue()).toBe(
      "Unsent draft",
    );
    const originalId = await pane.getAttribute("data-pane");
    await showFilesList(page);
    await openListedFile(page, "browser-notes.txt");
    await pane.getByRole("button", { name: "Next file" }).click();
    await browserExpect(pane.locator("mark.report-cbox")).toHaveCount(1);
    await pane.locator(".report-comment-del").click();
    await page.locator(`.dv-tab[data-dock-panel="${originalId}"]`).click();
    await browserExpect(pane).toHaveAttribute("data-pane", originalId!);
    await browserExpect(pane.locator("mark.report-cbox")).toHaveCount(0);
    await drawImageBox();
    await popover.waitFor();
    await popover.locator("textarea").fill("Crop this");
    await popover.getByRole("button", { name: "Comment" }).click();
    expect(await pane.locator(".report-comment blockquote").textContent()).toBe(
      "Box on image",
    );
    await pane.getByRole("button", { name: "Previous file" }).click();
    await pane
      .locator('.files-detail[aria-label="browser-notes.txt"]')
      .waitFor();
    expect(await pane.locator("mark.report-cbox").count()).toBe(0);
    let dismissed: string | undefined;
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      dismissed = message;
    });
    await page.locator(`.agent[data-id="${fixture.empty}"]`).click();
    await browserExpect
      .poll(() => dismissed)
      .toContain("You have 1 unsent comment.");
    await browserExpect(page).toHaveURL(`${base}#agent=${fixture.demo}`);
    await pane.getByRole("button", { name: "Next file" }).click();
    await pane.locator(".files-image-frame mark.report-cbox").waitFor();
    await browserExpect(pane.locator(".report-comment-input")).toHaveValue(
      "Crop this",
    );
    await drawImageBox();
    await popover.locator("textarea").fill("Another region");
    await popover.getByRole("button", { name: "Comment" }).click();
    await page.route(`${base}api/attachments`, (route) =>
      route.request().postData()?.includes("browser-image-box-2.jpg")
        ? route.fulfill({ status: 503, json: { error: "Upload unavailable" } })
        : route.continue(),
    );
    const cleanup = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/attachment-crops/"),
    );
    const natural = await pane
      .locator(".files-detail img")
      .evaluate((image: any) => ({
        width: image.naturalWidth,
        height: image.naturalHeight,
      }));
    let delivered = page.waitForRequest((request) =>
      request.url().endsWith(`/api/conversations/${fixture.demo}/deliver`),
    );
    await pane.getByRole("button", { name: "Submit comments" }).click();
    const failure = page.locator("[data-comment-send]").getByRole("alert");
    await failure.getByRole("button", { name: "Send without images" }).click();
    let content = (await delivered).postDataJSON().content as string;
    expect((await cleanup).ok()).toBeTrue();
    expect(content).toStartWith('Comments on file "browser-image.png" (id: ');
    expect(content).toContain(":\nCrop this");
    const coordinates = /box 1, x=(\d+) y=(\d+) w=(\d+) h=(\d+) px/.exec(
      content,
    )!;
    for (const [index, expected] of [
      natural.width * 0.2,
      natural.height * 0.25,
      natural.width * 0.4,
      natural.height * 0.5,
    ].entries())
      expect(
        Math.abs(Number(coordinates[index + 1]) - expected),
      ).toBeLessThanOrEqual(1);
    expect(content).toContain(
      `px in the ${natural.width}×${natural.height} original (x,y = top-left)`,
    );
    expect(content).not.toContain("![browser-image-box-1.jpg](");
    expect(errors).toEqual([]);
    await desktop.context.close();

    const { demo } = await postFixture(base, "seed-published-pdf");
    const phone = await filePage(browser, 412, 844, true);
    ({ page, errors } = phone);
    await page.goto(`${base}#agent=${demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Open slides.pdf in Files" }).tap();
    pane = filesSurface(page);
    const frame = pane.locator('.files-pdf-frame[data-page="2"]');
    await frame.scrollIntoViewIfNeeded();
    const position = await pane.locator(".files-position").textContent();
    const box = (await frame.boundingBox())!;
    const touch = await phone.context.newCDPSession(page);
    const at = (x: number, y: number) => [
      { x: box.x + box.width * x, y: box.y + box.height * y },
    ];
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: at(0.1, 0.2),
    });
    await frame.locator("mark.report-cbox").waitFor({ state: "attached" });
    for (let step = 1; step <= 10; step++)
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: at(0.1 + step * 0.06, 0.2 + step * 0.03),
      });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    popover = page.locator(".report-comment-popover");
    await popover.waitFor();
    expect(await pane.locator(".files-position").textContent()).toBe(position);
    await popover.locator("textarea").fill("Label this");
    await popover.getByRole("button", { name: "Comment" }).tap();
    expect(await pane.locator(".report-comment blockquote").textContent()).toBe(
      "Box on page 2",
    );
    await fileShot(page, `files-box-comment-412.png`);
    delivered = page.waitForRequest((request) =>
      request.url().endsWith(`/api/conversations/${demo}/deliver`),
    );
    await pane.getByRole("button", { name: "Submit comments" }).tap();
    content = (await delivered).postDataJSON().content as string;
    expect(content).toStartWith('Comments on file "slides.pdf" (id: ');
    expect(content).toContain(
      "- box 1 (page 2), x=0.10 y=0.20 w=0.60 h=0.30 (fractions of width and height; x,y = top-left), attached as slides-box-1.jpg:",
    );
    expect(content).toContain("Label this");
    expect(content).toContain("![slides-box-1.jpg](");
    const cropUrl = /!\[slides-box-1\.jpg\]\(([^)]+)\)/.exec(content)![1]!;
    const crop = await page.evaluate(async (url) => {
      const image = new (globalThis as any).Image();
      image.src = /^\/api\/conversations\/[^/]+\/attachments\/[^/]+$/.test(url)
        ? `${url}/preview`
        : url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, cropUrl);
    expect(Math.abs(crop.width - 360)).toBeLessThanOrEqual(2);
    expect(Math.abs(crop.height - 120)).toBeLessThanOrEqual(2);
    expect(content).not.toContain("box x=");
    await pane.locator("mark.report-cbox").waitFor({ state: "detached" });
    expect(errors).toEqual([]);
    await phone.context.close();
  },
  // Feature: #3380 the latest Markdown version highlights what is new since it was last reviewed.
  async function test_markdown_changes_since_reviewed(browser, base) {
    const agent = "files-document-review";
    const plan = (count: string, extra = "") =>
      `# Plan\n\nThere are ${count} decisions left.\n\nKeep this paragraph as it is.\n${extra}`;
    await postFixture(base, "publish-document-review", {
      agent,
      text: plan("three"),
    });
    for (const [width, count, note] of [
      [1280, "two", "A note for the wide screen."],
      [390, "one", "One more line for phones."],
    ] as const) {
      const mobile = width === 390;
      const { context, page, errors } = await filePage(
        browser,
        width,
        844,
        mobile,
      );
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      if (mobile) {
        const menu = page.locator('.pane-menu-item[data-pane="files"]');
        await menu.waitFor({ state: "attached" });
        await page.locator("#pane-fab").click();
        await menu.click();
      } else await page.locator('.rail-btn[data-pane="files"]').click();
      const pane = filesSurface(page);
      const doc = pane.locator(".files-markdown");
      await openListedFile(page, "plan.md");
      await doc.locator("p", { hasText: "Keep this paragraph" }).waitFor();
      expect(await pane.locator(".doc-changes").count()).toBe(0);
      await postFixture(base, "publish-document-review", {
        agent,
        text: plan(count, `\n${note}\n`),
      });
      if (!mobile) {
        await showFilesList(page);
        await pane
          .locator('.files-card[aria-label="plan.md"]', {
            hasText: "2 versions",
          })
          .waitFor();
        await openListedFile(page, "plan.md");
      }
      await doc.locator("p.doc-diff-added", { hasText: note }).waitFor();
      expect(await doc.locator("ins.doc-diff-added").allTextContents()).toEqual(
        [count],
      );
      expect(await doc.innerText()).not.toContain(
        mobile ? "A note for the wide screen." : "three",
      );
      const header = pane.locator(".doc-changes");
      expect(await header.innerText()).toStartWith("New since");
      expect(
        await header
          .locator("select")
          .evaluate((select: any) => select.selectedOptions[0].label),
      ).toStartWith(`Version ${mobile ? 2 : 1} · `);
      await fileShot(page, `files-markdown-changes-${width}.png`);
      const reviewed = pane.getByRole("button", {
        name: "Reviewed",
        exact: true,
      });
      if (mobile) {
        await reviewed.scrollIntoViewIfNeeded();
        expect(
          await reviewed.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            const round = rect.height / 2;
            return [
              [rect.left + round, rect.top + 2],
              [rect.right - round, rect.top + 2],
              [rect.left + round, rect.bottom - 2],
              [rect.right - round, rect.bottom - 2],
            ].map(([x, y]) =>
              button.contains(button.ownerDocument.elementFromPoint(x!, y!)),
            );
          }),
        ).toEqual([true, true, true, true]);
        await fileShot(page, `files-markdown-reviewed-button-${width}.png`);
        await reviewed.click();
        await header.waitFor({ state: "detached" });
      } else {
        for (const highlighted of [true, false]) {
          expect(await doc.locator("ins.doc-diff-added").count()).toBe(
            highlighted ? 1 : 0,
          );
          await dispatchArtifactSelection(
            page,
            "mouse",
            "are two decisions",
            doc,
          );
          const popover = page.locator(".report-comment-popover");
          await popover.locator("textarea").fill("Check this decision count");
          await popover.getByRole("button", { name: "Comment" }).click();
          expect(
            await pane.locator(".report-comment blockquote").textContent(),
          ).toBe("are two decisions");
          expect(
            (await doc.locator("mark.report-cmark").allTextContents()).join(""),
          ).toBe("are two decisions");
          const delivered = page.waitForRequest((request) =>
            request.url().endsWith(`/api/conversations/${agent}/deliver`),
          );
          await pane.getByRole("button", { name: "Submit comments" }).click();
          expect((await delivered).postDataJSON().content).toEndWith(
            "- line 2, chars 11-28:\n> are two decisions\nCheck this decision count",
          );
          await showFilesList(page);
          await openListedFile(page, "plan.md");
          await doc.locator("p", { hasText: note }).waitFor();
        }
      }
      await doc.locator("p", { hasText: note }).waitFor();
      expect(await doc.locator(".doc-diff-added").count()).toBe(0);
      expect(await pane.locator(".doc-changes").count()).toBe(0);
      expect(errors).toEqual([]);
      await context.close();
    }

    const owner = "artifact-document-review";
    const older = await postFixture(base, "publish-review-artifact", {
      agent: owner,
      markdown: plan("two"),
    });
    const seen = await postFixture(base, "publish-review-artifact", {
      agent: owner,
      id: older.id,
      markdown: plan("three"),
    });
    const { context, page, errors } = await filePage(browser, 1280, 844);
    await page.goto(`${base}#agent=${owner}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator('.rail-btn[data-pane="report"]').click();
    const doc = page.locator(".report-doc");
    await doc.locator("p", { hasText: "Keep this paragraph" }).waitFor();
    expect(await page.locator(".doc-changes").count()).toBe(0);
    await postFixture(base, "publish-review-artifact", {
      agent: owner,
      id: older.id,
      markdown: plan("two", "\nA note for the wide screen.\n"),
    });
    await page.evaluate((agentId) => {
      const browser = globalThis as any;
      browser.dispatchEvent(
        new browser.CustomEvent("recurse:ui-refresh", { detail: { agentId } }),
      );
    }, owner);
    await doc
      .locator("p.doc-diff-added", { hasText: "A note for the wide screen." })
      .waitFor();
    expect(await doc.locator("ins.doc-diff-added").allTextContents()).toEqual([
      "two",
    ]);
    const compare = page.locator(".doc-changes select");
    expect(await compare.inputValue()).toBe(seen.version);
    await fileShot(page, "artifact-markdown-changes-1280.png");
    await compare.selectOption(older.version);
    await page.waitForFunction(
      "!document.querySelector('.report-doc ins.doc-diff-added') && !!document.querySelector('.report-doc p.doc-diff-added')",
    );
    await compare.selectOption(seen.version);
    await doc.locator("ins.doc-diff-added", { hasText: "two" }).waitFor();
    for (const highlighted of [true, false]) {
      expect(await doc.locator("ins.doc-diff-added").count()).toBe(
        highlighted ? 1 : 0,
      );
      await dispatchArtifactSelection(page, "mouse", "are two decisions", doc);
      const popover = page.locator(".report-comment-popover");
      await popover.locator("textarea").fill("Check this decision count");
      await popover.getByRole("button", { name: "Comment" }).click();
      expect(
        await page
          .locator(".report-comment .report-comment-quote")
          .textContent(),
      ).toBe("are two decisions");
      expect(
        (await doc.locator("mark.report-cmark").allTextContents()).join(""),
      ).toBe("are two decisions");
      const delivered = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${owner}/deliver`),
      );
      await page.getByRole("button", { name: "Submit comments" }).click();
      expect((await delivered).postDataJSON().content).toEndWith(
        "- line 2, chars 11-28:\n> are two decisions\nCheck this decision count",
      );
      await page.locator(".report-comment").waitFor({ state: "detached" });
    }
    await page.locator(".doc-changes").waitFor({ state: "detached" });
    expect(await doc.locator(".doc-diff-added").count()).toBe(0);
    expect(await doc.innerText()).toContain("A note for the wide screen.");
    expect(errors).toEqual([]);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["files-comments", tests]]);
