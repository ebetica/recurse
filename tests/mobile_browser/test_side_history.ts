import { expect } from "bun:test";
import type { Route } from "playwright";
import { postFixture, runBrowserTests, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2847 a failed optimistic delete restores the last side conversation and reports the error
  async function test_failed_side_delete(browser, base) {
    const agent = "side-delete-parent";
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.request.post(
      `${base}__browser-test/seed-model-selection-error`,
      {
        data: { agent, model: "fauxordinary/faux-1" },
      },
    );
    await page.goto(`${base}#agent=${agent}`);
    await page.locator("#input:enabled").fill("Reply only Delete parent ready");
    await page.locator("#input").press("Enter");
    await page
      .locator(".msg.assistant .content", { hasText: "Delete parent ready" })
      .waitFor();
    const response = await page.request.post(
      `${base}api/conversations/${agent}/side`,
      { data: {} },
    );
    expect(response.ok()).toBe(true);
    const { id } = (await response.json()) as { id: string };
    let releaseDelete!: () => void;
    const held = new Promise<void>((resolve) => (releaseDelete = resolve));
    await page.route(`${base}api/conversations/${id}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await held;
      await route.fulfill({ status: 500, body: "Delete failed" });
    });
    await page.goto(`${base}#agent=${agent}`);
    await page.locator('.rail-btn[data-pane="side"]').click();
    const pane = page.locator('.pane-col[data-pane="side"]');
    await pane.locator(`iframe[data-side="${id}"]`).waitFor();
    await pane
      .getByRole("button", { name: "Delete side conversation" })
      .click();
    try {
      await pane.waitFor({ state: "detached" });
    } finally {
      releaseDelete();
    }
    await pane.locator(`iframe[data-side="${id}"]`).waitFor();
    await pane
      .getByText("Could not delete this side conversation.", { exact: true })
      .waitFor();
    await page.close();
  },
  // Regression: #2817 parked side frames retain their cache without background reads
  async function test_parked_side_history(browser, base) {
    const { agent } = await postFixture(base, "seed-side-history");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const response = await page.request.post(
      `${base}api/conversations/${agent}/side`,
      { data: {} },
    );
    expect(response.ok()).toBe(true);
    const { id } = (await response.json()) as { id: string };
    const reads: string[] = [];
    const boots: string[] = [];
    const cursors: (string | undefined)[] = [];
    let cachedCursor = "";
    page.on("response", async (response) => {
      if (response.url().endsWith(`/api/conversations/${id}/view?limit=100`)) {
        const page = (await response.json()) as {
          instance_id: string;
          revision: number;
        };
        cachedCursor = `${page.instance_id}:${page.revision}`;
      }
    });
    page.on("request", (request) => {
      if (request.frame() === page.mainFrame() || request.method() !== "GET")
        return;
      if (request.isNavigationRequest()) boots.push(request.url());
      const url = new URL(request.url());
      if (url.pathname === `/api/conversations/${id}/events`)
        cursors.push(request.headers()["last-event-id"]);
      if (url.pathname.startsWith("/api/"))
        reads.push(url.pathname + url.search);
    });
    const parentTicks = async (count: number) => {
      for (let tick = 0; tick < count; tick++)
        await page.waitForRequest(
          (request) =>
            request.frame() === page.mainFrame() &&
            new URL(request.url()).pathname === "/api/tree",
        );
    };
    await page.goto(`${base}#agent=${agent}`);
    const rail = page.locator('.rail-btn[data-pane="side"]');
    const side = page.frameLocator("iframe.side-frame");
    await side
      .getByText("Side history answer 69", { exact: true })
      .waitFor({ state: "attached" });
    await side
      .locator("#scroll")
      .evaluate((node) => (node.dataset.cached = "retained"));
    await parentTicks(2);
    expect(
      reads.filter(
        (url) =>
          url.includes("before=") ||
          url.includes("/events") ||
          url === "/api/version",
      ),
    ).toEqual([]);
    expect(
      reads.filter((url) => url.startsWith(`/api/conversations/${id}/view`)),
    ).toHaveLength(1);
    expect(
      reads.filter((url) => url.startsWith(`/api/conversations/${id}?focused`)),
    ).toHaveLength(1);
    reads.length = 0;
    let holdCatchup = false;
    const held: Route[] = [];
    await page.route(`${base}api/conversations/${id}**`, (route) => {
      if (holdCatchup && route.request().method() === "GET") held.push(route);
      else void route.continue();
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.locator("#input").fill("Keep the side conversation closed");
      await parentTicks(4);
      expect(reads).toEqual([]);
      holdCatchup = true;
      await rail.click();
      expect(await side.locator("#scroll").getAttribute("data-cached")).toBe(
        "retained",
      );
      expect(
        await side
          .getByText("Side history answer 69", { exact: true })
          .isVisible(),
      ).toBe(true);
      holdCatchup = false;
      await Promise.all(held.splice(0).map((route) => route.continue()));
      if (cycle === 0) {
        const older = page.waitForRequest((request) => {
          const url = new URL(request.url());
          return (
            url.pathname === `/api/conversations/${id}/view` &&
            url.searchParams.has("before")
          );
        });
        await side.locator("#scroll").evaluate((node) => (node.scrollTop = 0));
        await older;
        await side
          .getByText("Side history answer 0", { exact: true })
          .waitFor({ state: "attached" });
      } else {
        await side.getByText("Arrived while parked", { exact: true }).waitFor();
      }
      await page
        .locator('.pane-col[data-pane="side"]')
        .getByRole("button", { name: /^Close / })
        .click();
      await page
        .locator("#side-frame-parking iframe.side-frame")
        .waitFor({ state: "attached" });
      reads.length = 0;
      if (cycle === 0) {
        const delivered = await page.request.post(
          `${base}api/conversations/${id}/deliver`,
          { data: { content: "Arrived while parked" } },
        );
        expect(delivered.ok()).toBe(true);
      }
    }
    await parentTicks(4);
    expect(reads).toEqual([]);
    expect(boots).toHaveLength(1);
    expect(cursors.length).toBeGreaterThanOrEqual(2);
    expect(cursors[0]).toBe(cachedCursor);
    expect(
      cursors.every(
        (cursor) => typeof cursor === "string" && cursor.includes(":"),
      ),
    ).toBe(true);
    await page.close();
  },
];
if (import.meta.main) await runBrowserTests([["side-history", tests]]);
