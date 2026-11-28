import { expect } from "bun:test";
import { assertSchemeLinks } from "./document_links";
import { SCHEME_LINKS } from "./fixtures/reference_links";
import { expect as browserExpect, type Locator } from "playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchArtifactSelection,
  expectHitCorners,
  gotoRoot,
  mockConversation,
  postFixture,
  rootAgentId,
  runBrowserTests,
  turn,
  waitForLayout,
  type BrowserTest,
  MERMAID_DIAGRAM,
} from "./common";

type TraversalObserver = Window & { diagramTraversals?: boolean[] };

async function expectReadableTables(content: Locator) {
  const tables = content.locator(".table-scroll");
  await browserExpect(tables).toHaveCount(2);
  await browserExpect(
    tables.first().getByText("The report is ready for a second reader."),
  ).toBeVisible();
  await tables
    .last()
    .getByText(
      "Tell the requester where to find the report and related files.",
      { exact: true },
    )
    .waitFor();
  const [narrow, wide] = await tables.evaluateAll((wrappers) =>
    wrappers.map((wrapper) => {
      const lines = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      };
      const rows = wrapper.querySelector("table")!.rows;
      return {
        overflow: wrapper.scrollWidth - wrapper.clientWidth,
        headers: Array.from(rows[0]!.cells, lines),
        cells: Array.from(rows[1]!.cells, (cell) => ({
          lines: lines(cell),
          width: Math.round(cell.getBoundingClientRect().width),
          minimum: Math.round(12 * parseFloat(getComputedStyle(cell).fontSize)),
        })),
        codeLines: rows[2] ? lines(rows[2].querySelector("code")!) : null,
      };
    }),
  );
  expect(narrow!.overflow).toBeLessThanOrEqual(0);
  expect(narrow!.cells[0]!.lines).toBe(1);
  expect(narrow!.cells[1]!.lines).toBe(1);
  expect(narrow!.cells[2]!.lines).toBeGreaterThan(1);
  expect(narrow!.codeLines).toBeGreaterThan(1);
  expect(wide!.overflow).toBeGreaterThan(0);
  expect(wide!.headers[0]).toBeGreaterThan(1);
  expect(wide!.cells).toHaveLength(8);
  for (const cell of wide!.cells) {
    expect(cell.width).toBeGreaterThanOrEqual(cell.minimum);
    expect(cell.lines).toBeGreaterThan(1);
  }
  return tables;
}

async function expectTableScrolls(wrapper: Locator) {
  await wrapper.hover();
  const start = await wrapper.evaluate((element) => element.scrollLeft);
  await wrapper.page().mouse.wheel(120, 0);
  await browserExpect
    .poll(() => wrapper.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(start);
}

export const tests: BrowserTest[] = [
  // Regression: #3568 wrap Markdown tables before scrolling; preserve #3550 diagram zoom and pan; #3737 colour ts code blocks (5ed7717ef: data-source-syntax was unset).
  async function test_mermaid_zoom_in_reply_and_document(browser, base) {
    const directory = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
    if (directory) await mkdir(directory, { recursive: true });
    const markdown = await Bun.file(
      join(import.meta.dir, "fixtures/wide_mermaid.md"),
    ).text();
    for (const width of [390, 1280]) {
      const phone = width === 390;
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: phone,
        hasTouch: phone,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      if (phone)
        await page.addInitScript(() => {
          window.addEventListener("popstate", ({ state }) => {
            (window as TraversalObserver).diagramTraversals?.push(
              Boolean(state?.phoneViewer),
            );
          });
        });
      const shot = (name: string) =>
        directory &&
        page.screenshot({ path: `${directory}/${width}-${name}.png` });
      const themeUrl = `${base}api/settings/theme`;
      const originalTheme =
        phone && directory
          ? await (await page.request.get(themeUrl)).json()
          : null;
      if (originalTheme)
        await page.request.post(themeUrl, { data: { theme: "GitHub Light" } });
      const { agent } = await postFixture(base, "seed-mermaid-reply");
      if (phone) await page.goto(`${base}#agent=${agent}`);
      else {
        await gotoRoot(page, base);
        await page.locator(`.agent[data-id="${agent}"]`).click();
      }
      await page
        .locator("#input:enabled")
        .fill("Show how a request becomes a report.");
      await page.locator("#send").click();
      const content = page.locator(".msg.assistant .content");
      const reply = content.locator(".mermaid-host");
      await waitForLayout(page);
      const tables = await expectReadableTables(content);
      const typed = content.locator(".code-wrap pre code.language-ts");
      await browserExpect(typed).toHaveAttribute(
        "data-source-syntax",
        "highlighted",
      );
      const colour = (locator: Locator) =>
        locator.evaluate((element) => getComputedStyle(element).color);
      expect(await colour(typed.locator(".hljs-keyword"))).not.toBe(
        await colour(typed),
      );
      const plain = content.locator(".code-wrap pre code").last();
      expect(await plain.textContent()).toBe("const plain = 1;\n");
      expect(await plain.locator(".source-token").count()).toBe(0);
      const typedWrap = content.locator(".code-wrap", {
        has: page.locator("code.language-ts"),
      });
      await typedWrap.getByRole("button", { name: "Copy code" }).click();
      await typedWrap.getByRole("button", { name: "Code copied" }).waitFor();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        "const answer = 42;\n",
      );
      if (directory) {
        await tables.first().scrollIntoViewIfNeeded();
        await shot("chat-tables");
      }
      await expectTableScrolls(tables.last());
      const svg = reply.locator(MERMAID_DIAGRAM);
      await svg.scrollIntoViewIfNeeded();
      expect(
        await svg.evaluate((element) => {
          const { right, top, height } = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            right - 18,
            top + Math.min(height / 2, 18),
          );
          return element.contains(hit);
        }),
      ).toBe(true);
      const copy = reply.getByRole("button", { name: "Copy code" });
      const open = reply.getByRole("button", { name: "Open diagram" });
      if (phone) {
        await expectHitCorners(copy);
        await expectHitCorners(open);
      }
      await shot("thread");
      await copy.click();
      await reply.getByRole("button", { name: "Code copied" }).waitFor();
      expect(
        await page.evaluate(() => navigator.clipboard.readText()),
      ).toContain("F[Validate request]");
      const priorHistoryLength = await page.evaluate(() => history.length);
      if (phone) await open.tap();
      else await open.press("Enter");
      const viewer = page.getByRole("dialog", { name: "Diagram viewer" });
      const canvas = viewer.getByRole("region", { name: "Diagram canvas" });
      const label = canvas.getByText("Validate request", { exact: true });
      const close = viewer.getByRole("button", { name: "Close diagram" });
      await label.waitFor();
      if (!phone)
        expect(await page.evaluate(() => history.length)).toBe(
          priorHistoryLength,
        );
      await browserExpect(close).toBeFocused();
      if (phone)
        for (const name of [
          "Zoom in",
          "Zoom out",
          "Fit diagram",
          "Close diagram",
        ])
          await expectHitCorners(viewer.getByRole("button", { name }));
      await shot("fit");
      const fit = (await label.boundingBox())!;
      const area = (await canvas.boundingBox())!;
      const x = area.x + area.width / 2;
      const y = area.y + area.height / 2;
      const touch = phone ? await context.newCDPSession(page) : undefined;
      const drag = async (start: number[], end: number[]) => {
        if (!touch) {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + end[0]!, y, { steps: 3 });
          await page.mouse.up();
          return;
        }
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: start.map((dx, id) => ({ x: x + dx, y, id })),
        });
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: end.map((dx, id) => ({ x: x + dx, y, id })),
        });
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      };
      if (phone) await drag([-13, 13], [-100, 100]);
      else {
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, -120);
      }
      await browserExpect
        .poll(async () => (await label.boundingBox())!.width)
        .toBeGreaterThan(fit.width * 2);
      await shot("zoomed");
      const zoomed = (await label.boundingBox())!;
      await drag([0], [-60]);
      await browserExpect
        .poll(async () => (await label.boundingBox())!.x)
        .toBeLessThan(zoomed.x);
      await page.keyboard.press("Escape");
      await viewer.waitFor({ state: "hidden" });
      await browserExpect(open).toBeFocused();
      await svg.waitFor();
      if (!phone) {
        await open.click();
        await viewer.waitFor();
        await page.goBack();
        await browserExpect(page).toHaveURL(`${base}#agent=${rootAgentId()}`);
        await viewer.waitFor({ state: "hidden" });
      }

      const owner = `${agent}-artifact`;
      const { id } = await postFixture(base, "publish-review-artifact", {
        agent: owner,
        markdown,
      });
      await page.goto("about:blank");
      await page.goto(`${base}#agent=${owner}&artifact=${id}`);
      const artifact = page.locator('.pane-col[data-pane="report"]');
      const doc = artifact.locator(".report-doc");
      const documentOpen = doc.getByRole("button", { name: "Open diagram" });
      await documentOpen.waitFor();
      await waitForLayout(page);
      const documentTables = await expectReadableTables(doc);
      if (directory && phone) {
        await documentTables.first().scrollIntoViewIfNeeded();
        await shot("artifact-tables");
      }
      const prompts: string[] = [];
      page.on("dialog", async (dialog) => {
        prompts.push(dialog.message());
        await dialog.dismiss();
      });
      const staged = artifact
        .locator(".report-comment")
        .getByText("Check the labels before sharing.");
      if (phone) {
        await dispatchArtifactSelection(
          page,
          "touch",
          "Follow the request from intake through delivery.",
          doc,
        );
        const comment = page.locator(".report-comment-popover:not([hidden])");
        await comment
          .locator("textarea")
          .fill("Check the labels before sharing.");
        await comment.locator(".report-comment-popover-submit").click();
        await staged.waitFor({ state: "attached" });
      }
      await expectTableScrolls(documentTables.last());
      await documentOpen.click();
      await label.waitFor();
      const documentFit = (await label.boundingBox())!;
      const zoomIn = viewer.getByRole("button", { name: "Zoom in" });
      await zoomIn.press("Enter");
      const once = (await label.boundingBox())!.width;
      expect(once).toBeGreaterThan(documentFit.width);
      await zoomIn.press("Enter");
      const twice = (await label.boundingBox())!.width;
      expect(twice).toBeGreaterThan(once);
      await viewer.getByRole("button", { name: "Zoom out" }).click();
      const reduced = (await label.boundingBox())!;
      expect(reduced.width).toBeLessThan(twice);
      expect(reduced.width).toBeGreaterThan(documentFit.width);
      await canvas.press("ArrowRight");
      expect((await label.boundingBox())!.x).toBeLessThan(reduced.x);
      await viewer.getByRole("button", { name: "Fit diagram" }).click();
      const reset = (await label.boundingBox())!;
      for (const key of ["x", "y", "width", "height"] as const)
        expect(Math.abs(reset[key] - documentFit[key])).toBeLessThanOrEqual(1);
      if (phone) await page.goBack();
      else await close.click();
      await viewer.waitFor({ state: "hidden" });
      await browserExpect(documentOpen).toBeFocused();
      expect(prompts).toEqual([]);
      if (phone) {
        const traversals = await page.evaluateHandle(
          () => ((window as TraversalObserver).diagramTraversals = []),
        );
        await page.goForward();
        await browserExpect
          .poll(() => traversals.jsonValue())
          .toEqual([true, false]);
        await browserExpect(viewer).toBeHidden();
        await browserExpect(doc).toBeVisible();
        expect(prompts).toEqual([]);
        await browserExpect(staged).toBeAttached();
      }
      if (originalTheme)
        await page.request.post(themeUrl, {
          data: {
            theme: originalTheme.theme,
            appearance: originalTheme.appearance,
          },
        });
      await context.close();
    }
  },
  // Regression: #2622 approximation tildes in real replies stay literal.
  async function test_approximation_tildes(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    const attempted: string[] = [];
    const executions: string[] = [];
    page.on("request", (request) => {
      if (/example\.invalid|javascript:|data:image/.test(request.url()))
        attempted.push(request.url());
    });
    const png = Buffer.from(
      await page.evaluate<string>(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 160;
      const context = canvas.getContext('2d');
      context.fillStyle = '#167d8d'; context.fillRect(0, 0, 320, 160);
      context.fillStyle = '#fff'; context.font = '24px sans-serif';
      context.fillText('Local image', 86, 88);
      return canvas.toDataURL('image/png').split(',')[1];
    })()`),
      "base64",
    );
    const workdir = await mkdtemp(join(tmpdir(), "reply-images-"));
    const absolute = join(workdir, "absolute.png");
    await writeFile(absolute, new Uint8Array(png));
    await writeFile(join(workdir, "relative.png"), new Uint8Array(png));
    await page.route("https://example.invalid/**", (route) =>
      route.fulfill({ contentType: "image/png", body: png }),
    );
    page.on("dialog", async (dialog) => {
      executions.push(dialog.message());
      await dialog.dismiss();
    });
    const fixture = await page.request.post(
      `${base}__browser-test/seed-files-pane`,
    );
    const { image } = (await fixture.json()) as { image: string };
    const safeImage = `/api/conversations/files-demo/attachments/${image}`;
    const reply =
      "~5 runs, ..., ~10 seconds; took ~5 min (~10 s each); (~5) and (~10); ~5-~10; ~5 runs.~10 s. ~~old~~ ~old~ **~~a~~** " +
      "[script link](javascript:alert(1)) ![script image](javascript:alert(2)) " +
      `![Absolute path](${absolute}) ![Relative path](./relative.png) ` +
      "![blocked](https://example.invalid/image.png) " +
      "![data image](data:image/png;base64,AAAA) " +
      `![vetted](${safeImage} '&quot; onerror=alert(3)') ` +
      "![attribute text](https://example.invalid/attribute.png onerror=alert(4)) " +
      "<https://example.invalid/autolink> <img src=https://example.invalid/raw.png onerror=alert(5)> " +
      `${SCHEME_LINKS.replace(/\n/g, " ")} Final **word**`;
    await page.request.post(
      `${base}__browser-test/seed-model-selection-error`,
      {
        data: { agent: "tilde-reply", model: "fauxordinary/faux-1", workdir },
      },
    );
    await page.goto(`${base}#agent=tilde-reply`);
    const input = page.locator("#input:enabled");
    await input.fill(`Reply only ${reply}`);
    await input.press("Enter");
    const content = page.locator(".msg.assistant .content").last();
    await content
      .filter({ hasText: "s each" })
      .waitFor()
      .catch(async (error) => {
        console.log(await page.locator("body").innerText());
        throw error;
      });
    await page
      .locator('#send[aria-label="Send message"]')
      .waitFor({ state: "attached" });
    await content.locator("p .turn-tail").waitFor();
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR) {
      await mkdir(process.env.RECURSE_BROWSER_SCREENSHOT_DIR, {
        recursive: true,
      });
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/message-tildes-phone.png`,
      });
    }
    expect(await content.locator("del").allTextContents()).toEqual([
      "old",
      "old",
      "a",
    ]);
    expect(await content.innerText()).toContain("took ~5 min (~10 s each)");
    expect(await content.locator("strong del").innerText()).toBe("a");
    await content.locator("p .turn-tail").waitFor();
    await browserExpect(
      content.getByRole("button", {
        name: "Show image from example.invalid",
        exact: true,
      }),
    ).toBeVisible();
    await browserExpect(content.locator(".artifact-failed-image")).toHaveCount(
      2,
    );
    for (const alt of ["Absolute path", "Relative path"]) {
      const local = content.locator(`img[alt="${alt}"]`);
      await local.scrollIntoViewIfNeeded();
      await local.evaluate((image: any) => image.decode());
      expect(await local.getAttribute("src")).toContain("/path-image?");
    }
    const vetted = content.locator('img[alt="vetted"]');
    expect(await vetted.count()).toBe(1);
    expect(await vetted.getAttribute("src")).toBe(`${safeImage}/thumbnail`);
    expect(await vetted.getAttribute("title")).toBe('" onerror=alert(3)');
    expect(
      await content.locator("[onerror], [onload], [onclick]").count(),
    ).toBe(0);
    expect(await content.locator('a[href^="javascript:"]').count()).toBe(0);
    expect(await content.innerText()).toContain("script link");
    await assertSchemeLinks(content);
    expect(await content.innerText()).toContain(
      "![attribute text](https://example.invalid/attribute.png onerror=alert(4))",
    );
    expect(await content.innerText()).toContain(
      "<img src=https://example.invalid/raw.png onerror=alert(5)>",
    );
    expect(
      await content
        .locator('a[href="https://example.invalid/autolink"]')
        .innerText(),
    ).toBe("https://example.invalid/autolink");
    await vetted.scrollIntoViewIfNeeded();
    await vetted.evaluate((image: any) => image.decode());
    expect(attempted).toEqual([]);
    expect(executions).toEqual([]);

    const filename = content.locator(
      '.thread-image:has(img[alt="vetted"]) .image-filename',
    );
    await browserExpect(filename).toHaveText("browser-image.png");
    expect(
      await filename.evaluate(
        (caption: any) => caption.scrollWidth <= caption.clientWidth,
      ),
    ).toBeTrue();
    const markup = await content.innerHTML();
    await page.request.post(
      `${base}__browser-test/seed-model-selection-error`,
      {
        data: { agent: "markdown-other", model: "fauxordinary/faux-1" },
      },
    );
    await page.locator("#input").blur();
    await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="markdown-other"]').click();
    await page.waitForFunction("!document.querySelector('.msg.assistant')");
    await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="tilde-reply"]').click();
    await content.locator("p .turn-tail").waitFor();
    await browserExpect(filename).toHaveText("browser-image.png");
    expect(await content.innerHTML()).toBe(markup);
    for (const width of [1280, 412]) {
      await page.setViewportSize({ width, height: 844 });
      await content
        .locator('img[alt="Absolute path"]')
        .scrollIntoViewIfNeeded();
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/path-images-${width}.png`,
        });
      await content.locator('img[alt="Absolute path"]').click();
      const viewer = page.locator('dialog[aria-label="Image viewer"]');
      await viewer.locator("img").evaluate((image: any) => image.decode());
      await browserExpect(
        viewer.getByRole("button", { name: "Download", exact: true }),
      ).toBeVisible();
      expect(await viewer.locator("img").getAttribute("src")).not.toContain(
        "thumbnail=",
      );
      await viewer
        .getByRole("button", { name: "Close image", exact: true })
        .click();
    }
    const permission = content.getByRole("button", {
      name: "Show image from example.invalid",
      exact: true,
    });
    for (const width of [1280, 412]) {
      await page.setViewportSize({ width, height: 844 });
      await permission.scrollIntoViewIfNeeded();
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/external-before-${width}.png`,
        });
    }
    expect(attempted).toEqual([]);
    await permission.click();
    const external = content.locator('img[alt="blocked"]');
    await external.evaluate((image: any) => image.decode());
    expect(attempted).toEqual(["https://example.invalid/image.png"]);
    for (const width of [1280, 412]) {
      await page.setViewportSize({ width, height: 844 });
      await external.scrollIntoViewIfNeeded();
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/external-after-${width}.png`,
        });
    }
    await page.close();
    await rm(workdir, { recursive: true, force: true });
  },
  // Regression: #2250 angle-bracket placeholders stay literal
  async function test_message_placeholders(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    let reply =
      'subagent rm ends with "Revive the agent via subagent revive <id>."\n\n' +
      'A cleared copy comes back as "<title> (before clear)".\n\n' +
      "- Continue with <path> and <cid>.\n\nThe final paragraph is still here.\n\n```text\ncopy this\n```\n\n- Final **word**";
    await mockConversation(page, base, "main", () => ({
      id: "main",
      title: "Angle placeholders",
      parent: null,
      status: "idle",
      turns: [turn("placeholders", "Explain <id> and <title>.", reply)],
    }));
    await gotoRoot(page, base);
    const content = page.locator(".msg.assistant .content").last();
    await content.waitFor();
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR) {
      await mkdir(process.env.RECURSE_BROWSER_SCREENSHOT_DIR, {
        recursive: true,
      });
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/message-placeholders-phone.png`,
      });
    }
    expect(await content.innerText()).toContain(
      'subagent rm ends with "Revive the agent via subagent revive <id>."',
    );
    expect(await content.innerText()).toContain(
      'A cleared copy comes back as "<title> (before clear)".',
    );
    expect(await content.innerText()).toContain(
      "Continue with <path> and <cid>.",
    );
    expect(await content.innerText()).toContain(
      "The final paragraph is still here.",
    );
    expect(
      await content.locator(":is(title, id, path, cid):not(svg *)").count(),
    ).toBe(0);
    expect(await content.locator(".code-wrap pre").innerText()).toBe(
      "copy this\n",
    );
    expect(await content.locator(".code-wrap .copy-btn").count()).toBe(1);
    expect(await content.locator("li .turn-tail").innerText()).toBe("word");
    expect(await page.locator(".msg.user").innerText()).toContain(
      "Explain <id> and <title>.",
    );
    const row = await page.locator(".msg.assistant").last().elementHandle();
    const identity = await row!.getAttribute("data-row-id");
    const offset = await row!.getAttribute("data-message-offset");
    expect(identity).not.toBeNull();
    expect(offset).not.toBeNull();
    reply += "\n\nRevision **fresh**";
    await content.locator("strong", { hasText: "fresh" }).waitFor();
    expect(await row!.evaluate((node) => node.isConnected)).toBe(true);
    expect(await row!.getAttribute("data-row-id")).toBe(identity);
    expect(await row!.getAttribute("data-message-offset")).toBe(offset);
    expect(await content.innerText()).toContain("Revision fresh");
    await page.close();
  },
];

if (import.meta.main) await runBrowserTests([["message-markdown", tests]]);
