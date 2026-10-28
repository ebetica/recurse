import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import {
  gotoRoot,
  mockConversation,
  postFixture,
  runBrowserTests,
  themeColors,
  type BrowserTest,
} from "./common";
import { idleConv, row, tree } from "./fixtures";

export const tests: BrowserTest[] = [
  // Regression: #2297 desktop actions must remain reachable without overflow. (also Feature #2310 viewport changes move actions between phone and desktop hosts.; #2363 parent navigation can replace rail buttons during box reads.)
  async function test_desktop_rail_actions_and_pane_cycling(browser, base) {
    await postFixture(base, "seed-artifact-app");
    const { demo } = await postFixture(base, "seed-published-sizes");
    await postFixture(base, `seed-artifact-app?agent=${demo}`);
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
      });
      const page = await context.newPage();
      await page.goto(`${base}#agent=${demo}`);
      await page.locator("#trash-btn.on").waitFor({ state: "attached" });
      await page
        .locator('#pane-menu-panels [data-pane="files"]')
        .waitFor({ state: "attached" });
      await page
        .locator('#pane-menu-panels [data-pane="report"]')
        .waitFor({ state: "attached" });
      const dir = process.env.RECURSE_SCREENSHOT_DIR;
      const stage = process.env.RECURSE_SCREENSHOT_STAGE || "after";
      if (dir) {
        await mkdir(dir, { recursive: true });
        await page.screenshot({ path: `${dir}/${stage}-${width}-rail.png` });
      }
      if (width === 412) {
        await page.locator("#pane-fab").click();
        expect(await page.locator("#pane-menu #takeover-btn").isVisible()).toBe(
          true,
        );
        if (dir)
          await page.screenshot({
            path: `${dir}/${stage}-${width}-rail-menu.png`,
          });
        await context.close();
        continue;
      }
      expect(await page.locator("#pane-fab").isVisible()).toBe(false);
      const actions = page.locator("#pane-rail > button");
      expect(
        await actions.evaluateAll((els) => els.map((el) => el.id)),
      ).toEqual(["trash-btn", "takeover-btn"]);
      const first = page.locator("#pane-rail [data-pane]").first();
      const childTop = (await first.boundingBox())!.y;
      expect((await page.locator("#trash-btn").boundingBox())!.height).toBe(44);
      expect((await page.locator("#takeover-btn").boundingBox())!.height).toBe(
        44,
      );
      expect(
        await page
          .locator("#pane-rail-panels")
          .evaluate(
            (el) => (globalThis as any).getComputedStyle(el).borderTopWidth,
          ),
      ).toBe("1px");
      await page.locator("#trash-btn").click();
      expect(await page.locator("#trash-btn").getAttribute("class")).toContain(
        "armed",
      );
      expect(await page.locator(".hold-tip.on").isVisible()).toBe(true);
      await page.locator("#takeover-btn").click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document
            .getElementById("takeover-btn")
            .getAttribute("aria-pressed") === "true",
      );
      expect(
        await page.locator("#trash-btn").getAttribute("class"),
      ).not.toContain("armed");
      await page.locator("#takeover-btn").click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document
            .getElementById("takeover-btn")
            .getAttribute("aria-pressed") === "false",
      );
      const ids = await page
        .locator("#pane-rail [data-pane]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-pane")));
      expect(ids.length).toBeGreaterThanOrEqual(2);
      if ((await first.getAttribute("aria-expanded")) === "false")
        await first.click();
      await page.locator(`.pane-col[data-pane="${ids[0]}"] .pane-body`).focus();
      let index = 0;
      for (const key of ["j", "j", "k", "k"]) {
        index = (index + (key === "j" ? 1 : -1) + ids.length) % ids.length;
        await page.keyboard.press(key);
        await page.waitForFunction(
          (id) =>
            (globalThis as any).document.activeElement?.closest(".pane-col")
              ?.dataset.pane === id,
          ids[index],
        );
        const active = await page.evaluate(
          () =>
            (globalThis as any).document.activeElement?.closest(".pane-col")
              ?.dataset.pane,
        );
        expect(active).toBe(ids[index]);
        expect(
          await page.locator("#trash-btn").getAttribute("class"),
        ).not.toContain("armed");
      }
      await page.setViewportSize({ width: 412, height: 915 });
      await page
        .locator("#pane-menu #trash-btn")
        .waitFor({ state: "attached" });
      expect(await page.locator("#pane-menu #trash-btn").count()).toBe(1);
      await page.setViewportSize({ width, height: 915 });
      await page
        .locator("#pane-rail #trash-btn")
        .waitFor({ state: "attached" });
      expect(await page.locator("#pane-rail #trash-btn").count()).toBe(1);
      await page.locator("#up-top").click();
      await page.locator("#takeover-btn.on").waitFor({ state: "hidden" });
      await page.locator('#pane-rail [data-pane="report"]').waitFor();
      const parentBox = await page.waitForFunction(() => {
        const button = (globalThis as any).document.querySelector(
          "#pane-rail [data-pane]",
        );
        if (!button) return false;
        const box = button.getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? { y: box.y } : false;
      });
      const parentGeometry = await parentBox.jsonValue();
      await parentBox.dispose();
      if (!parentGeometry) throw new Error("Parent rail button is not visible");
      expect(childTop - parentGeometry.y).toBe(44);
      expect(await page.locator("#pane-rail #trash-btn").isVisible()).toBe(
        true,
      );
      if (dir)
        await page.screenshot({
          path: `${dir}/${stage}-${width}-rail-root.png`,
        });
      await context.close();
    }
  },
  // Regression: #2861 conversation actions dismiss the phone menu after activation.
  async function test_takeover_single_activation_and_enabled_menu(
    browser,
    base,
  ) {
    for (const width of [412]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      let parent: string | null = "parent";
      let pinned = false;
      const pins: boolean[] = [];
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({ json: [{ ...tree()[0], parent, pinned }] }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv(),
        parent,
        pinned,
      }));
      await page.route(`${base}api/conversations/main/pin`, (route) => {
        pinned = route.request().postDataJSON().pinned;
        pins.push(pinned);
        return route.fulfill({ json: { pinned } });
      });
      await gotoRoot(page, base);
      await page.locator("#pane-fab").click();
      const dir = process.env.RECURSE_SCREENSHOT_DIR;
      if (dir) {
        await mkdir(dir, { recursive: true });
        await page.screenshot({
          path: `${dir}/${process.env.RECURSE_SCREENSHOT_STAGE || "after"}-${width}-enabled-menu.png`,
        });
      }
      if (width === 412) await page.locator("#takeover-btn").tap();
      else await page.locator("#takeover-btn").click();
      await page
        .locator("#takeover-btn.active:not(:disabled)")
        .waitFor({ state: "attached" });
      expect(pins).toEqual([true]);
      expect(await page.locator("#pane-menu.on").count()).toBe(0);
      await page.locator("#pane-fab").tap();
      expect(await page.locator(".hold-tip.on").count()).toBe(0);
      expect(await page.locator("#takeover-btn").innerText()).toBe(
        "Hand back control",
      );
      if (width === 412) await page.locator("#takeover-btn").tap();
      else await page.locator("#takeover-btn").click();
      await page
        .locator("#takeover-btn:not(.active):not(:disabled)")
        .waitFor({ state: "attached" });
      expect(pins).toEqual([true, false]);
      expect(await page.locator("#pane-menu.on").count()).toBe(0);
      await page.locator("#pane-fab").tap();
      await page.mouse.move(0, 900);
      const styles = await page.evaluate(() => {
        const ids = ["trash-btn", "takeover-btn", "new-top", "pane-fab"];
        return ids.map((id) => {
          const el = (globalThis as any).document.getElementById(id);
          const css = (globalThis as any).getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            color: css.color,
            background: css.backgroundColor,
            border: css.borderWidth,
            x: box.x,
            width: box.width,
            height: box.height,
          };
        });
      });
      expect(styles[0].color).toBe(styles[2].color);
      expect(styles[1].color).toBe(styles[0].color);
      expect(styles[1].background).toBe(styles[0].background);
      expect(styles[3].border).toBe(styles[2].border);
      expect(styles[3].x - styles[2].x - styles[2].width).toBeLessThanOrEqual(
        2,
      );
      for (const style of styles)
        expect(style.height).toBeGreaterThanOrEqual(44);
      expect(
        await page.locator("#takeover-btn svg [stroke-dasharray]").count(),
      ).toBe(0);
      expect(
        await page
          .locator("#pane-menu-panels")
          .evaluate(
            (el) => (globalThis as any).getComputedStyle(el).borderTopWidth,
          ),
      ).toBe("1px");
      parent = null;
      await page.reload();
      await page.locator("#conv-title").waitFor();
      await page.locator("#pane-fab").click();
      expect(await page.locator("#takeover-btn").isVisible()).toBe(false);
      await context.close();
    }
  },
  async function test_overflow_slide_actions(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({ json: [{ ...tree()[0], parent: "parent" }] }),
    );
    await mockConversation(page, base, "main", () => ({
      ...idleConv(),
      parent: "parent",
    }));
    let deletes = 0;
    let pins = 0;
    await page.route(`${base}api/conversations/main`, (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deletes++;
      return route.fulfill({ json: { ok: true } });
    });
    await page.route(`${base}api/conversations/main/pin`, (route) => {
      pins++;
      return route.fulfill({ json: { pinned: true } });
    });
    await gotoRoot(page, base);
    const cdp = await context.newCDPSession(page);
    const slide = async (selector: string, hot = true, cancel = false) => {
      const button = (await page.locator("#pane-fab").boundingBox())!;
      const x = button.x + button.width / 2;
      const y = button.y + button.height / 2;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await page.locator("#pane-menu.on").waitFor();
      const item = (await page.locator(selector).boundingBox())!;
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            {
              x: x + ((item.x + item.width / 2 - x) * i) / 8,
              y: y + ((item.y + item.height / 2 - y) * i) / 8,
            },
          ],
        });
      }
      await page.waitForFunction(
        ({ selector, hot }) => {
          const document = (globalThis as any).document;
          return hot
            ? document.querySelector(`${selector}.hot`) !== null
            : document.querySelector("#pane-menu .hot") === null;
        },
        { selector, hot },
      );
      expect(await page.locator(`${selector}.hot`).count()).toBe(hot ? 1 : 0);
      await cdp.send("Input.dispatchTouchEvent", {
        type: cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    };
    await slide("#trash-btn", true, true);
    expect(await page.locator("#trash-btn.armed").count()).toBe(0);
    expect(deletes).toBe(0);
    await slide("#scroll", false);
    expect(await page.locator("#trash-btn.armed").count()).toBe(0);
    expect(deletes).toBe(0);
    await slide("#takeover-btn");
    await page
      .locator("#takeover-btn.active:not(:disabled)")
      .waitFor({ state: "attached" });
    expect(pins).toBe(1);
    await slide("#trash-btn");
    expect(await page.locator("#trash-btn.armed").count()).toBe(1);
    expect(deletes).toBe(0);
    const deleted = page.waitForResponse(
      (response) =>
        response.url() === `${base}api/conversations/main` &&
        response.request().method() === "DELETE",
    );
    await slide("#trash-btn");
    await deleted;
    expect(deletes).toBe(1);
    await context.close();
  },
  // Regression: #2861 confirmed Delete must not leave the conversation actions menu open.
  async function test_overflow_touch_tap_delete(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({ json: tree() }),
    );
    await mockConversation(page, base, "main", () => idleConv());
    let deletes = 0;
    await page.route(`${base}api/conversations/main`, (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deletes++;
      return route.fulfill({ json: { ok: true } });
    });
    await gotoRoot(page, base);
    const cdp = await context.newCDPSession(page);
    const tap = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    };
    await tap("#pane-fab");
    await page.locator("#pane-menu.on").waitFor();
    await page.locator("#trash-btn").focus();
    await page.keyboard.press("Escape");
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
    await tap("#pane-fab");
    await page.locator("#pane-backdrop").tap({ position: { x: 10, y: 500 } });
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
    await tap("#pane-fab");
    await tap("#trash-btn");
    await page.locator("#trash-btn.armed").waitFor();
    expect(await page.locator("#trash-btn.armed").count()).toBe(1);
    expect(deletes).toBe(0);
    const deletion = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname === "/api/conversations/main",
    );
    await tap("#trash-btn");
    await (await deletion).finished();
    expect(deletes).toBe(1);
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
    expect(await page.locator("#pane-backdrop.on").count()).toBe(0);
    expect(await page.locator("#pane-fab").getAttribute("aria-expanded")).toBe(
      "false",
    );
    await context.close();
  },
  async function test_single_row_header(browser, base) {
    await postFixture(base, "seed-artifact-app?reader=long");
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 412 ? 915 : 900 },
        hasTouch: width === 412,
        isMobile: width === 412,
      });
      const page = await context.newPage();
      const title = "A conversation name long enough to truncate on a phone";
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [
            {
              ...tree()[0],
              title,
              parent: "parent",
              status: "running",
              children: 2,
            },
            { ...tree("parent")[0], title: "Parent", children: 1 },
          ],
        }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv([
          row(
            "a1",
            "assistant",
            "```text\n" + "horizontal content ".repeat(100) + "\n```",
          ),
        ]),
        title,
        parent: "parent",
        status: "running",
        active_run: "header-run",
      }));
      await mockConversation(page, base, "parent", () => ({
        ...idleConv(),
        id: "parent",
        title: "Parent",
      }));
      let deletes = 0;
      await page.route(`${base}api/conversations/main`, (route) => {
        if (route.request().method() !== "DELETE") return route.fallback();
        deletes++;
        return route.fulfill({ json: { ok: true } });
      });
      await gotoRoot(page, base);
      await page.locator("#conv-status.running").waitFor();
      const shot = async (stage: string) => {
        const dir = process.env.RECURSE_SCREENSHOT_DIR;
        if (!dir) return;
        await mkdir(dir, { recursive: true });
        await page.screenshot({
          path: `${dir}/${process.env.RECURSE_SCREENSHOT_STAGE || "after"}-${width}-${stage}.png`,
        });
      };
      const boxes = await Promise.all(
        [
          "#menu-btn",
          "#up-top",
          "#conv-status",
          "#conv-title",
          "#chip-kids",
          "#new-top",
          ...(width === 412 ? ["#pane-fab"] : []),
        ].map((id) => page.locator(id).boundingBox()),
      );
      const header = (await page.locator("#topbar").boundingBox())!;
      expect(header.height).toBe(48);
      for (const box of boxes) {
        expect(box).toBeTruthy();
        expect(
          Math.abs(box!.y + box!.height / 2 - (header.y + header.height / 2)),
        ).toBeLessThan(2);
      }
      for (let i = 1; i < boxes.length; i++)
        expect(boxes[i]!.x).toBeGreaterThanOrEqual(
          boxes[i - 1]!.x + boxes[i - 1]!.width,
        );
      if (width === 412) {
        expect(
          await page
            .locator("#conv-title")
            .evaluate((el) => el.scrollWidth > el.clientWidth),
        ).toBe(true);
      }
      for (const id of [
        "#menu-btn",
        "#up-top",
        "#conv-title",
        "#new-top",
        ...(width === 412 ? ["#pane-fab"] : []),
      ]) {
        const box = (await page.locator(id).boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await shot("closed");
      if (width === 1280) {
        const sidebarHeader = await page.locator("#brand").boundingBox();
        await page.locator("#menu-btn").click();
        expect(await page.locator("#sidebar").isVisible()).toBe(false);
        expect((await page.locator("#topbar").boundingBox())!.height).toBe(48);
        await shot("sidebar-collapsed");
        await page.locator("#menu-btn").click();
        expect(await page.locator("#brand").boundingBox()).toEqual(
          sidebarHeader,
        );
        expect(await page.locator("#pane-fab").isVisible()).toBe(false);
        expect(await page.locator("#pane-rail #trash-btn").isVisible()).toBe(
          true,
        );
        await context.close();
        continue;
      }
      await page.locator("#pane-fab").click();
      const items = page.locator("#pane-menu .pane-menu-item:visible");
      const iconBoxes = [];
      for (const item of await items.all()) {
        expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        const icon = item.locator("svg");
        expect(await icon.count()).toBe(1);
        expect(await icon.getAttribute("aria-hidden")).toBe("true");
        iconBoxes.push((await icon.boundingBox())!);
      }
      for (const box of iconBoxes) {
        expect(box.width).toBe(16);
        expect(box.height).toBe(16);
        expect(box.x).toBe(iconBoxes[0].x);
      }
      const labels = await items.allTextContents();
      expect(labels.slice(0, 2).map((s) => s.trim())).toEqual([
        "Delete",
        "Take control",
      ]);
      expect(
        await page
          .locator("#pane-menu-panels .pane-menu-item")
          .allTextContents(),
      ).toEqual(labels.slice(2, -1));
      expect(labels.at(-1)?.trim()).toBe("Up to parent agent");
      expect(await page.locator("#up-btn").isEnabled()).toBe(true);
      expect(
        await page
          .locator("#up-btn")
          .evaluate((el) => (globalThis as any).getComputedStyle(el).color),
      ).toBe(
        await page
          .locator("#trash-btn")
          .evaluate((el) => (globalThis as any).getComputedStyle(el).color),
      );
      await shot("menu");
      await page.locator("#trash-btn").click();
      expect(deletes).toBe(0);
      expect(await page.locator("#trash-btn").innerText()).toBe(
        "Confirm delete agent and descendants",
      );
      expect(await page.locator(".hold-tip.on").count()).toBe(0);
      const itemBox = (await page.locator("#trash-btn").boundingBox())!;
      const label = page.locator("#trash-btn .action-label");
      const labelBox = (await label.boundingBox())!;
      expect(labelBox.x).toBeGreaterThanOrEqual(itemBox.x);
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(
        itemBox.x + itemBox.width,
      );
      expect(
        await label.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await shot("confirmation");
      const deleted = page.waitForResponse(
        (response) =>
          response.url() === `${base}api/conversations/main` &&
          response.request().method() === "DELETE",
      );
      await page.locator("#trash-btn").click();
      await deleted;
      expect(deletes).toBe(1);
      await context.close();
    }
  },
  async function test_live_count_icons(browser, base) {
    const observed: { text: string; icons: number }[] = [];
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [
            { ...tree()[0], children: 4, status: "running" },
            ...Array.from({ length: 4 }, (_, i) => ({
              ...tree()[0],
              id: `child-${i}`,
              parent: "main",
              title: `Child ${i}`,
              status: "running",
            })),
          ],
        }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv(),
        status: "running",
        active_run: "live-header-run",
        shells: {
          status: "ready",
          active_count: 1,
          background_count: 1,
          items: [],
        },
      }));
      await gotoRoot(page, base);
      await page.locator(".live-panel .shell-chip").waitFor();
      const dir = process.env.RECURSE_SCREENSHOT_DIR;
      if (dir) {
        await mkdir(dir, { recursive: true });
        await page.screenshot({
          path: `${dir}/${process.env.RECURSE_SCREENSHOT_STAGE || "after"}-${width}-live.png`,
        });
      }
      for (const [selector, label] of [
        [".shell-chip", "1 active shell"],
        [".agent-chip", "4 active agents"],
      ]) {
        const chip = page.locator(`.live-panel ${selector}`);
        expect(await chip.getAttribute("aria-label")).toContain(label);
        expect(await chip.getAttribute("title")).toContain(label);
        observed.push({
          text: (await chip.innerText()).trim(),
          icons: await chip.locator("svg[aria-hidden=true]").count(),
        });
      }
      await context.close();
    }
    expect(observed).toEqual([
      { text: "1", icons: 1 },
      { text: "4", icons: 1 },
      { text: "1", icons: 1 },
      { text: "4", icons: 1 },
    ]);
  },
  async function test_last_turn_state_badge(browser, base) {
    for (const width of [412, 1280]) {
      const context = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({ json: [{ ...tree()[0], children: 2 }] }),
      );
      await mockConversation(page, base, "main", () => ({
        ...idleConv(),
        status: "interrupted",
      }));
      await gotoRoot(page, base);
      const state = page.getByRole("img", {
        name: "interrupted — context kept",
      });
      await state.waitFor();
      const dir = process.env.RECURSE_SCREENSHOT_DIR;
      if (dir) {
        await mkdir(dir, { recursive: true });
        await page.screenshot({
          path: `${dir}/${process.env.RECURSE_SCREENSHOT_STAGE || "after"}-${width}-state.png`,
        });
      }
      expect(await state.getAttribute("id")).toBe("chip-state");
      expect((await state.innerText()).trim()).toBe("");
      expect(await state.locator("svg[aria-hidden=true]").count()).toBe(1);
      const box = (await state.boundingBox())!;
      const kids = (await page.locator("#chip-kids").boundingBox())!;
      expect(box.width).toBe(box.height);
      expect(box.height).toBe(kids.height);
      expect(box.y).toBe(kids.y);
      const [warn] = await themeColors(page, "var(--warn)");
      expect(
        await state.evaluate(
          (el) => (globalThis as any).getComputedStyle(el).color,
        ),
      ).toBe(warn);
      await context.close();
    }
  },
  async function test_mobile_sidebar_parent_control(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({
        json: [
          { ...tree()[0], parent: "parent" },
          { ...tree("parent")[0], title: "Parent", children: 1 },
        ],
      }),
    );
    await mockConversation(page, base, "main", () => ({
      ...idleConv([
        row(
          "a1",
          "assistant",
          "```text\n" + "long line ".repeat(100) + "\n```",
        ),
      ]),
      parent: "parent",
    }));
    await mockConversation(page, base, "parent", () => ({
      ...idleConv(),
      id: "parent",
      title: "Parent",
    }));
    await gotoRoot(page, base);
    await page.locator(".content pre").waitFor();
    await page.locator("#menu-btn").tap();
    expect(await page.locator("#up-top.on").count()).toBe(1);
    await page.locator("#backdrop").tap({ position: { x: 400, y: 400 } });
    await page.locator("#up-top").tap();
    await page.waitForFunction(
      "document.querySelector('#conv-title')?.textContent === 'Parent'",
    );
    expect(await page.locator("#up-top.on").count()).toBe(0);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["header", tests]]);
