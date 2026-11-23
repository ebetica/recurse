import type { Page } from "playwright";

let scrollCheck = 0;

export async function waitForPaneScroll(
  page: Page,
  scrollerSelector: string,
  paneSelector: string,
) {
  const key = `__paneScrollCheck${scrollCheck++}`;
  await page.waitForFunction(
    ({ scrollerSelector, paneSelector, key }) => {
      const browser = globalThis as any;
      const scroller = browser.document.querySelector(scrollerSelector);
      const chrome = [
        browser.document.querySelector("#topbar"),
        browser.document.querySelector(`${paneSelector} .pane-powerbar`),
      ];
      if (!scroller || chrome.some((node) => !node)) return false;
      const previous = browser[key];
      const top = scroller.scrollTop;
      const frames = previous?.top === top ? previous.frames + 1 : 0;
      browser[key] = { top, frames };
      const settled =
        frames >= 2 &&
        chrome.every((node) =>
          node
            .getAnimations()
            .every((animation: any) => animation.playState !== "running"),
        );
      if (settled) delete browser[key];
      return settled;
    },
    { scrollerSelector, paneSelector, key },
    { polling: "raf" },
  );
}

export async function waitForPaneTransition(page: Page, selector: string) {
  await page.waitForFunction((selector) => {
    const pane = (globalThis as any).document.querySelector(selector);
    return (
      pane &&
      pane
        .getAnimations({ subtree: true })
        .every(
          (animation: any) =>
            animation.playState !== "running" ||
            animation.effect?.getTiming().iterations === Infinity,
        )
    );
  }, selector);
}

export function dockControls(page: Page) {
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
  const arrange = async (key: string) => {
    await page.keyboard.press("w");
    await page.locator("#window-key-hints").waitFor({ state: "visible" });
    await page.keyboard.press(key);
    await page.locator("#window-key-hints").waitFor({ state: "hidden" });
  };
  const tab = (id: string) =>
    page.locator(`#dock .dv-tab[data-dock-panel="${id}"]`);
  const windowBox = async (id: string) =>
    (await tab(id)
      .locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]")
      .boundingBox())!;
  return { thread, focusThread, focused, arrange, tab, windowBox };
}
