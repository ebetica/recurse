import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { expect as browserExpect } from "playwright/test";
import { captureErrors, type BrowserTest } from "./common";

export const test_last_thinking_survives_wait_and_reload: BrowserTest = async (
  browser,
  base,
) => {
  for (const thinking of [
    "claude",
    "chatgpt",
    "claude-redacted",
    "chatgpt-encrypted",
  ]) {
    for (const width of [1280, 390]) {
      for (const colorScheme of ["light", "dark"] as const) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          isMobile: width === 390,
          hasTouch: width === 390,
          colorScheme,
        });
        const errors = captureErrors(page);
        let agent = "";
        try {
          const theme = await page.request.post(`${base}api/settings/theme`, {
            data: { theme: "Tokyo Night", appearance: colorScheme },
          });
          expect(theme.ok()).toBeTrue();
          const seed = await page.request.post(
            `${base}__browser-test/seed-live-tools`,
            {
              data: { thinking },
            },
          );
          const seeded = await seed.json();
          agent = seeded.agent;
          await page.goto(`${base}#agent=${agent}`);
          await page.locator("#input").fill("Check the background work.");
          await page.locator("#send").click();
          const bar = page.locator("#live-bar");
          const expectWaiting = async (title: string) => {
            await browserExpect(bar.locator(".live-thinking-title")).toHaveText(
              title,
            );
            await browserExpect(bar.locator(".live-thinking-head")).toHaveText(
              /^Waiting/,
            );
          };
          await bar.locator(".shell-chip").waitFor();
          await browserExpect
            .poll(async () => {
              const view = await (
                await page.request.get(`${base}api/conversations/${agent}/view`)
              ).json();
              return view.blocks.some(
                (row: any) => row.running && row.tool_elapsed_ms >= 3500,
              );
            })
            .toBe(true);
          const title =
            thinking === "claude" || thinking === "chatgpt"
              ? "Checking the background work"
              : "Waiting";
          await expectWaiting(title);
          await browserExpect(
            bar.locator(".live-thinking-elapsed"),
          ).toHaveCount(1);
          await page.reload();
          await bar.locator(".shell-chip").waitFor();
          await expectWaiting(title);
          if (title !== "Waiting") {
            await bar.locator(".live-thinking-copy").click();
            await browserExpect(
              bar.locator(".live-thinking-summary"),
            ).toHaveText(
              "I am waiting for the command to finish before checking its result.",
            );
          }
          await writeFile(seeded.outputGate, "ready");
          await browserExpect
            .poll(async () => {
              const view = await (
                await page.request.get(`${base}api/conversations/${agent}/view`)
              ).json();
              return view.blocks.some((row: any) => row.running);
            })
            .toBe(false);
          await page.reload();
          await bar.locator(".shell-chip").waitFor();
          await expectWaiting(title);
          if (title !== "Waiting") {
            const toggle = bar.locator(".live-thinking-copy");
            if ((await toggle.getAttribute("aria-expanded")) === "false")
              await toggle.click();
            await browserExpect(
              bar.locator(".live-thinking-summary"),
            ).toHaveText(
              "I am waiting for the command to finish before checking its result.",
            );
          }
          const shots = process.env.LAST_THINKING_SCREENSHOTS;
          if (shots)
            await page.screenshot({
              path: `${shots}/${thinking}-${width}-${colorScheme}.png`,
            });
          await page.request.post(`${base}__browser-test/durable-release`);
          await expectWaiting("Reviewing the command result");
          await page.reload();
          await expectWaiting("Reviewing the command result");
          await page.request.post(`${base}__browser-test/durable-release`);
          await page
            .getByText("Live tools finished.", { exact: true })
            .waitFor();
          await browserExpect(bar.locator(".live-thinking-title")).toHaveCount(
            0,
          );
          expect(errors).toEqual([]);
        } finally {
          if (agent)
            await page.request.post(
              `${base}__browser-test/durable-thinking-cleanup?agent=${agent}`,
            );
          await page.close();
        }
      }
    }
  }
};
