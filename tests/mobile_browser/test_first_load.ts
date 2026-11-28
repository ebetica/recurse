import { expect } from "bun:test";
import { cp, mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  ROOT,
  assertArtifactVersionMenuEscape,
  checkedTap,
  closeWithRoutes,
  expectHitCorners,
  gotoRoot,
  mockConversation,
  openPage,
  routeArtifacts,
  screenshot,
  startServer,
  stopServer,
  turn,
  visibleAndUncovered,
  waitForLayout,
  type BrowserTest,
} from "./common";

async function assertDraftSurvivesSelection(
  browser: Browser,
  base: string,
  before: "boot" | "first-tree",
): Promise<void> {
  const page = await browser.newPage();
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    before === "boot" ? "**/static/app.js?*" : "**/api/tree",
    async (route) => {
      await held;
      await route.continue();
    },
  );
  try {
    if (before === "boot") await page.goto(base, { waitUntil: "commit" });
    else await gotoRoot(page, base);
    await page.locator("#input").fill("Composer draft survives refresh");
    release();
    await page.locator(".agent.selected").waitFor();
    expect(await page.locator("#input").inputValue()).toBe(
      "Composer draft survives refresh",
    );
    expect(await page.locator("#send").isEnabled()).toBeTrue();
  } finally {
    release();
    await page.close();
  }
}

export const tests: BrowserTest[] = [
  // Regression: #3182 A stale desktop windows import must offer recovery without losing unsent work.
  async function test_reload_after_windows_chunk_is_removed(
    browser,
    _base,
    data,
  ) {
    const frontendRoot = join(data, "browser-build");
    const web = join(frontendRoot, "web");
    await mkdir(web, { recursive: true });
    for (const name of ["index.html", "icons.ts", "dist"])
      await cp(join(ROOT, "web", name), join(web, name), { recursive: true });
    const server = await startServer({ frontendRoot });
    let context: BrowserContext | undefined;
    try {
      const opened = await openPage(browser, {
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      context = opened.context;
      const { page } = opened;
      await page.goto(`${server.base}#agent=${server.root}`);
      await browserExpect(page.locator("#pane-fab")).toBeVisible();
      const input = page.locator("#input");
      const draft = "Keep this unsent while the browser build changes";
      await input.fill(draft);
      const servedVersion = await page
        .locator("body")
        .getAttribute("data-version");
      const preload = await page
        .locator('link[rel="modulepreload"]')
        .getAttribute("href");
      const oldChunk = basename(new URL(preload!, server.base).pathname);
      const newChunk = `host-${Bun.hash(oldChunk).toString(36)}.js`;
      const dist = join(web, "dist");
      const entry = join(dist, "app.js");
      await rename(join(dist, oldChunk), join(dist, newChunk));
      await Bun.write(
        `${entry}.next`,
        (await Bun.file(entry).text()).replaceAll(
          `./${oldChunk}`,
          `./${newChunk}`,
        ),
      );
      await rename(`${entry}.next`, entry);
      await browserExpect
        .poll(async () => {
          const response = await page.request.get(`${server.base}api/version`);
          return ((await response.json()) as { version: string }).version;
        })
        .not.toBe(servedVersion);
      const response = page.waitForResponse(
        (res) => res.url() === new URL(preload!, server.base).href,
      );
      await page.setViewportSize({ width: 1190, height: 844 });
      expect((await response).status()).toBe(404);
      const reload = page.getByRole("button", { name: "Reload page" });
      await browserExpect(reload).toBeVisible();
      await browserExpect(reload).toBeEnabled();
      await expectHitCorners(reload);
      await screenshot(page, "window-load-error");
      await checkedTap(reload);
      await browserExpect(
        page
          .getByRole("status")
          .filter({ hasText: "Send or clear unsent work" }),
      ).toBeVisible();
      await browserExpect(input).toHaveValue(draft);
      await input.clear();
      await checkedTap(reload);
      const open = page.getByRole("button", {
        name: "Open fullscreen",
        exact: true,
      });
      await browserExpect(open).toBeVisible();
      await checkedTap(open);
      await browserExpect(page.locator("#main.fullscreen")).toBeVisible();
      const exit = page.getByRole("button", {
        name: "Exit fullscreen",
        exact: true,
      });
      await checkedTap(exit);
      await browserExpect(open).toBeVisible();
    } finally {
      try {
        await context?.close();
      } finally {
        await stopServer(server);
      }
    }
  },
  // Regression: #2505 #3269 the sidebar, fonts and desktop Chat window are ready before the first visible Chat frame.
  async function test_fresh_mobile_and_desktop(browser, base) {
    for (const [name, viewport, touch] of [
      ["phone", { width: 390, height: 844 }, true],
      ["desktop", { width: 1280, height: 800 }, false],
    ] as const) {
      const { context, page, errors } = await openPage(browser, {
        viewport,
        touch,
      });
      if (name === "desktop")
        await page.addInitScript(() => {
          const browser = globalThis as any;
          browser.__chatWidths = [];
          const sample = () => {
            const main = browser.document.querySelector("#main");
            if (main?.checkVisibility({ visibilityProperty: true }))
              browser.__chatWidths.push(main.getBoundingClientRect().width);
            if (!browser.__chatSettled) browser.requestAnimationFrame(painted);
          };
          const painted = () => {
            const channel = new browser.MessageChannel();
            channel.port1.onmessage = sample;
            channel.port2.postMessage(0);
          };
          browser.requestAnimationFrame(painted);
        });
      await routeArtifacts(page, base);
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.evaluate(async () => {
        await (globalThis as any).document.fonts.ready;
      });
      await waitForLayout(page);
      if (name === "desktop") {
        const chat = await page.evaluate(() => {
          const browser = globalThis as any;
          browser.__chatSettled = true;
          return {
            narrowest: Math.min(...browser.__chatWidths),
            settled: browser.document
              .querySelector("#main")
              .getBoundingClientRect().width,
          };
        });
        expect(chat.narrowest).toBeGreaterThanOrEqual(chat.settled - 1);
      }
      await page.waitForFunction(
        "!document.querySelector('#thread-loading').classList.contains('on') && !document.querySelector('#messages').classList.contains('stale')",
      );
      await visibleAndUncovered(page, "#conv-title");
      await visibleAndUncovered(page, "#messages");
      await visibleAndUncovered(page, "#input");
      await page.locator("#input").fill("hello stays visible");
      await visibleAndUncovered(page, "#input");
      expect(await page.locator("#input").inputValue()).toBe(
        "hello stays visible",
      );
      if (name === "desktop") {
        const imageBytes = Buffer.from(
          "89504e470d0a1a0a7175657565642d696d6167652d65786163742d6279746573",
          "hex",
        );
        await page.evaluate(() => {
          const browser = globalThis as any;
          const realFetch = browser.fetch.bind(browser);
          browser.fetch = (input: any, init: any) => {
            const url = typeof input === "string" ? input : input.url;
            if (url === "/api/attachments")
              return new browser.Promise((resolve: any) => {
                const file = init.body.get("file");
                file.arrayBuffer().then((buffer: ArrayBuffer) => {
                  browser.__uploadedAttachment = {
                    name: file.name,
                    type: file.type,
                    bytes: Array.from(new browser.Uint8Array(buffer)),
                  };
                });
                browser.__releaseAttachmentUpload = () =>
                  resolve(
                    new browser.Response(
                      JSON.stringify({
                        id: "queued-image.png",
                        url: "/api/attachments/queued-image.png",
                        filename: "queued-image.png",
                        is_image: true,
                      }),
                      {
                        status: 200,
                        headers: { "Content-Type": "application/json" },
                      },
                    ),
                  );
              });
            return realFetch(input, init);
          };
        });
        await page.locator("#file-input").setInputFiles({
          name: "queued-image.png",
          mimeType: "image/png",
          buffer: imageBytes,
        });
        await page.waitForFunction("document.querySelector('#send').disabled");
        await page.locator("#input").fill("");
        expect(await page.locator("#send").getAttribute("aria-label")).toBe(
          "Send message",
        );
        expect(await page.locator("#send.stop").count()).toBe(0);
        await page.waitForFunction("window.__uploadedAttachment");
        expect(
          await page.evaluate(() => (globalThis as any).__uploadedAttachment),
        ).toEqual({
          name: "queued-image.png",
          type: "image/png",
          bytes: Array.from(imageBytes),
        });
        expect(
          await page.locator(".attach-chip.uploading img").getAttribute("alt"),
        ).toBe("queued-image.png");
        await page.evaluate("window.__releaseAttachmentUpload() ");
        await page.waitForFunction("!document.querySelector('#send').disabled");
        expect(
          await page
            .locator(".attach-chip:not(.uploading) img")
            .getAttribute("src"),
        ).toBe("/api/attachments/queued-image.png");
      } else {
        expect(await page.locator("#panes").isVisible()).toBeFalse();
        expect(await page.locator("#pane-fab.attention").count()).toBe(0);
        expect(await page.locator("#pane-fab").isVisible()).toBeTrue();
        await page.locator("#input").blur();
        const trigger = await page.locator("#pane-fab").evaluate((element) => {
          const browser = globalThis as any;
          const rect = element.getBoundingClientRect();
          const style = browser.getComputedStyle(element);
          const box = browser.document
            .querySelector("#new-top")
            .getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            padding: style.padding,
            borderWidth: style.borderWidth,
            background: style.backgroundColor,
            boxRight: box.right,
            label: element.getAttribute("aria-label"),
            hasPopup: element.getAttribute("aria-haspopup"),
          };
        });
        expect(trigger.width).toBeGreaterThanOrEqual(44);
        expect(trigger.height).toBeGreaterThanOrEqual(44);
        expect(trigger.padding).toBe("0px");
        expect(trigger.borderWidth).toBe("0px");
        expect(trigger.background).toBe("rgba(0, 0, 0, 0)");
        expect(trigger.boxRight).toBeLessThanOrEqual(trigger.left);
        expect(trigger.right).toBeLessThanOrEqual(viewport.width);
        expect(trigger.label).toBe("More actions");
        expect(trigger.hasPopup).toBe("menu");
        await page.locator("#pane-fab").focus();
        expect(
          await page.locator("#pane-fab").evaluate((element) => {
            const browser = globalThis as any;
            return {
              width: browser.getComputedStyle(element).outlineWidth,
              style: browser.getComputedStyle(element).outlineStyle,
            };
          }),
        ).toEqual({ width: "2px", style: "solid" });
        await page.locator("#menu-btn").click();
        await page.waitForFunction(
          "document.querySelector('.agent')?.getBoundingClientRect().left >= 0",
        );
        await visibleAndUncovered(page, ".agent");
        await page.locator(".agent").first().click();
        await page.waitForFunction(
          "!document.querySelector('#sidebar')?.classList.contains('open')",
        );
        await page.locator("#pane-fab").click();
        expect(
          await page.locator("#pane-fab").getAttribute("aria-expanded"),
        ).toBe("true");
        const menuFits = () =>
          page.locator("#pane-menu").evaluate((menu) => {
            const document = menu.ownerDocument;
            const box = menu.getBoundingClientRect();
            const rows = [...menu.querySelectorAll(".pane-menu-item")].filter(
              (row: any) => row.getBoundingClientRect().height > 0,
            );
            return {
              inside:
                box.left >= 0 &&
                box.top >= 0 &&
                box.right <= document.documentElement.clientWidth &&
                box.bottom <= document.documentElement.clientHeight,
              rowsHit: rows.map((row: any) => {
                const rect = row.getBoundingClientRect();
                return row.contains(
                  document.elementFromPoint(
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                  ),
                );
              }),
            };
          });
        const ltr = await menuFits();
        expect(ltr.inside).toBeTrue();
        expect(ltr.rowsHit.length).toBeGreaterThan(0);
        expect(ltr.rowsHit.every(Boolean)).toBeTrue();
        await page
          .locator("#pane-backdrop")
          .click({ position: { x: 1, y: 1 } });
        await page.evaluate("document.documentElement.dir = 'rtl'");
        await page.locator("#pane-fab").click();
        expect(await menuFits()).toEqual(ltr);
        const item = page.locator('.pane-menu-item[data-pane="report"]');
        expect(await item.getAttribute("role")).toBe("menuitem");
        expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await item.click();
        await page.locator(".pane-col.mobile-active").waitFor();
        expect(await page.locator(".pane-title").innerText()).toBe("Artifacts");
        await assertArtifactVersionMenuEscape(page);
        await page.locator(".pane-head .x").click();
        expect(await page.locator("#panes").isVisible()).toBeFalse();
        await visibleAndUncovered(page, "#input");
      }
      if (name === "desktop") {
        expect(
          await page
            .locator("#sidebar")
            .evaluate((element) => (element as any).inert),
        ).toBeFalse();
        await page.locator("#settings-btn").focus();
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(
            "document.activeElement?.closest('#sidebar') === null",
          ),
        ).toBeTrue();
        await page.locator("#pane-rail-panels .rail-btn").last().focus();
        await page.keyboard.press("Tab");
        await browserExpect(
          page.locator("#pane-rail > #trash-btn"),
        ).toBeFocused();
        await page.locator('.rail-btn[data-pane="report"]').click();
        await assertArtifactVersionMenuEscape(page);
        await visibleAndUncovered(page, ".agent");
        await visibleAndUncovered(page, "#input");
      }
      expect(errors).toEqual([]);
      await context.close();
    }
  },
  async function test_restored_mobile_selection_survives_stale_generation(
    browser,
    base,
  ) {
    const rememberedId = "remembered-mobile-agent";
    const served = await (await fetch(base)).text();
    const stale = served
      .replaceAll("browser-e2e-current", "browser-e2e-old")
      .replaceAll(
        "/static/app.js?v=browser-e2e-old",
        "/static/app.js?v=browser-e2e-current",
      )
      .replace(
        "/static/app.css?v=browser-e2e-old",
        "/static/app.css?v=browser-e2e-current",
      );
    const runtimeVersion = String(
      ((await (await fetch(`${base}api/version`)).json()) as any).version,
    );
    const rememberedConv = {
      id: rememberedId,
      title: "Remembered mobile agent",
      parent: "main",
      status: "idle",
      kind: null,
      turns: [
        turn("remembered", "Say something", "Remembered thread is visible.", {
          cursor: 100,
          includeRows: false,
          rowIds: { user: "remembered-u", assistant: "remembered-a" },
          usage: null,
        }),
      ],
      msg_count: 2,
      window_cursor: 0,
      draft: null,
      pending: [],
      model: "anthropic/claude-opus-5",
      backend: "pi",
    };
    for (const [name, options] of [
      [
        "phone",
        {
          viewport: { width: 390, height: 844 },
          touch: true,
        },
      ],
      [
        "desktop-site-coarse",
        {
          viewport: { width: 1280, height: 800 },
          isMobile: false,
          hasTouch: true,
        },
      ],
    ] as const) {
      const { context, page, errors } = await openPage(browser, options);
      await context.addInitScript(
        `localStorage.setItem('recurse.lastAgent', ${JSON.stringify(rememberedId)});`,
      );
      let roots = 0;
      let firstShell = true;
      page.on("request", (request) => {
        if (request.url().split("?")[0] === base) roots++;
      });
      await page.route(`${base}**`, async (route) => {
        if (route.request().url().split("?")[0] === base && firstShell) {
          firstShell = false;
          return route.fulfill({
            status: 200,
            body: stale,
            contentType: "text/html",
          });
        }
        return route.continue();
      });
      await page.route(`${base}api/tree`, async (route) => {
        const response = await route.fetch();
        const nodes = (await response.json()) as any[];
        nodes.push({
          id: rememberedId,
          parent: "main",
          title: "Remembered mobile agent",
          kind: null,
          status: "idle",
          updated: 1,
          children: 0,
          queued: 0,
          preview: "",
          description: null,
          muted: false,
          safety_off: false,
          safety_off_active: false,
          skill_context: "browser-restored-mobile",
        });
        return route.fulfill({ json: nodes });
      });
      await mockConversation(page, base, rememberedId, () => rememberedConv);
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForURL(`${base}?_recurse_generation=${runtimeVersion}**`);
      await page.locator(`.agent[data-id="${rememberedId}"]`).waitFor();
      if (name === "phone") {
        await page.locator("#sidebar.open").waitFor();
        await page.locator(`.agent[data-id="${rememberedId}"]`).click();
      }
      await page
        .locator("#conv-title")
        .filter({ hasText: "Remembered mobile agent" })
        .waitFor();
      await page
        .locator("#messages")
        .filter({ hasText: "Remembered thread is visible." })
        .waitFor();
      await page.waitForFunction("location.search === ''");
      await visibleAndUncovered(page, "#messages");
      await visibleAndUncovered(page, "#input");
      expect(
        await page
          .locator(`.agent[data-id="${rememberedId}"].selected`)
          .count(),
      ).toBe(1);
      expect(roots).toBe(2);
      if (name === "desktop-site-coarse")
        expect(
          await page.evaluate("matchMedia('(pointer: coarse)').matches"),
        ).toBeTrue();
      expect(errors).toEqual([]);
      await closeWithRoutes(context);
    }
  },
  async function test_optional_chrome_cannot_abort_boot(browser, base) {
    const servedResponse = await fetch(base);
    const served = await servedResponse.text();
    const marker = '<script type="module" src="/static/app.js';
    const removal = `<script>
      for (const id of ["connection-status", "connection-announcement",
        "agent-finder", "agent-menu", "agent-finder-query", "agent-finder-status",
        "pane-announcer", "key-mode", "shortcut-groups"])
        document.getElementById(id)?.remove();
    </script>`;
    const shell = served.replace(marker, removal + marker);
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
    await page.route(`${base}**`, async (route) => {
      const url = route.request().url().split("?")[0];
      if (url === base)
        return route.fulfill({
          status: 200,
          body: shell,
          contentType: "text/html",
        });
      return route.continue();
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    for (const selector of [
      "#connection-status",
      "#agent-finder",
      "#pane-announcer",
      "#key-mode",
    ])
      expect(await page.locator(selector).count()).toBe(0);
    await page.waitForFunction(
      "!document.querySelector('#messages')?.classList.contains('stale')",
    );
    await visibleAndUncovered(page, "#messages");
    await visibleAndUncovered(page, "#input");
    await page.locator("#input").fill("core shell stays visible");
    expect(await page.locator("#input").inputValue()).toBe(
      "core shell stays visible",
    );
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2248 pre-startup composer text survives selection (also Feature #2749 compact composer height follows text instead of its controls.; #2440 a boot-time Enter waits visibly, then reaches the real selection.; #2440 a real deleted target returns404 without the transient retry ladder.)
  async function test_input_typed_before_boot_survives_selection(
    browser,
    base,
  ) {
    await assertDraftSurvivesSelection(browser, base, "boot");
  },
  // Regression: #2248 pre-tree composer text survives selection
  async function test_input_typed_before_first_tree_survives_selection(
    browser,
    base,
  ) {
    await assertDraftSurvivesSelection(browser, base, "first-tree");
  },
  // Regression: #3208 Initial desktop sizing must preserve native composer input and caret.
  async function test_composer_typing_after_desktop_mount(browser, base) {
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    let releaseDock!: () => void;
    const dockStyle = new Promise<void>((resolve) => (releaseDock = resolve));
    await page.route("**/static/dockview.css", async (route) => {
      await dockStyle;
      await route.continue();
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    const input = page.locator("#input");
    try {
      await input.selectText();
      const mounted = page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const document = (globalThis as any).document;
            const observer = new (globalThis as any).MutationObserver(() => {
              if (!document.querySelector("#dock #main")) return;
              observer.disconnect();
              resolve();
            });
            observer.observe(document.body, { childList: true, subtree: true });
          }),
      );
      releaseDock();
      await mounted;
      await page.keyboard.insertText("/revive");
      await page
        .locator("#skill-menu .skill-option.action", { hasText: "/revive" })
        .waitFor();
      expect(await input.inputValue()).toBe("/revive");
      expect(await input.evaluate((node: any) => node.selectionStart)).toBe(7);
    } finally {
      releaseDock();
      await context.close();
    }
  },
];
