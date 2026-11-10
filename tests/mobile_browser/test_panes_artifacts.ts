import { expect } from "bun:test";
import {
  ARTIFACT,
  ARTIFACT_VERSION,
  LOGIN,
  startServer,
  stopServer,
  assertArtifactVersionMenuEscape,
  captureErrors,
  dispatchArtifactSelection,
  dispatchArtifactTap,
  gotoRoot,
  postFixture,
  rootAgentId,
  routeArtifacts,
  runBrowserTests,
  themeColors,
  visibleAndUncovered,
  type BrowserTest,
} from "./common";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { artifactReopen } from "./artifact_reopen";

export const tests: BrowserTest[] = [
  // Regression: #3200 staging a selection comment cannot override a later viewer focus change.
  async function test_artifact_reload_selection_and_content(
    browser,
    base,
    data,
    serverPid,
  ) {
    const context = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const owner = rootAgentId();
    const first = await artifacts.create(context, { owner, title: "First" });
    const second = await artifacts.create(context, { owner, title: "Second" });
    for (const [item, title] of [
      [first, "First"],
      [second, "Second"],
    ] as const) {
      await writeFile(
        join(String(item.repo_path), "index.md"),
        `# ${title} initial`,
      );
      await artifacts.publish(context, owner, String(item.id));
    }
    for (const phone of [false, true]) {
      const browserContext = await browser.newContext({
        viewport: { width: phone ? 390 : 1280, height: 800 },
        isMobile: phone,
        hasTouch: phone,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await browserContext.newPage();
      const errors = captureErrors(page);
      await page.goto(`${base}#agent=${owner}&artifact=${first.id}`);
      await page.locator("#artifact-picker").waitFor();
      await page.evaluate(
        (id) =>
          (globalThis as any).history.replaceState(null, "", `#agent=${id}`),
        owner,
      );
      await page.locator("#artifact-picker").selectOption(String(second.id));
      await page
        .getByRole("heading", { name: "Second initial", exact: true })
        .waitFor();
      const version = String(
        (await artifacts.get(context, owner, String(second.id))).version,
      );
      const url = `${base}api/artifacts/${second.id}/file?agent=${owner}&path=index.md&version=${version}`;
      const response = await page.request.get(url);
      const etag = response.headers().etag;
      expect(etag).toBeTruthy();
      expect(
        (
          await page.request.get(url, { headers: { "If-None-Match": etag! } })
        ).status(),
      ).toBe(304);
      expect(
        (
          await page.request.get(
            url.replace(`agent=${owner}`, "agent=missing-owner"),
            {
              headers: { "If-None-Match": etag! },
            },
          )
        ).status(),
      ).toBe(404);
      const unversioned = await page.request.get(
        url.replace(`&version=${version}`, ""),
        {
          headers: { "If-None-Match": etag! },
        },
      );
      expect(unversioned.status()).toBe(200);
      expect(unversioned.headers()["cache-control"]).toBe("private, no-store");
      const revalidation = page.waitForRequest((request) => {
        const target = new URL(request.url());
        return (
          target.pathname === `/api/artifacts/${second.id}/file` &&
          target.searchParams.get("version") === version
        );
      });
      await page.reload();
      expect((await (await revalidation).allHeaders())["if-none-match"]).toBe(
        etag,
      );
      await page
        .getByRole("heading", { name: "Second initial", exact: true })
        .waitFor();
      expect(await page.locator("#artifact-picker").inputValue()).toBe(
        String(second.id),
      );
      if (!phone) {
        let release = () => {};
        let held = () => {};
        const pending = new Promise<void>((resolve) => (release = resolve));
        const requested = new Promise<void>((resolve) => (held = resolve));
        const route = `**/api/conversations/${owner}?**`;
        const files: string[] = [];
        const recordFile = (request: { url(): string }) => {
          if (
            new URL(request.url()).pathname.endsWith(
              `/artifacts/${second.id}/file`,
            )
          )
            files.push(request.url());
        };
        page.on("request", recordFile);
        await page.route(route, async (request) => {
          held();
          await pending;
          await request.continue();
        });
        const reload = page.reload();
        await requested;
        await page.locator(".agent").first().waitFor();
        expect(
          await page.locator('.pane-col[data-pane="report"]').count(),
        ).toBe(0);
        expect(files).toEqual([]);
        release();
        await reload;
        await page.unroute(route);
        page.off("request", recordFile);
        await page
          .getByRole("heading", { name: "Second initial", exact: true })
          .waitFor();
      }
      await writeFile(
        join(String(second.repo_path), "index.md"),
        "# Second updated\n\n" + "Artifact paragraph.\n\n".repeat(100),
      );
      const updated = await artifacts.publish(
        context,
        owner,
        String(second.id),
      );
      await page
        .getByRole("heading", { name: "Second updated", exact: true })
        .waitFor();
      expect(
        (
          await page.request.get(
            url.replace(version, String(updated.version)),
            {
              headers: { "If-None-Match": etag! },
            },
          )
        ).status(),
      ).toBe(200);
      const pane = page.locator('.pane-col[data-pane="report"]');
      if (!phone) {
        await pane
          .getByRole("button", { name: "Version history", exact: true })
          .click();
        await pane.getByRole("menuitemradio").nth(1).waitFor();
        await page.keyboard.press("Escape");
        await pane.locator(".report-doc").focus();
        await page.keyboard.press("[");
        await page
          .getByRole("heading", { name: "Second initial", exact: true })
          .waitFor();
        await page.keyboard.press("]");
        await page
          .getByRole("heading", { name: "Second updated", exact: true })
          .waitFor();
        await pane.locator(".report-doc").focus();
        const body = pane.locator(".pane-body");
        for (const key of ["j", "d"]) {
          await page.keyboard.press(key);
          await page.waitForFunction(
            () =>
              (globalThis as any).document.querySelector(
                '.pane-body[data-pane="report"]',
              ).scrollTop > 0,
          );
          expect(await page.locator("#artifact-picker").inputValue()).toBe(
            String(second.id),
          );
          const down = await body.evaluate((element) => element.scrollTop);
          await page.keyboard.press(key === "j" ? "k" : "u");
          await page.waitForFunction(
            (down) =>
              (globalThis as any).document.querySelector(
                '.pane-body[data-pane="report"]',
              ).scrollTop < down,
            down,
          );
        }
        await dispatchArtifactSelection(page, "mouse", "Second updated");
        await page
          .locator(".report-comment-popover:not([hidden]) textarea")
          .fill("Keep this note");
        expect(
          await page
            .locator(".report-comment-popover-submit")
            .evaluate((button: any) => {
              button.click();
              const viewer = button.ownerDocument.querySelector(
                '.pane-col[data-pane="report"] .report-doc',
              )!;
              viewer.focus();
              return new Promise<boolean>((resolve) =>
                (globalThis as any).requestAnimationFrame(() =>
                  resolve(button.ownerDocument.activeElement === viewer),
                ),
              );
            }),
        ).toBe(true);
        page.once("dialog", (dialog) => void dialog.dismiss());
        await page.keyboard.press("h");
        expect(await pane.locator(".artifact-list").count()).toBe(0);
        expect(await pane.locator(".report-comment").count()).toBe(1);
        page.once("dialog", (dialog) => void dialog.accept());
        await page.keyboard.press("h");
        await pane.locator(".artifact-list").waitFor();
        expect(await pane.locator(".report-doc").isVisible()).toBe(false);
        expect(await pane.locator(".report-comment").count()).toBe(0);
        const cursor = pane.locator(".pane-item-cursor");
        await page.keyboard.press("j");
        expect(await cursor.getAttribute("aria-label")).toBe("First");
        await page.keyboard.press("k");
        expect(await cursor.getAttribute("aria-label")).toBe("Second");
        await page.keyboard.press("Shift+G");
        expect(await cursor.getAttribute("aria-label")).toBe("First");
        await page.keyboard.press("g");
        await page.keyboard.press("g");
        expect(await cursor.getAttribute("aria-label")).toBe("Second");
        await page.keyboard.press("j");
        await page.keyboard.press("y");
        await pane.getByText("Link copied.", { exact: true }).waitFor();
        const copied = await page.evaluate(() =>
          (globalThis as any).navigator.clipboard.readText(),
        );
        await page.keyboard.press("l");
        await page
          .getByRole("heading", { name: "First initial", exact: true })
          .waitFor();
        const download = pane.locator(".artifact-download");
        expect(copied).toBe(
          new URL((await download.getAttribute("href"))!, base).href,
        );
        await page.keyboard.press("/");
        const filter = pane.getByRole("searchbox", {
          name: "Filter artifacts",
        });
        await filter.fill("SECOND");
        expect(await pane.locator(".artifact-list-item").count()).toBe(1);
        await page.keyboard.type("j");
        expect(await filter.inputValue()).toBe("SECONDj");
        await pane
          .getByText("No matching artifacts.", { exact: true })
          .waitFor();
        await page.keyboard.press("Backspace");
        await body.focus();
        await page.keyboard.press("j");
        await page.keyboard.press("Enter");
        await page
          .getByRole("heading", { name: "Second updated", exact: true })
          .waitFor();
        await page.keyboard.press("y");
        await pane.getByText("Link copied.", { exact: true }).waitFor();
        expect(
          await page.evaluate(() =>
            (globalThis as any).navigator.clipboard.readText(),
          ),
        ).toBe(new URL((await download.getAttribute("href"))!, base).href);
        await page.keyboard.press("/");
        expect(await filter.inputValue()).toBe("SECOND");
        const pointer = await browserContext.newCDPSession(page);
        const changePointer = async (enabled: boolean) => {
          await page.evaluate(() => {
            const browser = globalThis as any;
            browser.__pointerChanged = new Promise<void>((resolve) => {
              browser
                .matchMedia("(pointer: coarse)")
                .addEventListener(
                  "change",
                  () => browser.requestAnimationFrame(() => resolve()),
                  { once: true },
                );
            });
          });
          await pointer.send("Emulation.setTouchEmulationEnabled", { enabled });
          await page.evaluate(() => (globalThis as any).__pointerChanged);
        };
        await changePointer(true);
        await page.locator("#artifact-picker").waitFor();
        expect(await pane.locator(".artifact-list").count()).toBe(0);
        await changePointer(false);
        await filter.waitFor();
        expect(await filter.inputValue()).toBe("SECOND");
        expect(await pane.locator(".artifact-list-item").count()).toBe(1);
        for (const staged of [true, false]) {
          await changePointer(true);
          await dispatchArtifactSelection(page, "touch", "Second updated");
          const draft = page.locator(".report-comment-popover:not([hidden])");
          await draft
            .locator("textarea")
            .fill(staged ? "Touch note" : "Touch draft");
          if (staged)
            await draft.locator(".report-comment-popover-submit").click();
          await changePointer(false);
          expect(await pane.locator(".artifact-list").count()).toBe(0);
          expect(await pane.locator(".report-doc").isVisible()).toBeTrue();
          if (staged) {
            expect(
              await pane.locator(".report-comment").isVisible(),
            ).toBeTrue();
            expect(
              await pane.locator(".report-sendbar-send").isVisible(),
            ).toBeTrue();
            await pane.locator(".report-doc").focus();
            page.once("dialog", (dialog) => void dialog.dismiss());
            await page.keyboard.press("h");
            expect(await pane.locator(".report-comment").count()).toBe(1);
            page.once("dialog", (dialog) => void dialog.accept());
          } else {
            expect(await draft.isVisible()).toBeTrue();
            expect(await draft.locator("textarea").inputValue()).toBe(
              "Touch draft",
            );
            await draft.locator(".report-comment-popover-cancel").click();
          }
          await body.focus();
          await page.keyboard.press("h");
          await pane.locator(".artifact-list").waitFor();
        }
        await pointer.detach();
        await body.focus();
        await page.keyboard.press("j");
      } else {
        expect(await pane.locator(".artifact-list").count()).toBe(0);
        expect(
          await pane.locator(".artifact-browse-btn").isVisible(),
        ).toBeFalse();
      }
      const shots = process.env.RECURSE_SCREENSHOT_DIR;
      if (shots) {
        await mkdir(shots, { recursive: true });
        await page.screenshot({
          path: `${shots}/${phone ? 390 : 1280}-artifacts-navigation.png`,
        });
      }
      if (!phone) {
        await page.keyboard.press("Escape");
        await page.waitForFunction(() =>
          (globalThis as any).document.activeElement?.matches(".agent"),
        );
        await pane.locator(".pane-body").focus();
        await page.keyboard.press("q");
        await pane.waitFor({ state: "detached" });
      }
      if (phone) {
        await artifacts.deleteArtifact(
          context,
          owner,
          String(second.id),
          String(updated.version),
        );
        expect(
          (
            await page.request.get(url, { headers: { "If-None-Match": etag! } })
          ).status(),
        ).toBe(404);
        await page.reload();
        await page
          .getByRole("heading", { name: "First initial", exact: true })
          .waitFor();
        expect(await page.locator("#artifact-picker").inputValue()).toBe(
          String(first.id),
        );
      }
      expect(errors).toEqual([]);
      await browserContext.close();
      if (!phone) {
        await writeFile(
          join(String(second.repo_path), "index.md"),
          "# Second initial",
        );
        await artifacts.publish(context, owner, String(second.id));
      }
    }
    const remote = await startServer({ auth: true });
    try {
      const login = await fetch(remote.base + "login", {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ password: LOGIN }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const tree = (await (
        await fetch(remote.base + "api/tree", { headers: { cookie } })
      ).json()) as Array<{ id: string; parent: string | null }>;
      const remoteOwner = tree.find((node) => node.parent === null)!.id;
      const remoteContext = {
        artifactsDir: join(remote.data, "data", "artifact_repos"),
        trashDir: join(remote.data, "data", "trash"),
      };
      const app = await artifacts.create(remoteContext, {
        owner: remoteOwner,
        title: "Remote app",
      });
      await writeFile(
        join(String(app.repo_path), "index.html"),
        '<button id="count" onclick="this.textContent=\'clicked\'">click</button>',
      );
      const published = await artifacts.publish(
        remoteContext,
        remoteOwner,
        String(app.id),
      );
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      expect(
        (
          await page.request.post(base + "api/backends", {
            data: { label: "CacheRemote", url: remote.base, password: LOGIN },
          })
        ).ok(),
      ).toBeTrue();
      const path = `/api/backends/CacheRemote/artifacts/${app.id}/page`;
      const initial = page.waitForResponse(
        (response) => new URL(response.url()).pathname === path,
      );
      await page.goto(
        `${base}#agent=${encodeURIComponent(`CacheRemote/${remoteOwner}`)}&artifact=${app.id}`,
      );
      const frame = page.frameLocator("iframe.artifact-embed-page");
      await frame.locator("#count").click();
      await frame.getByText("clicked", { exact: true }).waitFor();
      const pane = page.locator('.pane-col[data-pane="report"]');
      await pane.locator(".pane-body").focus();
      await page.keyboard.press("h");
      await pane.locator(".artifact-list").waitFor();
      await page.keyboard.press("Enter");
      await frame.getByText("clicked", { exact: true }).waitFor();
      const etag = (await initial).headers().etag;
      expect(etag).toBeTruthy();
      const unauthorized = await fetch(
        `${remote.base}api/artifacts/${app.id}/page?agent=${remoteOwner}&version=${published.version}`,
        { headers: { "If-None-Match": etag! } },
      );
      expect(unauthorized.status).not.toBe(304);
      expect(unauthorized.ok).toBeFalse();
      const revalidation = page.waitForRequest(
        (request) => new URL(request.url()).pathname === path,
      );
      await page.reload();
      expect((await (await revalidation).allHeaders())["if-none-match"]).toBe(
        etag,
      );
      await frame.locator("#count").click();
      await frame.getByText("clicked", { exact: true }).waitFor();
      await writeFile(
        join(remote.data, "data/config/themes.json"),
        JSON.stringify({ theme: "Ocean" }),
      );
      const themed = await fetch(
        `${remote.base}api/artifacts/${app.id}/page?agent=${remoteOwner}&version=${published.version}`,
        {
          headers: { cookie, "If-None-Match": etag! },
        },
      );
      expect(themed.status).toBe(200);
      expect(themed.headers.get("etag")).not.toBe(etag);
      await page.close();
    } finally {
      await fetch(base + "api/backends/CacheRemote", {
        method: "DELETE",
      }).finally(() => stopServer(remote));
    }
    await artifactReopen(browser, base, data, serverPid);
  },
  // Feature: #2728 Git commits publish into the already-open Artifact pane.
  async function test_artifact_commit_updates_open_pane(browser, base, data) {
    const page = await browser.newPage();
    const context = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    for (const kind of ["document", "app"]) {
      const item = await artifacts.create(context, {
        owner: rootAgentId(),
        title: `Commit ${kind}`,
      });
      const repo = String(item.repo_path);
      const entry = kind === "document" ? "index.md" : "index.html";
      const content = (text: string) =>
        kind === "document"
          ? `# ${text}`
          : `<h1>${text}</h1><button>Try</button>`;
      await writeFile(join(repo, entry), content("Initial commit"));
      await artifacts.publish(context, rootAgentId(), String(item.id));
      await page.goto(`${base}#artifact=${item.id}`);
      const visible = (text: string) =>
        kind === "document"
          ? page.getByRole("heading", { name: text, exact: true })
          : page
              .frameLocator("iframe.artifact-embed-page")
              .getByRole("heading", {
                name: text,
                exact: true,
              });
      await visible("Initial commit").waitFor();
      await writeFile(join(repo, entry), content("Committed update"));
      await Bun.$`git -C ${repo} add --all`.quiet();
      const start = performance.now();
      const commit = Bun.spawn(
        ["git", "-C", repo, "commit", "-m", `Update ${kind}`],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      let output = "";
      let published: number | undefined;
      const completion = (async () => {
        for await (const chunk of commit.stderr) {
          output += new TextDecoder().decode(chunk);
          if (published === undefined && /"command":\s*"publish"/.test(output))
            published = Math.round(performance.now() - start);
        }
        return {
          exitCode: await commit.exited,
          completed: Math.round(performance.now() - start),
        };
      })();
      await visible("Committed update").waitFor();
      console.log(
        `ARTIFACT_LATENCY ${kind} viewer=${Math.round(performance.now() - start)}ms`,
      );
      const { exitCode, completed } = await completion;
      console.log(
        `ARTIFACT_LATENCY ${kind} published=${published}ms completion=${completed}ms`,
      );
      expect(exitCode).toBe(0);
      const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
      expect(
        (await artifacts.get(context, rootAgentId(), String(item.id))).version,
      ).toBe(head);
      if (kind === "app") {
        expect(output).toMatch(/"command":\s*"check"/);
        expect(output).toMatch(/"ok":\s*true/);
        await writeFile(
          join(repo, entry),
          '<script type="module" src="./missing.ts"></script>',
        );
        await Bun.$`git -C ${repo} add --all`.quiet();
        const failed =
          await Bun.$`git -C ${repo} commit -m ${"Broken app"}`.quiet();
        expect(failed.stderr.toString()).toMatch(/"code":\s*"build"/);
        expect(
          (await artifacts.get(context, rootAgentId(), String(item.id)))
            .version,
        ).toBe(head);
        await visible("Committed update").waitFor();
      }
    }
    await page.close();
  },

  // Regression: #2721 image placeholders stretched figures and enlarged small images.
  async function test_artifact_figure_natural_dimensions(browser, base, data) {
    const page = await browser.newPage();
    const context = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const item = await artifacts.create(context, {
      owner: rootAgentId(),
      title: "Figure aspect ratios",
    });
    const repo = String(item.repo_path);
    for (const [name, width, height] of [
      ["wide", 480, 120],
      ["tall", 120, 480],
    ] as const) {
      await writeFile(
        join(repo, `${name}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="steelblue"/></svg>`,
      );
      const png = await page.evaluate(
        ([width, height]) => {
          const canvas = (globalThis as any).document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")!.fillRect(0, 0, width, height);
          return canvas.toDataURL("image/png").split(",")[1]!;
        },
        [width, height],
      );
      await writeFile(
        join(repo, `${name}.png`),
        new Uint8Array(Buffer.from(png, "base64")),
      );
    }
    await writeFile(
      join(repo, "index.md"),
      '# Figure aspect ratios\n\n<img src="wide.png" width="400" height="400" alt="Both dimensions">\n\n<img src="tall.png" width="60" alt="Width only">\n\n<img src="wide.svg" height="60" alt="Height only">\n\n![Wide PNG](wide.png)\n\n![Tall PNG](tall.png)\n\n![Wide SVG](wide.svg)\n\n![Tall SVG](tall.svg)',
    );
    await artifacts.publish(context, rootAgentId(), String(item.id));
    const measurements = [];
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}#artifact=${item.id}`);
      await page.waitForFunction(() => {
        const images = [
          ...(globalThis as any).document.querySelectorAll(".artifact-image"),
        ];
        return (
          images.length === 7 &&
          images.every((image) => !image.hidden && image.naturalWidth > 0)
        );
      });
      if (width === 390) {
        const gap = await page
          .locator(".artifact-image-frame")
          .evaluateAll(
            (frames) =>
              frames[1]!.getBoundingClientRect().top -
              frames[0]!.getBoundingClientRect().bottom,
          );
        expect(gap).toBeGreaterThan(0);
      }
      if (process.env.ARTIFACT_FIGURE_SHOTS)
        await page.screenshot({
          path: `${process.env.ARTIFACT_FIGURE_SHOTS}/${width}.png`,
          fullPage: true,
        });
      measurements.push(
        ...(await page.locator(".artifact-image").evaluateAll((images) =>
          images.map((element) => {
            const image = element as any;
            const box = image.getBoundingClientRect();
            const frame = image.parentElement!.getBoundingClientRect();
            return {
              error: Math.abs(
                box.width /
                  box.height /
                  (image.naturalWidth / image.naturalHeight) -
                  1,
              ),
              width: box.width,
              naturalWidth: image.naturalWidth,
              frameError: Math.abs(
                frame.width /
                  frame.height /
                  (image.naturalWidth / image.naturalHeight) -
                  1,
              ),
            };
          }),
        )),
      );
    }
    for (const size of measurements) {
      expect(size.error).toBeLessThan(0.01);
      expect(size.frameError).toBeLessThan(0.01);
      expect(size.width).toBeLessThanOrEqual(size.naturalWidth);
    }
    await page.close();
  },

  // Regression: #2740 content settled with Refresh disabled until an unrelated toolbar render.
  async function test_artifact_disk_publication_refresh(browser, base, data) {
    const remote = await startServer({ auth: true });
    try {
      const login = await fetch(remote.base + "login", {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ password: LOGIN }),
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const tree = (await (
        await fetch(remote.base + "api/tree", { headers: { cookie } })
      ).json()) as Array<{ id: string; parent: string | null }>;
      const remoteOwner = tree.find((node) => node.parent === null)!.id;
      for (const [directory, label, owner] of [
        [data, "", rootAgentId()],
        [remote.data, "ArtifactRemote", remoteOwner],
      ] as const) {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        const errors = captureErrors(page);
        await page.addInitScript(() => {
          const dom = globalThis as any;
          new dom.MutationObserver((records: any[]) => {
            for (const record of records) {
              const pane = record.target;
              if (
                record.attributeName !== "aria-busy" ||
                pane.getAttribute("aria-busy") !== "false" ||
                !pane.textContent?.includes("Initial disk content")
              )
                continue;
              const refresh = pane.parentElement?.querySelector(
                ".artifact-refresh-btn",
              );
              if (
                refresh &&
                (globalThis as any).__settledArtifactRefreshDisabled ===
                  undefined
              )
                (globalThis as any).__settledArtifactRefreshDisabled =
                  refresh.disabled;
            }
          }).observe(dom.document, { subtree: true, attributes: true });
        });
        const agent = label ? `${label}/${owner}` : owner;
        const apiBase = label ? `/api/backends/${label}` : "/api";
        if (label) {
          expect(
            (
              await page.request.post(base + "api/backends", {
                data: { label, url: remote.base, password: LOGIN },
              })
            ).ok(),
          ).toBeTrue();
          await page.goto(base);
          await page
            .locator(
              `.backend-section[data-backend="${label}"] .agent[data-id="${agent}"]`,
            )
            .waitFor();
        }
        const context = {
          artifactsDir: join(directory, "data", "artifact_repos"),
          trashDir: join(directory, "data", "trash"),
        };
        const item = await artifacts.create(context, {
          owner,
          title: "Disk refresh",
        });
        const repo = String(item.repo_path);
        const publish = async (text: string) => {
          await writeFile(
            join(repo, "index.md"),
            `${text}\n\n![Disk image](figure.svg)`,
          );
          await writeFile(
            join(repo, "figure.svg"),
            `<svg xmlns="http://www.w3.org/2000/svg" width="${text.length * 10}" height="40"><rect width="100%" height="100%" fill="steelblue"/></svg>`,
          );
          await artifacts.publish(context, owner, String(item.id));
        };
        await publish("Initial disk content");
        const revisionRead = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            `${apiBase}/artifacts/revision`,
        );
        await page.goto(
          `${base}#agent=${encodeURIComponent(agent)}&artifact=${item.id}`,
        );
        await page.getByText("Initial disk content", { exact: true }).waitFor();
        await page.waitForFunction(
          () =>
            typeof (globalThis as any).__settledArtifactRefreshDisabled ===
            "boolean",
        );
        expect(
          await page.evaluate(
            () => (globalThis as any).__settledArtifactRefreshDisabled,
          ),
        ).toBeFalse();
        const revision = await revisionRead;
        expect(revision.status()).toBe(200);
        expect(new URL(revision.url()).searchParams.get("agent")).toBe(owner);
        const waitForRevision = async (
          expected: string | null,
          etag?: string,
        ) => {
          expect(typeof expected).toBe("string");
          const deadline = performance.now() + 2000;
          for (;;) {
            const response = await page.request.get(
              base + apiBase.slice(1) + "/tree",
              {
                headers: etag ? { "If-None-Match": etag } : {},
              },
            );
            const actual =
              response.status() === 200
                ? (await response.json()).find((row: any) => row.id === owner)
                    ?.artifacts_revision
                : null;
            if (actual === expected || performance.now() >= deadline) {
              expect(response.status()).toBe(200);
              expect(actual).toBe(expected);
              return response;
            }
            await Bun.sleep(100);
          }
        };
        const oldRevision = await artifacts.revision(context, owner);
        const treeResponse = await waitForRevision(oldRevision);
        const treeEtag = treeResponse.headers().etag!;
        expect(
          (
            await page.request.get(base + apiBase.slice(1) + "/tree", {
              headers: { "If-None-Match": treeEtag },
            })
          ).status(),
        ).toBe(304);
        const fileRequests: string[] = [];
        page.on("request", (request) => {
          if (
            new URL(request.url()).pathname.endsWith(
              `/artifacts/${item.id}/file`,
            )
          )
            fileRequests.push(request.url());
        });
        await publish("Manually refreshed disk content");
        const publishedRevision = await artifacts.revision(context, owner);
        expect(publishedRevision).not.toBe(oldRevision);
        const changedTree = await waitForRevision(publishedRevision, treeEtag);
        expect(changedTree.headers().etag).not.toBe(treeEtag);
        await page
          .getByRole("button", { name: "Refresh artifact", exact: true })
          .click({ timeout: 2000 });
        await page
          .getByText("Manually refreshed disk content", { exact: true })
          .waitFor({ timeout: 2000 });
        await page.waitForFunction(
          () =>
            (globalThis as any).document.querySelector(".artifact-image")
              ?.naturalWidth ===
            "Manually refreshed disk content".length * 10,
        );
        expect(
          fileRequests.some(
            (url) => new URL(url).searchParams.get("path") === "figure.svg",
          ),
        ).toBeTrue();
        fileRequests.length = 0;
        await Promise.all([
          page.waitForRequest(
            (request) =>
              new URL(request.url()).searchParams.get("path") === "figure.svg",
          ),
          page
            .getByRole("button", { name: "Refresh artifact", exact: true })
            .click(),
        ]);
        await publish("Automatically refreshed disk content");
        await page
          .getByText("Automatically refreshed disk content", { exact: true })
          .waitFor({ timeout: 2000 });
        expect(
          fileRequests.every((url) =>
            new URL(url).pathname.startsWith(apiBase + "/"),
          ),
        ).toBeTrue();
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally {
      await fetch(base + "api/backends/ArtifactRemote", {
        method: "DELETE",
      }).finally(() => stopServer(remote));
    }
  },

  // Regression: #2497 an open Artifact waited for the 15-second list refresh during a turn.
  async function test_artifact_follows_publication_during_running_turn(
    browser,
    base,
    data,
  ) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const { agent } = await (
      await page.request.post(`${base}__browser-test/seed-live-tools`, {
        data: { mode: "long" },
      })
    ).json();
    const context = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const item = await artifacts.create(context, {
      owner: agent,
      title: "Live publication",
    });
    const repo = String(item.repo_path);
    await writeFile(
      join(repo, "index.html"),
      "<!doctype html><body>Initial version</body>",
    );
    const initial = await artifacts.publish(context, agent, String(item.id));
    await page.goto(`${base}#agent=${agent}&artifact=${item.id}`);
    await page
      .frameLocator("iframe.artifact-embed-page")
      .getByText("Initial version", { exact: true })
      .waitFor();
    const delivered = await page.request.post(
      `${base}api/conversations/${agent}/deliver`,
      { data: { content: "Run tools." } },
    );
    expect(delivered.ok()).toBeTrue();
    await page
      .locator(`.agent[data-id="${agent}"] .agent-state.running`)
      .waitFor();
    await writeFile(
      join(repo, "index.html"),
      "<!doctype html><body>Latest version</body>",
    );
    const latest = await artifacts.publish(context, agent, String(item.id));
    expect(latest.version).not.toBe(initial.version);
    await page
      .frameLocator("iframe.artifact-embed-page")
      .getByText("Latest version", { exact: true })
      .waitFor({ timeout: 3000 });
    const tree = await (await page.request.get(`${base}api/tree`)).json();
    expect(tree.find((node: { id: string }) => node.id === agent).status).toBe(
      "running",
    );
    await page.close();
  },

  // Regression: #2365 pane keys must work after clicking sandboxed Artifact content.
  async function test_artifact_frame_pane_hotkeys(browser, base) {
    const app = await postFixture(base, "seed-artifact-app");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await gotoRoot(page, base);
    await page.locator(`a[href="#artifact=${app.id}"]`).click();
    const frame = page.frameLocator("iframe.artifact-embed-page");
    await frame.locator("body[data-ready]").waitFor();
    const pane = page.locator('.pane-col[data-pane="report"]');
    const fullscreen = pane.locator('.fs[aria-pressed="true"]');
    const content = await (await page
      .locator("iframe.artifact-embed-page")
      .elementHandle())!.contentFrame();
    await frame.locator("body").evaluate((body) => {
      body.style.setProperty("min-height", "2400px", "important");
    });
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector("iframe.artifact-embed-page")
          .clientHeight >= 2400,
    );
    await frame.locator("#count").click();
    await page.keyboard.press("j");
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector(
          '.pane-col[data-pane="report"] .pane-body',
        ).scrollTop > 0,
    );
    await page.keyboard.press("k");
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector(
          '.pane-col[data-pane="report"] .pane-body',
        ).scrollTop === 0,
    );
    await page.keyboard.press("d");
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector(
          '.pane-col[data-pane="report"] .pane-body',
        ).scrollTop > 40,
    );
    const down = await pane
      .locator(".pane-body")
      .evaluate((body) => body.scrollTop);
    await page.keyboard.press("u");
    await page.waitForFunction(
      (down) =>
        (globalThis as any).document.querySelector(
          '.pane-col[data-pane="report"] .pane-body',
        ).scrollTop < down,
      down,
    );
    await page.keyboard.press("Shift+G");
    await page.waitForFunction(() => {
      const body = (globalThis as any).document.querySelector(
        '.pane-col[data-pane="report"] .pane-body',
      );
      return body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    });
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector(
          '.pane-col[data-pane="report"] .pane-body',
        ).scrollTop === 0,
    );
    await page.setViewportSize({ width: 1280, height: 600 });
    await frame.locator("body").evaluate((body) => {
      body.style.setProperty("min-height", "32000px", "important");
      const win = body.ownerDocument.defaultView!;
      win.addEventListener("message", (event: any) => {
        if (event.data === "artifact-scroll-barrier")
          win.parent.postMessage(event.data, "*");
      });
    });
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector("iframe.artifact-embed-page")
          .clientHeight === 600,
    );
    await frame.locator("#count").click();
    await pane.locator(".pane-body").evaluate((body) => {
      body.scrollTop = 0;
    });
    await content!.evaluate(() => (globalThis as any).scrollTo(0, 0));
    await page.keyboard.press("j");
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelector(
          '.pane-col[data-pane="report"] .pane-body',
        ).scrollTop > 0,
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const win = globalThis as any;
          const frame = win.document.querySelector(
            "iframe.artifact-embed-page",
          );
          const receive = (event: any) => {
            if (
              event.source !== frame.contentWindow ||
              event.data !== "artifact-scroll-barrier"
            )
              return;
            win.removeEventListener("message", receive);
            resolve();
          };
          win.addEventListener("message", receive);
          frame.contentWindow.postMessage("artifact-scroll-barrier", "*");
        }),
    );
    expect(await content!.evaluate(() => (globalThis as any).scrollY)).toBe(0);
    await pane.locator(".pane-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await page.keyboard.press("j");
    await content!.waitForFunction(() => (globalThis as any).scrollY > 0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await frame.locator("#count").click();
    await page.keyboard.press("z");
    await fullscreen.waitFor();
    await frame.locator("#count").click();
    await page.keyboard.press("z");
    await fullscreen.waitFor({ state: "hidden" });
    await frame.locator("body").evaluate((body: any) => {
      const input = body.ownerDocument.createElement("input");
      input.id = "typing";
      body.append(input);
    });
    await frame.locator("#typing").fill("z");
    await frame.locator("#typing").press("z");
    expect(await frame.locator("#typing").inputValue()).toBe("zz");
    await page.evaluate(() => {
      (globalThis as any).postMessage({ recurseArtifactKey: "z" }, "*");
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const win = globalThis as any;
          const receive = (event: any) => {
            if (event.data !== "artifact-key-barrier") return;
            win.removeEventListener("message", receive);
            resolve();
          };
          win.addEventListener("message", receive);
          win.postMessage("artifact-key-barrier", "*");
        }),
    );
    expect(await fullscreen.count()).toBe(0);
    await frame.locator("#count").click();
    await page.keyboard.press("i");
    await page.waitForFunction(
      () => (globalThis as any).document.activeElement?.id === "input",
    );
    await frame.locator("#count").click();
    await page.keyboard.press("o");
    await page.locator("#pane-finder-query").waitFor();
    await page.keyboard.press("Escape");
    await frame.locator("#count").click();
    await page.keyboard.press("z");
    await fullscreen.waitFor();
    await frame.locator("#count").click();
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await context.close();
  },

  async function test_artifact_attention_survives_conversation_switch(
    browser,
    base,
  ) {
    const app = await postFixture(base, "seed-artifact-app");
    const context = await browser.newContext({
      viewport: { width: 412, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await gotoRoot(page, base);
    await page.locator(`a[href="#artifact=${app.id}"]`).click();
    await page
      .frameLocator("iframe.artifact-embed-page")
      .locator("body[data-ready]")
      .waitFor();
    await page
      .getByRole("button", { name: "Close Artifacts", exact: true })
      .click();
    const waitForArtifactList = async (id: string) => {
      const response = await page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/artifacts" &&
          url.searchParams.get("agent") === id
        );
      });
      if (!response.ok())
        throw new Error(`Artifact list failed: ${response.status()}`);
      await response.finished();
    };
    const switchTo = async (id: string) => {
      const read = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/conversations/${id}`,
      );
      await page.evaluate((agentId) => {
        (globalThis as any).location.hash = `agent=${agentId}`;
      }, id);
      await (await read).finished();
      const hash =
        id === rootAgentId()
          ? `#artifact=${app.id}`
          : `#agent=${rootAgentId()}&artifact=${app.id}`;
      await page.locator(`a[href="${hash}"]`).waitFor();
      // test-check-allow: T6 Closed-pane attention has no public post-list render signal during a visit; keep its existing bounded settle.
      await page.waitForTimeout(2000);
    };
    await Promise.all([
      waitForArtifactList("artifact-link-source"),
      switchTo("artifact-link-source"),
    ]);
    await switchTo(rootAgentId());
    if (process.env.ARTIFACT_ATTENTION_SHOTS)
      await page.screenshot({
        path: `${process.env.ARTIFACT_ATTENTION_SHOTS}/switch.png`,
      });
    expect(await page.locator("#pane-fab.attention").count()).toBe(0);
    expect(
      await page
        .locator('#pane-menu .pane-menu-item[data-pane="report"].attention')
        .count(),
    ).toBe(0);
    await switchTo("artifact-link-source");
    const revised = await postFixture(base, `revise-artifact-app?id=${app.id}`);
    expect(revised.version).not.toBe(app.version);
    await switchTo(rootAgentId());
    await page.locator("#pane-fab.attention").waitFor({ timeout: 25_000 });
    expect(await page.locator("#pane-fab").getAttribute("aria-label")).toBe(
      "More actions — Artifacts available",
    );
    expect(await page.locator("#pane-fab").getAttribute("title")).toBe(
      "More actions — Artifacts available",
    );
    expect(await page.locator("#pane-fab .badge").count()).toBe(0);
    expect(
      await page
        .locator('#pane-menu .pane-menu-item[data-pane="report"].attention')
        .count(),
    ).toBe(1);
    if (process.env.ARTIFACT_ATTENTION_SHOTS)
      await page.screenshot({
        path: `${process.env.ARTIFACT_ATTENTION_SHOTS}/new-version.png`,
      });
    await page.locator("#pane-fab").click();
    await page
      .locator('#pane-menu .pane-menu-item[data-pane="report"]')
      .click();
    await page
      .frameLocator("iframe.artifact-embed-page")
      .locator("body[data-ready]")
      .waitFor();
    expect(await page.locator("#pane-fab.attention").count()).toBe(0);
    await page
      .getByRole("button", { name: "Close Artifacts", exact: true })
      .click();
    await Promise.all([waitForArtifactList(rootAgentId()), page.reload()]);
    await page.locator(`a[href="#artifact=${app.id}"]`).waitFor();
    // test-check-allow: T6 Reload restores a closed pane with no public post-list attention-render signal; keep its existing bounded settle.
    await page.waitForTimeout(2000);
    expect(await page.locator("#pane-fab.attention").count()).toBe(0);
    expect(
      await page
        .locator('#pane-menu .pane-menu-item[data-pane="report"].attention')
        .count(),
    ).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  },

  async function test_artifact_reply_links(browser, base) {
    const app = await postFixture(base, "seed-artifact-app");
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
      });
      const page = await context.newPage();
      await gotoRoot(page, base);
      const link = page.locator(`a[href="#artifact=${app.id}"]`);
      await link.waitFor();
      expect(await link.getAttribute("target")).toBeNull();
      const stamp = await page.evaluate<number>("performance.timeOrigin");
      await link.click();
      await page
        .frameLocator("iframe.artifact-embed-page")
        .locator("body[data-ready]")
        .waitFor();
      expect(await page.locator("#artifact-picker").inputValue()).toBe(app.id);
      expect(context.pages().length).toBe(1);
      expect(await page.evaluate<number>("performance.timeOrigin")).toBe(stamp);
      if (width === 1280) {
        const pane = page.locator('.pane-col[data-pane="report"]');
        await pane.locator(".pane-body").focus();
        await page.keyboard.press("h");
        await pane.locator(".artifact-list").waitFor();
        await link.click();
        await pane.locator(".artifact-list").waitFor({ state: "detached" });
        await page.locator("#artifact-picker").waitFor();
        expect(
          await page.locator("iframe.artifact-embed-page").isVisible(),
        ).toBeTrue();
      }
      if (process.env.ARTIFACT_LINK_SHOTS)
        await page.screenshot({
          path: `${process.env.ARTIFACT_LINK_SHOTS}/${width}.png`,
        });
      await page.goto(`${base}#agent=artifact-link-source`);
      await page.locator("a", { hasText: "Shared" }).click();
      await page
        .frameLocator("iframe.artifact-embed-page")
        .locator("body[data-ready]")
        .waitFor();
      if (width === 1280) {
        await page.locator('.agent[data-id="artifact-link-source"]').click();
        expect(page.url()).not.toContain("artifact=");
        await page.goBack();
        await page
          .frameLocator("iframe.artifact-embed-page")
          .locator("body[data-ready]")
          .waitFor();
      }
      await page.goto(
        `${base}#agent=${rootAgentId()}&artifact=unknown-artifact`,
      );
      await page
        .locator(".artifact-notice", { hasText: "Artifact not found" })
        .waitFor();
      if (width === 390) {
        await page.goBack();
        await page.locator('.pane-col[data-pane="report"]').waitFor({
          state: "detached",
        });
        expect(await page.locator("#topbar").isVisible()).toBeTrue();
      }
      await context.close();
    }
  },

  // Regression: #3203 closed Artifact discovery must update availability without another metadata refresh.
  async function test_artifact_published_mid_session_becomes_reachable(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    let published = false;
    let nonemptyHeld = false;
    let metadataHeld = false;
    let releaseArtifacts = () => {};
    let releaseMetadata = () => {};
    const artifactsReady = new Promise<void>(
      (resolve) => (releaseArtifacts = resolve),
    );
    const metadataReady = new Promise<void>(
      (resolve) => (releaseMetadata = resolve),
    );
    await page.exposeFunction("artifactMetadataApplied", () => {
      if (metadataHeld) releaseArtifacts();
    });
    await page.addInitScript(() => {
      const browser = globalThis as any;
      const fetch = browser.fetch.bind(browser);
      browser.fetch = async (...args: any[]) => {
        const response = await fetch(...args);
        const url = new URL(response.url);
        if (
          url.pathname.startsWith("/api/conversations/") &&
          url.searchParams.get("focused") === "1"
        ) {
          const json = response.json.bind(response);
          response.json = async () => {
            const body = await json();
            browser.requestAnimationFrame(() =>
              browser.requestAnimationFrame(() =>
                browser.artifactMetadataApplied(),
              ),
            );
            return body;
          };
        }
        return response;
      };
    });
    await page.route(`${base}api/conversations/*?focused=1`, async (route) => {
      const selected = nonemptyHeld && !metadataHeld;
      if (selected) metadataHeld = true;
      const response = await route.fetch();
      if (metadataHeld && !selected) await metadataReady;
      await route.fulfill({ response });
    });
    await page.route(`${base}api/artifacts**`, async (route) => {
      const url = route.request().url();
      if (url.includes("/file"))
        return route.fulfill({
          body: "# Browser artifact\nVisible body.\n",
          contentType: "text/markdown; charset=utf-8",
        });
      if (url.includes("/versions"))
        return route.fulfill({
          json: [
            {
              version: ARTIFACT_VERSION,
              status: "ready",
              created_at: ARTIFACT.created_at,
            },
          ],
        });
      if (published) {
        nonemptyHeld = true;
        await page.keyboard.press("Shift");
        await artifactsReady;
      }
      return route.fulfill({ json: published ? [ARTIFACT] : [] });
    });
    try {
      const emptyArtifacts = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/artifacts",
      );
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      const entry = page.locator(
        '#pane-menu .pane-menu-item[data-pane="report"]',
      );
      await (await emptyArtifacts).finished();
      await entry.waitFor({ state: "detached" });
      expect(await entry.count()).toBe(0);
      published = true;
      await entry.waitFor({ state: "attached", timeout: 25_000 });
      await page.locator("#pane-fab").click();
      await entry.click();
      await page.locator(".report-doc").waitFor();
      expect(errors).toEqual([]);
    } finally {
      releaseArtifacts();
      releaseMetadata();
      await page.unrouteAll({ behavior: "wait" });
      await context.close();
    }
  },
  async function test_artifact_comment_preserves_reader_scroll(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const paragraphs = Array.from(
      { length: 80 },
      (_, i) => `Paragraph ${i}: long artifact body.`,
    );
    paragraphs.splice(40, 0, "Reader anchor");
    await routeArtifacts(
      page,
      base,
      `# Browser artifact\n\n${paragraphs.join("\n\n")}`,
    );
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.locator("#pane-fab").click();
    await page.locator('.pane-menu-item[data-pane="report"]').click();
    await page
      .locator(".report-doc p", { hasText: "Reader anchor" })
      .scrollIntoViewIfNeeded();
    await page.evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const paneBody = page.locator('.pane-col[data-pane="report"]');
    const readerScroll = await paneBody.evaluate(
      (element) =>
        (globalThis as any).getComputedStyle(element) &&
        (element as any).scrollTop,
    );
    expect(readerScroll).toBeGreaterThan(0);
    await dispatchArtifactSelection(page, "touch", "Reader anchor");
    await page.waitForFunction(
      "getSelection()?.toString() === 'Reader anchor'",
    );
    const popover = page.locator(".report-comment-popover:not([hidden])");
    await popover.waitFor();
    await popover.locator("textarea").fill("keep my place");
    await popover.locator(".report-comment-popover-submit").click();
    await page.waitForFunction(
      "document.activeElement?.classList.contains('report-comment-input')",
    );
    expect(
      Math.abs(
        (await paneBody.evaluate((element) => (element as any).scrollTop)) -
          readerScroll,
      ),
    ).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2351 artifact comment send bar floated 14px above the desktop pane bottom
  async function test_artifact_send_bar_meets_pane_bottom(browser, base) {
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i}: long artifact body.`,
    );
    for (const phone of [false, true]) {
      const context = await browser.newContext({
        viewport: phone
          ? { width: 390, height: 844 }
          : { width: 1280, height: 800 },
        isMobile: phone,
        hasTouch: phone,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      await routeArtifacts(
        page,
        base,
        `# Browser artifact\nVisible body.\n\n${paragraphs.join("\n\n")}`,
      );
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.evaluate((id) => {
        (globalThis as any).location.hash = `artifact=${id}`;
      }, ARTIFACT.id);
      const pane = page.locator('.pane-col[data-pane="report"]');
      await pane.locator(".report-doc", { hasText: "Visible body" }).waitFor();
      await dispatchArtifactSelection(page, phone ? "touch" : "mouse");
      const popover = page.locator(".report-comment-popover:not([hidden])");
      await popover.waitFor();
      await popover.locator("textarea").fill("bar placement");
      await popover.locator(".report-comment-popover-submit").click();
      const bar = page.locator(".report-sendbar.on");
      await bar.waitFor();
      await pane
        .locator(".report-doc p", { hasText: "Paragraph 30:" })
        .scrollIntoViewIfNeeded();
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const [paneBox, barBox] = await Promise.all([
        pane.boundingBox(),
        bar.boundingBox(),
      ]);
      expect(
        Math.abs(barBox!.y + barBox!.height - (paneBox!.y + paneBox!.height)),
      ).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
      await context.close();
    }
  },
  // Regression: #3247 refresh must not reopen a submitted pane over comment retry controls.
  async function test_artifact_comment_pointer_flow(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    const submissions: any[] = [];
    let attempts = 0;
    await page.route(
      `${base}api/conversations/${rootAgentId()}/deliver`,
      (route) => {
        attempts++;
        submissions.push(route.request().postDataJSON());
        if (attempts === 1 || attempts === 3)
          return route.fulfill({ status: 500, json: { detail: "retry" } });
        return route.fulfill({ json: { steer: false } });
      },
    );
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page
      .locator('#dock .dv-tab[data-dock-panel="report"] button')
      .click();
    await page
      .locator('.pane-col[data-pane="report"]')
      .waitFor({ state: "detached" });
    await page.locator('.rail-btn[data-pane="tips"]').click();
    await page.locator('.rail-btn[data-pane="report"]').click();
    await page.locator('.pane-col[data-pane="report"] .report-doc').waitFor();
    await page.locator(".report-doc", { hasText: "Visible body" }).waitFor();
    await dispatchArtifactSelection(page, "touch");
    let popover = page.locator(".report-comment-popover:not([hidden])");
    await popover.waitFor();
    await popover.locator("textarea").fill("draft survives tap");
    const caret = await popover
      .locator("textarea")
      .evaluate((node: any) => [node.selectionStart, node.selectionEnd]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator(".pane-col").count()).toBe(1);
    expect(
      await page.locator(".pane-col.mobile-active").getAttribute("data-pane"),
    ).toBe("report");
    expect(await popover.locator("textarea").inputValue()).toBe(
      "draft survives tap",
    );
    expect(
      await popover
        .locator("textarea")
        .evaluate((node: any) => node.ownerDocument.activeElement === node),
    ).toBeTrue();
    expect(
      await popover
        .locator("textarea")
        .evaluate((node: any) => [node.selectionStart, node.selectionEnd]),
    ).toEqual(caret);
    await dispatchArtifactTap(page, "touch");
    expect(await popover.isVisible()).toBeTrue();
    expect(await popover.locator("textarea").inputValue()).toBe(
      "draft survives tap",
    );
    await page.locator(".report-comment-popover-cancel").click();
    expect(await page.locator(".report-comment").count()).toBe(0);
    await dispatchArtifactSelection(page, "touch");
    await page.locator(".report-comment-popover:not([hidden])").waitFor();
    await page.locator(".report-comment-popover textarea").fill("first note");
    await page.locator(".report-comment-popover-submit").click();
    expect(await page.locator(".report-comment").count()).toBe(1);
    await page.waitForFunction(
      "document.activeElement?.classList.contains('report-comment-input') && !getSelection()?.toString()",
    );
    await dispatchArtifactSelection(page, "touch", "Browser artifact");
    const stagedPopover = page.locator(".report-comment-popover:not([hidden])");
    await stagedPopover.waitFor();
    await stagedPopover.locator("textarea").fill("draft with staged comment");
    await dispatchArtifactTap(page, "touch");
    expect(await page.locator(".report-comment").count()).toBe(1);
    expect(await stagedPopover.locator("textarea").inputValue()).toBe(
      "draft with staged comment",
    );
    await page.locator(".report-comment-popover-cancel").click();
    await dispatchArtifactSelection(page, "touch", "Browser artifact");
    await page.locator(".report-comment-popover:not([hidden])").waitFor();
    await page.locator(".report-comment-popover textarea").fill("second note");
    await page.locator(".report-comment-popover-submit").click();
    expect(await page.locator(".report-comment").count()).toBe(2);
    await page.locator(".report-sendbar-send").click();
    const pending = page.locator("[data-comment-send]");
    const failure = pending.getByRole("alert");
    await failure.waitFor();
    expect(await pending.textContent()).toContain("first note");
    expect(await pending.textContent()).toContain("second note");
    await failure.getByRole("button", { name: "Retry" }).click();
    await pending.waitFor({ state: "detached" });
    expect(submissions.length).toBe(2);
    expect(submissions[1].client_message_id).toBe(
      submissions[0].client_message_id,
    );
    const payload = String(submissions[0].content);
    expect(payload).toContain(ARTIFACT.title);
    expect(payload).toContain(ARTIFACT.id);
    expect(payload).toContain(ARTIFACT_VERSION);
    expect(payload).toContain(
      `$CHAT_DATA_DIR/artifact_repos/${rootAgentId()}/${ARTIFACT.id}`,
    );
    expect(payload).toContain("first note");
    expect(payload).toContain("second note");
    await page.locator("#pane-fab").click();
    await page.locator('.pane-menu-item[data-pane="report"]').click();
    await page.locator('.pane-col[data-pane="report"] .report-doc').waitFor();
    await dispatchArtifactSelection(page, "touch");
    await page
      .locator(".report-comment-popover:not([hidden]) textarea")
      .fill("Discard this note");
    await page.locator(".report-comment-popover-submit").click();
    await page.locator(".report-sendbar-send").click();
    const refreshed = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/conversations/${rootAgentId()}`,
    );
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await (await refreshed).finished();
    const discarded = page.locator("[data-comment-send]");
    page.once("dialog", (dialog) => void dialog.accept());
    await discarded.getByRole("button", { name: "Discard" }).click();
    await discarded.waitFor({ state: "detached" });
    expect(attempts).toBe(3);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_compact_artifact_header(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    const picker = page.locator("#artifact-picker.artifact-title-select");
    await page
      .locator(".pane-powerbar-controls:not([inert]) #artifact-picker")
      .waitFor();
    await visibleAndUncovered(page, "#artifact-picker.artifact-title-select");
    expect(await picker.inputValue()).toBe(ARTIFACT.id);
    expect(await picker.innerText()).toContain("Browser artifact");
    await visibleAndUncovered(page, ".artifact-version-btn");
    expect(
      await page
        .locator('.artifact-version-btn[aria-label="Version history"]')
        .count(),
    ).toBe(1);
    const download = page.locator("a.artifact-download.artifact-icon-btn");
    await visibleAndUncovered(page, "a.artifact-download.artifact-icon-btn");
    expect(await download.getAttribute("aria-label")).toStartWith(
      "Download original",
    );
    expect(await download.getAttribute("download")).not.toBeNull();
    expect(await page.locator(".report-doc").innerText()).toContain(
      "Visible body",
    );
    for (const gone of [
      ".artifact-summary",
      ".artifact-controls",
      ".artifact-status",
      ".artifact-kind",
      ".artifact-history",
    ])
      expect(await page.locator(gone).count()).toBe(0);
    expect(
      await page.getByText("Download original", { exact: true }).count(),
    ).toBe(0);
    await assertArtifactVersionMenuEscape(page);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_artifact_delete_flow(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const nextVersion = "e".repeat(40);
    const other = {
      ...ARTIFACT,
      id: "other-browser-artifact",
      title: "Other artifact",
      version: "f".repeat(40),
    };
    let currentVersion = ARTIFACT_VERSION;
    let deleted = false;
    const deleteBodies: any[] = [];
    const pendingRoutes: any[] = [];
    await page.route(`${base}api/artifacts**`, (route) => {
      const request = route.request();
      const url = request.url();
      if (request.method() === "DELETE") {
        deleteBodies.push(request.postDataJSON());
        if (deleteBodies.length === 1) {
          currentVersion = nextVersion;
          return route.fulfill({
            status: 409,
            json: {
              detail:
                "artifact changed; refresh and retry with the current version",
            },
          });
        }
        pendingRoutes.push(route);
        return;
      }
      if (url.includes("/file"))
        return route.fulfill({
          body: url.includes(other.id)
            ? "# Other artifact\nOther body.\n"
            : "# Browser artifact\nVisible body.\n",
          contentType: "text/markdown; charset=utf-8",
        });
      if (url.includes("/versions")) return route.fulfill({ json: [] });
      return route.fulfill({
        json: deleted
          ? [other]
          : [{ ...ARTIFACT, version: currentVersion }, other],
      });
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.locator(".report-doc", { hasText: "Visible body" }).waitFor();
    const dialogMessages: string[] = [];
    page.once("dialog", (dialog) => {
      dialogMessages.push(dialog.message());
      void dialog.accept();
    });
    await page.locator(".artifact-delete-btn").click();
    await page
      .locator(".artifact-notice.error", { hasText: "artifact changed" })
      .waitFor();
    expect(dialogMessages[0]).toContain("Browser artifact");
    expect(deleteBodies[0].expected_version).toBe(ARTIFACT_VERSION);
    expect(await page.locator("#artifact-picker").inputValue()).toBe(
      ARTIFACT.id,
    );
    await page.waitForFunction(
      "document.activeElement?.classList.contains('artifact-delete-btn')",
    );
    page.once("dialog", (dialog) => void dialog.accept());
    const request = page.waitForRequest((r) => r.method() === "DELETE");
    await page.locator(".artifact-delete-btn").click();
    await request;
    await page.locator(".artifact-notice", { hasText: "Deleting" }).waitFor();
    expect(await page.locator(".artifact-delete-btn").isDisabled()).toBeTrue();
    expect(deleteBodies.at(-1).expected_version).toBe(nextVersion);
    expect(pendingRoutes.length).toBe(1);
    deleted = true;
    await pendingRoutes[0].fulfill({
      json: {
        id: ARTIFACT.id,
        title: ARTIFACT.title,
        owner_agent_id: rootAgentId(),
        version: nextVersion,
        deletion_id: "1".repeat(40),
        deleted: true,
        already_deleted: false,
        notification_pending: false,
      },
    });
    await page.locator(".report-doc", { hasText: "Other body" }).waitFor();
    expect(await page.locator("#artifact-picker").inputValue()).toBe(other.id);
    expect(await page.locator("#artifact-picker").isDisabled()).toBeTrue();
    await page.waitForFunction(
      "document.activeElement?.classList.contains('pane-title')",
    );
    expect(await page.locator(".report-comment-input").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_svg_artifact_asset(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    await page.goto(`${base}#agent=${rootAgentId()}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator(".agent").first().waitFor();
    await page.locator('.pane-col[data-pane="report"]').waitFor();
    const expected = [`agent=${rootAgentId()}`, `version=${ARTIFACT_VERSION}`];
    await page.waitForFunction(
      "document.querySelector('.report-doc img[src*=\\\"chart.svg\\\"]')?.naturalWidth === 10",
    );
    const src = String(
      await page
        .locator('.report-doc img[src*="chart.svg"]')
        .getAttribute("src"),
    );
    expect(src.includes(expected[0]) && src.includes(expected[1])).toBeTrue();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Feature: #2323 a theme change refreshes the sandboxed page without rebuilding.
  async function test_published_app_runs_in_the_pane(browser, base, data) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const app = await postFixture(base, "seed-artifact-app");
    await gotoRoot(page, base);
    await page.locator('.pane-col[data-pane="report"]').waitFor();
    expect(await page.locator("#artifact-picker").inputValue()).toBe(app.id);
    const frame = page.frameLocator("iframe.artifact-embed-page");
    const ready = () => frame.locator("body[data-ready]").waitFor();
    const reload = async () => {
      await frame
        .locator("body")
        .evaluate((body: any) => delete body.dataset.ready);
      await page.locator(".artifact-errors-reload").click();
    };
    await ready();
    const button = frame.locator("#count");
    await button.click();
    await frame.locator("#count", { hasText: "1" }).waitFor();
    expect(
      await button.evaluate(
        (el: any) => (globalThis as any).getComputedStyle(el).color,
      ),
    ).toBe("rgb(0, 128, 0)");
    const [accent, bg] = await themeColors(page, "var(--accent)", "var(--bg)");
    expect(
      await button.evaluate(
        (el: any) => (globalThis as any).getComputedStyle(el).borderTopColor,
      ),
    ).toBe(accent);
    expect(
      await frame
        .locator("body")
        .evaluate(
          (el: any) => (globalThis as any).getComputedStyle(el).backgroundColor,
        ),
    ).toBe(bg);
    const appMono = await page.evaluate(() => {
      const browser = globalThis as any;
      const probe = browser.document.createElement("span");
      probe.style.fontFamily = "var(--font-mono)";
      browser.document.body.append(probe);
      const family = browser.getComputedStyle(probe).fontFamily as string;
      probe.remove();
      return family;
    });
    expect(appMono).toContain("monospace");
    expect(
      await frame.locator("body").evaluate((body: any) => {
        const code = body.ownerDocument.createElement("code");
        body.append(code);
        const view = body.ownerDocument.defaultView;
        const family = view.getComputedStyle(code).fontFamily as string;
        code.remove();
        return family;
      }),
    ).toBe(appMono);
    const sandbox = await page
      .locator("iframe.artifact-embed-page")
      .getAttribute("sandbox");
    const themePath = join(data, "data/config/themes.json");
    try {
      for (const theme of ["GitHub Light", "Ocean"]) {
        const reloaded = page.waitForResponse((response) =>
          response.url().includes(`/api/artifacts/${app.id}/page`),
        );
        await writeFile(themePath, JSON.stringify({ theme }));
        await reloaded;
        await ready();
        const [background] = await themeColors(page, "var(--bg)");
        expect(
          await frame
            .locator("body")
            .evaluate(
              (el: any) =>
                (globalThis as any).getComputedStyle(el).backgroundColor,
            ),
        ).toBe(background);
        expect(
          await page
            .locator("iframe.artifact-embed-page")
            .getAttribute("sandbox"),
        ).toBe(sandbox);
        expect(await button.textContent()).toBe("0");
      }
    } finally {
      const reloaded = page.waitForResponse((response) =>
        response.url().includes(`/api/artifacts/${app.id}/page`),
      );
      await rm(themePath, { force: true });
      await reloaded;
      await ready();
    }
    expect(
      await frame.locator("img").evaluate((img: any) => img.naturalWidth),
    ).toBe(1);
    expect(await button.evaluate(() => (globalThis as any).origin)).toBe(
      "null",
    );
    const appError = "TypeError: the chart data is null";
    await page.evaluate(() =>
      (globalThis as any).postMessage({ recurseArtifactError: "forged" }, "*"),
    );
    const strip = page.locator(".artifact-errors");
    expect(await strip.isHidden()).toBeTrue();
    await frame.locator("#boom").click();
    await strip.locator("li", { hasText: appError }).waitFor();
    expect(await strip.locator("li").allTextContents()).toEqual([appError]);
    expect(await strip.locator("strong").textContent()).toBe(
      "The page raised an error",
    );
    const delivered: { url: string; content: string }[] = [];
    let hold = false;
    let release = () => {};
    await page.route("**/api/conversations/*/deliver", async (route) => {
      delivered.push({
        url: route.request().url(),
        content: route.request().postDataJSON().content,
      });
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: {} });
    });
    const sendButton = strip.locator(".artifact-errors-send");
    const finishHeldSend = async () => {
      const done = page.waitForResponse((r) => r.url().endsWith("/deliver"));
      release();
      await done;
      await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    };
    await sendButton.click();
    await strip.getByRole("button", { name: "Sent" }).waitFor();
    expect(delivered.length).toBe(1);
    expect(delivered[0].url).toEndWith(
      `/api/conversations/${app.owner}/deliver`,
    );
    expect(delivered[0].content).toContain(`(id: ${app.id}, version: `);
    expect(delivered[0].content).toContain(`\n- ${appError}\n`);
    expect(delivered[0].content).toContain(
      `$CHAT_DATA_DIR/artifact_repos/${app.owner}/${app.id}`,
    );
    expect(delivered[0].content).toContain(
      "git commit to publish and rerun the app check",
    );
    const laterError = "Error: a later error";
    const raiseLater = () =>
      frame.locator("body").evaluate(() => {
        setTimeout(() => {
          throw new Error("a later error");
        });
      });
    hold = true;
    await reload();
    expect(await strip.isHidden()).toBeTrue();
    await frame.locator("#count", { hasText: "0" }).waitFor();
    await ready();
    await frame.locator("#boom").click();
    await strip.locator("li", { hasText: appError }).waitFor();
    await sendButton.click();
    await strip.getByRole("button", { name: "Sending…" }).waitFor();
    await raiseLater();
    await strip.locator("li", { hasText: laterError }).waitFor();
    await finishHeldSend();
    expect(delivered[1].content).not.toContain(laterError);
    expect(await sendButton.textContent()).toContain("Send to agent");
    expect(await sendButton.isEnabled()).toBeTrue();
    await sendButton.click();
    await strip.getByRole("button", { name: "Sending…" }).waitFor();
    await reload();
    expect(await strip.isHidden()).toBeTrue();
    await ready();
    await frame.locator("#boom").click();
    await strip.locator("li", { hasText: appError }).waitFor();
    await finishHeldSend();
    expect(await sendButton.textContent()).toContain("Send to agent");
    expect(await sendButton.isEnabled()).toBeTrue();
    expect(
      errors.filter(
        (error) => !error.includes(appError) && !error.includes(laterError),
      ),
    ).toEqual([]);
  },
];

if (import.meta.main) await runBrowserTests([["panes-artifacts", tests]]);
