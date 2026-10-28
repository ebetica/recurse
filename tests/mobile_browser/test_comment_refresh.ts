import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Page } from "playwright";

async function shot(page: Page, pane: string, width: number): Promise<void> {
  const dir = process.env.RECURSE_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${pane}-refresh-${width}.png` });
}
import {
  ARTIFACT,
  ARTIFACT_VERSION,
  OLDER_ARTIFACT_VERSION,
  dispatchArtifactSelection,
  gotoRoot,
  rootAgentId,
  runBrowserTests,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  async function test_comments_survive_refresh(browser, base) {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
      });
      const page = await context.newPage();
      const activeText = () => page.evaluate("document.activeElement?.value");
      const refresh = () =>
        page.evaluate((agentId) => {
          const browser = globalThis as any;
          browser.dispatchEvent(
            new browser.CustomEvent("recurse:ui-refresh", {
              detail: { agentId },
            }),
          );
        }, rootAgentId());
      let updated = false;
      let artifactReads = 0;
      let diffReads = 0;
      await page.route("**/api/artifacts**", (route) => {
        const url = route.request().url();
        if (url.includes("/file"))
          return route.fulfill({
            body: updated
              ? "# Revised\n\nAnchors removed."
              : "# Review\n\nFirst anchor.\n\nSecond anchor.",
            contentType: "text/markdown",
          });
        if (url.includes("/versions")) return route.fulfill({ json: [] });
        artifactReads++;
        return route.fulfill({
          json: [
            {
              ...ARTIFACT,
              version: updated ? OLDER_ARTIFACT_VERSION : ARTIFACT_VERSION,
            },
          ],
        });
      });
      await page.route("**/api/conversations/**/diff**", (route) => {
        if (route.request().url().includes("/files"))
          return route.fulfill({
            json: {
              available: true,
              path: "review.txt",
              patch:
                "diff --git a/review.txt b/review.txt\n--- a/review.txt\n+++ b/review.txt\n@@ -1,2 +1,2 @@\n-old first\n-old second\n+First anchor\n+Second anchor\n",
              truncated: false,
            },
          });
        diffReads++;
        return route.fulfill({
          json: {
            available: true,
            base: "HEAD",
            version: updated ? "new" : "old",
            files: updated
              ? []
              : [
                  {
                    path: "review.txt",
                    additions: 2,
                    deletions: 2,
                    status: "modified",
                  },
                ],
            untracked: [],
          },
        });
      });
      await gotoRoot(page, base);
      await page.locator("#input").fill("Composer draft survives refresh");
      const open = async (id: string) => {
        if (width === 390) {
          await page.locator("#pane-fab").click();
          await page.locator(`.pane-menu-item[data-pane="${id}"]`).click();
        } else await page.locator(`.rail-btn[data-pane="${id}"]`).click();
      };
      await open("report");
      await page.locator(".report-doc p").first().waitFor();
      await dispatchArtifactSelection(page, "mouse", "First anchor");
      const popover = page.locator(".report-comment-popover:not([hidden])");
      await popover.waitFor();
      await popover.locator("textarea").fill("Staged artifact note");
      await popover
        .getByRole("button", { name: "Comment", exact: true })
        .click();
      await page.waitForFunction(
        "document.activeElement?.classList.contains('report-comment-input')",
      );
      await dispatchArtifactSelection(page, "mouse", "Second anchor");
      await popover.waitFor();
      await popover
        .locator("textarea")
        .fill("Artifact draft still being typed");
      updated = true;
      const before = artifactReads;
      const artifactRefresh = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/artifacts",
      );
      await refresh();
      await (await artifactRefresh).finished();
      await page.waitForFunction(
        "document.querySelector('#report-selection-comment')?.value === 'Artifact draft still being typed' && document.activeElement?.value === 'Artifact draft still being typed'",
      );
      expect(artifactReads).toBeGreaterThan(before);
      expect(await page.locator("#report-selection-comment").inputValue()).toBe(
        "Artifact draft still being typed",
      );
      expect(await page.locator(".report-comment-input").inputValue()).toBe(
        "Staged artifact note",
      );
      expect(await activeText()).toBe("Artifact draft still being typed");
      await shot(page, "artifact", width);
      await popover
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Clear comments", exact: true })
        .click();
      await page.locator(".report-doc h1", { hasText: "Revised" }).waitFor();
      updated = false;
      await open("diff");
      await refresh();
      const inputs = page.locator(".diff-line-input");
      await page
        .locator('.diff-row.add[data-line="1"] .diff-add-comment')
        .click({ force: true });
      await inputs.first().fill("Staged Changes note");
      await page
        .locator('.diff-row.add[data-line="2"] .diff-add-comment')
        .click({ force: true });
      await inputs.nth(1).fill("Changes draft still being typed  ");
      updated = true;
      const beforeDiff = diffReads;
      const diffRefresh = page.waitForResponse((response) =>
        /\/api\/conversations\/[^/]+\/diff$/.test(
          new URL(response.url()).pathname,
        ),
      );
      await refresh();
      await (await diffRefresh).finished();
      await page.waitForFunction(
        "document.querySelectorAll('.diff-line-input')[1]?.value === 'Changes draft still being typed  ' && document.activeElement?.value === 'Changes draft still being typed  '",
      );
      expect(diffReads).toBeGreaterThan(beforeDiff);
      expect(await inputs.first().inputValue()).toBe("Staged Changes note");
      expect(await inputs.nth(1).inputValue()).toBe(
        "Changes draft still being typed  ",
      );
      expect(await activeText()).toBe("Changes draft still being typed  ");
      await shot(page, "changes", width);
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.locator(".diff-sendbar-clear").click();
      expect(await inputs.first().inputValue()).toBe("Staged Changes note");
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator(".diff-sendbar-clear").click();
      expect(await inputs.count()).toBe(0);
      expect(await page.locator("#input").inputValue()).toBe(
        "Composer draft survives refresh",
      );
      await context.close();
    }
  },
];
if (import.meta.main) await runBrowserTests([["comment-refresh", tests]]);
