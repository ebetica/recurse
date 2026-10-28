import { expect } from "bun:test";
import {
  gotoRoot,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Feature: #2314 p must not close an open pane; Escape returns to agents.
  async function test_pane_focus_and_visibility_keys(browser, base) {
    await postFixture(base, "seed-artifact-app");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await gotoRoot(page, base);
    const pane = page.locator('.pane-col[data-pane="report"]');
    await pane.waitFor();
    const thread = page.locator("#scroll");
    const focusThread = async () => {
      await thread.evaluate((node: any) => {
        node.tabIndex = -1;
        node.focus();
      });
    };
    const focused = async (selector: string) => {
      await page.waitForFunction(
        (selector) =>
          (globalThis as any).document.activeElement?.matches(selector),
        selector,
      );
    };
    await focusThread();
    await page.keyboard.press("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(
      await pane.evaluate(
        (el: any) => (globalThis as any).getComputedStyle(el).outlineStyle,
      ),
    ).toBe("none");
    expect(
      await pane
        .locator(".pane-body")
        .evaluate(
          (el: any) => (globalThis as any).getComputedStyle(el).outlineStyle,
        ),
    ).toBe("none");
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("p");
    await focused("#scroll");
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("o");
    await pane.waitFor({ state: "detached" });
    await focusThread();
    await page.keyboard.press("o");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("o");
    await pane.waitFor({ state: "detached" });
    await focusThread();
    await page.keyboard.press("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("Escape");
    await focused(".agent");
    expect(await pane.isVisible()).toBeTrue();
    await page.keyboard.press("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    await page.keyboard.press("z");
    await pane.locator('.fs[aria-pressed="true"]').waitFor();
    await page.keyboard.press("p");
    await focused("#scroll");
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    await page.keyboard.press("p");
    await focused('.pane-col[data-pane="report"] .pane-body');
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    await page.keyboard.press("Escape");
    await focused(".agent");
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("h");
    await pane.waitFor({ state: "detached" });
    await focused(".agent");
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["pane-hotkeys", tests]]);
