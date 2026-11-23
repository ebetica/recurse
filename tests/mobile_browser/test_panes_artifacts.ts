import { expect } from "bun:test";
import { assertDocumentLinks } from "./document_links";
import { REFERENCE_LINKS } from "./fixtures/reference_links";
import {
  ARTIFACT,
  ARTIFACT_VERSION,
  assertArtifactVersionMenuEscape,
  dispatchArtifactSelection,
  gotoRoot,
  openPage,
  postFixture,
  rootAgentId,
  routeArtifacts,
  runBrowserTests,
  screenshot,
  stageArtifactComment,
  themeColors,
  visibleAndUncovered,
  type BrowserTest,
} from "./common";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import { artifactReopen } from "./artifact_reopen";
import { artifactLinks } from "./artifact_links";

export const tests: BrowserTest[] = [
  // Regression: #3200 staging a selection comment cannot override a later viewer focus change.
  async function test_artifact_reload_selection_and_content(
    browser,
    base,
    data,
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
      const {
        context: browserContext,
        page,
        errors,
      } = await openPage(browser, {
        viewport: { width: phone ? 390 : 1280, height: 800 },
        touch: phone,
        permissions: ["clipboard-read", "clipboard-write"],
      });
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
        try {
          await requested;
          await page
            .getByRole("tab", { name: "Artifacts", selected: true })
            .waitFor();
          expect(
            await page
              .getByRole("heading", { name: "Second initial", exact: true })
              .count(),
          ).toBe(0);
          expect(files).toEqual([]);
        } finally {
          release();
        }
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
        expect(
          await pane.locator(".report-doc h1 ins.doc-diff-added").textContent(),
        ).toBe("updated");
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
        expect(
          await pane
            .locator(".report-comment .report-comment-quote")
            .textContent(),
        ).toBe("Second updated");
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
            expect(
              await pane
                .locator(".report-comment .report-comment-quote")
                .textContent(),
            ).toBe("Second updated");
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
        await page.keyboard.press("Enter");
        await pane
          .getByRole("heading", { name: "Second updated", exact: true })
          .waitFor();
        await stageArtifactComment(
          page,
          "mouse",
          "Second updated",
          "Heading anchor",
        );
        expect(
          await pane
            .locator(".report-comment .report-comment-quote")
            .textContent(),
        ).toBe("Second updated");
        const delivered = page.waitForRequest((request) =>
          request.url().endsWith(`/api/conversations/${owner}/deliver`),
        );
        await pane.getByRole("button", { name: "Submit comments" }).click();
        expect((await delivered).postDataJSON().content).toEndWith(
          "- line 1, chars 0-14:\n> Second updated\nHeading anchor",
        );
        await pane.locator(".report-comment").waitFor({ state: "detached" });
        await body.focus();
        await page.keyboard.press("h");
        await pane.locator(".artifact-list").waitFor();
        await page.keyboard.press("j");
      } else {
        expect(await pane.locator(".artifact-list").count()).toBe(0);
        expect(
          await pane.locator(".artifact-browse-btn").isVisible(),
        ).toBeFalse();
      }
      await screenshot(
        page,
        `panes-artifacts/${phone ? 390 : 1280}-artifacts-navigation`,
      );
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
  },
  artifactReopen,
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
      await screenshot(page, `panes-artifacts/figure/${width}`, {
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

  // Regression: #2365 pane keys must work after clicking sandboxed Artifact content.
  async function test_artifact_frame_pane_hotkeys(browser, base) {
    const app = await postFixture(base, "seed-artifact-app");
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
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
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 412, height: 844 },
      touch: true,
    });
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
    await screenshot(page, "panes-artifacts/attention/switch");
    expect(await page.locator("#pane-fab.attention").count()).toBe(0);
    expect(
      await page
        .locator('#pane-menu .pane-menu-item[data-pane="report"].attention')
        .count(),
    ).toBe(0);
    await switchTo("artifact-link-source");
    const next = await postFixture(base, "revise-artifact-app", { id: app.id });
    expect(next.version).not.toBe(app.version);
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
    await screenshot(page, "panes-artifacts/attention/new-version");
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
      const { context, page } = await openPage(browser, {
        viewport: { width, height: 844 },
      });
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
      await screenshot(page, `panes-artifacts/links/${width}`);
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

  async function test_compact_artifact_header(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    await routeArtifacts(page, base);
    await page.goto(`${base}#agent=${rootAgentId()}&artifact=${ARTIFACT.id}`);
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
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
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
    await page.goto(`${base}#agent=${rootAgentId()}&artifact=${ARTIFACT.id}`);
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
  // Regression: #3307 Artifact Markdown omits unnecessary link labels.
  async function test_svg_artifact_asset(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    await routeArtifacts(
      page,
      base,
      `# Browser artifact\n\n${REFERENCE_LINKS}\n![SVG chart](chart.svg)\n`,
    );
    await page.goto(`${base}#agent=${rootAgentId()}&artifact=${ARTIFACT.id}`, {
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
    await assertDocumentLinks(page.locator(".report-doc .artifact-markdown"));
    expect(errors).toEqual([]);
    await context.close();
  },
  artifactLinks,
  // Feature: #2323 a theme change refreshes the sandboxed page without rebuilding.
  async function test_published_app_runs_in_the_pane(browser, base, data) {
    const { page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    const app = await postFixture(base, "seed-artifact-app");
    await page.goto(`${base}#agent=${rootAgentId()}&artifact=${app.id}`);
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
      await mkdir(join(data, "data/config"), { recursive: true });
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
