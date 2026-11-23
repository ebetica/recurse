import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as artifacts from "../../src/artifacts";
import { rectanglePdf } from "./server/media";
import {
  captureErrors,
  PNG_1X1,
  rootAgentId,
  postFixture,
  dispatchArtifactSelection,
  type BrowserTest,
} from "./common";

// Regression: #3363 #3397 Artifact Markdown opens siblings in-app and reports missing or escaping paths.
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
  await writeFile(
    join(repo, "index.md"),
    "# Project overview\n\n[Missing](missing.md)\n\n[Escape](../architecture.md)\n\n[Missing image](missing.png)\n\n[Missing PDF](missing.pdf)\n\n[Missing CSV](missing.csv)\n\n[Code](sub/code.ts)\n\n[Data](sub/data.csv)\n\n[Architecture](architecture.md)\n\n[Details](architecture.md#details)\n\n[Diagram](diagram.png)\n\n[PDF](review.pdf)\n\n[Archive](archive.zip)\n\n[External](https://example.com/)\n",
  );
  await writeFile(
    join(repo, "architecture.md"),
    "# System architecture\n\nSibling document at the selected version.\n\n[Overview](index.md)\n\n" +
      Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.\n\n`).join("") +
      "## Details\n\nVersioned details.\n\n" +
      Array.from({ length: 30 }, (_, i) => `After details ${i}.\n\n`).join(""),
  );
  await mkdir(join(repo, "sub"));
  await writeFile(join(repo, "sub", "code.ts"), "export const sibling = 42;\n");
  await writeFile(join(repo, "sub", "data.csv"), "name,value\nArtifact,42\n");
  await writeFile(join(repo, "diagram.png"), PNG_1X1);
  await writeFile(join(repo, "review.pdf"), rectanglePdf(1));
  const published = await artifacts.publish(store, owner, String(artifact.id));
  await writeFile(
    join(repo, "architecture.md"),
    "# Newest architecture\n\nNot the historical sibling.\n",
  );
  await artifacts.publish(store, owner, String(artifact.id));
  for (const phone of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: phone ? 390 : 1280, height: 844 },
      isMobile: phone,
      hasTouch: phone,
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
        .filter({ hasText: String(published.version).slice(0, 8) })
        .click();
    };
    await historical();
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
    for (const name of [
      "Missing",
      "Escape",
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
        await raw.waitForURL(/\/api\/artifacts\/.*\/file\?/);
        expect(new URL(raw.url()).searchParams.get("version")).toBe(
          String(published.version),
        );
        await raw.close();
      }
    }
    await page.getByRole("link", { name: "Architecture", exact: true }).click();
    await page
      .getByRole("heading", { name: "System architecture", exact: true })
      .waitFor();
    expect(context.pages().length).toBe(1);
    expect(page.url()).toStartWith(base);
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/artifact-sibling-${phone ? "phone" : "desktop"}.png`,
      });
    const download = page
      .getByRole("link", { name: "Download", exact: true })
      .last();
    expect(
      await download.evaluate((element) => {
        const browser = globalThis as any;
        const rect = element.getBoundingClientRect();
        return [
          [rect.left + 4, rect.top + 4],
          [rect.right - 4, rect.top + 4],
          [rect.left + 4, rect.bottom - 4],
          [rect.right - 4, rect.bottom - 4],
        ].every(([x, y]) =>
          element.contains(browser.document.elementFromPoint(x!, y!)),
        );
      }),
    ).toBeTrue();
    expect(
      new URL((await download.getAttribute("href"))!, base).searchParams.get(
        "version",
      ),
    ).toBe(String(published.version));
    if (phone) {
      await page.getByRole("link", { name: "Overview", exact: true }).click();
      await overview.waitFor();
      await page
        .getByRole("link", { name: "Architecture", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "System architecture", exact: true })
        .waitFor();
      await page.reload();
      await page
        .getByRole("heading", { name: "System architecture", exact: true })
        .waitFor();
      await page.goBack();
      await overview.waitFor();
      await page.goBack();
      await page
        .getByRole("heading", { name: "System architecture", exact: true })
        .waitFor();
      await page.goBack();
    } else await page.locator('.dv-tab[data-dock-panel="report"]').click();
    await overview.waitFor();
    await historical();
    await page.getByRole("link", { name: "Details", exact: true }).click();
    const details = page.getByRole("heading", { name: "Details", exact: true });
    await details.waitFor();
    await browserExpect
      .poll(() =>
        details.evaluate((element) => {
          let scroller = element.parentElement!;
          while (
            scroller.parentElement &&
            scroller.scrollHeight <= scroller.clientHeight
          )
            scroller = scroller.parentElement;
          const bounds = scroller.getBoundingClientRect();
          const toolbar = element
            .closest(".file-tab")!
            .querySelector(".files-detail-bar")!
            .getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          return (
            rect.top >= Math.max(bounds.top, toolbar.bottom, 0) &&
            rect.bottom <=
              Math.min(bounds.bottom, (globalThis as any).innerHeight)
          );
        }),
      )
      .toBe(true);
    await dispatchArtifactSelection(
      page,
      phone ? "touch" : "mouse",
      "Versioned details.",
      page.locator(".file-tab .report-doc").last(),
    );
    const popover = page.locator(".report-comment-popover:not([hidden])");
    await popover
      .locator("textarea")
      .fill("Reply only Sibling feedback accepted");
    await popover.locator(".report-comment-popover-submit").click();
    if (phone) {
      page.once("dialog", (dialog) => void dialog.dismiss());
      await page.getByRole("link", { name: "Overview", exact: true }).click();
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
    await page.locator(".file-tab .report-sendbar-send").last().click();
    expect((await delivered).postData()).toContain(
      `/artifact_repos/${owner}/${artifact.id}/architecture.md`,
    );
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
