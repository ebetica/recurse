import { expect } from "bun:test";
import { waitForPaneScroll, waitForPaneTransition } from "./pane_layout";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkdirGit } from "../../src/workdir_git";
import {
  captureErrors,
  gotoRoot,
  postFixture,
  runBrowserTests,
  routeArtifacts,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2300 phone pane bars reveal on scroll-up; #2861 pane menu actions dismiss their owning menu.
  async function test_pane_powerbar(browser, base) {
    const app = await postFixture(base, "seed-pane-reading");
    const fixture = app;
    await postFixture(base, `revise-artifact-app?id=${app.id}`);
    const git = new WorkdirGit({
      repoUrl: "",
      repoDir: String(app.cwd),
      dataDir: String(app.cwd),
      env: process.env,
    });
    const source = join(String(app.cwd), "index.md");
    await Bun.write(
      source,
      (await Bun.file(source).text()).replaceAll(
        "Document paragraph",
        "Updated paragraph",
      ),
    );
    const diff = await git.worktreeDiff(String(app.cwd));
    expect(diff.available).toBe(true);
    for (const width of [412, 1280]) {
      for (const id of ["report", "files", "diff"]) {
        const context = await browser.newContext({
          viewport: { width, height: 915 },
          isMobile: width === 412,
          hasTouch: width === 412,
        });
        const page = await context.newPage();
        const errors = captureErrors(page);
        const act = width === 412 ? "tap" : "click";
        await page.route("**/api/conversations/*/diff**", async (route) => {
          const url = new URL(route.request().url());
          await route.fulfill({
            json: url.pathname.endsWith("/files")
              ? await git.diffFile(
                  String(app.cwd),
                  url.searchParams.get("path"),
                  null,
                  true,
                )
              : diff,
          });
        });
        if (id === "report") await gotoRoot(page, base);
        else await page.goto(`${base}#agent=${fixture.demo}`);
        if (id === "report") {
          await page
            .getByRole("link", { name: "Reading document", exact: true })
            [act]();
        } else if (id === "files") {
          await page
            .getByRole("button", { name: "Open reading.md in Files" })
            .first()
            [act]();
        } else if (width === 412) {
          await page.locator("#pane-fab").tap();
          await page.locator(`.pane-menu-item[data-pane="${id}"]`).tap();
        } else {
          await page.locator(`.rail-btn[data-pane="${id}"]`).click();
        }
        if (width === 1280)
          await page.locator("#panes").evaluate((node) => {
            node.style.width = "330px";
            node.style.flex = "none";
          });
        const pane = page.locator(`.pane-col[data-pane="${id}"]`);
        await pane.waitFor();
        if (id === "diff")
          await pane.locator(".diff-row.add").first().waitFor();
        else await pane.locator("h1").first().waitFor();
        await waitForPaneTransition(page, `.pane-col[data-pane="${id}"]`);
        const screenshot = async (stage: string) => {
          const dir = process.env.RECURSE_SCREENSHOT_DIR;
          if (!dir) return;
          await mkdir(dir, { recursive: true });
          await page.screenshot({ path: `${dir}/${id}-${width}-${stage}.png` });
        };
        await screenshot("top");
        const bar = pane.locator(".pane-powerbar");
        expect(await bar.count()).toBe(1);
        expect(await pane.locator(".pane-top-controls").count()).toBe(0);
        expect(await bar.getByRole("button", { name: /^Close / }).count()).toBe(
          1,
        );
        const controls =
          id === "report"
            ? ".artifact-title-select, .artifact-icon-btn"
            : id === "files"
              ? ".files-back, .files-actions .artifact-icon-btn, .pane-powerbar-overflow > summary"
              : ".diff-base-btn, .pane-powerbar-overflow > summary";
        const boxes = await bar
          .locator(controls + ", .x")
          .evaluateAll((nodes) =>
            nodes.map((node) => {
              const rect = node.getBoundingClientRect();
              return {
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                height: rect.height,
                width: rect.width,
              };
            }),
          );
        expect(boxes.length).toBeGreaterThan(1);
        const bounds = (await bar.boundingBox())!;
        const paneBox = (await pane.boundingBox())!;
        for (const box of boxes) {
          expect(box.top).toBeGreaterThanOrEqual(bounds.y);
          expect(box.bottom).toBeLessThanOrEqual(bounds.y + bounds.height);
          expect(box.left).toBeGreaterThanOrEqual(bounds.x);
          expect(box.right).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect(box.left).toBeGreaterThanOrEqual(paneBox.x);
          expect(box.right).toBeLessThanOrEqual(paneBox.x + paneBox.width);
          if (width === 412) {
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.width).toBeGreaterThanOrEqual(44);
          }
        }
        const first = pane
          .locator(id === "diff" ? ".diff-file-head" : "h1")
          .first();
        await first.waitFor();
        expect((await first.boundingBox())!.y).toBeGreaterThanOrEqual(
          bounds.y + bounds.height,
        );
        const scrollerSelector =
          width === 412
            ? `.pane-col[data-pane="${id}"]`
            : id === "diff"
              ? ".diff-list"
              : `.pane-col[data-pane="${id}"] .pane-body`;
        const scroller =
          width === 412
            ? pane
            : id === "diff"
              ? pane.locator(".diff-list")
              : pane.locator(".pane-body");
        if (width === 412) {
          await scroller.evaluate((node) => {
            node.scrollTop = 24;
          });
          await waitForPaneScroll(
            page,
            scrollerSelector,
            `.pane-col[data-pane="${id}"]`,
          );
        }
        await scroller.evaluate((node) => {
          node.scrollTop = 600;
        });
        await waitForPaneScroll(
          page,
          scrollerSelector,
          `.pane-col[data-pane="${id}"]`,
        );
        await screenshot("down");
        const down = (await bar.boundingBox())!;
        expect(
          width === 412 ? down.y + down.height <= 0 : down.y === bounds.y,
        ).toBe(true);
        await scroller.evaluate((node) => {
          node.scrollTop = 560;
        });
        await waitForPaneScroll(
          page,
          scrollerSelector,
          `.pane-col[data-pane="${id}"]`,
        );
        await screenshot("up");
        if (width === 412) {
          const appBar = (await page.locator("#topbar").boundingBox())!;
          const powerbar = (await bar.boundingBox())!;
          expect(appBar.y).toBeGreaterThanOrEqual(0);
          expect(
            Math.abs(powerbar.y - appBar.y - appBar.height),
          ).toBeLessThanOrEqual(1);
          expect(powerbar.y + powerbar.height).toBeLessThanOrEqual(915);
          const before = await first.boundingBox();
          await scroller.evaluate((node) => {
            node.scrollTop = 600;
          });
          await waitForPaneScroll(
            page,
            scrollerSelector,
            `.pane-col[data-pane="${id}"]`,
          );
          expect(
            (await bar.boundingBox())!.y + powerbar.height,
          ).toBeLessThanOrEqual(0);
          const hiddenApp = (await page.locator("#topbar").boundingBox())!;
          expect(hiddenApp.y + hiddenApp.height).toBeLessThanOrEqual(0);
          expect(
            Math.abs((await first.boundingBox())!.y - before!.y + 40),
          ).toBeLessThanOrEqual(1);
        }
        await scroller.evaluate((node) => {
          node.scrollTop = 0;
        });
        await waitForPaneScroll(
          page,
          scrollerSelector,
          `.pane-col[data-pane="${id}"]`,
        );
        const top = (await bar.boundingBox())!;
        expect((await first.boundingBox())!.y).toBeGreaterThanOrEqual(
          top.y + top.height,
        );
        if (id === "report") {
          const history = bar.getByRole("button", { name: "Version history" });
          await history[act]();
          const menu = bar.getByRole("menu", { name: "Version history" });
          await menu.getByRole("menuitemradio").first().waitFor();
          await menu.getByRole("menuitemradio").first()[act]();
          expect(await menu.count()).toBe(0);
          await history[act]();
          await menu.getByRole("menuitemradio").last()[act]();
          expect(await menu.count()).toBe(0);
          await history[act]();
          page.once("dialog", (dialog) => dialog.dismiss());
          await menu
            .getByRole("menuitem", { name: /^Restore selected/ })
            [act]();
          expect(await menu.count()).toBe(0);
        }
        if (id === "diff" || id === "files") {
          const summary = bar.locator(".pane-powerbar-overflow > summary");
          await summary[act]();
          if (id === "diff") {
            await bar
              .getByRole("button", { name: "Split", exact: true })
              [act]();
            expect(await bar.locator("details[open]").count()).toBe(0);
            await summary[act]();
          }
          if (id === "files") {
            const version = bar.getByRole("combobox", { name: "Version" });
            const versions = await version
              .locator("option")
              .evaluateAll((options) => options.map((option) => option.value));
            await version.selectOption(versions[versions.length - 1]);
            expect(await bar.locator("details[open]").count()).toBe(0);
            await summary[act]();
            await version.focus();
            if (width === 412)
              expect(
                (await version.boundingBox())!.height,
              ).toBeGreaterThanOrEqual(44);
          }
          await page.keyboard.press("Escape");
          expect(await pane.isVisible()).toBe(true);
          expect(await bar.locator("details[open]").count()).toBe(0);
          expect(
            await summary.evaluate(
              (node) => node.ownerDocument.activeElement === node,
            ),
          ).toBe(true);
        }
        const retainedBar = await bar.elementHandle();
        const retainedBody = await pane.locator(".pane-body").elementHandle();
        if (width === 412) {
          await pane.evaluate((node) => {
            node.scrollTop = 300;
          });
          await page.keyboard.press("Escape");
        } else await bar.getByRole("button", { name: /^Close / })[act]();
        if (width === 412) {
          await page.locator("#pane-fab").tap();
          await page.locator(`.pane-menu-item[data-pane="${id}"]`).tap();
        } else await page.locator(`.rail-btn[data-pane="${id}"]`).click();
        await pane.waitFor();
        expect(await bar.count()).toBe(1);
        if (width === 412) {
          await page.waitForFunction(
            (id) =>
              (globalThis as any).document.activeElement?.id ===
              `pane-title-${id}`,
            id,
          );
          expect(await pane.evaluate((node) => node.scrollTop)).toBe(300);
        }
        expect(
          await bar.evaluate((node, old) => node === old, retainedBar),
        ).toBe(true);
        expect(
          await pane
            .locator(".pane-body")
            .evaluate((node, old) => node === old, retainedBody),
        ).toBe(true);
        expect(errors).toEqual([]);
        await context.close();
      }
    }
  },
  async function test_powerbar_loading_focus(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 915 },
    });
    const page = await context.newPage();
    await routeArtifacts(page, base);
    await gotoRoot(page, base);
    const pane = page.locator('.pane-col[data-pane="report"]');
    await pane.locator(".report-doc").waitFor();
    await pane.locator(".artifact-version-btn").click();
    await page.getByRole("menuitemradio").nth(1).waitFor();
    let release!: () => Promise<void>;
    let captured!: () => void;
    const held = new Promise<void>((resolve) => {
      captured = resolve;
    });
    await page.route("**/api/artifacts/*/file*", (route) => {
      release = () => route.fallback();
      captured();
    });
    await page.getByRole("menuitemradio").nth(1).click();
    await held;
    await page.waitForFunction(
      "document.querySelector('.pane-powerbar-controls')?.inert",
    );
    expect(
      await pane.locator(".pane-body").evaluate((node) => node.inert),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        String((globalThis as any).document.activeElement?.id),
      ),
    ).toBe("pane-title-report");
    const close = pane.getByRole("button", { name: "Close Artifacts" });
    expect(
      await close.evaluate((node) => node.closest("[inert]") === null),
    ).toBe(true);
    await close.click();
    expect(await pane.count()).toBe(0);
    await release();
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["pane-powerbar", tests]]);
