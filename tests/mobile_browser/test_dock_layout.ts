import { expect } from "bun:test";
import { rename } from "node:fs/promises";
import { expect as browserExpect } from "playwright/test";
import {
  gotoRoot,
  openPage,
  postFixture,
  rootAgentId,
  runBrowserTests,
  screenshot,
  startNewAgent,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { dockControls } from "./pane_layout";

export const tests: BrowserTest[] = [
  // Regression: #3553 The saved desktop layout appears before conversation or file responses.
  async function test_saved_layout_is_ready_on_the_first_frame(browser, base) {
    const { demo } = await postFixture(base, "seed-published-markdown");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const target = `${base}#agent=${demo}`;
    const file = page.getByRole("tab", { name: "report.md", exact: true });
    await page.goto(target);
    await waitForLayout(page);
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await page.getByRole("button", { name: "Open report.md in Files" }).click();
    await browserExpect(file).toHaveAttribute("aria-selected", "true");
    const saved = [
      [
        ["Chat", "false"],
        ["report.md", "true"],
      ],
      [["Explorer", "true"]],
    ];
    await page.locator('.agent[data-id="main"]').click();
    await browserExpect(
      page.getByRole("tab", { name: "Chat", exact: true }),
    ).toHaveAttribute("aria-selected", "true");

    let gate = Promise.withResolvers<void>();
    await page.route(
      new RegExp(
        `/api/conversations/${demo}(?:$|\\?|/(?:view|files)(?:\\?|$))`,
      ),
      async (route) => {
        await gate.promise;
        await route.continue();
      },
    );
    type TabStrip = Array<Array<Array<string | null>>>;
    type RecordedLayout = Window & { layoutStates?: TabStrip[] };
    const recordLayout = ({ demo, cold }: { demo: string; cold: boolean }) => {
      const states: TabStrip[] = [];
      const selector = `.agent.selected[data-id="${demo}"]`;
      let started = cold;
      let scheduled = false;
      if (!cold)
        document.addEventListener(
          "click",
          (event) => {
            if ((event.target as Element).closest(`.agent[data-id="${demo}"]`))
              started = true;
          },
          { capture: true },
        );
      const observer = new MutationObserver(() => {
        if (
          !started ||
          scheduled ||
          (!cold && !document.querySelector(selector))
        )
          return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const tabs = Array.from(
            document.querySelectorAll("#dock .dv-tabs-container"),
            (group) =>
              Array.from(group.querySelectorAll('[role="tab"]'), (tab) => [
                tab.getAttribute("aria-label"),
                tab.getAttribute("aria-selected"),
              ]),
          ).filter((group) => group.length);
          if (
            (!cold || tabs.length) &&
            JSON.stringify(tabs) !== JSON.stringify(states.at(-1))
          )
            states.push(tabs);
        });
      });
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-selected", "aria-label", "class"],
      });
      Object.assign(window, { layoutStates: states });
    };
    const states = async () => {
      await page.waitForFunction(
        () => (window as RecordedLayout).layoutStates?.length,
      );
      return page.evaluate(() => (window as RecordedLayout).layoutStates);
    };
    const assertStoredLayout = async (cold: boolean) => {
      expect(await states()).toEqual([saved]);
      if (cold) {
        await browserExpect(
          page.getByText("Loading file…", { exact: true }),
        ).toBeVisible();
        await browserExpect(
          page.locator("#dock .dv-tabs-and-actions-container").first(),
        ).toHaveAttribute("inert", "");
        await page.keyboard.press("g");
        await page.keyboard.press("1");
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(await states()).toEqual([saved]);
      }
      gate.resolve();
      await page.locator(".file-tab .files-markdown h1").waitFor();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(await states()).toEqual([saved]);
    };
    try {
      await page.evaluate(recordLayout, { demo, cold: false });
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await assertStoredLayout(false);

      gate = Promise.withResolvers<void>();
      let treeUnavailable = false;
      await page.route(/\/api\/tree(?:\/events)?(?:\?|$)/, async (route) => {
        await gate.promise;
        if (treeUnavailable) await route.fulfill({ status: 503, json: {} });
        else await route.continue();
      });
      await page.addInitScript(recordLayout, { demo, cold: true });
      await page.reload({ waitUntil: "domcontentloaded" });
      await assertStoredLayout(true);

      treeUnavailable = true;
      const failedTree = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/tree" &&
          response.status() === 503,
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await failedTree;
      await browserExpect(file).toHaveCount(0);
      await page.locator("#input").fill("Draft while reconnecting");
      await browserExpect(page.locator("#input")).toHaveValue(
        "Draft while reconnecting",
      );

      treeUnavailable = false;
      gate = Promise.withResolvers<void>();
      await page.goto(`${base}?shared#trees=&agent=${demo}`, {
        waitUntil: "domcontentloaded",
      });
      const chat = page.getByRole("tab", { name: "Chat", exact: true });
      await browserExpect(chat).toHaveAttribute("aria-selected", "true");
      expect(await states()).toEqual([[[["Chat", "true"]]]]);
    } finally {
      gate.resolve();
    }
  },
  // Regression: #3557 Closing a desktop tab focuses its neighbour without stealing focus for inactive tabs.
  async function test_tab_close_focuses_neighbour(browser, base) {
    const { demo } = await postFixture(base, "seed-image-navigation");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    try {
      await page.goto(`${base}#agent=${demo}`);
      const tab = (title: string) =>
        page.locator(`.dv-tab[aria-label="${title}"]`);
      const chat = tab("Chat");
      const group = page.locator(".dv-groupview").filter({ has: chat });
      const middle = tab("nav-1.png");
      const right = tab("nav-2.png");
      const openImage = async (name: string) => {
        await chat.click();
        await page.locator(`#messages img[alt="${name}"]`).click();
        await page
          .locator("dialog.image-popout")
          .getByRole("button", { name: "Open in Files" })
          .click();
        await page
          .locator(`.files-detail[aria-label="${name}"]:visible`)
          .waitFor();
      };
      const closeButton = async (title: string) => {
        await tab(title).hover();
        await tab(title)
          .getByRole("button", { name: `Close ${title}` })
          .click();
        await browserExpect(tab(title)).toHaveCount(0);
      };
      const result = () =>
        group.locator(".dv-active-tab").evaluate((tab) => {
          const doc = tab.ownerDocument;
          const panel = doc.querySelector(
            `.dock-panel[data-dock-panel="${tab.getAttribute("data-dock-panel")}"]`,
          );
          return {
            tab: tab.getAttribute("aria-label"),
            focused: !!panel?.contains(doc.activeElement),
          };
        });
      await openImage("nav-1.png");
      await openImage("nav-2.png");
      await browserExpect(group.locator(".dv-tab")).toHaveText([
        "Chat",
        "nav-1.png",
        "nav-2.png",
      ]);

      await chat.click();
      await middle.click();
      await closeButton("nav-1.png");
      await waitForLayout(page);
      const middleClosed = await result();

      await right.click();
      await page.keyboard.press("q");
      await browserExpect(right).toHaveCount(0);
      await waitForLayout(page);
      const lastClosed = await result();

      await openImage("nav-1.png");
      await openImage("nav-2.png");
      await closeButton("nav-1.png");
      await waitForLayout(page);
      const inactiveClosed = await result();
      expect({ middleClosed, lastClosed, inactiveClosed }).toEqual({
        middleClosed: { tab: "nav-2.png", focused: true },
        lastClosed: { tab: "Chat", focused: true },
        inactiveClosed: { tab: "nav-2.png", focused: true },
      });

      await openImage("nav-1.png");
      await middle.click({ button: "middle" });
      await browserExpect(middle).toHaveCount(0);
      await browserExpect
        .poll(result)
        .toEqual({ tab: "nav-2.png", focused: true });

      await openImage("nav-1.png");
      await right.click();
      const chatRail = page.locator('.rail-btn[data-pane="chat"]');
      await chatRail.focus();
      await browserExpect(chatRail).toBeFocused();
      await closeButton("nav-1.png");
      await browserExpect(right).toHaveClass(/dv-active-tab/);
      await browserExpect(chatRail).toBeFocused();

      await openImage("nav-1.png");
      const focusedRead = Promise.withResolvers<void>();
      const releaseRead = Promise.withResolvers<void>();
      await page.route(
        (url) =>
          url.pathname === `/api/conversations/${demo}` &&
          url.searchParams.has("focused"),
        async (route) => {
          focusedRead.resolve();
          await releaseRead.promise;
          await route.continue();
        },
      );
      try {
        await page.reload({ waitUntil: "domcontentloaded" });
        await focusedRead.promise;
        await browserExpect(middle).toHaveClass(/dv-active-tab/);
        await closeButton("nav-1.png");
        await browserExpect(right).toHaveClass(/dv-active-tab/);
        await browserExpect(
          page.locator('.files-detail[aria-label="nav-2.png"]'),
        ).toHaveCount(0);
      } finally {
        releaseRead.resolve();
      }
      await browserExpect
        .poll(result)
        .toEqual({ tab: "nav-2.png", focused: true });
    } finally {
      await page.close();
    }
  },
  // Regression: #3377 A live user row does not prevent the first publication from opening in Files.
  async function test_restores_conversation_window_layouts(browser, base) {
    const agent = "dock-layout-send";
    await postFixture(base, "seed-model-selection-error", {
      agent,
      model: "fauxordinary/faux-1",
    });
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    const { thread, focusThread, focused, arrange, tab, windowBox } =
      dockControls(page);
    const input = page.locator("#input");
    const explorer = page.locator('.pane-col[data-pane="explorer"]');
    const chatTab = tab("chat");
    const explorerTab = tab("explorer");
    const finderQuery = page.locator("#pane-finder-query");
    const finderDraft = "Keep this draft when Chat reopens from the finder";
    await page.goto(`${base}#agent=${agent}`);
    await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
    await waitForLayout(page);
    await input.fill("Reply only Docked chat can send.");
    await input.press("Enter");
    await page
      .locator(".msg.assistant")
      .filter({ hasText: "Docked chat can send." })
      .waitFor();
    const splitLayout = [["chat"], ["explorer"]];
    const tabbedLayout = [["chat", "explorer"]];
    const waitLayout = (expected: string[][]) =>
      page.waitForFunction((expected) => {
        const groups = [
          ...(globalThis as any).document.querySelectorAll(
            "#dock .dv-groupview",
          ),
        ].map((group: any) =>
          [...group.querySelectorAll(".dv-tab[data-dock-panel]")].map(
            (tab: any) => tab.dataset.dockPanel,
          ),
        );
        return JSON.stringify(groups.sort()) === JSON.stringify(expected);
      }, expected);
    const storedLayout = (
      owner: string,
      expected: string[][],
      maximized?: boolean,
      minChatWidth?: number,
    ) =>
      page.waitForFunction(
        ({ owner, expected, maximized, minChatWidth }) => {
          const storage = (globalThis as any).localStorage;
          return Object.keys(storage).some((key) => {
            if (!key.startsWith("recurse.conversationUiState.local.v1.slot."))
              return false;
            const record = JSON.parse(storage.getItem(key));
            if (record.owner !== owner) return false;
            const layout = record.panes?.["window-layout"]?.value;
            if (!layout?.grid) return false;
            if (
              maximized !== undefined &&
              Array.isArray(layout.grid.maximizedNode?.location) !== maximized
            )
              return false;
            const groups: string[][] = [];
            let chatWidth = 0;
            const visit = (node: any) => {
              if (node.type === "branch") node.data.forEach(visit);
              else {
                groups.push(node.data.views);
                if (node.data.views.includes("chat")) chatWidth = node.size;
              }
            };
            visit(layout.grid.root);
            return (
              JSON.stringify(groups.sort()) === JSON.stringify(expected) &&
              (minChatWidth === undefined || chatWidth > minChatWidth)
            );
          });
        },
        { owner, expected, maximized, minChatWidth },
      );
    const joinExplorer = async () => {
      const bounds = (await chatTab.boundingBox())!;
      await explorerTab.dragTo(chatTab, {
        targetPosition: { x: bounds.width - 2, y: bounds.height / 2 },
      });
      await waitLayout(tabbedLayout);
      await chatTab.locator(".dock-tab-icon").click();
    };
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await joinExplorer();
    await input.fill("B layout draft");
    await page.locator('.agent[data-id="main"]').click();
    await page.locator('.agent.selected[data-id="main"]').waitFor();
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await waitLayout(splitLayout);
    await page.locator(`.agent[data-id="${agent}"]`).click();
    await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
    await waitLayout(tabbedLayout);
    expect(await input.inputValue()).toBe("B layout draft");
    await storedLayout(agent, tabbedLayout);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout(tabbedLayout);
    await page.locator('.agent[data-id="main"]').click();
    await page.locator('.agent.selected[data-id="main"]').waitFor();
    await waitLayout(splitLayout);
    await storedLayout("main", splitLayout);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout(splitLayout);
    const liveSash = page
      .locator("#dock .dv-sash:visible:not([inert])")
      .first();
    await liveSash.waitFor();
    const widthBeforeSash = (await windowBox("chat")).width;
    const sash = (await liveSash.boundingBox())!;
    const sashX = sash.x + sash.width / 2;
    const sashY = sash.y + sash.height / 2;
    await page.mouse.move(sashX, sashY);
    await page.mouse.down();
    await page.mouse.move(sashX + 64, sashY, { steps: 3 });
    await page.mouse.up();
    await storedLayout("main", splitLayout, undefined, widthBeforeSash + 40);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout(splitLayout);
    expect((await windowBox("chat")).width).toBeGreaterThan(
      widthBeforeSash + 40,
    );
    await screenshot(page, "pane-hotkeys/1280-window-conversation-a");
    await page.locator(`.agent[data-id="${agent}"]`).click();
    await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
    await waitLayout(tabbedLayout);
    for (const kind of [
      "renderer",
      "legacy-renderer",
      "hidden-group",
      "hidden-window",
      "oversized",
    ]) {
      console.log("Window layout corruption:", kind);
      await storedLayout(
        agent,
        kind === "renderer" ? tabbedLayout : splitLayout,
      );
      await page.locator('.agent[data-id="main"]').click();
      await waitLayout(splitLayout);
      await page.evaluate(
        ({ owner, kind }) => {
          const storage = (globalThis as any).localStorage;
          for (const key of Object.keys(storage)) {
            if (!key.startsWith("recurse.conversationUiState.local.v1.slot."))
              continue;
            const record = JSON.parse(storage.getItem(key));
            if (record.owner !== owner) continue;
            const layout =
              record.panes?.["window-layout"]?.value ||
              (record.key === "window-layout" ? record.value : null);
            if (!layout?.panels?.explorer) continue;
            if (kind === "renderer")
              layout.panels.explorer.contentComponent = "unregistered-renderer";
            else if (kind === "legacy-renderer")
              layout.panels.explorer.view = {
                content: { id: "unregistered-renderer" },
                tab: { id: "tab" },
              };
            else if (kind === "oversized")
              layout.panels.explorer.title = "x".repeat(32_001);
            else {
              const nodes = [layout.grid.root];
              while (nodes.length) {
                const node = nodes.pop();
                if (node.type === "branch") nodes.push(...node.data);
                else if (
                  node.data.views.includes(
                    kind === "hidden-group" ? "explorer" : "chat",
                  )
                ) {
                  if (kind === "hidden-group") node.data.hideHeader = true;
                  else node.visible = false;
                }
              }
            }
            storage.setItem(key, JSON.stringify(record));
          }
        },
        { owner: agent, kind },
      );
      const response = await page.reload({ waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      await waitLayout(splitLayout);
      await page.locator(`.agent[data-id="${agent}"]`).click();
      await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
      await waitLayout(splitLayout);
      await thread.waitFor();
      await chatTab.waitFor();
      await explorerTab.waitFor();
      expect(await explorerTab.getAttribute("aria-label")).toBe("Explorer");
      await explorerTab.click();
      await chatTab.click();
    }
    await joinExplorer();
    await storedLayout(agent, tabbedLayout);
    await page.setViewportSize({ width: 390, height: 844 });
    await focused('.pane-col[data-pane="explorer"] .pane-title');
    await page.keyboard.press("o");
    await finderQuery.fill("Chat");
    await page.getByRole("option", { name: "Chat", exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await focused("#scroll");
    await explorer.waitFor({ state: "detached" });
    await page.keyboard.press("o");
    await finderQuery.fill("Chat");
    await page
      .getByRole("option", { name: "Chat Open", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator(".msg.assistant")
      .filter({ hasText: "Docked chat can send." })
      .waitFor();
    expect(await page.locator("#dock").count()).toBe(0);
    await input.fill("B layout draft");
    await input.evaluate((node: any) => node.setSelectionRange(2, 8));
    expect(
      await input.evaluate((node: any) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([2, 8]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitLayout(tabbedLayout);
    await focused("#input");
    expect(await input.inputValue()).toBe("B layout draft");
    expect(
      await input.evaluate((node: any) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([2, 8]);
    await screenshot(page, "pane-hotkeys/1280-window-conversation-b");
    const { demo: autoOwner } = await postFixture(base, "seed-files-auto-open");
    const publishAutomatic = async (gate?: string) =>
      (
        (await postFixture(base, "republish-auto-open", { gate })) as {
          draft: number;
        }
      ).draft;
    await page.locator(`.agent[data-id="${autoOwner}"]`).click();
    await page.locator('.rail-btn[data-pane="files"]').waitFor();
    const automaticFiles = page.locator(".pane-col.file-tab");
    expect(await automaticFiles.count()).toBe(0);
    await page
      .locator("#conv-title", { hasText: "Auto-opened files" })
      .waitFor();
    await page.keyboard.press("w");
    await page.keyboard.press("o");
    await storedLayout(autoOwner, [["chat"]], true);
    const autoHeading = automaticFiles.locator(
      ".files-detail .files-markdown h1",
    );
    const publishing = publishAutomatic("first-publication");
    await page.locator(".msg.user").nth(1).waitFor();
    await postFixture(base, "release", {
      agent: autoOwner,
      gate: "first-publication",
    });
    const autoFirst = await publishing;
    await autoHeading
      .filter({ hasText: `Draft ${autoFirst}` })
      .waitFor({ state: "attached" });
    for (let version = 0; version < 2; version++) {
      const latest = await publishAutomatic();
      await automaticFiles
        .locator('select[aria-label="Version"] option', {
          hasText: `Version ${latest}`,
        })
        .waitFor({ state: "attached" });
      expect(await autoHeading.textContent()).toBe(`Draft ${autoFirst}`);
      expect(await automaticFiles.count()).toBe(1);
      expect(await tab("chat").getAttribute("class")).toContain(
        "dv-active-tab",
      );
    }
    await page.keyboard.press("i");
    await focused("#input");
    await page.locator('.agent[data-id="main"]').click();
    await automaticFiles.waitFor({ state: "detached" });
    const autoFourth = await publishAutomatic();
    const autoResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/conversations/${autoOwner}?`) &&
        response.url().includes("focused=1"),
    );
    await page.locator(`.agent[data-id="${autoOwner}"]`).click();
    await page
      .getByRole("button", { name: "Open report.md in Files" })
      .nth(autoFourth - 1)
      .waitFor();
    await (await autoResponse).finished();
    expect(await automaticFiles.count()).toBe(0);
    await waitLayout([["chat"]]);
    await storedLayout(autoOwner, [["chat"]], true);
    await storedLayout(agent, tabbedLayout);
    await page.locator('.agent[data-id="main"]').click();
    await waitLayout(splitLayout);
    await page.locator('#dock .dv-tab[data-dock-panel="chat"] button').click();
    await page.locator(".dock-parking #main").waitFor({ state: "attached" });
    await storedLayout("main", [["explorer"]]);
    const storagePage = await context.newPage();
    const version = await storagePage.goto(`${base}api/version`);
    expect(version?.status()).toBe(200);
    expect(version?.headers()["content-type"]).toContain("application/json");
    await page.evaluate((agent) => {
      const browser = globalThis as any;
      browser.layoutStorageChanged = false;
      const changed = (event: any) => {
        if (
          event.key?.startsWith("recurse.conversationUiState.local.v1.slot.") &&
          event.newValue &&
          JSON.parse(event.newValue).owner === agent
        ) {
          browser.layoutStorageChanged = true;
          browser.removeEventListener("storage", changed);
        }
      };
      browser.addEventListener("storage", changed);
    }, agent);
    await storagePage.evaluate((agent) => {
      const storage = (globalThis as any).localStorage;
      for (const key of Object.keys(storage)) {
        if (!key.startsWith("recurse.conversationUiState.local.v1.slot."))
          continue;
        const record = JSON.parse(storage.getItem(key));
        if (record.owner !== agent) continue;
        const layout =
          record.panes?.["window-layout"]?.value ||
          (record.key === "window-layout" ? record.value : null);
        if (!layout?.panels?.explorer) continue;
        layout.panels.side = layout.panels.explorer;
        delete layout.panels.explorer;
        layout.panels.side.id = "side";
        layout.panels.side.title = "Side conversations";
        const nodes = [layout.grid.root];
        while (nodes.length) {
          const node = nodes.pop();
          if (node.type === "branch") nodes.push(...node.data);
          else {
            node.data.views = node.data.views.map((id: string) =>
              id === "explorer" ? "side" : id,
            );
            if (node.data.activeView === "explorer")
              node.data.activeView = "side";
          }
        }
        storage.setItem(key, JSON.stringify(record));
      }
    }, agent);
    await page.waitForFunction(() => (globalThis as any).layoutStorageChanged);
    await storagePage.close();
    await page.locator(`.agent[data-id="${agent}"]`).click();
    await page.locator(`.agent.selected[data-id="${agent}"]`).waitFor();
    await page
      .locator(".msg.assistant")
      .filter({ hasText: "Docked chat can send." })
      .waitFor({ state: "attached" });
    await thread.waitFor();
    await page.setViewportSize({ width: 1024, height: 800 });
    await storedLayout(agent, [["chat", "side"]]);
    await page.setViewportSize({ width: 1280, height: 800 });
    const fileFixture = (await postFixture(
      base,
      "seed-published-markdown",
    )) as {
      demo: string;
      id: string;
      payload: string;
    };
    const visitFiles = async (cid: string) => {
      await page.locator(`.agent[data-id="${cid}"]`).click();
      await page.waitForURL(`${base}#agent=${cid}`);
      await page
        .locator("#conv-freshness:not(.on)")
        .waitFor({ state: "attached" });
    };
    await visitFiles(fileFixture.demo);
    await page
      .getByRole("button", { name: "Open report.md in Files" })
      .waitFor();
    await focusThread();
    await arrange("v");
    await page.getByRole("button", { name: "Open report.md in Files" }).click();
    const filePane = page.locator(".pane-col.file-tab:visible");
    await filePane.locator(".files-markdown h1").waitFor();
    const filePanelId = (await filePane.getAttribute("data-pane"))!;
    const fileBody = await filePane.locator(".pane-body").elementHandle();
    const fileLayout = [["chat"], [filePanelId]].sort();
    await waitLayout(fileLayout);
    await page.getByRole("button", { name: "Open report.md in Files" }).click();
    expect(
      await filePane
        .locator(".pane-body")
        .evaluate((node, prior) => node === prior, fileBody),
    ).toBeTrue();
    expect(
      await filePane
        .getByRole("button", { name: "All files", exact: true })
        .count(),
    ).toBe(0);
    await storedLayout(fileFixture.demo, fileLayout);
    await page.reload();
    await filePane.locator(".files-markdown h1").waitFor();
    await waitLayout(fileLayout);
    expect((await windowBox(filePanelId)).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    await visitFiles("main");
    expect(await tab(filePanelId).count()).toBe(0);
    await visitFiles(fileFixture.demo);
    await filePane.locator(".files-markdown h1").waitFor();
    await waitLayout(fileLayout);
    await rename(fileFixture.payload, fileFixture.payload + ".missing");
    try {
      await visitFiles("main");
      await visitFiles(fileFixture.demo);
      const response = await fetch(
        `${base}api/conversations/${fileFixture.demo}/files`,
      );
      expect(response.status).toBe(200);
      expect(
        (await response.json()).files.map(
          (file: { name: string }) => file.name,
        ),
      ).toEqual(["diagram.svg"]);
      await page.reload();
      await page.locator('.rail-btn[data-pane="files"]').waitFor();
      await waitLayout(fileLayout);
      await filePane.getByText("File unavailable.", { exact: true }).waitFor();
      await storedLayout(fileFixture.demo, fileLayout);
    } finally {
      await rename(fileFixture.payload + ".missing", fileFixture.payload);
    }
    await visitFiles("main");
    await visitFiles(fileFixture.demo);
    await filePane.locator(".files-markdown h1").waitFor();
    await waitLayout(fileLayout);
    expect(await filePane.getAttribute("data-pane")).toBe(filePanelId);
    await screenshot(page, "pane-hotkeys/1280-window-published-files");
    await focusThread();
    await arrange("e");
    expect((await windowBox(filePanelId)).y).toBeGreaterThan(
      (await windowBox("chat")).y,
    );
    await arrange("t");
    await waitLayout([["chat", filePanelId]]);
    await tab(filePanelId).click();
    await arrange("q");
    await waitLayout([["chat"]]);
    const joinedChat = await tab("chat")
      .locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]")
      .elementHandle();
    const { demo: splitOwner } = await postFixture(
      base,
      "seed-published-versions",
    );
    await visitFiles(splitOwner);
    await waitLayout([["chat"]]);
    expect(
      await tab("chat")
        .locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]")
        .evaluate((node, prior) => node === prior, joinedChat),
    ).toBeTrue();
    await page
      .getByRole("button", { name: "Open report.md in Files" })
      .last()
      .click();
    await filePane.locator(".files-markdown h1").waitFor();
    const splitFile = (await filePane.getAttribute("data-pane"))!;
    await waitLayout([["chat", splitFile]]);
    await arrange("e");
    await waitLayout([["chat"], [splitFile]].sort());
    expect((await windowBox(splitFile)).x).toBeGreaterThan(
      (await windowBox("chat")).x,
    );
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await explorer.waitFor();
    await input.fill("Keep this draft when all panes close");
    await input.evaluate((node: any) => node.setSelectionRange(5, 9));
    await page.keyboard.press("Escape");
    await tab(splitFile).click();
    await arrange("o");
    await arrange("Shift+Q");
    await waitLayout([["chat"]]);
    expect(await page.locator("#dock .pane-col").count()).toBe(0);
    expect(await input.inputValue()).toBe(
      "Keep this draft when all panes close",
    );
    expect(
      await input.evaluate((node: any) => [
        node.selectionStart,
        node.selectionEnd,
      ]),
    ).toEqual([5, 9]);
    await storedLayout(splitOwner, [["chat"]], false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLayout([["chat"]]);
    await browserExpect(input).toHaveValue(
      "Keep this draft when all panes close",
    );
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await explorer.waitFor();
    await focusThread();
    await arrange("Shift+Q");
    await waitLayout([["chat"]]);
    await waitForLayout(page);
    expect(
      await thread.evaluate(
        (node: any) => node === (globalThis as any).document.activeElement,
      ),
    ).toBeTrue();
    await startNewAgent(page);
    await page.locator(".draft-row.cursor").waitFor();
    await input.fill(finderDraft);
    await input.press("Escape");
    await focusThread();
    await arrange("q");
    await chatTab.waitFor({ state: "detached" });
    await page.keyboard.press("o");
    await focused("#pane-finder-query");
    expect(await page.locator("#pane-finder .pane-option").count()).toBe(1);
    await page.getByRole("option", { name: "Chat", exact: true }).waitFor();
    await page.keyboard.press("Enter");
    await focused("#scroll");
    await chatTab.waitFor();
    expect(await input.inputValue()).toBe(finderDraft);
    await context.close();
  },
  // Regression: #3354 A closed desktop Chat must have a visible way back. (also Feature #3372 closed windows reopen where they were.)
  async function test_closed_chat_reopens(browser, base) {
    const { demo } = await postFixture(base, "seed-published-sizes");
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    const root = rootAgentId();
    await gotoRoot(page, base);
    await waitForLayout(page);
    const chatTab = page.locator('#dock .dv-tab[data-dock-panel="chat"]');
    const chatButton = page.locator(
      '#pane-rail-panels .rail-btn[data-pane="chat"]',
    );
    const parked = page.locator(".dock-parking #main");
    const focused = (selector: string) =>
      page.waitForFunction(
        (selector) =>
          (globalThis as any).document.activeElement?.matches(selector),
        selector,
      );
    const closeChat = async () => {
      await chatTab.getByRole("button").click();
      await parked.waitFor({ state: "attached" });
      await chatButton.and(page.locator('[aria-expanded="false"]')).waitFor();
    };
    const reopened = async () => {
      await page
        .locator('#dock .dock-panel[data-dock-panel="chat"] #main')
        .waitFor();
      await chatButton.and(page.locator('[aria-expanded="true"]')).waitFor();
    };
    expect(
      await page
        .locator("#pane-rail-panels .rail-btn")
        .first()
        .getAttribute("data-pane"),
    ).toBe("chat");
    expect(await chatButton.getAttribute("title")).toBe("Chat (g1)");
    await closeChat();
    expect(
      await chatButton.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return [
          [0, 0],
          [-21, 0],
          [21, 0],
          [0, -21],
          [0, 21],
        ].every(([dx, dy]) =>
          button.contains(
            button.ownerDocument.elementFromPoint(x + dx, y + dy),
          ),
        );
      }),
    ).toBeTrue();
    await screenshot(
      page,
      `header/${process.env.RECURSE_SCREENSHOT_STAGE || "after"}-1280x800-chat-closed`,
    );
    await chatButton.click();
    await reopened();
    await focused("#scroll");
    await page.keyboard.press("w");
    await page.keyboard.press("q");
    await parked.waitFor({ state: "attached" });
    await page.keyboard.press("g");
    await page.keyboard.press("1");
    await reopened();
    await focused("#scroll");
    await closeChat();
    await page.locator(`.agent[data-id="${root}"]`).click();
    await reopened();
    await closeChat();
    await page.locator("#new-top").click();
    await reopened();
    await focused("#input");
    await gotoRoot(page, base);
    await page.locator(`.agent.selected[data-id="${root}"]`).waitFor();
    await page.locator('.rail-btn[data-pane="explorer"]').click();
    await page.locator('#dock .dv-tab[data-dock-panel="explorer"]').waitFor();
    await closeChat();
    await page.reload();
    await page.locator('#dock .dv-tab[data-dock-panel="explorer"]').waitFor();
    await reopened();
    const tab = (id: string) =>
      page.locator(`#dock .dv-tab[data-dock-panel="${id}"]`);
    const tips = page.locator('#pane-rail .rail-btn[data-pane="tips"]');
    await tips.click();
    await tab("tips").waitFor();
    const windows = () =>
      page.evaluate(async () => {
        const win = globalThis as any;
        await new Promise((done) =>
          win.requestAnimationFrame(() => win.requestAnimationFrame(done)),
        );
        return [...win.document.querySelectorAll("#dock .dv-groupview")]
          .map((group: any) => {
            const { left, top, width, height } = group.getBoundingClientRect();
            const tabs = [...group.querySelectorAll(".dv-tab")];
            const ids = tabs.map((tab: any) => tab.dataset.dockPanel).join();
            return { ids, box: [left, top, width, height] as number[] };
          })
          .sort((a: any, b: any) => a.box[0] - b.box[0]);
      });
    const [first] = await windows();
    await tab("chat").click();
    await page.keyboard.type("wrlll");
    await page.keyboard.press("Enter");
    const placed = await windows();
    expect(placed[0]!.box[2]).toBeGreaterThan(first!.box[2]! + 20);
    const places = async () => {
      const now = await windows();
      const moved = now.some((window, index) =>
        window.box.some(
          (v, side) => Math.abs(v - placed[index]!.box[side]!) > 1,
        ),
      );
      return { ids: now.map((window) => window.ids), moved };
    };
    const unmoved = { ids: ["chat", "tips", "explorer"], moved: false };
    expect(await places()).toEqual(unmoved);
    await closeChat();
    await page.keyboard.type("g1");
    await reopened();
    expect(await places()).toEqual(unmoved);
    await tab("tips").getByRole("button").click();
    await tab("tips").waitFor({ state: "detached" });
    await tips.click();
    await tab("tips").waitFor();
    expect(await places()).toEqual(unmoved);
    for (const id of [demo, root]) {
      await closeChat();
      await page.locator(`.agent[data-id="${id}"]`).click();
      await page.locator(`.agent.selected[data-id="${id}"]`).waitFor();
      await reopened();
    }
    await tab("explorer").waitFor();
    expect(await places()).toEqual(unmoved);
    await closeChat();
    await tab("tips").getByRole("button").click();
    await tab("tips").waitFor({ state: "detached" });
    await chatButton.click();
    await reopened();
    expect((await places()).ids).toEqual(["chat", "explorer"]);
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["dock-layout", tests]]);
