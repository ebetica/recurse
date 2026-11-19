import type { Page } from "playwright";
import { expect as browserExpect } from "playwright/test";

export const fontSize = (el: unknown) =>
  (globalThis as any).getComputedStyle(el).fontSize;

export async function openDetail(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name }).click();
}

export async function closeDetails(page: Page): Promise<void> {
  const sheets = page.locator("dialog.settings-sheet[open]");
  const name =
    page.viewportSize()!.width <= 700 ? /^Close / : /^(Close|Back to) /;
  while (await sheets.count())
    await sheets.last().getByRole("button", { name }).click();
}

export const expectModalSheet = (page: Page, name: string) =>
  browserExpect(page.locator("dialog:modal")).toHaveAccessibleName(name);

export async function showCategory(page: Page, cat: string): Promise<void> {
  await closeDetails(page);
  const back = page.locator(".settings-cat:not([hidden]) .settings-back");
  if (await back.isVisible()) await back.click();
  await page.locator(`#settings-nav button[data-cat="${cat}"]`).click();
}
