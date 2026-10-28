import { expect } from "bun:test";
import { EventEmitter, once } from "node:events";
import type { Browser, Locator, Route } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  dispatchArtifactSelection,
  gotoRoot,
  postFixture,
  runBrowserTests,
  themeColors,
  type BrowserTest,
} from "./common";

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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await page.route("**/api/tree", (route) => runningTree(route, fixture.empty));
  await page.route(`**/api/conversations/${fixture.empty}?*`, runningView);
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
  let pane = page.locator('.pane-col[data-pane="files"]');
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
    r.url().includes(`/conversations/${fixture.empty}/files?`),
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
  expect(
    Boolean((await pane.count()) === 1 && (await pane.isVisible())),
  ).toBeTrue();
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
  expect(
    Boolean((await pane.count()) === 1 && (await pane.isVisible())),
  ).toBeTrue();
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
  await page.locator("#menu-btn").click();
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
  pane = page.locator('.pane-col[data-pane="files"]');
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
        const pane = page.locator('.pane-col[data-pane="files"]');
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
        await page.screenshot({
          path: `${process.env.RECURSE_AGENT_TMPDIR}/files-newest-first-${width}.png`,
        });
        await pane
          .getByRole("button", { name: "Open report.md", exact: true })
          .click();
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
      `window.__filesFetchOrder=[]; window.__filesClockOffset=0; const realNow=performance.now.bind(performance); performance.now=()=>realNow()+window.__filesClockOffset; window.__emptyFilesFetchOrder=[]; window.__emptyFilesPath='${emptyFilesPath}'; const originalFetch=window.fetch.bind(window); window.fetch=(input,init)=>{const url=String(typeof input==='string'?input:input.url); if(url.includes('/files?')) window.__filesFetchOrder.push('list'); if(url.includes(window.__emptyFilesPath)) window.__emptyFilesFetchOrder.push('list'); if(url.includes('/files/')&&url.includes('/preview')) window.__filesFetchOrder.push(document.querySelector('.files-detail')?'preview-in-detail':'preview-in-list'); return originalFetch(input,init);};`,
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
      r.url().includes(`/conversations/${fixture.empty}/files?`),
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
    await page.keyboard.press("o");
    await pane.waitFor({ state: "detached" });
    await page.locator(`.agent[data-id="${fixture.empty}"]`).focus();
    const composerBefore = await page.locator("#input").inputValue();
    await page.keyboard.press("p");
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
    const detail = pane;
    await detail.locator(".files-preview-placeholder").waitFor();
    await firstPreview;
    expect(heldPreviews).toHaveLength(1);
    const head = (await detail.locator(".files-detail-head").boundingBox())!;
    expect(head.height).toBeLessThanOrEqual(56);
    for (const name of ["All files", "Jump to message", "Delete"])
      expect(await detail.getByRole("button", { name }).count()).toBe(1);
    const previewRefreshBefore = (await page.evaluate(
      "window.__filesFetchOrder.filter(item => item === 'list').length",
    )) as number;
    expect(
      (
        await page.request.post(base + "__browser-test/append-files-message")
      ).ok(),
    ).toBeTrue();
    await page.getByText("Files recorded.", { exact: true }).waitFor();
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
    await detail.getByRole("button", { name: "All files" }).click();
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
    expect(
      Boolean((await pane.count()) === 1 && (await pane.isVisible())),
    ).toBeTrue();
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
    const popout = page.locator("dialog.image-popout");
    await popout.waitFor({ state: "visible" });
    await popout.getByRole("button", { name: "Close image" }).click();
    await popout.waitFor({ state: "hidden" });
    expect(await imageCard.isVisible()).toBeTrue();
    expect(await pane.locator(".files-detail").count()).toBe(0);
    await imageCard.locator(".files-thumb").click();
    await popout.getByRole("button", { name: "Open in Files" }).click();
    await pane
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    await pane.getByRole("button", { name: "All files" }).click();
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
    expect(
      Boolean((await pane.count()) === 1 && (await pane.isVisible())),
    ).toBeTrue();
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
    expect(
      Boolean((await pane.count()) === 1 && (await pane.isVisible())),
    ).toBeTrue();
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("#conv-title", { hasText: "Files image navigation" })
      .waitFor();
    await page.locator('#messages img[alt="nav-2.png"]').click();
    await page
      .locator("dialog.image-popout")
      .getByRole("button", { name: "Open in Files" })
      .click();
    const pane = page.locator('.pane-col[data-pane="files"]');
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
    expect(await position.textContent()).toBe("2 of 3");
    expect(await detail.getAttribute("aria-label")).toBe(middle);
    await page.keyboard.press("ArrowRight");
    expect(await detail.getAttribute("aria-label")).toBe(last);
    await pane.getByRole("button", { name: "All files" }).click();
    await pane.locator(".files-card").nth(2).waitFor();
    expect(
      await pane.locator(".files-card").first().getAttribute("aria-label"),
    ).toBe(last);
    await pane.locator(".files-thumb").first().click();
    await page
      .locator("dialog.image-popout")
      .getByRole("button", { name: "Open in Files" })
      .click();
    expect(await position.textContent()).toBe("3 of 3");
    await page.waitForFunction(
      "document.querySelector('.files-detail img')?.naturalWidth > 0",
    );
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-viewer-desktop.png`,
      });
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_session_files_pane_refreshes_on_composer_upload(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    expect(fixture).toBeTruthy();
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("#conv-title", { hasText: "Files demo agent" })
      .waitFor();
    await page.locator('.rail-btn[data-pane="files"]').click();
    const pane = page.locator('.pane-col[data-pane="files"]');
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
    const pane = page.locator('.pane-col[data-pane="files"]');
    await pane.locator(".files-card").first().waitFor();
    expect(
      Boolean((await pane.count()) === 1 && (await pane.isVisible())),
    ).toBeTrue();
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
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      try {
        await page.goto(`${base}#agent=${demo}`, {
          waitUntil: "domcontentloaded",
        });
        await page
          .getByRole("button", { name: "Open review.diff in Files" })
          .click();
        const diff = page.locator(".files-detail .files-diff");
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
          await page.getByRole("button", { name: "All files" }).click();
          await page
            .getByRole("button", { name: `Open ${name}`, exact: true })
            .click();
          await page
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
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const fixture = (await postFixture(base, "seed-published-markdown")) as {
        demo: string;
        id: string;
      };
      const remote: string[] = [];
      page.on("request", (request) => {
        if (!request.url().startsWith(base)) remote.push(request.url());
      });
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
        const pane = page.locator('.pane-col[data-pane="files"]');
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
        expect(
          await detail
            .locator(".files-markdown .artifact-blocked-image")
            .count(),
        ).toBe(1);
        expect(await pane.locator(".files-grid").count()).toBe(0);
        if (process.env.SCREENSHOT_DIR)
          await page.screenshot({
            path: `${process.env.SCREENSHOT_DIR}/files-detail-markdown-${width}.png`,
          });
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
          expect(await pane.getAttribute("aria-modal")).toBe("true");
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
        await detail.getByRole("button", { name: "All files" }).click();
        const card = pane.locator(".files-card", { hasText: "report.md" });
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const { demo } = (await postFixture(base, "seed-published-media")) as {
      demo: string;
    };
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page
        .locator("#conv-title", { hasText: "Published media" })
        .waitFor();
      const open = async (name: string) => {
        const chip = page.getByRole("button", {
          name: `Open ${name} in Files`,
        });
        await chip.waitFor({ timeout: 15_000 });
        await chip.click();
        return page.locator('.pane-col[data-pane="files"]');
      };
      let detail = await open("chart.svg");
      await page
        .locator("dialog.image-popout")
        .getByRole("button", { name: "Open in Files" })
        .click();
      const svg = detail.locator(".files-detail img");
      await svg.waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        (el: any) => el.complete && el.naturalWidth === 40,
        await svg.elementHandle(),
      );
      detail = await open("tone.wav");
      const audio = detail.locator("audio.files-media");
      await audio.waitFor();
      await page.waitForFunction(
        (el: any) => el.duration > 0,
        await audio.elementHandle(),
      );
      detail = await open("clip.webm");
      const video = detail.locator("video.files-media");
      await video.waitFor();
      expect(await video.getAttribute("src")).toEndWith("/preview");
      await detail.getByRole("button", { name: "All files" }).click();
      const card = page.locator(".files-card", { hasText: "tone.wav" });
      await card.waitFor();
      expect(await card.locator("audio, .files-preview-note").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_pdf_pages_draw_in_the_detail_view(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const { demo } = (await postFixture(base, "seed-published-pdf")) as {
      demo: string;
    };
    const pdfRequests: string[] = [];
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
      const open = async (name: string) => {
        const chip = page.getByRole("button", {
          name: `Open ${name} in Files`,
        });
        await chip.waitFor({ timeout: 15_000 });
        await chip.click();
        return page.locator('.pane-col[data-pane="files"]');
      };
      expect(pdfRequests).toEqual([]);
      const initialWorker = page.waitForEvent("worker", { timeout: 10_000 });
      let detail = await open("slides.pdf");
      const pages = detail.locator(".files-pdf-page");
      await detail
        .getByRole("img", { name: "Page 2 of 2" })
        .waitFor({ timeout: 15_000 });
      expect(await pages.count()).toBe(2);
      const first = await pages.first().elementHandle();
      await page.waitForFunction(
        (el: any) => el.dataset.drawn === "true",
        first,
        { timeout: 15_000 },
      );
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
      expect(page.workers()).toHaveLength(1);
      const firstClosed = page
        .workers()[0]
        .waitForEvent("close", { timeout: 10_000 });
      await detail.getByRole("button", { name: "All files" }).click();
      await firstClosed;
      expect(page.workers()).toHaveLength(0);
      const reopened = page.waitForEvent("worker", { timeout: 10_000 });
      await page
        .getByRole("button", { name: "Open slides.pdf" })
        .first()
        .click();
      await detail.getByRole("img", { name: "Page 1 of 2" }).waitFor();
      const reopenedWorker = await reopened;
      expect(page.workers()).toHaveLength(1);
      const cmap = page.waitForResponse((response) =>
        response.url().endsWith("/static/pdfjs/cmaps/UniJIS-UCS2-H.bcmap"),
      );
      const replaced = reopenedWorker.waitForEvent("close", {
        timeout: 10_000,
      });
      const notesWorker = page.waitForEvent("worker", { timeout: 10_000 });
      detail = await open("notes-ja.pdf");
      expect((await cmap).status()).toBe(200);
      await page.waitForFunction(
        (el: any) => el.dataset.drawn === "true",
        await detail.getByRole("img", { name: "Page 1 of 1" }).elementHandle(),
        { timeout: 15_000 },
      );
      await replaced;
      await notesWorker;
      expect(page.workers()).toHaveLength(1);
      detail = await open("long.pdf");
      const last = detail.getByRole("img", { name: "Page 16 of 16" });
      await last.waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        (el: any) => el.dataset.drawn === "true",
        await detail.getByRole("img", { name: "Page 1 of 16" }).elementHandle(),
        { timeout: 15_000 },
      );
      expect(
        await detail.locator('.files-pdf-page[data-drawn="true"]').count(),
      ).toBeLessThan(16);
      await last.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        (el: any) => el.dataset.drawn === "true",
        await last.elementHandle(),
        { timeout: 15_000 },
      );
      await page.waitForFunction(
        (el: any) => !el.dataset.drawn && el.width === 0,
        await detail.getByRole("img", { name: "Page 1 of 16" }).elementHandle(),
        { timeout: 15_000 },
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
      const closing = page
        .workers()
        .map((worker) => worker.waitForEvent("close", { timeout: 10_000 }));
      const brokenWorker = page
        .waitForEvent("worker", { timeout: 10_000 })
        .then((worker) => worker.waitForEvent("close", { timeout: 10_000 }));
      detail = await open("broken.pdf");
      await detail
        .getByText("Couldn’t show this PDF. Download it to open it.")
        .waitFor({ timeout: 15_000 });
      expect(await detail.locator(".files-pdf-page").count()).toBe(0);
      await Promise.all([...closing, brokenWorker]);
      expect(page.workers()).toHaveLength(0);
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
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
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
    const page = await context.newPage();
    const errors = captureErrors(page);
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
      await page.waitForFunction(
        (el: any) => el.dataset.drawn === "true",
        await first.elementHandle(),
        { timeout: 30_000 },
      );
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const { demo } = (await postFixture(base, "seed-published-later")) as {
      demo: string;
    };
    const listing = `**/api/conversations/${demo}/files?*`;
    let firstListing: string | null = null;
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
      const pane = page.locator('.pane-col[data-pane="files"]');
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
      await pane.getByRole("button", { name: "All files" }).click();
      await page.route(`**/api/conversations/${demo}/files?*`, (route) =>
        route.fulfill({ status: 500, body: "{}" }),
      );
      const failed = (await postFixture(base, "publish-later-file")) as {
        name: string;
      };
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
      await pane
        .locator(".files-detail h1", { hasText: failed.name })
        .waitFor({ timeout: 15_000 });
      await page.route(`**/api/conversations/${demo}/attachments/*`, (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({ status: 500, body: "{}" })
          : route.continue(),
      );
      page.once("dialog", (dialog) => void dialog.accept());
      await pane.getByRole("button", { name: "Delete" }).click();
      await pane
        .locator(".files-error", { hasText: "Couldn’t delete the file" })
        .waitFor({ timeout: 15_000 });
      expect(
        await pane
          .locator(".files-detail h1", { hasText: failed.name })
          .count(),
      ).toBe(1);
      expect(errors.filter((error) => !error.includes("500"))).toEqual([]);
    } finally {
      await closeWithRoutes(context);
    }
  },
  async function test_large_files_download_natively(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
      const pane = page.locator('.pane-col[data-pane="files"]');
      expect(
        await source(pane.getByRole("link", { name: "Download" })),
      ).toEqual(["http", "large.bin"]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_a_republished_file_keeps_its_versions(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const { demo } = await postFixture(base, "seed-published-versions");
    try {
      await gotoRoot(page, base);
      await page.locator(`.agent[data-id="${demo}"]`).click();
      const chips = page.getByRole("button", {
        name: "Open report.md in Files",
      });
      await chips.nth(2).waitFor({ timeout: 15_000 });
      await chips.first().click();
      const pane = page.locator('.pane-col[data-pane="files"]');
      const heading = pane.locator(".files-detail .files-markdown h1");
      await heading.waitFor({ timeout: 15_000 });
      expect(await heading.innerText()).toBe("Draft 1");
      await pane.getByLabel("File options", { exact: true }).click();
      const menu = pane.getByRole("combobox", { name: "Version" });
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
      await pane.getByRole("button", { name: "All files" }).click();
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
      const pane = page.locator('.pane-col[data-pane="files"]');
      expect(await pane.count()).toBe(0);
      const heading = pane.locator(".files-detail .files-markdown h1");
      const first = await republish();
      await heading
        .filter({ hasText: `Draft ${first}` })
        .waitFor({ timeout: 15_000 });
      const second = await republish();
      await heading
        .filter({ hasText: `Draft ${second}` })
        .waitFor({ timeout: 15_000 });
      await pane.getByLabel("File options", { exact: true }).click();
      await pane
        .getByRole("combobox", { name: "Version" })
        .selectOption({ index: 1 });
      await heading.filter({ hasText: `Draft ${first}` }).waitFor();
      const third = await republish();
      await pane.getByLabel("File options", { exact: true }).click();
      const menu = pane.getByRole("combobox", { name: "Version" });
      await menu
        .locator("option", { hasText: "latest" })
        .filter({ hasText: `Version ${third}` })
        .waitFor({ state: "attached", timeout: 15_000 });
      expect(await heading.innerText()).toBe(`Draft ${first}`);
      await page
        .locator(`.agent[data-id]:not([data-id="${demo}"])`)
        .first()
        .click();
      await pane.waitFor({ state: "detached" });
      const fourth = await republish();
      const focusedResponse = page.waitForResponse(
        (r) =>
          r.url().includes(`/conversations/${demo}?`) &&
          r.url().includes("focused=1"),
      );
      await page.locator(`.agent[data-id="${demo}"]`).click();
      await page
        .getByRole("button", { name: "Open report.md in Files" })
        .nth(fourth - 1)
        .waitFor({ timeout: 15_000 });
      await (await focusedResponse).finished();
      expect(await pane.count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_a_bash_publish_shows_every_file_on_the_reply(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
          '.pane-col[data-pane="files"] .files-detail .files-markdown h1',
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
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      await page.goto(`${base}#agent=${fixture.demo}`, {
        waitUntil: "domcontentloaded",
      });
      if (mobile) {
        const menu = page.locator('.pane-menu-item[data-pane="files"]');
        await menu.waitFor({ state: "attached" });
        await page.locator("#pane-fab").click();
        await menu.click();
      } else await page.locator('.rail-btn[data-pane="files"]').click();
      const pane = page.locator('.pane-col[data-pane="files"]');
      await pane
        .getByRole("button", { name: "Open browser-notes.txt" })
        .click();
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
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-text-comment-${width}.png`,
        });
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
    const context = await browser.newContext({
      viewport: { width: 1280, height: 844 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("button", { name: "Open review.diff in Files" })
      .click();
    await page
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
      await page.getByRole("button", { name: "All files" }).click();
      await page
        .getByRole("button", { name: `Open ${name}`, exact: true })
        .click();
      await page
        .locator(".files-detail .files-diff .diff-row.add")
        .first()
        .waitFor();
      await page.waitForFunction(
        (marks) =>
          (globalThis as any).document.querySelectorAll(
            ".files-detail mark.report-cmark",
          ).length === marks,
        marks,
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
    await page.getByRole("button", { name: "Submit comments" }).click();
    await page.getByRole("button", { name: "Submitting…" }).waitFor();
    await page.getByRole("button", { name: "All files" }).click();
    await page.locator(".report-bar").waitFor({ state: "detached" });
    release();
    expect((await delivered).ok()).toBeTrue();
    await page
      .getByRole("button", { name: "Open review.diff", exact: true })
      .click();
    await page.getByRole("button", { name: "Submit comments" }).waitFor();
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2693 Files touch taps need a hint and holds need visible feedback without breaking navigation.
  async function test_files_touch_scroll_pinch_and_pan(browser, base) {
    const { demo } = await postFixture(base, "seed-published-pdf");
    const context = await browser.newContext({
      viewport: { width: 412, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    try {
      await page.goto(`${base}#agent=${demo}`);
      await page.getByRole("button", { name: "Open long.pdf in Files" }).tap();
      const pane = page.locator('.pane-col[data-pane="files"]');
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
        if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
          await page.screenshot({
            path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-${kind}-tap-hint.png`,
          });
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
        if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
          await page.screenshot({
            path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-${kind}-hold-start.png`,
          });
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
        if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
          await page.screenshot({
            path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-${kind}-touch-scroll.png`,
          });
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
        if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
          await page.screenshot({
            path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-${kind}-pinch-pan.png`,
          });
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
    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 844 },
    });
    let page = await desktop.newPage();
    let errors = captureErrors(page);
    await page.goto(`${base}#agent=${fixture.demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator('.rail-btn[data-pane="files"]').click();
    let pane = page.locator('.pane-col[data-pane="files"]');
    await pane.getByRole("button", { name: "Open browser-image.png" }).click();
    await page
      .locator("dialog.image-popout")
      .getByRole("button", { name: "Open in Files" })
      .click();
    const drawImageBox = async () => {
      await page.waitForFunction(
        "document.querySelector('.files-detail img')?.naturalWidth > 0",
      );
      const image = (await pane.locator(".files-image-frame").boundingBox())!;
      await page.mouse.move(
        image.x + image.width * 0.2,
        image.y + image.height * 0.25,
      );
      await page.mouse.down();
      await page.mouse.move(
        image.x + image.width * 0.6,
        image.y + image.height * 0.75,
        { steps: 8 },
      );
      await page.mouse.up();
    };
    await drawImageBox();
    let popover = page.locator(".report-comment-popover");
    await popover.waitFor();
    await popover.locator("textarea").fill("Unsent draft");
    await pane.getByRole("button", { name: "Previous file" }).click();
    await popover.waitFor({ state: "hidden" });
    await pane.getByRole("button", { name: "Next file" }).click();
    await pane
      .locator('.files-detail[aria-label="browser-image.png"]')
      .waitFor();
    expect(await popover.isHidden()).toBeTrue();
    expect(await pane.locator("mark.report-cbox").count()).toBe(0);
    await drawImageBox();
    await popover.waitFor();
    await popover.locator("textarea").fill("Crop this");
    await popover.getByRole("button", { name: "Comment" }).click();
    expect(await pane.locator(".report-comment blockquote").textContent()).toBe(
      "Box on image",
    );
    await pane.getByRole("button", { name: "Previous file" }).click();
    await pane
      .locator('.files-detail[aria-label="browser-notes.txt"]')
      .waitFor();
    expect(await pane.locator("mark.report-cbox").count()).toBe(0);
    await pane.getByRole("button", { name: "Next file" }).click();
    await pane.locator(".files-image-frame mark.report-cbox").waitFor();
    await page.route(`${base}api/attachments`, (route) =>
      route.fulfill({ status: 503, json: { error: "Upload unavailable" } }),
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
    let content = (await delivered).postDataJSON().content as string;
    expect(content).toStartWith('Comments on file "browser-image.png" (id: ');
    expect(content).toContain(
      "(crop unavailable; coordinates only):\nCrop this",
    );
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
    expect(content).not.toContain("![browser-image-box-1.png](");
    expect(errors).toEqual([]);
    await desktop.close();

    const { demo } = await postFixture(base, "seed-published-pdf");
    const phone = await browser.newContext({
      viewport: { width: 412, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    page = await phone.newPage();
    errors = captureErrors(page);
    await page.goto(`${base}#agent=${demo}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Open slides.pdf in Files" }).tap();
    pane = page.locator('.pane-col[data-pane="files"]');
    const frame = pane.locator('.files-pdf-frame[data-page="2"]');
    await frame.scrollIntoViewIfNeeded();
    const position = await pane.locator(".files-position").textContent();
    const box = (await frame.boundingBox())!;
    const touch = await phone.newCDPSession(page);
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
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
      await page.screenshot({
        path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/files-box-comment-412.png`,
      });
    delivered = page.waitForRequest((request) =>
      request.url().endsWith(`/api/conversations/${demo}/deliver`),
    );
    await pane.getByRole("button", { name: "Submit comments" }).tap();
    content = (await delivered).postDataJSON().content as string;
    expect(content).toStartWith('Comments on file "slides.pdf" (id: ');
    expect(content).toContain(
      "- box 1 (page 2), x=0.10 y=0.20 w=0.60 h=0.30 (fractions of width and height; x,y = top-left), attached as slides-box-1.png:",
    );
    expect(content).toContain("Label this");
    expect(content).toContain("![slides-box-1.png](");
    const cropUrl = /!\[slides-box-1\.png\]\(([^)]+)\)/.exec(content)![1]!;
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
    await phone.close();
  },
];
if (import.meta.main) await runBrowserTests([["panes-files", tests]]);
