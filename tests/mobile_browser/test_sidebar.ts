import { expect } from "bun:test";
import { assertSectionSpacing } from "./sidebar_section_spacing";
import type { BrowserContext, Locator, Request } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  captureErrors,
  expectHitCorners,
  gotoRoot,
  openPage,
  postFixture,
  rootAgentId,
  screenshot,
  showAgentList,
  startServer,
  stopServer,
  type BrowserTest,
} from "./common";
import {
  edgesUncovered,
  header,
  sectionOf,
  seedSections,
  serverTags,
  type SidebarSectionIds,
} from "./sidebar_support";

export const tests: BrowserTest[] = [
  // Feature: #3707 phone swipes use script order and keep deletion deliberate.
  async function test_sidebar_swipe_actions(browser) {
    for (const width of [390, 412]) {
      const server = await startServer();
      const { base } = server;
      const context = await browser.newContext({
        viewport: { width, height: 840 },
        isMobile: true,
        hasTouch: true,
        colorScheme: width === 390 ? "light" : "dark",
        reducedMotion: width === 390 ? "reduce" : "no-preference",
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      try {
        const ids = await seedSections(context, base);
        const fresh = page.locator(
          `#agent-list .agent[data-id="${ids.fresh}"]`,
        );
        const tray = fresh.getByRole("group", { name: "Swipe actions" });
        const button = (name: string) =>
          tray.getByRole("button", { name, exact: true });
        const unread = fresh.locator(".agent-unread");
        await gotoRoot(page, base);
        await showAgentList(page);
        const touch = await context.newCDPSession(page);
        const drag = async (
          side: "left" | "right",
          full = false,
          checkBadge = false,
        ) => {
          await fresh.scrollIntoViewIfNeeded();
          const box = (await fresh.boundingBox())!;
          const x = side === "left" ? box.x + box.width - 16 : box.x + 16;
          const y = box.y + box.height / 2;
          const distance = checkBadge
            ? box.width - 32
            : full
              ? box.width * 0.7
              : side === "left"
                ? 115
                : 78;
          const dx = side === "left" ? -distance : distance;
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{ x, y }],
          });
          for (const part of [0.3, 0.6, 1])
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: x + part * dx, y }],
            });
          if (checkBadge) {
            expect(
              await fresh.evaluate((row) => {
                const tray = row.querySelector(".swipe-full")!;
                const badge = row.querySelector(".kids")!;
                const { left, right, x, y, width, height } =
                  badge.getBoundingClientRect();
                const hit = row.ownerDocument.elementFromPoint(
                  x + width / 2,
                  y + height / 2,
                );
                const strip = tray.getBoundingClientRect();
                return (
                  tray.querySelectorAll(".swipe-labelled").length === 3 &&
                  badge.contains(hit) &&
                  (strip.right <= left || strip.left >= right)
                );
              }),
            ).toBeTrue();
          }
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        };
        const expectActions = async (names: string[]) => {
          await browserExpect(tray.getByRole("button")).toHaveCount(
            names.length,
          );
          await browserExpect(tray).not.toHaveAttribute("inert", "");
          for (const [i, name] of names.entries()) {
            await browserExpect(
              tray.getByRole("button").nth(i),
            ).toHaveAccessibleName(name);
            await expectHitCorners(button(name), 44, { scroll: false });
          }
        };
        const readTree = async () => {
          const response = await context.request.get(`${base}api/tree`);
          expect(response.ok()).toBeTrue();
          return (await response.json()) as { id: string; unread: boolean }[];
        };
        const readMarks = async () => {
          const tree = await readTree();
          return [ids.fresh, ids.child].map(
            (id) => tree.find((row) => row.id === id)?.unread,
          );
        };

        await drag("left");
        if (width === 412) {
          expect(
            await fresh.evaluate(async (el) => {
              const row = el.querySelector(".row1")!;
              const tray = el.querySelector(".swipe-tray")!;
              for (;;) {
                if (
                  row.getBoundingClientRect().right >
                  tray.getBoundingClientRect().left
                )
                  return false;
                if (!el.getAnimations().length) return true;
                await new Promise<void>((resolve) =>
                  el.ownerDocument.defaultView!.requestAnimationFrame(() =>
                    resolve(),
                  ),
                );
              }
            }),
          ).toBeTrue();
        }
        await expectActions(["Archive", "Delete", "More"]);
        await browserExpect
          .poll(() =>
            fresh.locator(".title, .kids").evaluateAll((elements) =>
              elements.map((el) => {
                const box = el.getBoundingClientRect();
                return el.contains(
                  el.ownerDocument.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2,
                  ),
                );
              }),
            ),
          )
          .toEqual([true, true]);
        await screenshot(page, `sidebar-left-${width}`);
        await button("More").tap();
        await browserExpect(
          page.getByRole("menuitem", { name: "Rename" }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await drag("left");
        await button("Delete").tap();
        const confirm = page.getByRole("dialog", {
          name: "Delete Fresh idle and all its subagents?",
        });
        await browserExpect(
          confirm.getByRole("button", { name: "Cancel" }),
        ).toBeFocused();
        expect(
          (await readTree()).some((row) => row.id === ids.fresh),
        ).toBeTrue();
        await confirm.getByRole("button", { name: "Cancel" }).tap();
        await drag("left", true);
        await browserExpect
          .poll(() => serverTags(context, base, ids.fresh))
          .toHaveProperty("archived");
        await browserExpect(fresh).toHaveCount(0);
        await header(page, "Archive").getByRole("button").tap();
        await drag("left");
        await button("Restore").tap();
        await browserExpect
          .poll(() => sectionOf(page, ids.fresh))
          .toBe("Inbox");

        await drag("right");
        await expectActions(["Unread", "Pin"]);
        await screenshot(page, `sidebar-right-${width}`);
        await button("Unread").tap();
        await browserExpect(unread).toBeVisible();
        await browserExpect.poll(readMarks).toEqual([true, false]);
        await page.reload();
        await showAgentList(page);
        await browserExpect(unread).toBeVisible();
        await drag("right");
        await button("Read").tap();
        await browserExpect(unread).toHaveCount(0);
        await browserExpect.poll(readMarks).toEqual([false, false]);

        const customize = async (fullSwipe: boolean) => {
          const title = fullSwipe
            ? `Confirm-delete swipes on ${width}`
            : `Swipe actions on ${width}`;
          const script = `export default rows => [{ title: ${JSON.stringify(title)},
            rows: rows.filter(row => row.id === ${JSON.stringify(ids.fresh)}),
            rowActions: [
              { label: "Delete", do: "delete", swipe: "left"${fullSwipe ? ", fullSwipe: true" : ""} },
              { label: "Flag", set: "flagged", swipe: "left" },
              { label: "Review this later", set: "review-later", swipe: "left" },
              { label: "Pin to top", icon: "pin", set: "pinned", swipe: "right", swipeOnly: true },
              { label: "Check replies", set: "check-replies", swipe: "right", swipeOnly: true },
              { label: "Ask me later", set: "ask-later", swipe: "right", swipeOnly: true },
            ],
          }];`;
          await postFixture(base, "save-sidebar-script", {
            script,
            by: "operator",
          });
          await page.reload();
          await showAgentList(page);
          await header(page, title).waitFor();
        };
        await customize(false);
        await drag("left", true);
        await expectActions(["Delete", "Flag", "Review this later"]);
        await browserExpect(button("Flag")).toHaveText("Flag");
        await browserExpect(button("Review this later")).toHaveText(
          "Review this later",
        );
        await screenshot(page, `sidebar-custom-${width}`);
        await browserExpect(confirm).toHaveCount(0);
        await button("Flag").tap();
        await browserExpect
          .poll(() => serverTags(context, base, ids.fresh))
          .toHaveProperty("flagged");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await drag("right", true, true);
        await browserExpect
          .poll(() => serverTags(context, base, ids.fresh))
          .toHaveProperty("pinned");
        await fresh
          .getByRole("button", { name: "Actions for Fresh idle" })
          .press("Enter");
        await browserExpect(
          page.getByRole("menuitem", { name: "Flag" }),
        ).toHaveText("Flag");
        await page.keyboard.press("Escape");
        await customize(true);
        await drag("left", true);
        await browserExpect(confirm).toBeVisible();
        await browserExpect(fresh).toBeVisible();
        const deleteAgent = confirm.getByRole("button", {
          name: "Delete agent",
        });
        await deleteAgent.press("Enter");
        await browserExpect(confirm).toBeVisible();
        const box = (await deleteAgent.boundingBox())!;
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            { x: box.x + box.width / 2, y: box.y + box.height / 2 },
          ],
        });
        await page
          .locator(".hold-tip.on", { hasText: "Tap to confirm deletion" })
          .waitFor();
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await browserExpect(confirm).toBeHidden();
        await browserExpect(fresh).toBeVisible();
        await drag("left", true);
        await deleteAgent.tap();
        await browserExpect(fresh).toHaveCount(0);
        await browserExpect
          .poll(async () =>
            (await readTree()).some((row) =>
              [ids.fresh, ids.child].includes(row.id),
            ),
          )
          .toBe(false);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await stopServer(server);
      }
    }
  },
  // Feature: #3371 edge drops choose a sibling parent without promising sibling order.
  async function test_sidebar_drag_parent(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 900 },
    });
    const saved = await (
      await context.request.get(`${base}api/sidebar/script`)
    ).json();
    const ids = await seedSections(context, base);
    const response = await context.request.post(`${base}api/conversations`, {
      data: { parent: ids.fresh },
    });
    expect(response.ok()).toBeTrue();
    const second = (await response.json()).id as string;
    await postFixture(base, "save-sidebar-script", {
      script: `export default rows => [{ title: "Agents", rows: ${JSON.stringify([ids.fresh, ids.busy, ids.stale, ids.archived])}.map(id => rows.find(r => r.id === id && r.depth === 0)).filter(Boolean) }];`,
      by: "operator",
    });
    await gotoRoot(page, base);
    const row = (id: string) =>
      page.locator(`#agent-list .agent[data-id="${id}"]`);
    const expand = async (id: string) => {
      await row(id).click();
      await row(id).focus();
      if ((await row(id).getAttribute("aria-expanded")) === "false")
        await page.keyboard.press("l");
    };
    const parentOf = async (id: string) =>
      (
        (await (await context.request.get(`${base}api/tree`)).json()) as any[]
      ).find((n) => n.id === id)?.parent;
    const inset = (target: Locator) =>
      target.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return [
          [box.left + 6, box.top + 6],
          [box.right - 6, box.top + 6],
          [box.left + 6, box.bottom - 6],
          [box.right - 6, box.bottom - 6],
        ].every(([x, y]) =>
          element.contains(element.ownerDocument.elementFromPoint(x!, y!)),
        );
      });
    const start = async (source: string, target: Locator, edge: boolean) => {
      expect(await inset(row(source))).toBeTrue();
      expect(await inset(target)).toBeTrue();
      const from = (await row(source).boundingBox())!;
      const to = (await target.boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        from.x + from.width / 2 + 8,
        from.y + from.height / 2,
        { steps: 4 },
      );
      const y = to.y + (edge ? -0.5 : to.height / 2);
      await page.mouse.move(to.x + to.width / 2, y, { steps: 12 });
      await page.mouse.move(to.x + to.width / 2 + 1, y);
    };
    const left = (target: Locator) =>
      target.evaluate((element) => element.getBoundingClientRect().left);
    const line = page.locator(".agent-drop-line");
    await header(page, "Agents").waitFor();
    await expand(ids.fresh);
    await row(second).waitFor();
    const children = page.locator('#agent-list .agent[aria-level="2"]');
    expect(await children.count()).toBe(2);
    const lower = children.nth(1);
    const childBox = (await lower.boundingBox())!;
    const aboveBox = (await children.nth(0).boundingBox())!;
    expect(childBox.y).toBeGreaterThan(aboveBox.y);
    await start(ids.busy, lower, true);
    await line.waitFor();
    expect(await left(line)).toBeCloseTo(await left(lower.locator(".row1")), 0);
    expect(await page.locator(".drop-ok").count()).toBe(0);
    await screenshot(page, "sidebar/sidebar-sibling-insertion");
    await page.mouse.up();
    await browserExpect.poll(() => parentOf(ids.busy)).toBe(ids.fresh);
    await browserExpect(row(ids.busy)).toHaveAttribute("aria-level", "2");
    expect(await left(row(ids.busy).locator(".row1"))).toBeCloseTo(
      await left(row(second).locator(".row1")),
      0,
    );
    await start(ids.busy, row(ids.child), false);
    await browserExpect(row(ids.child)).toHaveClass(/drop-ok/);
    expect(await line.count()).toBe(0);
    await page.mouse.up();
    await browserExpect.poll(() => parentOf(ids.busy)).toBe(ids.child);
    await browserExpect(row(ids.busy)).toHaveAttribute("aria-level", "3");
    expect(await left(row(ids.busy).locator(".row1"))).toBeGreaterThan(
      await left(row(ids.child).locator(".row1")),
    );
    await start(ids.busy, row(ids.archived), true);
    await line.waitFor();
    expect(await left(line)).toBeCloseTo(
      await left(row(ids.archived).locator(".row1")),
      0,
    );
    await page.mouse.up();
    await browserExpect.poll(() => parentOf(ids.busy)).toBeNull();
    await browserExpect(row(ids.busy)).toHaveAttribute("aria-level", "1");
    expect(await left(row(ids.busy).locator(".row1"))).toBeCloseTo(
      await left(row(ids.stale).locator(".row1")),
      0,
    );
    await expand(ids.fresh);
    await expand(ids.child);
    for (const [target, edge] of [
      [ids.child, false],
      [ids.grandchild, true],
    ] as const) {
      await start(ids.fresh, row(target), edge);
      await browserExpect(
        page.locator(edge ? ".agent-drop-line.invalid" : ".drop-bad"),
      ).toBeVisible();
      await page.mouse.up();
      expect(await parentOf(ids.fresh)).toBeNull();
      expect(await parentOf(ids.child)).toBe(ids.fresh);
    }
    await start(ids.busy, header(page, "Agents"), false);
    expect(await page.locator(".drop-ok, .agent-drop-line").count()).toBe(0);
    await page.mouse.up();
    expect(await parentOf(ids.busy)).toBeNull();
    expect(errors).toEqual([]);
    for (const id of [ids.fresh, ids.busy, ids.stale, ids.archived]) {
      const response = await context.request.delete(
        `${base}api/conversations/${id}`,
      );
      expect(response.ok()).toBeTrue();
      await browserExpect.poll(() => parentOf(id)).toBeUndefined();
    }
    await postFixture(base, "save-sidebar-script", {
      script: saved.script,
      by: "operator",
    });
    await context.close();
  },
  // Feature: #2526 phone-only density must not override desktop sidebar styling.
  async function test_sidebar_compact_rows(browser, base) {
    for (const width of [412, 1280]) {
      const { context, page } = await openPage(browser, {
        viewport: { width, height: 915 },
        touch: width === 412,
      });
      const response = await context.request.post(
        `${base}__browser-test/seed-sidebar-compact`,
      );
      expect(response.ok()).toBe(true);
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
      await screenshot(page, `sidebar/compact-sidebar-${width}`);
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
      if (width === 412) {
        await page.locator("#menu-btn").click();
        await page.waitForFunction(
          () =>
            (globalThis as any).document
              .querySelector("#sidebar")
              .getBoundingClientRect().x === 0,
        );
      }
      const created = await context.request.post(`${base}api/conversations`, {
        data: { title: "Empty section example" },
      });
      expect(created.ok()).toBeTrue();
      const { id } = await created.json();
      const example = page.locator(`.agent[data-id="${id}"]`);
      await example.waitFor();
      const titles = () =>
        page.locator("#agent-list .tree-section-title").allTextContents();
      expect(await titles()).toEqual(["Inbox"]);
      await screenshot(page, `sidebar/empty-sections-hidden-${width}`);
      const pin = async (pinned: boolean) => {
        const response = await context.request.post(`${base}api/sidebar/tags`, {
          data: {
            ids: [id],
            ...(pinned ? { set: { pinned: null } } : { clear: ["pinned"] }),
          },
        });
        expect(response.ok()).toBeTrue();
      };
      await pin(true);
      await browserExpect(header(page, "Pinned")).toHaveCount(1);
      expect(await titles()).toEqual(["Pinned", "Inbox"]);
      await example.waitFor();
      await screenshot(page, `sidebar/empty-section-returned-${width}`);
      await header(page, "Pinned").locator(".tree-section-toggle").click();
      await pin(false);
      await browserExpect(header(page, "Pinned")).toHaveCount(0);
      await pin(true);
      await browserExpect(
        header(page, "Pinned").locator(".tree-section-toggle"),
      ).toHaveAttribute("aria-expanded", "false");
      expect(await titles()).toEqual(["Pinned", "Inbox"]);
      await browserExpect(example).toHaveCount(0);
      expect(
        (await context.request.delete(`${base}api/conversations/${id}`)).ok(),
      ).toBeTrue();
      await context.close();
    }
  },
  // Regression: #2696 discovery before the home tree must not freeze empty ranks.
  async function test_sidebar_prefers_operator_messages_on_hourly_resort(
    browser,
    base,
  ) {
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 900 },
    });
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
      if (!response.ok() || !response.url().endsWith("/api/tree")) return false;
      const payload = await response.json();
      return (payload.unchanged ? [] : (payload.changed ?? payload)).some(
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
    await screenshot(page, "sidebar/sidebar-1280");
    await context.close();
  },
  // Feature: #2869 shared tree links limit discovery and copy a subagent's root.
  async function test_shared_tree_links(browser, base) {
    const { context, page } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const response = await context.request.post(
      `${base}__browser-test/seed-shared-trees`,
    );
    expect(response.ok()).toBeTrue();
    const { ids } = (await response.json()) as { ids: string[] };
    const [first, child, second] = ids;
    const chosen = ids.slice(0, 4);
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
    await screenshot(page, "sidebar/share-phone");
    const phoneBox = (await share.boundingBox())!;
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.locator("#pane-rail > #share-link-btn").waitFor();
    await screenshot(page, "sidebar/share-desktop");
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
  // Regression: #3255 keep section labels close above rows without shrinking phone targets. (also Regression #3551 fit visible section buttons within the header; #3448 show the draft row in its listed agent's place; #3289 retry a sidebar script run that timed out; #3140 scroll section headers into view before mobile touch input; #3139 wait for the initial conversation before returning to the phone list; Feature #2953 Inbox, Active and Archive sections with row actions.)
  async function test_sidebar_sections(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 900 },
    });
    const ids = await seedSections(context, base);
    await assertSectionSpacing(browser, context, base, ids);
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
    await screenshot(page, "sidebar/sections-desktop");
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
    let staleRequest: Request | undefined;
    const failedReads = new Set<Request>();
    let cancelled!: () => void;
    const staleCancelled = new Promise<void>((r) => (cancelled = r));
    page.on("requestfailed", (request) => {
      failedReads.add(request);
      if (request === staleRequest) cancelled();
    });
    await page.route(/\/api\/tree(\?|$)/, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const rows: any[] = payload.unchanged ? [] : (payload.changed ?? payload);
      const pinned = rows.find(
        (row) => row.id === ids.fresh && row.tags?.pinned,
      );
      if (staleRequest) await laterHeld;
      else if (pinned) {
        staleRequest = route.request();
        if (failedReads.has(staleRequest)) cancelled();
        pinnedRead();
        pinned.title = "Stale read applied";
        await staleHeld;
        return route.fulfill({ response, json: payload });
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
    const archiveIdle = inbox.getByRole("button", {
      name: "Archive idle > 1 day",
    });
    await archiveIdle.waitFor({ state: "hidden" });
    const beforeHeaderHover = await bounds(headerContent);
    const headerHeight = (await inbox.boundingBox())!.height;
    await inbox.hover();
    await archiveIdle.waitFor();
    expect((await inbox.boundingBox())!.height).toBe(headerHeight);
    expect((await archiveIdle.boundingBox())!.height).toBeLessThanOrEqual(
      headerHeight,
    );
    expect(await bounds(headerContent)).toEqual(beforeHeaderHover);
    await page.mouse.move(1200, 800);
    await inbox.locator(".tree-section-toggle").focus();
    await page.keyboard.press("Tab");
    await browserExpect(archiveIdle).toBeFocused();
    expect(await bounds(headerContent)).toEqual(beforeHeaderHover);
    await archiveIdle.click();
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
    await screenshot(page, "sidebar/sections-long-title");
    await fresh.hover();
    expect((await fresh.boundingBox())!.height).toBe(rowHeight);
    expect(errors).toEqual([]);
    await context.close();

    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await phoneHold(phone, base, await seedSections(phone, base));
    await phone.close();

    const script = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await customScript(script, base, await seedSections(script, base));
  },
];

async function customScript(
  context: BrowserContext,
  base: string,
  ids: SidebarSectionIds,
): Promise<void> {
  const script = [
    "export default function sidebar(rows, now) {",
    '  if (rows.some((r) => r.tags.boom)) throw new Error("boom");',
    "  if (rows.some((r) => r.tags.hang)) for (;;);",
    "  if (rows.some((r) => r.tags.slow) && Date.now() < now * 1000 + 300) for (;;);",
    "  return [",
    `    { title: "Mine", rows: rows.filter((r) => r.id === "${ids.fresh}"), actions: [
      { label: "Archive idle longer than one day", set: "archived" },
      { label: "Restore all archived conversations", clear: "archived" },
    ] },`,
    `    { title: "Has PR", rows: rows.filter((r) => r.parent === "${ids.fresh}" && r.depth === 1 && r.prs.some((pr) => pr.number === 42 && pr.checks === "pass" && !pr.merged)) },`,
    `    { title: "Others", rows: rows.filter((r) => r.depth === 0 && r.id !== "${ids.fresh}") },`,
    `    { title: "Hidden", hideWhenEmpty: true, rows: ["${ids.fresh}", "unknown"], empty: "Hidden empty text", actions: [{ label: "Hidden action", set: "pinned", rows }] },`,
    '    { title: "Visible empty", hideWhenEmpty: false, rows: [], empty: rows.some((r) => r.tags.slow) ? "Slow ran" : "Visible empty text" },',
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
      { title: "Hidden", rows: 0 },
      { title: "Visible empty", rows: 0 },
    ],
  });
  await context.addInitScript(() =>
    localStorage.setItem("recurse.sidebarWidth", "220"),
  );
  const page = await context.newPage();
  const errors = captureErrors(page);
  await gotoRoot(page, base);
  const mine = header(page, "Mine");
  await mine.locator(".tree-section-toggle").focus();
  const headerHeight = (await mine.boundingBox())!.height;
  for (const name of [
    "Archive idle longer than one day",
    "Restore all archived conversations",
  ]) {
    const action = mine.getByRole("button", { name });
    await page.keyboard.press("Tab");
    await browserExpect(action).toBeFocused();
    expect(await edgesUncovered(action)).toBeTrue();
    expect((await action.boundingBox())!.height).toBeLessThanOrEqual(
      headerHeight,
    );
  }
  await browserExpect(header(page, "Visible empty")).toHaveCount(1);
  await browserExpect(
    page.getByText("Visible empty text", { exact: true }),
  ).toBeVisible();
  expect(await header(page, "Hidden").count()).toBe(0);
  expect(
    await page.getByText("Hidden empty text", { exact: true }).count(),
  ).toBe(0);
  expect(
    await page
      .getByRole("button", { name: "Hidden action", exact: true })
      .count(),
  ).toBe(0);
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
  const banner = notice.getByRole("alert");
  for (const tag of ["slow", "hang"]) {
    const tagged = await context.request.post(`${base}api/sidebar/tags`, {
      data: { ids: [ids.fresh], set: { [tag]: null } },
    });
    expect(tagged.ok()).toBe(true);
    if (tag === "slow")
      await page.getByText("Slow ran", { exact: true }).waitFor();
  }
  await banner
    .getByText("Sidebar script failed: The script ran longer than 50 ms")
    .waitFor();
  await header(page, "Inbox").waitFor();

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/static\/sidebar-worker\.js/, async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  await header(page, "Mine").waitFor();
  await header(page, "Visible empty").waitFor();
  expect(await header(page, "Hidden").count()).toBe(0);
  expect(await header(page, "Inbox").count()).toBe(0);
  release();

  const boom = await context.request.post(`${base}api/sidebar/tags`, {
    data: { ids: [ids.fresh], set: { boom: null } },
  });
  expect(boom.ok()).toBe(true);
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
  ids: SidebarSectionIds,
): Promise<void> {
  const page = await context.newPage();
  const errors = captureErrors(page);
  await gotoRoot(page, base);
  await browserExpect(
    page.locator(`.agent[data-id="${rootAgentId()}"]`),
  ).toHaveClass(/selected/);
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
  ).toEqual(["Archive", "Snooze", "Pin", "Swipe actions", "Rename"]);
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
  await screenshot(page, "sidebar/sections-phone");
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
