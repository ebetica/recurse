import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import captured from "../backend/fixtures/pull_request_diff.json";
import {
  captureErrors,
  postFixture,
  runBrowserTests,
  type BrowserTest,
} from "./common";

async function openChanges(page: Page, base: string, cid: string) {
  await page.goto(`${base}#agent=${cid}`, { waitUntil: "domcontentloaded" });
  if (page.viewportSize()!.width < 600) {
    await page.locator("#pane-fab").tap();
    await page.locator('.pane-menu-item[data-pane="diff"]').tap();
  } else await page.locator('.rail-btn[data-pane="diff"]').click();
  return page.locator('.pane-col[data-pane="diff"]');
}

async function shoot(page: Page, name: string) {
  const dir = process.env.RECURSE_SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}

// Feature: #3183 #3342 Changes names its base, switches by name, flags caps.
async function test_changes_base(browser: Browser, base: string) {
  const { cid, branch, start } = await postFixture(base, "seed-changes-base");
  const { cwd } = (await (
    await fetch(`${base}api/conversations/${cid}/diff`)
  ).json()) as { cwd: string };
  const createdUntracked = Array.from(
    { length: 501 },
    (_, i) => `untracked-${i}.txt`,
  );
  await Promise.all(
    createdUntracked.map((name) => writeFile(join(cwd, name), "local only\n")),
  );
  const untrackedNames = createdUntracked.sort().slice(0, 500);
  const short = String(branch).slice(0, 7);
  const page = await browser.newPage({
    viewport: { width: 1280, height: 844 },
  });
  const errors = captureErrors(page);
  const pane = await openChanges(page, base, cid);
  const label = pane.locator(".diff-base-btn");
  const since = (name: string) =>
    label.filter({ hasText: `Changes since ${name}` }).waitFor();
  const added = (text: string) =>
    pane.locator(".diff-row.add", { hasText: text });
  await since("main");
  await added("branch line").waitFor();
  await added("uncommitted line").waitFor();
  expect(
    await pane.locator(".diff-file-toggle .diff-path").allTextContents(),
  ).toEqual(["a.txt"]);
  const untracked = pane.locator("details.diff-untracked");
  await untracked.locator("summary", { hasText: "500" }).waitFor();
  expect(
    (await pane.locator(".diff-trunc").allTextContents()).map((text) =>
      text.replace(/\s+/gu, " ").trim(),
    ),
  ).toEqual(["The untracked file list is capped — showing 500 names."]);
  expect(await untracked.getAttribute("open")).toBeNull();
  expect(await untracked.locator(".diff-path").allTextContents()).toEqual(
    untrackedNames,
  );
  expect(await pane.locator(".diff-path").allTextContents()).toEqual([
    "a.txt",
    ...untrackedNames,
  ]);
  await browserExpect(pane.locator(".diff-group-label")).toHaveText(
    ["Changed files", "Untracked"],
    { useInnerText: true },
  );
  await browserExpect(pane.locator(".diff-stat")).toHaveText(
    "1 file changed +2 −0",
  );
  const defaultTip = await label.getAttribute("title");
  expect(defaultTip).toContain(String(start).slice(0, 7));
  await shoot(page, "changes-default-untracked-desktop");
  await untracked.locator("summary").click();
  expect(
    await untracked.locator(".diff-path:visible").allTextContents(),
  ).toEqual(untrackedNames);
  expect(await pane.locator(".diff-path:visible").allTextContents()).toEqual([
    "a.txt",
    ...untrackedNames,
  ]);
  await untracked.locator("summary").click();
  await label.click();
  const input = pane.getByRole("combobox", { name: "Show the changes of" });
  const [inputBox, applyBox, cancelBox] = await Promise.all(
    [
      input,
      pane.locator(".diff-base-apply"),
      pane.locator(".diff-base-cancel"),
    ].map((control) => control.boundingBox()),
  );
  expect(inputBox!.width).toBeGreaterThan(applyBox!.width + cancelBox!.width);
  await input.fill("no-such-branch");
  await input.press("Enter");
  await pane
    .locator(".diff-base-error", {
      hasText: 'No branch, tag or commit named "no-such-branch".',
    })
    .waitFor();
  await input.fill(String(branch));
  const selectedPatch = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/diff/files") &&
      !url.searchParams.has("contents") &&
      url.searchParams.has("snapshot")
    );
  });
  const selectedContents = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/diff/files") &&
      url.searchParams.get("contents") === "1" &&
      url.searchParams.has("snapshot")
    );
  });
  await input.press("Enter");
  expect(
    new URL((await selectedPatch).url()).searchParams.get("snapshot"),
  ).toBe(`${start}..${branch}`);
  const contentsResponse = await selectedContents;
  expect(new URL(contentsResponse.url()).searchParams.get("snapshot")).toBe(
    `${start}..${branch}`,
  );
  const contents = await contentsResponse.json();
  expect(contents.newContent).toContain("branch line");
  expect(contents.newContent).not.toContain("uncommitted line");
  await label.filter({ hasText: `${short} since main` }).waitFor();
  await added("branch line").waitFor();
  await added("uncommitted line").waitFor({ state: "detached" });
  expect(await pane.locator(".diff-untracked-note").count()).toBe(0);
  await shoot(page, "changes-since-commit-desktop");
  const commitTip = await label.getAttribute("title");
  expect(commitTip).toBe(`Commits after main up to ${short} (1 commit).`);
  expect(commitTip).not.toBe(defaultTip);
  await label.click();
  expect(await pane.getByRole("option").first().textContent()).toBe(
    "Changes since main (default)",
  );
  expect(await pane.locator(".diff-base-section").allTextContents()).toEqual([
    "Show the changes of",
    "Change target",
  ]);
  await browserExpect(pane.locator(".diff-base-kind")).toHaveText(
    ["", "Branch", "Branch", "Branch", "Commit", ""],
    { useInnerText: true },
  );
  await shoot(page, "changes-since-commit-finder-desktop");
  const defaultPatch = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/diff/files") &&
      !url.searchParams.has("contents") &&
      !url.searchParams.has("snapshot")
    );
  });
  await pane
    .getByRole("option", { name: "Changes since main (default)" })
    .click();
  await since("main");
  expect((await (await defaultPatch).json()).patch).toContain(
    "+uncommitted line",
  );
  await added("uncommitted line").waitFor();
  await label.click();
  await input.fill("HEAD");
  await input.press("Enter");
  await label.filter({ hasText: "Uncommitted changes" }).waitFor();
  await added("branch line").waitFor({ state: "detached" });
  await untracked.locator("summary", { hasText: "500" }).waitFor();
  expect(await untracked.getAttribute("open")).toBeNull();
  expect(await pane.locator(".diff-group-label").allTextContents()).toEqual([
    "Changed files",
    "Untracked",
  ]);
  await label.click();
  await pane
    .getByRole("option", { name: "Changes on this branch (default)" })
    .click();
  await since("main");
  await added("branch line").waitFor();
  const phone = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phonePane = await openChanges(phone, base, cid);
  await phonePane
    .locator(".diff-base-btn", { hasText: "Changes since main" })
    .waitFor();
  await phonePane.locator(".diff-row.add").first().waitFor();
  const defaultDisclosure = phonePane.locator(".diff-untracked > summary");
  await defaultDisclosure.filter({ hasText: "500" }).waitFor();
  expect(
    await phonePane.locator(".diff-untracked").getAttribute("open"),
  ).toBeNull();
  expect(
    await phonePane.locator(".diff-group-label").allTextContents(),
  ).toEqual(["Changed files", "Untracked"]);
  expect(
    await phonePane.locator(".diff-file-toggle .diff-path").allTextContents(),
  ).toEqual(["a.txt"]);
  expect(
    await phonePane.locator(".diff-untracked .diff-path").allTextContents(),
  ).toEqual(untrackedNames);
  await shoot(phone, "changes-default-untracked-phone");
  await defaultDisclosure.tap();
  expect(
    await phonePane
      .locator(".diff-untracked .diff-path:visible")
      .allTextContents(),
  ).toEqual(untrackedNames);
  await defaultDisclosure.tap();
  await phonePane.locator(".diff-base-btn").click();
  const phoneInput = phonePane.getByRole("combobox", {
    name: "Show the changes of",
  });
  await phoneInput.fill(String(branch));
  await phoneInput.press("Enter");
  await phonePane
    .locator(".diff-base-btn", { hasText: `${short} since main` })
    .waitFor();
  await phonePane
    .locator(".diff-row.add", { hasText: "branch line" })
    .waitFor();
  await shoot(phone, "changes-in-commit-phone");
  expect(await phonePane.locator(".diff-untracked-note").count()).toBe(0);
  await phonePane.locator(".diff-base-btn").click();
  await phoneInput.fill("HEAD");
  await phoneInput.press("Enter");
  const disclosure = phonePane.locator(".diff-untracked > summary");
  await disclosure.waitFor();
  await disclosure.scrollIntoViewIfNeeded();
  expect(
    await disclosure.evaluate((control) => {
      const rect = control.getBoundingClientRect();
      return [rect.left + 2, rect.right - 2].every((x) =>
        [rect.top + 2, rect.bottom - 2].every((y) =>
          control.contains(control.ownerDocument.elementFromPoint(x, y)),
        ),
      );
    }),
  ).toBe(true);
  expect(
    await phonePane.locator(".diff-untracked").getAttribute("open"),
  ).toBeNull();
  await shoot(phone, "changes-untracked-collapsed-phone");
  await disclosure.tap();
  expect(
    await phonePane
      .locator(".diff-untracked .diff-path:visible")
      .allTextContents(),
  ).toEqual(untrackedNames);
  await phonePane.locator(".diff-base-btn").click();
  await phonePane
    .getByRole("option", { name: "Changes on this branch (default)" })
    .click();
  await phonePane
    .locator(".diff-base-btn", { hasText: "Changes since main" })
    .waitFor();
  await phone.close();
  await writeFile(join(cwd, "a.txt"), "branch line\nuncommitted line\n");
  await Bun.$`git -C ${cwd} add untracked-0.txt`.quiet();
  const reopen = async () =>
    openChanges(
      await browser.newPage({ viewport: { width: 1280, height: 844 } }),
      base,
      cid,
    );
  const totals = await reopen();
  await browserExpect(totals.locator(".diff-stat")).toHaveText(
    "2 files changed +3 −1",
  );
  await totals.page().close();
  await Bun.$`git -C ${cwd} add -A`.quiet();
  const capped = await reopen();
  await browserExpect(capped.locator(".diff-trunc")).toHaveText([
    "The diff hit the server’s size cap — some content below is partial.",
  ]);
  expect(await capped.locator(".diff-stat").count()).toBe(0);
  await capped.page().close();
  expect(errors).toEqual([]);
  await page.close();
}

export const tests: BrowserTest[] = [false, true].map(
  (mobile) =>
    // Regression: #3568 a narrow PR description wraps Markdown tables before scrolling.
    async function test_pr_diff(browser, base) {
      const context = await browser.newContext({
        viewport: { width: mobile ? 412 : 1280, height: 844 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      if (!mobile)
        await context.addInitScript(() =>
          (globalThis as any).localStorage.setItem("recurse.panesWidth", "390"),
        );
      const page = await context.newPage();
      const errors = captureErrors(page);
      const { demo } = await postFixture(base, "seed-files-pane");
      const theme = await page.request.post(`${base}api/settings/theme`, {
        data: { theme: "Solarized Dark" },
      });
      expect(theme.status()).toBe(200);
      const delivered: string[] = [];
      let contents = 0;
      const evidence =
        "Check that the activity pill shows the latest summary throughout a turn, including while a tool is running. The summary should stay visible without pushing the composer down.";
      let body =
        captured.pr.body +
        `\n| Check | Evidence |\n| --- | --- |\n| Activity | ${evidence} |\n`;
      const { body: _body, ...pr } = captured.pr;
      await page.route(`**/api/conversations/${demo}/**`, (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        if (path.endsWith("/prs"))
          return route.fulfill({ json: { prs: [pr] } });
        if (path.endsWith("/diff/candidates"))
          return route.fulfill({
            json: { branches: [], commits: [], tags: [] },
          });
        if (path.endsWith("/diff"))
          return route.fulfill({
            json: url.searchParams.get("pr")
              ? { ...captured.summary, body }
              : captured.working,
          });
        if (path.endsWith("/diff/files")) {
          if (url.searchParams.has("contents")) contents++;
          expect(url.searchParams.get("pr")).toBe(captured.pr.url);
          return route.fulfill({ json: captured.file });
        }
        if (path.endsWith("/deliver")) {
          delivered.push(JSON.parse(route.request().postData()!).content);
          return route.fulfill({ json: { steer: false } });
        }
        return route.continue();
      });
      const diffReady = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/conversations/${demo}/diff` &&
          !url.searchParams.has("pr")
        );
      });
      await page.goto(`${base}#agent=${demo}`, {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#conv-title").waitFor();
      if (mobile) {
        await diffReady;
        await page.locator("#pane-fab").tap();
        await page.locator('.pane-menu-item[data-pane="diff"]').tap();
        await page.locator(".diff-base-btn").click();
      } else {
        await page.locator('.rail-btn[data-pane="diff"]').waitFor();
        await page.locator("#input").focus();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Shift+P");
      }
      const pane = page.locator('.pane-col[data-pane="diff"]');
      const input = pane.locator(".diff-base-input");
      await input.waitFor();
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(resolve))",
      );
      expect(
        await input.evaluate(
          (element) => element === element.ownerDocument.activeElement,
        ),
      ).toBe(true);
      if (mobile) {
        const bar = pane.locator(".pane-powerbar");
        expect(await bar.locator(".pane-powerbar-overflow").isVisible()).toBe(
          false,
        );
        expect(await bar.locator(".x").isVisible()).toBe(false);
        const [inputBox, applyBox, cancelBox] = await Promise.all([
          input.boundingBox(),
          pane.locator(".diff-base-apply").boundingBox(),
          pane.locator(".diff-base-cancel").boundingBox(),
        ]);
        expect(inputBox!.width).toBeGreaterThan(
          applyBox!.width + cancelBox!.width,
        );
      }
      await input.fill("thinksum");
      const option = pane.getByRole("option", { name: /#2069/ });
      await option.waitFor();
      expect(await pane.locator(".diff-base-repo").allTextContents()).toEqual([
        "ebetica/recurse",
      ]);
      expect(await option.textContent()).toBe(
        "#2069 · " + captured.pr.title + " · merged",
      );
      if (mobile) await option.tap();
      else {
        await input.press("ArrowDown");
        await input.press("Enter");
      }
      await pane.locator(".diff-row.add").first().waitFor();
      expect(contents).toBe(0);
      const shot = async (view: string) => {
        const dir = process.env.RECURSE_SCREENSHOT_DIR;
        if (!dir) return;
        await mkdir(dir, { recursive: true });
        await page.screenshot({
          path: join(dir, `pr-${view}-${mobile ? "mobile" : "desktop"}.png`),
        });
      };
      if (process.env.RECURSE_DESCRIPTION_BASELINE)
        await shot("description-before");
      const title = pane.getByRole("heading", { name: captured.pr.title });
      await title.waitFor();
      expect(await title.locator("a").getAttribute("href")).toBe(
        captured.pr.url,
      );
      const description = pane.locator(".diff-pr-body");
      expect(await description.locator("h2").first().textContent()).toBe(
        "Summary",
      );
      await description.locator("code").first().waitFor({ state: "attached" });
      expect(await description.locator("code").count()).toBeGreaterThan(0);
      const measurement = await page.waitForFunction(
        (id) => {
          const browser = globalThis as any;
          const element = browser.document.getElementById(id);
          if (!element) return null;
          const bottom = element.getBoundingClientRect().bottom;
          const walker = browser.document.createTreeWalker(
            element,
            browser.NodeFilter.SHOW_TEXT,
          );
          const lines: Array<{ top: number; bottom: number }> = [];
          let partial = false;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const range = browser.document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (rect.height && rect.top < bottom - 0.5) {
                lines.push({ top: rect.top, bottom: rect.bottom });
                if (rect.bottom > bottom + 0.5) partial = true;
              }
            }
          }
          const bands: typeof lines = [];
          for (const rect of lines.sort((a, b) => a.top - b.top)) {
            const previous = bands.at(-1);
            if (previous && rect.top < previous.bottom) {
              previous.bottom = Math.max(previous.bottom, rect.bottom);
            } else {
              bands.push(rect);
            }
          }
          return bands.length
            ? {
                collapsed: element.clientHeight,
                full: element.scrollHeight,
                lines: bands.length,
                partial,
              }
            : null;
        },
        await description.getAttribute("id"),
      );
      const height = (await measurement.jsonValue())!;
      expect(height.lines).toBe(6);
      expect(height.partial).toBe(false);
      expect(height.full).toBeGreaterThan(height.collapsed);
      const more = pane.getByRole("button", { name: "Show more", exact: true });
      await more.waitFor();
      expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await more.locator('svg[aria-hidden="true"]').count()).toBe(1);
      await shot("description-collapsed");
      if (mobile) await more.tap();
      else {
        await more.focus();
        await more.press("Enter");
      }
      const less = pane.getByRole("button", { name: "Show less", exact: true });
      expect(await less.getAttribute("aria-expanded")).toBe("true");
      expect((await description.boundingBox())!.height).toBeGreaterThan(
        height.collapsed,
      );
      const table = description.locator(".table-scroll");
      await table.getByText(evidence, { exact: true }).waitFor();
      const { scrollWidth, clientWidth } = await table.evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      await pane.getByLabel("Changes options", { exact: true }).click();
      await pane.getByRole("button", { name: "Split", exact: true }).click();
      expect(await less.getAttribute("aria-expanded")).toBe("true");
      await title.scrollIntoViewIfNeeded();
      await shot("description-expanded");
      await less.click();
      await title.scrollIntoViewIfNeeded();
      expect(await more.getAttribute("aria-expanded")).toBe("false");
      expect(await pane.locator(".diff-base-btn").textContent()).toContain(
        "into main",
      );
      for (const mode of ["Unified", "Split"]) {
        await pane.getByLabel("Changes options", { exact: true }).click();
        await pane.getByRole("button", { name: mode, exact: true }).click();
        const patch = pane.locator(".diff-patch").first();
        const result = await patch.evaluate((element) => {
          const lines = [...element.querySelectorAll(".diff-line")];
          const line = lines.find((line) =>
            line.textContent?.includes("matchAll"),
          )!;
          const browser = globalThis as any;
          const range = browser.document.createRange();
          const walker = browser.document.createTreeWalker(
            line,
            browser.NodeFilter.SHOW_TEXT,
          );
          let last = walker.nextNode()!;
          for (let next = walker.nextNode(); next; next = walker.nextNode())
            last = next;
          range.setStart(last, last.textContent!.length - 1);
          range.setEnd(last, last.textContent!.length);
          const frame = element.getBoundingClientRect();
          const before = range.getBoundingClientRect().right;
          element.scrollLeft = element.scrollWidth;
          return {
            before,
            after: range.getBoundingClientRect().right,
            left: frame.left,
            right: frame.right,
            scrollLeft: element.scrollLeft,
            rowWidths: [
              ...element.querySelectorAll(".diff-row.add, .diff-cell.add"),
            ].map((row) => row.getBoundingClientRect().width),
          };
        });
        expect(result.before).toBeGreaterThan(result.right);
        expect(result.scrollLeft).toBeGreaterThan(0);
        expect(result.after).toBeLessThanOrEqual(result.right);
        expect(result.after).toBeGreaterThan(result.left);
        expect(new Set(result.rowWidths).size).toBe(1);
        expect(result.rowWidths[0]).toBeGreaterThan(result.right - result.left);
        await shot(mode.toLowerCase() + "-scrolled");
      }
      await pane.getByLabel("Changes options", { exact: true }).click();
      await pane.getByRole("button", { name: "Unified", exact: true }).click();
      await pane.locator(".diff-base-btn").click();
      expect(await option.textContent()).toBe(
        "#2069 · " + captured.pr.title + " · merged",
      );
      await shot("picker");
      await pane.locator(".diff-base-cancel").click();
      await pane.locator(".diff-row.add .diff-num").first().click();
      await pane.locator(".diff-line-input").fill("Check this PR change.");
      const editorFits = await pane
        .locator(".diff-line-input")
        .evaluate((input) => {
          const patch = input.closest(".diff-patch")!;
          patch.scrollLeft = patch.scrollWidth;
          const frame = patch.getBoundingClientRect();
          const editor = input.getBoundingClientRect();
          return editor.left >= frame.left && editor.right <= frame.right;
        });
      expect(editorFits).toBe(true);
      await pane.locator(".diff-sendbar-send").click();
      await page.waitForFunction(
        "document.querySelector('.diff-sendbar-label')?.textContent?.trim() === '0 comments'",
      );
      expect(delivered[0]).toContain("PR: #2069");
      expect(delivered[0]).toContain(captured.pr.url);
      await pane.locator(".diff-base-btn").click();
      await pane.getByRole("option", { name: /Working directory/ }).click();
      await pane.locator(".diff-base-btn", { hasText: "Changes" }).waitFor();
      expect(await pane.locator(".diff-pr").count()).toBe(0);
      expect(await pane.locator(".diff-file").count()).toBe(0);
      expect(await pane.locator(".diff-pr-summary").count()).toBe(0);
      body = captured.pr.body
        .split("\n")
        .find((line) => line.startsWith("- "))!
        .slice(2);
      if (mobile) {
        await pane.locator(".diff-base-btn").click();
        await pane.getByRole("option", { name: /#2069/ }).click();
      } else {
        await pane.locator(".pane-body").focus();
        await page.keyboard.press("o");
        await page.locator("#pane-finder-query").fill("changes/2069");
        expect(
          await page.locator("#pane-finder .pane-option").first().textContent(),
        ).toBe(`changes/#2069 ${captured.pr.title}`);
        await page.keyboard.press("Enter");
      }
      await page.waitForFunction(
        (expected) =>
          (globalThis as any).document
            .querySelector('.pane-col[data-pane="diff"] .diff-pr-body')
            ?.textContent.trim() === expected,
        body,
      );
      await pane.locator(".diff-pr-more").waitFor({ state: "detached" });
      expect(
        await description.evaluate(
          (element) =>
            (globalThis as any).getComputedStyle(element, "::after").content,
        ),
      ).toBe("none");
      await shot("description-short");
      if (!mobile) {
        await pane.locator(".pane-body").focus();
        await page.keyboard.press("o");
        await page.locator("#pane-finder-query").fill("file/notes");
        expect(
          await page.locator("#pane-finder .pane-option").first().textContent(),
        ).toBe("file/browser-notes.txt");
        await page.keyboard.press("Enter");
        await page
          .locator(".dv-tab", { hasText: "browser-notes.txt" })
          .waitFor();
      }
      expect(errors).toEqual([]);
      await context.close();
    },
);
tests.push(test_changes_base);
if (import.meta.main) await runBrowserTests([["pr-diff", tests]]);
