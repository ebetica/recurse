import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  PNG_1X1,
  closeWithRoutes,
  expectHitCorners,
  gotoRoot,
  mockConversation,
  openPage,
  postFixture,
  rootAgentId,
  routeArtifacts,
  runBrowserTests,
  screenshot,
  visibleAndUncovered,
  type BrowserTest,
  startNewAgent,
  openSettingsPanel,
  showAgentList,
  turn,
  waitForLayout,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3246 rendering a diagram during navigation must not squeeze the phone conversation.
  async function test_phone_switch_keeps_full_width_while_diagram_loads(
    browser,
    base,
  ) {
    const { demo } = await postFixture(base, "seed-theme-surfaces");
    try {
      for (const width of [390, 430]) {
        const { context, page } = await openPage(browser, {
          viewport: { width, height: width === 390 ? 844 : 932 },
          touch: true,
          deviceScaleFactor: 3,
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        let release!: () => void;
        let requested!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const loading = new Promise<void>((resolve) => (requested = resolve));
        await page.route(/\/static\/flowDiagram-[^/]+\.js$/, async (route) => {
          requested();
          await held;
          await route.continue();
        });
        try {
          await gotoRoot(page, base);
          await page
            .locator("#input")
            .fill(`Reply only Phone width ready ${width}`);
          await page.locator("#send").click();
          await page
            .getByText(`Phone width ready ${width}`, { exact: true })
            .waitFor();
          await page.locator("#menu-btn").click();
          await page.locator("html.phone-list").waitFor();
          await page.evaluate(() => {
            const browser = globalThis as any;
            browser.__phoneWidths = [];
            browser.__samplePhoneWidths = true;
            const sample = () => {
              if (!browser.__samplePhoneWidths) return;
              if (
                !browser.document.documentElement.classList.contains(
                  "phone-list",
                )
              )
                browser.__phoneWidths.push({
                  viewport: browser.innerWidth,
                  widths: ["#main", "#scroll", "#messages"].map(
                    (selector) =>
                      browser.document
                        .querySelector(selector)
                        .getBoundingClientRect().width,
                  ),
                });
              browser.requestAnimationFrame(sample);
            };
            browser.requestAnimationFrame(sample);
          });
          await page.locator(`.agent[data-id="${demo}"]`).click();
          await loading;
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                const browser = globalThis as any;
                browser.requestAnimationFrame(() =>
                  browser.requestAnimationFrame(() => resolve()),
                );
              }),
          );
          await screenshot(page, `mobile-layout/phone-diagram-${width}`);
          release();
          await page.locator("#messages .mermaid-done svg").waitFor();
          await page.locator("#menu-btn").click();
          await page.locator("html.phone-list").waitFor();
          await page.locator(`.agent[data-id="${rootAgentId()}"]`).click();
          await waitForLayout(page);
          const frames = await page.evaluate(() => {
            const browser = globalThis as any;
            browser.__samplePhoneWidths = false;
            return browser.__phoneWidths as Array<{
              viewport: number;
              widths: number[];
            }>;
          });
          console.log("Phone width trace:", JSON.stringify({ width, frames }));
          expect(frames.length).toBeGreaterThan(0);
          expect(
            frames.filter((frame) =>
              frame.widths.some((value) => value < frame.viewport - 1),
            ),
          ).toEqual([]);
        } finally {
          release();
          await closeWithRoutes(context);
        }
      }
    } finally {
      expect(
        (await fetch(`${base}api/conversations/${demo}`, { method: "DELETE" }))
          .ok,
      ).toBeTrue();
      await browserExpect
        .poll(async () => {
          const tree = (await (
            await fetch(`${base}api/tree`)
          ).json()) as Array<{ id: string }>;
          return tree.some((agent) => agent.id === demo);
        })
        .toBe(false);
    }
  },
  // Regression: #3512 #2991 installed apps avoid fullscreen cutout jumps and keep controls clear of safe areas.
  async function test_fullscreen_safe_area(browser, base) {
    const { context, page } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
    });
    const dockRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/^\/static\/(?:host-[^/]+\.js|dockview\.css)$/.test(path))
        dockRequests.push(path);
    });
    await gotoRoot(page, base);
    const manifest = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    expect(
      (await (await page.request.get(new URL(manifest!, base).href)).json())
        .display,
    ).toBe("standalone");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { top: 60, bottom: 24 },
    });
    await page.locator(".agent").first().waitFor();
    await page.locator("#pane-fab.on").waitFor();
    expect(
      await page
        .locator("#topbar")
        .evaluate((el) => (globalThis as any).getComputedStyle(el).paddingTop),
    ).toBe("60px");
    expect(
      (await page.locator("#menu-btn").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(60);
    await openSettingsPanel(page);
    expect(
      (await page.locator("#settings-close").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(60);
    expect(
      (await page.locator(".settings-head h2").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(60);
    await page.locator('#settings-nav button[data-cat="appearance"]').click();
    expect(
      (await page.locator(".settings-back:visible").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(60);
    await page.getByRole("button", { name: /^Name and icon / }).click();
    await page.locator("dialog.settings-sheet[open]").evaluate((el) => {
      (el as any).style.height = "100dvh";
    });
    expect(
      (await page.locator("dialog.settings-sheet[open]").boundingBox())!.y,
    ).toBeGreaterThanOrEqual(60);
    await page
      .locator("dialog.settings-sheet[open] .settings-sheet-close")
      .click();
    expect(await page.locator("#dock, #dockview-css").count()).toBe(0);
    expect(dockRequests).toEqual([]);
    await page.setViewportSize({ width: 915, height: 412 });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { left: 60, right: 0, top: 0, bottom: 24 },
    });
    expect(
      (await page.locator(".settings-head h2").boundingBox())!.x,
    ).toBeGreaterThanOrEqual(60);
    expect(
      (await page
        .locator('#settings-nav button[data-cat="appearance"]')
        .boundingBox())!.x,
    ).toBeGreaterThanOrEqual(60);
    await page.locator("#settings-close").click();
    expect(
      (await page.locator("#input").boundingBox())!.y +
        (await page.locator("#input").boundingBox())!.height,
    ).toBeLessThanOrEqual(388);
    await page.setViewportSize({ width: 667, height: 375 });
    await showAgentList(page);
    await page.waitForFunction(
      "document.querySelector('#sidebar.open')?.getBoundingClientRect().left >= 0",
    );
    expect(
      (await page.locator("#sidebar .agent").first().boundingBox())!.x,
    ).toBeGreaterThanOrEqual(60);
    await openSettingsPanel(page);
    await page.locator('#settings-nav button[data-cat="appearance"]').click();
    await page.getByRole("button", { name: /^Name and icon / }).click();
    expect(
      (await page.locator("dialog.settings-sheet[open] h2").boundingBox())!.x,
    ).toBeGreaterThanOrEqual(60);
    await context.close();
  },
  // Feature: #2354 touch attachment controls keep image previews accessible.
  async function test_mobile_shell_stays_visible_across_scroll_resize_and_list(
    browser,
    base,
  ) {
    const content =
      "# Wide transcript\n\n" +
      Array.from(
        { length: 80 },
        (_, i) => `Entry ${i}: ${"long-token-".repeat(90)}`,
      ).join("\n\n") +
      "\n\n| Review | Revisions | Delivery |\n| --- | --- | --- |\n" +
      "| Check the totals against the source files. | Save a copy of the report before editing. | Share the reviewed report with the requester. |";
    const thread = {
      id: "main",
      title: "Mobile shell agent",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 2,
      window_cursor: 0,
      turns: [
        turn("mobile-shell", "Keep the shell visible", content, {
          cursor: 100,
          includeRows: false,
          rowIds: { user: "mobile-shell-u", assistant: "mobile-shell-a" },
          usage: null,
        }),
      ],
    };
    const branchThread = { ...thread, id: "branch", title: "Branch agent" };
    const leafThread = { ...thread, id: "leaf", title: "Leaf agent" };
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
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
    await page.locator("#input").blur();
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
    await page.locator("#input").fill("visible above the keyboard");
    await page.evaluate(() => {
      const browser = globalThis as any;
      const viewport = browser.visualViewport;
      const height = Object.getOwnPropertyDescriptor(
        browser.VisualViewport.prototype,
        "height",
      )!;
      Object.defineProperty(viewport, "height", {
        configurable: true,
        get: () => height.get!.call(viewport) - 24,
      });
      viewport.dispatchEvent(new browser.Event("resize"));
    });
    await page.waitForFunction(
      "Math.abs(document.querySelector('#composer-wrap').getBoundingClientRect().bottom - visualViewport.offsetTop - visualViewport.height) <= 1",
    );
    expect(
      await page.evaluate(() => {
        const browser = globalThis as any;
        const viewport = browser.visualViewport;
        const bottom = viewport.offsetTop + viewport.height;
        const composer = browser.document
          .querySelector("#composer")
          .getBoundingClientRect();
        const send = browser.document.querySelector("#send");
        const button = send.getBoundingClientRect();
        const hit = browser.document.elementFromPoint(
          button.left + button.width / 2,
          button.top + button.height / 2,
        );
        return {
          composerVisible:
            composer.top >= viewport.offsetTop && composer.bottom <= bottom,
          sendHit: send.contains(hit),
        };
      }),
    ).toEqual({ composerVisible: true, sendHit: true });
    await page.evaluate(() => {
      const browser = globalThis as any;
      delete browser.visualViewport.height;
      browser.visualViewport.dispatchEvent(new browser.Event("resize"));
    });
    await page.locator("#input").fill("");
    await page.locator("#input").fill("keyboard-sized\n".repeat(20) + "@");
    await page.locator("#agent-finder.on").waitFor();
    const finder = await page.locator("#agent-finder").boundingBox();
    expect(
      Boolean(finder && finder.x >= 0 && finder.x + finder.width <= 390),
    ).toBeTrue();
    expect(
      await page.evaluate(() => {
        const browser = globalThis as any;
        const button = browser.document.querySelector("#conv-title");
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
    await page.locator("#menu-btn").click();
    await page.locator("#sidebar.open").waitFor();
    await visibleAndUncovered(page, '.agent[data-id="leaf"]');
    expect(
      await page.locator("#sidebar").evaluate((el) => (el as any).inert),
    ).toBeFalse();
    expect(
      await page.locator("#main").evaluate((el) => (el as any).inert),
    ).toBeTrue();
    await openSettingsPanel(page);
    await page.locator("#settings-close").click();
    await page.waitForFunction("!history.state?.settings");
    expect(await page.locator("#sidebar.open").count()).toBe(1);
    await startNewAgent(page);
    await visibleAndUncovered(page, "#input");
    expect(await page.locator("#sidebar.open").count()).toBe(0);
    await page.locator("#menu-btn").click();
    await page.locator("#sidebar.open").waitFor();
    await page.keyboard.press("Escape");
    expect(await page.locator("#sidebar.open").count()).toBe(1);
    expect(errors).toEqual([]);
    await closeWithRoutes(context);

    const {
      context: desktop,
      page: desktopPage,
      errors: desktopErrors,
    } = await openPage(browser, { viewport: { width: 1280, height: 800 } });
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
  async function test_reduced_motion_stops_control_transitions(browser, base) {
    const { context, page } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
      reducedMotion: "no-preference",
    });
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
    expect(
      moving.filter((d) => !d.startsWith("#sidebar") && d.endsWith(" 0s")),
    ).toEqual([]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await durations()).filter((d) => !d.endsWith(" 0s"))).toEqual([]);
    await context.close();
  },
  // Feature: #2279 touch Send and general controls provide 44px targets.
  async function test_phone_tap_targets_stay_44px(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
    });
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
    for (const selector of ["#menu-btn", "#pane-fab"])
      misses.push(...(await short(selector)));
    await page.locator("#input").fill("A message");
    const corners = ["#attach", "#send"];
    for (const selector of [...corners, "#model-row.on #model-trigger"])
      await expectHitCorners(page.locator(selector), 44, {
        label: selector,
        scroll: false,
      });
    await page.locator("#send").tap();
    await page
      .locator(".msg.assistant .content", { hasText: "Acknowledged." })
      .waitFor();
    await visibleAndUncovered(page, "#menu-btn");
    await visibleAndUncovered(page, "#pane-fab");
    expect(await page.locator("#input").inputValue()).toBe("");
    await page.locator("#menu-btn").click();
    await page.locator("#sidebar.open").waitFor();
    expect(await page.locator("#sidebar .agent").count()).toBeGreaterThan(0);
    misses.push(...(await short("#new-list, #settings-btn")));
    misses.push(
      ...(await short("#sidebar .agent, .tree-section-toggle", true)),
    );
    await page.locator("#sidebar .agent").first().click();
    await page.locator("#sidebar.open").waitFor({ state: "detached" });
    await page.locator("#pane-fab").click();
    await page.locator("#pane-menu.on .pane-menu-item").first().waitFor();
    misses.push(...(await short("#pane-menu.on .pane-menu-item", true)));
    expect(misses).toEqual([]);
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
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
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
  // Feature: #3061 phone thread drags dismiss the keyboard without losing the draft.
  async function test_phone_thread_drag_hides_keyboard(browser, base) {
    for (const width of [390, 1280]) {
      const { agent } = await postFixture(base, "seed-scroll-pin");
      const { context, page } = await openPage(browser, {
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: true,
      });
      try {
        await page.goto(`${base}#agent=${agent}`);
        const input = page.locator("#input");
        await input.fill("Start the reply.");
        await page.locator("#send").click();
        await page.getByText("Short reply.", { exact: true }).waitFor();
        const draft = "Keep this draft and caret while I read.";
        await input.fill(draft);
        await input.evaluate((el: any) => el.setSelectionRange(7, 7));
        const beforeStream = await page.locator("#scroll").evaluate((el) => ({
          top: el.scrollTop,
          height: el.scrollHeight,
        }));
        await postFixture(base, "release", { agent, gate: "reply" });
        await page.getByText("First paragraph 10.", { exact: false }).waitFor();
        await waitForLayout(page);
        expect(
          await input.evaluate((el) => el === el.ownerDocument.activeElement),
        ).toBeTrue();
        expect(
          await page.locator("#scroll").evaluate((el) => el.scrollHeight),
        ).toBeGreaterThan(beforeStream.height);
        expect(
          await page.locator("#scroll").evaluate((el) => el.scrollTop),
        ).toBeGreaterThan(beforeStream.top);
        await page.locator("#scroll").evaluate((el) => (el.scrollTop = 0));
        await waitForLayout(page);
        expect(
          await input.evaluate((el) => el === el.ownerDocument.activeElement),
        ).toBeTrue();
        await page.setViewportSize({ width, height: 650 });
        await waitForLayout(page);
        expect(
          await input.evaluate((el) => el === el.ownerDocument.activeElement),
        ).toBeTrue();
        await page.setViewportSize({ width, height: 844 });
        await waitForLayout(page);
        const cdp = await context.newCDPSession(page);
        const drag = async (selector: string) => {
          const box = (await page.locator(selector).boundingBox())!;
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y }],
          });
          for (const distance of [15, 35, 60])
            await cdp.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x, y: y - distance }],
            });
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        };
        await input.fill(Array.from({ length: 12 }, () => draft).join("\n"));
        await drag("#input");
        expect(
          await input.evaluate((el) => el === el.ownerDocument.activeElement),
        ).toBeTrue();
        await input.fill(draft);
        await input.evaluate((el: any) => el.setSelectionRange(7, 7));
        if (width === 390)
          await screenshot(page, "mobile-layout/keyboard-before");
        await drag("#scroll");
        expect(
          await input.evaluate((el) => el === el.ownerDocument.activeElement),
        ).toBe(width !== 390);
        expect(await input.inputValue()).toBe(draft);
        expect(
          await page.locator("#scroll").evaluate((el) => el.scrollTop),
        ).toBeGreaterThan(0);
        expect(
          await input.evaluate((el: any) => [
            el.selectionStart,
            el.selectionEnd,
          ]),
        ).toEqual([7, 7]);
        if (width === 390)
          await screenshot(page, "mobile-layout/keyboard-after");
        await waitForLayout(page);
        await input.tap();
        expect(
          await input.evaluate((el) => el === el.ownerDocument.activeElement),
        ).toBeTrue();
        const box = (await page.locator("#scroll").boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 100);
        await waitForLayout(page);
        expect(
          await input.evaluate((el) => el === el.ownerDocument.activeElement),
        ).toBeTrue();
        expect(await input.inputValue()).toBe(draft);
        for (let i = 0; i < 4; i++)
          await postFixture(base, "release", { agent, gate: "reply" });
        await page.getByText("Scroll pin finished.", { exact: true }).waitFor();
      } finally {
        await context.request.delete(`${base}api/conversations/${agent}`);
        await page.waitForFunction(
          async (url) => (await fetch(url)).status === 404,
          `${base}api/conversations/${agent}/view`,
        );
        await context.close();
      }
    }
  },
];
if (import.meta.main) await runBrowserTests([["mobile-layout", tests]]);
