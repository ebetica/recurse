import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import {
  postFixture,
  rootAgentId,
  runBrowserTests,
  waitForLayout,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3393 Fullscreen must hide covered dock content and dividers, then restore the native grid.
  async function test_dock_zoom_isolates_every_pane(browser, base, data) {
    const owner = rootAgentId();
    const store = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const artifact = await artifacts.create(store, {
      owner,
      title: "Zoom experiment log",
    });
    await writeFile(
      join(String(artifact.repo_path), "index.md"),
      "# Zoom experiment log\n\n" +
        "The neighbouring document must disappear during fullscreen.\n\n".repeat(
          40,
        ),
    );
    await artifacts.publish(store, owner, String(artifact.id));
    const { demo } = await postFixture(base, "seed-published-markdown");
    const { cid } = await postFixture(base, "seed-changes-base");
    const failures: unknown[] = [];
    for (const width of [1280, 2000]) {
      for (const [pane, agent] of [
        ["report", owner],
        ["files", demo],
        ["file", demo],
        ["explorer", owner],
        ["diff", cid],
        ["side", owner],
        ["tips", owner],
      ]) {
        const page = await browser.newPage({
          viewport: { width, height: 1000 },
        });
        try {
          await page.goto(`${base}#agent=${agent}`);
          await waitForLayout(page);
          if (pane === "report") {
            await page
              .locator("#input")
              .fill("Reply only Zoom keeps this real chat reply readable.");
            await page.locator("#input").press("Enter");
            await page
              .locator(".msg.assistant .content", {
                hasText: "Zoom keeps this real chat reply readable.",
              })
              .first()
              .waitFor();
            await page.locator("#input").press("Escape");
          }
          if (pane === "side") {
            const response = await page.request.post(
              `${base}api/conversations/${owner}/side`,
              { data: {} },
            );
            expect(response.ok()).toBeTrue();
          }
          const tab = (id: string) =>
            page.locator(`#dock .dv-tab[data-dock-panel="${id}"]`);
          await tab("chat").locator(".dock-tab-icon").click();
          await page.keyboard.press("w");
          await page.keyboard.press("v");
          if (pane === "file")
            await page
              .getByRole("button", {
                name: "Open report.md in Files",
                exact: true,
              })
              .click();
          else await page.locator(`.rail-btn[data-pane="${pane}"]`).click();
          const neighbour = page.locator(
            pane === "file"
              ? ".pane-col.file-tab"
              : `.pane-col[data-pane="${pane}"]`,
          );
          await browserExpect(neighbour).toBeVisible();
          const panel = (await neighbour.getAttribute("data-pane"))!;
          if (pane === "report")
            await neighbour
              .getByRole("heading", { name: "Zoom experiment log" })
              .waitFor();
          if (pane === "side")
            await neighbour.locator("iframe.side-frame").waitFor();
          if (pane === "report") {
            await page.setViewportSize({ width: 390, height: 1000 });
            await browserExpect(
              page.locator('.fs[data-pane="chat"]'),
            ).toBeHidden();
            await page.setViewportSize({ width, height: 1000 });
          }
          await waitForLayout(page);
          const geometry = () =>
            page.locator("#dock .dv-groupview").evaluateAll((groups) =>
              groups.map((group) => {
                const box = group.getBoundingClientRect();
                return [box.x, box.y, box.width, box.height];
              }),
            );
          const original = await geometry();
          for (const id of ["chat", panel]) {
            await tab(id).locator(".dock-tab-icon").click();
            for (const command of ["only", "fullscreen"]) {
              const toggle = async () => {
                if (command === "only") {
                  await page.keyboard.press("w");
                  await page.keyboard.press("o");
                } else await page.keyboard.press("z");
                await waitForLayout(page);
              };
              await toggle();
              if (
                pane === "report" &&
                id === "chat" &&
                command === "fullscreen" &&
                process.env.RECURSE_BROWSER_SCREENSHOT_DIR
              )
                await page.screenshot({
                  path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/zoom-${width}.png`,
                });
              const result = await page
                .locator(`#dock .dock-panel[data-dock-panel="${id}"]`)
                .evaluate((element) => {
                  const browser = globalThis as any;
                  const document = browser.document;
                  const overlay = element.closest(".dv-render-overlay")!;
                  const box = overlay.getBoundingClientRect();
                  const points = [0.05, 0.5, 0.95].flatMap((x) =>
                    [0.1, 0.5, 0.9].map((y) => {
                      const hit = document.elementFromPoint(
                        box.left + box.width * x,
                        box.top + box.height * y,
                      );
                      return overlay.contains(hit);
                    }),
                  );
                  const others = [
                    ...document.querySelectorAll("#dock .dv-render-overlay"),
                  ].filter((other) => other !== overlay);
                  return {
                    points,
                    hidden: others.every(
                      (other) =>
                        !other.checkVisibility({ visibilityProperty: true }),
                    ),
                    dividers: [
                      ...document.querySelectorAll("#dock .dv-sash"),
                    ].every(
                      (sash) =>
                        !sash.checkVisibility({ visibilityProperty: true }),
                    ),
                  };
                });
              if (
                !result.points.every(Boolean) ||
                !result.hidden ||
                !result.dividers
              )
                failures.push({ width, pane, id, command, ...result });
              if (command === "fullscreen") {
                const exit = page.getByRole("button", {
                  name: "Exit fullscreen",
                  exact: true,
                });
                await browserExpect(exit).toBeVisible();
                expect(
                  await exit.evaluate((element) => {
                    const document = (globalThis as any).document;
                    const box = element.getBoundingClientRect();
                    const inset = Math.min(box.width, box.height) / 4;
                    return [box.left + inset, box.right - inset].every((x) =>
                      [box.top + inset, box.bottom - inset].every((y) =>
                        element.contains(document.elementFromPoint(x, y)),
                      ),
                    );
                  }),
                ).toBeTrue();
                await exit.click();
                await waitForLayout(page);
                if (id === "chat") {
                  await toggle();
                  await page.keyboard.press("Escape");
                  await browserExpect(page.locator("#main")).not.toHaveClass(
                    /fullscreen/,
                  );
                  await waitForLayout(page);
                }
              } else await toggle();
              await browserExpect(neighbour).toBeVisible();
              expect(await geometry()).toEqual(original);
              expect(
                await neighbour.evaluate((element) => {
                  const document = (globalThis as any).document;
                  const box = element.getBoundingClientRect();
                  return [0.1, 0.5, 0.9].every((x) =>
                    [0.1, 0.5, 0.9].every((y) =>
                      element.contains(
                        document.elementFromPoint(
                          box.left + box.width * x,
                          box.top + box.height * y,
                        ),
                      ),
                    ),
                  );
                }),
              ).toBeTrue();
            }
          }
        } finally {
          await page.close();
        }
      }
    }
    expect(
      failures,
      "covered fullscreen windows must not paint or intercept input",
    ).toEqual([]);
  },
];

if (import.meta.main) await runBrowserTests([["dock-zoom", tests]]);
