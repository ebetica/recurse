import { expect } from "bun:test";
import { postFixture, waitForLayout, type BrowserTest } from "./common";

// Regression: #3005 a background poll discarded history loaded by scrolling up.
export const test_history_survives_poll: BrowserTest = async (
  browser,
  base,
) => {
  const { agent } = await postFixture(base, "seed-durable-history", {
    agent: "history-poll",
  });
  await postFixture(base, "durable-history-more", { agent, from: 70, to: 160 });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const path = `/api/conversations/${agent}/view`;
  let release!: () => void;
  let held = new Promise<void>((resolve) => (release = resolve));
  let paused: (() => void) | undefined;
  await page.route(`**/api/conversations/${agent}/events*`, (route) =>
    route.abort(),
  );
  await page.route(`**${path}?*`, async (route) => {
    if (new URL(route.request().url()).searchParams.has("since")) {
      paused?.();
      await held;
    }
    await route.continue();
  });
  try {
    await page.goto(`${base}#agent=${agent}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText("Answer 159", { exact: true }).waitFor();
    const loaded: string[] = [];
    for (let n = 0; n < 2; n++) {
      const response = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === path && url.searchParams.has("before");
      });
      await page.locator("#scroll").evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event("scroll"));
      });
      const older = await (await response).json();
      const answer = older.blocks.find((row: any) =>
        /^Answer \d+$/.test(row.text),
      ).text;
      loaded.push(answer);
      await page.getByText(answer, { exact: true }).waitFor();
      await waitForLayout(page);
    }
    const poll = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === path && url.searchParams.has("since");
    });
    release();
    expect((await (await poll).json()).reset).toBe(false);
    await postFixture(base, "durable-history-more", {
      agent,
      from: 160,
      to: 161,
    });
    await page.getByText("Answer 160", { exact: true }).waitFor();
    for (const answer of loaded)
      expect(await page.getByText(answer, { exact: true }).count()).toBe(1);
    held = new Promise<void>((resolve) => (release = resolve));
    await new Promise<void>((resolve) => (paused = resolve));
    await postFixture(base, "durable-history-more", {
      agent,
      from: 161,
      to: 231,
    });
    const reset = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === path && url.searchParams.has("since");
    });
    release();
    expect((await (await reset).json()).reset).toBe(true);
    await page.getByText("Answer 230", { exact: true }).waitFor();
    for (const answer of loaded)
      expect(await page.getByText(answer, { exact: true }).count()).toBe(1);
    expect(await page.locator("#messages").innerText()).not.toContain(
      "too large to load whole",
    );
  } finally {
    release();
    await page.close();
  }
};
