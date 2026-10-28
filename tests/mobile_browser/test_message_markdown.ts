import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
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
    await page.route("https://example.invalid/**", (route) => route.abort());
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
      "![blocked](https://example.invalid/image.png) " +
      "![data image](data:image/png;base64,AAAA) " +
      `![vetted](${safeImage} '&quot; onerror=alert(3)') ` +
      "![attribute text](https://example.invalid/attribute.png onerror=alert(4)) " +
      "<https://example.invalid/autolink> <img src=https://example.invalid/raw.png onerror=alert(5)> " +
      "Final **word**";
    await page.request.post(
      `${base}__browser-test/seed-model-selection-error`,
      {
        data: { agent: "tilde-reply", model: "fauxordinary/faux-1" },
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
    await page.locator('#send[aria-label="Send message"]').waitFor();
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
    expect(await content.locator(".blocked-image").allTextContents()).toEqual([
      "Image blocked",
      "Image blocked",
      "Image blocked",
    ]);
    const vetted = content.locator("img");
    expect(await vetted.count()).toBe(1);
    expect(await vetted.getAttribute("src")).toBe(`${safeImage}/preview`);
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
    const markup = await content.innerHTML();
    await page.request.post(
      `${base}__browser-test/seed-model-selection-error`,
      {
        data: { agent: "markdown-other", model: "fauxordinary/faux-1" },
      },
    );
    await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="markdown-other"]').click();
    await page.waitForFunction("!document.querySelector('.msg.assistant')");
    await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="tilde-reply"]').click();
    await content.locator("p .turn-tail").waitFor();
    expect(await content.innerHTML()).toBe(markup);
    await page.close();
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
