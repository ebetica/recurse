import { expect } from "bun:test";
import { tests as remoteExplorer } from "./test_remote_explorer";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { retire } from "../../src/utils/trash";
import type { Page, Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { waitForPaneTransition } from "./pane_layout";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureErrors,
  dispatchArtifactSelection,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

async function openExplorer(page: Page, width: number): Promise<void> {
  const selector = '.pane-col[data-pane="explorer"]';
  if (!(await page.locator(selector).isVisible())) {
    if (width === 412) {
      await page.locator("#pane-fab").click();
      await page.locator('.pane-menu-item[data-pane="explorer"]').click();
    } else await page.locator('.rail-btn[data-pane="explorer"]').click();
  }
  await waitForPaneTransition(page, selector);
}

export const tests: BrowserTest[] = [
  ...remoteExplorer,
  async function explorer_pages_previews_and_fuzzy_search(browser, base, data) {
    const temporary = await mkdtemp(join(data, "data", "browser-explorer-"));
    const root = join(
      temporary,
      "workspace".repeat(15),
      "workspace".repeat(15),
    );
    const shots =
      process.env.EXPLORER_SHOTS ||
      join(process.env.RECURSE_AGENT_TMPDIR || tmpdir(), "shots", "explorer");
    await mkdir(shots, { recursive: true });
    try {
      await mkdir(join(root, "src"), { recursive: true });
      expect(root.length).toBeGreaterThan(256);
      await writeFile(join(root, ".gitignore"), "node_modules/\n");
      const source =
        "export function application() {\n  return 'Read-only file preview';\n}\n".repeat(
          500,
        );
      await writeFile(join(root, "src", "application.ts"), source);
      const htmlSource = `<h1>Explorer HTML preview</h1>
<p>Offline file content</p>
<script>parent.__explorerHtmlRan = true; fetch('${base}explorer-html-probe');</script>
<img src="${base}explorer-html-probe" onerror="parent.__explorerHtmlRan = true">
<iframe src="${base}explorer-html-probe"></iframe>
<a href="${base}explorer-html-probe">External link</a>
<form action="${base}explorer-html-probe"><input name="probe"></form>
<style>body { background: red; }</style>`;
      await writeFile(join(root, "src", "page.html"), htmlSource);
      const pickedPath = "src/pick `quoted`.ts";
      await writeFile(join(root, pickedPath), "export const picked = true;\n");
      await writeFile(
        join(root, "src", "😀app-types.ts"),
        "export type Application = { name: string };\n",
      );
      await writeFile(join(root, ".env"), "fixture only\n");
      await mkdir(join(root, "node_modules"));
      await writeFile(
        join(root, "node_modules", "application-ignored.ts"),
        "ignored\n",
      );
      await Promise.all(
        Array.from({ length: 70 }, (_, i) =>
          writeFile(join(root, `notes-${i}.md`), `# Note ${i}\n`),
        ),
      );
      const otherRoot = join(root, "other");
      await mkdir(otherRoot);
      await writeFile(join(otherRoot, "only-here.txt"), "Other conversation\n");
      expect(
        await Bun.spawn(["git", "init", "-q", root], {
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ).toBe(0);
      const other = await postFixture(base, "seed-model-selection-error", {
        agent: "explorer-other",
        model: "fauxordinary/faux-1",
        workdir: otherRoot,
      });
      for (const width of [1280, 412]) {
        const fixture = await postFixture(base, "seed-model-selection-error", {
          agent: `explorer-demo-${width}`,
          model: "fauxordinary/faux-1",
          workdir: root,
        });
        const context = await browser.newContext({
          viewport: { width, height: 915 },
          isMobile: width === 412,
          hasTouch: width === 412,
        });
        if (width === 1280)
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        try {
          const page = await context.newPage();
          const errors = captureErrors(page);
          const requests: string[] = [];
          const htmlRequests: string[] = [];
          page.on("request", (request) => {
            if (request.url().includes("explorer-html-probe"))
              htmlRequests.push(request.url());
            if (request.url().includes(`/conversations/${fixture.agent}/tree`))
              requests.push(request.url());
          });
          await page.goto(`${base}#agent=${fixture.agent}`, {
            waitUntil: "domcontentloaded",
          });
          await page
            .locator("#conv-title", { hasText: "Choose a model" })
            .waitFor();
          expect(requests).toHaveLength(0);
          await openExplorer(page, width);
          let pane = page.locator('.pane-col[data-pane="explorer"]');
          const tree = pane;
          const fileFor = (path: string) =>
            width === 1280
              ? page.locator(".pane-col.file-tab").filter({
                  has: page.locator(".explorer-filename", { hasText: path }),
                })
              : tree;
          let nextFile = "";
          await pane
            .getByRole("button", { name: "Show more", exact: true })
            .waitFor();
          expect(requests).toHaveLength(1);
          expect(
            await page.evaluate(
              () =>
                (globalThis as any).document.activeElement?.id ===
                "explorer-search",
            ),
          ).toBe(width === 1280);
          expect(await pane.locator(".explorer-row").count()).toBe(48);
          await pane
            .getByRole("button", { name: "Show more", exact: true })
            .click();
          await page.waitForFunction(
            "document.querySelectorAll('.explorer-row').length > 48",
          );
          expect(requests).toHaveLength(2);
          if (width === 1280) {
            const rows = pane.locator(".explorer-row:not(:disabled)");
            const paths = await rows.evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute("data-path")),
            );
            const cursor = pane.locator(".pane-item-cursor");
            const before = requests.length;
            await pane
              .getByRole("combobox", { name: "Search files" })
              .press("Escape");
            expect(await cursor.getAttribute("data-path")).toBe(paths[0]);
            await page.keyboard.press("j");
            expect(await cursor.getAttribute("data-path")).toBe(paths[1]);
            await page.keyboard.press("k");
            expect(await cursor.getAttribute("data-path")).toBe(paths[0]);
            await page.keyboard.press("Shift+G");
            expect(await cursor.getAttribute("data-path")).toBe(paths.at(-1));
            await page.keyboard.press("g");
            await page.keyboard.press("g");
            expect(await cursor.getAttribute("data-path")).toBe(paths[0]);
            await page.keyboard.press("Control+i");
            expect(await cursor.getAttribute("data-path")).toBe(paths[0]);
            expect(
              await cursor.evaluate(
                (node) => node === node.ownerDocument.activeElement,
              ),
            ).toBeTrue();
            await page.keyboard.press("y");
            await pane.getByText("Path copied.", { exact: true }).waitFor();
            expect(
              await page.evaluate(() =>
                (globalThis as any).navigator.clipboard.readText(),
              ),
            ).toBe(`${root}/${paths[0]}`);
            expect(requests).toHaveLength(before);
            expect(await pane.locator(".explorer-source").count()).toBe(0);
            for (const viewport of [412, 1280]) {
              await page.evaluate(() => {
                const browser = globalThis as any;
                browser.__explorerResized = false;
                browser.matchMedia("(max-width: 700px)").addEventListener(
                  "change",
                  () =>
                    browser.requestAnimationFrame(() => {
                      browser.__explorerResized = true;
                    }),
                  { once: true },
                );
              });
              await page.setViewportSize({ width: viewport, height: 915 });
              await page.waitForFunction(
                () => (globalThis as any).__explorerResized,
              );
              if (viewport === 412) {
                expect(
                  await pane
                    .locator(".pane-item-cursor, .explorer-row[tabindex='-1']")
                    .count(),
                ).toBe(0);
                await rows.nth(0).focus();
                await page.keyboard.press("Tab");
                expect(
                  await rows
                    .nth(1)
                    .evaluate(
                      (node) => node === node.ownerDocument.activeElement,
                    ),
                ).toBeTrue();
              }
            }
            await rows.nth(0).focus();
            await page.keyboard.press("/");
            const search = pane.getByRole("combobox", { name: "Search files" });
            expect(
              await search.evaluate(
                (node) => node === node.ownerDocument.activeElement,
              ),
            ).toBeTrue();
            await search.press("j");
            expect(await search.inputValue()).toBe("j");
            await search.fill("");
          }
          const env = pane.locator('.explorer-row[data-path=".env"]');
          await browserExpect(env).toBeEnabled();
          await env.click();
          const envFile = fileFor(".env");
          await browserExpect(envFile.locator(".explorer-source")).toHaveText(
            "fixture only\n",
          );
          if (width === 1280)
            await page
              .locator(".dv-tab", { hasText: ".env" })
              .getByRole("button", { name: "Close .env", exact: true })
              .click();
          else
            await envFile
              .getByRole("button", { name: "Files", exact: true })
              .click();
          const src = pane.locator(".explorer-row", { hasText: "src" });
          if (width === 1280) {
            await src.focus();
            await page.keyboard.press("l");
          } else await src.click();
          await pane
            .locator(".explorer-row", { hasText: "application.ts" })
            .waitFor();
          expect(
            requests.filter(
              (url) => new URL(url).searchParams.get("path") === "src",
            ),
          ).toHaveLength(1);
          if (width === 1280) {
            await pane
              .locator(".explorer-row", { hasText: "application.ts" })
              .focus();
            await page.keyboard.press("h");
            expect(await src.getAttribute("aria-expanded")).toBe("false");
            expect(
              await pane
                .locator(".explorer-row", { hasText: "application.ts" })
                .count(),
            ).toBe(0);
            await page.keyboard.press("l");
            const application = pane.locator(".explorer-row", {
              hasText: "application.ts",
            });
            await application.waitFor();
            const files = await pane
              .locator(".explorer-row[data-file]:not(:disabled)")
              .evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute("data-path")!),
              );
            nextFile = files[files.indexOf("src/application.ts") + 1]!;
            await application.focus();
            await page.keyboard.press("]");
            expect(
              await pane.locator(".pane-item-cursor").getAttribute("data-path"),
            ).toBe(nextFile);
            await page.keyboard.press("[");
            expect(
              await pane.locator(".pane-item-cursor").getAttribute("data-path"),
            ).toBe("src/application.ts");
          }
          await page.screenshot({ path: join(shots, `${width}-tree.png`) });
          if (width === 1280) await page.keyboard.press("l");
          else
            await pane
              .locator(".explorer-row", { hasText: "application.ts" })
              .click();
          pane = fileFor("src/application.ts");
          await pane
            .locator(".explorer-source", { hasText: "Read-only file preview" })
            .waitFor();
          expect(
            await pane.locator(".explorer-source").textContent(),
          ).toHaveLength(16 * 1024);
          if (width === 1280) {
            const tab = page.locator(".dv-tab", { hasText: "application.ts" });
            expect(await tab.count()).toBe(1);
            expect(
              await tab.evaluate((node) =>
                [
                  ...node.closest(".dv-groupview")!.querySelectorAll(".dv-tab"),
                ].map((item) => item.getAttribute("data-dock-panel")),
              ),
            ).toContain("chat");
            expect(
              await tree
                .locator('.explorer-row[data-path="src/application.ts"]')
                .count(),
            ).toBe(1);
            const original = await pane.locator(".pane-body").elementHandle();
            const reselected = page.waitForResponse(
              (response) =>
                response.url().includes("/tree/file?") &&
                new URL(response.url()).searchParams.get("path") ===
                  "src/application.ts",
            );
            await tree
              .locator('.explorer-row[data-path="src/application.ts"]')
              .click();
            expect((await reselected).ok()).toBeTrue();
            await tree
              .getByText("Loading file…", { exact: true })
              .waitFor({ state: "hidden" });
            expect(await tab.count()).toBe(1);
            expect(
              await pane
                .locator(".pane-body")
                .evaluate((node, saved) => node === saved, original),
            ).toBeTrue();
          }
          await page.screenshot({ path: join(shots, `${width}-preview.png`) });
          if (width === 1280) {
            const body = pane.locator(".pane-body");
            const before = requests.length;
            await body.focus();
            await page.keyboard.press("j");
            await page.keyboard.press("k");
            await page.keyboard.press("d");
            const down = await body.evaluate((node) => node.scrollTop);
            expect(down).toBeGreaterThan(0);
            await page.keyboard.press("u");
            expect(await body.evaluate((node) => node.scrollTop)).toBeLessThan(
              down,
            );
            await page.keyboard.press("Shift+G");
            expect(
              await body.evaluate((node) => node.scrollTop),
            ).toBeGreaterThan(down);
            await page.keyboard.press("g");
            await page.keyboard.press("g");
            expect(await body.evaluate((node) => node.scrollTop)).toBe(0);
            expect(await pane.locator(".explorer-filename").textContent()).toBe(
              "src/application.ts",
            );
            expect(requests).toHaveLength(before);
            await context.clearPermissions();
            await context.grantPermissions([]);
            await page.evaluate(() => {
              const browser = globalThis as any;
              browser.__explorerCopied = false;
              browser.document.addEventListener(
                "copy",
                () =>
                  browser.requestAnimationFrame(() => {
                    browser.__explorerCopied = true;
                  }),
                { once: true },
              );
            });
            await page.keyboard.press("y");
            await page.waitForFunction(
              () => (globalThis as any).__explorerCopied,
            );
            expect(
              await body.evaluate(
                (node) => node === node.ownerDocument.activeElement,
              ),
            ).toBeTrue();
            await context.grantPermissions([
              "clipboard-read",
              "clipboard-write",
            ]);
            expect(
              await page.evaluate(() =>
                (globalThis as any).navigator.clipboard.readText(),
              ),
            ).toBe(`${root}/src/application.ts`);
            const nextText = await readFile(join(root, nextFile), "utf8");
            await page.keyboard.press("]");
            const next = fileFor(nextFile);
            await next
              .locator(".explorer-source", { hasText: nextText.trim() })
              .waitFor();
            expect(await next.locator(".explorer-source").textContent()).toBe(
              nextText,
            );
            expect(await next.locator(".explorer-filename").textContent()).toBe(
              nextFile,
            );
            expect(
              await page
                .locator(".dv-tab", { hasText: "application.ts" })
                .count(),
            ).toBe(1);
            await page.keyboard.press("[");
            await pane
              .locator(".explorer-source", {
                hasText: "Read-only file preview",
              })
              .waitFor();
          }
          if (width === 1280) {
            const switchTo = async (agent: string) => {
              await page.locator(`.agent[data-id="${agent}"]`).click();
              await page.waitForURL(`${base}#agent=${agent}`);
              await page
                .locator("#conv-freshness:not(.on)")
                .waitFor({ state: "attached" });
            };
            const returned = async () => {
              await switchTo(fixture.agent);
              await pane
                .locator(".explorer-source", {
                  hasText: "Read-only file preview",
                })
                .waitFor();
            };
            const neighbour = page.locator(".dv-tab", {
              hasText: nextFile.split("/").at(-1)!,
            });
            await page.reload();
            await pane
              .locator(".explorer-source", {
                hasText: "Read-only file preview",
              })
              .waitFor();
            expect(await neighbour.count()).toBe(1);
            await switchTo(other.agent);
            expect(
              await page
                .locator(".dv-tab", { hasText: "application.ts" })
                .count(),
            ).toBe(0);
            await returned();
            expect(await neighbour.count()).toBe(1);
            await rename(
              join(root, nextFile),
              join(root, nextFile + ".missing"),
            );
            await switchTo(other.agent);
            await returned();
            expect(await neighbour.count()).toBe(0);
            expect(
              await page.locator(".dv-tab", { hasText: "Explorer" }).count(),
            ).toBe(1);
            await page.reload();
            await pane
              .locator(".explorer-source", {
                hasText: "Read-only file preview",
              })
              .waitFor();
            expect(await neighbour.count()).toBe(0);
            await page.waitForFunction(
              ({ owner, key }) => {
                const storage = (globalThis as any).localStorage;
                return Object.keys(storage).some((slot) => {
                  if (
                    !slot.startsWith(
                      "recurse.conversationUiState.local.v1.slot.",
                    )
                  )
                    return false;
                  const record = JSON.parse(storage.getItem(slot));
                  if (record.owner !== owner) return false;
                  const panels =
                    record.panes?.["window-layout"]?.value?.panels || {};
                  return Object.values(panels).some(
                    (panel: any) =>
                      panel.params?.file?.source === "explorer" &&
                      panel.params.file.key === key,
                  );
                });
              },
              { owner: fixture.agent, key: JSON.stringify([root, nextFile]) },
            );
            await rename(
              join(root, nextFile + ".missing"),
              join(root, nextFile),
            );
            await switchTo(other.agent);
            await returned();
            expect(await neighbour.count()).toBe(1);
            const src = tree.locator('.explorer-row[data-path="src"]');
            await src.waitFor();
            expect(await src.getAttribute("aria-expanded")).toBe("false");
            await src.click();
            await tree
              .locator('.explorer-row[data-path="src/application.ts"]')
              .waitFor();
            const savedId = await pane.getAttribute("data-pane");
            const alias = await postFixture(
              base,
              "seed-model-selection-error",
              {
                agent: "explorer-alias",
                model: "fauxordinary/faux-1",
                workdir: root,
              },
            );
            await switchTo(alias.agent);
            await page.reload();
            await page
              .locator(`.agent.selected[data-id="${alias.agent}"]`)
              .waitFor();
            const selectApplication = async () => {
              await openExplorer(page, width);
              const folder = tree.locator('.explorer-row[data-path="src"]');
              await folder.waitFor();
              if ((await folder.getAttribute("aria-expanded")) === "false")
                await folder.click();
              await tree
                .locator('.explorer-row[data-path="src/application.ts"]')
                .click();
              await tree
                .getByText("Loading file…", { exact: true })
                .waitFor({ state: "hidden" });
            };
            await selectApplication();
            await pane
              .locator(".explorer-source", {
                hasText: "Read-only file preview",
              })
              .waitFor();
            expect(await pane.getAttribute("data-pane")).not.toBe(savedId);
            await returned();
            const restoredBody = await pane
              .locator(".pane-body")
              .elementHandle();
            await selectApplication();
            expect(await fileFor("src/application.ts").count()).toBe(1);
            expect(await pane.getAttribute("data-pane")).toBe(savedId);
            expect(
              await pane
                .locator(".pane-body")
                .evaluate((node, saved) => node === saved, restoredBody),
            ).toBeTrue();
            expect(
              await pane
                .locator(".explorer-filebar")
                .getByRole("button", { name: "Files", exact: true })
                .count(),
            ).toBe(0);
          }
          await dispatchArtifactSelection(
            page,
            width === 412 ? "touch" : "mouse",
            "return",
            pane.locator(".report-doc"),
          );
          const popover = page.locator(".report-comment-popover");
          const reply = `Explorer comment ${width} received`;
          const note = `Explain this return.\nReply only ${reply}`;
          await popover.locator("textarea").fill(note);
          await popover
            .getByRole("button", { name: "Comment", exact: true })
            .click();
          await pane.locator(".report-comment").waitFor();
          expect(await pane.locator("mark.report-cmark").textContent()).toBe(
            "return",
          );
          if (width === 1280) {
            await pane.locator(".pane-body").focus();
            await page.keyboard.press("h");
            expect(
              await tree
                .locator('.explorer-row[data-path="src/application.ts"]')
                .count(),
            ).toBe(1);
            page.once("dialog", (dialog) => dialog.dismiss());
            await page
              .locator(".dv-tab", { hasText: "application.ts" })
              .getByRole("button", {
                name: "Close application.ts",
                exact: true,
              })
              .click();
          } else {
            page.once("dialog", (dialog) => dialog.dismiss());
            await pane
              .locator(".explorer-filebar")
              .getByRole("button", { name: "Files", exact: true })
              .click();
          }
          expect(await pane.locator(".report-comment").isVisible()).toBe(true);
          const cachedBody = await pane.locator(".pane-body").elementHandle();
          const beforeClose = requests.length;
          await pane.locator(".explorer-source").focus();
          await page.keyboard.press("Escape");
          await pane.waitFor({ state: "detached" });
          let beforeReopen = beforeClose;
          if (width === 1280) {
            const paths = await tree
              .locator('.explorer-row[data-path^="notes-"]')
              .evaluateAll((nodes) =>
                nodes
                  .map((node) => node.getAttribute("data-path")!)
                  .slice(0, 33),
              );
            expect(paths).toHaveLength(33);
            for (const path of paths) {
              await tree.locator(`.explorer-row[data-path="${path}"]`).click();
              const preview = fileFor(path).locator(".explorer-source");
              await preview.waitFor();
              expect(await preview.textContent()).toBe(
                await readFile(join(root, path), "utf8"),
              );
              await page
                .locator(".dv-tab", { hasText: path })
                .getByRole("button", { name: `Close ${path}`, exact: true })
                .click();
              await fileFor(path).waitFor({ state: "detached" });
            }
            expect(requests).toHaveLength(beforeClose + paths.length);
            beforeReopen = requests.length;
          }
          await openExplorer(page, width);
          if (width === 1280)
            await tree
              .locator('.explorer-row[data-path="src/application.ts"]')
              .click();
          await pane.locator(".report-comment").waitFor();
          expect(requests).toHaveLength(
            beforeReopen + (width === 1280 ? 1 : 0),
          );
          expect(
            await pane
              .locator(".pane-body")
              .evaluate((node, saved) => node === saved, cachedBody),
          ).toBeTrue();
          expect(await pane.locator("mark.report-cmark").textContent()).toBe(
            "return",
          );
          await pane
            .getByRole("button", { name: "Load more", exact: true })
            .click();
          await page.waitForFunction(
            (node) => (node?.textContent?.length || 0) > 16384,
            await pane.locator(".explorer-source").elementHandle(),
          );
          expect(await pane.locator(".explorer-source").textContent()).toBe(
            source.slice(0, 32 * 1024),
          );
          expect(await pane.locator("mark.report-cmark").textContent()).toBe(
            "return",
          );
          const bodyWidth = await pane
            .locator(".pane-body")
            .evaluate((body) => ({
              scroll: body.scrollWidth,
              client: body.clientWidth,
            }));
          expect(bodyWidth.scroll).toBeLessThanOrEqual(bodyWidth.client);
          await page.screenshot({ path: join(shots, `${width}-comments.png`) });
          const downloading = page.waitForEvent("download");
          await pane.getByRole("link", { name: "Download file" }).click();
          const download = await downloading;
          expect(download.suggestedFilename()).toBe("application.ts");
          const downloaded = await download.path();
          expect(downloaded).not.toBeNull();
          expect(await readFile(downloaded!, "utf8")).toBe(source);
          const delivered = page.waitForRequest((request) =>
            request
              .url()
              .endsWith(`/api/conversations/${fixture.agent}/deliver`),
          );
          await pane
            .getByRole("button", { name: "Submit comments", exact: true })
            .click();
          const start = source.indexOf("return");
          expect((await delivered).postDataJSON().content).toBe(
            `Comments on file "application.ts" (path: ${root}/src/application.ts):\n\n- line 2, chars ${start}-${start + "return".length}:\n> return\n${note}`,
          );
          await page
            .locator("#messages .msg.assistant")
            .filter({ hasText: reply })
            .waitFor();
          await openExplorer(page, width);
          pane = tree;
          if (width === 412)
            await pane.locator(".explorer-row", { hasText: "src" }).click();
          await pane
            .locator(".explorer-row", { hasText: "application.ts" })
            .waitFor();
          expect(await pane.locator(".report-comment").count()).toBe(0);
          const input = pane.getByRole("combobox", { name: "Search files" });
          await input.fill("appts");
          await pane
            .locator(".explorer-result", { hasText: "src/application.ts" })
            .waitFor();
          expect(
            await pane.locator(".explorer-result mark").count(),
          ).toBeGreaterThan(0);
          const unicode = pane.locator(".explorer-result", {
            hasText: "😀app-types.ts",
          });
          await unicode.waitFor();
          expect(
            (await unicode.locator("mark").allTextContents())
              .join("")
              .toLowerCase(),
          ).toBe("appts");
          expect(
            await pane
              .locator(".explorer-result", { hasText: "node_modules" })
              .count(),
          ).toBe(0);
          for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
            await input.dispatchEvent("keydown", {
              key: "Escape",
              bubbles: true,
              ...composition,
            });
            expect(await pane.isVisible()).toBe(true);
            expect(await input.inputValue()).toBe("appts");
          }
          await input.press("ArrowDown");
          expect(
            await pane
              .locator('.explorer-result[aria-selected="true"]')
              .count(),
          ).toBe(1);
          await input.press("ArrowUp");
          if (width === 1280) {
            const paths = await pane
              .locator(".explorer-result")
              .evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute("data-path")),
              );
            const before = requests.length;
            await pane.locator(".explorer-result").first().focus();
            await page.keyboard.press("j");
            expect(
              await pane.locator(".pane-item-cursor").getAttribute("data-path"),
            ).toBe(paths[1]);
            expect(
              await pane
                .locator('.explorer-result[aria-selected="true"]')
                .getAttribute("data-path"),
            ).toBe(paths[1]);
            await page.keyboard.press("k");
            expect(
              await pane.locator(".pane-item-cursor").getAttribute("data-path"),
            ).toBe(paths[0]);
            await page.keyboard.press("y");
            await pane.getByText("Path copied.", { exact: true }).waitFor();
            expect(
              await page.evaluate(() =>
                (globalThis as any).navigator.clipboard.readText(),
              ),
            ).toBe(paths[0]);
            expect(requests).toHaveLength(before);
            expect(await pane.locator(".explorer-source").count()).toBe(0);
            await page.keyboard.press("h");
            expect(await input.inputValue()).toBe("");
            await page.keyboard.press("/");
            await input.fill("appts");
            await pane
              .locator(".explorer-result", { hasText: "src/application.ts" })
              .waitFor();
          }
          await page.screenshot({ path: join(shots, `${width}-search.png`) });
          const selected = await input.getAttribute("aria-activedescendant");
          const selectedPath = selected
            ? await tree.locator(`#${selected}`).getAttribute("data-path")
            : "src/application.ts";
          await input.press("Enter");
          pane = fileFor(selectedPath!);
          await pane.locator(".explorer-source").waitFor();
          if (width === 1280)
            await page.locator(".dv-tab", { hasText: "Explorer" }).click();
          else
            await pane
              .locator(".explorer-filebar")
              .getByRole("button", { name: "Files", exact: true })
              .click();
          pane = tree;
          await pane
            .getByRole("combobox", { name: "Search files" })
            .press("Escape");
          expect(
            await pane
              .getByRole("combobox", { name: "Search files" })
              .inputValue(),
          ).toBe("");
          await pane
            .locator(".explorer-row", { hasText: "application.ts" })
            .waitFor();
          await pane.locator(".explorer-row", { hasText: "page.html" }).click();
          pane = fileFor("src/page.html");
          const htmlCode = pane.locator(".explorer-source");
          await htmlCode.waitFor();
          expect(await htmlCode.textContent()).toBe(htmlSource);
          expect(
            await pane
              .getByRole("button", { name: "Source", exact: true })
              .getAttribute("aria-pressed"),
          ).toBe("true");
          expect(
            await pane.locator(".explorer-html-preview iframe").count(),
          ).toBe(0);
          await dispatchArtifactSelection(
            page,
            width === 412 ? "touch" : "mouse",
            "Explorer HTML preview",
            pane.locator(".report-doc"),
          );
          const htmlNote = "Keep this heading.";
          await popover.locator("textarea").fill(htmlNote);
          await popover
            .getByRole("button", { name: "Comment", exact: true })
            .click();
          await pane.locator(".report-comment").waitFor();
          expect(
            await pane.locator(".report-comment textarea").inputValue(),
          ).toBe(htmlNote);
          const sourceNode = await htmlCode.elementHandle();
          const beforeToggle = requests.length;
          await pane
            .getByRole("button", { name: "Preview", exact: true })
            .click();
          const frame = pane.locator(".explorer-html-preview iframe");
          const rendered = pane.frameLocator(".explorer-html-preview iframe");
          await rendered
            .getByRole("heading", {
              name: "Explorer HTML preview",
              exact: true,
            })
            .waitFor();
          expect(await frame.getAttribute("sandbox")).toBe("");
          expect(await frame.getAttribute("referrerpolicy")).toBe(
            "no-referrer",
          );
          expect(
            await frame.evaluate(
              (element) =>
                "contentDocument" in element &&
                element.contentDocument === null,
            ),
          ).toBe(true);
          expect(
            await rendered
              .locator("script, iframe, form, input, img, [href], [onerror]")
              .count(),
          ).toBe(0);
          expect(
            await rendered
              .locator("style", { hasText: "background: red" })
              .count(),
          ).toBe(0);
          expect(
            await page.evaluate("window.__explorerHtmlRan"),
          ).toBeUndefined();
          expect(htmlRequests).toEqual([]);
          expect(await htmlCode.isVisible()).toBe(false);
          expect(await pane.locator(".report-comment").isVisible()).toBe(false);
          await page.keyboard.press("Escape");
          await pane.waitFor({ state: "detached" });
          await openExplorer(page, width);
          if (width === 1280)
            await tree
              .locator('.explorer-row[data-path="src/page.html"]')
              .click();
          await rendered
            .getByRole("heading", {
              name: "Explorer HTML preview",
              exact: true,
            })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: join(shots, `${width}-html-preview.png`),
          });
          await pane
            .getByRole("button", { name: "Source", exact: true })
            .click();
          await pane.locator(".report-comment").waitFor();
          expect(await sourceNode!.evaluate((node) => node.isConnected)).toBe(
            true,
          );
          expect(await htmlCode.textContent()).toBe(htmlSource);
          expect(await pane.locator("mark.report-cmark").textContent()).toBe(
            "Explorer HTML preview",
          );
          expect(
            await pane.locator(".report-comment textarea").inputValue(),
          ).toBe(htmlNote);
          expect(requests).toHaveLength(
            beforeToggle + (width === 1280 ? 1 : 0),
          );
          await pane.locator(".report-comment").scrollIntoViewIfNeeded();
          await page.screenshot({
            path: join(shots, `${width}-html-source-comments.png`),
          });
          page.once("dialog", (dialog) => dialog.accept());
          if (width === 1280) {
            await page
              .locator(".dv-tab", { hasText: "page.html" })
              .getByRole("button", { name: "Close page.html", exact: true })
              .click();
            await pane.waitFor({ state: "detached" });
            const notes = await tree
              .locator('.explorer-row[data-path^="notes-"]')
              .evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute("data-path")!),
              );
            const slots = 8 - (await page.locator(".file-tab").count());
            expect(slots).toBeGreaterThan(0);
            expect(notes.length).toBeGreaterThan(slots);
            for (const path of notes.slice(0, slots)) {
              await tree.locator(`.explorer-row[data-path="${path}"]`).click();
              const preview = fileFor(path).locator(".explorer-source");
              await preview.waitFor();
              expect(await preview.textContent()).toBe(
                await readFile(join(root, path), "utf8"),
              );
            }
            expect(await page.locator(".file-tab").count()).toBe(8);
            await tree
              .locator(`.explorer-row[data-path="${notes[slots]}"]`)
              .click();
            await tree
              .getByText("Close a file tab before opening another.", {
                exact: true,
              })
              .waitFor();
            expect(await page.locator(".file-tab").count()).toBe(8);
            for (const path of notes.slice(0, slots)) {
              const tab = page.locator(".dv-tab", { hasText: path });
              await tab.hover();
              await tab
                .getByRole("button", { name: `Close ${path}`, exact: true })
                .click();
              await tab.waitFor({ state: "detached" });
            }
            await page.locator('.dv-tab[data-dock-panel="chat"]').click();
          } else
            await pane
              .locator(".explorer-filebar")
              .getByRole("button", { name: "Files", exact: true })
              .click();
          pane = tree;
          if (width === 412) {
            await pane
              .getByRole("button", { name: "Close Explorer", exact: true })
              .click();
            await pane.waitFor({ state: "hidden" });
          }
          const composer = page.locator("#input");
          const fileMenu = page.locator("#file-menu");
          await composer.fill("");
          await page.keyboard.type("# ");
          expect(await composer.inputValue()).toBe("# ");
          expect(await fileMenu.isVisible()).toBe(false);
          await composer.fill("Review #pick");
          const fileOption = fileMenu.getByRole("option", {
            name: pickedPath,
            exact: true,
          });
          await fileOption.waitFor();
          const completedFiles = await fileMenu
            .getByRole("option")
            .allTextContents();
          const lazySearchPath = `**/api/conversations/${fixture.agent}/tree/search?*`;
          const lazyRoutes = new Map<
            string,
            ReturnType<typeof Promise.withResolvers<Route>>
          >();
          for (const query of ["picking", "pickingmore"])
            lazyRoutes.set(query, Promise.withResolvers<Route>());
          await page.route(lazySearchPath, (route) => {
            const query = new URL(route.request().url()).searchParams.get("q")!;
            const held = lazyRoutes.get(query);
            if (held) return held.resolve(route);
            return route.fallback();
          });
          await composer.press("End");
          await page.keyboard.insertText("ing");
          const olderSearch = await lazyRoutes.get("picking")!.promise;
          if (process.env.LAZY_SEARCH_SCREENSHOT_DIR)
            await page.screenshot({
              path: join(
                process.env.LAZY_SEARCH_SCREENSHOT_DIR,
                `files-${width}.png`,
              ),
            });
          await browserExpect(fileOption).toBeVisible();
          await browserExpect(fileOption).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await browserExpect(fileMenu).not.toContainText(
            /Finding files|Searching|Loading/,
          );
          const olderCancelled = page.waitForEvent("requestfailed", {
            predicate: (request) => request === olderSearch.request(),
          });
          await page.keyboard.insertText("more");
          const newerSearch = await lazyRoutes.get("pickingmore")!.promise;
          await browserExpect(fileOption).toBeVisible();
          await newerSearch.fulfill({
            json: { results: ["newer-file.ts", pickedPath] },
          });
          await browserExpect(fileMenu.getByRole("option")).toHaveCount(2);
          await browserExpect(fileOption).toHaveAttribute(
            "aria-selected",
            "true",
          );
          await olderSearch
            .fulfill({ json: { results: ["stale-file.ts"] } })
            .catch(() => {});
          expect((await olderCancelled).failure()?.errorText).toContain(
            "ERR_ABORTED",
          );
          await browserExpect(fileMenu.getByRole("option")).toHaveText([
            "newer-file.ts",
            pickedPath,
          ]);
          await page.unroute(lazySearchPath);
          await composer.press("Escape");
          const restoredSearch = page.waitForResponse(
            (response) =>
              response
                .url()
                .includes(`/api/conversations/${fixture.agent}/tree/search?`) &&
              new URL(response.url()).searchParams.get("q") === "pick",
          );
          await composer.fill("Review #pick");
          await restoredSearch;
          await browserExpect(fileMenu.getByRole("option")).toHaveText(
            completedFiles,
          );
          await fileOption.waitFor();
          for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
            for (const key of ["Escape", "Enter"]) {
              await composer.dispatchEvent("keydown", {
                key,
                bubbles: true,
                ...composition,
              });
              expect(await fileMenu.isVisible()).toBe(true);
              expect(await composer.inputValue()).toBe("Review #pick");
            }
          }
          await composer.press("ArrowLeft");
          await page.waitForFunction(
            "document.getElementById('file-menu-style')?.sheet",
          );
          const menuBounds = (await fileMenu.boundingBox())!;
          const fieldBounds = (await page.locator("#composer").boundingBox())!;
          expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(
            fieldBounds.y,
          );
          expect(menuBounds.y + menuBounds.height).toBeGreaterThan(
            fieldBounds.y - fieldBounds.height,
          );
          await page.screenshot({
            path: join(shots, `${width}-composer-files.png`),
          });
          if (width === 1280) await fileOption.click();
          else {
            await composer.press("ArrowDown");
            await composer.press("ArrowUp");
            await composer.press("Tab");
          }
          const chosen = "Review ``" + pickedPath + "`` ";
          expect(await composer.inputValue()).toBe(chosen);
          expect(await fileMenu.isVisible()).toBe(false);
          await page.screenshot({
            path: join(shots, `${width}-composer-path.png`),
          });
          const pickerReply = `Composer files ${width} received`;
          const pickerMessage = `${chosen}\nReply only ${pickerReply}`;
          await composer.fill(pickerMessage);
          const pickedDelivery = page.waitForRequest(
            (request) =>
              request.method() === "POST" &&
              new URL(request.url()).pathname ===
                `/api/conversations/${fixture.agent}/deliver`,
          );
          await page.locator("#send").click();
          expect((await pickedDelivery).postDataJSON().content).toBe(
            pickerMessage,
          );
          await page
            .locator("#messages .msg.assistant")
            .filter({ hasText: pickerReply })
            .waitFor();
          if (width === 412) {
            await openExplorer(page, width);
            const folder = pane.locator(".explorer-row", { hasText: "src" });
            await folder.waitFor();
            if ((await folder.getAttribute("aria-expanded")) !== "true")
              await folder.click();
            await pane
              .locator(".explorer-row", { hasText: "application.ts" })
              .waitFor();
          }
          const held = Promise.withResolvers<Route>();
          const heldPath = `**/api/conversations/${fixture.agent}/tree/file?*`;
          await page.route(heldPath, (route) => held.resolve(route));
          await pane
            .locator(".explorer-row", { hasText: "application.ts" })
            .click();
          const pending = await held.promise;
          await composer.fill("Review #pick");
          await fileOption.waitFor();
          const cancelled = page.waitForEvent("requestfailed", {
            predicate: (request) => request === pending.request(),
          });
          const heldSearch = Promise.withResolvers<Route>();
          const searchPath = `**/api/conversations/${fixture.agent}/tree/search?*`;
          await page.route(searchPath, (route) => heldSearch.resolve(route));
          await composer.fill("#onlyhere");
          const searching = await heldSearch.promise;
          const searchCancelled = page.waitForEvent("requestfailed", {
            predicate: (request) => request === searching.request(),
          });
          await page.evaluate(
            `location.hash = ${JSON.stringify(`#agent=${other.agent}`)}`,
          );
          await pane.waitFor({ state: "detached" });
          await fileMenu.waitFor({ state: "hidden" });
          await page.waitForFunction(
            "document.querySelector('#input').value === ''",
          );
          expect(await composer.inputValue()).toBe("");
          await pending.continue().catch(() => {});
          expect((await cancelled).failure()?.errorText).toContain(
            "ERR_ABORTED",
          );
          await page.unroute(heldPath);
          await searching.continue().catch(() => {});
          expect((await searchCancelled).failure()?.errorText).toContain(
            "ERR_ABORTED",
          );
          await page.unroute(searchPath);
          await openExplorer(page, width);
          await pane
            .locator(".explorer-row", { hasText: "only-here.txt" })
            .waitFor();
          expect(
            await pane
              .locator(".explorer-row", { hasText: "application.ts" })
              .count(),
          ).toBe(0);
          if (width === 412) {
            await pane
              .getByRole("button", { name: "Close Explorer", exact: true })
              .click();
            await pane.waitFor({ state: "hidden" });
          }
          await composer.fill("#pick");
          await fileMenu
            .getByText("No matching files.", { exact: true })
            .waitFor();
          expect(await fileMenu.getByRole("option").count()).toBe(0);
          await composer.fill("#onlyhere");
          await fileMenu
            .getByRole("option", { name: "only-here.txt", exact: true })
            .waitFor();
          expect(
            (await fileMenu.getByRole("option").allTextContents()).map((text) =>
              text.trim(),
            ),
          ).toEqual(["only-here.txt"]);
          await composer.press("Escape");
          expect(await composer.inputValue()).toBe("#onlyhere");
          expect(await fileMenu.isVisible()).toBe(false);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
      console.log(
        `Explorer screenshots: ${shots}/{1280,412}-{tree,preview,comments,search,html-preview,html-source-comments}.png`,
      );
    } finally {
      retire(temporary, join(tmpdir(), ".trash"));
    }
  },
  // Feature: #3251 opening Explorer focuses search, whose results update lazily.
  async function test_explorer_search_is_focused_and_lazy(browser, base) {
    const root = await mkdtemp(join(tmpdir(), "browser-explorer-lazy-"));
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      for (const name of [
        "alpha-one.ts",
        "alpha-two.ts",
        "beta.ts",
        "gamma.ts",
      ])
        await writeFile(join(root, name), `${name}\n`);
      const { agent } = await postFixture(base, "seed-model-selection-error", {
        agent: "explorer-lazy",
        model: "fauxordinary/faux-1",
        workdir: root,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .locator("#conv-title", { hasText: "Choose a model" })
        .waitFor();
      await openExplorer(page, 1280);
      const pane = page.locator('.pane-col[data-pane="explorer"]');
      const search = pane.getByRole("combobox", { name: "Search files" });
      await pane.locator('.explorer-row[data-path="beta.ts"]').waitFor();
      expect(
        await search.evaluate(
          (node) => node === node.ownerDocument.activeElement,
        ),
      ).toBeTrue();
      const shown = () =>
        pane
          .locator(".explorer-result")
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("data-path")),
          );
      await page.keyboard.type("alpha");
      await pane
        .locator('.explorer-result[data-path="alpha-two.ts"]')
        .waitFor();
      expect((await shown()).sort()).toEqual(["alpha-one.ts", "alpha-two.ts"]);
      const held = {
        gamma: Promise.withResolvers<Route>(),
        beta: Promise.withResolvers<Route>(),
      };
      const searchPath = `**/api/conversations/${agent}/tree/search?*`;
      await page.route(searchPath, (route) => {
        const query = new URL(route.request().url()).searchParams.get("q");
        if (query === "gamma" || query === "beta") held[query].resolve(route);
        else void route.continue();
      });
      await search.fill("gamma");
      const gamma = await held.gamma.promise;
      expect((await shown()).sort()).toEqual(["alpha-one.ts", "alpha-two.ts"]);
      expect(await pane.getByText(/Searching/).count()).toBe(0);
      expect(await pane.locator(".explorer-row").count()).toBe(0);
      const gammaDropped = page.waitForEvent("requestfailed", {
        predicate: (request) => request === gamma.request(),
      });
      await search.fill("beta");
      const beta = await held.beta.promise;
      expect((await shown()).sort()).toEqual(["alpha-one.ts", "alpha-two.ts"]);
      await pane.locator('.explorer-result[data-path="alpha-two.ts"]').focus();
      await beta.continue();
      await pane.locator('.explorer-result[data-path="beta.ts"]').waitFor();
      const betaSet = await shown();
      expect(betaSet[0]).toBe("beta.ts");
      expect(betaSet).not.toContain("alpha-two.ts");
      expect(
        await pane
          .locator(".explorer-result.pane-item-cursor")
          .evaluate((node) => [
            node === node.ownerDocument.activeElement,
            node.getAttribute("data-path"),
          ]),
      ).toEqual([true, "beta.ts"]);
      await gamma.continue().catch(() => {});
      expect((await gammaDropped).failure()?.errorText).toContain(
        "ERR_ABORTED",
      );
      expect(await shown()).toEqual(betaSet);
      await page.unroute(searchPath);
      await search.press("Enter");
      await page
        .locator(".pane-col.file-tab .explorer-source", {
          hasText: "beta.ts",
        })
        .waitFor();
      await search.press("Escape");
      expect(await search.inputValue()).toBe("");
      await pane.locator('.explorer-row[data-path="beta.ts"]').waitFor();
      await search.press("Escape");
      expect(
        await pane
          .locator(".explorer-row.pane-item-cursor")
          .evaluate((node) => node === node.ownerDocument.activeElement),
      ).toBeTrue();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      retire(root, join(tmpdir(), ".trash"));
    }
  },
  // Regression: #3195 copy the opened file's folder, not an older tree root.
  async function test_explorer_copy_uses_opened_working_folder(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 915 },
    });
    const roots = new Set<string>();
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      const first = await postFixture(base, "seed-changes-base");
      const page = await context.newPage();
      await page.goto(`${base}#agent=${first.cid}`, {
        waitUntil: "domcontentloaded",
      });
      await openExplorer(page, 1280);
      const pane = page.locator('.pane-col[data-pane="explorer"]');
      await page.waitForFunction(() =>
        (globalThis as any).document
          .querySelector(".explorer-root")
          ?.getAttribute("title"),
      );
      const firstRoot = (await pane
        .locator(".explorer-root")
        .getAttribute("title"))!;
      expect(firstRoot).toMatch(/\/(?:changes-base|pi-seed-cwd)-[^/]+$/);
      roots.add(firstRoot);
      await writeFile(join(firstRoot, "a.txt"), "First working folder\n");
      await pane
        .getByRole("button", { name: "Refresh working folder" })
        .click();
      const row = pane.locator('.explorer-row[data-path="a.txt"]');
      await row.waitFor();
      await postFixture(base, "seed-changes-base");
      const listing = await page.request.get(
        `${base}api/conversations/${first.cid}/tree`,
      );
      expect(listing.ok()).toBeTrue();
      const secondRoot: string = (await listing.json()).root;
      expect(secondRoot).toMatch(/\/(?:changes-base|pi-seed-cwd)-[^/]+$/);
      expect(secondRoot).not.toBe(firstRoot);
      roots.add(secondRoot);
      await writeFile(join(secondRoot, "a.txt"), "Second working folder\n");
      expect(await pane.locator(".explorer-root").getAttribute("title")).toBe(
        firstRoot,
      );
      await row.focus();
      await page.keyboard.press("l");
      const file = page.locator(".pane-col.file-tab");
      await file
        .locator(".explorer-source", { hasText: "Second working folder" })
        .waitFor();
      await page.keyboard.press("y");
      await file.getByText("Path copied.", { exact: true }).waitFor();
      expect(
        await page.evaluate(() =>
          (globalThis as any).navigator.clipboard.readText(),
        ),
      ).toBe(`${secondRoot}/a.txt`);
    } finally {
      await context.close();
      for (const root of roots) retire(root, join(dirname(root), ".trash"));
    }
  },
];
if (import.meta.main) await runBrowserTests([["explorer", tests]]);
