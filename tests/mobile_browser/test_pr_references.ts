import { expect } from "bun:test";
import type { Browser, Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { postFixture, runBrowserTests, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  async function test_pr_references(browser, base) {
    const { checkout, plain } = await postFixture(base, "seed-pr-references");
    for (const width of [1280, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      await page.goto(`${base}#agent=${checkout}`);
      const links = page.locator('.msg.assistant a[href*="/pull/"]');
      await links.first().waitFor();
      expect(
        await links.evaluateAll((nodes) =>
          nodes.map(
            (a) =>
              `${a.textContent}|${a.getAttribute("href")}|${a.getAttribute("target")}|${a.getAttribute("rel")}`,
          ),
        ),
      ).toEqual([
        "#42|https://github.com/Owner/Repo/pull/42|_blank|noopener noreferrer",
      ]);
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      if (shots) {
        await mkdir(shots, { recursive: true });
        await page.screenshot({ path: `${shots}/pr-references-${width}.png` });
      }
      await page.goto(`${base}#agent=${plain}`);
      await page
        .locator(".msg.assistant .content")
        .filter({ hasText: "Review #42 from pr-plain" })
        .waitFor();
      expect(
        await page.locator('.msg.assistant a[href*="/pull/"]').count(),
      ).toBe(0);
      await page.close();
    }
  },
  // Feature: #2929 branch PRs; #2941 created PRs; Changes opens newest PR.
  async function test_pr_links(browser, base) {
    const { root, notes, links, calls, createdCalls } = await postFixture(
      base,
      "seed-pr-links",
    );
    expect(links).toEqual({
      "pr-branch": [
        {
          repo: "owner/repo",
          number: 7,
          url: "https://github.com/owner/repo/pull/7",
          title: "Link branch pull requests",
          state: "open",
          checks: "pass",
          source: "branch",
          detected_at: expect.any(Number),
        },
      ],
      "pr-child": [
        {
          repo: "owner/repo",
          number: 8,
          url: "https://github.com/owner/repo/pull/8",
          title: "Record created pull requests",
          state: "open",
          checks: null,
          source: "created",
          detected_at: expect.any(Number),
        },
      ],
    });
    expect(calls).toHaveLength(1);
    const view =
      "--repo owner/repo --json number,title,url,state,baseRefName,statusCheckRollup,createdAt";
    expect(createdCalls).toEqual([
      "pr create --title Older",
      "pr create --title Record created pull requests",
      `pr view 8 ${view}`,
      "pr view 9 --json url -q .url",
      `pr view 9 ${view}`,
    ]);
    const page = await browser.newPage({
      viewport: { width: 1280, height: 844 },
    });
    const detached = await page.request.get(
      `${base}api/conversations/pr-detached/prs`,
    );
    expect(await detached.json()).toEqual({ prs: [] });
    const subtree = await page.request.get(
      `${base}api/conversations/${root}/prs`,
    );
    expect(
      (await subtree.json()).prs.map(
        (pr: { number: number; agent?: { id: string } }) =>
          `${pr.number} ${pr.agent?.id}`,
      ),
    ).toEqual(["8 pr-child", "7 pr-branch"]);
    const refreshes: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/pr-branch/prs?refresh=1"))
        refreshes.push(request.url());
    });
    await page.goto(`${base}#agent=pr-branch`);
    await page.locator('.rail-btn[data-pane="diff"]').waitFor();
    await page.locator("#input").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+P");
    const pane = page.locator('.pane-col[data-pane="diff"]');
    await pane.getByRole("option", { name: /#7/ }).waitFor();
    expect(
      (await pane.getByRole("option").allTextContents()).slice(0, 3),
    ).toEqual([
      "Working directory",
      "#7 · Link branch pull requests · open · checks pass",
      "#8 · Record created pull requests · open · pr-child",
    ]);
    await pane.locator(".diff-base-cancel").click();
    for (const [phone, view] of [
      [false, page],
      [true, await phoneView(browser, base)],
    ] as const) {
      const changes = view.locator('.pane-col[data-pane="diff"]');
      await changes
        .getByRole("heading", { name: "Record created pull requests" })
        .waitFor();
      await changes
        .locator(".diff-row.add", { hasText: "created link" })
        .waitFor();
      await changes
        .locator(".diff-row.add", { hasText: "uncommitted note" })
        .waitFor();
      expect(await changes.locator(".diff-pr-meta").textContent()).toContain(
        "#8 · open",
      );
      expect(
        await changes.locator(".diff-group-label").allTextContents(),
      ).toEqual(["Uncommitted changes", "Pull request files"]);
      const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
      if (shots) {
        await mkdir(shots, { recursive: true });
        await view.screenshot({
          path: `${shots}/pr-first-changes-${phone ? "phone" : "desktop"}.png`,
        });
      }
      if (phone) await view.close();
    }
    const note = pane.locator(".diff-row.add", { hasText: "uncommitted note" });
    await note.locator(".diff-num").click();
    await pane.locator(".diff-line-input").fill("Keep this note.");
    await writeFile(notes, "edited note\n");
    const reread = page.waitForResponse((response) =>
      response.url().endsWith("/pr-branch/diff?base=HEAD"),
    );
    await page.evaluate(() => {
      const browser = globalThis as any;
      browser.dispatchEvent(
        new browser.CustomEvent("recurse:ui-refresh", {
          detail: { agentId: "pr-branch" },
        }),
      );
    });
    await reread;
    expect(await pane.locator(".diff-line-input").inputValue()).toBe(
      "Keep this note.",
    );
    expect(await note.count()).toBe(1);
    page.once("dialog", (dialog) => dialog.accept());
    await pane.locator(".diff-sendbar-clear").click();
    const edited = pane.locator(".diff-row.add", { hasText: "edited note" });
    await edited.locator(".diff-num").click();
    await pane.locator(".diff-line-input").waitFor();
    const newer = page.waitForResponse((response) =>
      response.url().endsWith("/pr-branch/prs"),
    );
    await postFixture(base, "newer-pr-link");
    await newer;
    expect(await pane.locator(".diff-pr-title").textContent()).toContain(
      "Record created pull requests",
    );
    await edited.locator(".diff-add-comment").click();
    await pane.getByRole("heading", { name: "Newer pull request" }).waitFor();
    await pane.locator(".diff-base-btn").click();
    await postFixture(base, "retitle-pr-link");
    for (const name of [
      "#7 · Renamed 7 · open",
      "#8 · Renamed 8 · open · Child renamed",
    ])
      await pane.getByRole("option", { name }).waitFor();
    expect(refreshes).toHaveLength(1);
    await pane.locator(".pane-powerbar .x").click();
    await pane.waitFor({ state: "detached" });
    const reopened = [
      "/pr-branch/prs?refresh=1",
      "/pr-child/prs?refresh=1",
      "/pr-branch/diff?pr=",
    ].map((path) =>
      page.waitForRequest((request) => request.url().includes(path)),
    );
    await page.locator('.rail-btn[data-pane="diff"]').click();
    await Promise.all(reopened);
    expect(refreshes).toHaveLength(2);
    await page.close();
  },
];
async function phoneView(browser: Browser, base: string): Promise<Page> {
  const view = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await view.goto(`${base}#agent=pr-branch`);
  await view.locator("#pane-fab").tap();
  await view.locator('.pane-menu-item[data-pane="diff"]').tap();
  return view;
}
if (import.meta.main) await runBrowserTests([["pr-references", tests]]);
