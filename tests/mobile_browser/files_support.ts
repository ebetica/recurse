import type { Browser, Locator, Page } from "playwright";
import { captureErrors } from "./common";

export async function filePage(
  browser: Browser,
  width: number,
  height: number,
  mobile = false,
) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  return { context, page, errors: captureErrors(page) };
}

export async function fileShot(page: Page, name: string): Promise<void> {
  const directory = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
  if (directory) await page.screenshot({ path: `${directory}/${name}` });
}

export const filesSurface = (page: Page) =>
  page.locator(
    '.pane-col[data-pane="files"], .pane-col.file-tab:visible:has(.files-detail)',
  );

export async function showFilesList(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) <= 700) {
    await page.getByRole("button", { name: "All files", exact: true }).click();
    return;
  }
  const list = page.locator('.pane-col[data-pane="files"]');
  if (await page.locator('.dv-tab[data-dock-panel="files"]').count())
    await page.locator('.dv-tab[data-dock-panel="files"]').click();
  else await page.locator('.rail-btn[data-pane="files"]').click();
  await list.waitFor();
}

export async function openListedFile(page: Page, name: string): Promise<void> {
  await page
    .locator(".files-card")
    .getByRole("button", { name: `Open ${name}`, exact: true })
    .click();
}

export async function openReplyFile(
  page: Page,
  name: string,
): Promise<Locator> {
  const chip = page.getByRole("button", {
    name: `Open ${name} in Files`,
    exact: true,
  });
  if (!(await chip.isVisible()))
    await page.locator('.dv-tab[data-dock-panel="chat"]').click();
  await chip.click();
  return filesSurface(page).filter({ has: page.locator(".files-detail") });
}

export async function closeFileTab(page: Page, id?: string): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) <= 700) {
    await page
      .locator('.pane-col[data-pane="files"] .pane-powerbar > .x')
      .click();
    return;
  }
  const panel =
    id ??
    (await page
      .locator(".pane-col.file-tab:visible")
      .getAttribute("data-pane"))!;
  const tab = page.locator(`.dv-tab[data-dock-panel="${panel}"]`);
  await tab.hover();
  await tab.locator("button").click();
}

export async function renderedText(target: Locator): Promise<string> {
  await target.page().waitForFunction(
    (element: any) =>
      (element.firstElementChild ?? element).checkVisibility({
        contentVisibilityAuto: true,
      }),
    await target.elementHandle(),
  );
  return target.innerText();
}

export interface Fixture {
  demo: string;
  empty: string;
  empty_text: string;
}
