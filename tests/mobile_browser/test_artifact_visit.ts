import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  gotoRoot,
  postFixture,
  rootAgentId,
  runBrowserTests,
  waitForLayout,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3319 visiting a conversation must not open its app Artifact.
  async function test_artifact_visit_requires_explicit_open(browser, base) {
    const { agent, id } = await postFixture(
      base,
      "seed-native-artifact-settings",
    );
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await page.goto(`${base}#agent=${agent}`);
        await browserExpect(
          page.locator(".activity-group-summary .turn-summary"),
        ).toHaveText("Used Artifacts, used Recurse settings");
        expect(
          await page.locator('.pane-col[data-pane="report"]').count(),
        ).toBe(0);
        await page.locator(".activity-group-toggle").click();
        await page.locator(".turn-series-toggle").click();
        await browserExpect(page.locator(".turn-tool-name")).toHaveText([
          "Artifact",
          "Recurse settings",
        ]);
        const tools = page.locator(".turn-tool");
        await tools.nth(0).locator(".turn-tool-head").click();
        await browserExpect(
          tools.nth(0).getByRole("region", { name: "Output", exact: true }),
        ).toContainText(id);
        await tools.nth(1).locator(".turn-tool-head").click();
        await browserExpect(
          tools
            .nth(1)
            .getByRole("region", { name: "Full arguments", exact: true }),
        ).toContainText('"themes"');
        await page.locator(`a[href="#artifact=${id}"]`).click();
        await browserExpect(page.locator(".report-doc h1")).toHaveText(
          "Native report",
        );
      } finally {
        await page.close();
      }
    }
    const app = await postFixture(base, "seed-artifact-app");
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
      });
      const page = await context.newPage();
      await page.addInitScript((owner) => {
        const browser = globalThis as any;
        const json = browser.Response.prototype.json;
        browser.Response.prototype.json = async function () {
          const value = await json.call(this);
          const url = new URL(this.url);
          if (
            url.pathname === "/api/artifacts" &&
            url.searchParams.get("agent") === owner
          )
            browser.requestAnimationFrame(() => {
              browser.__artifactDiscoveryApplied = true;
            });
          return value;
        };
      }, rootAgentId());
      const discovery = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/artifacts" &&
          url.searchParams.get("agent") === rootAgentId()
        );
      });
      await gotoRoot(page, base);
      const link = page.locator(`a[href="#artifact=${app.id}"]`);
      await link.waitFor();
      const response = await discovery;
      expect(response.ok()).toBeTrue();
      const { artifacts: listing } = await response.json();
      expect(
        listing.some((item: { id: string }) => item.id === app.id),
      ).toBeTrue();
      await page.waitForFunction(
        () => (globalThis as any).__artifactDiscoveryApplied === true,
      );
      await waitForLayout(page);
      const pane = page.locator('.pane-col[data-pane="report"]');
      expect(await pane.count()).toBe(0);
      await link.click();
      const ready = () =>
        page
          .frameLocator("iframe.artifact-embed-page")
          .locator("body[data-ready]")
          .waitFor();
      await ready();
      expect(await pane.isVisible()).toBeTrue();
      await page.reload();
      await ready();
      expect(await pane.isVisible()).toBeTrue();
      await context.close();
    }
  },
];

if (import.meta.main) await runBrowserTests([["artifact-visit", tests]]);
