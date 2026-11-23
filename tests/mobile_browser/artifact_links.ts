import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as artifacts from "../../src/artifacts";
import { rectanglePdf } from "./server/media";
import {
  captureErrors,
  checkedTap,
  expectHitCorners,
  PNG_1X1,
  rootAgentId,
  postFixture,
  dispatchArtifactSelection,
  type BrowserTest,
} from "./common";

// Regression: #3363 #3397 #3674 Sibling Markdown stays in the Artifact pane and supports browser history.
export const artifactLinks: BrowserTest = async (browser, base, data) => {
  const store = {
    artifactsDir: join(data, "data", "artifact_repos"),
    trashDir: join(data, "data", "trash"),
  };
  const owner = rootAgentId();
  const artifact = await artifacts.create(store, {
    owner,
    title: "Linked documents",
  });
  const repo = String(artifact.repo_path);
  const index =
    "# Project overview\n\nPublished project overview.\n\n[Missing](missing.md)\n\n[Escape](../architecture.md)\n\n[Absolute](/architecture.md)\n\n[Missing image](missing.png)\n\n[Missing PDF](missing.pdf)\n\n[Missing CSV](missing.csv)\n\n[Code](sub/code.ts)\n\n[Data](sub/data.csv)\n\n[Architecture](./sub/architecture.md)\n\n[Details](sub/architecture.md#details)\n\n[Diagram](diagram.png)\n\n[PDF](review.pdf)\n\n[Archive](archive.zip)\n\n[External](https://example.com/)\n";
  await writeFile(join(repo, "index.md"), index);
  await mkdir(join(repo, "sub"));
  const historicalMarkdown =
    "# System architecture\n\nSibling document at the selected version.\n\n[Project overview](../index.md)\n\n" +
    Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.\n\n`).join("") +
    "## Details\n\nVersioned details.\n\n" +
    Array.from({ length: 30 }, (_, i) => `After details ${i}.\n\n`).join("") +
    "[Return to project overview](../index.md)\n";
  await writeFile(join(repo, "sub", "architecture.md"), historicalMarkdown);
  await writeFile(join(repo, "sub", "code.ts"), "export const sibling = 42;\n");
  await writeFile(join(repo, "sub", "data.csv"), "name,value\nArtifact,42\n");
  await writeFile(join(repo, "diagram.png"), PNG_1X1);
  await writeFile(join(repo, "review.pdf"), rectanglePdf(1));
  const version = String(
    (await artifacts.publish(store, owner, String(artifact.id))).version,
  );
  await writeFile(
    join(repo, "index.md"),
    index.replace("Published project overview.", "Updated project overview."),
  );
  await writeFile(
    join(repo, "sub", "architecture.md"),
    "# Newest architecture\n\nNot the historical sibling.\n",
  );
  await artifacts.publish(store, owner, String(artifact.id));
  await writeFile(join(repo, "sub", "architecture.md"), "# Unpublished edit\n");
  for (const phone of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: phone ? 390 : 1280, height: 844 },
      isMobile: phone,
      hasTouch: phone,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${owner}&artifact=${artifact.id}`);
    const overview = page.getByRole("heading", {
      name: "Project overview",
      exact: true,
    });
    await overview.waitFor();
    const historical = async () => {
      await page
        .getByRole("button", { name: "Version history", exact: true })
        .click();
      await page
        .getByRole("menuitemradio")
        .filter({ hasText: version.slice(0, 8) })
        .click();
      await page
        .getByText("Published project overview.", { exact: true })
        .waitFor();
    };
    await historical();
    const pane = page.locator('.pane-body[data-pane="report"]');
    const architecture = page.getByRole("link", {
      name: "Architecture",
      exact: true,
    });
    const heading = page.getByRole("heading", {
      name: "System architecture",
      exact: true,
    });
    const inset = { horizontalInset: 4, verticalInset: 4 };
    const tap = async (link: ReturnType<typeof page.getByRole>) => {
      if (!phone) return link.click();
      await expectHitCorners(link, 44, inset);
      await checkedTap(link, {
        x: inset.horizontalInset,
        y: inset.verticalInset,
      });
    };
    await tap(architecture);
    await browserExpect(
      pane.getByRole("heading", { name: "System architecture", exact: true }),
    ).toBeVisible();
    const sectionUrl = () =>
      new URLSearchParams(new URL(page.url()).hash.slice(1));
    expect(sectionUrl().get("page")).toBe("sub/architecture.md");
    await browserExpect(pane.locator(".report-doc")).toBeFocused();
    if (!phone) {
      await page.keyboard.press("y");
      await pane.getByText("Link copied.", { exact: true }).waitFor();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(new URL(copied).searchParams.get("path")).toBe(
        "sub/architecture.md",
      );
    }
    expect(await pane.locator('[aria-current="page"]').textContent()).toBe(
      "sub/architecture.md",
    );
    const download = page.getByRole("link", {
      name: /^Download original sub\/architecture\.md,/,
    });
    await expectHitCorners(download, 44, inset);
    const requestedDownload = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === `/api/artifacts/${artifact.id}/file` &&
        url.searchParams.has("download")
      );
    });
    const downloadEvent = page.waitForEvent("download");
    if (phone) await checkedTap(download);
    else await download.click();
    const downloadUrl = new URL((await requestedDownload).url());
    const saved = await downloadEvent;
    expect(downloadUrl.searchParams.get("path")).toBe("sub/architecture.md");
    expect(downloadUrl.searchParams.get("version")).toBe(version);
    expect(saved.suggestedFilename()).toBe("architecture.md");
    expect(await Bun.file(await saved.path()).text()).toBe(historicalMarkdown);
    await page.goBack();
    await overview.waitFor();
    await page.goForward();
    await heading.waitFor();
    await page.reload();
    await heading.waitFor();
    await tap(pane.getByRole("link", { name: "Overview", exact: true }));
    await overview.waitFor();
    expect(sectionUrl().has("page")).toBe(false);
    const returnToOverview = async () => {
      if (phone) await page.goBack();
      else {
        const id = await page
          .locator(".file-tab:visible")
          .getAttribute("data-pane");
        await page
          .locator(`.dv-tab[data-dock-panel="${id}"] .dv-default-tab-action`)
          .click();
        await page.locator('.dv-tab[data-dock-panel="report"]').click();
      }
      await overview.waitFor();
      if (phone) await historical();
    };
    await page.getByRole("link", { name: "Missing", exact: true }).click();
    await browserExpect(pane.locator(".artifact-notice")).toContainText(
      "File not found",
    );
    await page.goBack();
    await overview.waitFor();
    for (const name of ["Escape", "Absolute"])
      expect(
        await pane.locator(`a:text-is("${name}")`).getAttribute("href"),
      ).toBeNull();
    for (const name of [
      "Missing image",
      "Missing PDF",
      "Missing CSV",
      "Archive",
    ]) {
      await page.getByRole("link", { name, exact: true }).click();
      await browserExpect(
        page.locator(".file-tab:visible .report-doc"),
      ).toContainText("File not found");
      expect(context.pages().length).toBe(1);
      await returnToOverview();
    }
    for (const name of ["Code", "Data"]) {
      await page.getByRole("link", { name, exact: true }).click();
      const file = page.locator(".file-tab:visible");
      if (name === "Code") {
        await browserExpect(file.locator("pre")).toHaveText(
          "export const sibling = 42;\n",
        );
        await file.locator("pre .hljs-keyword").first().waitFor();
      } else
        await browserExpect(
          file.frameLocator("iframe").locator("table"),
        ).toContainText("Artifact");
      expect(context.pages().length).toBe(1);
      await returnToOverview();
    }
    for (const name of ["External"])
      expect(
        await page
          .getByRole("link", { name, exact: true })
          .getAttribute("target"),
      ).toBe("_blank");
    if (!phone) {
      for (const options of [
        { modifiers: ["Control"] as "Control"[] },
        { button: "middle" as const },
      ]) {
        const popup = context.waitForEvent("page");
        await page
          .getByRole("link", { name: "Architecture", exact: true })
          .click(options);
        const raw = await popup;
        await browserExpect(
          raw.getByRole("heading", {
            name: "System architecture",
            exact: true,
          }),
        ).toBeVisible();
        const params = new URLSearchParams(new URL(raw.url()).hash.slice(1));
        expect(params.get("page")).toBe("sub/architecture.md");
        expect(params.get("version")).toBe(version);
        if (options.button !== "middle") {
          const unversionedFragmentLimit = 512;
          const overviewParams = new URLSearchParams(params);
          overviewParams.delete("page");
          overviewParams.delete("version");
          overviewParams.set(
            "section",
            "a".repeat(
              unversionedFragmentLimit -
                overviewParams.toString().length -
                "&section=".length,
            ),
          );
          overviewParams.set("version", version);
          await raw.goto(`${base}#${overviewParams}`);
          await browserExpect(
            raw.getByText("Published project overview.", { exact: true }),
          ).toBeVisible();
          for (const [brokenVersion, message] of [
            ["not-a-commit", "Invalid Artifact version."],
            ["0".repeat(40), "Artifact version not found."],
          ] as const) {
            params.set("version", brokenVersion);
            await raw.goto(`${base}#${params}`);
            await browserExpect(
              raw.getByText(message, { exact: false }),
            ).toBeVisible();
            await browserExpect(
              raw.getByRole("heading", { name: "Newest architecture" }),
            ).toHaveCount(0);
            if (brokenVersion === "not-a-commit") {
              await browserExpect(
                raw.getByRole("link", { name: /^Download original/ }),
              ).toHaveCount(0);
              await raw
                .locator('.pane-body[data-pane="report"] .report-doc')
                .focus();
              await raw.keyboard.press("y");
              await browserExpect(
                raw.getByText(message, { exact: false }),
              ).toBeVisible();
            }
          }
        }
        await raw.close();
      }
    }
    await tap(architecture);
    await heading.waitFor();
    await tap(
      pane.getByRole("link", { name: "Project overview", exact: true }),
    );
    await overview.waitFor();
    await page.getByRole("link", { name: "Details", exact: true }).click();
    const details = page.getByRole("heading", { name: "Details", exact: true });
    await details.waitFor();
    expect(sectionUrl().get("section")).toBe("details");
    await browserExpect
      .poll(() =>
        details.evaluate((element, phone) => {
          const pane = element.closest('.pane-body[data-pane="report"]')!;
          const clip = (
            phone ? pane.closest(".pane-col")! : pane
          ).getBoundingClientRect();
          const { left, top, right, bottom } = element.getBoundingClientRect();
          const document = element.ownerDocument;
          const { innerWidth, innerHeight } = document.defaultView!;
          return (
            left >= Math.max(0, clip.left) &&
            right <= Math.min(innerWidth, clip.right) &&
            top >= Math.max(0, clip.top) &&
            bottom <= Math.min(innerHeight, clip.bottom) &&
            [left + 1, right - 1].every((x) =>
              [top + 1, bottom - 1].every((y) =>
                element.contains(document.elementFromPoint(x, y)),
              ),
            )
          );
        }, phone),
      )
      .toBe(true);
    await dispatchArtifactSelection(
      page,
      phone ? "touch" : "mouse",
      "Versioned details.",
      pane.locator(".report-doc"),
    );
    const popover = page.locator(".report-comment-popover:not([hidden])");
    await popover
      .locator("textarea")
      .fill("Reply only Sibling feedback accepted");
    await popover.locator(".report-comment-popover-submit").click();
    if (phone) {
      page.once("dialog", (dialog) => void dialog.dismiss());
      await pane.getByRole("link", { name: "Overview", exact: true }).click();
      expect(context.pages().length).toBe(1);
      await page
        .getByRole("heading", { name: "System architecture", exact: true })
        .waitFor();
    }
    const delivered = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname ===
        `/api/conversations/${owner}/deliver`,
    );
    await pane.locator(".report-sendbar-send").click();
    const comment = (await delivered).postDataJSON().content;
    expect(comment).toContain(
      `/artifact_repos/${owner}/${artifact.id}/sub/architecture.md`,
    );
    expect(comment).toContain(version);
    await pane.locator(".report-comment").waitFor({ state: "detached" });
    const end = pane.getByRole("link", {
      name: "Return to project overview",
      exact: true,
    });
    await end.click();
    await overview.waitFor();
    await page.goBack();
    expect(sectionUrl().get("section")).toBe("details");
    await browserExpect(end).toBeInViewport();
    await page.goForward();
    await overview.waitFor();
    await page.getByRole("link", { name: "Diagram", exact: true }).click();
    await page.locator(".file-tab img").waitFor();
    expect(context.pages().length).toBe(1);
    if (!phone) {
      await page.getByRole("link", { name: "PDF", exact: true }).click();
      const pdf = page.locator(".file-tab:visible");
      await pdf.locator('canvas[data-drawn="true"]').waitFor();
      const frame = (await pdf.locator(".report-box-frame").boundingBox())!;
      await page.mouse.move(
        frame.x + frame.width * 0.2,
        frame.y + frame.height * 0.2,
      );
      await page.keyboard.down("Control");
      await page.mouse.down();
      await page.mouse.move(
        frame.x + frame.width * 0.6,
        frame.y + frame.height * 0.6,
        { steps: 8 },
      );
      await page.mouse.up();
      await page.keyboard.up("Control");
      const box = page.locator(".report-comment-popover:not([hidden])");
      await box.locator("textarea").fill("Keep the PDF box anchor");
      await box.locator(".report-comment-popover-submit").click();
      await pdf.locator("mark.report-cbox").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("link", { name: "PDF", exact: true }).click();
      await pdf.locator(".report-comment").waitFor();
      await pdf.locator("mark.report-cbox").waitFor();
      await pdf.locator(".report-comment-del").click();
    }
    expect(errors).toEqual([]);
    await context.close();
  }
  const fixture = await postFixture(base, "seed-linked-markdown");
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: width === 390,
      hasTouch: width === 390,
    });
    const page = await context.newPage();
    await page.goto(`${base}#agent=${fixture.demo}`);
    await page
      .getByRole("button", { name: "Open report.md in Files", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Weekly report", exact: true })
      .waitFor();
    await page.getByRole("link", { name: "Architecture", exact: true }).click();
    await page
      .getByRole("heading", { name: "Files architecture", exact: true })
      .waitFor();
    await browserExpect(
      page.getByRole("heading", { name: "Details", exact: true }),
    ).toBeInViewport();
    expect(context.pages().length).toBe(1);
    if (width === 390) {
      await page.goBack();
      await page
        .getByRole("heading", { name: "Weekly report", exact: true })
        .waitFor();
    }
    await context.close();
  }
};
