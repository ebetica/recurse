import { expect } from "bun:test";
import { postFixture, runBrowserTests, type BrowserTest } from "./common";
import {
  filePage,
  fileShot,
  filesSurface,
  showFilesList,
} from "./files_support";

interface ImageNavigationFixture {
  demo: string;
  image_ids: string[];
}

export const tests: BrowserTest[] = [
  // Regression: #2736 image viewer navigation counts up towards newer files.
  async function test_files_image_navigation(browser, base) {
    const fixture = (await postFixture(
      base,
      "seed-image-navigation",
    )) as ImageNavigationFixture;
    const { context, page, errors } = await filePage(browser, 1280, 800);
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("#conv-title", { hasText: "Files image navigation" })
      .waitFor();
    await page.locator('#messages img[alt="nav-2.png"]').click();
    const viewer = page.locator("dialog.image-popout");
    await viewer.waitFor();
    expect(await viewer.locator(".files-position").count()).toBe(0);
    await viewer.getByRole("button", { name: "Open in Files" }).click();
    const pane = filesSurface(page);
    const detail = pane.locator(".files-detail");
    await pane.locator('.files-detail[aria-label="nav-2.png"]').waitFor();
    const position = pane.locator(".files-position");
    expect(await position.textContent()).toBe("2 of 3");
    const previous = pane.getByRole("button", { name: "Previous file" });
    while (!(await previous.isDisabled())) await previous.click();
    expect(await position.textContent()).toBe("1 of 3");
    expect(await detail.getAttribute("aria-label")).toBe("nav-1.png");
    const next = pane.getByRole("button", { name: "Next file" });
    await next.click();
    expect(await position.textContent()).toBe("2 of 3");
    const middle = await detail.getAttribute("aria-label");
    await next.click();
    expect(await position.textContent()).toBe("3 of 3");
    const last = await detail.getAttribute("aria-label");
    expect(last).toBe("nav-3.png");
    expect(await next.isDisabled()).toBeTrue();
    await page.keyboard.press("ArrowLeft");
    await pane.locator('.files-detail[aria-label="nav-2.png"]').waitFor();
    expect(await position.textContent()).toBe("2 of 3");
    expect(await detail.getAttribute("aria-label")).toBe(middle);
    await page.keyboard.press("ArrowRight");
    await pane.locator('.files-detail[aria-label="nav-3.png"]').waitFor();
    expect(await detail.getAttribute("aria-label")).toBe(last);
    await showFilesList(page);
    await pane.locator(".files-card").nth(2).waitFor();
    expect(
      await pane.locator(".files-card").first().getAttribute("aria-label"),
    ).toBe(last);
    await pane.locator(".files-thumb").first().click();
    expect(await position.textContent()).toBe("3 of 3");
    await page.waitForFunction(
      "document.querySelector('.files-detail img')?.naturalWidth > 0",
    );
    await fileShot(page, `files-viewer-desktop.png`);
    expect(errors).toEqual([]);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["files", tests]]);
