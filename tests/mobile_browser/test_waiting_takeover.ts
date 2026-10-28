import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Locator, Page, Route } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  postFixture,
  routeArtifacts,
  runBrowserTests,
  visibleAndUncovered,
  type BrowserTest,
} from "./common";
declare const getComputedStyle: any;

const SHOT_DIR =
  process.env.RECURSE_SCREENSHOT_DIR ||
  join(tmpdir(), `recurse-waiting-shots-${process.pid}`);

async function treeWithStatusRows(route: Route): Promise<void> {
  const response = await route.fetch();
  const payload = await response.json();
  const rows = (
    Array.isArray(payload) ? payload : (payload?.tree ?? payload)
  ) as any[] | undefined;
  expect(Array.isArray(rows) && rows.length > 0).toBeTrue();
  const root = rows![0];
  const now = Date.now() / 1000;
  const extra = [
    {
      id: "shot-held-running",
      parent: root.id,
      title: "Held running with a deliberately long title",
      status: "running",
      updated: now - 400,
      children: 12,
      queued: 3,
      preview: "",
      muted: true,
      pinned: true,
    },
    {
      id: "shot-held-waiting",
      parent: root.id,
      title: "Held waiter",
      status: "waiting",
      updated: now - 300,
      children: 0,
      queued: 0,
      preview: "",
      muted: false,
      pinned: true,
    },
    {
      id: "shot-held-idle",
      parent: root.id,
      title: "Held",
      status: "idle",
      updated: now - 200,
      children: 0,
      queued: 0,
      preview: "",
      muted: true,
      pinned: true,
    },
    {
      id: "shot-idle",
      parent: root.id,
      title: "Quiet",
      status: "idle",
      updated: now - 100,
      children: 0,
      queued: 0,
      preview: "",
      muted: false,
    },
  ];
  return route.fulfill({
    status: 200,
    body: JSON.stringify([...rows!, ...extra]),
    contentType: "application/json",
  });
}

async function openSidebar(
  page: Page,
  base: string,
  width: number,
  mobile: boolean,
): Promise<string[]> {
  void width;
  const errors = captureErrors(page);
  await routeArtifacts(page, base);
  await page.route(`${base}api/tree*`, treeWithStatusRows);
  await gotoRoot(page, base);
  await page.locator(".agent").first().waitFor();
  await page.locator('.agent[data-id="shot-held-idle"]').waitFor();
  await page
    .locator('.agent[data-id="shot-held-running"] .agent-state.running')
    .waitFor({ state: "attached" });
  await page
    .locator('.agent[data-id="shot-held-waiting"] .agent-state.waiting')
    .waitFor({ state: "attached" });
  await page
    .locator('.agent[data-id="shot-held-idle"] .agent-state.taken-over')
    .waitFor({ state: "attached" });
  await page
    .locator('.agent[data-id="shot-idle"] .agent-state.idle')
    .waitFor({ state: "attached" });
  if (mobile) {
    await page.locator("#menu-btn").click();
    await page.locator("#sidebar.open").waitFor();
  }
  return errors;
}

async function assertTakeoverTag(row: Locator): Promise<void> {
  const marker = row.locator(".takeover-tag");
  expect(await marker.count()).toBe(1);
  expect(await marker.getAttribute("title")).toBe("Taken over by the operator");
  expect(await marker.getAttribute("aria-hidden")).toBe("true");
}

async function assertStatusRows(page: Page): Promise<void> {
  const heldRunningRow = page.locator('.agent[data-id="shot-held-running"]');
  const heldRunning = heldRunningRow.locator(".agent-state");
  expect((await heldRunning.getAttribute("class")) ?? "").toContain("running");
  expect(await heldRunning.getAttribute("aria-label")).toBe(
    "Running this agent's current turn, taken over by the operator",
  );
  expect(await heldRunning.getAttribute("title")).toBe(
    "Running this agent's current turn, taken over by the operator",
  );
  await assertTakeoverTag(heldRunningRow);
  expect(await heldRunningRow.locator(".kids").isVisible()).toBeTrue();
  expect(await heldRunningRow.locator(".queue-badge").isVisible()).toBeTrue();

  const heldWaitingRow = page.locator('.agent[data-id="shot-held-waiting"]');
  const heldWaiting = heldWaitingRow.locator(".agent-state");
  expect((await heldWaiting.getAttribute("class")) ?? "").toContain("waiting");
  expect(await heldWaiting.getAttribute("aria-label")).toBe(
    "Waiting on background work, taken over by the operator",
  );
  expect(await heldWaiting.getAttribute("title")).toBe(
    "Waiting on background work, taken over by the operator",
  );
  await assertTakeoverTag(heldWaitingRow);

  const heldRow = page.locator('.agent[data-id="shot-held-idle"]');
  const held = heldRow.locator(".agent-state");
  expect((await held.getAttribute("class")) ?? "").toContain("taken-over");
  expect(await held.getAttribute("aria-label")).toBe(
    "Taken over by the operator",
  );
  expect(await held.getAttribute("title")).toBe("Taken over by the operator");
  expect(await heldRow.locator(".takeover-tag").count()).toBe(0);

  const idleRow = page.locator('.agent[data-id="shot-idle"]');
  const idle = idleRow.locator(".agent-state");
  expect((await idle.getAttribute("class")) ?? "").toContain("idle");
  expect(await idle.getAttribute("aria-label")).toBe("Idle");
  expect(await idleRow.locator(".takeover-tag").count()).toBe(0);
  expect(await page.locator("#takeover-btn").count()).toBe(1);
  expect(await page.locator("#mute-btn").count()).toBe(0);
  expect(await page.locator("#pin-btn").count()).toBe(0);
  const label = await page.locator("#takeover-btn").getAttribute("title");
  expect(
    label?.startsWith("Take over") || label?.startsWith("Taken over"),
  ).toBe(true);
}

export const tests: BrowserTest[] = [
  // Regression: #2677 taking over lights the control and handing back resets it.
  async function test_takeover_control_lights_up(browser, base) {
    const { agent } = await postFixture(base, "seed-durable");
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    try {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await gotoRoot(page, base);
        if (width === 390) await page.locator("#menu-btn").click();
        await page.locator(`.agent[data-id="${agent}"]`).click();
        if (width === 390) await page.locator("#pane-fab").click();
        const button = page.locator("#takeover-btn.on");
        await button.waitFor();
        await page.mouse.move(0, 0);
        const style = () =>
          button.evaluate((el) => {
            const css = getComputedStyle(el);
            return { color: css.color, background: css.backgroundColor };
          });
        const idle = await style();
        await button.click();
        await page.waitForFunction(() => {
          const el = (globalThis as any).document.querySelector(
            "#takeover-btn",
          );
          return el?.getAttribute("aria-pressed") === "true" && !el.disabled;
        });
        await page.mouse.move(0, 0);
        if (process.env.RECURSE_SCREENSHOT_DIR) {
          await mkdir(process.env.RECURSE_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: join(
              process.env.RECURSE_SCREENSHOT_DIR,
              `takeover-active-${width}.png`,
            ),
          });
        }
        const active = await style();
        expect(active.color).not.toBe(idle.color);
        expect(active.background).not.toBe(idle.background);
        await button.click();
        await page.waitForFunction(() => {
          const el = (globalThis as any).document.querySelector(
            "#takeover-btn",
          );
          return el?.getAttribute("aria-pressed") === "false" && !el.disabled;
        });
        await page.mouse.move(0, 0);
        expect(await style()).toEqual(idle);
      }
    } finally {
      try {
        await page.evaluate(async (agent) => {
          const url = `/api/conversations/${agent}`;
          await fetch(`${url}/pin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pinned: false }),
          });
          const deleted = await fetch(url, { method: "DELETE" });
          if (!deleted.ok) throw new Error(`Cleanup failed: ${deleted.status}`);
        }, agent);
      } finally {
        await closeWithRoutes(context);
      }
    }
  },
  async function test_sidebar_status_rows_desktop(browser, base) {
    await mkdir(SHOT_DIR, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = await openSidebar(page, base, 1280, false);
    await assertStatusRows(page);
    await visibleAndUncovered(page, "#sidebar");
    await page.locator("#sidebar").screenshot({
      path: join(SHOT_DIR, "sidebar-status-desktop.png"),
    });
    expect(errors).toEqual([]);
    await closeWithRoutes(context);
  },
  // Regression: #2433 an opening slide is not yet ready for hit-testing.
  async function test_sidebar_status_rows_mobile(browser, base) {
    await mkdir(SHOT_DIR, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = await openSidebar(page, base, 390, true);
    await assertStatusRows(page);
    await page.waitForFunction(() => {
      const sidebar = (globalThis as any).document.querySelector(
        "#sidebar.open",
      );
      return Boolean(
        sidebar &&
        sidebar
          .getAnimations({ subtree: false })
          .every(
            (animation: any) =>
              !animation.pending && animation.playState !== "running",
          ),
      );
    });
    await visibleAndUncovered(page, "#sidebar.open");
    await page.locator("#sidebar").screenshot({
      path: join(SHOT_DIR, "sidebar-status-390.png"),
    });
    expect(errors).toEqual([]);
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["waiting-takeover", tests]]);
