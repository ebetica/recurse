import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { assertDocumentLinks } from "./document_links";
import {
  dispatchArtifactSelection,
  gotoRoot,
  postFixture,
  runBrowserTests,
  type BrowserTest,
  MERMAID_DIAGRAM,
} from "./common";
import {
  filePage,
  fileShot,
  filesSurface,
  showFilesList,
  openListedFile,
  openReplyFile,
  renderedText,
} from "./files_support";

export const tests: BrowserTest[] = [
  // Feature: #2593 #3369 published diffs retain syntax, changed lines and pinned desktop file headers.
  async function test_published_diff_has_syntax_and_line_colours(
    browser,
    base,
  ) {
    const { demo } = await postFixture(base, "seed-published-diff");
    for (const width of [1280, 412]) {
      const { context, page, errors } = await filePage(browser, width, 900);
      try {
        await page.goto(`${base}#agent=${demo}`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .getByRole("button", { name: "Open review.diff in Files" })
          .click();
        const diff = filesSurface(page).locator(".files-detail .files-diff");
        await diff.locator(".diff-row.add .hljs-keyword").first().waitFor();
        expect(await diff.locator(".diff-row.del").count()).toBeGreaterThan(0);
        expect(
          await diff.locator(".diff-row.del", { hasText: "-- old" }).count(),
        ).toBe(1);
        expect(
          await diff.locator(".diff-row.add", { hasText: "++ new" }).count(),
        ).toBe(1);
        expect(
          await diff.locator(".diff-hunk", { hasText: "@@" }).count(),
        ).toBeGreaterThan(0);
        expect(
          await diff
            .locator(".files-diff-header", { hasText: "diff --git" })
            .count(),
        ).toBe(2);
        const colours = await diff.evaluate((element) => {
          const style = (selector: string) =>
            (globalThis as any).getComputedStyle(
              element.querySelector(selector)!,
            );
          return {
            add: style(".add").backgroundColor,
            del: style(".del").backgroundColor,
            syntax: style(".hljs-keyword").color,
            code: style(".diff-line").color,
          };
        });
        expect(colours.add).not.toBe(colours.del);
        expect(colours.syntax).not.toBe(colours.code);
        expect(
          await page
            .locator("body")
            .evaluate(
              (element) =>
                element.scrollWidth <= (globalThis as any).innerWidth,
            ),
        ).toBeTrue();
        if (width === 1280) {
          const pane = page.locator(".pane-col.file-tab:visible");
          const body = pane.locator(".pane-body");
          const head = pane.locator(".files-detail-head");
          const headTop = (await head.boundingBox())!.y;
          await body.focus();
          await page.keyboard.press("j");
          expect(
            await body.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
          await page.keyboard.press("Shift+G");
          expect(
            await body.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(500);
          expect((await head.boundingBox())!.y).toBe(headTop);
          const metadata = pane.locator(".files-detail-bar");
          expect((await metadata.boundingBox())!.y).toBe(
            (await body.boundingBox())!.y,
          );
          expect(
            await metadata.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return [
                [box.left + 2, box.top + 2],
                [box.right - 2, box.top + 2],
                [box.left + 2, box.bottom - 2],
                [box.right - 2, box.bottom - 2],
              ].every(
                ([x, y]) =>
                  element.ownerDocument.elementFromPoint(x, y) === element,
              );
            }),
          ).toBeTrue();
          expect(
            await pane
              .getByRole("link", { name: "Download", exact: true })
              .evaluate((element) => {
                const box = element.getBoundingClientRect();
                return [
                  [box.left + 4, box.top + 4],
                  [box.right - 4, box.top + 4],
                  [box.left + 4, box.bottom - 4],
                  [box.right - 4, box.bottom - 4],
                ].every(([x, y]) =>
                  element.contains(
                    element.ownerDocument.elementFromPoint(x, y),
                  ),
                );
              }),
          ).toBeTrue();
          await fileShot(page, "files-header-scrolled-desktop.png");
          const scrollTop = await body.evaluate((element) => element.scrollTop);
          await page.locator('.dv-tab[data-dock-panel="chat"]').click();
          await openReplyFile(page, "review.diff");
          expect(await body.evaluate((element) => element.scrollTop)).toBe(
            scrollTop,
          );
          await body.focus();
          await page.keyboard.press("g");
          await page.keyboard.press("g");
          expect(await body.evaluate((element) => element.scrollTop)).toBe(0);
        }
        await fileShot(page, `files-diff-${width}.png`);
        for (const name of ["review.patch", "review.txt"]) {
          await showFilesList(page);
          await openListedFile(page, name);
          await filesSurface(page)
            .locator(".files-detail .files-diff .hljs-keyword")
            .first()
            .waitFor();
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #3397 a Markdown picture click must open the shared viewer without consuming a text-selection drag.
  async function test_markdown_picture_clicks(browser, base, data) {
    const headings =
      "# Picture navigation\n\n## The chart\n\n### Details\n\n#### Labels\n\n##### Source\n\n###### About this example";
    const { agent, id } = await postFixture(base, "seed-artifact-sections", {
      markdown:
        `${headings}\n\nBefore image: select this sentence.\n\n` +
        '<img src="diagram.svg" alt="Artifact picture" width="50%">\n\n' +
        '<img src="diagram.svg" alt="Small picture" height="25%">\n\n' +
        "After image: keep the comment offer.\n\n[Notes](notes.md)\n\n![Blocked picture](https://example.com/blocked.svg)\n",
      replyMarkdown: `${headings}\n\nHere is the document.`,
    });
    const store = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const item = await artifacts.get(store, agent, id);
    await writeFile(
      join(String(item.repo_path), "diagram.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="450" viewBox="0 0 640 240"><rect width="640" height="240" fill="#8bc4ed"/><circle cx="140" cy="120" r="64" fill="#336b9a"/><text x="240" y="125" font-size="28">Artifact picture</text></svg>',
    );
    await writeFile(
      join(String(item.repo_path), "notes.md"),
      "# Picture notes\n\n![File picture](diagram.svg)\n",
    );
    await artifacts.publish(store, agent, id);
    const headingScale = (content: Element) => {
      const body = parseFloat(
        getComputedStyle(content.querySelector("p")!).fontSize,
      );
      return [...content.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((heading) =>
        Number(
          (parseFloat(getComputedStyle(heading).fontSize) / body).toFixed(3),
        ),
      );
    };
    const layouts = [];
    for (const width of [1280, 412]) {
      const { context, page, errors } = await filePage(
        browser,
        width,
        844,
        width === 412,
      );
      const external: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith("https://example.com/"))
          external.push(request.url());
      });
      await page.goto(`${base}#agent=${agent}`);
      const section = page.getByRole("link", { name: "Section", exact: true });
      await section.waitFor();
      const replyHeadings = await page
        .locator(".msg.assistant .content")
        .evaluate(headingScale);
      await section.click();
      const report = page.locator('.pane-col[data-pane="report"]');
      const markdown = report.locator(".artifact-markdown");
      const picture = report.locator(
        'img[alt="Artifact picture"]:not([hidden])',
      );
      const small = report.locator('img[alt="Small picture"]:not([hidden])');
      await picture.waitFor();
      await small.waitFor();
      layouts.push({
        width,
        replyHeadings,
        documentHeadings: await markdown.evaluate(headingScale),
        imageWidthPercent: await picture.evaluate((image) => {
          const body = image.closest(".artifact-markdown")!.querySelector("p")!;
          return Math.round(
            (100 * image.getBoundingClientRect().width) /
              body.getBoundingClientRect().width,
          );
        }),
        imageHeightPercent: await small.evaluate((image) =>
          Math.round(
            (100 * image.getBoundingClientRect().height) /
              (image as HTMLImageElement).naturalHeight,
          ),
        ),
      });
      await fileShot(page, `artifact-markdown-layout-${width}.png`);
      if (width === 1280) {
        const text = (await report
          .getByText("Before image: select this sentence.", { exact: true })
          .boundingBox())!;
        const image = (await picture.boundingBox())!;
        await page.mouse.move(text.x + 2, text.y + text.height / 2);
        await page.mouse.down();
        await page.mouse.move(
          image.x + image.width / 2,
          image.y + image.height / 2,
          { steps: 12 },
        );
        await page.mouse.up();
        expect(
          await page.getByRole("dialog", { name: "Image viewer" }).count(),
        ).toBe(0);
        const popover = page.locator(".report-comment-popover:not([hidden])");
        await popover
          .locator("textarea")
          .fill("Preserve the picture selection");
        await popover
          .getByRole("button", { name: "Comment", exact: true })
          .click();
      }
      await picture.click();
      const viewer = page.getByRole("dialog", { name: "Image viewer" });
      await viewer.waitFor();
      await viewer
        .locator("img.files-image")
        .evaluate((image: any) => image.decode());
      expect(
        await viewer.locator("img.files-image").getAttribute("src"),
      ).toContain(`/api/artifacts/${id}/file?`);
      await fileShot(page, `artifact-image-viewer-${width}.png`);
      await viewer
        .getByRole("button", { name: "Close image", exact: true })
        .click();
      await viewer.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => !(globalThis as any).history.state?.imagePopout,
      );
      if (width === 1280) {
        expect(await report.locator(".report-comment-text").textContent()).toBe(
          "Preserve the picture selection",
        );
        await report.locator(".report-comment-del").click();
      }
      await report
        .getByRole("button", {
          name: "Show image from example.com",
          exact: true,
        })
        .waitFor();
      expect(external).toEqual([]);
      await report.getByRole("link", { name: "Notes", exact: true }).click();
      await report
        .locator('.report-doc img[alt="File picture"]:not([hidden])')
        .click();
      await viewer.waitFor();
      await viewer
        .getByRole("button", { name: "Close image", exact: true })
        .click();
      await viewer.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => !(globalThis as any).history.state?.imagePopout,
      );
      expect(errors).toEqual([]);
      await context.close();
    }
    expect(layouts).toEqual(
      [1280, 412].map((width) => ({
        width,
        replyHeadings: [1.25, 1.1, 1.02, 1, 0.83, 0.67],
        documentHeadings: [2, 1.5, 1.25, 1, 0.875, 0.85],
        imageWidthPercent: 50,
        imageHeightPercent: 25,
      })),
    );
  },
  // Feature: #3362 #3307 #3369 #3397 Markdown retains shared images, sanitized links and visible heading jumps.
  async function test_published_file_opens_its_detail_view(
    browser,
    base,
    data,
  ) {
    for (const width of [390, 1280]) {
      const { context, page, errors } = await filePage(
        browser,
        width,
        844,
        width === 390,
      );
      const fixture = (await postFixture(base, "seed-published-markdown")) as {
        demo: string;
        id: string;
      };
      const remote: string[] = [];
      page.on("request", (request) => {
        if (!request.url().startsWith(base)) remote.push(request.url());
      });
      if (width === 390)
        await page.route("**/attachments/*/thumbnail", (route) =>
          route.fulfill({ status: 404, body: "not found" }),
        );
      try {
        await page.goto(`${base}#agent=${fixture.demo}`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .locator("#conv-title", { hasText: "Published files" })
          .waitFor();
        const item = page.locator(".agent-attachment-item.file", {
          hasText: "report.md",
        });
        await item.waitFor();
        const chip = (await item.boundingBox())!;
        if (width === 1280) expect(chip.height).toBeLessThanOrEqual(34);
        expect(chip.width).toBeLessThan(220);
        await fileShot(page, `files-reply-${width}.png`);
        expect(
          await item
            .locator(".agent-attachment-file-download")
            .getAttribute("href"),
        ).toBe(`/api/conversations/${fixture.demo}/attachments/${fixture.id}`);
        await item
          .getByRole("button", { name: "Open report.md in Files" })
          .click();
        if (width === 1280)
          await page.locator(".dv-tab", { hasText: "report.md" }).waitFor();
        const list = page.locator('.pane-col[data-pane="files"]');
        const pane =
          width === 1280 ? page.locator(".pane-col.file-tab:visible") : list;
        const detail = pane;
        await detail.locator(".files-markdown h1").waitFor();
        expect(await detail.locator(".files-markdown h1").innerText()).toBe(
          "Weekly report",
        );
        await assertDocumentLinks(detail.locator(".files-markdown"));
        expect(await detail.locator(".files-markdown strong").innerText()).toBe(
          "previews",
        );
        await detail.locator(`.files-markdown ${MERMAID_DIAGRAM}`).waitFor();
        await detail.locator(".files-markdown .katex-display .katex").waitFor();
        expect(await detail.locator(".files-markdown .katex").count()).toBe(2);
        await detail
          .locator('.files-markdown img[alt="Local diagram"]:not([hidden])')
          .waitFor();
        const image = detail.locator(
          '.files-markdown img[alt="Local diagram"]',
        );
        expect(await image.getAttribute("src")).toMatch(
          width === 390 ? /\/preview$/ : /\/thumbnail$/,
        );
        expect((await image.boundingBox())!.height).toBeGreaterThan(360);
        expect((await image.boundingBox())!.width).toBeGreaterThan(0);
        expect(
          await detail
            .locator(".files-markdown table")
            .evaluate(
              (table: any) =>
                table.getBoundingClientRect().width <=
                table.closest(".artifact-markdown").getBoundingClientRect()
                  .width,
            ),
        ).toBeTrue();
        for (const alt of ["Absolute path", "Unpublished relative path"]) {
          const local = detail.locator(
            `.files-markdown img[alt="${alt}"]:not([hidden])`,
          );
          await local.waitFor();
          await local.evaluate((image: any) => image.decode());
          expect(await local.getAttribute("src")).toContain("/path-image?");
        }
        await detail
          .getByRole("button", {
            name: "Show image from example.com",
            exact: true,
          })
          .waitFor();
        const disguised = detail.getByRole("button", {
          name: "Expand details",
          exact: true,
        });
        expect(await disguised.getAttribute("data-external-image")).toBeNull();
        await disguised.click();
        expect(await disguised.innerText()).toBe("Expand details");
        expect(remote).toEqual([]);
        expect(await pane.locator(".files-grid").count()).toBe(0);
        if (width === 1280) {
          const heading = pane.locator(".files-markdown h1");
          const metadata = pane.locator(".files-detail-bar");
          const body = pane.locator(".pane-body");
          await body.focus();
          await page.keyboard.press("Shift+G");
          expect(
            await body.evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
          await heading.evaluate((element) =>
            element.scrollIntoView({ block: "start" }),
          );
          const headingBox = (await heading.boundingBox())!;
          const metadataBox = (await metadata.boundingBox())!;
          expect(headingBox.y).toBeGreaterThanOrEqual(
            metadataBox.y + metadataBox.height,
          );
          await fileShot(page, "files-heading-jump-desktop.png");
        }
        await fileShot(page, `files-detail-markdown-${width}.png`);
        await dispatchArtifactSelection(
          page,
          width === 390 ? "touch" : "mouse",
          "Weekly report",
        );
        const popover = page.locator(".report-comment-popover:not([hidden])");
        await popover.waitFor();
        await popover.locator("textarea").fill("Explain the report");
        if (width !== 390) {
          const input = popover.locator("textarea");
          await input.click();
          expect(
            await input.evaluate(
              (element: any) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          await pane.locator(".pane-body").focus();
          await page.keyboard.press("c");
          expect(
            await input.evaluate(
              (element: any) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          expect(await input.inputValue()).toBe("Explain the report");
          expect(await pane.locator(".report-comment").count()).toBe(0);
          await pane.locator(".pane-body").focus();
          await page.keyboard.press("z");
          expect(await pane.getAttribute("class")).toContain("fullscreen");
          expect(await pane.getAttribute("role")).toBe("region");
          expect(await pane.getAttribute("aria-modal")).toBeNull();
          await popover.waitFor();
          await page.keyboard.press("c");
          expect(
            await input.evaluate(
              (element: any) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          await page.keyboard.press("c");
          expect(await input.inputValue()).toBe("Explain the reportc");
          await page.keyboard.press("Backspace");
          await pane.locator(".pane-body").focus();
          await page.keyboard.press("z");
        }
        await popover.getByRole("button", { name: "Comment" }).click();
        expect(await pane.locator("mark.report-cmark").textContent()).toBe(
          "Weekly report",
        );
        if (width === 1280) {
          if (!(await list.isVisible()))
            await page.locator('.rail-btn[data-pane="files"]').click();
          await list.locator(".files-grid").waitFor();
          expect(await list.locator(".files-grid").count()).toBe(1);
          expect(
            await detail.getByRole("button", { name: "All files" }).count(),
          ).toBe(0);
          await page.locator('.dv-tab[data-dock-panel="files"]').click();
        } else await showFilesList(page);
        const card = list.locator(".files-card", { hasText: "report.md" });
        await card.waitFor();
        expect(await card.locator(".files-markdown").count()).toBe(0);
        await card.getByRole("button", { name: "Open report.md" }).click();
        await pane.locator(".files-detail .files-markdown h1").waitFor();
        expect(remote).toEqual([]);
        if (width === 1280) {
          const enlarge = async (
            target: typeof image,
            shot: string,
            local = false,
            artifact = false,
          ) => {
            await target.scrollIntoViewIfNeeded();
            await fileShot(page, shot.replace("image-", "document-"));
            const viewer = page.getByRole("dialog", { name: "Image viewer" });
            await target.click();
            if (!artifact) {
              expect(await viewer.count()).toBe(0);
              await target.dblclick();
            }
            const shown = viewer.locator("img.files-image");
            await shown.waitFor();
            await shown.evaluate((node: any) => node.decode());
            const original = new URL((await shown.getAttribute("src"))!, base);
            expect(original.pathname).not.toEndWith("/thumbnail");
            expect(original.searchParams.has("thumbnail")).toBeFalse();
            const expected = new URL((await target.getAttribute("src"))!, base);
            expected.pathname = expected.pathname.replace(
              /\/thumbnail$/,
              "/preview",
            );
            expected.searchParams.delete("thumbnail");
            expect(original.href).toBe(expected.href);
            expect(await shown.getAttribute("alt")).toBe(
              local
                ? original.searchParams.get("path")!.split("/").pop()!
                : await target.getAttribute("alt"),
            );
            await fileShot(page, shot);
            const downloading = page.waitForEvent("download");
            await viewer
              .getByRole("button", { name: "Download", exact: true })
              .click();
            expect(await (await downloading).failure()).toBeNull();
            await page.keyboard.press("Escape");
            await viewer.waitFor({ state: "detached" });
            await page.waitForFunction(
              () => !(globalThis as any).history.state?.imagePopout,
            );
          };
          await enlarge(image, "markdown-image-files-desktop.png");
          await enlarge(
            detail.locator('.files-markdown img[alt="Absolute path"]'),
            "markdown-path-image-files-desktop.png",
            true,
          );
          const store = {
            artifactsDir: join(data, "data", "artifact_repos"),
            trashDir: join(data, "data", "trash"),
          };
          const artifact = await artifacts.create(store, {
            owner: fixture.demo,
            title: "Markdown image report",
          });
          const asset = await page.request.get(
            new URL((await image.getAttribute("src"))!, base).href,
          );
          await writeFile(
            join(String(artifact.repo_path), "diagram.svg"),
            new Uint8Array(await asset.body()),
          );
          await writeFile(
            join(String(artifact.repo_path), "index.md"),
            "# Markdown image report\n\n![Artifact diagram](./diagram.svg)\n\n[![Linked diagram](./diagram.svg)](https://example.com/image-link)\n\n![Unapproved diagram](https://example.com/not-approved.svg)\n",
          );
          await artifacts.publish(store, fixture.demo, String(artifact.id));
          await page.goto(
            `${base}#agent=${fixture.demo}&artifact=${artifact.id}`,
          );
          const report = page.locator('.pane-col[data-pane="report"]');
          const artifactImage = report.locator(
            'img[alt="Artifact diagram"]:not([hidden])',
          );
          await artifactImage.waitFor();
          await enlarge(
            artifactImage,
            "markdown-image-artifact-desktop.png",
            false,
            true,
          );
          await context.route("https://example.com/image-link", (route) =>
            route.fulfill({ body: "Linked image destination" }),
          );
          const popup = page.waitForEvent("popup");
          await report
            .locator('img[alt="Linked diagram"]:not([hidden])')
            .click();
          const linked = await popup;
          await linked.waitForURL("https://example.com/image-link");
          await linked.close();
          await report
            .getByRole("button", {
              name: "Show image from example.com",
              exact: true,
            })
            .waitFor();
          expect(
            await report
              .getByRole("img", { name: "Unapproved diagram" })
              .count(),
          ).toBe(0);
          expect(remote).toEqual([]);
        } else {
          await image.tap();
          const viewer = page.getByRole("dialog", { name: "Image viewer" });
          await viewer
            .locator("img.files-image")
            .evaluate((image: any) => image.decode());
          await fileShot(page, "markdown-image-files-phone.png");
          await viewer
            .getByRole("button", { name: "Close image", exact: true })
            .click();
          await viewer.waitFor({ state: "detached" });
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_svg_audio_and_video_preview_in_the_detail_view(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = (await postFixture(base, "seed-published-media")) as {
      demo: string;
    };
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page
        .locator("#conv-title", { hasText: "Published media" })
        .waitFor();
      let detail = await openReplyFile(page, "chart.svg");
      const svg = detail.locator(".files-detail img");
      await svg.waitFor();
      await page.waitForFunction(
        (el: any) => el.complete && el.naturalWidth === 40,
        await svg.elementHandle(),
      );
      detail = await openReplyFile(page, "tone.wav");
      const audio = detail.locator("audio.files-media");
      await audio.waitFor();
      await page.waitForFunction(
        (el: any) => el.duration > 0,
        await audio.elementHandle(),
      );
      detail = await openReplyFile(page, "clip.webm");
      const video = detail.locator("video.files-media");
      await video.waitFor();
      expect(await video.getAttribute("src")).toEndWith("/preview");
      await showFilesList(page);
      const card = page.locator(".files-card", { hasText: "tone.wav" });
      await card.waitFor();
      expect(await card.locator("audio, .files-preview-note").count()).toBe(0);
      await page.locator(".files-card", { hasText: ".env" }).waitFor();
      expect(
        await page.locator(".files-card").evaluateAll((cards: any[]) =>
          Object.fromEntries(
            cards.map((item) => [
              item.querySelector(".files-name").innerText,
              item
                .querySelector(".files-meta")
                .innerText.split(" · ")
                .filter((part: string) => !/^[\d.]+ [KM]?B$/.test(part))
                .join(" · "),
            ]),
          ),
        ),
      ).toEqual({
        "chart.svg": "SVG image · Published by agent",
        "tone.wav": "WAV audio · Published by agent",
        "clip.webm": "WEBM video · Published by agent",
        "pixel.png": "PNG image · Published by agent",
        Makefile: "Published by agent",
        ".env": "Published by agent",
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_large_files_download_natively(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-published-sizes");
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const source = async (link: any) => {
        await link.waitFor();
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          link.click(),
        ]);
        return [download.url().split(":")[0], download.suggestedFilename()];
      };
      const chip = (name: string) =>
        page.getByRole("link", { name: new RegExp(`^Download ${name}`) });
      expect(await source(chip("small.bin"))).toEqual(["blob", "small.bin"]);
      expect(await source(chip("large.bin"))).toEqual(["http", "large.bin"]);
      await page
        .getByRole("button", { name: "Open large.bin in Files" })
        .click();
      const pane = filesSurface(page);
      expect(
        await source(pane.getByRole("link", { name: "Download" })),
      ).toEqual(["http", "large.bin"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_a_republished_file_keeps_its_versions(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-published-versions");
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const chips = page.getByRole("button", {
        name: "Open report.md in Files",
      });
      await chips.nth(2).waitFor();
      await chips.first().click();
      const pane = filesSurface(page);
      const heading = pane.locator(".files-detail .files-markdown h1");
      await heading.waitFor();
      expect(await heading.innerText()).toBe("Draft 1");
      await pane.getByLabel("File options", { exact: true }).click();
      const menu = pane.getByRole("combobox", { name: "Version" });
      const firstId = await pane.getAttribute("data-pane");
      const firstValue = await menu.inputValue();
      const options = await menu
        .locator("option")
        .evaluateAll((items: any[]) =>
          items.map((item) => [
            item.textContent.trim().split(" ")[1],
            item.textContent.includes("latest"),
            item.selected,
          ]),
        );
      expect(options).toEqual([
        ["3", true, false],
        ["2", false, false],
        ["1", false, true],
      ]);
      await menu.selectOption({ index: 0 });
      await pane
        .locator(".files-detail .files-markdown h1", { hasText: "Draft 3" })
        .waitFor();
      await page.locator(`.dv-tab[data-dock-panel="${firstId}"]`).click();
      expect(await heading.innerText()).toBe("Draft 1");
      await pane.getByLabel("File options", { exact: true }).click();
      expect(await menu.inputValue()).toBe(firstValue);
      await showFilesList(page);
      const card = pane.locator(".files-card");
      await card.first().waitFor();
      expect(await card.count()).toBe(1);
      expect(await renderedText(card.locator(".files-meta"))).toMatch(
        /^MD file · .+ · 3 versions$/,
      );
      await card.getByRole("button", { name: "Open report.md" }).click();
      await pane
        .locator(".files-detail .files-markdown h1", { hasText: "Draft 3" })
        .waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  // Regression: #3377 A live turn must not offer the previous turn's file.
  async function test_a_published_file_opens_files_and_follows_new_versions(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-files-auto-open");
    const republish = async (gate?: string) =>
      (
        (await postFixture(base, "republish-auto-open", { gate })) as {
          draft: number;
        }
      ).draft;
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page.locator('.rail-btn[data-pane="files"]').waitFor();
      expect(await page.locator(".pane-col.file-tab").count()).toBe(0);
      const publishing = republish("first-publication");
      await page.locator(".msg.user").nth(1).waitFor();
      await postFixture(base, "release", {
        agent: demo,
        gate: "first-publication",
      });
      const first = await publishing;
      const firstView = page.locator(".pane-col.file-tab").filter({
        has: page.getByRole("heading", {
          name: `Draft ${first}`,
          exact: true,
          includeHidden: true,
        }),
      });
      await firstView.locator("h1").waitFor({ state: "attached" });
      expect(
        await page
          .locator('.dv-tab[data-dock-panel="chat"]')
          .getAttribute("class"),
      ).toContain("dv-active-tab");
      const second = await republish();
      await firstView
        .locator('select[aria-label="Version"] option', {
          hasText: `Version ${second}`,
        })
        .waitFor({ state: "attached" });
      expect(await firstView.locator("h1").textContent()).toBe(
        `Draft ${first}`,
      );
      await page
        .getByRole("button", { name: "Open report.md in Files" })
        .nth(second - 1)
        .click();
      const pane = page.locator(".pane-col.file-tab:visible");
      const heading = pane.locator(".files-markdown h1");
      await heading.filter({ hasText: `Draft ${second}` }).waitFor();
      await pane.getByLabel("File options", { exact: true }).click();
      await pane
        .getByRole("combobox", { name: "Version" })
        .selectOption({ index: 1 });
      await heading.filter({ hasText: `Draft ${first}` }).waitFor();
      expect(await page.locator(".pane-col.file-tab").count()).toBe(2);
      const third = await republish();
      await pane.getByLabel("File options", { exact: true }).click();
      await pane
        .getByRole("combobox", { name: "Version" })
        .locator("option", { hasText: `Version ${third}` })
        .waitFor({ state: "attached" });
      expect(await heading.innerText()).toBe(`Draft ${first}`);
      await page
        .locator(`.agent[data-id]:not([data-id="${demo}"])`)
        .first()
        .click();
      await page.waitForFunction(
        () => !(globalThis as any).document.querySelector(".pane-col.file-tab"),
      );
      const fourth = await republish();
      const focusedResponse = page.waitForResponse(
        (r) =>
          r.url().includes(`/conversations/${demo}?`) &&
          r.url().includes("focused=1"),
      );
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await (await focusedResponse).finished();
      await page
        .getByRole("button", {
          name: "Open report.md in Files",
          includeHidden: true,
        })
        .nth(fourth - 1)
        .waitFor({ state: "attached" });
      await heading.filter({ hasText: `Draft ${first}` }).waitFor();
      expect(await page.locator(".pane-col.file-tab").count()).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_a_bash_publish_shows_every_file_on_the_reply(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-published-bash");
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const chip = (name: string) =>
        page.getByRole("button", { name: `Open ${name} in Files` });
      await chip("plan.md").waitFor();
      await chip("notes.txt").waitFor();
      await chip("plan.md").click();
      await page
        .locator(
          ".pane-col.file-tab:visible .files-detail .files-markdown h1",
          {
            hasText: "Plan",
          },
        )
        .waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["files-viewers", tests]]);
