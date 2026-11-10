import { expect } from "bun:test";
import { EventEmitter, once } from "node:events";
import type { Browser, Locator, Page, Route } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  dispatchArtifactSelection,
  gotoRoot,
  postFixture,
  runBrowserTests,
  showAgentList,
  themeColors,
  type BrowserTest,
} from "./common";

async function filePage(
  browser: Browser,
  width: number,
  height: number,
  mobile = false,
) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  return { context, page, errors: captureErrors(page) };
}
async function fileShot(page: Page, name: string): Promise<void> {
  const directory = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
  if (directory) await page.screenshot({ path: `${directory}/${name}` });
}
async function waitForDrawn(target: Locator, timeout = 15_000): Promise<void> {
  await target
    .page()
    .waitForFunction(
      (element: any) => element.dataset.drawn === "true",
      await target.elementHandle(),
      { timeout },
    );
}

const filesSurface = (page: Page) =>
  page.locator(
    '.pane-col[data-pane="files"], .pane-col.file-tab:visible:has(.files-detail)',
  );
async function showFilesList(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1280) <= 700) {
    await page.getByRole("button", { name: "All files", exact: true }).click();
    return;
  }
  const list = page.locator('.pane-col[data-pane="files"]');
  if (await page.locator('.dv-tab[data-dock-panel="files"]').count())
    await page.locator('.dv-tab[data-dock-panel="files"]').click();
  else await page.locator('.rail-btn[data-pane="files"]').click();
  await list.waitFor();
}
async function openListedFile(page: Page, name: string): Promise<void> {
  await page
    .locator(".files-card")
    .getByRole("button", { name: `Open ${name}`, exact: true })
    .click();
}

async function openReplyFile(page: Page, name: string): Promise<Locator> {
  const chip = page.getByRole("button", {
    name: `Open ${name} in Files`,
    exact: true,
  });
  if (!(await chip.isVisible()))
    await page.locator('.dv-tab[data-dock-panel="chat"]').click();
  await chip.click();
  return filesSurface(page).filter({ has: page.locator(".files-detail") });
}
async function closeFileTab(page: Page, id?: string): Promise<void> {
  const panel =
    id ??
    (await page
      .locator(".pane-col.file-tab:visible")
      .getAttribute("data-pane"))!;
  const tab = page.locator(`.dv-tab[data-dock-panel="${panel}"]`);
  await tab.hover();
  await tab.locator("button").click();
}

async function renderedText(target: Locator): Promise<string> {
  await target.page().waitForFunction(
    (element: any) =>
      (element.firstElementChild ?? element).checkVisibility({
        contentVisibilityAuto: true,
      }),
    await target.elementHandle(),
  );
  return target.innerText();
}

interface Fixture {
  demo: string;
  empty: string;
  empty_text: string;
}

interface ImageNavigationFixture {
  demo: string;
  image_ids: string[];
}

async function retryColdFiles(
  page: Page,
  pane: Locator,
  base: string,
  cid: string,
  coldUrl: string,
  coldFailed: Route[],
): Promise<void> {
  await pane
    .locator(".files-error", { hasText: "Couldn’t load files" })
    .waitFor();
  expect(await pane.getByRole("button", { name: "Retry" }).count()).toBe(1);
  await page.unroute(coldUrl);
  expect(
    (await page.request.post(base + "__browser-test/append-empty-file")).ok(),
  ).toBeTrue();
  const retryBefore = await page.evaluate("window.__filesFetchOrder.length");
  const retryResponse = page.waitForResponse((r) =>
    r.url().includes(`/conversations/${cid}/files?`),
  );
  await pane.getByRole("button", { name: "Retry" }).click();
  await page.waitForFunction(
    `window.__filesFetchOrder.length > ${retryBefore}`,
    null,
    { timeout: 15_000 },
  );
  await pane.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
  await (await retryResponse).finished();
  expect(coldFailed).toHaveLength(1);
}

async function runningTree(route: Route, runningCid: string): Promise<void> {
  const response = await route.fetch();
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  for (const row of rows) if (row.id === runningCid) row.status = "running";
  await route.fulfill({ response, json: rows });
}
async function runningView(route: Route): Promise<void> {
  const response = await route.fetch();
  const payload = (await response.json()) as Record<string, unknown>;
  payload.status = "running";
  await route.fulfill({ response, json: payload });
}
async function emptyFiles(route: Route): Promise<void> {
  const raw = new URL(route.request().url()).searchParams.get("generation");
  expect(raw).not.toBeNull();
  const generation = Number(raw);
  await route.fulfill({
    json: { files: [], cursor: null, generation, done: true },
  });
}
function heldRoutes() {
  const routes: Route[] = [];
  const events = new EventEmitter();
  return {
    routes,
    hold(route: Route) {
      routes.push(route);
      events.emit("held");
    },
    next(timeout = 15_000) {
      return once(events, "held", { signal: AbortSignal.timeout(timeout) });
    },
  };
}
async function mobileFiles(
  browser: Browser,
  base: string,
  fixture: Fixture,
): Promise<void> {
  const { context, page, errors } = await filePage(browser, 390, 844, true);
  await page.route("**/api/tree", (route) => runningTree(route, fixture.empty));
  await page.route(`**/api/conversations/${fixture.empty}?*`, runningView);
  await page.route(
    (url) => url.pathname === `/api/conversations/${fixture.empty}/events`,
    (route) => route.abort(),
  );
  await page.addInitScript(`
    window.__filesFetchOrder = []; window.__filesClockOffset = 0;
    const realNow = performance.now.bind(performance); performance.now = () => realNow() + window.__filesClockOffset;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => { const url = String(typeof input === 'string' ? input : input.url);
      if (url.includes('/files?')) window.__filesFetchOrder.push('list');
      if (url.includes('/files/') && url.includes('/preview')) window.__filesFetchOrder.push(document.querySelector('.files-card') ? 'preview-after-card' : 'preview-before-card');
      return originalFetch(input, init); };
  `);
  const coldFailed: Route[] = [];
  const coldUrl = `**/api/conversations/${fixture.empty}/files?*`;
  await page.route(coldUrl, (route) => {
    coldFailed.push(route);
    return route.fulfill({
      status: 503,
      json: { error: "browser cold failure" },
    });
  });
  await page.goto(`${base}#agent=${fixture.empty}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#conv-title", { hasText: "Files empty agent" }).waitFor();
  await page.locator("#pane-fab").waitFor();
  await page.waitForFunction("window.__filesFetchOrder.length > 0", null, {
    timeout: 15_000,
  });
  expect(await page.locator('.pane-col[data-pane="files"]').count()).toBe(0);
  await page.evaluate("document.querySelector('#pane-fab')?.click()");
  const menu = page.locator('.pane-menu-item[data-pane="files"]');
  await menu.waitFor({ state: "attached", timeout: 15_000 });
  expect(coldFailed).toHaveLength(1);
  await menu.evaluate((element) => (element as { click: () => void }).click());
  let pane = filesSurface(page);
  await retryColdFiles(page, pane, base, fixture.empty, coldUrl, coldFailed);
  const heldRequests = heldRoutes();
  const held = heldRequests.routes;
  const filesUrl = `**/api/conversations/${fixture.empty}/files?*`;
  await page.route(filesUrl, (route) => {
    heldRequests.hold(route);
  });
  const firstHeld = heldRequests.next();
  await pane.locator(".pane-title").focus();
  expect(
    (await page.request.post(base + "__browser-test/append-empty-file")).ok(),
  ).toBeTrue();
  await page.evaluate("window.__filesClockOffset += 60000");
  await firstHeld;
  expect(held).toHaveLength(1);
  expect(await pane.isVisible()).toBeTrue();
  expect(
    await page.evaluate(
      "document.activeElement?.closest('.pane-col[data-pane=\\\"files\\\"]') !== null",
    ),
  ).toBeTrue();
  const secondHeld = heldRequests.next();
  await held[0].continue();
  await pane.locator(".pane-title").focus();
  expect(
    (await page.request.post(base + "__browser-test/append-empty-file")).ok(),
  ).toBeTrue();
  await page.evaluate("window.__filesClockOffset += 60000");
  await secondHeld;
  expect(held).toHaveLength(2);
  expect(await pane.isVisible()).toBeTrue();
  expect(
    await page.evaluate(
      "document.activeElement?.closest('.pane-col[data-pane=\\\"files\\\"]') !== null",
    ),
  ).toBeTrue();
  await emptyFiles(held[1]);
  await page.waitForFunction(
    "!document.querySelector('.pane-col[data-pane=\\\"files\\\"]')",
    null,
    { timeout: 15_000 },
  );
  expect(
    await page.evaluate("document.activeElement?.id === 'menu-btn'"),
  ).toBeTrue();
  await page.unroute(filesUrl);
  await showAgentList(page);
  await page.locator(`.agent[data-id="${fixture.demo}"]`).click();
  await page.locator("#conv-title", { hasText: "Files demo agent" }).waitFor();
  expect(
    await page.evaluate(
      "(() => { const a=document.activeElement; return !a?.closest('.pane-col') && (a?.id === 'menu-btn' || !!a?.closest('#sidebar') || a?.id === 'input'); })()",
    ),
  ).toBeTrue();
  await page.goto(`${base}#agent=${fixture.empty}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#conv-title", { hasText: "Files empty agent" }).waitFor();
  await page.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
  expect(
    (await page.request.post(base + "__browser-test/remove-empty-file")).ok(),
  ).toBeTrue();
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(`/conversations/${fixture.empty}/files?`),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  const emptyResponse = await responsePromise;
  expect(emptyResponse.ok()).toBeTrue();
  const projection = (await (
    await page.request.get(emptyResponse.url())
  ).json()) as Record<string, unknown>;
  expect(Boolean(!projection.stale && projection.done)).toBeTrue();
  expect((projection.files as unknown[]).length).toBe(1);
  expect(JSON.stringify(projection.files)).toContain("empty-agent.txt");
  const download = await page.request.get(
    base +
      `api/conversations/${fixture.empty}/attachments/${fixture.empty_text}`,
  );
  expect(download.ok()).toBeTrue();
  await page.locator("#conv-title", { hasText: "Files empty agent" }).waitFor();
  await page.evaluate("document.querySelector('#pane-fab')?.click()");
  await menu.waitFor({ state: "attached", timeout: 15_000 });
  await menu.evaluate((element) => (element as { click: () => void }).click());
  pane = filesSurface(page);
  await pane.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
  expect(errors).toEqual([]);
  await page.unrouteAll({ behavior: "wait" });
  await context.close();
}

export const tests: BrowserTest[] = [
  // Feature: #2632 a republished name moves above intervening uploads and publications.
  async function test_files_are_newest_first(browser, base) {
    const { demo } = await postFixture(base, "seed-files-newest-first");
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      try {
        await page.route(`**/api/conversations/${demo}/files?*`, (route) => {
          const url = new URL(route.request().url());
          url.searchParams.set("limit", "2");
          return route.continue({ url: url.toString() });
        });
        await page.goto(`${base}#agent=${demo}`, {
          waitUntil: "domcontentloaded",
        });
        if (width === 390) {
          const menu = page.locator('.pane-menu-item[data-pane="files"]');
          await menu.waitFor({ state: "attached" });
          await page.locator("#pane-fab").click();
          await menu.click();
        } else await page.locator('.rail-btn[data-pane="files"]').click();
        const pane = filesSurface(page);
        const list = page.locator('.pane-col[data-pane="files"]');
        await pane.getByRole("button", { name: "Load older files" }).waitFor();
        expect(await pane.locator(".files-card").count()).toBe(2);
        await pane.getByRole("button", { name: "Load older files" }).click();
        await pane.locator(".files-card").nth(2).waitFor();
        expect(
          await pane.getByRole("button", { name: "Load older files" }).count(),
        ).toBe(0);
        expect(
          await pane
            .locator(".files-card")
            .evaluateAll((cards) =>
              cards.map((card) => card.getAttribute("aria-label")),
            ),
        ).toEqual(["report.md", "summary.md", "notes.txt"]);
        expect(
          await renderedText(pane.locator(".files-card").first()),
        ).toContain("2 versions");
        const filter = pane.locator(".files-filter");
        expect(await filter.isVisible()).toBe(width === 1280);
        if (width === 1280) {
          await list.locator(".pane-title").focus();
          const cursor = pane.locator(".pane-item-cursor");
          for (const [key, name] of [
            ["j", "report.md"],
            ["j", "summary.md"],
            ["k", "report.md"],
            ["]", "summary.md"],
            ["[", "report.md"],
            ["Shift+G", "notes.txt"],
          ]) {
            await page.keyboard.press(key!);
            expect(await cursor.getAttribute("aria-label")).toBe(name!);
          }
          await page.keyboard.press("g");
          await page.keyboard.press("g");
          await page.keyboard.press("y");
          await pane
            .locator(".files-navigation-status", { hasText: "Link copied." })
            .waitFor();
          const downloadLink = pane.getByRole("link", {
            name: "Download",
            exact: true,
          });
          const copied = await page.evaluate(() =>
            (globalThis as any).navigator.clipboard.readText(),
          );
          await page.keyboard.press("l");
          await pane
            .locator(".files-markdown h1", { hasText: "Updated report" })
            .waitFor();
          expect(copied).toBe(
            new URL((await downloadLink.getAttribute("href"))!, base).href,
          );
          const body = pane.locator(".pane-body:has(.files-detail)");
          for (const key of ["j", "d"]) {
            await page.keyboard.press(key);
            await page.waitForFunction(
              (element: any) => element.scrollTop > 0,
              await body.elementHandle(),
            );
            const down = await body.evaluate((element) => element.scrollTop);
            await page.keyboard.press(key === "j" ? "k" : "u");
            await page.waitForFunction(
              ([element, down]: any) => element.scrollTop < down,
              [await body.elementHandle(), down],
            );
          }
          await page.keyboard.press("[");
          await pane
            .locator('.files-detail[aria-label="summary.md"]')
            .waitFor();
          await page.keyboard.press("y");
          await pane
            .locator(".files-jump-status", { hasText: "Link copied." })
            .waitFor();
          expect(
            await page.evaluate(() =>
              (globalThis as any).navigator.clipboard.readText(),
            ),
          ).toBe(
            new URL((await downloadLink.getAttribute("href"))!, base).href,
          );
          await page.keyboard.press("]");
          await pane.locator('.files-detail[aria-label="report.md"]').waitFor();
          await page.keyboard.press("h");
          expect(await cursor.getAttribute("aria-label")).toBe("report.md");
          await page.keyboard.press("/");
          expect(
            await filter.evaluate(
              (element) => element === element.ownerDocument.activeElement,
            ),
          ).toBeTrue();
          await filter.fill("summary");
          expect(await pane.locator(".files-card").count()).toBe(1);
          await page.keyboard.type("j");
          expect(await filter.inputValue()).toBe("summaryj");
          await pane.getByText("No matching files.", { exact: true }).waitFor();
          await filter.fill("report");
          await list.locator(".pane-title").focus();
          await page.keyboard.press("j");
          await page.keyboard.press("Enter");
          await pane.locator('.files-detail[aria-label="report.md"]').waitFor();
          await page.keyboard.press("/");
          expect(await filter.inputValue()).toBe("report");
          expect(await pane.locator(".files-card").count()).toBe(1);
          const pointer = await context.newCDPSession(page);
          await pointer.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
          });
          await pane.locator(".files-card").nth(2).waitFor();
          expect(await filter.isVisible()).toBeFalse();
          await pointer.send("Emulation.setTouchEmulationEnabled", {
            enabled: false,
          });
          await pane
            .locator('.files-card[aria-label="summary.md"]')
            .waitFor({ state: "detached" });
          expect(await filter.isVisible()).toBeTrue();
          expect(await filter.inputValue()).toBe("report");
          expect(await pane.locator(".files-card").count()).toBe(1);
          await pointer.detach();
          await list.locator(".pane-title").focus();
          await page.keyboard.press("j");
          await page.keyboard.press("Escape");
          await page.waitForFunction(() =>
            (globalThis as any).document.activeElement?.matches(".agent"),
          );
          expect(await list.isVisible()).toBeTrue();
          await list.locator(".pane-title").focus();
          await page.keyboard.press("q");
          await list.waitFor({ state: "detached" });
          await pane.locator(".files-detail").waitFor();
          await page.locator('.rail-btn[data-pane="files"]').click();
          await list.waitFor();
          expect(await filter.inputValue()).toBe("report");
          await pane.getByRole("button", { name: "Load older files" }).click();
          await pane
            .locator(".files-summary", { hasText: "1 of 3 files" })
            .waitFor();
          expect(await pane.locator(".files-card").count()).toBe(1);
        }
        await page.screenshot({
          path: `${process.env.RECURSE_AGENT_TMPDIR}/files-navigation-${width}.png`,
        });
        await openListedFile(page, "report.md");
        await pane
          .locator(".files-markdown h1", { hasText: "Updated report" })
          .waitFor();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_session_files_pane(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    expect(fixture).toBeTruthy();
    await page.route(`**/api/conversations/${fixture.demo}/diff*`, (route) =>
      route.fulfill({
        json: {
          available: true,
          base: "origin/main",
          version: "files-fixture",
          diff: "diff --git a/fixture.txt b/fixture.txt\nindex 111..222 100644\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-old\n+new\n",
          truncated: false,
          untracked: [],
          currentPr: null,
        },
      }),
    );
    await page.route("**/api/tree", (route) =>
      runningTree(route, fixture.demo),
    );
    await page.route(`**/api/conversations/${fixture.demo}?*`, runningView);
    const appendFilesMessage = async () => {
      expect(
        (
          await page.request.post(base + "__browser-test/append-files-message")
        ).ok(),
      ).toBeTrue();
      await page.evaluate("window.__filesClockOffset += 60000");
    };
    const emptyFilesPath = `/api/conversations/${fixture.empty}/files?`;
    await page.addInitScript(
      `window.__filesFetchOrder=[]; window.__filesClockOffset=0; const realNow=performance.now.bind(performance); performance.now=()=>realNow()+window.__filesClockOffset; window.__emptyFilesFetchOrder=[]; window.__emptyFilesPath='${emptyFilesPath}'; const originalFetch=window.fetch.bind(window); window.fetch=(input,init)=>{const url=String(typeof input==='string'?input:input.url); if(url.includes('/files?')) window.__filesFetchOrder.push('list'); if(url.includes(window.__emptyFilesPath)) window.__emptyFilesFetchOrder.push('list'); if(url.includes('/files/')&&url.includes('/preview')) window.__filesFetchOrder.push([...document.querySelectorAll('.files-detail')].some(detail=>url.includes('/files/'+detail.dataset.fileKey.replace(':','/')+'/preview'))?'preview-in-detail':'preview-in-list'); return originalFetch(input,init);};`,
    );
    const coldFailed: Route[] = [];
    const coldUrl = `**/api/conversations/${fixture.empty}/files?*`;
    await page.route(coldUrl, (route) => {
      coldFailed.push(route);
      return route.fulfill({
        status: 503,
        json: { error: "browser cold failure" },
      });
    });
    await gotoRoot(page, base);
    const focused = page.waitForResponse(
      (r) =>
        r.url().startsWith(base + `api/conversations/${fixture.empty}?`) &&
        r.url().includes("focused=1"),
    );
    await page.locator(`.agent[data-id="${fixture.empty}"]`).click();
    const focusedResponse = await focused;
    expect(focusedResponse.ok()).toBeTrue();
    await page
      .locator("#conv-title", { hasText: "Files empty agent" })
      .waitFor();
    await page.waitForFunction(
      "window.__emptyFilesFetchOrder.length > 0",
      null,
      { timeout: 15_000 },
    );
    const filesButton = page.locator('.rail-btn[data-pane="files"]');
    await filesButton.waitFor({ timeout: 15_000 });
    expect(coldFailed).toHaveLength(1);
    expect(await page.locator('.pane-col[data-pane="files"]').count()).toBe(0);
    await filesButton.click();
    let pane = page.locator('.pane-col[data-pane="files"]');
    await retryColdFiles(page, pane, base, fixture.empty, coldUrl, coldFailed);
    await pane.locator(".pane-title").focus();
    await page.locator(`.agent[data-id="${fixture.demo}"]`).click();
    await page
      .locator("#conv-title", { hasText: "Files demo agent" })
      .waitFor();
    expect(
      await page.evaluate(
        `document.activeElement?.closest('.agent')?.dataset.id === ${JSON.stringify(fixture.demo)}`,
      ),
    ).toBeTrue();
    await page.locator(`.agent[data-id="${fixture.empty}"]`).click();
    await page
      .locator("#conv-title", { hasText: "Files empty agent" })
      .waitFor();
    await filesButton.waitFor({ timeout: 15_000 });
    expect(await filesButton.count()).toBe(1);
    if ((await filesButton.getAttribute("aria-expanded")) !== "true")
      await filesButton.click();
    pane = page.locator('.pane-col[data-pane="files"]');
    await pane.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
    expect(
      (await page.request.post(base + "__browser-test/remove-empty-file")).ok(),
    ).toBeTrue();
    let reloaded = false;
    const onNavigated = (frame: unknown) => {
      if (frame === page.mainFrame()) reloaded = true;
    };
    page.on("framenavigated", onNavigated);
    const reloadResponse = page.waitForResponse(
      (r) =>
        reloaded && r.url().includes(`/conversations/${fixture.empty}/files?`),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const projectionResponse = await reloadResponse;
    page.off("framenavigated", onNavigated);
    expect(
      projectionResponse.ok(),
      `${projectionResponse.status()} ${projectionResponse.url()}`,
    ).toBeTrue();
    const projection = (await projectionResponse.json()) as Record<
      string,
      unknown
    >;
    expect(Boolean(!projection.stale && projection.done)).toBeTrue();
    expect((projection.files as unknown[]).length).toBe(1);
    expect(JSON.stringify(projection.files)).toContain("empty-agent.txt");
    const download = await page.request.get(
      base +
        `api/conversations/${fixture.empty}/attachments/${fixture.empty_text}`,
    );
    expect(download.ok()).toBeTrue();
    await page
      .locator("#conv-title", { hasText: "Files empty agent" })
      .waitFor();
    await page.locator('.rail-btn[data-pane="files"]').waitFor();
    pane = page.locator('.pane-col[data-pane="files"]');
    await pane.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
    await pane.locator(".pane-title").focus();
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await page.locator(`.agent[data-id="${fixture.empty}"]`).focus();
    const composerBefore = await page.locator("#input").inputValue();
    await page.locator('.rail-btn[data-pane="files"]').click();
    await pane.waitFor();
    await pane.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
    expect(await page.locator("#input").inputValue()).toBe(composerBefore);
    await page.locator(`.agent[data-id="${fixture.demo}"]`).click();
    await page
      .locator("#conv-title", { hasText: "Files demo agent" })
      .waitFor();
    const previewHolds = heldRoutes();
    const heldPreviews = previewHolds.routes;
    await page.route(
      `**/api/conversations/${fixture.demo}/files/**/preview`,
      (route) => {
        previewHolds.hold(route);
      },
    );
    await page
      .locator('.rail-btn[data-pane="files"]')
      .waitFor({ timeout: 15_000 });
    await page
      .locator('.rail-btn[data-pane="diff"]')
      .waitFor({ timeout: 15_000 });
    const railIds = await page
      .locator("#pane-rail .rail-btn")
      .evaluateAll((buttons) =>
        buttons.map(
          (button) => (button as { dataset?: { pane?: string } }).dataset?.pane,
        ),
      );
    expect(railIds).toContain("diff");
    expect(railIds).toContain("files");
    expect(railIds.indexOf("diff")).toBe(railIds.indexOf("files") + 1);
    await filesButton.click();
    const badgeStyle = (await page
      .waitForFunction(
        `(() => {
        const button = document.querySelector(
          '.rail-btn[data-pane="files"].active',
        );
        const badge = button?.querySelector('.rail-count');
        if (!button?.isConnected || !badge?.isConnected) return null;
        const s = getComputedStyle(badge);
        const badgeBox = badge.getBoundingClientRect();
        const buttonBox = button.getBoundingClientRect();
        if (!s.backgroundColor || !s.color) return null;
        return {
          bg: s.backgroundColor,
          color: s.color,
          shadow: s.boxShadow,
          font: s.fontSize,
          badgeWidth: badgeBox.width,
          badgeHeight: badgeBox.height,
          badgeRight: badgeBox.x + badgeBox.width,
          buttonRight: buttonBox.x + buttonBox.width,
        };
      })()`,
      )
      .then((handle) => handle.jsonValue())) as {
      bg: string;
      color: string;
      shadow: string;
      font: string;
      badgeWidth: number;
      badgeHeight: number;
      badgeRight: number;
      buttonRight: number;
    };
    const [bg, activeBg, text, activeText, accent] = await themeColors(
      page,
      "var(--count-bg)",
      "var(--count-bg-active)",
      "var(--count-text)",
      "var(--count-text-active)",
      "var(--accent)",
    );
    expect([bg, activeBg]).toContain(badgeStyle.bg);
    expect([text, activeText]).toContain(badgeStyle.color);
    expect(badgeStyle.bg + badgeStyle.color + badgeStyle.shadow).not.toContain(
      accent.slice(4, -1),
    );
    expect(badgeStyle.badgeWidth >= 15).toBeTrue();
    expect(badgeStyle.badgeHeight >= 14).toBeTrue();
    expect(badgeStyle.badgeRight <= badgeStyle.buttonRight + 6).toBeTrue();
    pane = page.locator('.pane-col[data-pane="files"]');
    await pane.waitFor();
    const cards = pane.locator(".files-card");
    await cards.first().waitFor();
    expect(await cards.count()).toBe(2);
    const textCard = cards.filter({ hasText: "browser-notes.txt" });
    const imageCard = cards.filter({ hasText: "browser-image.png" });
    await imageCard.locator("img").waitFor();
    await page.waitForFunction(
      "[...document.querySelectorAll('.files-card img')].some(image => image.complete && image.naturalWidth > 0)",
    );
    const row = (await textCard.boundingBox())!;
    expect(row.height).toBeGreaterThanOrEqual(44);
    expect(row.height).toBeLessThanOrEqual(60);
    expect(
      await textCard.locator("pre, .files-preview-placeholder").count(),
    ).toBe(0);
    const firstPreview = previewHolds.next();
    await textCard
      .getByRole("button", { name: "Open browser-notes.txt" })
      .click();
    const detail = page.locator(".pane-col.file-tab:visible");
    await detail.locator(".files-preview-placeholder").waitFor();
    await firstPreview;
    expect(heldPreviews).toHaveLength(1);
    const head = (await detail.locator(".files-detail-head").boundingBox())!;
    expect(head.height).toBeLessThanOrEqual(56);
    for (const name of ["Jump to message", "Delete"])
      expect(await detail.getByRole("button", { name }).count()).toBe(1);
    const previewRefreshBefore = (await page.evaluate(
      "window.__filesFetchOrder.filter(item => item === 'list').length",
    )) as number;
    expect(
      (
        await page.request.post(base + "__browser-test/append-files-message")
      ).ok(),
    ).toBeTrue();
    await page
      .getByText("Files recorded.", { exact: true })
      .waitFor({ state: "attached" });
    expect(
      (await page.evaluate(
        "window.__filesFetchOrder.filter(item => item === 'list').length",
      )) as number,
    ).toBe(previewRefreshBefore);
    const secondPreview = previewHolds.next();
    await page.evaluate("window.__filesClockOffset += 60000");
    await page.waitForFunction(
      `window.__filesFetchOrder.filter(item => item === 'list').length > ${previewRefreshBefore}`,
    );
    await secondPreview;
    expect(heldPreviews).toHaveLength(2);
    await heldPreviews[heldPreviews.length - 1].fulfill({
      json: {
        kind: "text",
        text: "bounded browser text preview",
        truncated: false,
      },
    });
    await detail
      .locator("pre", { hasText: "bounded browser text preview" })
      .waitFor();
    await page.unroute(`**/api/conversations/${fixture.demo}/files/**/preview`);
    let fetchOrder = (await page.evaluate(
      "window.__filesFetchOrder",
    )) as string[];
    expect(fetchOrder).toContain("list");
    expect(fetchOrder).toContain("preview-in-detail");
    expect(fetchOrder).not.toContain("preview-in-list");
    expect(await filesButton.getAttribute("aria-label")).toContain("2");
    const listRequests = fetchOrder.filter((item) => item === "list").length;
    const previewRequests = fetchOrder.filter(
      (item) => item === "preview-in-detail",
    ).length;
    await appendFilesMessage();
    await page.waitForFunction(
      `window.__filesFetchOrder.filter(item => item === 'list').length > ${listRequests}`,
    );
    await detail
      .locator("pre", { hasText: "bounded browser text preview" })
      .waitFor();
    fetchOrder = (await page.evaluate("window.__filesFetchOrder")) as string[];
    expect(
      fetchOrder.filter((item) => item === "preview-in-detail").length,
    ).toBe(previewRequests);
    const downloadEvent = page.waitForEvent("download");
    await detail.getByRole("link", { name: "Download" }).click();
    expect((await downloadEvent).suggestedFilename()).toBe("browser-notes.txt");
    await detail.getByRole("button", { name: "Jump to message" }).click();
    await page
      .locator(".file-jump-target", { hasText: "Browser files source message" })
      .waitFor();
    await showFilesList(page);
    const failed: Route[] = [];
    const failUrl = `**/api/conversations/${fixture.demo}/files?*`;
    await page.route(failUrl, (route) => {
      failed.push(route);
      return route.fulfill({ status: 503, json: { error: "browser failure" } });
    });
    const failedBefore = (await page.evaluate(
      "window.__filesFetchOrder.filter(item => item === 'list').length",
    )) as number;
    const failedResponse = page.waitForResponse((r) =>
      r.url().includes(`/conversations/${fixture.demo}/files?`),
    );
    await appendFilesMessage();
    await page.waitForFunction(
      `window.__filesFetchOrder.filter(item => item === 'list').length > ${failedBefore}`,
    );
    await (await failedResponse).finished();
    expect(failed).toHaveLength(1);
    await pane
      .locator(".files-error", { hasText: "Couldn’t refresh files" })
      .waitFor();
    expect(await pane.isVisible()).toBeTrue();
    await page.unroute(failUrl);
    const retry = (await page.evaluate(
      "window.__filesFetchOrder.filter(item => item === 'list').length",
    )) as number;
    await pane.getByRole("button", { name: "Retry" }).click();
    await page.waitForFunction(
      `window.__filesFetchOrder.filter(item => item === 'list').length > ${retry}`,
    );
    await pane.locator(".files-card").first().waitFor();
    expect(await pane.isVisible()).toBeTrue();
    await imageCard.locator(".files-thumb").click();
    const imageView = page.locator(".pane-col.file-tab:visible");
    await imageView
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    const imagePanel = (await imageView.getAttribute("data-pane"))!;
    await closeFileTab(page, imagePanel);
    expect(await imageCard.isVisible()).toBeTrue();
    expect(await pane.locator(".files-detail").count()).toBe(0);
    await imageCard.locator(".files-thumb").click();
    await imageView
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    expect(await imageView.getAttribute("data-pane")).toBe(imagePanel);
    await showFilesList(page);
    const heldRequests = heldRoutes();
    const held = heldRequests.routes;
    const filesUrl = `**/api/conversations/${fixture.demo}/files?*`;
    await page.route(filesUrl, (route) => {
      heldRequests.hold(route);
    });
    const firstHeld = heldRequests.next();
    await pane.locator(".pane-title").focus();
    const listBefore = (await page.evaluate(
      "window.__filesFetchOrder.filter(item => item === 'list').length",
    )) as number;
    await appendFilesMessage();
    await page.waitForFunction(
      `window.__filesFetchOrder.filter(item => item === 'list').length > ${listBefore}`,
    );
    await firstHeld;
    expect(held).toHaveLength(1);
    expect(await pane.isVisible()).toBeTrue();
    expect(
      await page.evaluate(
        "document.activeElement?.closest('.pane-col[data-pane=\\\"files\\\"]') !== null",
      ),
    ).toBeTrue();
    const continued = page.waitForResponse((r) =>
      r.url().includes(`/api/conversations/${fixture.demo}/files?`),
    );
    await held[0].continue();
    expect((await continued).ok()).toBeTrue();
    await pane.locator(".files-card").first().waitFor();
    const secondHeld = heldRequests.next();
    await pane.locator(".pane-title").focus();
    await appendFilesMessage();
    await secondHeld;
    expect(held).toHaveLength(2);
    expect(await pane.isVisible()).toBeTrue();
    expect(
      await page.evaluate(
        "document.activeElement?.closest('.pane-col[data-pane=\\\"files\\\"]') !== null",
      ),
    ).toBeTrue();
    await emptyFiles(held[1]);
    await page.waitForFunction(
      "!document.querySelector('.pane-col[data-pane=\\\"files\\\"]')",
      { timeout: 15_000 },
    );
    expect(
      await page.evaluate(
        `document.activeElement?.closest('.agent')?.dataset.id === ${JSON.stringify(fixture.demo)}`,
      ),
    ).toBeTrue();
    await page.unroute(filesUrl);
    expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
    await mobileFiles(browser, base, fixture);
    const staleContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const stalePage = await staleContext.newPage();
    const staleErrors = captureErrors(stalePage);
    const staleRequests = heldRoutes();
    const heldStale = staleRequests.routes;
    const staleFilesButton = stalePage.locator('.rail-btn[data-pane="files"]');
    await gotoRoot(stalePage, base);
    await stalePage.locator(`.agent[data-id="${fixture.demo}"]`).click();
    await stalePage
      .locator("#conv-title", { hasText: "Files demo agent" })
      .waitFor();
    await staleFilesButton.waitFor({ timeout: 15_000 });
    await stalePage.route(
      `**/api/conversations/${fixture.demo}/files?*`,
      (route) => {
        staleRequests.hold(route);
      },
    );
    const staleHeld = staleRequests.next(10_000);
    await staleFilesButton.click();
    await staleHeld;
    expect(heldStale.length).toBeGreaterThan(0);
    await stalePage.locator(`.agent[data-id="${fixture.empty}"]`).click();
    await heldStale[0]
      .fulfill({
        json: {
          files: [
            {
              key: "upload:stale",
              storage: "upload",
              id: "stale",
              name: "STALE FOREIGN CARD",
              size: 1,
              media_type: "text/plain",
              preview: "none",
              references: 1,
              sources: [
                {
                  offset: 1,
                  turn_id: "stale",
                  role: "operator",
                  timestamp: null,
                },
              ],
            },
          ],
          cursor: null,
          generation: 0,
          done: true,
        },
      })
      .catch(() => undefined);
    await stalePage
      .locator("#conv-title", { hasText: "Files empty agent" })
      .waitFor();
    expect(
      await stalePage
        .locator(".files-card", { hasText: "STALE FOREIGN CARD" })
        .count(),
    ).toBe(0);
    await staleFilesButton.waitFor({ timeout: 15_000 });
    await staleFilesButton.click();
    const stalePane = stalePage.locator('.pane-col[data-pane="files"]');
    await stalePane
      .locator(".files-card", { hasText: "empty-agent.txt" })
      .waitFor();
    expect(
      await stalePage
        .locator(".files-card", { hasText: "STALE FOREIGN CARD" })
        .count(),
    ).toBe(0);
    expect(staleErrors).toEqual([]);
    await staleContext.close();
  },
  // Regression: #2736 image viewer navigation counts up towards newer files.
  async function test_files_image_navigation(browser, base) {
    const fixture = (await postFixture(
      base,
      "seed-image-navigation",
    )) as ImageNavigationFixture;
    const { context, page, errors } = await filePage(browser, 1280, 800);
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("#conv-title", { hasText: "Files image navigation" })
      .waitFor();
    await page.locator('#messages img[alt="nav-2.png"]').click();
    const viewer = page.locator("dialog.image-popout");
    await viewer.waitFor();
    expect(await viewer.locator(".files-position").count()).toBe(0);
    await viewer.getByRole("button", { name: "Open in Files" }).click();
    const pane = filesSurface(page);
    const detail = pane.locator(".files-detail");
    await pane.locator('.files-detail[aria-label="nav-2.png"]').waitFor();
    const position = pane.locator(".files-position");
    expect(await position.textContent()).toBe("2 of 3");
    const previous = pane.getByRole("button", { name: "Previous file" });
    while (!(await previous.isDisabled())) await previous.click();
    expect(await position.textContent()).toBe("1 of 3");
    expect(await detail.getAttribute("aria-label")).toBe("nav-1.png");
    const next = pane.getByRole("button", { name: "Next file" });
    await next.click();
    expect(await position.textContent()).toBe("2 of 3");
    const middle = await detail.getAttribute("aria-label");
    await next.click();
    expect(await position.textContent()).toBe("3 of 3");
    const last = await detail.getAttribute("aria-label");
    expect(last).toBe("nav-3.png");
    expect(await next.isDisabled()).toBeTrue();
    await page.keyboard.press("ArrowLeft");
    await pane.locator('.files-detail[aria-label="nav-2.png"]').waitFor();
    expect(await position.textContent()).toBe("2 of 3");
    expect(await detail.getAttribute("aria-label")).toBe(middle);
    await page.keyboard.press("ArrowRight");
    await pane.locator('.files-detail[aria-label="nav-3.png"]').waitFor();
    expect(await detail.getAttribute("aria-label")).toBe(last);
    await showFilesList(page);
    await pane.locator(".files-card").nth(2).waitFor();
    expect(
      await pane.locator(".files-card").first().getAttribute("aria-label"),
    ).toBe(last);
    await pane.locator(".files-thumb").first().click();
    expect(await position.textContent()).toBe("3 of 3");
    await page.waitForFunction(
      "document.querySelector('.files-detail img')?.naturalWidth > 0",
    );
    await fileShot(page, `files-viewer-desktop.png`);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_session_files_pane_refreshes_on_composer_upload(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    expect(fixture).toBeTruthy();
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("#conv-title", { hasText: "Files demo agent" })
      .waitFor();
    await page.locator('.rail-btn[data-pane="files"]').click();
    const pane = filesSurface(page);
    await pane
      .locator(".files-card", { hasText: "browser-notes.txt" })
      .waitFor();
    expect(await pane.locator(".files-card").count()).toBe(2);
    await page.locator("#file-input").setInputFiles({
      name: "browser-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("browser upload bytes\n"),
    });
    await page
      .locator(".attach-chip", { hasText: "browser-upload.txt" })
      .waitFor();
    await pane
      .locator(".files-card", { hasText: "browser-upload.txt" })
      .waitFor({ timeout: 15_000 });
    expect(await pane.locator(".files-card").count()).toBe(3);
    await page
      .locator(".attach-chip", { hasText: "browser-upload.txt" })
      .locator(".rm")
      .click();
    await page.waitForFunction(
      "!document.querySelector('.pane-col[data-pane=\\\"files\\\"]')?.textContent?.includes('browser-upload.txt')",
      null,
      { timeout: 15_000 },
    );
    expect(await pane.locator(".files-card").count()).toBe(2);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_files_pane_hidden_when_empty(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    expect(fixture).toBeTruthy();
    const emptyUrl = `**/api/conversations/${fixture.empty}/files?*`;
    await page.route(emptyUrl, emptyFiles);
    await gotoRoot(page, base);
    const probe = page.waitForResponse((r) =>
      r.url().includes(`/conversations/${fixture.empty}/files?`),
    );
    await page.locator(`.agent[data-id="${fixture.empty}"]`).click();
    const probeResponse = await probe;
    expect(probeResponse.ok()).toBeTrue();
    const probeJson = (await probeResponse.json()) as { files: unknown[] };
    expect(probeJson.files).toEqual([]);
    await page
      .locator("#conv-title", { hasText: "Files empty agent" })
      .waitFor();
    await page.waitForFunction(
      "!document.querySelector('.rail-btn[data-pane=\"files\"]')",
      null,
      { timeout: 15_000 },
    );
    expect(await page.locator('.rail-btn[data-pane="files"]').count()).toBe(0);
    expect(await page.locator('.pane-col[data-pane="files"]').count()).toBe(0);
    await page.unroute(emptyUrl);
    await page.locator(`.agent[data-id="${fixture.demo}"]`).click();
    await page
      .locator("#conv-title", { hasText: "Files demo agent" })
      .waitFor();
    const filesButton = page.locator('.rail-btn[data-pane="files"]');
    await filesButton.waitFor({ timeout: 15_000 });
    await filesButton.click();
    const pane = filesSurface(page);
    await pane.locator(".files-card").first().waitFor();
    expect(await pane.isVisible()).toBeTrue();
    expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
  },
  // Feature: #2593 published diffs retain syntax and header-looking changed lines.
  async function test_published_diff_has_syntax_and_line_colours(
    browser,
    base,
  ) {
    const { demo } = await postFixture(base, "seed-published-diff");
    for (const width of [1280, 412]) {
      const { context, page, errors } = await filePage(browser, width, 900);
      try {
        await page.goto(`${base}#agent=${demo}`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .getByRole("button", { name: "Open review.diff in Files" })
          .click();
        const diff = filesSurface(page).locator(".files-detail .files-diff");
        await diff.locator(".diff-row.add .hljs-keyword").first().waitFor();
        expect(await diff.locator(".diff-row.del").count()).toBeGreaterThan(0);
        expect(
          await diff.locator(".diff-row.del", { hasText: "-- old" }).count(),
        ).toBe(1);
        expect(
          await diff.locator(".diff-row.add", { hasText: "++ new" }).count(),
        ).toBe(1);
        expect(
          await diff.locator(".diff-hunk", { hasText: "@@" }).count(),
        ).toBeGreaterThan(0);
        expect(
          await diff
            .locator(".files-diff-header", { hasText: "diff --git" })
            .count(),
        ).toBe(2);
        const colours = await diff.evaluate((element) => {
          const style = (selector: string) =>
            (globalThis as any).getComputedStyle(
              element.querySelector(selector)!,
            );
          return {
            add: style(".add").backgroundColor,
            del: style(".del").backgroundColor,
            syntax: style(".hljs-keyword").color,
            code: style(".diff-line").color,
          };
        });
        expect(colours.add).not.toBe(colours.del);
        expect(colours.syntax).not.toBe(colours.code);
        expect(
          await page
            .locator("body")
            .evaluate(
              (element) =>
                element.scrollWidth <= (globalThis as any).innerWidth,
            ),
        ).toBeTrue();
        if (process.env.SCREENSHOT_DIR)
          await page.screenshot({
            path: `${process.env.SCREENSHOT_DIR}/files-diff-${width}.png`,
          });
        for (const name of ["review.patch", "review.txt"]) {
          await showFilesList(page);
          await openListedFile(page, name);
          await filesSurface(page)
            .locator(".files-detail .files-diff .hljs-keyword")
            .first()
            .waitFor();
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #2255 published Files Markdown keeps sanitization
  async function test_published_file_opens_its_detail_view(browser, base) {
    for (const width of [1280, 390]) {
      const { context, page, errors } = await filePage(
        browser,
        width,
        844,
        width === 390,
      );
      const fixture = (await postFixture(base, "seed-published-markdown")) as {
        demo: string;
        id: string;
      };
      const remote: string[] = [];
      page.on("request", (request) => {
        if (!request.url().startsWith(base)) remote.push(request.url());
      });
      if (width === 390)
        await page.route("**/attachments/*/thumbnail", (route) =>
          route.fulfill({ status: 404, body: "not found" }),
        );
      try {
        await page.goto(`${base}#agent=${fixture.demo}`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .locator("#conv-title", { hasText: "Published files" })
          .waitFor();
        const item = page.locator(".agent-attachment-item.file", {
          hasText: "report.md",
        });
        await item.waitFor({ timeout: 15_000 });
        const chip = (await item.boundingBox())!;
        if (width === 1280) expect(chip.height).toBeLessThanOrEqual(34);
        expect(chip.width).toBeLessThan(220);
        if (process.env.FILE_CHIP_SCREENSHOTS)
          await page.screenshot({
            path: `${process.env.FILE_CHIP_SCREENSHOTS}/desktop-reply.png`,
          });
        expect(
          await item
            .locator(".agent-attachment-file-download")
            .getAttribute("href"),
        ).toBe(`/api/conversations/${fixture.demo}/attachments/${fixture.id}`);
        await item
          .getByRole("button", { name: "Open report.md in Files" })
          .click();
        if (width === 1280)
          expect(
            await page.locator(".dv-tab", { hasText: "report.md" }).count(),
          ).toBe(1);
        const list = page.locator('.pane-col[data-pane="files"]');
        const pane =
          width === 1280 ? page.locator(".pane-col.file-tab:visible") : list;
        const detail = pane;
        await detail.locator(".files-markdown h1").waitFor({ timeout: 15_000 });
        expect(await detail.locator(".files-markdown h1").innerText()).toBe(
          "Weekly report",
        );
        expect(await detail.locator(".files-markdown strong").innerText()).toBe(
          "previews",
        );
        await detail.locator(".files-markdown .mermaid-host svg").waitFor();
        await detail.locator(".files-markdown .katex-display .katex").waitFor();
        expect(await detail.locator(".files-markdown .katex").count()).toBe(2);
        await detail
          .locator('.files-markdown img[alt="Local diagram"]:not([hidden])')
          .waitFor();
        const image = detail.locator(
          '.files-markdown img[alt="Local diagram"]',
        );
        expect(await image.getAttribute("src")).toMatch(
          width === 390 ? /\/preview$/ : /\/thumbnail$/,
        );
        expect((await image.boundingBox())!.height).toBeGreaterThan(360);
        expect((await image.boundingBox())!.width).toBeGreaterThan(0);
        expect(
          await detail
            .locator(".files-markdown table")
            .evaluate(
              (table: any) =>
                table.getBoundingClientRect().width <=
                table.closest(".artifact-markdown").getBoundingClientRect()
                  .width,
            ),
        ).toBeTrue();
        for (const alt of ["Absolute path", "Unpublished relative path"]) {
          const local = detail.locator(
            `.files-markdown img[alt="${alt}"]:not([hidden])`,
          );
          await local.waitFor();
          await local.evaluate((image: any) => image.decode());
          expect(await local.getAttribute("src")).toContain("/path-image?");
        }
        await detail
          .getByRole("button", {
            name: "Show image from example.com",
            exact: true,
          })
          .waitFor();
        const disguised = detail.getByRole("button", {
          name: "Expand details",
          exact: true,
        });
        expect(await disguised.getAttribute("data-external-image")).toBeNull();
        await disguised.click();
        expect(await disguised.innerText()).toBe("Expand details");
        expect(remote).toEqual([]);
        expect(await pane.locator(".files-grid").count()).toBe(0);
        if (process.env.SCREENSHOT_DIR) {
          const screenshotWidth = width === 390 ? 412 : width;
          await page.setViewportSize({ width: screenshotWidth, height: 844 });
          await detail
            .locator('img[alt="Absolute path"]')
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${process.env.SCREENSHOT_DIR}/files-detail-markdown-${screenshotWidth}.png`,
          });
          await page.setViewportSize({ width, height: 844 });
        }
        await dispatchArtifactSelection(
          page,
          width === 390 ? "touch" : "mouse",
          "Weekly report",
        );
        const popover = page.locator(".report-comment-popover:not([hidden])");
        await popover.waitFor();
        await popover.locator("textarea").fill("Explain the report");
        if (width !== 390) {
          const input = popover.locator("textarea");
          await input.click();
          expect(
            await input.evaluate(
              (element: any) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          await pane.locator(".pane-body").focus();
          await page.keyboard.press("c");
          expect(
            await input.evaluate(
              (element: any) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          expect(await input.inputValue()).toBe("Explain the report");
          expect(await pane.locator(".report-comment").count()).toBe(0);
          await pane.locator(".pane-body").focus();
          await page.keyboard.press("z");
          expect(await pane.getAttribute("class")).toContain("fullscreen");
          expect(await pane.getAttribute("role")).toBe("region");
          expect(await pane.getAttribute("aria-modal")).toBeNull();
          await popover.waitFor();
          await page.keyboard.press("c");
          expect(
            await input.evaluate(
              (element: any) => element === element.ownerDocument.activeElement,
            ),
          ).toBe(true);
          await page.keyboard.press("c");
          expect(await input.inputValue()).toBe("Explain the reportc");
          await page.keyboard.press("Backspace");
          await pane.locator(".pane-body").focus();
          await page.keyboard.press("z");
        }
        await popover.getByRole("button", { name: "Comment" }).click();
        expect(await pane.locator("mark.report-cmark").textContent()).toBe(
          "Weekly report",
        );
        if (width === 1280) {
          if (!(await list.isVisible()))
            await page.locator('.rail-btn[data-pane="files"]').click();
          await list.locator(".files-grid").waitFor();
          expect(await list.locator(".files-grid").count()).toBe(1);
          expect(
            await detail.getByRole("button", { name: "All files" }).count(),
          ).toBe(0);
          await page.locator('.dv-tab[data-dock-panel="files"]').click();
        } else await showFilesList(page);
        const card = list.locator(".files-card", { hasText: "report.md" });
        await card.waitFor();
        expect(await card.locator(".files-markdown").count()).toBe(0);
        await card.getByRole("button", { name: "Open report.md" }).click();
        await pane.locator(".files-detail .files-markdown h1").waitFor();
        expect(remote).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_svg_audio_and_video_preview_in_the_detail_view(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = (await postFixture(base, "seed-published-media")) as {
      demo: string;
    };
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page
        .locator("#conv-title", { hasText: "Published media" })
        .waitFor();
      let detail = await openReplyFile(page, "chart.svg");
      const svg = detail.locator(".files-detail img");
      await svg.waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        (el: any) => el.complete && el.naturalWidth === 40,
        await svg.elementHandle(),
      );
      detail = await openReplyFile(page, "tone.wav");
      const audio = detail.locator("audio.files-media");
      await audio.waitFor();
      await page.waitForFunction(
        (el: any) => el.duration > 0,
        await audio.elementHandle(),
      );
      detail = await openReplyFile(page, "clip.webm");
      const video = detail.locator("video.files-media");
      await video.waitFor();
      expect(await video.getAttribute("src")).toEndWith("/preview");
      await showFilesList(page);
      const card = page.locator(".files-card", { hasText: "tone.wav" });
      await card.waitFor();
      expect(await card.locator("audio, .files-preview-note").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_pdf_pages_draw_in_the_detail_view(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = (await postFixture(base, "seed-published-pdf")) as {
      demo: string;
    };
    const pdfRequests: string[] = [];
    const pdfWorkers = () =>
      page
        .workers()
        .filter((worker) => worker.url().endsWith("/pdf.worker.js"));
    const remote: string[] = [];
    context.on("request", (request) => {
      const url = request.url();
      if (/^https?:/.test(url) && !url.startsWith(base)) remote.push(url);
    });
    page.on("request", (request) => {
      if (/\/static\/pdf/.test(request.url())) pdfRequests.push(request.url());
    });
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page.locator("#conv-title", { hasText: "Published PDF" }).waitFor();
      expect(pdfRequests).toEqual([]);
      const initialWorker = page.waitForEvent("worker", { timeout: 10_000 });
      let detail = await openReplyFile(page, "slides.pdf");
      const pages = detail.locator(".files-pdf-page");
      await detail
        .getByRole("img", { name: "Page 2 of 2" })
        .waitFor({ timeout: 15_000 });
      expect(await pages.count()).toBe(2);
      const first = await pages.first().elementHandle();
      await waitForDrawn(pages.first());
      const pixel = await page.evaluate((el: any) => {
        const data = el
          .getContext("2d")
          .getImageData(el.width / 2, el.height / 2, 1, 1).data;
        return [data[0], data[1], data[2]];
      }, first);
      expect(pixel[0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(60);
      expect(
        pdfRequests.some((url) => url.endsWith("/static/pdfjs/pdf.worker.js")),
      ).toBe(true);
      await initialWorker;
      expect(pdfWorkers()).toHaveLength(1);
      const firstClosed = pdfWorkers()[0].waitForEvent("close", {
        timeout: 10_000,
      });
      await closeFileTab(page);
      await firstClosed;
      expect(pdfWorkers()).toHaveLength(0);
      await showFilesList(page);
      const reopened = page.waitForEvent("worker", { timeout: 10_000 });
      await openListedFile(page, "slides.pdf");
      await detail.getByRole("img", { name: "Page 1 of 2" }).waitFor();
      const reopenedWorker = await reopened;
      expect(pdfWorkers()).toHaveLength(1);
      const cmap = page.waitForResponse((response) =>
        response.url().endsWith("/static/pdfjs/cmaps/UniJIS-UCS2-H.bcmap"),
      );
      const notesWorker = page.waitForEvent("worker", { timeout: 10_000 });
      detail = await openReplyFile(page, "notes-ja.pdf");
      expect((await cmap).status()).toBe(200);
      await waitForDrawn(detail.getByRole("img", { name: "Page 1 of 1" }));
      const notes = await notesWorker;
      expect(pdfWorkers()).toHaveLength(2);
      expect(pdfWorkers()).toContain(reopenedWorker);
      const notesClosed = notes.waitForEvent("close", { timeout: 10_000 });
      await closeFileTab(page);
      await notesClosed;
      expect(pdfWorkers()).toHaveLength(1);
      detail = await openReplyFile(page, "long.pdf");
      const last = detail.getByRole("img", { name: "Page 16 of 16" });
      await last.waitFor({ timeout: 15_000 });
      await waitForDrawn(detail.getByRole("img", { name: "Page 1 of 16" }));
      expect(
        await detail.locator('.files-pdf-page[data-drawn="true"]').count(),
      ).toBeLessThan(16);
      const box = (await detail
        .getByRole("img", { name: "Page 1 of 16" })
        .boundingBox())!;
      await page.keyboard.down("Control");
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.2, {
        steps: 8,
      });
      await page.mouse.up();
      await page.keyboard.up("Control");
      await page
        .locator(".report-comment-popover textarea")
        .fill("Retained PDF note");
      await page.keyboard.press("Escape");
      const retained = await detail.locator(".pane-body").elementHandle();
      await detail.locator(".pane-body").focus();
      await page.keyboard.press("Escape");
      await page.waitForFunction((body: any) => !body.isConnected, retained);
      await openReplyFile(page, "notes-ja.pdf");
      detail = await openReplyFile(page, "long.pdf");
      expect(
        await detail
          .locator(".pane-body")
          .evaluate((node, prior) => node === prior, retained),
      ).toBeTrue();
      await detail.locator("mark.report-cbox").waitFor();
      await detail.locator(".report-comment-del").click();
      await detail.locator(".pane-body").focus();
      await page.keyboard.press("Shift+G");
      await waitForDrawn(last);
      await page.waitForFunction(
        (el: any) => !el.dataset.drawn && el.width === 0,
        await detail.getByRole("img", { name: "Page 1 of 16" }).elementHandle(),
        { timeout: 15_000 },
      );
      await page.keyboard.press("g");
      await page.keyboard.press("g");
      await waitForDrawn(
        detail.getByRole("img", { name: "Page 1 of 16" }),
        30_000,
      );
      for (const [path, status] of [
        ["wasm/openjpeg.wasm", 200],
        ["wasm/jbig2.wasm", 200],
        ["standard_fonts/FoxitSerif.pfb", 200],
        ["iccs/CGATS001Compat-v2-micro.icc", 200],
        ["wasm/quickjs-eval.wasm", 404],
      ] as const) {
        const response = await page.request.get(`${base}static/pdfjs/${path}`);
        expect([path, response.status()]).toEqual([path, status]);
      }
      const closing = pdfWorkers().map((worker) =>
        worker.waitForEvent("close", { timeout: 10_000 }),
      );
      for (const id of await page
        .locator(".pane-col.file-tab")
        .evaluateAll((panels) =>
          panels.map((panel) => panel.getAttribute("data-pane")!),
        ))
        await closeFileTab(page, id);
      const brokenWorker = page
        .waitForEvent("worker", { timeout: 10_000 })
        .then((worker) => worker.waitForEvent("close", { timeout: 10_000 }));
      detail = await openReplyFile(page, "broken.pdf");
      await detail
        .getByText("Couldn’t show this PDF. Download it to open it.")
        .waitFor({ timeout: 15_000 });
      expect(await detail.locator(".files-pdf-page").count()).toBe(0);
      await Promise.all([...closing, brokenWorker]);
      expect(pdfWorkers()).toHaveLength(0);
      expect(remote).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_pdf_draws_on_a_phone_browser_without_newer_builtins(
    browser,
    base,
  ) {
    const printer = await browser.newPage();
    await printer.setContent(`<body style="font: 16px serif"><script>
      for (let n = 1; n <= 3; n++) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 500;
        const context = canvas.getContext("2d");
        const noise = context.createImageData(500, 500);
        for (let i = 0; i < noise.data.length; i++)
          noise.data[i] = Math.random() * 256;
        context.putImageData(noise, 0, 0);
        document.body.insertAdjacentHTML("beforeend",
          '<div style="break-after: page"><h1>Page ' + n + " report</h1><p>" +
          "Quarterly figures. ".repeat(60) + '</p><img src="' +
          canvas.toDataURL() + '" style="width: 400px"></div>');
      }
    </script></body>`);
    const pdf = await printer.pdf({ format: "A4" });
    await printer.close();
    const seeded = await fetch(`${base}__browser-test/seed-posted-pdf`, {
      method: "POST",
      body: new Uint8Array(pdf),
    });
    const { demo } = (await seeded.json()) as { demo: string };
    const { context, page, errors } = await filePage(browser, 412, 915, true);
    const older =
      "delete Promise.try; delete Math.sumPrecise;" +
      "for (const name of ['getOrInsert', 'getOrInsertComputed']) {" +
      " delete Map.prototype[name]; delete WeakMap.prototype[name]; }" +
      "for (const name of ['fromBase64', 'fromHex']) delete Uint8Array[name];" +
      "for (const name of ['toBase64', 'toHex', 'setFromBase64', 'setFromHex'])" +
      " delete Uint8Array.prototype[name];";
    await context.addInitScript(older);
    await context.route("**/static/pdfjs/pdf.worker.js", async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: `${older}\n${await response.text()}`,
      });
    });
    const workers: string[] = [];
    page.on("worker", (worker) => workers.push(worker.url()));
    try {
      await page.goto(`${base}#agent=${demo}`);
      await page.locator("#conv-title", { hasText: "Posted PDF" }).waitFor();
      await page
        .getByRole("button", { name: "Open report.pdf in Files" })
        .click();
      const first = page
        .locator('.pane-col[data-pane="files"] .files-detail')
        .getByRole("img", { name: "Page 1 of 3" });
      await first.waitFor({ timeout: 30_000 });
      await waitForDrawn(first, 30_000);
      const dark = await first.evaluate((el: any) => {
        const height = Math.floor(el.height * 0.2);
        const { data } = el
          .getContext("2d")
          .getImageData(0, 0, el.width, height);
        let count = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) count++;
        return count;
      });
      expect(dark).toBeGreaterThan(100);
      expect(workers).toEqual([`${base}static/pdfjs/pdf.worker.js`]);
      expect(errors).toEqual([]);
    } finally {
      await closeWithRoutes(context);
    }
  },
  async function test_a_newer_reply_file_opens_from_an_open_pane(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = (await postFixture(base, "seed-published-later")) as {
      demo: string;
    };
    const listing = `**/api/conversations/${demo}/files?*`;
    let firstListing: string | null = null;
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    await page.route(listing, async (route) => {
      firstListing ??= await (await route.fetch()).text();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: firstListing,
      });
    });
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const filesButton = page.locator('.rail-btn[data-pane="files"]');
      await filesButton.waitFor({ timeout: 15_000 });
      await filesButton.click();
      const pane = filesSurface(page);
      const list = page.locator('.pane-col[data-pane="files"]');
      const file = page.locator(".pane-col.file-tab:visible");
      await pane.locator(".files-card", { hasText: "first.md" }).waitFor();
      const later = (await postFixture(base, "publish-later-file")) as {
        name: string;
      };
      const chip = page.getByRole("button", {
        name: `Open ${later.name} in Files`,
      });
      await chip.waitFor({ timeout: 15_000 });
      expect(
        await pane.locator(".files-card", { hasText: later.name }).count(),
      ).toBe(0);
      await page.unroute(listing);
      await chip.click();
      await pane
        .locator(".files-detail h1", { hasText: later.name })
        .waitFor({ timeout: 15_000 });
      await showFilesList(page);
      await page.route(`**/api/conversations/${demo}/files?*`, (route) =>
        route.fulfill({ status: 500, body: "{}" }),
      );
      const failed = (await postFixture(base, "publish-later-file")) as {
        name: string;
      };
      await page.locator('.dv-tab[data-dock-panel="chat"]').click();
      const failedChip = page.getByRole("button", {
        name: `Open ${failed.name} in Files`,
      });
      await failedChip.waitFor({ timeout: 15_000 });
      await failedChip.click();
      await pane.locator(".files-error").waitFor({ timeout: 15_000 });
      expect(
        await pane.getByRole("button", { name: "All files" }).count(),
      ).toBe(1);
      await page.unroute(`**/api/conversations/${demo}/files?*`);
      await pane.getByRole("button", { name: "Retry" }).click();
      await page
        .locator(".pane-col.file-tab:visible")
        .locator(".files-detail h1", { hasText: failed.name })
        .waitFor({ timeout: 15_000 });
      await page.route(listing, async (route) => {
        const response = await route.fetch();
        refreshStarted.resolve();
        await releaseRefresh.promise;
        await route.fulfill({ response });
      });
      const newest = (await postFixture(base, "publish-later-file")) as {
        name: string;
      };
      await refreshStarted.promise;
      await page.route(`**/api/conversations/${demo}/attachments/*`, (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({ status: 500, body: "{}" })
          : route.continue(),
      );
      await closeFileTab(page, "files");
      page.once("dialog", (dialog) => void dialog.accept());
      await file.getByRole("button", { name: "Delete" }).click();
      const deletionError = `Couldn’t delete ${failed.name}.`;
      await pane
        .locator(".files-error", { hasText: deletionError })
        .waitFor({ timeout: 15_000 });
      expect(
        await pane
          .locator(".files-detail h1", { hasText: failed.name })
          .count(),
      ).toBe(1);
      releaseRefresh.resolve();
      await pane.locator(".files-position", { hasText: "of 4" }).waitFor();
      expect(
        await pane
          .locator(".files-error", { hasText: deletionError })
          .isVisible(),
      ).toBeTrue();
      await page.unroute(`**/api/conversations/${demo}/attachments/*`);
      await pane.getByRole("button", { name: "Next file" }).click();
      await pane
        .locator(".files-detail h1", { hasText: newest.name })
        .waitFor();
      page.once("dialog", (dialog) => void dialog.accept());
      await pane.getByRole("button", { name: "Delete" }).click();
      await showFilesList(page);
      await list.locator(".files-summary", { hasText: "3 files" }).waitFor();
      expect(
        await list
          .locator(".files-error", { hasText: deletionError })
          .isVisible(),
      ).toBeTrue();
      page.once("dialog", (dialog) => void dialog.accept());
      await file.getByRole("button", { name: "Retry" }).click();
      await list.locator(".files-summary", { hasText: "2 files" }).waitFor();
      expect(await list.locator(".files-error").count()).toBe(0);
      expect(
        await list.locator(".files-card", { hasText: failed.name }).count(),
      ).toBe(0);
      expect(errors.filter((error) => !error.includes("500"))).toEqual([]);
    } finally {
      releaseRefresh.resolve();
      await closeWithRoutes(context);
    }
  },
  async function test_large_files_download_natively(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-published-sizes");
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const source = async (link: any) => {
        await link.waitFor({ timeout: 15_000 });
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          link.click(),
        ]);
        return [download.url().split(":")[0], download.suggestedFilename()];
      };
      const chip = (name: string) =>
        page.getByRole("link", { name: new RegExp(`^Download ${name}`) });
      expect(await source(chip("small.bin"))).toEqual(["blob", "small.bin"]);
      expect(await source(chip("large.bin"))).toEqual(["http", "large.bin"]);
      await page
        .getByRole("button", { name: "Open large.bin in Files" })
        .click();
      const pane = filesSurface(page);
      expect(
        await source(pane.getByRole("link", { name: "Download" })),
      ).toEqual(["http", "large.bin"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_a_republished_file_keeps_its_versions(browser, base) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-published-versions");
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const chips = page.getByRole("button", {
        name: "Open report.md in Files",
      });
      await chips.nth(2).waitFor({ timeout: 15_000 });
      await chips.first().click();
      const pane = filesSurface(page);
      const heading = pane.locator(".files-detail .files-markdown h1");
      await heading.waitFor({ timeout: 15_000 });
      expect(await heading.innerText()).toBe("Draft 1");
      await pane.getByLabel("File options", { exact: true }).click();
      const menu = pane.getByRole("combobox", { name: "Version" });
      const firstId = await pane.getAttribute("data-pane");
      const firstValue = await menu.inputValue();
      const options = await menu
        .locator("option")
        .evaluateAll((items: any[]) =>
          items.map((item) => [
            item.textContent.trim().split(" ")[1],
            item.textContent.includes("latest"),
            item.selected,
          ]),
        );
      expect(options).toEqual([
        ["3", true, false],
        ["2", false, false],
        ["1", false, true],
      ]);
      await menu.selectOption({ index: 0 });
      await pane
        .locator(".files-detail .files-markdown h1", { hasText: "Draft 3" })
        .waitFor();
      await page.locator(`.dv-tab[data-dock-panel="${firstId}"]`).click();
      expect(await heading.innerText()).toBe("Draft 1");
      await pane.getByLabel("File options", { exact: true }).click();
      expect(await menu.inputValue()).toBe(firstValue);
      await showFilesList(page);
      const card = pane.locator(".files-card");
      await card.first().waitFor();
      expect(await card.count()).toBe(1);
      expect(await renderedText(card.locator(".files-meta"))).toContain(
        "3 versions",
      );
      await card.getByRole("button", { name: "Open report.md" }).click();
      await pane
        .locator(".files-detail .files-markdown h1", { hasText: "Draft 3" })
        .waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_a_published_file_opens_files_and_follows_new_versions(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-files-auto-open");
    const republish = async () =>
      ((await postFixture(base, "republish-auto-open")) as { draft: number })
        .draft;
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page.locator('.rail-btn[data-pane="files"]').waitFor({
        timeout: 15_000,
      });
      expect(await page.locator(".pane-col.file-tab").count()).toBe(0);
      const first = await republish();
      const firstView = page.locator(".pane-col.file-tab").filter({
        has: page.getByRole("heading", {
          name: `Draft ${first}`,
          exact: true,
          includeHidden: true,
        }),
      });
      await firstView.locator("h1").waitFor({ state: "attached" });
      expect(
        await page
          .locator('.dv-tab[data-dock-panel="chat"]')
          .getAttribute("class"),
      ).toContain("dv-active-tab");
      const second = await republish();
      await firstView
        .locator('select[aria-label="Version"] option', {
          hasText: `Version ${second}`,
        })
        .waitFor({ state: "attached" });
      expect(await firstView.locator("h1").textContent()).toBe(
        `Draft ${first}`,
      );
      await page
        .getByRole("button", { name: "Open report.md in Files" })
        .nth(second - 1)
        .click();
      const pane = page.locator(".pane-col.file-tab:visible");
      const heading = pane.locator(".files-markdown h1");
      await heading.filter({ hasText: `Draft ${second}` }).waitFor();
      await pane.getByLabel("File options", { exact: true }).click();
      await pane
        .getByRole("combobox", { name: "Version" })
        .selectOption({ index: 1 });
      await heading.filter({ hasText: `Draft ${first}` }).waitFor();
      expect(await page.locator(".pane-col.file-tab").count()).toBe(2);
      const third = await republish();
      await pane.getByLabel("File options", { exact: true }).click();
      await pane
        .getByRole("combobox", { name: "Version" })
        .locator("option", { hasText: `Version ${third}` })
        .waitFor({ state: "attached" });
      expect(await heading.innerText()).toBe(`Draft ${first}`);
      await page
        .locator(`.agent[data-id]:not([data-id="${demo}"])`)
        .first()
        .click();
      await page.waitForFunction(
        () => !(globalThis as any).document.querySelector(".pane-col.file-tab"),
      );
      const fourth = await republish();
      const focusedResponse = page.waitForResponse(
        (r) =>
          r.url().includes(`/conversations/${demo}?`) &&
          r.url().includes("focused=1"),
      );
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await (await focusedResponse).finished();
      await page
        .getByRole("button", {
          name: "Open report.md in Files",
          includeHidden: true,
        })
        .nth(fourth - 1)
        .waitFor({ state: "attached" });
      await heading.filter({ hasText: `Draft ${first}` }).waitFor();
      expect(await page.locator(".pane-col.file-tab").count()).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_a_bash_publish_shows_every_file_on_the_reply(
    browser,
    base,
  ) {
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const { demo } = await postFixture(base, "seed-published-bash");
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const chip = (name: string) =>
        page.getByRole("button", { name: `Open ${name} in Files` });
      await chip("plan.md").waitFor({ timeout: 15_000 });
      await chip("notes.txt").waitFor();
      await chip("plan.md").click();
      await page
        .locator(
          ".pane-col.file-tab:visible .files-detail .files-markdown h1",
          {
            hasText: "Plan",
          },
        )
        .waitFor({ timeout: 15_000 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  // Feature: #2666 selected text in a Files text preview stages Artifact-style comments.
  async function test_text_file_selection_comments(browser, base) {
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    for (const width of [1280, 412]) {
      const mobile = width === 412;
      const { context, page, errors } = await filePage(
        browser,
        width,
        844,
        mobile,
      );
      await page.goto(`${base}#agent=${fixture.demo}`, {
        waitUntil: "domcontentloaded",
      });
      if (mobile) {
        const menu = page.locator('.pane-menu-item[data-pane="files"]');
        await page.waitForFunction(
          `(/Files \\(\\d+\\)/).test(document.querySelector('.pane-menu-item[data-pane="files"]')?.textContent || '')`,
        );
        const more = page.locator("#pane-fab");
        expect(await more.getAttribute("aria-label")).toBe("More actions");
        expect(await more.getAttribute("title")).toBe("More actions");
        expect(await more.locator(".badge").count()).toBe(0);
        await more.click();
        expect(await menu.innerText()).toMatch(/Files \(\d+\)/);
        await menu.click();
      } else await page.locator('.rail-btn[data-pane="files"]').click();
      const pane = filesSurface(page);
      await openListedFile(page, "browser-notes.txt");
      const text = pane.locator(".files-detail pre", {
        hasText: "bounded browser text preview",
      });
      await text.waitFor();
      if (mobile) await dispatchArtifactSelection(page, "touch", "bounded");
      else {
        const range = await text.evaluate((pre: any) => {
          const node = pre.ownerDocument.createTreeWalker(pre, 4).nextNode();
          const range = pre.ownerDocument.createRange();
          range.setStart(node, 0);
          range.setEnd(node, "bounded".length);
          const rect = range.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            y: (rect.top + rect.bottom) / 2,
          };
        });
        await page.mouse.move(range.left + 1, range.y);
        await page.mouse.down();
        await page.mouse.move(range.right - 1, range.y, { steps: 8 });
        await page.mouse.up();
      }
      const popover = page.locator(".report-comment-popover");
      await popover.waitFor();
      await popover.locator("textarea").fill(`Explain this at ${width}`);
      await popover.getByRole("button", { name: "Comment" }).click();
      const card = pane.locator(".report-comment");
      await card.waitFor();
      expect(await card.locator("blockquote").textContent()).toBe("bounded");
      expect(await pane.locator("mark.report-cmark").textContent()).toBe(
        "bounded",
      );
      await fileShot(page, `files-text-comment-${width}.png`);
      const delivered = page.waitForRequest((request) =>
        request.url().endsWith(`/api/conversations/${fixture.demo}/deliver`),
      );
      await pane.getByRole("button", { name: "Submit comments" }).click();
      const content = (await delivered).postDataJSON().content as string;
      expect(content).toMatch(
        new RegExp(
          `^Comments on file "browser-notes\\.txt" \\(id: [^)\\s]+\\):\n\n- line 1, chars 0-7:\n> bounded\nExplain this at ${width}$`,
        ),
      );
      await card.waitFor({ state: "detached" });
      expect(await pane.locator("mark.report-cmark").count()).toBe(0);
      expect(errors).toEqual([]);
      await context.close();
    }
    const { demo } = await postFixture(base, "seed-published-diff");
    const { context, page, errors } = await filePage(browser, 1280, 844);
    await page.goto(`${base}#agent=${demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("button", { name: "Open review.diff in Files" })
      .click();
    await filesSurface(page)
      .locator(".files-detail .files-diff .diff-row.add")
      .first()
      .waitFor();
    await dispatchArtifactSelection(page, "mouse", "++ new");
    const popover = page.locator(".report-comment-popover");
    await popover.locator("textarea").fill("Why add this?");
    await popover.getByRole("button", { name: "Comment" }).click();
    expect(
      await page.locator(".files-detail mark.report-cmark").textContent(),
    ).toBe("++ new");
    for (const [name, marks] of [
      ["review.patch", 0],
      ["review.diff", 1],
    ] as const) {
      await showFilesList(page);
      await openListedFile(page, name);
      await filesSurface(page)
        .locator(".files-detail .files-diff .diff-row.add")
        .first()
        .waitFor();
      await page.waitForFunction(
        ([detail, marks]: any) =>
          detail.querySelectorAll("mark.report-cmark").length === marks,
        [
          await filesSurface(page).locator(".files-detail").elementHandle(),
          marks,
        ],
      );
    }
    expect(await page.locator(".report-comment blockquote").textContent()).toBe(
      "++ new",
    );
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/conversations/${demo}/deliver`, async (route) => {
      await held;
      await route.continue();
    });
    const delivered = page.waitForResponse((response) =>
      response.url().endsWith(`/api/conversations/${demo}/deliver`),
    );
    const origin = (await page
      .locator(".pane-col.file-tab:visible")
      .getAttribute("data-pane"))!;
    await page.getByRole("button", { name: "Submit comments" }).click();
    await page.locator("[data-comment-send]").getByRole("status").waitFor();
    await page
      .locator(`.pane-col[data-pane="${origin}"] .report-bar`)
      .waitFor({ state: "hidden" });
    release();
    expect((await delivered).ok()).toBeTrue();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2693 Files touch taps need a hint and holds need visible feedback without breaking navigation.
  async function test_files_touch_scroll_pinch_and_pan(browser, base) {
    const { demo } = await postFixture(base, "seed-published-pdf");
    const { context, page, errors } = await filePage(browser, 412, 844, true);
    try {
      await page.goto(`${base}#agent=${demo}`);
      await page.getByRole("button", { name: "Open long.pdf in Files" }).tap();
      const pane = filesSurface(page);
      const detail = pane.locator(".files-detail");
      const touch = await context.newCDPSession(page);
      const drag = async (x: number, y: number, dx: number, dy: number) => {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x, y }],
        });
        for (let step = 1; step <= 10; step++)
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x: x + (dx * step) / 10, y: y + (dy * step) / 10 }],
          });
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      };
      await page.evaluate(
        `document.addEventListener('touchstart', event => window.__filesGestureTargets?.push(!!event.target.closest('.report-box-frame')));`,
      );
      for (const kind of ["pdf", "image"]) {
        if (kind === "image") {
          const printer = await browser.newPage({
            viewport: { width: 400, height: 1400 },
          });
          await printer.setContent(
            '<body style="margin:0;background:linear-gradient(red,blue);height:1400px"><h1>Scrollable image</h1></body>',
          );
          const buffer = await printer.screenshot();
          await printer.close();
          await page.locator("#file-input").setInputFiles({
            name: "scrollable.png",
            mimeType: "image/png",
            buffer,
          });
          await page
            .locator('.attach-chip img[alt="scrollable.png"]')
            .waitFor({ state: "attached" });
          await pane.getByRole("button", { name: "All files" }).tap();
          await pane
            .getByRole("button", { name: "Open scrollable.png", exact: true })
            .tap();
          await page
            .locator("dialog.image-popout")
            .getByRole("button", { name: "Open in Files" })
            .tap();
          await page.waitForFunction(
            "document.querySelector('.files-detail img')?.naturalHeight === 1400",
          );
        } else {
          await pane
            .locator('.files-pdf-page[data-drawn="true"]')
            .first()
            .waitFor();
        }
        const frame = pane.locator(".report-box-frame").first();
        const scroll = await frame.evaluateHandle((element) => {
          for (let at: any = element.parentElement; at; at = at.parentElement)
            if (
              at.scrollHeight > at.clientHeight &&
              /auto|scroll/.test(
                (globalThis as any).getComputedStyle(at).overflowY,
              )
            )
              return at;
          if (element.closest(".image-zoom-viewport"))
            return element.closest(".pane-body");
          throw Error("No real Files scroll container");
        });
        const tap = (await frame.boundingBox())!;
        const at = {
          x: tap.x + tap.width / 2,
          y: Math.min(tap.y + tap.height / 2, 500),
        };
        await page.touchscreen.tap(at.x, at.y);
        await pane.locator(".files-box-hint").waitFor({ timeout: 1500 });
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        await fileShot(page, `files-${kind}-tap-hint.png`);
        await pane.locator(".files-box-hint").waitFor({ state: "detached" });
        await page.mouse.click(at.x, at.y);
        expect(await pane.locator(".files-box-hint").count()).toBe(0);
        await page.evaluate(
          `document.addEventListener('pointerdown', event => window.__filesHoldPointer = event.pointerId, { once: true });`,
        );
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [at],
        });
        const start = frame.locator("mark.files-box-start");
        await start.waitFor();
        const startBox = (await start.boundingBox())!;
        expect(startBox.width).toBeGreaterThanOrEqual(16);
        expect(startBox.height).toBeGreaterThanOrEqual(16);
        expect(
          await frame.evaluate((element) =>
            element.hasPointerCapture((globalThis as any).__filesHoldPointer),
          ),
        ).toBeTrue();
        await fileShot(page, `files-${kind}-hold-start.png`);
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        if (kind === "image") {
          expect((await frame.boundingBox())!.height).toBeLessThanOrEqual(
            844 * 0.65,
          );
          expect(await page.evaluate<number>("visualViewport.scale")).toBe(1);
          await scroll.dispose();
          continue;
        }
        const before = await scroll.evaluate(
          (element: any) => element.scrollTop,
        );
        const box = (await frame.boundingBox())!;
        const x = box.x + box.width / 2;
        const y = Math.min(box.y + box.height / 2, 650);
        const name = await detail.getAttribute("aria-label");
        await page.evaluate("window.__filesGestureTargets = []");
        await drag(x, y, 0, -180);
        await page.waitForFunction(
          ({ element, before }: any) => element.scrollTop > before + 50,
          { element: scroll, before },
        );
        expect(await detail.getAttribute("aria-label")).toBe(name);
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        await fileShot(page, `files-${kind}-touch-scroll.png`);
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [
            { x: 166, y: 420, id: 1 },
            { x: 246, y: 420, id: 2 },
          ],
        });
        for (let step = 1; step <= 10; step++)
          await touch.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
              { x: 166 - step * 8, y: 420, id: 1 },
              { x: 246 + step * 8, y: 420, id: 2 },
            ],
          });
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
        await page.waitForFunction("visualViewport.scale > 1.5");
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        const left = await page.evaluate<number>("visualViewport.offsetLeft");
        await drag(280, 420, -100, 0);
        await page.waitForFunction(
          (left) => (globalThis as any).visualViewport.offsetLeft > left + 20,
          left,
        );
        expect(await detail.getAttribute("aria-label")).toBe(name);
        expect(
          await page.evaluate<boolean[]>("window.__filesGestureTargets"),
        ).toEqual([true, true, true, true]);
        expect(await pane.locator("mark.report-cbox").count()).toBe(0);
        expect(
          await page.locator(".report-comment-popover:visible").count(),
        ).toBe(0);
        await fileShot(page, `files-${kind}-pinch-pan.png`);
        await touch.send("Emulation.setPageScaleFactor", {
          pageScaleFactor: 1,
        });
        await page.waitForFunction("visualViewport.scale <= 1.01");
        await scroll.dispose();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  // Feature: #2667 a box drawn on a Files image or PDF page stages an Artifact-style comment.
  async function test_box_comments_on_images_and_pdf_pages(browser, base) {
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    const desktop = await filePage(browser, 1280, 844);
    let { page, errors } = desktop;
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator('.rail-btn[data-pane="files"]').click();
    let pane = filesSurface(page);
    await openListedFile(page, "browser-image.png");
    pane = page.locator(".pane-col.file-tab:visible");
    const drawImageBox = async () => {
      await page.waitForFunction(
        "document.querySelector('.files-detail img')?.naturalWidth > 0",
      );
      const image = (await pane.locator(".files-image-frame").boundingBox())!;
      await page.mouse.move(
        image.x + image.width * 0.2,
        image.y + image.height * 0.25,
      );
      await page.keyboard.down("Control");
      await page.mouse.down();
      await page.mouse.move(
        image.x + image.width * 0.6,
        image.y + image.height * 0.75,
        { steps: 8 },
      );
      await page.mouse.up();
      await page.keyboard.up("Control");
    };
    await drawImageBox();
    let popover = page.locator(".report-comment-popover");
    await popover.waitFor();
    await popover.locator("textarea").fill("Unsent draft");
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "hidden" });
    expect(await pane.locator(".report-comment-input").inputValue()).toBe(
      "Unsent draft",
    );
    await page.keyboard.press("Escape");
    await pane.waitFor({ state: "detached" });
    await openListedFile(page, "browser-image.png");
    pane = page.locator(".pane-col.file-tab:visible");
    await pane
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    await pane.locator(".report-comment-input").waitFor();
    expect(await pane.locator(".report-comment-input").inputValue()).toBe(
      "Unsent draft",
    );
    await pane.locator(".report-comment-del").click();
    await drawImageBox();
    await popover.locator("textarea").fill("Unsent draft");
    await pane.getByRole("button", { name: "Previous file" }).click();
    await popover.waitFor({ state: "hidden" });
    await pane.getByRole("button", { name: "Next file" }).click();
    await pane
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    expect(await popover.isHidden()).toBeTrue();
    expect(await pane.locator("mark.report-cbox").count()).toBe(1);
    expect(await pane.locator(".report-comment-input").inputValue()).toBe(
      "Unsent draft",
    );
    await pane.locator(".report-comment-del").click();
    await drawImageBox();
    await popover.waitFor();
    await popover.locator("textarea").fill("Crop this");
    await popover.getByRole("button", { name: "Comment" }).click();
    expect(await pane.locator(".report-comment blockquote").textContent()).toBe(
      "Box on image",
    );
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.locator(`.agent[data-id="${fixture.empty}"]`).click();
    expect(page.url()).toBe(`${base}#agent=${fixture.demo}`);
    await pane.getByRole("button", { name: "Previous file" }).click();
    await pane
      .locator('.files-detail[aria-label="browser-notes.txt"]')
      .waitFor();
    expect(await pane.locator("mark.report-cbox").count()).toBe(0);
    await pane.getByRole("button", { name: "Next file" }).click();
    await pane.locator(".files-image-frame mark.report-cbox").waitFor();
    await drawImageBox();
    await popover.locator("textarea").fill("Another region");
    await popover.getByRole("button", { name: "Comment" }).click();
    await page.route(`${base}api/attachments`, (route) =>
      route.request().postData()?.includes("browser-image-box-2.jpg")
        ? route.fulfill({ status: 503, json: { error: "Upload unavailable" } })
        : route.continue(),
    );
    const cleanup = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/attachment-crops/"),
    );
    const natural = await pane
      .locator(".files-detail img")
      .evaluate((image: any) => ({
        width: image.naturalWidth,
        height: image.naturalHeight,
      }));
    let delivered = page.waitForRequest((request) =>
      request.url().endsWith(`/api/conversations/${fixture.demo}/deliver`),
    );
    await pane.getByRole("button", { name: "Submit comments" }).click();
    const failure = page.locator("[data-comment-send]").getByRole("alert");
    await failure.getByRole("button", { name: "Send without images" }).click();
    let content = (await delivered).postDataJSON().content as string;
    expect((await cleanup).ok()).toBeTrue();
    expect(content).toStartWith('Comments on file "browser-image.png" (id: ');
    expect(content).toContain(":\nCrop this");
    const coordinates = /box 1, x=(\d+) y=(\d+) w=(\d+) h=(\d+) px/.exec(
      content,
    )!;
    for (const [index, expected] of [
      natural.width * 0.2,
      natural.height * 0.25,
      natural.width * 0.4,
      natural.height * 0.5,
    ].entries())
      expect(
        Math.abs(Number(coordinates[index + 1]) - expected),
      ).toBeLessThanOrEqual(1);
    expect(content).toContain(
      `px in the ${natural.width}×${natural.height} original (x,y = top-left)`,
    );
    expect(content).not.toContain("![browser-image-box-1.jpg](");
    expect(errors).toEqual([]);
    await desktop.context.close();

    const { demo } = await postFixture(base, "seed-published-pdf");
    const phone = await filePage(browser, 412, 844, true);
    ({ page, errors } = phone);
    await page.goto(`${base}#agent=${demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Open slides.pdf in Files" }).tap();
    pane = filesSurface(page);
    const frame = pane.locator('.files-pdf-frame[data-page="2"]');
    await frame.scrollIntoViewIfNeeded();
    const position = await pane.locator(".files-position").textContent();
    const box = (await frame.boundingBox())!;
    const touch = await phone.context.newCDPSession(page);
    const at = (x: number, y: number) => [
      { x: box.x + box.width * x, y: box.y + box.height * y },
    ];
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: at(0.1, 0.2),
    });
    await frame.locator("mark.report-cbox").waitFor({ state: "attached" });
    for (let step = 1; step <= 10; step++)
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: at(0.1 + step * 0.06, 0.2 + step * 0.03),
      });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    popover = page.locator(".report-comment-popover");
    await popover.waitFor();
    expect(await pane.locator(".files-position").textContent()).toBe(position);
    await popover.locator("textarea").fill("Label this");
    await popover.getByRole("button", { name: "Comment" }).tap();
    expect(await pane.locator(".report-comment blockquote").textContent()).toBe(
      "Box on page 2",
    );
    await fileShot(page, `files-box-comment-412.png`);
    delivered = page.waitForRequest((request) =>
      request.url().endsWith(`/api/conversations/${demo}/deliver`),
    );
    await pane.getByRole("button", { name: "Submit comments" }).tap();
    content = (await delivered).postDataJSON().content as string;
    expect(content).toStartWith('Comments on file "slides.pdf" (id: ');
    expect(content).toContain(
      "- box 1 (page 2), x=0.10 y=0.20 w=0.60 h=0.30 (fractions of width and height; x,y = top-left), attached as slides-box-1.jpg:",
    );
    expect(content).toContain("Label this");
    expect(content).toContain("![slides-box-1.jpg](");
    const cropUrl = /!\[slides-box-1\.jpg\]\(([^)]+)\)/.exec(content)![1]!;
    const crop = await page.evaluate(async (url) => {
      const image = new (globalThis as any).Image();
      image.src = /^\/api\/conversations\/[^/]+\/attachments\/[^/]+$/.test(url)
        ? `${url}/preview`
        : url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, cropUrl);
    expect(Math.abs(crop.width - 360)).toBeLessThanOrEqual(2);
    expect(Math.abs(crop.height - 120)).toBeLessThanOrEqual(2);
    expect(content).not.toContain("box x=");
    await pane.locator("mark.report-cbox").waitFor({ state: "detached" });
    expect(errors).toEqual([]);
    await phone.context.close();
  },
];
if (import.meta.main) await runBrowserTests([["panes-files", tests]]);
