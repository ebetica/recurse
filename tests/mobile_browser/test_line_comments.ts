import { expect } from "bun:test";
import { waitForPaneTransition } from "./pane_layout";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

const PATCH = [
  "diff --git a/src/small.txt b/src/small.txt",
  "index 111..222 100644",
  "--- a/src/small.txt",
  "+++ b/src/small.txt",
  "@@ -2,7 +2,7 @@",
  " line 2 body",
  " line 3 body",
  " line 4 body",
  "-line 5 body",
  "+line 5 CHANGED",
  " line 6 body",
  " line 7 body",
  " line 8 body",
].join("\n");
const SUMMARY = {
  available: true,
  base: "origin/main",
  baseSha: "a".repeat(40),
  baseSource: "auto:origin/main",
  headSha: "b".repeat(40),
  branch: "operator/comments",
  cwd: "/wt",
  cwdSource: "stored",
  stat: " 1 file changed",
  truncated: false,
  files: [
    { path: "src/small.txt", additions: 1, deletions: 1, status: "modified" },
  ],
  moreFiles: 0,
  untracked: [],
  currentPr: null,
  version: "comments-fixture",
};
const shots =
  process.env.RECURSE_SCREENSHOT_DIR ??
  join(
    process.env.RECURSE_AGENT_TMPDIR ?? process.env.TMPDIR ?? tmpdir(),
    "recurse-comments-shots",
  );

async function runningTree(
  route: import("playwright").Route,
  id: string,
): Promise<void> {
  const response = await route.fetch();
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  for (const row of rows) if (row.id === id) row.status = "running";
  await route.fulfill({ response, json: rows });
}
async function runningView(route: import("playwright").Route): Promise<void> {
  const response = await route.fetch();
  const payload = (await response.json()) as Record<string, unknown>;
  payload.status = "running";
  await route.fulfill({ response, json: payload });
}
const MOBILE_COMMENT_MESSAGE = [
  "Comments from user:",
  "Selected change target: current worktree",
  "",
  "> [worktree] src/small.txt:5 (new side)",
  "```diff",
  "+line 5 CHANGED",
  "```",
  "mobile note",
].join("\n");
async function openChanges(
  page: Page,
  base: string,
  demo: string,
  mobile = false,
) {
  if (mobile)
    await page.goto(`${base}#agent=${demo}`, { waitUntil: "domcontentloaded" });
  else {
    await gotoRoot(page, base);
    await page.locator(`.agent[data-id="${demo}"]`).click();
  }
  await page.locator("#conv-title").waitFor();
  if (mobile) {
    await page.locator("#pane-fab").tap();
    const item = page.locator('.pane-menu-item[data-pane="diff"]');
    await item.waitFor({ state: "attached", timeout: 15_000 });
    await item.tap();
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
  } else await page.locator('.rail-btn[data-pane="diff"]').click();
  const pane = page.locator('.pane-col[data-pane="diff"]');
  await pane
    .locator(".diff-file-toggle", { hasText: "src/small.txt" })
    .waitFor();
  await waitForPaneTransition(page, '.pane-col[data-pane="diff"]');
  return pane;
}
function num(file: ReturnType<Page["locator"]>, text: string) {
  return file.locator(".diff-num", { hasText: text }).first();
}
async function shot(page: Page, name: string): Promise<void> {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: join(shots, name) });
}

export const tests: BrowserTest[] = [
  // Regression: #2439 context failure must not detach an active drag's source.
  async function test_contents_unavailable_preserves_code_selection(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const { demo } = await postFixture(base, "seed-files-pane");
    let releaseContents!: () => void;
    const contentsGate = new Promise<void>((resolve) => {
      releaseContents = resolve;
    });
    await page.route("**/api/conversations/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/conversations/${demo}/diff`)
        return route.fulfill({ json: SUMMARY });
      if (url.pathname === `/api/conversations/${demo}/diff/files`) {
        if (url.searchParams.has("contents")) await contentsGate;
        return route.fulfill({
          json: {
            available: true,
            path: "src/small.txt",
            patch: PATCH,
            truncated: false,
          },
        });
      }
      return route.continue();
    });
    const pane = await openChanges(page, base, demo);
    const source = pane.locator(".diff-row.add .diff-src");
    await source.waitFor();
    const original = await source.elementHandle();
    if (!original) throw new Error("Added source is missing");
    const box = await source.boundingBox();
    if (!box) throw new Error("Added source is hidden");
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, {
      steps: 10,
    });
    const selection = await page.evaluate(() =>
      String((globalThis as any).getSelection()),
    );
    expect(selection.trim()).not.toBe("");
    releaseContents();
    await pane.locator(".diff-expand-note").waitFor();
    expect(await original.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    expect(
      await page.evaluate(() => String((globalThis as any).getSelection())),
    ).toBe(selection);
    expect(await source.boundingBox()).toEqual(box);
    await page.mouse.up();
    expect(await pane.locator(".diff-line-input, .in-range").count()).toBe(0);
    await original.dispose();
    await context.close();
  },
  async function test_line_comments_desktop(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const fixture = (await postFixture(base, "seed-files-pane")) as {
      demo: string;
    };
    const demo = fixture.demo;
    await page.route("**/api/tree", (route) => runningTree(route, demo));
    await page.route(
      new RegExp(`/api/conversations/${demo}\\?[^/]*$`),
      runningView,
    );
    const delivered: string[] = [];
    await page.route("**/api/conversations/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/conversations/${demo}/diff`)
        return route.fulfill({ json: SUMMARY });
      if (path === `/api/conversations/${demo}/diff/files`)
        return route.fulfill({
          json: {
            available: true,
            path: "src/small.txt",
            patch: PATCH,
            truncated: false,
          },
        });
      return route.continue();
    });
    await page.route(`**/api/conversations/${demo}/deliver`, (route) => {
      delivered.push(route.request().postData() ?? "");
      return route.fulfill({
        json: { steer: false, message_id: "comments-desktop-message" },
      });
    });
    const pane = await openChanges(page, base, demo);
    const small = pane.locator(".diff-file", { hasText: "src/small.txt" });
    await small.locator(".diff-row.add").waitFor();
    const source = small.locator(".diff-row.add .diff-src");
    const sourceBox = (await source.boundingBox())!;
    const add = small.locator(".diff-row.add .diff-add-comment");
    await pane.locator(".pane-body").focus();
    await add.hover();
    await page.keyboard.press("c");
    const lineInput = small.locator(".diff-line-input");
    expect(await lineInput.count()).toBe(1);
    expect(
      await lineInput.evaluate(
        (element) => element === element.ownerDocument.activeElement,
      ),
    ).toBe(true);
    expect(delivered).toEqual([]);
    await add.click();
    expect(await lineInput.count()).toBe(0);
    await add.click();
    expect(
      await lineInput.evaluate(
        (element) => element === element.ownerDocument.activeElement,
      ),
    ).toBe(true);
    await add.click();
    await num(small, "5").hover();
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + 5, sourceBox.y + sourceBox.height / 2);
    await page.mouse.up();
    expect(await small.locator(".diff-line-input, .in-range").count()).toBe(0);
    await page.mouse.move(sourceBox.x + 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sourceBox.x + sourceBox.width - 2,
      sourceBox.y + sourceBox.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    expect(
      await page.evaluate(() =>
        String((globalThis as any).getSelection()).trim(),
      ),
    ).not.toBe("");
    expect(await small.locator(".diff-line-input, .in-range").count()).toBe(0);
    await shot(page, "comments-desktop-selection.png");
    await num(small, "5").click();
    expect(await small.locator(".diff-line-input").count()).toBe(1);
    await num(small, "5").click();
    await pane.getByLabel("Changes options", { exact: true }).click();
    await pane.getByRole("button", { name: "Split" }).click();
    await small.locator(".diff-split-row").first().waitFor();
    expect(
      await small
        .locator(".diff-split-row .diff-num", { hasText: "2" })
        .count(),
    ).toBe(2);
    const boxes = small.locator(".diff-patch-content > .diff-line-comment");
    const inCell = small.locator(".diff-split-row .diff-line-comment");
    await small.locator(".diff-cell.new.add").hover();
    const newPlus = small.getByRole("button", {
      name: "Comment on src/small.txt line 5 (new side)",
      exact: true,
    });
    await newPlus.click();
    expect(await boxes.count()).toBe(1);
    expect(await inCell.count()).toBe(0);
    await small.locator(".diff-cell.old.del").hover();
    const oldPlus = small.getByRole("button", {
      name: "Comment on src/small.txt line 5 (old side)",
      exact: true,
    });
    await oldPlus.click();
    expect(await boxes.count()).toBe(2);
    expect(await inCell.count()).toBe(0);
    await small.locator(".diff-cell.new.add").hover();
    await newPlus.click();
    await small.locator(".diff-cell.old.del").hover();
    await oldPlus.click();
    expect(await boxes.count()).toBe(0);
    await num(small, "3").hover();
    await page.mouse.down();
    await num(small, "5").hover();
    await page.mouse.up();
    expect(await small.locator(".diff-cell.in-range").count()).toBe(3);
    await small.getByPlaceholder("Leave a comment on lines 3–5…").waitFor();
    expect(await boxes.count()).toBe(1);
    expect(await inCell.count()).toBe(0);
    await shot(page, "comments-desktop-split.png");
    await small.locator(".diff-cell.old.del").hover();
    await oldPlus.click();
    expect(await boxes.count()).toBe(0);
    expect(await pane.locator(".diff-sendbar-label").textContent()).toBe(
      "0 comments",
    );
    await pane.getByLabel("Changes options", { exact: true }).click();
    await pane.getByRole("button", { name: "Unified" }).click();
    await small.locator(".diff-row.add").waitFor();
    await num(small, "2").hover();
    await page.mouse.down();
    await num(small, "4").hover();
    await page.mouse.up();
    expect(await small.locator(".diff-row.in-range").count()).toBe(3);
    await small.getByPlaceholder("Leave a comment on lines 2–4…").waitFor();
    await num(small, "6").click({ modifiers: ["Shift"] });
    const editor = small.getByPlaceholder("Leave a comment on lines 2–6…");
    await editor.waitFor();
    expect(await small.locator(".diff-row.in-range").count()).toBe(5);
    await editor.fill("range note");
    expect(await pane.getByText("1 comment", { exact: true }).count()).toBe(1);
    await shot(page, "comments-desktop-range.png");
    await small.locator(".diff-row.add").hover();
    await small
      .getByRole("button", {
        name: "Comment on src/small.txt line 5 (new side)",
        exact: true,
      })
      .click();
    await small
      .locator(".diff-row.add + .diff-line-comment textarea")
      .fill("new-side note");
    await small.locator(".diff-row.del").hover();
    await small
      .getByRole("button", {
        name: "Comment on src/small.txt line 5 (old side)",
        exact: true,
      })
      .click();
    await small
      .locator(".diff-row.del + .diff-line-comment textarea")
      .fill("old-side note");
    expect(await pane.getByText("3 comments", { exact: true }).count()).toBe(1);
    await pane.getByRole("button", { name: "Submit comment" }).click();
    await page.waitForFunction(
      "document.querySelector('.diff-sendbar-label')?.textContent === '0 comments'",
      null,
      { timeout: 15_000 },
    );
    expect(await small.locator(".diff-line-input").count()).toBe(0);
    expect(delivered).toHaveLength(1);
    const message = JSON.parse(delivered[0]).content as string;
    expect(message).toContain(
      "> [worktree] src/small.txt:2-6 (new side)\n```diff\n line 2 body\n line 3 body\n line 4 body\n+line 5 CHANGED\n line 6 body\n```\nrange note",
    );
    expect(message).toContain(
      "> [worktree] src/small.txt:5 (new side)\n```diff\n+line 5 CHANGED\n```\nnew-side note",
    );
    expect(message).toContain(
      "> [worktree] src/small.txt:5 (old side)\n```diff\n−line 5 body\n```\nold-side note",
    );
    await page.locator("#input").fill(message);
    await Promise.all([
      page.waitForResponse(`${base}api/conversations/${demo}/deliver`),
      page.getByRole("button", { name: "Send message" }).click(),
    ]);
    const threadBubble = page.locator(".msg.user", {
      hasText: "Comments from user:",
    });
    await threadBubble.last().waitFor();
    expect(await threadBubble.last().locator("pre > code").count()).toBe(3);
    await shot(page, "comments-desktop-thread.png");
    expect(
      await threadBubble.last().locator("pre").first().innerText(),
    ).toContain("+line 5 CHANGED");
    expect(errors).toEqual([]);
    await closeWithRoutes(context);
  },
  async function test_line_comments_mobile(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const fixture = (await postFixture(base, "seed-files-pane")) as {
      demo: string;
    };
    const demo = fixture.demo;
    let mobileDelivered = false;
    await page.route("**/api/tree", (route) => runningTree(route, demo));
    await page.route(
      new RegExp(`/api/conversations/${demo}\\?[^/]*$`),
      runningView,
    );
    await page.route("**/api/conversations/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === `/api/conversations/${demo}/events`) {
        const blocks = mobileDelivered
          ? [
              {
                id: "mobile-comment",
                kind: "text",
                role: "user",
                text: MOBILE_COMMENT_MESSAGE,
                origin: "operator",
                name: null,
                args: "",
                result: null,
                result_truncated: false,
                live: false,
              },
            ]
          : [];
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            "retry: 3000\n\n" +
            "id: mobile-comments:1\n" +
            "event: snapshot\n" +
            `data: ${JSON.stringify({ status: "ready", instance_id: "mobile-comments", revision: mobileDelivered ? 2 : 1, blocks, older: false, newer: false })}\n\n`,
        });
      }
      if (path === `/api/conversations/${demo}/view`)
        return route.fulfill({
          json: {
            status: "ready",
            instance_id: "mobile-comments",
            revision: mobileDelivered ? 2 : 1,
            blocks: mobileDelivered
              ? [
                  {
                    id: "mobile-comment",
                    kind: "text",
                    role: "user",
                    text: MOBILE_COMMENT_MESSAGE,
                    origin: "operator",
                    name: null,
                    args: "",
                    result: null,
                    result_truncated: false,
                    live: false,
                  },
                ]
              : [],
            older: false,
            newer: false,
          },
        });
      if (path === `/api/conversations/${demo}/deliver`) {
        mobileDelivered = true;
        return route.fulfill({
          json: { steer: true, message_id: "comments-mobile-message" },
        });
      }
      if (path === `/api/conversations/${demo}/diff`)
        return route.fulfill({ json: SUMMARY });
      if (path === `/api/conversations/${demo}/diff/files`)
        return route.fulfill({
          json: {
            available: true,
            path: "src/small.txt",
            patch: PATCH,
            truncated: false,
          },
        });
      return route.continue();
    });
    const pane = await openChanges(page, base, demo, true);
    const small = pane.locator(".diff-file", { hasText: "src/small.txt" });
    await small.locator(".diff-row.add").waitFor();
    const sourceBox = (await small
      .locator(".diff-row.add .diff-src")
      .boundingBox())!;
    await page.mouse.move(sourceBox.x + 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sourceBox.x + sourceBox.width - 2,
      sourceBox.y + sourceBox.height / 2,
      { steps: 10 },
    );
    await page.mouse.up();
    expect(
      await page.evaluate(() =>
        String((globalThis as any).getSelection()).trim(),
      ),
    ).not.toBe("");
    expect(await small.locator(".diff-line-input, .in-range").count()).toBe(0);
    await shot(page, "comments-mobile-selection.png");
    await num(small, "5").tap();
    const editor = small.locator(".diff-line-input").first();
    await editor.waitFor();
    await editor.fill("mobile note");
    expect(await pane.getByText("1 comment", { exact: true }).count()).toBe(1);
    await shot(page, "comments-mobile-390.png");
    await pane.getByRole("button", { name: "Submit comment" }).click();
    await page.waitForFunction(
      "document.querySelector('.diff-sendbar-label')?.textContent === '0 comments'",
      null,
      { timeout: 15_000 },
    );
    await page.locator('.pane-col[data-pane="diff"] .x').click();
    const threadBubble = page.locator(".msg.user", {
      hasText: "+line 5 CHANGED",
    });
    await threadBubble.last().waitFor();
    expect(await page.locator(".msg.user pre > code").count()).toBe(1);
    await shot(page, "comments-mobile-thread.png");
    expect(errors).toEqual([]);
    await closeWithRoutes(context);
  },
];
if (import.meta.main) await runBrowserTests([["line-comments", tests]]);
