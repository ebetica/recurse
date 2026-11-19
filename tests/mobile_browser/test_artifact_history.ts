import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import {
  captureErrors,
  dispatchArtifactSelection,
  rootAgentId,
  runBrowserTests,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Feature: #3434 linked Artifacts retain their own Back trail and reading positions.
  async function test_linked_artifact_history(browser, base, data) {
    const store = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const owner = rootAgentId();
    const documents = await Promise.all(
      ["Trail start", "Linked middle", "Linked end"].map((title) =>
        artifacts.create(store, { owner, title }),
      ),
    );
    const [a, b, c] = documents;
    const paragraphs = Array.from(
      { length: 40 },
      (_, n) => `Reading paragraph ${n}.\n\n`,
    ).join("");
    const sources = [
      `# Trail start\n\n[Reading position](#reading-position)\n\n${paragraphs}## Reading position\n\n[Open middle](#artifact=${b!.id}&section=middle-section)\n\n${paragraphs}`,
      `# Linked middle\n\n${paragraphs}## Middle section\n\n[Open end](#artifact=${c!.id})\n\n${paragraphs}`,
      "# Linked end\n\nEnd of the linked trail.\n",
    ];
    for (const [index, document] of documents.entries()) {
      await writeFile(
        join(String(document.repo_path), "index.md"),
        sources[index]!,
      );
      await artifacts.publish(store, owner, String(document.id));
    }
    for (const width of [1280, 412]) {
      await writeFile(join(String(a!.repo_path), "index.md"), sources[0]!);
      await artifacts.publish(store, owner, String(a!.id));
      const phone = width === 412;
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: phone,
        hasTouch: phone,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const previous = !phone
        ? String(
            (
              await (
                await page.request.post(`${base}api/conversations`, {
                  data: { parent: null, title: "Before the Artifact trail" },
                })
              ).json()
            ).id,
          )
        : null;
      if (previous) await page.goto(`${base}#agent=${previous}`);
      await page.goto(`${base}#agent=${owner}&artifact=${a!.id}`);
      const pane = page.locator('.pane-col[data-pane="report"]');
      const start = pane.getByRole("heading", {
        name: "Trail start",
        exact: true,
        level: 1,
      });
      const middle = pane.getByRole("heading", {
        name: "Middle section",
        exact: true,
      });
      await start.waitFor();
      await pane
        .getByRole("link", { name: "Reading position", exact: true })
        .click();
      await browserExpect(
        pane.getByRole("heading", { name: "Reading position", exact: true }),
      ).toBeInViewport();
      const link = pane.getByRole("link", { name: "Open middle", exact: true });
      const position = await link.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await link.click();
      await middle.waitFor();
      await browserExpect(middle).toBeInViewport();
      await dispatchArtifactSelection(
        page,
        phone ? "touch" : "mouse",
        "Middle section",
        pane.locator(".report-doc"),
      );
      const popover = page.locator(".report-comment-popover:not([hidden])");
      await popover
        .locator("textarea")
        .fill("Keep this linked-document comment");
      await popover.locator(".report-comment-popover-submit").click();
      let dialogs = 0;
      const cancel = async (dialog: import("playwright").Dialog) => {
        dialogs++;
        await dialog.dismiss();
      };
      page.on("dialog", cancel);
      const middleUrl = page.url();
      await page.goBack();
      await page.waitForURL(middleUrl);
      if (!phone) {
        await pane.locator(".report-doc").focus();
        await page.keyboard.press("o");
        await page.locator("#pane-finder-query").fill("artifact/Trail start");
        await page
          .getByRole("option", { name: "artifact/Trail start", exact: true })
          .click();
        expect(page.url()).toBe(middleUrl);
        expect(dialogs).toBe(2);
      } else expect(dialogs).toBe(1);
      await browserExpect
        .poll(() =>
          pane.locator(".report-comment .report-comment-text").textContent(),
        )
        .toBe("Keep this linked-document comment");
      await pane.locator(".report-comment-del").click();
      await browserExpect(pane.locator(".report-comment")).toHaveCount(0);
      page.off("dialog", cancel);
      await writeFile(
        join(String(a!.repo_path), "index.md"),
        sources[0]!.replace("# Trail start", "# Updated trail start"),
      );
      await artifacts.publish(store, owner, String(a!.id));
      await page.reload();
      await middle.waitFor();
      await browserExpect(middle).toBeInViewport();
      if (previous) {
        await pane.locator(".pane-body").evaluate((element) => {
          element.scrollTop -= 100;
        });
        const readingPosition = await middle.evaluate(
          (element) => element.getBoundingClientRect().top,
        );
        await page.locator(`.agent[data-id="${previous}"]`).click();
        await page.locator(`.agent.selected[data-id="${previous}"]`).waitFor();
        await page.goBack();
        await middle.waitFor();
        await browserExpect
          .poll(() =>
            middle.evaluate((element) => element.getBoundingClientRect().top),
          )
          .toBe(readingPosition);
      }
      await pane.getByRole("link", { name: "Open end", exact: true }).click();
      await pane
        .getByRole("heading", { name: "Linked end", exact: true, level: 1 })
        .waitFor();
      await page.goBack();
      await middle.waitFor();
      await browserExpect(middle).toBeInViewport();
      await page.goBack();
      await start.waitFor();
      await browserExpect
        .poll(() =>
          link.evaluate((element) => element.getBoundingClientRect().top),
        )
        .toBe(position);
      await link.click();
      await middle.waitFor();
      await page.goBack();
      await start.waitFor();
      await browserExpect
        .poll(() =>
          link.evaluate((element) => element.getBoundingClientRect().top),
        )
        .toBe(position);
      await link.click();
      await middle.waitFor();
      await pane
        .getByRole("combobox", { name: "Select artifact", exact: true })
        .selectOption(String(a!.id));
      await pane
        .getByRole("heading", {
          name: "Updated trail start",
          exact: true,
          level: 1,
        })
        .waitFor();
      if (phone) {
        await page.goBack();
        await browserExpect(page.locator("#panes")).not.toHaveClass(/\bon\b/);
        await page.goBack();
        await browserExpect(page.locator("html")).toHaveClass(/\bphone-list\b/);
      } else {
        await page.goBack();
        await page.locator(`.agent.selected[data-id="${previous}"]`).waitFor();
      }
      expect(errors).toEqual([]);
      await context.close();
    }
  },
];

if (import.meta.main) await runBrowserTests([["artifact-history", tests]]);
