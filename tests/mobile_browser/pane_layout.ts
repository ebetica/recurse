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
