import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Locator } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";
import {
  filePage,
  showFilesList,
  openListedFile,
  openReplyFile,
  closeFileTab,
} from "./files_support";

async function waitForDrawn(target: Locator): Promise<void> {
  await target
    .page()
    .waitForFunction(
      (element: any) => element.dataset.drawn === "true",
      await target.elementHandle(),
    );
}

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
  async function test_pdf_pages_draw_in_the_detail_view(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = (await postFixture(base, "seed-published-pdf")) as {
      demo: string;
    };
    const pdfRequests: string[] = [];
    const pdfWorkers = () =>
      page
        .workers()
        .filter((worker) => worker.url().endsWith("/pdf.worker.js"));
    const remote: string[] = [];
    context.on("request", (request) => {
      const url = request.url();
      if (/^https?:/.test(url) && !url.startsWith(base)) remote.push(url);
    });
    page.on("request", (request) => {
      if (/\/static\/pdf/.test(request.url())) pdfRequests.push(request.url());
    });
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page.locator("#conv-title", { hasText: "Published PDF" }).waitFor();
      expect(pdfRequests).toEqual([]);
      const initialWorker = page.waitForEvent("worker");
      let detail = await openReplyFile(page, "slides.pdf");
      const pages = detail.locator(".files-pdf-page");
      await detail.getByRole("img", { name: "Page 2 of 2" }).waitFor();
      expect(await pages.count()).toBe(2);
      const first = await pages.first().elementHandle();
      await waitForDrawn(pages.first());
      const pixel = await page.evaluate((el: any) => {
        const data = el
          .getContext("2d")
          .getImageData(el.width / 2, el.height / 2, 1, 1).data;
        return [data[0], data[1], data[2]];
      }, first);
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(60);
      expect(
        pdfRequests.some((url) => url.endsWith("/static/pdfjs/pdf.worker.js")),
      ).toBe(true);
      await initialWorker;
      expect(pdfWorkers()).toHaveLength(1);
      const firstClosed = pdfWorkers()[0].waitForEvent("close");
      await closeFileTab(page);
      await firstClosed;
      expect(pdfWorkers()).toHaveLength(0);
      await showFilesList(page);
      const reopened = page.waitForEvent("worker");
      await openListedFile(page, "slides.pdf");
      await detail.getByRole("img", { name: "Page 1 of 2" }).waitFor();
      const reopenedWorker = await reopened;
      expect(pdfWorkers()).toHaveLength(1);
      const cmap = page.waitForResponse((response) =>
        response.url().endsWith("/static/pdfjs/cmaps/UniJIS-UCS2-H.bcmap"),
      );
      const notesWorker = page.waitForEvent("worker");
      detail = await openReplyFile(page, "notes-ja.pdf");
      expect((await cmap).status()).toBe(200);
      await waitForDrawn(detail.getByRole("img", { name: "Page 1 of 1" }));
      const notes = await notesWorker;
      expect(pdfWorkers()).toHaveLength(2);
      expect(pdfWorkers()).toContain(reopenedWorker);
      const notesClosed = notes.waitForEvent("close");
      await closeFileTab(page);
      await notesClosed;
      expect(pdfWorkers()).toHaveLength(1);
      detail = await openReplyFile(page, "long.pdf");
      const last = detail.getByRole("img", { name: "Page 16 of 16" });
      await last.waitFor();
      await waitForDrawn(detail.getByRole("img", { name: "Page 1 of 16" }));
      expect(
        await detail.locator('.files-pdf-page[data-drawn="true"]').count(),
      ).toBeLessThan(16);
      const box = (await detail
        .getByRole("img", { name: "Page 1 of 16" })
        .boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.2, {
        steps: 8,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      await page
        .locator(".report-comment-popover textarea")
        .fill("Retained PDF note");
      await page.keyboard.press("Escape");
      const retained = await detail.locator(".pane-body").elementHandle();
      await detail.locator(".pane-body").focus();
      await page.keyboard.press("Escape");
      await page.waitForFunction((body: any) => !body.isConnected, retained);
      await openReplyFile(page, "notes-ja.pdf");
      detail = await openReplyFile(page, "long.pdf");
      expect(
        await detail
          .locator(".pane-body")
          .evaluate((node, prior) => node === prior, retained),
      ).toBeTrue();
      await detail.locator("mark.report-cbox").waitFor();
      await detail.locator(".report-comment-del").click();
      await detail.locator(".pane-body").focus();
      await page.keyboard.press("Shift+G");
      await waitForDrawn(last);
      await page.waitForFunction(
        (el: any) => !el.dataset.drawn && el.width === 0,
        await detail.getByRole("img", { name: "Page 1 of 16" }).elementHandle(),
      );
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await waitForDrawn(detail.getByRole("img", { name: "Page 1 of 16" }));
      for (const [path, status] of [
        ["wasm/openjpeg.wasm", 200],
        ["wasm/jbig2.wasm", 200],
        ["standard_fonts/FoxitSerif.pfb", 200],
        ["iccs/CGATS001Compat-v2-micro.icc", 200],
        ["wasm/quickjs-eval.wasm", 404],
      ] as const) {
        const response = await page.request.get(`${base}static/pdfjs/${path}`);
        expect([path, response.status()]).toEqual([path, status]);
      }
      const closing = pdfWorkers().map((worker) =>
        worker.waitForEvent("close"),
      );
      for (const id of await page
        .locator(".pane-col.file-tab")
        .evaluateAll((panels) =>
          panels.map((panel) => panel.getAttribute("data-pane")!),
        ))
        await closeFileTab(page, id);
      const brokenWorker = page
        .waitForEvent("worker")
        .then((worker) => worker.waitForEvent("close"));
      detail = await openReplyFile(page, "broken.pdf");
      await detail
        .getByText("Couldn’t show this PDF. Download it to open it.")
        .waitFor();
      expect(await detail.locator(".files-pdf-page").count()).toBe(0);
      await Promise.all([...closing, brokenWorker]);
      expect(pdfWorkers()).toHaveLength(0);
      expect(remote).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_pdf_draws_on_a_phone_browser_without_newer_builtins(
    browser,
    base,
  ) {
    const printer = await browser.newPage();
    await printer.setContent(`<body style="font: 16px serif"><script>
      for (let n = 1; n <= 3; n++) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 500;
        const context = canvas.getContext("2d");
        const noise = context.createImageData(500, 500);
        for (let i = 0; i < noise.data.length; i++)
          noise.data[i] = Math.random() * 256;
        context.putImageData(noise, 0, 0);
        document.body.insertAdjacentHTML("beforeend",
          '<div style="break-after: page"><h1>Page ' + n + " report</h1><p>" +
          "Quarterly figures. ".repeat(60) + '</p><img src="' +
          canvas.toDataURL() + '" style="width: 400px"></div>');
      }
    </script></body>`);
    const pdf = await printer.pdf({ format: "A4" });
    await printer.close();
    const seeded = await fetch(`${base}__browser-test/seed-posted-pdf`, {
      method: "POST",
      body: new Uint8Array(pdf),
    });
    const { demo } = (await seeded.json()) as { demo: string };
    const { context, page, errors } = await filePage(browser, 412, 915, true);
    const older =
      "delete Promise.try; delete Math.sumPrecise;" +
      "for (const name of ['getOrInsert', 'getOrInsertComputed']) {" +
      " delete Map.prototype[name]; delete WeakMap.prototype[name]; }" +
      "for (const name of ['fromBase64', 'fromHex']) delete Uint8Array[name];" +
      "for (const name of ['toBase64', 'toHex', 'setFromBase64', 'setFromHex'])" +
      " delete Uint8Array.prototype[name];";
    await context.addInitScript(older);
    await context.route("**/static/pdfjs/pdf.worker.js", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `${older}\n${await response.text()}`,
      });
    });
    const workers: string[] = [];
    page.on("worker", (worker) => workers.push(worker.url()));
    try {
      await page.goto(`${base}#agent=${demo}`);
      await page.locator("#conv-title", { hasText: "Posted PDF" }).waitFor();
      await page
        .getByRole("button", { name: "Open report.pdf in Files" })
        .click();
      const first = page
        .locator('.pane-col[data-pane="files"] .files-detail')
        .getByRole("img", { name: "Page 1 of 3" });
      await first.waitFor();
      await waitForDrawn(first);
      const dark = await first.evaluate((el: any) => {
        const height = Math.floor(el.height * 0.2);
        const { data } = el
          .getContext("2d")
          .getImageData(0, 0, el.width, height);
        let count = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) count++;
        return count;
      });
      expect(dark).toBeGreaterThan(100);
      expect(workers).toEqual([`${base}static/pdfjs/pdf.worker.js`]);
      expect(errors).toEqual([]);
    } finally {
      await closeWithRoutes(context);
    }
  },
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
            await closeFileTab(page);
            await pane.waitFor({ state: "detached" });
          }
          await openReplyFile(page, name);
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
if (import.meta.main) await runBrowserTests([["files-viewers", tests]]);
