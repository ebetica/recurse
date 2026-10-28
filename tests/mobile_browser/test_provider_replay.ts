import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { captureErrors, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  async function test_recorded_websocket_steer(browser, base) {
    const page = await browser.newPage();
    const errors = captureErrors(page);
    try {
      const seeded = await page.request.post(
        `${base}__browser-test/seed-provider-replay`,
        { data: { name: "openai-codex-auto", copies: 2 } },
      );
      const { agent } = await seeded.json();
      await page.goto(`${base}#agent=${agent}`);
      await page.locator("#input").fill("First public message.");
      await page.locator("#send").click();
      await page.locator(".working.live-panel").waitFor();
      await browserExpect
        .poll(async () => {
          const status = await (
            await page.request.post(
              `${base}__browser-test/provider-replay-status`,
              { data: { agent } },
            )
          ).json();
          const view = await (
            await page.request.get(`${base}api/conversations/${agent}/view`)
          ).json();
          return { requests: status.requests, turn: view.turn_status };
        })
        .toEqual({ requests: 1, turn: "running" });
      await page.locator("#input").fill("Public steer message.");
      const delivery = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/conversations/${agent}/deliver`) &&
          response.request().method() === "POST",
      );
      await page.locator("#input").press("Enter");
      expect((await (await delivery).json()).steer).toBeTrue();
      await page.getByText("Public steer message.", { exact: true }).waitFor();
      await page
        .getByText("RECORDED_PROVIDER_OK", { exact: true })
        .first()
        .waitFor();
      await browserExpect
        .poll(async () => {
          const status = await (
            await page.request.post(
              `${base}__browser-test/provider-replay-status`,
              { data: { agent } },
            )
          ).json();
          const view = await (
            await page.request.get(`${base}api/conversations/${agent}/view`)
          ).json();
          return { requests: status.requests, turn: view.turn_status };
        })
        .toEqual({ requests: 2, turn: "idle" });
      await browserExpect(page.locator("#send.stop")).toHaveCount(0);
      await page
        .getByText("RECORDED_PROVIDER_OK", { exact: true })
        .last()
        .waitFor();
      const status = await page.request.post(
        `${base}__browser-test/provider-replay-status`,
        { data: { agent, close: true } },
      );
      expect(await status.json()).toEqual({ requests: 2, failures: [] });
      expect(
        await page.locator(".activity-group-toggle").allTextContents(),
      ).not.toContain("Summary");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
  // Regression: #2634 stop must consume the first recording before the agent message consumes the second.
  async function test_recorded_anthropic_stop_and_agent_message(browser, base) {
    const page = await browser.newPage();
    const errors = captureErrors(page);
    try {
      const seeded = await page.request.post(
        `${base}__browser-test/seed-provider-replay`,
        { data: { name: "anthropic-sse", copies: 2 } },
      );
      const { agent } = await seeded.json();
      await page.goto(`${base}#agent=${agent}`);
      await page.locator("#input").fill("Public stopped message.");
      await page.locator("#send").click();
      await page.locator(".working.live-panel").waitFor();
      await browserExpect
        .poll(async () => {
          const status = await page.request.post(
            `${base}__browser-test/provider-replay-status`,
            { data: { agent } },
          );
          expect(status.ok()).toBeTrue();
          return (await status.json()).requests;
        })
        .toBe(1);
      await page.locator("#send.stop").click();
      await page.locator("#send.stop.armed").click();
      await browserExpect(page.locator("#send.stop")).toHaveCount(0);
      await browserExpect(page.locator(".working.live-panel")).toHaveCount(0);
      const delivered = await page.request.post(
        `${base}__browser-test/provider-replay-status`,
        { data: { agent, message: "PUBLIC_AGENT_MESSAGE" } },
      );
      expect(delivered.ok()).toBeTrue();
      await page.getByText("RECORDED_PROVIDER_OK", { exact: true }).waitFor();
      await browserExpect(page.locator("#send.stop")).toHaveCount(0);
      const status = await page.request.post(
        `${base}__browser-test/provider-replay-status`,
        { data: { agent, close: true } },
      );
      expect(await status.json()).toEqual({ requests: 2, failures: [] });
      const view = await (
        await page.request.get(`${base}api/conversations/${agent}/view`)
      ).json();
      expect(JSON.stringify(view)).toContain("PUBLIC_AGENT_MESSAGE");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
];
