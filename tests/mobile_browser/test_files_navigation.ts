import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  postFixture,
  rootAgentId,
  runBrowserTests,
  startServer,
  stopServer,
  type BrowserTest,
} from "./common";
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
  // Regression: #2736 #3552 Files steps toward newer files in the same tab.
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
    const tabs = page.locator('.dv-tab[data-dock-panel^="file:"]');
    const activeTitle = tabs
      .and(page.locator(".dv-active-tab"))
      .locator(".dv-default-tab-content");
    await browserExpect(tabs).toHaveCount(1);
    await browserExpect(activeTitle).toHaveText("nav-2.png");
    const originalId = await tabs.getAttribute("data-dock-panel");
    const previous = pane.getByRole("button", { name: "Previous file" });
    await previous.click();
    await browserExpect(position).toHaveText("1 of 3");
    await browserExpect(tabs).toHaveCount(1);
    await browserExpect(tabs).toHaveAttribute("data-dock-panel", originalId!);
    await browserExpect(tabs).toHaveAttribute("aria-label", "nav-1.png");
    await browserExpect(activeTitle).toHaveText("nav-1.png");
    const image = detail.getByRole("img", { name: "nav-1.png" });
    await browserExpect(image).toHaveAttribute(
      "src",
      new RegExp(`/attachments/${fixture.image_ids[0]}(?:/|$)`),
    );
    await image.evaluate((img: HTMLImageElement) => img.decode());
    await browserExpect(previous).toBeDisabled();
    const next = pane.getByRole("button", { name: "Next file" });
    await next.focus();
    await page.keyboard.press("Enter");
    await browserExpect(next).toBeFocused();
    expect(await position.textContent()).toBe("2 of 3");
    const middle = await detail.getAttribute("aria-label");
    await page.keyboard.press("Enter");
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
    await browserExpect(tabs).toHaveCount(1);
    await browserExpect(activeTitle).toHaveText("nav-3.png");
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
    await browserExpect(tabs).toHaveCount(1);
    await showFilesList(page);
    await pane
      .getByRole("button", { name: "Open nav-2.png", exact: true })
      .click();
    await browserExpect(tabs).toHaveCount(2);
    await browserExpect(activeTitle).toHaveText("nav-2.png");
    await next.click();
    await browserExpect(tabs).toHaveCount(2);
    await browserExpect(activeTitle).toHaveText("nav-3.png");
    await page.reload({ waitUntil: "domcontentloaded" });
    await browserExpect(tabs).toHaveCount(2);
    await browserExpect(tabs).toHaveText(["nav-3.png", "nav-3.png"]);
    expect(errors).toEqual([]);
    await context.close();

    const phone = await filePage(browser, 412, 844, true);
    await phone.page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await phone.page.locator('#messages img[alt="nav-2.png"]').tap();
    await phone.page.getByRole("button", { name: "Open in Files" }).tap();
    const phoneFiles = filesSurface(phone.page);
    await phoneFiles.getByRole("button", { name: "Previous file" }).tap();
    await browserExpect(phoneFiles.locator(".files-detail")).toHaveAttribute(
      "aria-label",
      "nav-1.png",
    );
    await phoneFiles.getByRole("button", { name: "Next file" }).tap();
    await browserExpect(phoneFiles.locator(".files-detail")).toHaveAttribute(
      "aria-label",
      "nav-2.png",
    );
    expect(phone.errors).toEqual([]);
    await phone.context.close();
  },
  // Regression: #3599 deleting an image's conversation keeps the replacement pane and Back order.
  async function test_files_image_history_after_delete(browser) {
    const server = await startServer();
    const { base } = server;
    try {
      const root = rootAgentId();
      const { demo, image_ids } = (await postFixture(
        base,
        "seed-image-navigation",
      )) as ImageNavigationFixture;
      const source = await fetch(
        `${base}api/conversations/${demo}/attachments/${image_ids[0]}`,
      );
      expect(source.ok).toBeTrue();
      const image = Buffer.from(await source.arrayBuffer());
      await postFixture(base, "publish-source-previews", {
        agent: root,
        text: "const saved = 1;",
      });
      const rootUrl = `${base}#agent=${encodeURIComponent(root)}`;
      const { page: phone, context } = await filePage(browser, 1280, 800);
      await phone.goto(rootUrl);
      await showFilesList(phone);
      const saved = phone.locator('.files-card[aria-label="configuration.ts"]');
      await saved.waitFor();
      await phone.locator(`.agent[data-id="${demo}"]`).click();
      await phone.locator('#messages img[alt="nav-2.png"]').waitFor();
      await phone.setViewportSize({ width: 412, height: 844 });
      await phone.waitForFunction(
        "history.state?.phoneScreen === 'conversation'",
      );
      await phone.locator("#pane-fab").click();
      await phone.locator('.pane-menu-item[data-pane="files"]').click();
      await filesSurface(phone).locator(".files-thumb").first().click();
      const phoneViewer = phone.getByRole("dialog", { name: "Image viewer" });
      await phoneViewer.waitFor();
      await phone.waitForFunction(
        "history.state?.imagePopout && history.state?.phonePane",
      );
      expect(
        (await fetch(`${base}api/conversations/${demo}`, { method: "DELETE" }))
          .ok,
      ).toBeTrue();
      await phoneViewer.waitFor({ state: "detached" });
      await saved.waitFor();
      await phone.waitForFunction(
        (url) =>
          location.href === url &&
          history.state?.phonePane &&
          !history.state?.imagePopout,
        rootUrl,
      );
      await phone.goBack();
      await saved.waitFor({ state: "hidden" });
      await browserExpect(phone).toHaveURL(rootUrl);
      await phone.goBack();
      await phone.locator("html.phone-list").waitFor({ state: "attached" });
      await context.close();

      const { page: desktop } = await filePage(browser, 1280, 800);
      await desktop.goto(rootUrl);
      await browserExpect(desktop.locator("#input")).toBeEnabled();
      await desktop.locator("#file-input").setInputFiles({
        name: "fallback.png",
        mimeType: "image/png",
        buffer: image,
      });
      await desktop.getByRole("button", { name: "Open fallback.png" }).click();
      const desktopViewer = desktop.getByRole("dialog", {
        name: "Image viewer",
      });
      await desktopViewer.waitFor();
      expect(
        (await fetch(`${base}api/conversations/${root}`, { method: "DELETE" }))
          .ok,
      ).toBeTrue();
      await desktop
        .locator("#conv-title", { hasText: /^No agents$/ })
        .waitFor();
      await desktopViewer.waitFor({ state: "detached" });
      await desktop.waitForFunction(
        (url) => location.href === url && !history.state?.imagePopout,
        base,
      );
    } finally {
      await stopServer(server);
    }
  },
];
if (import.meta.main) await runBrowserTests([["files", tests]]);
