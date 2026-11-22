import { expect } from "bun:test";
import { EventEmitter, once } from "node:events";
import type { Locator, Page, Route } from "playwright";
import type { TreeUpdate } from "../../src/web/tree_protocol";
import {
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  postFixture,
  runBrowserTests,
  showAgentList,
  waitForLayout,
  type BrowserTest,
} from "./common";
import {
  filePage,
  fileShot,
  filesSurface,
  showFilesList,
  openListedFile,
  openReplyFile,
  closeFileTab,
  renderedText,
  type Fixture,
} from "./files_support";

interface TreeStamp {
  id: string;
  updated: number;
}

async function refreshClock(page: Page): Promise<void> {
  await page.addInitScript(`
    window.__filesClockOffset = 0;
    const realNow = performance.now.bind(performance);
    performance.now = () => realNow() + window.__filesClockOffset;
  `);
}

function nextListRequest(page: Page, cid: string) {
  return page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === `/api/conversations/${cid}/files`,
  );
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
  const retryRequest = nextListRequest(page, cid);
  const retryResponse = page.waitForResponse((r) =>
    r.url().includes(`/conversations/${cid}/files?`),
  );
  await pane.getByRole("button", { name: "Retry" }).click();
  await retryRequest;
  await pane.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
  await (await retryResponse).finished();
  expect(coldFailed).toHaveLength(1);
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
  let consumed = 0;
  return {
    routes,
    hold(route: Route) {
      routes.push(route);
      events.emit("held");
    },
    async next(timeout = 15_000) {
      const index = consumed++;
      if (routes.length <= index)
        await once(events, "held", { signal: AbortSignal.timeout(timeout) });
    },
    async [Symbol.asyncDispose]() {
      await Promise.allSettled(routes.map((route) => route.abort()));
    },
  };
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
        await fileShot(page, `files-navigation-${width}.png`);
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
  // Regression: #3562 wait for the selected agent's Files button, not the outgoing rail's. (also #3373 consume held refreshes that arrive before their waiter.)
  async function test_session_files_pane(browser, base) {
    const fixture = (await postFixture(base, "seed-files-pane")) as Fixture;
    expect(fixture).toBeTruthy();
    for (const width of [1280, 390]) {
      const { context, page, errors } = await filePage(
        browser,
        width,
        844,
        width === 390,
      );
      const openList = async (target: Page) => {
        if (width === 1280) {
          await target.locator('.rail-btn[data-pane="files"]').click();
        } else {
          await target.evaluate("document.querySelector('#pane-fab')?.click()");
          const menu = target.locator('.pane-menu-item[data-pane="files"]');
          await menu.waitFor({ state: "attached" });
          await menu.evaluate((element) =>
            (element as { click: () => void }).click(),
          );
        }
      };
      const closedFocus = (cid: string) =>
        width === 1280 ? `.agent[data-id="${cid}"]` : "#menu-btn";
      await using previews = heldRoutes();
      await page.route("**/api/conversations/*/files/**/preview", (route) =>
        previews.hold(route),
      );
      await page.route(
        (url) => url.pathname === `/api/conversations/${fixture.empty}/events`,
        (route) => route.abort(),
      );
      await refreshClock(page);
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
      await showAgentList(page);
      const focused = page.waitForResponse(
        (r) =>
          r.url().startsWith(base + `api/conversations/${fixture.empty}?`) &&
          r.url().includes("focused=1"),
      );
      const coldRequest = nextListRequest(page, fixture.empty);
      const coldResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${fixture.empty}/files`,
      );
      await page.locator(`.agent[data-id="${fixture.empty}"]`).click();
      const focusedResponse = await focused;
      expect(focusedResponse.ok()).toBeTrue();
      await page
        .locator("#conv-title", { hasText: "Files empty agent" })
        .waitFor();
      await coldRequest;
      await (await coldResponse).finished();
      expect(coldFailed).toHaveLength(1);
      expect(await page.locator('.pane-col[data-pane="files"]').count()).toBe(
        0,
      );
      await openList(page);
      let pane = page.locator('.pane-col[data-pane="files"]');
      await retryColdFiles(
        page,
        pane,
        base,
        fixture.empty,
        coldUrl,
        coldFailed,
      );
      await waitForLayout(page);
      expect(previews.routes).toHaveLength(0);
      await using heldRequests = heldRoutes();
      const held = heldRequests.routes;
      const filesUrl = `**/api/conversations/${fixture.empty}/files?*`;
      await page.route(filesUrl, (route) => {
        heldRequests.hold(route);
      });
      for (const index of [0, 1]) {
        const nextHeld = heldRequests.next();
        await pane.locator(".pane-title").focus();
        expect(
          (
            await page.request.post(base + "__browser-test/append-empty-file")
          ).ok(),
        ).toBeTrue();
        await page.evaluate("window.__filesClockOffset += 60000");
        await nextHeld;
        await (
          await page.waitForResponse(
            (response) =>
              response
                .url()
                .startsWith(base + `api/conversations/${fixture.empty}?`) &&
              response.url().includes("focused=1"),
          )
        ).finished();
        await waitForLayout(page);
        expect(held).toHaveLength(index + 1);
        expect(await pane.isVisible()).toBeTrue();
        expect(
          await page.evaluate(
            "document.activeElement?.closest('.pane-col[data-pane=\\\"files\\\"]') !== null",
          ),
        ).toBeTrue();
        if (index === 0) {
          const continued = page.waitForResponse((response) =>
            response
              .url()
              .includes(`/api/conversations/${fixture.empty}/files?`),
          );
          await held[index].continue();
          expect((await continued).ok()).toBeTrue();
          await pane.locator(".files-card").first().waitFor();
        }
      }
      await emptyFiles(held[1]);
      await page.waitForFunction(
        "!document.querySelector('.pane-col[data-pane=\\\"files\\\"]')",
      );
      expect(
        await page.evaluate(
          `document.activeElement?.matches(${JSON.stringify(closedFocus(fixture.empty))})`,
        ),
      ).toBeTrue();
      await page.unroute(filesUrl);
      await showAgentList(page);
      await page.locator(`.agent[data-id="${fixture.demo}"]`).click();
      await page
        .locator("#conv-title", { hasText: "Files demo agent" })
        .waitFor();
      expect(
        await page.evaluate(
          `document.activeElement?.matches(${JSON.stringify(closedFocus(fixture.demo))})`,
        ),
      ).toBeTrue();
      await page.goto(`${base}#agent=${fixture.empty}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .locator(".files-card", { hasText: "empty-agent.txt" })
        .waitFor();
      expect(
        (
          await page.request.post(base + "__browser-test/remove-empty-file")
        ).ok(),
      ).toBeTrue();
      let reloaded = false;
      const onNavigated = (frame: unknown) => {
        if (frame === page.mainFrame()) reloaded = true;
      };
      page.on("framenavigated", onNavigated);
      const reloadResponse = page.waitForResponse(
        (r) =>
          reloaded &&
          r.url().includes(`/conversations/${fixture.empty}/files?`),
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
      await page
        .locator("#conv-title", { hasText: "Files empty agent" })
        .waitFor();
      pane = page.locator('.pane-col[data-pane="files"]');
      if (!(await pane.isVisible())) await openList(page);
      await pane
        .locator(".files-card", { hasText: "empty-agent.txt" })
        .waitFor();
      expect(errors).toEqual([]);
      await page.unrouteAll({ behavior: "wait" });
      await context.close();
      const {
        context: staleContext,
        page: stalePage,
        errors: staleErrors,
      } = await filePage(browser, width, 844, width === 390);
      await using staleRequests = heldRoutes();
      const heldStale = staleRequests.routes;
      await gotoRoot(stalePage, base);
      await showAgentList(stalePage);
      await stalePage.locator(`.agent[data-id="${fixture.demo}"]`).click();
      await stalePage
        .locator("#conv-title", { hasText: "Files demo agent" })
        .waitFor();
      await stalePage
        .locator('.rail-btn[data-pane="files"]')
        .waitFor({ state: "attached" });
      await stalePage.route(
        `**/api/conversations/${fixture.demo}/files?*`,
        (route) => {
          staleRequests.hold(route);
        },
      );
      const staleHeld = staleRequests.next(10_000);
      await openList(stalePage);
      await staleHeld;
      expect(heldStale.length).toBeGreaterThan(0);
      const staleRequest = heldStale[0].request();
      const staleCompletion = staleRequest.response().then(async (response) => {
        if (response) await response.finished();
        else expect(staleRequest.failure()?.errorText).toBe("net::ERR_ABORTED");
      });
      await stalePage
        .locator('.pane-col[data-pane="files"] .pane-title')
        .focus();
      await stalePage.keyboard.press("Escape");
      await showAgentList(stalePage);
      const currentProjection = stalePage.waitForResponse((response) =>
        response.url().includes(`/conversations/${fixture.empty}/files?`),
      );
      await stalePage.locator(`.agent[data-id="${fixture.empty}"]`).click();
      await (await currentProjection).finished();
      await heldStale[0].continue();
      await staleCompletion;
      await stalePage
        .locator("#conv-title", { hasText: "Files empty agent" })
        .waitFor();
      await waitForLayout(stalePage);
      expect(
        await stalePage.evaluate(
          `document.activeElement?.matches(${JSON.stringify(closedFocus(fixture.empty))})`,
        ),
      ).toBeTrue();
      expect(
        await stalePage
          .locator(".files-card", { hasText: "browser-notes.txt" })
          .count(),
      ).toBe(0);
      await using currentReads = heldRoutes();
      await stalePage.route(
        `**/api/conversations/${fixture.empty}/files?*`,
        (route) => currentReads.hold(route),
      );
      const currentRead = currentReads.next();
      await openList(stalePage);
      await currentRead;
      const stalePane = stalePage.locator('.pane-col[data-pane="files"]');
      expect(
        await stalePage
          .locator(".files-card", { hasText: "browser-notes.txt" })
          .count(),
      ).toBe(0);
      await currentReads.routes[0].continue();
      await stalePane
        .locator(".files-card", { hasText: "empty-agent.txt" })
        .waitFor();
      expect(staleErrors).toEqual([]);
      await staleContext.close();
    }
    const { context, page, errors } = await filePage(browser, 1280, 800);
    const appendFilesMessage = async (start = false) => {
      const response = await page.request.post(
        base + "__browser-test/append-files-message",
        { data: { start } },
      );
      expect(response.ok()).toBeTrue();
      if (!start) await page.evaluate("window.__filesClockOffset += 60000");
    };
    await refreshClock(page);
    await using previewHolds = heldRoutes();
    const heldPreviews = previewHolds.routes;
    await page.route(
      `**/api/conversations/${fixture.demo}/files/**/preview`,
      (route) => previewHolds.hold(route),
    );
    await page.goto(`${base}#agent=${fixture.empty}`, {
      waitUntil: "domcontentloaded",
    });
    const filesButton = page.locator('.rail-btn[data-pane="files"]');
    await filesButton.click();
    const pane = page.locator('.pane-col[data-pane="files"]');
    await pane.locator(".files-card", { hasText: "empty-agent.txt" }).waitFor();
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
    await page
      .locator('.rail-btn[data-pane="files"][aria-label^="Files (2)"]')
      .waitFor();
    expect(await filesButton.count()).toBe(1);
    if ((await filesButton.getAttribute("aria-expanded")) !== "true")
      await filesButton.click();
    await pane
      .locator(".files-card", { hasText: "browser-notes.txt" })
      .waitFor();
    await pane.locator(".pane-title").focus();
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await page.locator(`.agent[data-id="${fixture.demo}"]`).focus();
    const composerBefore = await page.locator("#input").inputValue();
    await filesButton.click();
    await pane.waitFor();
    await pane
      .locator(".files-card", { hasText: "browser-notes.txt" })
      .waitFor();
    expect(await page.locator("#input").inputValue()).toBe(composerBefore);
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
    expect(heldPreviews).toHaveLength(0);
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
    const beforeTree: TreeStamp[] = await (
      await page.request.get(base + "api/tree")
    ).json();
    const beforeUpdate = beforeTree.find(
      (row) => row.id === fixture.demo,
    )!.updated;
    const changedTree = page.waitForResponse(async (response) => {
      if (!response.ok() || new URL(response.url()).pathname !== "/api/tree")
        return false;
      const tree = (await response.json()) as
        | TreeStamp[]
        | TreeUpdate<TreeStamp>;
      const rows = Array.isArray(tree)
        ? tree
        : "changed" in tree
          ? tree.changed
          : [];
      return rows.some(
        (row) => row.id === fixture.demo && row.updated !== beforeUpdate,
      );
    });
    let refreshed = false;
    const previewRefresh = nextListRequest(page, fixture.demo).then(
      (request) => {
        refreshed = true;
        return request;
      },
    );
    try {
      await appendFilesMessage(true);
      await page
        .getByText("Files recorded.", { exact: true })
        .waitFor({ state: "attached" });
      await (await changedTree).finished();
      await page.waitForRequest(
        (request) =>
          request
            .url()
            .startsWith(base + `api/conversations/${fixture.demo}?`) &&
          new URL(request.url()).searchParams.get("focused") === "1",
      );
      expect(refreshed).toBeFalse();
      expect(heldPreviews).toHaveLength(1);
      const secondPreview = previewHolds.next();
      await page.evaluate("window.__filesClockOffset += 60000");
      await previewRefresh;
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
      expect(await filesButton.getAttribute("aria-label")).toContain("2");
      const listRequest = nextListRequest(page, fixture.demo);
      const listResponse = page.waitForResponse((response) =>
        response.url().includes(`/conversations/${fixture.demo}/files?`),
      );
      await appendFilesMessage();
      await listRequest;
      await (await listResponse).finished();
      await detail
        .locator("pre", { hasText: "bounded browser text preview" })
        .waitFor();
      expect(heldPreviews).toHaveLength(2);
      await page.unroute(
        `**/api/conversations/${fixture.demo}/files/**/preview`,
      );
      const downloadEvent = page.waitForEvent("download");
      await detail.getByRole("link", { name: "Download" }).click();
      expect((await downloadEvent).suggestedFilename()).toBe(
        "browser-notes.txt",
      );
      await detail.getByRole("button", { name: "Jump to message" }).click();
      await page
        .locator(".file-jump-target", {
          hasText: "Browser files source message",
        })
        .waitFor();
      await showFilesList(page);
      const failed: Route[] = [];
      const failUrl = `**/api/conversations/${fixture.demo}/files?*`;
      await page.route(failUrl, (route) => {
        failed.push(route);
        return route.fulfill({
          status: 503,
          json: { error: "browser failure" },
        });
      });
      const failedRequest = nextListRequest(page, fixture.demo);
      const failedResponse = page.waitForResponse((r) =>
        r.url().includes(`/conversations/${fixture.demo}/files?`),
      );
      await appendFilesMessage();
      await failedRequest;
      await (await failedResponse).finished();
      expect(failed).toHaveLength(1);
      await pane
        .locator(".files-error", { hasText: "Couldn’t refresh files" })
        .waitFor();
      expect(await pane.isVisible()).toBeTrue();
      await page.unroute(failUrl);
      const retryRequest = nextListRequest(page, fixture.demo);
      await pane.getByRole("button", { name: "Retry" }).click();
      await retryRequest;
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
      expect(errors).toEqual([]);
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await postFixture(base, "release", { agent: fixture.demo });
      await context.close();
    }
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
      .waitFor();
    expect(await pane.locator(".files-card").count()).toBe(3);
    await page
      .locator(".attach-chip", { hasText: "browser-upload.txt" })
      .locator(".rm")
      .click();
    await page.waitForFunction(
      "!document.querySelector('.pane-col[data-pane=\\\"files\\\"]')?.textContent?.includes('browser-upload.txt')",
      null,
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
    );
    expect(await page.locator('.rail-btn[data-pane="files"]').count()).toBe(0);
    expect(await page.locator('.pane-col[data-pane="files"]').count()).toBe(0);
    await page.unroute(emptyUrl);
    await page.locator(`.agent[data-id="${fixture.demo}"]`).click();
    await page
      .locator("#conv-title", { hasText: "Files demo agent" })
      .waitFor();
    const filesButton = page.locator('.rail-btn[data-pane="files"]');
    await filesButton.waitFor();
    await filesButton.click();
    const pane = filesSurface(page);
    await pane.locator(".files-card").first().waitFor();
    expect(await pane.isVisible()).toBeTrue();
    expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
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
      await filesButton.waitFor();
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
      await chip.waitFor();
      expect(
        await pane.locator(".files-card", { hasText: later.name }).count(),
      ).toBe(0);
      await page.unroute(listing);
      await chip.click();
      await pane.locator(".files-detail h1", { hasText: later.name }).waitFor();
      await showFilesList(page);
      await page.evaluate(
        "addEventListener('click', (e) => e.target.closest('.files-error button') && (window.retried = true), true)",
      );
      await page.route(listing, async (route) =>
        (await page.evaluate("window.retried"))
          ? route.continue()
          : route.fulfill({ status: 500, body: "{}" }),
      );
      const failed = (await postFixture(base, "publish-later-file")) as {
        name: string;
      };
      await openReplyFile(page, failed.name);
      await pane.getByRole("button", { name: "All files" }).waitFor();
      expect(await pane.locator(".files-error").count()).toBe(1);
      await pane.getByRole("button", { name: "Retry" }).click();
      await page
        .locator(".pane-col.file-tab:visible")
        .locator(".files-detail h1", { hasText: failed.name })
        .waitFor();
      await page.unroute(listing);
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
      await pane.locator(".files-error", { hasText: deletionError }).waitFor();
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
      await openListedFile(page, failed.name);
      await file
        .locator(".files-detail h1", { hasText: failed.name })
        .waitFor();
      const reopenedError = file.locator(".files-error", {
        hasText: deletionError,
      });
      await reopenedError.waitFor();
      page.once("dialog", (dialog) => void dialog.accept());
      await reopenedError.getByRole("button", { name: "Retry" }).click();
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
];
if (import.meta.main) await runBrowserTests([["files", tests]]);
