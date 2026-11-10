import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import * as artifacts from "../../src/artifacts";
import {
  captureErrors,
  gotoRoot,
  postFixture,
  rootAgentId,
  type BrowserTest,
} from "./common";

async function observeRevision(page: Page, owner: string): Promise<void> {
  await page.evaluate((agentId) => {
    const win = globalThis as any;
    const fetch = win.fetch.bind(win);
    win.fetch = async (...args: any[]) => {
      const response = await fetch(...args);
      if (new URL(response.url).pathname === "/api/tree" && response.ok) {
        const tree = await response.clone().json();
        win.__artifactTreeRevision = tree.find(
          (node: any) => node.id === agentId,
        )?.artifacts_revision;
      }
      return response;
    };
    const changed = (event: any) => {
      if (event.detail?.agentId === agentId)
        win.__artifactEventRevision = win.__artifactTreeRevision;
    };
    win.addEventListener("recurse:artifacts-refresh", changed);
    win.addEventListener("recurse:ui-refresh", changed);
  }, owner);
}

async function waitForSourceDeletion(page: Page, base: string): Promise<void> {
  await browserExpect
    .poll(
      async () => {
        const response = await page.request.get(`${base}api/tree`);
        const tree = await response.json();
        return tree.some(
          (node: { id: string }) => node.id === "artifact-link-source",
        );
      },
      { timeout: 30_000 },
    )
    .toBe(false);
}

// Regression: #3201 await source deletion before reseeding its Pi session.
export const artifactReopen: BrowserTest = async (browser, base, data) => {
  const owner = rootAgentId();
  const context = {
    artifactsDir: join(data, "data", "artifact_repos"),
    trashDir: join(data, "data", "trash"),
  };
  const text = Array.from(
    { length: 5000 },
    (_, index) => `Paragraph ${index}: ${"large artifact content ".repeat(6)}`,
  ).join("\n\n");
  for (const kind of ["markdown", "html"] as const) {
    const item = await postFixture(base, "seed-artifact-app");
    const repo = String(item.cwd);
    const entry = kind === "markdown" ? "index.md" : "index.html";
    const content = (heading: string) =>
      kind === "markdown"
        ? `# ${heading}\n\n${text}`
        : `<!doctype html><h1>${heading}</h1><button id="count" onclick="this.textContent='clicked'">click</button><button id="raise" onclick="throw new Error('reopened error')">error</button><button id="height" onclick="parent.postMessage({recurseArtifactHeight: 1337}, '*')">resize</button><pre>${text}</pre>`;
    if (kind === "markdown") await rm(join(repo, "index.html"));
    for (const phone of [false, true]) {
      await writeFile(join(repo, entry), content(`Initial ${kind}`));
      await artifacts.publish(context, owner, String(item.id));
      const browserContext = await browser.newContext({
        viewport: { width: phone ? 390 : 1280, height: 800 },
        isMobile: phone,
        hasTouch: phone,
      });
      const page = await browserContext.newPage();
      const errors = captureErrors(page);
      await gotoRoot(page, base);
      const link = page.locator(`a[href="#artifact=${item.id}"]`);
      await link.waitFor();
      await link.click();
      const heading = (name: string) =>
        kind === "markdown"
          ? page.locator(".report-doc h1", { hasText: name })
          : page
              .frameLocator("iframe.artifact-embed-page")
              .getByRole("heading", { name, exact: true });
      await heading(`Initial ${kind}`).waitFor();
      const pane = page.locator('.pane-body[data-pane="report"]');
      await pane.evaluate((element: any) => (element.dataset.retained = "yes"));
      if (kind === "html")
        await page
          .frameLocator("iframe.artifact-embed-page")
          .locator("#count")
          .click();
      await page
        .getByRole("button", { name: "Close Artifacts", exact: true })
        .click();
      await page
        .locator('.pane-col[data-pane="report"]')
        .waitFor({ state: "detached" });
      const requests: string[] = [];
      const record = (request: { url(): string }) => {
        const path = new URL(request.url()).pathname;
        if (
          path === `/api/artifacts/${item.id}/file` ||
          path === `/api/artifacts/${item.id}/page`
        )
          requests.push(path);
      };
      page.on("request", record);
      await link.click();
      await heading(`Initial ${kind}`).waitFor();
      expect(await pane.getAttribute("data-retained")).toBe("yes");
      if (kind === "html")
        expect(
          await page
            .frameLocator("iframe.artifact-embed-page")
            .locator("#count")
            .textContent(),
        ).toBe("clicked");
      expect(requests).toEqual([]);
      page.off("request", record);
      if (kind === "html")
        await page.evaluate(() => {
          (globalThis as any).__closedAppFrame = (
            globalThis as any
          ).document.querySelector("iframe.artifact-embed-page");
        });
      await page
        .getByRole("button", { name: "Close Artifacts", exact: true })
        .click();
      await observeRevision(page, owner);
      await writeFile(join(repo, entry), content(`Updated ${kind}`));
      await artifacts.publish(context, owner, String(item.id));
      const revision = await artifacts.revision(context, owner);
      await page.waitForFunction(
        (expected) => (globalThis as any).__artifactEventRevision === expected,
        revision,
      );
      await link.click();
      expect(await pane.getAttribute("data-retained")).toBe("yes");
      const hidden = await pane.evaluate(
        (element: any) =>
          (globalThis as any).getComputedStyle(element).visibility === "hidden",
      );
      expect(
        hidden || !(await heading(`Initial ${kind}`).isVisible()),
      ).toBeTrue();
      await heading(`Updated ${kind}`).waitFor();
      if (kind === "html")
        expect(
          await page.evaluate(
            () => !(globalThis as any).__closedAppFrame.isConnected,
          ),
        ).toBeTrue();
      expect(errors).toEqual([]);
      await browserContext.close();
    }
    if (kind === "html") {
      await writeFile(join(repo, entry), content("Initial html"));
      await artifacts.publish(context, owner, String(item.id));
      const other = await postFixture(
        base,
        "seed-artifact-app?agent=artifact-link-source",
      );
      const browserContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const page = await browserContext.newPage();
      await page.addInitScript(() => {
        delete (globalThis as any).Element.prototype.moveBefore;
      });
      await gotoRoot(page, base);
      const link = page.locator(`a[href="#artifact=${item.id}"]`);
      await link.click();
      await page
        .frameLocator("iframe.artifact-embed-page")
        .getByRole("heading", { name: "Initial html", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Close Artifacts", exact: true })
        .click();
      await page.evaluate((id) => {
        (globalThis as any).location.hash =
          `agent=artifact-link-source&artifact=${id}`;
      }, String(other.id));
      await page
        .frameLocator("iframe.artifact-embed-page")
        .locator("body[data-ready]")
        .waitFor();
      await page.evaluate((id) => {
        (globalThis as any).location.hash = `agent=${id}`;
      }, owner);
      await link.waitFor();
      await link.click();
      const frame = page.frameLocator("iframe.artifact-embed-page");
      await frame
        .getByRole("heading", { name: "Initial html", exact: true })
        .waitFor();
      await frame.locator("#height").click();
      await page.waitForFunction(
        () =>
          (globalThis as any).document.querySelector(
            "iframe.artifact-embed-page",
          )?.style.height === "1337px",
      );
      await frame.locator("#raise").click();
      await page
        .locator(".artifact-errors li", { hasText: "reopened error" })
        .waitFor();
      const otherInfo = await artifacts.get(
        context,
        "artifact-link-source",
        String(other.id),
      );
      await artifacts.deleteArtifact(
        context,
        "artifact-link-source",
        String(other.id),
        String(otherInfo.version),
      );
      expect(
        (
          await page.request.delete(
            `${base}api/conversations/artifact-link-source`,
          )
        ).status(),
      ).toBe(202);
      await waitForSourceDeletion(page, base);
      await browserContext.close();
    }
    const current = await artifacts.get(context, owner, String(item.id));
    await artifacts.deleteArtifact(
      context,
      owner,
      String(item.id),
      String(current.version),
    );
  }

  const item = await postFixture(base, "seed-artifact-app");
  const repo = String(item.cwd);
  await rm(join(repo, "index.html"));
  await writeFile(join(repo, "index.md"), "# Unversioned initial");
  await artifacts.publish(context, owner, String(item.id));
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const errors = captureErrors(page);
  let release = () => {};
  try {
    await page.route(/\/api\/artifacts\?/, async (route) => {
      const response = await route.fetch();
      const list = await response.json();
      await route.fulfill({
        response,
        json: {
          ...list,
          artifacts: list.artifacts.map((row: any) =>
            row.id === item.id
              ? { ...row, version: null, updated_at: "2026-01-01T00:00:00Z" }
              : row,
          ),
        },
      });
    });
    let hold = false;
    const pending = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/artifacts/${item.id}/file?**`, async (route) => {
      if (hold) await pending;
      await route.continue();
    });
    await gotoRoot(page, base);
    const link = page.locator(`a[href="#artifact=${item.id}"]`);
    await link.click();
    const pane = page.locator('.pane-body[data-pane="report"]');
    const initial = page.getByRole("heading", { name: "Unversioned initial" });
    await initial.waitFor();
    await pane.evaluate((element: any) => (element.dataset.retained = "yes"));
    await page.getByRole("button", { name: "Close Artifacts" }).click();
    await observeRevision(page, owner);
    await writeFile(join(repo, "index.md"), "# Unversioned updated");
    await artifacts.publish(context, owner, String(item.id));
    const revision = await artifacts.revision(context, owner);
    await page.waitForFunction(
      (expected) => (globalThis as any).__artifactEventRevision === expected,
      revision,
    );
    hold = true;
    const read = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith(`/artifacts/${item.id}/file`),
    );
    await link.click();
    await read;
    expect(await pane.getAttribute("data-retained")).toBe("yes");
    expect(await initial.isVisible()).toBeFalse();
    release();
    await page.getByRole("heading", { name: "Unversioned updated" }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    release();
    try {
      expect(
        (
          await page.request.delete(
            `${base}api/conversations/artifact-link-source`,
          )
        ).status(),
      ).toBe(202);
      await waitForSourceDeletion(page, base);
    } finally {
      await page.close();
      const current = await artifacts.get(context, owner, String(item.id));
      await artifacts.deleteArtifact(
        context,
        owner,
        String(item.id),
        String(current.version),
      );
    }
  }
};
