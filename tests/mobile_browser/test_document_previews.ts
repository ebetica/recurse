import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Locator } from "playwright";
import {
  captureErrors,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

async function hitCorners(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  expect(
    await control.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return [
        [box.left + 8, box.top + 8],
        [box.right - 8, box.top + 8],
        [box.left + 8, box.bottom - 8],
        [box.right - 8, box.bottom - 8],
      ].every(([x, y]) =>
        element.contains((globalThis as any).document.elementFromPoint(x, y)),
      );
    }),
  ).toBeTrue();
}

async function codeStyle(pre: Locator) {
  return pre.evaluate((element) => {
    const view = (target: any) => (globalThis as any).getComputedStyle(target);
    const block = view(element);
    const code = view(element.querySelector("code"));
    return {
      background: block.backgroundColor,
      border: block.borderTopStyle,
      radius: block.borderRadius,
      padding: block.padding,
      family: code.fontFamily,
      size: code.fontSize,
    };
  });
}

export const tests: BrowserTest[] = [
  // Feature: #3173 published documents use lazy, bounded, offline previews on desktop and phones.
  async function test_published_document_previews(browser, base) {
    const { demo } = await postFixture(base, "seed-document-previews");
    for (const width of [1280, 412]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const remote: string[] = [];
      context.on("request", (request) => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(base))
          remote.push(request.url());
      });
      try {
        await page.goto(`${base}#agent=${demo}`);
        await page.getByText("Documents published.", { exact: true }).waitFor();
        expect(page.workers()).toHaveLength(0);
        const markdownCode = await codeStyle(
          page.locator("#messages .content pre:has(code)").last(),
        );
        const pane = page.locator(
          width === 412
            ? '.pane-col[data-pane="files"]'
            : ".pane-col.file-tab:visible",
        );
        const open = async (name: string) => {
          if (await pane.isVisible()) {
            if (width === 412)
              await pane.locator(".pane-powerbar > .x").click();
            else {
              const id = await pane.getAttribute("data-pane");
              const tab = page.locator(`.dv-tab[data-dock-panel="${id}"]`);
              await tab.hover();
              await tab.getByRole("button", { name: /^Close / }).click();
            }
            await pane.waitFor({ state: "detached" });
          }
          await page
            .getByRole("button", { name: `Open ${name} in Files`, exact: true })
            .click();
          await pane.locator(".files-document").waitFor();
          await pane
            .getByRole("link", { name: "Download", exact: true })
            .waitFor();
          expect(await pane.locator(".files-meta").innerText()).not.toContain(
            "application/octet-stream",
          );
          return pane.frameLocator(".files-document-frame");
        };
        const shot = async (name: string) => {
          if (!process.env.RECURSE_BROWSER_SCREENSHOT_DIR) return;
          await mkdir(process.env.RECURSE_BROWSER_SCREENSHOT_DIR, {
            recursive: true,
          });
          await page.screenshot({
            path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/${name}-${width}.png`,
          });
        };
        let frame = await open("preview.docx");
        await frame
          .getByRole("heading", { name: "Document preview" })
          .waitFor();
        expect(await frame.locator("strong").innerText()).toBe("bold text");
        expect(await frame.locator("em").innerText()).toBe("italic text");
        expect(await frame.locator("li").allTextContents()).toEqual([
          "First item",
          "Second item",
        ]);
        expect(await frame.locator("td").allTextContents()).toContain(
          "Document cell",
        );
        await frame.getByRole("img").first().waitFor();
        expect(
          await frame
            .getByRole("img")
            .first()
            .evaluate((image: any) => image.complete && image.naturalWidth > 0),
        ).toBeTrue();
        expect(
          await pane
            .locator(".files-document > .files-preview-note:visible")
            .count(),
        ).toBe(0);
        await shot("docx");
        for (const [ext, text] of [
          ["xlsx", "Summary cell"],
          ["xls", "Summary cell"],
          ["ods", "Summary cell"],
          ["csv", "CSV cell"],
          ["tsv", "TSV cell"],
        ]) {
          frame = await open(`preview.${ext}`);
          await frame.getByRole("cell", { name: text, exact: true }).waitFor();
          expect(await frame.locator("body").innerText()).not.toContain(
            "Hidden row 201",
          );
          expect(await frame.locator("body").innerText()).not.toContain(
            "Hidden column AE",
          );
          if (ext === "xlsx") {
            await pane
              .getByText(
                "Showing the first 200 of 1,234 rows. Showing the first 30 of 31 columns.",
                { exact: true },
              )
              .waitFor();
            await frame
              .getByRole("cell", { name: `${"x".repeat(499)}…`, exact: true })
              .waitFor();
          } else
            expect(
              await pane
                .locator(".files-document > .files-preview-note:visible")
                .count(),
            ).toBe(0);
          if (["xlsx", "xls", "ods"].includes(ext)) {
            const details = pane.getByRole("button", {
              name: "Details",
              exact: true,
            });
            await hitCorners(details);
            await details.click();
            await frame
              .getByRole("cell", { name: "Details cell", exact: true })
              .waitFor();
          }
          await shot(ext);
        }
        frame = await open("preview.pptx");
        await frame
          .getByText("Presentation preview", { exact: true })
          .waitFor();
        await frame.getByRole("img").waitFor();
        await shot("pptx");
        const next = pane.getByRole("button", { name: "Slide 2", exact: true });
        await hitCorners(next);
        await next.click();
        await frame.getByText("Second slide", { exact: true }).waitFor();
        frame = await open("preview.ipynb");
        await frame
          .getByRole("heading", { name: "Notebook preview" })
          .waitFor();
        await frame.getByText("Notebook output", { exact: true }).waitFor();
        await frame.getByText("HTML output", { exact: true }).waitFor();
        expect(await frame.locator("code").innerText()).toContain(
          "print('Notebook output')",
        );
        await frame.getByRole("img").waitFor();
        expect(await codeStyle(frame.locator(".nb-input pre").first())).toEqual(
          markdownCode,
        );
        expect(
          await pane
            .locator(".files-document > .files-preview-note:visible")
            .count(),
        ).toBe(0);
        expect(
          await frame.locator("script, iframe, [onerror], a[href]").count(),
        ).toBe(0);
        expect(await pane.locator("iframe").getAttribute("sandbox")).toBe("");
        expect(
          await pane
            .locator("iframe")
            .evaluate((element: any) => element.contentDocument === null),
        ).toBeTrue();
        expect(
          await page.locator("body").getAttribute("data-document-script"),
        ).toBeNull();
        await shot("ipynb");
        frame = await open("limits.xlsx");
        await frame
          .getByRole("cell", { name: "Limited sheet 1", exact: true })
          .waitFor();
        await pane
          .getByText("Showing 20 of 31 sheets.", { exact: true })
          .waitFor();
        expect(
          await pane.locator(".files-document-tabs > button").count(),
        ).toBe(20);
        frame = await open("limits.pptx");
        await frame.getByText("Limited slide 1", { exact: true }).waitFor();
        await pane
          .getByText("Slide layout isn't shown. Showing 100 of 140 slides.", {
            exact: true,
          })
          .waitFor();
        expect(
          await pane.locator(".files-document-tabs > button").count(),
        ).toBe(100);
        frame = await open("limits.ipynb");
        await frame.locator("code").first().waitFor();
        expect(await frame.locator("code").first().innerText()).toBe(
          "limited_cell_0 = 0",
        );
        expect(await frame.locator("body").innerText()).not.toContain(
          "legacy_worksheet_cell",
        );
        await frame
          .getByText("Showing 50 of 51 outputs.", { exact: true })
          .waitFor();
        await pane
          .getByText("Showing 200 of 260 cells.", { exact: true })
          .waitFor();
        expect(await frame.locator("body").innerText()).not.toContain(
          "limited_cell_200",
        );
        expect(await frame.locator("body").innerText()).not.toContain(
          "Limited output 50",
        );
        for (const name of ["expanded.docx", "expanded.csv"]) {
          await open(name);
          await pane
            .getByText(
              "This document expands beyond the preview limit. Download it to open it.",
              { exact: true },
            )
            .waitFor();
        }
        await open("oversized.docx");
        await pane
          .getByText(
            "This file is too large to preview (limit: 8 MB). Download it to open it.",
            { exact: true },
          )
          .waitFor();
        const download = pane.getByRole("link", {
          name: "Download",
          exact: true,
        });
        await hitCorners(download);
        const downloading = page.waitForEvent("download");
        await download.click();
        expect((await downloading).suggestedFilename()).toBe("oversized.docx");
        expect(page.workers()).toHaveLength(0);
        expect(remote).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
];
if (import.meta.main) await runBrowserTests([["document-previews", tests]]);
