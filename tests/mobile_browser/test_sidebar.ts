import { expect } from "bun:test";
import { join } from "node:path";
import { ROOT } from "./common";
import type { BrowserContext, Locator, Page, Request } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { captureErrors, gotoRoot, type BrowserTest } from "./common";

type Ids = Record<
  "fresh" | "stale" | "busy" | "archived" | "child" | "grandchild",
  string
>;
const seedSections = async (context: BrowserContext, base: string) => {
  const response = await context.request.post(
    `${base}__browser-test/seed-sidebar-sections`,
  );
  expect(response.ok()).toBe(true);
  const ids = (await response.json()) as Ids;
  const archived = await context.request.post(`${base}api/sidebar/tags`, {
    data: { ids: [ids.archived], set: { archived: null } },
  });
  expect(archived.ok()).toBe(true);
  return ids;
};
const sectionOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const doc = (globalThis as any).document;
    let section = null;
    for (const el of doc.querySelectorAll(
      "#agent-list .tree-section-header, #agent-list .agent",
    )) {
      if (el.dataset.section) section = el.dataset.section;
      else if (el.dataset.id === id) return section;
    }
    return null;
  }, id);
const header = (page: Page, title: string) =>
  page.locator(`.tree-section-header[data-section="${title}"]`);
const serverTags = async (context: BrowserContext, base: string, id: string) =>
  ((await (await context.request.get(`${base}api/tree`)).json()) as any[]).find(
    (row) => row.id === id,
  ).tags;

export const tests: BrowserTest[] = [
  // Feature: #2526 phone-only density must not override desktop sidebar styling.
  async function test_sidebar_compact_rows(browser, base) {
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const response = await context.request.post(
        `${base}__browser-test/seed-sidebar-compact`,
      );
      expect(response.ok()).toBe(true);
      const page = await context.newPage();
      await gotoRoot(page, base);
      if (width === 412) {
        await page.locator("#menu-btn").click();
        await page.waitForFunction(
          () =>
            (globalThis as any).document
              .querySelector("#sidebar")
              .getBoundingClientRect().x === 0,
        );
      }
      const rows = page.locator("#agent-list .agent");
      await page.waitForFunction(
        () =>
          (globalThis as any).document.querySelectorAll("#agent-list .agent")
            .length === 10,
      );
      await page.locator("#sidebar").evaluate(async () => {
        await (globalThis as any).document.fonts.ready;
      });
      if (process.env.RECURSE_SCREENSHOT_DIR)
        await page.screenshot({
          path: join(
            process.env.RECURSE_SCREENSHOT_DIR,
            `compact-sidebar-${width}.png`,
          ),
        });
      const boxes = await rows.evaluateAll((elements) =>
        elements.map((el) => {
          const rect = el.getBoundingClientRect();
          const style = (globalThis as any).getComputedStyle(
            el.querySelector(".title")!,
          );
          return {
            top: rect.top,
            height: rect.height,
            font: parseFloat(style.fontSize),
            padding: parseFloat(
              (globalThis as any).getComputedStyle(el).paddingTop,
            ),
          };
        }),
      );
      const desktopRowHeight = 12.15 * 1.6 + 2 * 4 + 2;
      for (const [index, box] of boxes.entries()) {
        if (width === 412) {
          expect(box.height).toBeGreaterThanOrEqual(44);
        } else {
          expect(box.height).toBeCloseTo(desktopRowHeight, 1);
        }
        expect(box.font).toBe(width === 412 ? 15 : 12.15);
        expect(box.padding).toBe(width === 412 ? 2 : 4);
        if (index) {
          const step = box.top - boxes[index - 1]!.top;
          if (width === 412) {
            expect(step).toBeGreaterThanOrEqual(boxes[index - 1]!.height);
          } else {
            expect(step).toBeCloseTo(desktopRowHeight + 1, 1);
          }
        }
      }
      const idleMarks = page.locator(
        "#agent-list .agent-state.idle .state-mark",
      );
      expect(await idleMarks.count()).toBeGreaterThan(0);
      for (const mark of await idleMarks.all()) {
        expect(
          await mark.evaluate((element) => {
            const style = (globalThis as any).getComputedStyle(element);
            return {
              background: style.backgroundColor,
              border: style.borderStyle,
              width: style.width,
            };
          }),
        ).toEqual({
          background: "rgba(0, 0, 0, 0)",
          border: "solid",
          width: "8px",
        });
      }
      const child = page.locator('.agent[data-id="compact-sidebar-0"]');
      await child.click({
        position: { x: (await child.boundingBox())!.width - 4, y: 16 },
      });
      await page
        .locator('.agent.selected[data-id="compact-sidebar-0"]')
        .waitFor();
      await context.close();
    }
  },
  // Regression: #2696 discovery before the home tree must not freeze empty ranks.
  async function test_sidebar_prefers_operator_messages_on_hourly_resort(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const now = Date.now();
    await page.clock.setFixedTime(now);
    const seed = async (phase: number) => {
      const response = await context.request.post(
        `${base}__browser-test/seed-sidebar-order`,
        {
          data: { phase },
        },
      );
      expect(response.ok()).toBe(true);
      return (await response.json()).operator_message_at as number;
    };
    await seed(0);
    await page.addInitScript(() => {
      (globalThis as any).addEventListener("recurse:backends-change", () => {
        (globalThis as any).backendDiscoveryFinished = true;
      });
    });
    await page.route("**/api/tree", async (route) => {
      const response = await route.fetch();
      await page.waitForFunction(
        () => (globalThis as any).backendDiscoveryFinished,
      );
      await route.fulfill({ response });
    });
    await page.goto(base);
    const rows = page.locator(
      '.agent[data-id="operator-recent"], .agent[data-id="agent-active"], .agent[data-id="no-operator"]',
    );
    const order = () =>
      rows.evaluateAll((elements) =>
        elements.map((el) => el.getAttribute("data-id")),
      );
    await page.locator('.agent[data-id="operator-recent"]').waitFor();
    expect(await order()).toEqual([
      "no-operator",
      "operator-recent",
      "agent-active",
    ]);
    await page.unrouteAll({ behavior: "wait" });
    const latest = await seed(1);
    await page.waitForResponse(async (response) => {
      if (!response.url().endsWith("/api/tree")) return false;
      const nodes = await response.json();
      return nodes.some(
        (node: any) =>
          node.id === "operator-recent" && node.operator_message_at === latest,
      );
    });
    expect(await order()).toEqual([
      "no-operator",
      "operator-recent",
      "agent-active",
    ]);
    await page.clock.setFixedTime(now + 3_600_001);
    await page.waitForFunction(() => {
      const ids = Array.from(
        (globalThis as any).document.querySelectorAll(".agent"),
        (el: any) => el.dataset.id,
      );
      return ids.indexOf("operator-recent") < ids.indexOf("no-operator");
    });
    expect(await order()).toEqual([
      "operator-recent",
      "no-operator",
      "agent-active",
    ]);
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.RECURSE_SCREENSHOT_DIR, "sidebar-1280.png"),
      });
    await context.close();
  },
  // Feature: #2869 shared tree links limit discovery and copy a subagent's root.
  async function test_shared_tree_links(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const response = await context.request.post(
      `${base}__browser-test/seed-shared-trees`,
    );
    expect(response.ok()).toBeTrue();
    const { ids } = (await response.json()) as { ids: string[] };
    const [first, child, second] = ids;
    const chosen = ids.slice(0, 4);
    const page = await context.newPage();
    const openSidebar = async () => {
      await page
        .locator("#sidebar[aria-hidden]")
        .waitFor({ state: "attached" });
      if (!(await page.locator("#sidebar.open").count()))
        await page.locator("#menu-btn").click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document
            .querySelector("#sidebar")
            .getBoundingClientRect().x === 0,
      );
    };
    await page.goto(`${base}#trees=${first},${second}`);
    await openSidebar();
    const rows = page.locator("#agent-list .agent");
    const rowIds = () =>
      rows.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-id")).sort(),
      );
    await page.locator(`.agent[data-id="${child}"]`).waitFor();
    expect(await rowIds()).toEqual([first, child, second].sort());
    expect(
      await page.locator(`.agent.selected[data-id="${first}"]`).count(),
    ).toBe(1);
    await page.locator(`.agent[data-id="${second}"]`).click();
    await openSidebar();
    await page.locator(`.agent[data-id="${ids[3]}"]`).waitFor();
    expect(await rowIds()).toEqual([first, second, ids[3]].sort());
    await page.locator(`.agent[data-id="${first}"]`).click();
    await openSidebar();
    expect(await page.locator("#new-top").isVisible()).toBeFalse();
    expect(await page.getByRole("button", { name: "Show all" }).count()).toBe(
      0,
    );
    await page.locator(`.agent[data-id="${child}"]`).click();
    await page
      .locator(`#conv-title`, { hasText: "Shared tree fixture 1" })
      .waitFor();
    expect(await page.locator("#shared-tree-status").innerText()).toBe(
      "2 shared conversations",
    );
    expect(
      new URLSearchParams(new URL(page.url()).hash.slice(1)).get("trees"),
    ).toBe(`${first},${second}`);
    await page.reload();
    await page
      .locator(`.agent.selected[data-id="${child}"]`)
      .waitFor({ state: "attached" });
    await openSidebar();
    await page.locator(`.agent.selected[data-id="${child}"]`).waitFor();
    expect(await rowIds()).toEqual([first, child, second].sort());
    await page.locator("#sidebar .agent.selected").click();
    await page.locator("#input").fill("@");
    await page.locator("#agent-finder.on").waitFor();
    const options = page.locator("#agent-menu .agent-option");
    expect(await options.count()).toBe(chosen.length - 1);
    const titles = await options.allTextContents();
    for (let index = 0; index < ids.length; index++)
      expect(
        titles.some((title) => title.includes(`Shared tree fixture ${index}`)),
      ).toBe(index < chosen.length && index !== 1);
    await page.locator("#input").fill("");
    await page.locator("#agent-finder.on").waitFor({ state: "detached" });
    await page.locator("#input").blur();
    await page.locator("#pane-fab").tap();
    await page.locator("#pane-menu.on").waitFor();
    const share = page.locator("#share-link-btn");
    const screenshotDir = process.env.RECURSE_SCREENSHOT_DIR;
    if (screenshotDir)
      await page.screenshot({ path: `${screenshotDir}/share-phone.png` });
    const phoneBox = (await share.boundingBox())!;
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.locator("#pane-rail > #share-link-btn").waitFor();
    if (screenshotDir)
      await page.screenshot({ path: `${screenshotDir}/share-desktop.png` });
    expect(await share.locator("svg").count()).toBe(1);
    expect(phoneBox.width).toBeGreaterThanOrEqual(44);
    expect(phoneBox.height).toBeGreaterThanOrEqual(44);
    expect(await share.getAttribute("title")).toBe("Share link");
    expect(await share.getAttribute("aria-label")).toBe("Share link");
    await share.click();
    await page
      .locator("#share-link-status", { hasText: "Link copied" })
      .waitFor();
    expect(await page.locator("#share-link-status").isVisible()).toBeTrue();
    await page.locator("#share-link-status").waitFor({ state: "hidden" });
    await page.evaluate(() =>
      (globalThis as any).navigator.clipboard.writeText("not a share link"),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#pane-fab").tap();
    await page
      .locator("#pane-menu.on > #share-link-btn:not([hidden])")
      .waitFor();
    await page
      .getByRole("menuitem", { name: "Share link", exact: true })
      .click();
    await page
      .locator("#share-link-status", { hasText: "Link copied" })
      .waitFor();
    expect(await page.locator("#pane-menu").isVisible()).toBeFalse();
    const copied = await page.evaluate(() =>
      (globalThis as any).navigator.clipboard.readText(),
    );
    expect(copied).toBe(`${base}#trees=${first}`);
    await page.goto(copied);
    await openSidebar();
    await page.locator(`.agent[data-id="${child}"]`).waitFor();
    expect(await rowIds()).toEqual([first, child].sort());
    await page.goto(`${base}#agent=${child}`);
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.locator("#pane-rail > #share-link-btn:not([hidden])").waitFor();
    await page.locator("#new-top").click();
    await page.locator(".draft-row.cursor").waitFor();
    expect(await share.getAttribute("hidden")).not.toBeNull();
    expect(await share.isVisible()).toBeFalse();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#input").blur();
    await page.locator("#pane-fab").tap();
    await page
      .locator("#pane-menu.on > #share-link-btn[hidden]")
      .waitFor({ state: "attached" });
    expect(await share.getAttribute("hidden")).not.toBeNull();
    expect(await share.isVisible()).toBeFalse();
    await page.locator("#pane-fab").tap();
    await openSidebar();
    await page.locator(`.agent[data-id="${first}"]`).click();
    await page.locator("#pane-fab").tap();
    await page
      .locator("#pane-menu.on > #share-link-btn:not([hidden])")
      .waitFor();
    await context.close();
  },
  // Feature: #2953 Inbox, Active and Archive sections with row actions.
  async function test_sidebar_sections(browser, base) {
    let context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const ids = await seedSections(context, base);
    const page = await context.newPage();
    const errors = captureErrors(page);
    await gotoRoot(page, base);
    await page.locator(`.agent[data-id="${ids.fresh}"]`).waitFor();
    expect(await sectionOf(page, ids.fresh)).toBe("Inbox");
    expect(await sectionOf(page, ids.stale)).toBe("Inbox");
    expect(await sectionOf(page, ids.busy)).toBe("Active");
    const archive = header(page, "Archive");
    const toggle = archive.locator(".tree-section-toggle");
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    const archived = Number(
      await archive.locator(".tree-section-count").innerText(),
    );
    expect(archived).toBeGreaterThanOrEqual(1);
    expect(
      await page.locator(`.agent[data-id="${ids.archived}"]`).count(),
    ).toBe(0);

    const fresh = page.locator(`.agent[data-id="${ids.fresh}"]`);
    const archiveFresh = fresh.getByRole("button", {
      name: "Archive Fresh idle",
    });
    const bounds = (locator: Locator) =>
      locator.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().toJSON()),
      );
    const content = fresh.locator(".title, .kids, .time");
    expect(await content.count()).toBe(3);
    expect(await page.locator("#agent-list .agent-model").count()).toBe(0);
    const rowHeight = (await fresh.boundingBox())!.height;
    const beforeHover = await bounds(content);
    expect(await archiveFresh.isVisible()).toBe(false);
    await fresh.hover();
    await archiveFresh.waitFor();
    for (const name of ["Snooze", "Pin"])
      expect(
        await fresh.getByRole("button", { name: `${name} Fresh idle` }).count(),
      ).toBe(1);
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.RECURSE_SCREENSHOT_DIR, "sections-desktop.png"),
      });
    expect(await bounds(content)).toEqual(beforeHover);
    for (const button of await fresh.locator(".row-actions button").all()) {
      expect(await button.getAttribute("title")).toBe(
        await button.getAttribute("aria-label"),
      );
      expect(
        await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const row = element.closest(".agent")!.getBoundingClientRect();
          const hit = element.ownerDocument.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return {
            inside:
              rect.left >= row.left + row.width / 2 &&
              rect.right <= row.right &&
              rect.top >= row.top &&
              rect.bottom <= row.bottom,
            uncovered: !!hit && element.contains(hit),
          };
        }),
      ).toEqual({ inside: true, uncovered: true });
    }
    await page.mouse.move(1200, 800);
    await fresh.focus();
    await archiveFresh.waitFor();
    expect(await bounds(content)).toEqual(beforeHover);
    await archiveFresh.click();
    await fresh.waitFor({ state: "detached" });
    await archive
      .locator(".tree-section-count", {
        hasText: new RegExp(`^${archived + 1}$`),
      })
      .waitFor();
    await browserExpect
      .poll(() => serverTags(context, base, ids.fresh))
      .toMatchObject({ archived: { by: "operator" } });

    await toggle.click();
    await fresh.waitFor();
    expect(await sectionOf(page, ids.fresh)).toBe("Archive");
    await fresh.hover();
    await fresh.getByRole("button", { name: "Restore Fresh idle" }).click();
    await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Inbox");
    await fresh.hover();
    await fresh.getByRole("button", { name: "Archive Fresh idle" }).click();
    await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Archive");
    await fresh.hover();
    await fresh.getByRole("button", { name: "Restore Fresh idle" }).click();
    await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Inbox");
    await browserExpect
      .poll(async () => (await serverTags(context, base, ids.fresh)).archived)
      .toBeUndefined();

    let releaseStale!: () => void;
    const staleHeld = new Promise<void>((resolve) => (releaseStale = resolve));
    let releaseLater!: () => void;
    const laterHeld = new Promise<void>((resolve) => (releaseLater = resolve));
    let pinnedRead!: () => void;
    const stale = new Promise<void>((resolve) => (pinnedRead = resolve));
    let staleTaken = false;
    let staleRequest: Request | undefined;
    const failedReads = new Set<Request>();
    let cancelled!: () => void;
    const staleCancelled = new Promise<void>(
      (resolve) => (cancelled = resolve),
    );
    page.on("requestfailed", (request) => {
      failedReads.add(request);
      if (request === staleRequest) cancelled();
    });
    await page.route(/\/api\/tree(\?|$)/, async (route) => {
      const response = await route.fetch();
      const rows = (await response.json()) as any[];
      if (staleTaken) await laterHeld;
      else if (rows.find((row) => row.id === ids.fresh)?.tags?.pinned) {
        staleTaken = true;
        staleRequest = route.request();
        if (failedReads.has(staleRequest)) cancelled();
        pinnedRead();
        for (const row of rows)
          if (row.id === ids.stale) row.title = "Stale read applied";
        await staleHeld;
        return route.fulfill({ response, json: rows });
      }
      await route.fulfill({ response });
    });
    let sendFirst!: () => void;
    const first = new Promise<void>((resolve) => (sendFirst = resolve));
    let sent = 0;
    let answers = 0;
    let secondAfterFirst = false;
    await page.route(/\/api\/sidebar\/tags$/, async (route) => {
      if (++sent === 1) {
        await first;
      } else {
        secondAfterFirst = answers === 1;
        await stale;
      }
      const response = await route.fetch();
      answers++;
      await route.fulfill({ response });
    });
    await fresh.hover();
    await fresh.getByRole("button", { name: "Pin Fresh idle" }).click();
    await fresh.hover();
    await fresh.getByRole("button", { name: "Unpin Fresh idle" }).click();
    sendFirst();
    await browserExpect.poll(() => answers).toBe(2);
    expect(secondAfterFirst).toBe(true);
    releaseStale();
    await staleCancelled;
    expect(await fresh.locator('[aria-label="Pin Fresh idle"]').count()).toBe(
      1,
    );
    releaseLater();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    expect((await serverTags(context, base, ids.fresh)).pinned).toBeUndefined();
    expect(await header(page, "Pinned").count()).toBe(0);
    await fresh.hover();
    await fresh.getByRole("button", { name: "Pin Fresh idle" }).click();
    await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Pinned");
    await fresh.click();
    await fresh.focus();
    for (const hover of [false, true]) {
      if (hover) await fresh.hover();
      else await page.mouse.move(1200, 800);
      const rowBox = (await fresh.boundingBox())!;
      const actionsBox = (await fresh.locator(".row-actions").boundingBox())!;
      expect(actionsBox.y - rowBox.y).toBeGreaterThanOrEqual(2);
      expect(
        rowBox.x + rowBox.width - actionsBox.x - actionsBox.width,
      ).toBeGreaterThanOrEqual(2);
      expect(
        rowBox.y + rowBox.height - actionsBox.y - actionsBox.height,
      ).toBeGreaterThanOrEqual(2);
    }
    await fresh.hover();
    await fresh.getByRole("button", { name: "Unpin Fresh idle" }).click();
    await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Inbox");
    await header(page, "Pinned").waitFor({ state: "detached" });

    const inbox = header(page, "Inbox");
    await page.mouse.move(1200, 800);
    await page.locator("#input").focus();
    const headerContent = inbox.locator(
      ".tree-section-toggle, .tree-section-title, .tree-section-count",
    );
    const beforeHeaderHover = await bounds(headerContent);
    await inbox.hover();
    expect(await bounds(headerContent)).toEqual(beforeHeaderHover);
    await page.mouse.move(1200, 800);
    await inbox.locator(".tree-section-toggle").focus();
    expect(await inbox.locator(".section-actions button").isVisible()).toBe(
      true,
    );
    expect(await bounds(headerContent)).toEqual(beforeHeaderHover);
    await inbox.getByRole("button", { name: "Archive idle > 1 day" }).click();
    const dialog = page.getByRole("dialog", {
      name: "Archive 1 conversation?",
    });
    await dialog.getByRole("button", { name: "Archive" }).click();
    await browserExpect.poll(() => sectionOf(page, ids.stale)).toBe("Archive");

    await fresh.hover();
    await fresh.getByRole("button", { name: "Snooze Fresh idle" }).click();
    await page
      .getByRole("dialog", { name: "Snooze until" })
      .getByRole("button", { name: "1 hour" })
      .click();
    await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Archive");
    await browserExpect
      .poll(async () => (await serverTags(context, base, ids.fresh)).snoozed)
      .toMatchObject({ until: browserExpect.any(Number) });
    await fresh.click({ position: { x: 50, y: rowHeight / 2 } });
    await browserExpect(fresh).toHaveClass(/selected/);
    await page.keyboard.press("Escape");
    await page.keyboard.press("r");
    const longTitle =
      "Coordinator reviewing desktop sidebar layout with a long conversation title";
    await fresh.locator(".rename-input").fill(longTitle);
    await fresh.locator(".rename-input").press("Enter");
    await browserExpect(fresh.locator(".title")).toHaveText(longTitle);
    await page.mouse.move(1200, 800);
    await page.locator("#input").focus();
    expect((await fresh.boundingBox())!.height).toBe(rowHeight);
    expect(
      await fresh.evaluate((element) => {
        const title = element.querySelector(".title")!;
        const titleBox = title.getBoundingClientRect();
        const metadata = [".kids", ".time"].map((selector) =>
          element.querySelector(selector)!.getBoundingClientRect(),
        );
        const style = (globalThis as any).getComputedStyle(title);
        return {
          truncated: title.scrollWidth > title.clientWidth,
          ellipsis: style.textOverflow,
          singleLine: metadata.every(
            (box) =>
              box.width > 0 &&
              Math.abs(
                box.y + box.height / 2 - titleBox.y - titleBox.height / 2,
              ) < 1,
          ),
          timeAtRight: metadata[1]!.right > metadata[0]!.right,
        };
      }),
    ).toEqual({
      truncated: true,
      ellipsis: "ellipsis",
      singleLine: true,
      timeAtRight: true,
    });
    if (process.env.RECURSE_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(
          process.env.RECURSE_SCREENSHOT_DIR,
          "sections-long-title.png",
        ),
      });
    await fresh.hover();
    expect((await fresh.boundingBox())!.height).toBe(rowHeight);
    expect(errors).toEqual([]);
    await context.close();

    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await phoneHold(context, base, await seedSections(context, base));
    await context.close();

    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await customScript(context, base, await seedSections(context, base));
  },
  // Regression: #3017 tag actions precede POST answers; agent tags need no poll.
  async function test_sidebar_tag_updates(browser, base, data) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const ids = await seedSections(context, base);
    for (let i = 0; i < 40; i++) {
      const response = await context.request.post(`${base}api/conversations`, {
        data: {},
      });
      expect(response.ok()).toBeTrue();
    }
    const settings = await (
      await context.request.get(`${base}api/sidebar/script`)
    ).json();
    const script = settings.default
      .replace("collapsed: true", "collapsed: false")
      .replace(
        "actions: stale.length ? [archiveStale] : [],",
        'actions: [ARCHIVE, PIN].map(a => ({...a, label: a.label + " all", rows: inbox})),',
      )
      .replace(
        "rowActions: [RESTORE],",
        'rowActions: [RESTORE], actions: [{...RESTORE, label: "Restore all", rows: archive}],',
      )
      .replace(
        "rowActions: [PIN],",
        'rowActions: [PIN], actions: [{...SNOOZE, label: "Snooze all", rows: inbox}],',
      );
    expect(
      (
        await context.request.post(
          `${base}__browser-test/save-sidebar-script`,
          { data: { script, by: "operator" } },
        )
      ).ok(),
    ).toBeTrue();
    const page = await context.newPage();
    await page.clock.install();
    await gotoRoot(page, base);
    const row = page.locator(`.agent[data-id="${ids.fresh}"]`);
    await row.waitFor();
    await header(page, "Inbox")
      .getByRole("button", {
        name: "Archive all",
        exact: true,
        includeHidden: true,
      })
      .waitFor({ state: "attached" });
    const checkSection = (title: string) =>
      browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe(title);
    const act = async (action: string, bulk: boolean) => {
      if (bulk) {
        const section = header(
          page,
          action === "Restore"
            ? "Archive"
            : action === "Snooze"
              ? "Active"
              : "Inbox",
        );
        await section.hover();
        await section
          .getByRole("button", { name: `${action} all`, exact: true })
          .click();
      } else {
        await row.hover();
        await row
          .getByRole("button", { name: `${action} Fresh idle`, exact: true })
          .click();
      }
      if (action === "Snooze")
        await page
          .getByRole("dialog", { name: "Snooze until" })
          .getByRole("button", { name: "1 hour", exact: true })
          .click();
      if (bulk)
        await page
          .locator("#sidebar-popover")
          .getByRole("button", { name: action, exact: true })
          .click();
    };
    for (const bulk of [false, true]) {
      for (const [action, destination] of [
        ["Archive", "Archive"],
        ["Restore", "Inbox"],
        ["Pin", "Pinned"],
        ["Snooze", "Archive"],
        ["Restore", "Inbox"],
      ]) {
        if (action === "Snooze") {
          if (bulk) {
            const all = await (
              await context.request.get(`${base}api/tree`)
            ).json();
            expect(
              (
                await context.request.post(`${base}api/sidebar/tags`, {
                  data: {
                    ids: all.map((node: any) => node.id),
                    clear: ["pinned"],
                  },
                })
              ).ok(),
            ).toBeTrue();
            await checkSection("Inbox");
          } else {
            await row.hover();
            await row
              .getByRole("button", { name: "Unpin Fresh idle", exact: true })
              .click();
            await checkSection("Inbox");
          }
        }
        await beforeTagAnswer(
          page,
          () => act(action!, bulk),
          async () => {
            await checkSection(destination!);
            if (bulk) {
              const count = Number(
                await header(page, destination!)
                  .locator(".tree-section-count")
                  .innerText(),
              );
              expect(count).toBeGreaterThanOrEqual(40);
            }
          },
        );
      }
    }
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const proc = Bun.spawn(
      [
        process.execPath,
        join(ROOT, "tools/subagent.ts"),
        "tag",
        ids.fresh,
        "--add",
        "needs-review",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CHAT_DATA_DIR: join(data, "data"),
          RECURSE_HOME: join(data, "settings"),
          RECURSE_AGENT_ID: ids.fresh,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    await row.locator('[title="Tag: needs-review"]').waitFor();
    await context.close();
  },
];

async function beforeTagAnswer(
  page: Page,
  act: () => Promise<void>,
  check: () => Promise<void>,
): Promise<void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const requested = new Promise<void>((resolve) => (arrived = resolve));
  const pattern = /\/api\/sidebar\/tags$/;
  const handler = async (route: import("playwright").Route) => {
    arrived();
    await held;
    await route.continue();
  };
  await page.route(pattern, handler);
  try {
    await act();
    await requested;
    await check();
  } finally {
    const answered = page.waitForResponse((response) =>
      pattern.test(response.url()),
    );
    release();
    await answered;
    await page.unroute(pattern, handler);
  }
}

async function customScript(
  context: BrowserContext,
  base: string,
  ids: Ids,
): Promise<void> {
  const script = [
    "export default function sidebar(rows) {",
    '  if (rows.some((r) => r.tags.boom)) throw new Error("boom");',
    "  return [",
    `    { title: "Mine", rows: rows.filter((r) => r.id === "${ids.fresh}") },`,
    `    { title: "Has PR", rows: rows.filter((r) => r.parent === "${ids.fresh}" && r.depth === 1 && r.prs.some((pr) => pr.number === 42 && pr.checks === "pass" && !pr.merged)) },`,
    `    { title: "Others", rows: rows.filter((r) => r.depth === 0 && r.id !== "${ids.fresh}") },`,
    "  ];",
    "}",
  ].join("\n");
  const saved = await context.request.post(
    `${base}__browser-test/save-sidebar-script`,
    { data: { script, by: ids.fresh } },
  );
  expect(await saved.json()).toMatchObject({
    sections: [
      { title: "Mine", rows: 1 },
      { title: "Has PR", rows: 1 },
      { title: "Others" },
    ],
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await gotoRoot(page, base);
  await header(page, "Mine").waitFor();
  expect(await sectionOf(page, ids.fresh)).toBe("Mine");
  expect(await sectionOf(page, ids.stale)).toBe("Others");
  await page.locator(`.agent[data-id="${ids.child}"]`).waitFor();
  expect(await sectionOf(page, ids.child)).toBe("Has PR");
  expect(await page.locator(`.agent[data-id="${ids.child}"]`).count()).toBe(1);
  const prChild = page.locator(`.agent[data-id="${ids.child}"]`);
  await prChild.click();
  const grandchild = page.locator(`.agent[data-id="${ids.grandchild}"]`);
  await grandchild.waitFor();
  expect(await sectionOf(page, ids.grandchild)).toBe("Has PR");
  await prChild.focus();
  await page.keyboard.press("h");
  await browserExpect(prChild).toHaveAttribute("aria-expanded", "false");
  await grandchild.waitFor({ state: "detached" });
  await page.keyboard.press("l");
  await grandchild.waitFor();
  await grandchild.click();
  expect(await sectionOf(page, ids.grandchild)).toBe("Has PR");
  const notice = page.locator("#sidebar-script-notice");
  await notice.getByText("Changed by Fresh idle").waitFor();
  await notice.getByRole("button", { name: "Diff" }).click();
  const settings = page.getByRole("region", { name: "Sidebar", exact: true });
  await settings.getByText("Custom script").waitFor();
  await settings.getByText("Experimental", { exact: true }).waitFor();
  await settings
    .locator(".sidebar-script-text .add", { hasText: 'title: "Mine"' })
    .waitFor();
  await page.locator("#settings-close").click();
  await notice.waitFor({ state: "hidden" });

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/static\/sidebar-worker\.js/, async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  await header(page, "Mine").waitFor();
  expect(await header(page, "Inbox").count()).toBe(0);
  release();

  const boom = await context.request.post(`${base}api/sidebar/tags`, {
    data: { ids: [ids.fresh], set: { boom: null } },
  });
  expect(boom.ok()).toBe(true);
  const banner = notice.getByRole("alert");
  await banner
    .getByText("Sidebar script failed: Error: boom (line 2)")
    .waitFor();
  await header(page, "Inbox").waitFor();
  expect(await header(page, "Mine").count()).toBe(0);
  await banner.getByRole("button", { name: "Use default" }).click();
  await notice.waitFor({ state: "hidden" });
  const after = await context.request.get(`${base}api/sidebar/script`);
  expect((await after.json()).script).toBeNull();
  expect(errors).toEqual([]);
  await context.close();
}

async function phoneHold(
  context: BrowserContext,
  base: string,
  ids: Ids,
): Promise<void> {
  const page = await context.newPage();
  const errors = captureErrors(page);
  await gotoRoot(page, base);
  await page.locator("#menu-btn").click();
  await page.waitForFunction(
    () =>
      (globalThis as any).document
        .querySelector("#sidebar")
        .getBoundingClientRect().x === 0,
  );
  const touch = await context.newCDPSession(page);
  const send = (
    type: "touchStart" | "touchMove" | "touchEnd",
    x?: number,
    y?: number,
  ) =>
    touch.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: x === undefined ? [] : [{ x, y: y! }],
    });
  const center = async (locator: Locator) => {
    const box = (await locator.boundingBox())!;
    return [box.x + box.width / 2, box.y + box.height / 2] as const;
  };
  const menu = page.locator("#hold-menu");
  const hold = async (id: string) => {
    const [x, y] = await center(page.locator(`.agent[data-id="${id}"]`));
    await send("touchStart", x, y);
    await menu.getByRole("menu").waitFor();
    return [x, y] as const;
  };

  const fresh = page.locator(`.agent[data-id="${ids.fresh}"]`);
  await fresh.waitFor();
  const archived = Number(
    await header(page, "Archive").locator(".tree-section-count").innerText(),
  );
  const [x, y] = await hold(ids.fresh);
  const buttons = menu.getByRole("menuitem");
  expect(
    await buttons.evaluateAll((els) => els.map((el) => el.ariaLabel)),
  ).toEqual(["Archive", "Snooze", "Pin", "Rename"]);
  for (const box of await buttons.evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().toJSON()),
  )) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await send("touchMove", x, y - 20);
  await send("touchMove", x + 200, y + 200);
  const [ax, ay] = await center(
    menu.getByRole("menuitem", { name: "Archive" }),
  );
  await send("touchMove", ax, ay);
  await menu.locator(".hold-bubble", { hasText: "Archive" }).waitFor();
  if (process.env.RECURSE_SCREENSHOT_DIR)
    await page.screenshot({
      path: join(process.env.RECURSE_SCREENSHOT_DIR, "sections-phone.png"),
    });
  await send("touchEnd");
  await fresh.waitFor({ state: "detached" });
  await header(page, "Archive")
    .locator(".tree-section-count", {
      hasText: new RegExp(`^${archived + 1}$`),
    })
    .waitFor();
  await browserExpect
    .poll(() => serverTags(context, base, ids.fresh))
    .toMatchObject({ archived: { by: "operator" } });

  const stale = page.locator(`.agent[data-id="${ids.stale}"]`);
  const [sx, sy] = await hold(ids.stale);
  await send("touchMove", sx, sy + 150);
  await send("touchEnd");
  await menu.getByRole("menu").waitFor({ state: "detached" });
  expect(await sectionOf(page, ids.stale)).toBe("Inbox");
  expect(await serverTags(context, base, ids.stale)).toEqual({});
  expect(await page.locator(".rename-input").count()).toBe(0);

  await hold(ids.stale);
  await send("touchEnd");
  await menu.getByRole("menuitem", { name: "Rename" }).tap();
  await stale.locator(".rename-input").fill("Renamed by hold");
  await stale.locator(".rename-input").press("Enter");
  await stale.locator(".title", { hasText: "Renamed by hold" }).waitFor();
  expect(errors).toEqual([]);
  await context.close();
}
