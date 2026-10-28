import { expect } from "bun:test";
import recorded from "../backend/fixtures/conversation_title/recording.json";
import { join } from "node:path";
import {
  gotoRoot,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Feature: #2449 automatic naming updates the top-level title live.
  async function test_new_top_level_title_updates_live(browser, base) {
    for (const width of [412, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 915 } });
      try {
        await gotoRoot(page, base);
        await postFixture(base, "seed-conversation-title");
        await page.locator("#new-top").click();
        expect(await page.locator("#conv-title").innerText()).toBe("New agent");
        const created = page.waitForResponse(
          (response) =>
            response.url() === `${base}api/conversations` &&
            response.request().method() === "POST",
        );
        await page.locator("#input").fill(recorded.message);
        await page.locator("#send").click();
        const { id, title } = await (await created).json();
        expect(title ?? null).toBeNull();
        await page.waitForFunction(
          (title) =>
            (globalThis as any).document.querySelector("#conv-title")
              ?.textContent === title,
          recorded.appliedTitle,
        );
        expect(await page.locator("#conv-title").innerText()).toBe(
          recorded.appliedTitle,
        );
        if (width === 412) await page.locator("#menu-btn").click();
        const row = page.locator(`#agent-list .agent[data-id="${id}"] .title`);
        await row.filter({ hasText: recorded.appliedTitle }).waitFor();
        expect(await row.innerText()).toBe(recorded.appliedTitle);
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        if (shots)
          await page.screenshot({
            path: join(shots, `conversation-title-${width}.png`),
          });
        if (width === 412) await page.locator("#menu-btn").click();
        await page.locator(".prompt-banner-row").click();
        await page
          .locator(".prompt-banner-body > .prompt-block-head")
          .waitFor();
        expect(
          (
            await page.request.post(
              `${base}__browser-test/forget-conversation-request`,
              { data: { agent: id } },
            )
          ).ok(),
        ).toBe(true);
        await page.reload();
        await page.locator(".prompt-banner-row").click();
        await page
          .getByText("No system prompt has been captured yet.", { exact: true })
          .waitFor();
        const naming = page.locator(".conversation-name-capture");
        expect(await naming.getAttribute("open")).toBeNull();
        expect((await naming.locator("summary").innerText()).trim()).toBe(
          `Conversation name · ${recorded.appliedTitle}`,
        );
        if (shots)
          await page.screenshot({
            path: join(shots, `conversation-name-closed-${width}.png`),
          });
        await naming.locator("summary").click();
        const inspected = await page
          .locator(".conversation-name-capture pre")
          .innerText();
        expect(inspected).toContain(recorded.message);
        expect(inspected).toContain(recorded.rawReply);
        if (shots)
          await page.screenshot({
            path: join(shots, `conversation-name-inspector-${width}.png`),
          });
      } finally {
        await page.close();
      }
    }
  },
];
if (import.meta.main) {
  if (process.argv.includes("--list"))
    console.log(tests.map((test) => test.name).join("\n"));
  else await runBrowserTests([["conversation-title", tests]]);
}
