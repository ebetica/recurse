import { expect } from "bun:test";
import {
  PNG_1X1,
  assertArtifactVersionMenuEscape,
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  mockConversation,
  postFixture,
  routeArtifacts,
  runBrowserTests,
  visibleAndUncovered,
  type BrowserTest,
} from "./common";

async function layerAt(page: any, at: string | [number, number]) {
  const [x, y] = Array.isArray(at)
    ? at
    : await page.locator(at).evaluate((el: any) => {
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
  return page.evaluate(
    `document.elementFromPoint(${x}, ${y})?.closest("#sidebar, #backdrop, #topbar, #panes, #pane-backdrop, #pane-menu")?.id`,
  );
}

const turn = (id: string, user: string, assistant: string) => ({
  turn_id: id,
  cursor: 100,
  started_at: 1,
  ended_at: 2,
  open: false,
  status: "done",
  summary: null,
  segments: [
    {
      user: [
        {
          id: `${id}-u`,
          kind: "user",
          offset: 101,
          role: "user",
          content: user,
          ts: 1,
        },
      ],
      tools: [],
      summary: null,
      assistant: {
        id: `${id}-a`,
        kind: "assistant",
        offset: 102,
        role: "assistant",
        content: assistant,
        attachments: [],
      },
    },
  ],
});
export const tests: BrowserTest[] = [
  // Regression: #2505 the sidebar and fonts can be ready before the first conversation view loads.
  async function test_fresh_mobile_and_desktop(browser, base) {
    for (const [name, viewport, isMobile, hasTouch] of [
      ["phone", { width: 390, height: 844 }, true, true],
      ["desktop", { width: 1280, height: 800 }, false, false],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile,
        hasTouch,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      await routeArtifacts(page, base);
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.evaluate(async () => {
        await (globalThis as any).document.fonts.ready;
      });
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
        const trigger = await page.locator("#pane-fab").evaluate((element) => {
          const browser = globalThis as any;
          const rect = element.getBoundingClientRect();
          const style = browser.getComputedStyle(element);
          const title = browser.document
            .querySelector("#conv-title")
            .getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            padding: style.padding,
            borderWidth: style.borderWidth,
            background: style.backgroundColor,
            titleRight: title.right,
            label: element.getAttribute("aria-label"),
            hasPopup: element.getAttribute("aria-haspopup"),
          };
        });
        expect(trigger.width).toBe(44);
        expect(trigger.height).toBe(44);
        expect(trigger.padding).toBe("0px");
        expect(trigger.borderWidth).toBe("0px");
        expect(trigger.background).toBe("rgba(0, 0, 0, 0)");
        expect(trigger.titleRight).toBeLessThanOrEqual(trigger.left);
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
        const menu = await page.locator("#pane-menu").boundingBox();
        expect(menu && menu.x + menu.width <= viewport.width - 12).toBeTrue();
        await page
          .locator("#pane-backdrop")
          .click({ position: { x: 1, y: 1 } });
        await page.evaluate("document.documentElement.dir = 'rtl'");
        await page.locator("#pane-fab").click();
        const rtlMenu = await page.locator("#pane-menu").boundingBox();
        expect(rtlMenu && rtlMenu.x >= 12).toBeTrue();
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
        await page.locator('.pane-col[data-pane="report"]').waitFor();
        await assertArtifactVersionMenuEscape(page);
        await visibleAndUncovered(page, ".agent");
        await visibleAndUncovered(page, "#input");
      }
      expect(errors).toEqual([]);
      await context.close();
    }
  },
  // Feature: #2354 touch attachment controls keep image previews accessible.
  async function test_mobile_shell_stays_visible_across_scroll_resize_and_drawer(
    browser,
    base,
  ) {
    const content =
      "# Wide transcript\n\n" +
      Array.from(
        { length: 80 },
        (_, i) => `Entry ${i}: ${"long-token-".repeat(90)}`,
      ).join("\n\n") +
      "\n\n| column | value |\n| --- | --- |\n| wide | " +
      "cell-".repeat(120) +
      " |";
    const thread = {
      id: "main",
      title: "Mobile shell agent",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 2,
      window_cursor: 0,
      turns: [turn("mobile-shell", "Keep the shell visible", content)],
    };
    const branchThread = { ...thread, id: "branch", title: "Branch agent" };
    const leafThread = { ...thread, id: "leaf", title: "Leaf agent" };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeArtifacts(page, base);
    await page.route(`${base}api/tree`, async (route) =>
      route.fulfill({
        json: [
          {
            id: "main",
            parent: null,
            title: "Mobile shell agent",
            status: "idle",
            kind: null,
            updated: 1,
            children: 1,
            queued: 0,
            preview: "",
            muted: false,
          },
          {
            id: "branch",
            parent: "main",
            title: "Branch agent",
            status: "idle",
            kind: null,
            updated: 2,
            children: 1,
            queued: 0,
            preview: "",
            muted: false,
          },
          {
            id: "leaf",
            parent: "branch",
            title: "Leaf agent",
            status: "idle",
            kind: null,
            updated: 3,
            children: 0,
            queued: 0,
            preview: "",
            muted: false,
          },
        ],
      }),
    );
    await mockConversation(page, base, "branch", () => branchThread);
    await mockConversation(page, base, "leaf", () => leafThread);
    await mockConversation(page, base, "main", () => thread);
    let uploads = 0;
    await page.route(`${base}api/attachments`, (route) => {
      const name = `mobile-shell-${++uploads}.png`;
      return route.fulfill({
        json: {
          id: name,
          url: `/api/attachments/${name}`,
          filename: name,
          is_image: true,
        },
      });
    });
    await gotoRoot(page, base);
    await page.locator("#messages").filter({ hasText: "Entry 79" }).waitFor();
    await page.locator("#menu-btn").click();
    await page.waitForFunction(
      "document.querySelector('#sidebar .agent[data-id=\"branch\"]')?.getBoundingClientRect().left >= 0",
    );
    await page.locator('.agent[data-id="branch"]').click();
    await page.waitForFunction(
      "document.querySelector('#conv-title')?.textContent?.includes('Branch agent')",
    );
    await page.locator("#menu-btn").click();
    await page.waitForFunction(
      "document.querySelector('#sidebar .agent[data-id=\"leaf\"]')?.getBoundingClientRect().left >= 0",
    );
    await page.locator('.agent[data-id="leaf"]').click();
    await page.waitForFunction(
      "document.querySelector('#conv-title')?.textContent?.includes('Leaf agent')",
    );
    await page.locator("#messages").filter({ hasText: "Entry 79" }).waitFor();
    await page.waitForFunction(
      "!document.querySelector('#messages').classList.contains('stale')",
    );
    const table = page.locator("#messages .content .table-scroll").last();
    const tableMetrics = await table.evaluate((element) => {
      const browser = globalThis as any;
      const table = element.querySelector("table");
      return {
        wrapper: { width: element.clientWidth, scroll: element.scrollWidth },
        table: {
          display: table ? browser.getComputedStyle(table).display : null,
          role: table?.getAttribute("role"),
        },
      };
    });
    expect(tableMetrics.wrapper.scroll).toBeGreaterThan(
      tableMetrics.wrapper.width,
    );
    expect(tableMetrics.table).toEqual({ display: "table", role: null });
    const shell = async (): Promise<any> =>
      page.evaluate(() => {
        const browser = globalThis as any;
        const top = browser.document
          .querySelector("#topbar")
          .getBoundingClientRect();
        const menu = browser.document
          .querySelector("#menu-btn")
          .getBoundingClientRect();
        const composer = browser.document
          .querySelector("#composer")
          .getBoundingClientRect();
        const vv = browser.visualViewport;
        const visualTop = vv?.offsetTop ?? 0;
        const visualBottom = visualTop + (vv?.height ?? browser.innerHeight);
        const point = browser.document.elementFromPoint(
          menu.left + menu.width / 2,
          menu.top + menu.height / 2,
        );
        const button = browser.document.querySelector("#menu-btn");
        return {
          top,
          menu,
          composer,
          scrollY: browser.scrollY,
          pageWidth: browser.document.documentElement.scrollWidth,
          viewport: browser.innerWidth,
          visualTop,
          visualBottom,
          hit: point === button || button.contains(point),
        };
      });
    await page
      .locator("#scroll")
      .evaluate(
        (element) =>
          ((element as any).scrollTop = (element as any).scrollHeight),
      );
    const first = await shell();
    expect(first.visualTop <= first.top.top).toBeTrue();
    expect(
      first.top.bottom <= first.visualBottom &&
        first.menu.top >= first.visualTop,
    ).toBeTrue();
    expect(first.menu.bottom <= first.visualBottom).toBeTrue();
    expect(first.menu.width).toBeGreaterThanOrEqual(44);
    expect(first.menu.height).toBeGreaterThanOrEqual(44);
    expect(first.pageWidth <= first.viewport + 1).toBeTrue();
    expect(first.hit && first.scrollY === 0).toBeTrue();
    const one = (await page.locator("#input").boundingBox())!.height;
    await page.locator("#input").fill("grow the composer\n".repeat(20));
    const grown = (await page.locator("#input").boundingBox())!.height;
    expect(one < grown && grown <= 180).toBeTrue();
    await page.locator("#file-input").setInputFiles(
      ["first.png", "second.png"].map((name) => ({
        name,
        mimeType: "image/png",
        buffer: Buffer.from(PNG_1X1),
      })),
    );
    await page.waitForFunction(
      "document.querySelectorAll('.attach-chip:not(.uploading) .preview').length === 2",
    );
    const chips = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      return [...doc.querySelectorAll(".attach-chip")].map((chip: any) => {
        const remove = chip.querySelector(".rm");
        const preview = chip.querySelector(".preview");
        const box = remove.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const reach = (dx: number, dy: number) => {
          let step = 0;
          while (
            step < 60 &&
            remove.contains(
              doc.elementFromPoint(x + dx * (step + 1), y + dy * (step + 1)),
            )
          )
            step++;
          return step;
        };
        const view = preview.getBoundingClientRect();
        return {
          width: reach(-1, 0) + reach(1, 0) + 1,
          height: reach(0, -1) + reach(0, 1) + 1,
          centreOpensPreview: preview.contains(
            doc.elementFromPoint(
              view.left + view.width / 2,
              view.top + view.height / 2,
            ),
          ),
        };
      });
    });
    expect(chips.length).toBe(2);
    for (const chip of chips) {
      expect(chip.width).toBeGreaterThanOrEqual(44);
      expect(chip.height).toBeGreaterThanOrEqual(44);
      expect(chip.centreOpensPreview).toBeTrue();
    }
    await page.setViewportSize({ width: 390, height: 568 });
    await page.waitForFunction(
      "document.querySelector('#composer').getBoundingClientRect().bottom <= (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight) + 1",
    );
    const resized = await shell();
    expect(resized.visualTop <= resized.top.top).toBeTrue();
    expect(
      resized.top.bottom <= resized.visualBottom &&
        resized.menu.top >= resized.visualTop,
    ).toBeTrue();
    expect(resized.menu.bottom <= resized.visualBottom).toBeTrue();
    expect(resized.composer.bottom <= resized.visualBottom + 1).toBeTrue();
    expect(resized.pageWidth <= resized.viewport + 1).toBeTrue();
    expect(resized.hit && resized.scrollY === 0).toBeTrue();
    await page.locator("#input").fill("keyboard-sized\n".repeat(20) + "@");
    await page.locator("#agent-finder.on").waitFor();
    const finder = await page.locator("#agent-finder").boundingBox();
    expect(
      Boolean(finder && finder.x >= 0 && finder.x + finder.width <= 390),
    ).toBeTrue();
    expect(
      await page.evaluate(() => {
        const browser = globalThis as any;
        const button = browser.document.querySelector("#menu-btn");
        const rect = button.getBoundingClientRect();
        const hit = browser.document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit === button || button.contains(hit);
      }),
    ).toBeTrue();
    await page.locator("#input").fill("");
    await page.locator("#agent-finder.on").waitFor({ state: "detached" });
    await page.locator("#input").focus();
    await page.evaluate(
      "history.pushState({}, '', location.pathname + '#mobile-shell')",
    );
    await page.goBack();
    await page.waitForFunction("document.activeElement?.id === 'input'");
    expect(String(await page.evaluate("document.activeElement?.id"))).toBe(
      "input",
    );
    await page.locator("#pane-fab").click();
    await page.locator("#pane-menu.on").waitFor();
    await page.locator('.pane-menu-item[data-pane="report"]').click();
    await page.locator("#panes.on.overlay").waitFor();
    await page.locator("#menu-btn").click();
    const drawer = page.locator("#sidebar.open");
    await drawer.waitFor();
    const row = drawer.locator('.agent[data-id="leaf"]');
    await page.waitForFunction(
      "document.querySelector('#sidebar .agent')?.getBoundingClientRect().left >= 0",
    );
    expect(await row.isVisible()).toBeTrue();
    expect(await row.getAttribute("data-id")).toBe("leaf");
    await row.focus();
    expect(
      await page.evaluate(
        "document.activeElement === document.querySelector('#sidebar .agent[data-id=\\\"leaf\\\"]')",
      ),
    ).toBeTrue();
    const drawerBox = await drawer.boundingBox();
    const rowBox = await row.boundingBox();
    expect(drawerBox && rowBox && rowBox.y >= drawerBox.y).toBeTrue();
    expect(
      await row.evaluate((element) => {
        const browser = globalThis as any;
        const rect = element.getBoundingClientRect();
        const point = browser.document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return point === element || element.contains(point);
      }),
    ).toBeTrue();
    await row.focus();
    expect(
      await page.evaluate(
        "document.activeElement === document.querySelector('#sidebar .agent[data-id=\\\"leaf\\\"]')",
      ),
    ).toBeTrue();
    await row.press("Shift+Tab");
    expect(
      await page.evaluate(
        "document.activeElement?.closest('#sidebar') !== null",
      ),
    ).toBeTrue();
    await page.evaluate(() => {
      const browser = globalThis as any;
      const row = browser.document.querySelector("#sidebar .agent");
      const touch = new browser.Touch({
        identifier: 1,
        target: row,
        clientX: 20,
        clientY: 20,
      });
      row.dispatchEvent(
        new browser.TouchEvent("touchstart", {
          bubbles: true,
          touches: [touch],
          changedTouches: [touch],
        }),
      );
    });
    await page.locator("#sidebar .rename-input").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      "!document.querySelector('#sidebar .rename-input')",
    );
    expect(await page.locator("#sidebar.open").count()).toBe(1);
    await page.locator("#menu-btn").click();
    await page.waitForFunction(
      "!document.querySelector('#sidebar').classList.contains('open')",
    );
    expect(
      await page.evaluate(
        "document.activeElement === document.querySelector('#menu-btn')",
      ),
    ).toBeTrue();
    await page.locator(".pane-head .x").click();
    await page.locator("#menu-btn").click();
    await page.waitForFunction(
      "document.querySelector('#sidebar').classList.contains('open')",
    );
    await page.evaluate(
      "document.querySelector('.activity-group-toggle')?.click()",
    );
    if (await page.locator("#prompt-overlay.on").count()) {
      await page.locator("#prompt-overlay.on").waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        "!document.querySelector('#prompt-overlay').classList.contains('on')",
      );
      expect(await page.locator("#sidebar.open").count()).toBe(1);
    }
    await page.locator("#settings-btn").click();
    await page.locator("#settings-overlay.on").waitFor();
    await page.locator("#settings-close").click();
    expect(
      await page.evaluate(
        "document.activeElement === document.querySelector('#menu-btn')",
      ),
    ).toBeTrue();
    expect(
      await page.evaluate("document.querySelector('#sidebar').inert"),
    ).toBeTrue();
    expect(
      await page.evaluate(
        "!document.querySelector('#tree-announcer').closest('[inert]')",
      ),
    ).toBeTrue();
    await page.locator("#menu-btn").focus();
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(
          "document.activeElement?.closest('#sidebar') === null",
        ),
      ).toBeTrue();
    }
    await page.locator("#new-top").click();
    await page.locator("#menu-btn").click();
    await page.waitForFunction(
      "document.querySelector('#sidebar').classList.contains('open')",
    );
    const draftFocus = await page.evaluate(() => {
      const browser = globalThis as any;
      return {
        id: browser.document.activeElement?.id,
        tag: browser.document.activeElement?.tagName,
      };
    });
    expect(
      await page.evaluate(
        "document.activeElement?.closest('#sidebar') !== null",
      ),
    ).toBeTrue();
    expect(
      draftFocus.tag === "SUMMARY" || draftFocus.id === "settings-btn",
    ).toBeTrue();
    expect(
      await page.evaluate("!document.activeElement?.matches('.agent')"),
    ).toBeTrue();
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      "!document.querySelector('#sidebar').classList.contains('open')",
    );
    await page.locator("#menu-btn").click();
    await page.waitForFunction(
      "document.querySelector('#sidebar').classList.contains('open')",
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      "!document.querySelector('#backdrop').classList.contains('on')",
    );
    expect(await page.locator("#menu-btn").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      await page.evaluate(
        "document.activeElement === document.querySelector('#menu-btn')",
      ),
    ).toBeTrue();
    expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();

    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const desktopPage = await desktop.newPage();
    const desktopErrors = captureErrors(desktopPage);
    await routeArtifacts(desktopPage, base);
    await desktopPage.route(`${base}api/tree`, (route) =>
      route.fulfill({
        json: [
          {
            id: "main",
            parent: null,
            title: "Mobile shell agent",
            status: "idle",
            kind: null,
            updated: 1,
            children: 0,
            queued: 0,
            preview: "",
            muted: false,
          },
        ],
      }),
    );
    await mockConversation(desktopPage, base, "main", () => thread);
    await gotoRoot(desktopPage, base);
    await desktopPage
      .locator("#messages")
      .filter({ hasText: "Entry 79" })
      .waitFor();
    await desktopPage.setViewportSize({ width: 390, height: 844 });
    await desktopPage.waitForFunction(
      "matchMedia('(max-width: 700px)').matches",
    );
    await desktopPage.waitForFunction(
      "document.querySelector('#sidebar').inert",
    );
    expect(
      await desktopPage.evaluate(() => {
        const browser = globalThis as any;
        return {
          inert: browser.document.querySelector("#sidebar").inert,
          aria: browser.document
            .querySelector("#sidebar")
            .getAttribute("aria-hidden"),
        };
      }),
    ).toEqual({ inert: true, aria: "true" });
    await desktopPage.setViewportSize({ width: 1280, height: 800 });
    await desktopPage.waitForFunction(
      "!matchMedia('(max-width: 700px)').matches",
    );
    await desktopPage.waitForFunction(
      "!document.querySelector('#sidebar').inert",
    );
    expect(
      await desktopPage.evaluate(() => {
        const browser = globalThis as any;
        return {
          inert: browser.document.querySelector("#sidebar").inert,
          aria: browser.document
            .querySelector("#sidebar")
            .getAttribute("aria-hidden"),
        };
      }),
    ).toEqual({ inert: false, aria: null });
    const desktopTable = desktopPage
      .locator("#messages .content .table-scroll")
      .last();
    expect(
      await desktopTable.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBeTrue();
    expect(
      await desktopTable.evaluate((element) => {
        const browser = globalThis as any;
        return browser.getComputedStyle(element.querySelector("table")).display;
      }),
    ).toBe("table");
    expect(
      await desktopPage.evaluate(
        "document.documentElement.scrollWidth <= innerWidth + 1",
      ),
    ).toBeTrue();
    expect(desktopErrors).toEqual([]);
    await desktop.unrouteAll({ behavior: "ignoreErrors" });
    await desktop.close();
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
        turn("remembered", "Say something", "Remembered thread is visible."),
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
          isMobile: true,
          hasTouch: true,
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
      const context = await browser.newContext(options);
      await context.addInitScript(
        `localStorage.setItem('recurse.lastAgent', ${JSON.stringify(rememberedId)});`,
      );
      const page = await context.newPage();
      const errors = captureErrors(page);
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
  async function test_phone_drawer_and_pane_menu_stack_over_an_open_pane(
    browser,
    base,
  ) {
    const fixture = await postFixture(base, "seed-files-pane");
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const fab = page.locator("#pane-fab");
    const drawerAt = (edge: string) =>
      page.waitForFunction(
        `document.querySelector('#sidebar')?.getBoundingClientRect().${edge}`,
      );
    await page.goto(`${base}#agent=${fixture.demo}`);
    await page.locator("#pane-fab.on").waitFor();
    await fab.click();
    await page.locator('#pane-menu [data-pane="files"]').click();
    await page.locator("#panes.overlay .files-card").first().waitFor();
    expect(await layerAt(page, [206, 600])).toBe("panes");
    expect(await layerAt(page, "#menu-btn")).toBe("topbar");
    await fab.click();
    await page.locator("#pane-menu.on").waitFor();
    expect(await layerAt(page, '#pane-menu [data-pane="files"]')).toBe(
      "pane-menu",
    );
    await fab.click();
    await page.locator("#pane-menu.on").waitFor({ state: "detached" });
    await page.locator("#menu-btn").click();
    await drawerAt("left >= 0");
    expect(await layerAt(page, [100, 600])).toBe("sidebar");
    expect(await layerAt(page, [400, 600])).toBe("backdrop");
    expect(await layerAt(page, "#menu-btn")).toBe("topbar");
    await fab.click();
    const menu = (await page.locator("#pane-menu.on").boundingBox())!;
    const mid = menu.y + menu.height / 2;
    expect(await layerAt(page, [menu.x + 8, mid])).toBe("sidebar");
    expect(await layerAt(page, [menu.x + menu.width - 8, mid])).toBe(
      "pane-menu",
    );
    await fab.click();
    await page.locator("#menu-btn").click();
    await drawerAt("right <= 0");
    expect(await layerAt(page, [206, 600])).toBe("panes");
    await context.close();
  },
  async function test_reduced_motion_stops_drawer_and_control_transitions(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    const durations = (): Promise<string[]> =>
      page.evaluate(
        `["#sidebar", "#scroll-btn", "#safety-btn .knob"].flatMap((s) =>
          getComputedStyle(document.querySelector(s)).transitionDuration
            .split(", ").map((t) => s + " " + t))`,
      );
    const moving = await durations();
    expect(moving.length).toBeGreaterThanOrEqual(3);
    expect(moving.filter((d) => d.endsWith(" 0s"))).toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await durations()).filter((d) => !d.endsWith(" 0s"))).toEqual([]);
    await context.close();
  },
  // Feature: #2279 touch Send and general controls provide 44px targets.
  async function test_phone_tap_targets_stay_44px(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    const short = async (selector: string, rows = false) => {
      const sizes: number[][] = await page.evaluate(
        `[...document.querySelectorAll(${JSON.stringify(selector)})]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => [Math.round(r.width), Math.round(r.height)])`,
      );
      expect(sizes.length).toBeGreaterThan(0);
      return sizes
        .filter(([w, h]) => h! < 44 || (!rows && w! < 44))
        .map(([w, h]) => `${selector} ${w}x${h}`);
    };
    const misses: string[] = [];
    for (const selector of ["#menu-btn", "#new-top", "#pane-fab"])
      misses.push(...(await short(selector)));
    await page.locator("#input").fill("A message");
    for (const selector of ["#attach", "#send"]) {
      const hits = await page.locator(selector).evaluate((element) => {
        const document = (globalThis as any).document;
        const box = element.getBoundingClientRect();
        return [-21, 21].flatMap((x) =>
          [-21, 21].map((y) =>
            element.contains(
              document.elementFromPoint(
                box.x + box.width / 2 + x,
                box.y + box.height / 2 + y,
              ),
            ),
          ),
        );
      });
      expect(hits).toEqual([true, true, true, true]);
    }
    await page.locator("#menu-btn").click();
    await page.locator('#menu-btn[aria-expanded="true"]').waitFor();
    expect(await page.locator("#sidebar .agent").count()).toBeGreaterThan(0);
    await page.locator("#menu-btn").click();
    await page.locator('#menu-btn[aria-expanded="false"]').waitFor();
    await page.locator("#pane-fab").click();
    await page.locator("#pane-menu.on .pane-menu-item").first().waitFor();
    misses.push(...(await short("#pane-menu.on .pane-menu-item", true)));
    expect(misses).toEqual([]);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_optional_chrome_cannot_abort_boot(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
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
    const page = await context.newPage();
    const errors = captureErrors(page);
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
  async function test_live_response_keeps_first_and_latest_replies_visible_on_mobile(
    browser,
    base,
  ) {
    const attachment = {
      id: "f".repeat(32),
      name: "checkpoint.txt",
      size: 10,
      media_type: "text/plain",
      inline_media_type: null,
    };
    const thread = {
      id: "main",
      title: "Live turn",
      parent: null,
      status: "running",
      kind: null,
      msg_count: 4,
      window_cursor: 2000,
      turns: [
        {
          turn_id: "live-folded",
          cursor: 2000,
          started_at: 1,
          ended_at: null,
          open: true,
          status: "open",
          partial: false,
          summary: {
            tools: 0,
            shell: 0,
            read_files: 0,
            edit_files: 0,
            added: 0,
            removed: 0,
            write_files: 0,
            agents: 0,
            searches: 0,
            web: 0,
            prs: [],
            truncated: false,
          },
          segments: [
            {
              user: [
                {
                  kind: "user",
                  offset: 2010,
                  role: "user",
                  content: "Start it",
                  ts: 1,
                },
              ],
              tools: [],
              summary: null,
              assistant: {
                kind: "assistant",
                offset: 2020,
                role: "assistant",
                content: "Earlier 😀.",
                attachments: [attachment],
              },
            },
            {
              user: [],
              tools: [],
              summary: null,
              assistant: {
                kind: "assistant",
                offset: 2030,
                role: "assistant",
                content: "Latest settled reply.",
                attachments: [],
              },
            },
            {
              user: [],
              tools: [],
              summary: null,
              assistant: null,
            },
          ],
        },
      ],
      draft: { text: "Visible live output", tools: 0, attachments: [] },
      rows: [
        {
          id: "live-folded:user",
          kind: "text",
          role: "user",
          origin: "operator",
          text: "Start it",
          live: false,
        },
        {
          id: "live-folded:publication:0:0",
          kind: "tool_call",
          role: "tool",
          origin: "tool",
          text: "",
          name: "publish_attachment",
          args: "",
          result: "published",
          attachment,
          stat: { kind: "other" },
          running: false,
          live: false,
        },
        {
          id: "live-folded:assistant:0",
          kind: "text",
          role: "assistant",
          origin: "assistant",
          text: "Earlier 😀.",
          live: false,
        },
        {
          id: "live-folded:assistant:1",
          kind: "text",
          role: "assistant",
          origin: "assistant",
          text: "Latest settled reply.",
          live: false,
        },
        {
          id: "stream",
          kind: "text",
          role: "assistant",
          origin: "assistant",
          text: "Visible live output",
          live: true,
        },
      ],
    };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await mockConversation(page, base, "main", () => thread);
    await gotoRoot(page, base);
    await page
      .locator("#messages")
      .filter({ hasText: "Visible live output" })
      .waitFor();
    const live = page.locator(".turn.current");
    expect(await live.innerText()).toContain("Earlier 😀.");
    expect(await live.innerText()).not.toContain("Latest settled reply.");
    expect(await live.locator(".agent-attachment-item").count()).toBe(1);
    await live
      .locator(".activity-group-summary")
      .filter({ hasText: "1 reply" })
      .locator(".activity-group-toggle")
      .click();
    expect(await live.innerText()).toContain("Latest settled reply.");
    expect(await live.innerText()).toContain("Visible live output");
    expect(errors).toEqual([]);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["mobile-layout", tests]]);
