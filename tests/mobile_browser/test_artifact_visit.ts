import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import {
  gotoRoot,
  postFixture,
  rootAgentId,
  runBrowserTests,
  waitForLayout,
  captureErrors,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3397 Artifact section links must scroll the document without changing the route.
  async function test_artifact_section_links(browser, base) {
    const paragraphs = Array.from(
      { length: 35 },
      (_, i) => `Paragraph ${i}.\n\n`,
    ).join("");
    const { agent, id } = await postFixture(base, "seed-artifact-sections", {
      markdown:
        "# Section links\n\n" +
        "[First](#browser-control-first) · [Second](#browser-control-first-1) · [Named](#named-anchor) · [Explicit](#explicit-anchor)\n\n" +
        paragraphs +
        "## Browser Control: First!\n\n[Top](#section-links) · [Open second](#artifact=$ARTIFACT&section=browser-control-first-1)\n\n" +
        paragraphs +
        "## Browser Control: First!\n\n[Top](#section-links) · [Unknown](#artifact=$ARTIFACT&section=unknown) · [Empty](#artifact=$ARTIFACT&section=)\n\n" +
        '<a name="named-anchor"></a>\n\n### Named destination\n\n<p id="explicit-anchor">Explicit destination</p>\n\n' +
        paragraphs,
    });
    for (const width of [1280, 412]) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      await page.goto(`${base}#agent=${agent}`);
      const originalUrl = page.url();
      const sectionLink = page
        .locator(`a[href="#artifact=${id}&section=browser-control-first-1"]`)
        .first();
      await sectionLink.click();
      const doc = page.locator('.pane-body[data-pane="report"] .report-doc');
      const second = doc
        .getByRole("heading", { name: "Browser Control: First!", exact: true })
        .nth(1);
      const inScroller = async (target: typeof second) => {
        await browserExpect
          .poll(() =>
            target.evaluate((element) => {
              let scroller = element.parentElement!;
              while (
                scroller.parentElement &&
                scroller.scrollHeight <= scroller.clientHeight
              )
                scroller = scroller.parentElement;
              const bounds = scroller.getBoundingClientRect();
              const rect = element.getBoundingClientRect();
              return (
                rect.top >= Math.max(0, bounds.top) &&
                rect.bottom <=
                  Math.min((globalThis as any).innerHeight, bounds.bottom)
              );
            }),
          )
          .toBe(true);
      };
      await second.waitFor();
      await inScroller(second);
      expect(page.url()).toBe(originalUrl);
      if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR)
        await page.screenshot({
          path: `${process.env.RECURSE_BROWSER_SCREENSHOT_DIR}/artifact-section-${width}.png`,
        });
      await doc.getByRole("link", { name: "Open second", exact: true }).click();
      await inScroller(second);
      const chatTop = await page
        .locator("#scroll")
        .evaluate((element) => element.scrollTop);
      for (const [link, selector] of [
        ["First", "h2 >> nth=0"],
        ["Second", "h2 >> nth=1"],
        ["Named", "h3"],
        ["Explicit", "#explicit-anchor"],
      ]) {
        await doc
          .getByRole("link", { name: "Top", exact: true })
          .last()
          .click();
        await inScroller(doc.locator("h1"));
        await doc.getByRole("link", { name: link, exact: true }).click();
        await inScroller(doc.locator(selector!));
        expect(page.url()).toBe(originalUrl);
        expect(
          await page
            .locator("#scroll")
            .evaluate((element) => element.scrollTop),
        ).toBe(chatTop);
      }
      await doc.getByRole("link", { name: "Top", exact: true }).last().click();
      for (const name of ["Unknown", "Empty"]) {
        await doc.getByRole("link", { name, exact: true }).click();
        await inScroller(doc.locator("h1"));
      }
      expect(context.pages().length).toBe(1);
      expect(errors).toEqual([]);
      await context.close();
    }
  },
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
