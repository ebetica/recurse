import { expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as artifacts from "../../src/artifacts";
import {
  ARTIFACT,
  ARTIFACT_VERSION,
  dispatchArtifactSelection,
  dispatchArtifactTap,
  gotoRoot,
  openPage,
  rootAgentId,
  routeArtifacts,
  runBrowserTests,
  stageArtifactComment,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Regression: #3328 submitting selection comments must not close or hide the Artifact pane.
  async function test_artifact_comments_keep_pane_open(browser, base, data) {
    const store = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const owner = rootAgentId();
    const artifact = await artifacts.create(store, {
      owner,
      title: "Commented document",
    });
    const path = join(String(artifact.repo_path), "index.md");
    for (const phone of [false, true]) {
      await writeFile(
        path,
        "# Review document\n\n" +
          Array.from(
            { length: 5 },
            (_, n) => `Selection anchor ${n + 1}.`,
          ).join("\n\n"),
      );
      await artifacts.publish(store, owner, String(artifact.id));
      const { context, page, errors } = await openPage(browser, {
        viewport: { width: phone ? 390 : 1280, height: 844 },
        touch: phone,
      });
      const other = !phone
        ? String(
            (
              await (
                await page.request.post(`${base}api/conversations`, {
                  data: { parent: null, title: "Comment navigation" },
                })
              ).json()
            ).id,
          )
        : null;
      await page.goto(`${base}#agent=${owner}&artifact=${artifact.id}`);
      const pane = page.locator('.pane-col[data-pane="report"]');
      await pane.getByRole("heading", { name: "Review document" }).waitFor();
      if (!phone) {
        await page.locator('.rail-btn[data-pane="tips"]').click();
        await page.locator('.rail-btn[data-pane="report"]').click();
      }
      const reply = `Artifact comments accepted ${phone ? "phone" : "desktop"}`;
      for (let n = 1; n <= 5; n++) {
        await stageArtifactComment(
          page,
          phone ? "touch" : "mouse",
          `Selection anchor ${n}`,
          n === 5 ? `Reply only ${reply}` : `Note ${n}`,
        );
      }
      page.once("dialog", (dialog) => void dialog.dismiss());
      await page
        .getByRole("button", { name: "Close Artifacts", exact: true })
        .click();
      expect(await pane.locator(".report-comment").count()).toBe(5);
      expect(await pane.isVisible()).toBeTrue();
      if (other) {
        page.once("dialog", (dialog) => void dialog.dismiss());
        await page.locator(`.agent[data-id="${other}"]`).click();
        expect(await pane.locator(".report-comment").count()).toBe(5);
        expect(await pane.isVisible()).toBeTrue();
      }
      await writeFile(path, "# Revised document\n\nAll anchors removed.");
      await artifacts.publish(store, owner, String(artifact.id));
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/artifacts",
      );
      await page.evaluate((agentId) => {
        const browser = globalThis as any;
        browser.dispatchEvent(
          new browser.CustomEvent("recurse:ui-refresh", {
            detail: { agentId },
          }),
        );
      }, owner);
      await (await refreshed).finished();
      expect(await pane.locator(".report-comment").count()).toBe(5);
      expect(
        await pane
          .getByRole("heading", { name: "Review document" })
          .isVisible(),
      ).toBeTrue();
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route(
        `**/api/conversations/${owner}/deliver`,
        async (route) => {
          await gate;
          await route.continue();
        },
      );
      const delivered = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
          `/api/conversations/${owner}/deliver`,
      );
      void delivered.catch(() => {});
      try {
        await pane.locator(".report-sendbar-send").click();
        expect(await pane.isVisible()).toBeTrue();
        const pending = page.locator("[data-comment-send]");
        await pending.waitFor({ state: "attached" });
        expect(await pending.textContent()).toContain("Note 1");
        expect(await pending.textContent()).toContain("Selection anchor 5");
      } finally {
        release();
      }
      expect((await delivered).ok()).toBeTrue();
      await page.unroute(`**/api/conversations/${owner}/deliver`);
      await page
        .locator(".msg.assistant", { hasText: reply })
        .waitFor({ state: "attached" });
      await pane.getByRole("heading", { name: "Revised document" }).waitFor();
      expect(await pane.locator(".report-comment").count()).toBe(0);
      expect(await pane.isVisible()).toBeTrue();
      await page.reload();
      await pane.getByRole("heading", { name: "Revised document" }).waitFor();
      expect(await pane.isVisible()).toBeTrue();
      if (other) {
        await page.locator(`.agent[data-id="${other}"]`).click();
        await page.locator(`.agent[data-id="${owner}"]`).click();
        await pane.getByRole("heading", { name: "Revised document" }).waitFor();
        expect(await pane.isVisible()).toBeTrue();
        expect(
          (await page.request.delete(`${base}api/conversations/${other}`)).ok(),
        ).toBeTrue();
      }
      expect(errors).toEqual([]);
      await context.close();
    }
    await artifacts.deleteArtifact(
      store,
      owner,
      String(artifact.id),
      String((await artifacts.get(store, owner, String(artifact.id))).version),
    );
  },
  async function test_artifact_comment_preserves_reader_scroll(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
    const paragraphs = Array.from(
      { length: 80 },
      (_, i) => `Paragraph ${i}: long artifact body.`,
    );
    paragraphs.splice(40, 0, "Reader anchor");
    await routeArtifacts(
      page,
      base,
      `# Browser artifact\n\n${paragraphs.join("\n\n")}`,
    );
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    await page.locator("#pane-fab").click();
    await page.locator('.pane-menu-item[data-pane="report"]').click();
    await page
      .locator(".report-doc p", { hasText: "Reader anchor" })
      .scrollIntoViewIfNeeded();
    await page.evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const paneBody = page.locator('.pane-col[data-pane="report"]');
    const readerScroll = await paneBody.evaluate(
      (element) =>
        (globalThis as any).getComputedStyle(element) &&
        (element as any).scrollTop,
    );
    expect(readerScroll).toBeGreaterThan(0);
    await dispatchArtifactSelection(page, "touch", "Reader anchor");
    await page.waitForFunction(
      "getSelection()?.toString() === 'Reader anchor'",
    );
    const popover = page.locator(".report-comment-popover:not([hidden])");
    await popover.waitFor();
    await popover.locator("textarea").fill("keep my place");
    await popover.locator(".report-comment-popover-submit").click();
    await page.waitForFunction(
      "document.activeElement?.classList.contains('report-comment-edit')",
    );
    expect(
      Math.abs(
        (await paneBody.evaluate((element) => (element as any).scrollTop)) -
          readerScroll,
      ),
    ).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
    await context.close();
  },
  // Regression: #2351 artifact comment send bar floated 14px above the desktop pane bottom
  async function test_artifact_send_bar_meets_pane_bottom(browser, base) {
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i}: long artifact body.`,
    );
    for (const phone of [false, true]) {
      const { context, page, errors } = await openPage(browser, {
        viewport: phone
          ? { width: 390, height: 844 }
          : { width: 1280, height: 800 },
        touch: phone,
      });
      await routeArtifacts(
        page,
        base,
        `# Browser artifact\nVisible body.\n\n${paragraphs.join("\n\n")}`,
      );
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      await page.evaluate((id) => {
        (globalThis as any).location.hash = `artifact=${id}`;
      }, ARTIFACT.id);
      const pane = page.locator('.pane-col[data-pane="report"]');
      await pane.locator(".report-doc", { hasText: "Visible body" }).waitFor();
      await dispatchArtifactSelection(page, phone ? "touch" : "mouse");
      const popover = page.locator(".report-comment-popover:not([hidden])");
      await popover.waitFor();
      await popover.locator("textarea").fill("bar placement");
      await popover.locator(".report-comment-popover-submit").click();
      const bar = page.locator(".report-sendbar.on");
      await bar.waitFor();
      await pane
        .locator(".report-doc p", { hasText: "Paragraph 30:" })
        .scrollIntoViewIfNeeded();
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      const [paneBox, barBox] = await Promise.all([
        pane.boundingBox(),
        bar.boundingBox(),
      ]);
      expect(
        Math.abs(barBox!.y + barBox!.height - (paneBox!.y + paneBox!.height)),
      ).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
      await context.close();
    }
  },
  // Regression: #3247 refresh must not reopen a submitted pane over comment retry controls.
  async function test_artifact_comment_pointer_flow(browser, base) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 844 },
      touch: true,
    });
    await routeArtifacts(page, base);
    const submissions: any[] = [];
    let attempts = 0;
    await page.route(
      `${base}api/conversations/${rootAgentId()}/deliver`,
      (route) => {
        attempts++;
        submissions.push(route.request().postDataJSON());
        if (attempts === 1 || attempts === 3)
          return route.fulfill({ status: 500, json: { detail: "retry" } });
        return route.fulfill({ json: { steer: false } });
      },
    );
    await gotoRoot(page, base);
    await page.locator('.rail-btn[data-pane="report"]').click();
    await page
      .locator('#dock .dv-tab[data-dock-panel="report"] button')
      .click();
    await page
      .locator('.pane-col[data-pane="report"]')
      .waitFor({ state: "detached" });
    await page.locator('.rail-btn[data-pane="tips"]').click();
    await page.locator('.rail-btn[data-pane="report"]').click();
    await page.locator('.pane-col[data-pane="report"] .report-doc').waitFor();
    await page.locator(".report-doc", { hasText: "Visible body" }).waitFor();
    await dispatchArtifactSelection(page, "touch");
    let popover = page.locator(".report-comment-popover:not([hidden])");
    await popover.waitFor();
    await popover.locator("textarea").fill("draft survives tap");
    const caret = await popover
      .locator("textarea")
      .evaluate((node: any) => [node.selectionStart, node.selectionEnd]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () =>
        (globalThis as any).document.querySelectorAll(".pane-col").length === 1,
    );
    expect(await page.locator(".pane-col").count()).toBe(1);
    expect(
      await page.locator(".pane-col.mobile-active").getAttribute("data-pane"),
    ).toBe("report");
    expect(await popover.locator("textarea").inputValue()).toBe(
      "draft survives tap",
    );
    expect(
      await popover
        .locator("textarea")
        .evaluate((node: any) => node.ownerDocument.activeElement === node),
    ).toBeTrue();
    expect(
      await popover
        .locator("textarea")
        .evaluate((node: any) => [node.selectionStart, node.selectionEnd]),
    ).toEqual(caret);
    await dispatchArtifactTap(page, "touch");
    expect(await popover.isVisible()).toBeTrue();
    expect(await popover.locator("textarea").inputValue()).toBe(
      "draft survives tap",
    );
    await page.locator(".report-comment-popover-cancel").click();
    expect(await page.locator(".report-comment").count()).toBe(0);
    await dispatchArtifactSelection(page, "touch");
    await page.locator(".report-comment-popover:not([hidden])").waitFor();
    await page.locator(".report-comment-popover textarea").fill("first note");
    await page.locator(".report-comment-popover-submit").click();
    expect(await page.locator(".report-comment").count()).toBe(1);
    await page.waitForFunction(
      "document.activeElement?.classList.contains('report-comment-edit') && !getSelection()?.toString()",
    );
    await dispatchArtifactSelection(page, "touch", "Browser artifact");
    const stagedPopover = page.locator(".report-comment-popover:not([hidden])");
    await stagedPopover.waitFor();
    await stagedPopover.locator("textarea").fill("draft with staged comment");
    await dispatchArtifactTap(page, "touch");
    expect(await page.locator(".report-comment").count()).toBe(1);
    expect(await stagedPopover.locator("textarea").inputValue()).toBe(
      "draft with staged comment",
    );
    await page.locator(".report-comment-popover-cancel").click();
    await dispatchArtifactSelection(page, "touch", "Browser artifact");
    await page.locator(".report-comment-popover:not([hidden])").waitFor();
    await page.locator(".report-comment-popover textarea").fill("second note");
    await page.locator(".report-comment-popover-submit").click();
    expect(await page.locator(".report-comment").count()).toBe(2);
    await page.locator(".report-sendbar-send").click();
    expect(
      await page.locator('.pane-col[data-pane="report"]').isVisible(),
    ).toBeTrue();
    await page
      .getByRole("button", { name: "Close Artifacts", exact: true })
      .click();
    const pending = page.locator("[data-comment-send]");
    const failure = pending.getByRole("alert");
    await failure.waitFor();
    expect(await pending.textContent()).toContain("first note");
    expect(await pending.textContent()).toContain("second note");
    await failure.getByRole("button", { name: "Retry" }).click();
    await pending.waitFor({ state: "detached" });
    expect(submissions.length).toBe(2);
    expect(submissions[1].client_message_id).toBe(
      submissions[0].client_message_id,
    );
    const payload = String(submissions[0].content);
    expect(payload).toContain(ARTIFACT.title);
    expect(payload).toContain(ARTIFACT.id);
    expect(payload).toContain(ARTIFACT_VERSION);
    expect(payload).toContain(
      `$CHAT_DATA_DIR/artifact_repos/${rootAgentId()}/${ARTIFACT.id}`,
    );
    expect(payload).toContain("first note");
    expect(payload).toContain("second note");
    await page.locator("#pane-fab").click();
    await page.locator('.pane-menu-item[data-pane="report"]').click();
    await page.locator('.pane-col[data-pane="report"] .report-doc').waitFor();
    await stageArtifactComment(
      page,
      "touch",
      "Visible body",
      "Discard this note",
    );
    await page.locator(".report-sendbar-send").click();
    expect(
      await page.locator('.pane-col[data-pane="report"]').isVisible(),
    ).toBeTrue();
    await page
      .getByRole("button", { name: "Close Artifacts", exact: true })
      .click();
    const refreshed = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/conversations/${rootAgentId()}`,
    );
    await page.evaluate("window.dispatchEvent(new Event('focus'))");
    await (await refreshed).finished();
    const discarded = page.locator("[data-comment-send]");
    page.once("dialog", (dialog) => void dialog.accept());
    await discarded.getByRole("button", { name: "Discard" }).click();
    await discarded.waitFor({ state: "detached" });
    expect(attempts).toBe(3);
    expect(errors).toEqual([]);
    await context.close();
  },
];

if (import.meta.main) await runBrowserTests([["artifact-comments", tests]]);
