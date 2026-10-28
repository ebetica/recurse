import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { captureErrors, type BrowserTest } from "./common";
export const tests: BrowserTest[] = [
  // Regression: #2854 folded summaries omitted nested script writes and commands, including calls past the display cap. (also Regression #2341 script labels and expanded read diagnostics exposed internal wording.)
  async function test_script_labels_and_plain_read_diagnostics(browser, base) {
    const page = await browser.newPage();
    let agent = "";
    try {
      ({ agent } = await (
        await page.request.post(
          `${base}__browser-test/seed-script-read-diagnostics`,
        )
      ).json());
      await page.goto(`${base}#agent=${agent}`);
      await page.locator("#composer").waitFor();
      await page.request.post(`${base}api/conversations/${agent}/deliver`, {
        data: { content: "Read the file and run scripts." },
      });
      await page
        .getByText("Script and read finished.", { exact: true })
        .waitFor();
      const group = page.locator(".activity-group-toggle").first();
      expect(await group.innerText()).toContain("ran 2 commands");
      expect(await group.innerText()).toContain("Wrote 1 file");
      expect(await group.innerText()).toContain("used 102 other tools");
      await group.click();
      const series = page.locator(".turn-series-toggle").first();
      expect(await series.innerText()).toContain("ran 2 commands");
      expect(await series.innerText()).toContain("Wrote 1 file");
      expect(await series.innerText()).toContain("used 102 other tools");
      await series.click();
      const read = page
        .locator(".turn-tool", {
          has: page.locator(".turn-tool-head", { hasText: "Read" }),
        })
        .first();
      await read.locator(".turn-tool-head").click();
      await read
        .locator(".tool-payload")
        .filter({ hasText: "more lines" })
        .waitFor();
      const visible = await read.innerText();
      expect(visible).not.toContain("<harness>");
      expect(visible).not.toContain("[info]");
      const scripts = page.locator(".turn-tool-name", {
        hasText: "Ran a script",
      });
      await scripts.first().waitFor();
      expect(await scripts.allTextContents()).toEqual([
        "Ran a script · 104 tools",
        "Ran a script",
      ]);
    } finally {
      try {
        const cleanup = await page.request.post(
          `${base}__browser-test/clear-script-read-diagnostics`,
          { data: { agent } },
        );
        expect(cleanup.ok()).toBeTrue();
      } finally {
        await page.close();
      }
    }
  },
  // Regression: #2779 truncated titles retain trailing spaces regardless of TMPDIR length. (also Feature #2335 expanded tools need full commands and latest streamed output.; #2343 runtime precedes long commands; visible bar owns running counts.; #2411 latest shell output waits for the initial live panel checks.; #2343 the visible bar owns the running count, not the turn summary.)
  async function test_expanded_live_tools_show_latest_safe_output(
    browser,
    base,
  ) {
    for (const width of [412, 1280]) {
      for (const mode of [
        "output",
        "many-output",
        "secret-output",
        "background-output",
      ]) {
        const page = await browser.newPage({
          viewport: { width, height: 915 },
        });
        const post = (path: string, data?: object) =>
          page.request.post(`${base}${path}`, { data });
        const errors = captureErrors(page);
        let agent = "";
        let outputGate = "";
        try {
          ({ agent, outputGate } = await (
            await post("__browser-test/seed-live-tools", { mode })
          ).json());
          await page.goto(`${base}#agent=${agent}`);
          await page.locator("#composer").waitFor();
          await post(`api/conversations/${agent}/deliver`, {
            content: "Run tools.",
          });
          const bar = page.locator(".working .live-label");
          await bar.filter({ hasText: "Running" }).waitFor();
          await bar.click();
          const body = page.locator(".live-tool-body");
          await body.waitFor();
          const rows = body.locator(".live-tool-row");
          expect(await rows.count()).toBe(mode === "many-output" ? 3 : 1);
          expect(
            await page
              .locator(".turn-summary")
              .filter({ hasText: /[Rr]unning \d+ command/ })
              .count(),
          ).toBe(0);
          const title = await bar.locator(".live-thinking-title").textContent();
          expect(title).toBe(
            mode === "many-output"
              ? "Running 3 commands"
              : mode === "secret-output"
                ? "Running command"
                : `Running ${(await rows.first().locator("code").innerText()).slice(0, 2000)}`,
          );
          expect(title).not.toMatch(/\b(?:Ran|Preparing|Thinking)\b/);
          expect(await rows.locator('[role="timer"]').count()).toBe(
            await rows.count(),
          );
          if (mode !== "secret-output") {
            await rows.first().locator("pre").waitFor();
            expect(await rows.first().locator("pre").innerText()).not.toContain(
              "latest-",
            );
          }
          await writeFile(outputGate, "ready");
          if (mode !== "secret-output") {
            expect(await rows.first().locator("code").innerText()).toEndWith(
              "END_OF_COMMAND",
            );
            expect(
              (await rows.first().locator("code").innerText()).length,
            ).toBeGreaterThan(2000);
            await rows
              .first()
              .locator("pre")
              .filter({
                hasText: mode === "background-output" ? "latest-1" : "latest-0",
              })
              .waitFor();
            const tail = await rows.first().locator("pre").innerText();
            expect(tail.trim().split("\n").length).toBeLessThanOrEqual(5);
            expect(tail).not.toContain("line-1\n");
            await rows.first().locator("pre").click();
            await page.evaluate(() => {
              const doc = (globalThis as any).document;
              const range = doc.createRange();
              range.selectNodeContents(doc.querySelector(".live-tool-row pre"));
              doc.getSelection().removeAllRanges();
              doc.getSelection().addRange(range);
            });
            expect(
              await page.evaluate(() =>
                (globalThis as any).getSelection().toString(),
              ),
            ).toContain("latest-");
            expect(await bar.getAttribute("aria-expanded")).toBe("true");
          } else {
            await body.getByText("Output withheld", { exact: true }).waitFor();
            expect(await body.innerText()).not.toContain("sk-example");
            expect(await bar.getAttribute("title")).not.toContain("sk-example");
            expect(await body.locator("code").innerText()).toBe(
              "Command withheld",
            );
          }
          const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
          if (shots)
            await page.screenshot({
              path: `${shots}/live-tools-${width}-${mode}-expanded.png`,
            });
          if (mode === "background-output") {
            expect(
              await page.locator(".turn-summary").allInnerTexts(),
            ).toContain("Ran 1 command");
            await page.locator(".working .shell-chip").click();
            const shell = page.locator(".shell-surface .shell-row").first();
            await shell.waitFor();
            expect(await shell.locator(".shell-command").innerText()).toEndWith(
              "END_OF_COMMAND",
            );
            const meta = shell.locator(".shell-meta");
            expect(await meta.innerText()).toMatch(/Running[\s\S]*\d+s/);
            const metaBox = (await meta.boundingBox())!;
            const list = page.locator(".shell-surface .shell-list");
            const listBox = (await list.boundingBox())!;
            expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
            expect(metaBox.y).toBeGreaterThanOrEqual(listBox.y);
            expect(metaBox.y + metaBox.height).toBeLessThanOrEqual(
              listBox.y + listBox.height,
            );
            if (shots)
              await page.screenshot({
                path: `${shots}/live-tools-${width}-background-shell.png`,
              });
            await list.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            expect(await shell.locator(".shell-command").innerText()).toEndWith(
              "END_OF_COMMAND",
            );
            if (shots)
              await page.screenshot({
                path: `${shots}/live-tools-${width}-background-shell-command-end.png`,
              });
            await page.locator(".shell-surface-close").click();
          }
          await bar.click();
          await body.waitFor({ state: "hidden" });
          expect(
            (await page.locator(".live-panel-box").boundingBox())!.height,
          ).toBe(34);
          expect(errors).toEqual([]);
        } finally {
          if (agent) {
            await post("__browser-test/durable-release");
            const view = await (
              await page.request.get(`${base}api/conversations/${agent}/view`)
            ).json();
            await post(`api/conversations/${agent}/deliver`, {
              run_id: view.active_run,
            });
          }
          await page.close();
        }
      }
    }
  },
];
