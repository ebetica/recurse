import { expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect as browserExpect } from "playwright/test";
import { retire } from "../../src/utils/trash";
import {
  LOGIN,
  dispatchArtifactSelection,
  postFixture,
  startServer,
  stopServer,
  type BrowserTest,
} from "./common";
import { waitForPaneTransition } from "./pane_layout";

export const tests: BrowserTest[] = [
  // Feature: #3261 browse remote files through the existing proxy.
  async function test_remote_explorer_files_search_and_comments(browser, base) {
    const remote = await startServer({ auth: true });
    const temporary = await mkdtemp(join(tmpdir(), "remote-explorer-"));
    const root = join(temporary, "remote");
    const homeRoot = join(temporary, "home");
    const shots = join(
      process.env.RECURSE_AGENT_TMPDIR || tmpdir(),
      "remote-explorer-shots",
    );
    const source =
      "export const location = 'Connected remote working folder';\n";
    const setup = await browser.newContext();
    try {
      await mkdir(root);
      await mkdir(homeRoot);
      await mkdir(shots, { recursive: true });
      await writeFile(join(root, "remote-only.ts"), source);
      await writeFile(
        join(homeRoot, "home-only.ts"),
        "Home folder must not be read\n",
      );
      expect(await Bun.spawn(["git", "init", "-q", root]).exited).toBe(0);
      const login = await fetch(remote.base + "login", {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ password: LOGIN }),
      });
      expect(login.status).toBe(303);
      await setup.addCookies([
        {
          name: "chat_auth",
          value: login.headers
            .get("set-cookie")!
            .split(";")[0]!
            .slice("chat_auth=".length),
          url: remote.base,
        },
      ]);
      const seeded = await setup.request.post(
        remote.base + "__browser-test/seed-model-selection-error",
        {
          data: {
            agent: "remote-explorer",
            model: "fauxordinary/faux-1",
            workdir: root,
          },
        },
      );
      expect(seeded.ok()).toBeTrue();
      const { agent } = await seeded.json();
      expect(
        (
          await setup.request.post(
            `${remote.base}api/conversations/${agent}/rename`,
            {
              data: { title: "Remote Explorer" },
            },
          )
        ).ok(),
      ).toBeTrue();
      await postFixture(base, "seed-model-selection-error", {
        agent,
        model: "fauxordinary/faux-1",
        workdir: homeRoot,
      });
      expect(
        (
          await setup.request.post(base + "api/backends", {
            data: {
              label: "ExplorerRemote",
              url: remote.base,
              password: LOGIN,
            },
          })
        ).ok(),
      ).toBeTrue();
      const proxy = `${base}api/backends/ExplorerRemote/conversations/${agent}/tree`;
      for (const suffix of [
        "/file?path=../home/home-only.ts",
        "/raw?path=../home/home-only.ts",
      ]) {
        const refused = await setup.request.get(proxy + suffix);
        expect(refused.status()).toBe(422);
      }
      const range = await setup.request.get(
        proxy + "/raw?path=remote-only.ts",
        {
          headers: { range: "bytes=0-5" },
        },
      );
      expect(range.status()).toBe(206);
      expect(await range.text()).toBe(source.slice(0, 6));
      for (const width of [1280, 412]) {
        const context = await browser.newContext({
          viewport: { width, height: 915 },
          isMobile: width === 412,
          hasTouch: width === 412,
        });
        try {
          const page = await context.newPage();
          const localReads: string[] = [];
          page.on("request", (request) => {
            if (
              new URL(request.url()).pathname.startsWith(
                `/api/conversations/${agent}/tree`,
              )
            )
              localReads.push(request.url());
          });
          await page.goto(`${base}#agent=ExplorerRemote/${agent}`);
          await page
            .locator("#conv-title", { hasText: "Remote Explorer" })
            .waitFor();
          if (width === 412) {
            await page.locator("#pane-fab").click();
            await page.locator('.pane-menu-item[data-pane="explorer"]').click();
          } else {
            await page.keyboard.press("o");
            await page.getByRole("option", { name: /Explorer/ }).click();
          }
          const tree = page.locator('.pane-col[data-pane="explorer"]');
          await waitForPaneTransition(page, '.pane-col[data-pane="explorer"]');
          const row = tree.locator('.explorer-row[data-path="remote-only.ts"]');
          await row.waitFor();
          expect(
            await row.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return [
                [box.left + 2, box.top + 2],
                [box.right - 2, box.top + 2],
                [box.left + 2, box.bottom - 2],
                [box.right - 2, box.bottom - 2],
              ].every(([x, y]) =>
                element.contains(
                  element.ownerDocument.elementFromPoint(x!, y!),
                ),
              );
            }),
          ).toBeTrue();
          expect(
            await tree.locator(".explorer-root").getAttribute("title"),
          ).toBe(root);
          expect(
            await tree.getByText("home-only.ts", { exact: true }).count(),
          ).toBe(0);
          await row.click();
          let file = width === 1280 ? page.locator(".pane-col.file-tab") : tree;
          await browserExpect(file.locator(".explorer-source")).toHaveText(
            source,
          );
          const download = page.waitForEvent("download");
          await file
            .getByRole("link", { name: "Download file", exact: true })
            .click();
          expect((await download).suggestedFilename()).toBe("remote-only.ts");
          if (width === 1280) {
            await page.reload();
            file = page.locator(".pane-col.file-tab");
            await browserExpect(file.locator(".explorer-source")).toHaveText(
              source,
            );
            await tree.locator("#explorer-search").fill("remoteonly");
          } else {
            await file
              .getByRole("button", { name: "Files", exact: true })
              .click();
            await tree.locator("#explorer-search").fill("remoteonly");
          }
          const found = tree.locator(".explorer-result", {
            hasText: "remote-only.ts",
          });
          await found.waitFor();
          await found.click();
          await browserExpect(file.locator(".explorer-source")).toHaveText(
            source,
          );
          await dispatchArtifactSelection(
            page,
            width === 412 ? "touch" : "mouse",
            "location",
            file.locator(".report-doc"),
          );
          const popover = page.locator(".report-comment-popover");
          await popover
            .locator("textarea")
            .fill("Explain this remote declaration.");
          await popover
            .getByRole("button", { name: "Comment", exact: true })
            .click();
          await browserExpect(file.locator("mark.report-cmark")).toHaveText(
            "location",
          );
          await page.screenshot({ path: join(shots, `${width}.png`) });
          if (width === 412) {
            await page
              .getByRole("button", { name: "Close Explorer", exact: true })
              .click();
          } else {
            await page.locator(".dv-tab", { hasText: "Chat" }).click();
          }
          await page.locator("#input").fill("#remoteonly");
          const suggestion = page.locator("#file-menu .file-option", {
            hasText: "remote-only.ts",
          });
          await suggestion.waitFor();
          await suggestion.click();
          expect(await page.locator("#input").inputValue()).toBe(
            "`remote-only.ts` ",
          );
          expect(localReads).toEqual([]);
        } finally {
          await context.close();
        }
      }
      console.log(`Remote Explorer screenshots: ${shots}/{1280,412}.png`);
    } finally {
      await setup.request.delete(base + "api/backends/ExplorerRemote");
      await setup.close();
      await stopServer(remote);
      retire(temporary, join(tmpdir(), ".trash"));
    }
  },
];
