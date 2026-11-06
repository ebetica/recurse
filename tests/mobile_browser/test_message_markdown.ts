import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gotoRoot,
  mockConversation,
  runBrowserTests,
  turn,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
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
      "Final **word**";
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
    for (const width of [1280, 800, 1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(
        "(() => { const width = document.querySelector('#conv-controls').clientWidth; return document.querySelector('#context-indicator').classList.contains('mini-hidden') === (width < 620); })()",
      );
    }
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
    expect(await content.locator("title, id, path, cid").count()).toBe(0);
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
