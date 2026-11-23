import { expect } from "bun:test";
import type { Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  captureErrors,
  gotoRoot,
  openPage,
  postFixture,
  rootAgentId,
  runBrowserTests,
  screenshot,
  type BrowserTest,
  waitForLayout,
} from "./common";

const commandPoll = (message: string, timeout = 15_000) => ({
  message,
  timeout,
  intervals: [50],
});
export const tests: BrowserTest[] = [
  // Regression: #3198 #3239 Side reader keys follow their desktop pane without stealing editor focus
  async function test_side_conversation_pane(browser, base) {
    const agent = "side-parent";
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const errors = captureErrors(page);
    const boots: string[] = [];
    const reads: string[] = [];
    page.on("request", (request) => {
      if (request.frame() === page.mainFrame()) return;
      if (request.isNavigationRequest()) boots.push(request.url());
      reads.push(new URL(request.url()).pathname);
    });
    await page.request.post(
      `${base}__browser-test/seed-model-selection-error`,
      { data: { agent, model: "fauxordinary/faux-1" } },
    );
    const drafts = Array.from(
      { length: 50 },
      (_, n) => `Draft ${String(n).padStart(2, "0")}`,
    );
    const {
      ids: [, releaseNotes],
    } = await postFixture(base, "seed-named-artifacts", {
      agent,
      titles: ["Quarterly chart", "Release notes", ...drafts],
    });
    await page.goto(`${base}#agent=${agent}`);
    const input = page.locator("#input:enabled");
    await input.fill(
      "Reply only Parent ready. " +
        "This answer is long enough to scroll under the pane header. ".repeat(
          40,
        ),
    );
    await input.press("Enter");
    await page
      .locator(".msg.assistant .content", { hasText: "Parent ready" })
      .waitFor();
    await page
      .getByRole("button", { name: /^View activity token usage:/ })
      .waitFor();
    await input.fill("/renam");
    await page.getByRole("option", { name: /^\/rename / }).click();
    expect(await input.inputValue()).toBe("/rename ");
    await input.press("Enter");
    await page
      .locator("#send-status", { hasText: "Usage: /rename <title>" })
      .waitFor();
    await input.fill("/rename  Parent renamed ");
    await input.press("Enter");
    await page.locator("#conv-title", { hasText: "Parent renamed" }).waitFor();
    await page
      .locator(`#agent-list .agent[data-id="${agent}"] .title`, {
        hasText: "Parent renamed",
      })
      .waitFor();
    expect(await input.inputValue()).toBe("");
    const renamed = (await (
      await page.request.get(`${base}api/tree`)
    ).json()) as {
      id: string;
      title: string;
    }[];
    expect(renamed.find((row) => row.id === agent)?.title).toBe(
      "Parent renamed",
    );
    expect(
      await page.locator(".msg.user", { hasText: "/rename" }).count(),
    ).toBe(0);
    if (process.env.RECURSE_BROWSER_SCREENSHOT_DIR) {
      await screenshot(page, "platform-commands/rename-1280");
      await page.setViewportSize({ width: 412, height: 915 });
      await screenshot(page, "platform-commands/rename-412");
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await input.fill("/btw Reply only Side answer");
    await input.press("Enter");
    const pane = page.locator('.pane-col[data-pane="side"]');
    const frames = page.locator("iframe.side-frame");
    const side = page.frameLocator("iframe.side-frame");
    await side
      .locator(".msg.assistant .content", { hasText: "Side answer" })
      .waitFor();
    const parentReply = side.locator(".msg.assistant .content", {
      hasText: "Parent ready",
    });
    await parentReply.waitFor();
    expect(await parentReply.count()).toBe(1);
    expect(await side.locator("#sidebar").isVisible()).toBe(false);
    expect(await frames.count()).toBe(1);
    expect(boots).toHaveLength(1);
    const first = (await frames.getAttribute("data-side"))!;
    expect(
      await page.locator(`#agent-list .agent[data-id="${first}"]`).count(),
    ).toBe(0);
    await side
      .locator("#scroll")
      .evaluate((node) => (node.scrollTop = node.scrollHeight / 3));
    await screenshot(page, "platform-commands/side-pane-1280");

    const focusSide = () => parentReply.click();
    const windowBox = async (id: string) =>
      (await page
        .locator(`#dock .dv-tab[data-dock-panel="${id}"]`)
        .locator("xpath=ancestor::div[contains(@class, 'dv-groupview')]")
        .boundingBox())!;
    const sideWindow = () => windowBox("side");
    const windowKeys = async (prefix: string, key: string) => {
      await page.keyboard.press(prefix);
      await page.keyboard.press(key);
      await waitForLayout(page);
    };
    const reopenSide = async () => {
      await page.locator('.rail-btn[data-pane="side"]').click();
      await pane.waitFor();
      await parentReply.waitFor();
      await focusSide();
    };
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("z");
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    await focusSide();
    await page.keyboard.press("z");
    expect(await pane.getAttribute("class")).not.toContain("fullscreen");
    await windowKeys("w", "f");
    expect(await pane.getAttribute("role")).toBe("region");
    expect(await pane.getAttribute("aria-modal")).toBeNull();
    await focusSide();
    await windowKeys("w", "f");
    expect(await pane.getAttribute("class")).not.toContain("fullscreen");
    await focusSide();
    await windowKeys("g", "h");
    expect(
      await page
        .locator("#scroll")
        .evaluate((node) => node === node.ownerDocument.activeElement),
    ).toBeTrue();
    await windowKeys("g", "p");
    await focusSide();
    await windowKeys("w", "e");
    await focusSide();
    await windowKeys("w", "Shift+K");
    expect((await sideWindow()).y).toBeLessThan((await windowBox("chat")).y);
    await focusSide();
    await windowKeys("w", "Shift+J");
    expect((await sideWindow()).y).toBeGreaterThan((await windowBox("chat")).y);
    await focusSide();
    await windowKeys("w", "e");
    await focusSide();
    await windowKeys("w", "Shift+H");
    expect((await sideWindow()).x).toBeLessThan((await windowBox("chat")).x);
    await focusSide();
    await windowKeys("w", "Shift+L");
    expect((await sideWindow()).x).toBeGreaterThan((await windowBox("chat")).x);
    await focusSide();
    await windowKeys("w", "r");
    const wide = (await sideWindow()).width;
    await page.keyboard.press("h");
    await waitForLayout(page);
    expect((await sideWindow()).width).toBeLessThan(wide);
    await page.keyboard.press("Escape");
    await focusSide();
    await page.keyboard.press("o");
    await page.locator("[data-pane-finder] input").waitFor();
    await page.keyboard.press("Escape");
    await focusSide();
    await windowKeys("g", "g");
    expect(
      await side.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBe(0);
    await page.keyboard.press("j");
    const down = await side
      .locator("#scroll")
      .evaluate((node) => node.scrollTop);
    expect(down).toBeGreaterThan(0);
    await page.keyboard.press("k");
    expect(
      await side.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBeLessThan(down);
    await page.keyboard.press("Shift+G");
    expect(
      await side.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBeGreaterThan(down);
    await focusSide();
    await page.keyboard.press("z");
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    await focusSide();
    await page.keyboard.press("i");
    expect(await pane.getAttribute("class")).not.toContain("fullscreen");
    expect(
      await input.evaluate((node) => node === node.ownerDocument.activeElement),
    ).toBeTrue();
    await input.click();
    await page.keyboard.type("Parent draft from Side keys");
    expect(await input.inputValue()).toBe("Parent draft from Side keys");
    await input.fill("");
    const sideDraft = "z q wq wQ gh gp we wH wJ wK wL o j k gg G i";
    await focusSide();
    await page.keyboard.press("z");
    await side.locator("#input").click();
    await page.keyboard.type(sideDraft);
    expect(await side.locator("#input").inputValue()).toBe(sideDraft);
    expect(await pane.getAttribute("class")).toContain("fullscreen");
    await side.locator("button:visible:enabled").first().focus();
    await page.keyboard.press("z");
    expect(await pane.getAttribute("class")).not.toContain("fullscreen");
    await focusSide();
    await page.keyboard.press("i");
    expect(await pane.isVisible()).toBeTrue();
    expect(await side.locator("#input").inputValue()).toBe(sideDraft);
    expect(
      await input.evaluate((node) => node === node.ownerDocument.activeElement),
    ).toBeTrue();
    await focusSide();
    await page.keyboard.press("q");
    await pane.waitFor({ state: "detached" });
    await reopenSide();
    expect(await side.locator("#input").inputValue()).toBe(sideDraft);
    await windowKeys("w", "q");
    await pane.waitFor({ state: "detached" });
    await reopenSide();
    await windowKeys("w", "Shift+Q");
    expect(await page.locator(".pane-col").count()).toBe(0);
    expect(
      await page
        .locator('#dock .dock-panel[data-dock-panel="chat"]')
        .isVisible(),
    ).toBeTrue();
    await reopenSide();
    expect(await side.locator("#input").inputValue()).toBe(sideDraft);
    await side.locator("#input").fill("");

    await side.locator("#input").click();
    for (const key of ["Escape", "Escape", "j", "d", "d"])
      await page.keyboard.press(key);
    expect(await pane.isVisible()).toBe(true);
    expect(new URL(page.url()).hash).toBe(`#agent=${agent}`);
    expect(await side.locator("#input").inputValue()).toBe("");

    await pane.getByRole("button", { name: "New side conversation" }).click();
    await page
      .locator(`iframe.side-frame:not([data-side="${first}"])`)
      .waitFor();
    expect(await frames.count()).toBe(1);
    const second = page.frameLocator("iframe.side-frame");
    await second
      .locator(".msg.assistant .content", { hasText: /^\s*Side answer\s*$/ })
      .waitFor({ state: "detached" });
    const { title } = await postFixture(base, "seed-conversation-title");
    await second.locator("#input").fill("Reply only Second side answer");
    await second.locator("#input").press("Enter");
    await second
      .locator(".msg.assistant .content", { hasText: "Second side answer" })
      .waitFor();
    const picked = pane.locator("#side-picker option:checked");
    await picked.filter({ hasText: title }).waitFor({ state: "attached" });
    await pane
      .getByRole("button", { name: "Rename side conversation" })
      .click();
    const name = pane.getByRole("textbox", { name: "Side conversation name" });
    expect(await name.inputValue()).toBe(title);
    await name.fill("Renamed side");
    await name.press("Enter");
    await picked
      .filter({ hasText: "Renamed side" })
      .waitFor({ state: "attached" });
    const secondId = await frames.getAttribute("data-side");
    expect(boots).toHaveLength(1);
    const tree = (await (await page.request.get(`${base}api/tree`)).json()) as {
      id: string;
      title: string;
    }[];
    expect(tree.find((row) => row.id === secondId)?.title).toBe("Renamed side");
    await second.locator("#input").fill("Keep this side draft");
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    expect(
      await second.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBe(0);
    await page.setViewportSize({ width: 1280, height: 801 });
    await second.locator("#scroll").evaluate(
      (node) =>
        new Promise<void>((resolve) => {
          const browser = globalThis as any;
          const observer = new browser.ResizeObserver(() => {
            observer.disconnect();
            browser.requestAnimationFrame(() => resolve());
          });
          observer.observe(node);
        }),
    );
    expect(
      await second.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBe(0);
    await page.keyboard.press("j");
    expect(
      await second.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBeGreaterThan(0);
    await page.keyboard.press("d");
    expect(await frames.getAttribute("data-side")).toBe(secondId);
    await page.keyboard.press("Shift+G");
    const bottom = await second
      .locator("#scroll")
      .evaluate((node) => node.scrollTop);
    await page.keyboard.press("u");
    expect(
      await second.locator("#scroll").evaluate((node) => node.scrollTop),
    ).toBeLessThan(bottom);
    await page.keyboard.press("h");
    await pane.locator(".side-filter").waitFor();
    expect(await frames.isVisible()).toBeFalse();
    expect(await frames.count()).toBe(1);
    const ids = await pane
      .locator(".side-list-item")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-side")),
      );
    const cursor = pane.locator(".pane-item-cursor");
    expect(await cursor.getAttribute("data-side")).toBe(secondId);
    await page.keyboard.press("Shift+G");
    expect(await cursor.getAttribute("data-side")).toBe(ids.at(-1)!);
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    expect(await cursor.getAttribute("data-side")).toBe(ids[0]);
    await page.keyboard.press("j");
    expect(await cursor.getAttribute("data-side")).toBe(ids[1]);
    await page.keyboard.press("k");
    expect(await cursor.getAttribute("data-side")).toBe(ids[0]);
    await page.keyboard.press("/");
    const filter = pane.getByRole("searchbox", {
      name: "Filter side conversations",
    });
    await filter.fill("RENAMED");
    expect(await pane.locator(".side-list-item").count()).toBe(1);
    await filter.press("j");
    await pane
      .getByText("No side conversations match.", { exact: true })
      .waitFor();
    await filter.fill("RENAMED");
    await filter.press("Enter");
    await frames.waitFor({ state: "visible" });
    expect(await second.locator("#input").inputValue()).toBe(
      "Keep this side draft",
    );
    expect(boots).toHaveLength(1);
    const options = await pane
      .locator("#side-picker option")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("value")));
    const towardFirst = options.indexOf(secondId!) === 0 ? "]" : "[";
    await page.keyboard.press(towardFirst);
    await page.locator(`iframe.side-frame[data-side="${first}"]`).waitFor();
    await side
      .locator(".msg.assistant .content", { hasText: /^\s*Side answer\s*$/ })
      .waitFor();
    await page.keyboard.press(towardFirst === "]" ? "[" : "]");
    await page.locator(`iframe.side-frame[data-side="${secondId}"]`).waitFor();
    await second
      .locator(".msg.assistant .content", { hasText: "Second side answer" })
      .waitFor();
    await pane.getByRole("button", { name: "All side conversations" }).click();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.keyboard.press("y");
    await pane.getByText("Link copied.", { exact: true }).waitFor();
    const copied = await page.evaluate(() =>
      (globalThis as any).navigator.clipboard.readText(),
    );
    expect(new URL(copied).hash).toBe(`#agent=${secondId}`);
    expect(new URL(copied).searchParams.has("embed")).toBeFalse();
    await screenshot(page, "platform-commands/side-keys-1280");
    await page.context().clearPermissions();
    await page.context().grantPermissions([]);
    await page.evaluate(() => {
      const browser = globalThis as any;
      browser.__sideCopied = false;
      browser.document.addEventListener(
        "copy",
        () =>
          browser.requestAnimationFrame(() => {
            browser.__sideCopied = true;
          }),
        { once: true },
      );
    });
    expect(
      await page.evaluate(
        async () =>
          (
            await (globalThis as any).navigator.permissions.query({
              name: "clipboard-write",
            })
          ).state,
      ),
    ).toBe("denied");
    await page.keyboard.press("y");
    await page.waitForFunction(() => (globalThis as any).__sideCopied);
    expect(
      await cursor.evaluate(
        (node) => node === node.ownerDocument.activeElement,
      ),
    ).toBeTrue();
    await page.keyboard.press("l");
    await frames.waitFor({ state: "visible" });
    expect(await second.locator("#input").inputValue()).toBe(
      "Keep this side draft",
    );
    await second.locator("#input").fill("");
    expect(
      (
        await page.request.post(`${base}api/conversations/${first}/rename`, {
          data: { title: "Pricing questions" },
        })
      ).ok(),
    ).toBe(true);
    await pane
      .locator(`#side-picker option[value="${first}"]`, {
        hasText: "Pricing questions",
      })
      .waitFor({ state: "attached" });
    const finderQuery = page.locator("#pane-finder-query");
    const finderOptions = page.locator("#pane-finder .pane-option");
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("o");
    await finderQuery.fill("pricing");
    expect(await finderOptions.first().textContent()).toBe(
      "sidechat/Pricing questions",
    );
    await screenshot(page, "platform-commands/finder-side-1280");
    await page.keyboard.press("Enter");
    await page.locator(`iframe.side-frame[data-side="${first}"]`).waitFor();
    expect(await frames.count()).toBe(1);
    let releaseDelete!: () => void;
    const deleteHeld = new Promise<void>(
      (resolve) => (releaseDelete = resolve),
    );
    await page.route(`${base}api/conversations/${first}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await deleteHeld;
      await route.continue();
    });
    await pane
      .getByRole("button", { name: "Delete side conversation" })
      .click();
    try {
      await page
        .locator(`iframe.side-frame:not([data-side="${first}"])`)
        .waitFor();
      await pane
        .locator(`#side-picker option[value="${first}"]`)
        .waitFor({ state: "detached" });
      const renamed = await page.request.post(
        `${base}api/conversations/${agent}/rename`,
        { data: { title: "Parent renamed while deleting" } },
      );
      expect(renamed.ok()).toBe(true);
      await page
        .locator(`#agent-list .agent[data-id="${agent}"] .title`)
        .filter({ hasText: "Parent renamed while deleting" })
        .waitFor();
      expect(
        await pane.locator(`#side-picker option[value="${first}"]`).count(),
      ).toBe(0);
      expect(await frames.count()).toBe(1);
    } finally {
      releaseDelete();
    }
    await pane.locator(".side-delete:enabled").waitFor();
    await page
      .getByRole("button", { name: "Close Side conversations", exact: true })
      .click();
    await pane.waitFor({ state: "detached" });
    expect(
      await page.locator("#side-frame-parking iframe.side-frame").count(),
    ).toBe(1);
    reads.length = 0;
    for (let tick = 0; tick < 2; tick++)
      await page.waitForRequest(
        (request) =>
          request.frame() === page.mainFrame() &&
          new URL(request.url()).pathname === "/api/tree",
      );
    expect(reads).not.toContain("/api/tree");
    reads.length = 0;
    await page.locator('.rail-btn[data-pane="side"]').click();
    await pane.locator("iframe.side-frame").waitFor();
    await side
      .locator(".msg.assistant .content", { hasText: "Second side answer" })
      .waitFor();
    expect(boots).toHaveLength(1);
    await pane.locator(".pane-body").focus();
    await page.keyboard.press("o");
    await finderQuery.fill("artifact/");
    expect(await finderOptions.count()).toBe(50);
    expect(await finderOptions.locator(".agent-option-relation").count()).toBe(
      0,
    );
    await screenshot(page, "platform-commands/finder-artifact-1280");
    for (const title of [...drafts, "Quarterly chart", "Release notes"]) {
      await finderQuery.fill(`artifact/${title}`);
      expect(await finderOptions.allTextContents()).toEqual([
        `artifact/${title}`,
      ]);
    }
    await finderQuery.fill("artifact/rel");
    await page.keyboard.press("Enter");
    await page
      .locator(".report-doc", { hasText: "Release notes body." })
      .waitFor();
    expect(await page.locator("#artifact-picker").inputValue()).toBe(
      releaseNotes,
    );
    expect(errors).toEqual([]);
    await page.close();

    const phone = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    await phone.goto(`${base}#agent=${agent}`);
    await phone.locator("#pane-fab").tap();
    await phone.locator('.pane-menu-item[data-pane="side"]').tap();
    const phoneSide = phone.frameLocator("iframe.side-frame");
    await phoneSide
      .locator(".msg.assistant .content", { hasText: "Second side answer" })
      .waitFor();
    expect(await phoneSide.locator("#input").isVisible()).toBeTrue();
    expect(await phone.locator(".side-list").isVisible()).toBeFalse();
    expect(await phone.locator(".side-browse-btn").isVisible()).toBeFalse();
    expect(await phoneSide.locator("#menu-btn").isVisible()).toBeFalse();
    expect(await phoneSide.locator("#pane-fab").isVisible()).toBeFalse();
    await phoneSide
      .locator("#scroll")
      .evaluate((node) => (node.scrollTop = node.scrollHeight / 3));
    const bar = phone.locator('.pane-col[data-pane="side"] .pane-powerbar');
    for (const box of await bar
      .locator("select, button")
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node.getClientRects().length)
          .map((node) => node.getBoundingClientRect().toJSON()),
      )) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(412);
    }
    await screenshot(phone, "platform-commands/side-pane-412");
    await phone.close();

    const promoting = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const promoteErrors = captureErrors(promoting);
    await promoting.goto(`${base}#agent=${agent}`);
    await promoting.locator('.rail-btn[data-pane="side"]').click();
    const promotePane = promoting.locator('.pane-col[data-pane="side"]');
    await promoting
      .frameLocator("iframe.side-frame")
      .locator(".msg.assistant .content", { hasText: "Second side answer" })
      .waitFor();
    await promotePane
      .getByRole("button", { name: "Promote to subagent" })
      .click();
    await promoting
      .locator(`#agent-list .agent[data-id="${secondId}"]`)
      .waitFor();
    await promoting
      .locator(`#side-picker option[value="${secondId}"]`)
      .waitFor({ state: "detached" });
    const promotedTree = (await (
      await promoting.request.get(`${base}api/tree`)
    ).json()) as { id: string; parent: string | null; side_of?: string }[];
    expect(promotedTree.find((row) => row.id === secondId)).toMatchObject({
      parent: agent,
    });
    expect(promoteErrors).toEqual([]);
    await promoting.close();
  },
  async function test_platform_commands_keyboard_touch_and_confirmation(
    browser,
    base,
  ) {
    for (const [name, viewport, touch] of [
      ["phone", { width: 390, height: 844 }, true],
      ["desktop", { width: 1280, height: 800 }, false],
    ] as const) {
      const { context, page, errors } = await openPage(browser, {
        viewport,
        touch,
      });
      const cid = rootAgentId();
      const skillsUrl = `${base}api/conversations/${cid}/skills`;
      const registry = await page.request.get(skillsUrl);
      expect(registry.status()).toBe(200);
      const { context: skillContext } = (await registry.json()) as {
        context: string;
      };
      const etag = registry.headers().etag!;
      const unchanged = await page.request.get(skillsUrl, {
        headers: { "if-none-match": etag },
      });
      expect(unchanged.status()).toBe(304);
      expect(unchanged.headers()["x-recurse-skill-context"]).toBe(skillContext);
      const heldSkills = Promise.withResolvers<Route>();
      await page.route(skillsUrl, (route) => heldSkills.resolve(route));
      await page.route(base + "api/tree", (route) =>
        route.fulfill({
          json: [
            {
              id: cid,
              parent: null,
              title: "Coordinator",
              kind: null,
              skill_context: skillContext,
              status: "idle",
              updated: 2,
              children: 0,
              queued: 0,
              preview: "",
              muted: false,
              safety_off: false,
            },
          ],
        }),
      );
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      const composer = page.locator("#input");
      await composer.fill("/");
      const skillsRequest = await heldSkills.promise;
      const skillMenu = page.locator("#skill-menu");
      await browserExpect(skillMenu).not.toContainText(/Loading|Searching/);
      await composer.press("ArrowDown");
      const selectedCommand = skillMenu
        .getByRole("option")
        .filter({ hasText: "/clear" });
      await browserExpect(selectedCommand).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await composer.fill("/c");
      await browserExpect(selectedCommand).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await browserExpect(skillMenu).not.toContainText(/Loading|Searching/);
      await skillsRequest.fulfill({
        json: {
          context: skillContext,
          skills: [{ name: "compact-notes", description: "Compact notes" }],
        },
      });
      await skillMenu.locator(".skill-option:not(.action)").waitFor();
      await browserExpect(selectedCommand).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await composer.fill("/compact");
      const compact = page.locator("#skill-menu .skill-option.action", {
        hasText: "/compact",
      });
      await compact.waitFor();
      const compactResponse = page.waitForResponse(
        `${base}api/conversations/${cid}/compact`,
      );
      if (name === "phone") await compact.click();
      else {
        await composer.press("Escape");
        await composer.press("Enter");
      }
      await compactResponse;
      await page.waitForFunction(
        "document.querySelector('#input')?.value === ''",
      );
      await page.evaluate(
        "(() => { const status=document.querySelector('#send-status'); window.__statuses=[status?.textContent]; new MutationObserver(()=>window.__statuses.push(status?.textContent)).observe(status,{childList:true,subtree:true,characterData:true}); })()",
      );
      await composer.fill("/skill:compact");
      await page.waitForFunction(
        "document.querySelector('#input')?.value === '/skill:compact' && !document.querySelector('#skill-menu .skill-option.action')",
      );
      expect(
        await page.locator("#skill-menu .skill-option.action").count(),
      ).toBe(0);
      await composer.fill("/clear");
      const clear = page.locator("#skill-menu .skill-option.action", {
        hasText: "/clear",
      });
      await clear.waitFor();
      const prompts: string[] = [];
      page.once("dialog", (dialog) => {
        prompts.push(dialog.message());
        void dialog.dismiss();
      });
      await clear.click();
      expect(await composer.inputValue()).toBe("/clear");
      expect(
        prompts.length > 0 && prompts[0].includes("will no longer be shown"),
      ).toBeTrue();
      await composer.focus();
      await clear.waitFor();
      page.once("dialog", (dialog) => void dialog.accept());
      const clearResponse = page.waitForResponse(
        `${base}api/conversations/${cid}/clear`,
      );
      await clear.click();
      expect((await clearResponse).ok()).toBeTrue();
      await page.waitForFunction(
        "document.querySelector('#input')?.value === ''",
      );
      expect(
        (
          await page.request.post(base + "__browser-test/seed-stale-thread")
        ).ok(),
      ).toBeTrue();
      const seeded = await page.request.get(
        base + `api/conversations/${cid}/view`,
      );
      expect(
        seeded.ok() && (await seeded.text()).includes("STALE CLEARED ROW"),
      ).toBeTrue();
      await page.unroute(base + "api/tree");
      await page.reload({ waitUntil: "domcontentloaded" });
      const stale = page.locator(".msg", { hasText: "STALE CLEARED ROW" });
      await browserExpect
        .poll(
          () => stale.count(),
          commandPoll(`${name} stale row after external session replacement`),
        )
        .toBe(1);
      expect(
        await page.locator('.msg.user .bubble a[download="stale.txt"]').count(),
      ).toBe(1);
      expect(
        (
          await page.request.post(base + "__browser-test/synchronous-clear")
        ).ok(),
      ).toBeTrue();
      await stale.waitFor({ state: "detached", timeout: 15_000 });
      expect(
        await page.locator('.msg.user .bubble a[download="stale.txt"]').count(),
      ).toBe(0);
      expect(await page.locator(".agent").first().getAttribute("data-id")).toBe(
        cid,
      );
      expect(errors).toEqual([]);
      await context.close();
    }
  },
  async function test_revive_finder_keyboard_and_touch(browser, base) {
    const cid = rootAgentId();
    const rows = [
      {
        archive_id: "oldtop.20261011-a",
        cid: "oldtop",
        reason: "reap",
        title: "Release notes writer",
        parent: null,
        parent_title: null,
        top_level: true,
        archived: Date.now() / 1000 - 3 * 3600,
        workdir: "/gone",
      },
      {
        archive_id: "oldkid.clear-1a2b",
        cid: "oldkid",
        reason: "clear",
        title: "Leaf reviewer",
        parent: "oldtop",
        parent_title: "Release notes writer",
        top_level: false,
        archived: Date.now() / 1000 - 2 * 86400,
        workdir: null,
      },
    ];
    for (const [name, viewport, mobile] of [
      ["phone", { width: 390, height: 844 }, true],
      ["desktop", { width: 1280, height: 800 }, false],
    ] as const) {
      const { context, page, errors } = await openPage(browser, {
        viewport,
        touch: mobile,
      });
      const queries: string[] = [];
      const held = new Map<
        string,
        ReturnType<typeof Promise.withResolvers<Route>>
      >();
      await page.route(`${base}api/agent-archive?*`, (route) => {
        const q = new URL(route.request().url()).searchParams.get("q") ?? "";
        queries.push(q);
        const pending = held.get(q);
        if (pending) {
          pending.resolve(route);
          return;
        }
        const agents = rows.filter((row) =>
          q ? row.title.toLowerCase().includes(q) : true,
        );
        return route.fulfill({ json: { agents, next_offset: null } });
      });
      const revived: unknown[] = [];
      await page.route(`${base}api/agent-archive/revive`, (route) => {
        revived.push(route.request().postDataJSON());
        return route.fulfill({
          json: { id: cid, title: "Coordinator", notes: [] },
        });
      });
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      const composer = page.locator("#input");
      await composer.fill("/revive");
      const action = page.locator("#skill-menu .skill-option.action", {
        hasText: "/revive",
      });
      await action.waitFor();
      if (mobile) await action.click();
      else {
        await composer.press("Escape");
        await composer.press("Enter");
      }
      const finder = page.locator("#agent-finder.on.revive");
      await finder.waitFor();
      expect(await composer.inputValue()).toBe("");
      const options = page.locator("#agent-menu .agent-option");
      await browserExpect
        .poll(() => options.count(), commandPoll(name))
        .toBe(2);
      expect(
        await page
          .locator("#agent-menu .agent-option-group-label")
          .allTextContents(),
      ).toEqual(["Top-level agents", "Subagents"]);
      expect(await options.nth(0).textContent()).toContain("deleted 3h ago");
      expect(await options.nth(1).textContent()).toContain(
        "Leaf reviewer (before clear)",
      );
      expect(await options.nth(1).textContent()).toContain(
        "subagent of Release notes writer",
      );
      await screenshot(page, `platform-commands/revive-${name}`);
      const query = page.locator("#agent-finder-query");
      expect(
        (await page.evaluate("document.activeElement?.id")) ===
          "agent-finder-query",
      ).toBe(true);
      await query.press("ArrowDown");
      const selected = options.nth(1);
      await browserExpect(selected).toHaveAttribute("aria-selected", "true");
      for (const text of ["leaf", "release"])
        held.set(text, Promise.withResolvers<Route>());
      await query.fill("leaf");
      const older = await held.get("leaf")!.promise;
      await browserExpect(options).toHaveCount(2);
      await browserExpect(selected).toHaveAttribute("aria-selected", "true");
      await browserExpect(page.locator("#agent-finder-status")).not.toHaveText(
        /Searching|Loading/,
      );
      await older.fulfill({ json: { agents: [rows[1]], next_offset: null } });
      await browserExpect(options).toHaveCount(1);
      await browserExpect(options.first()).toContainText("Leaf reviewer");
      await query.fill("release");
      const stale = await held.get("release")!.promise;
      await browserExpect(options.first()).toContainText("Leaf reviewer");
      await screenshot(page, `platform-commands/archive-${name}`);
      held.delete("leaf");
      await query.fill("leaf");
      await page.waitForResponse(
        (response) => new URL(response.url()).searchParams.get("q") === "leaf",
      );
      const finished = page.waitForEvent("requestfinished", {
        predicate: (request) => request === stale.request(),
      });
      await stale.fulfill({ json: { agents: [rows[0]], next_offset: null } });
      await finished;
      await browserExpect(options.first()).toContainText("Leaf reviewer");
      await query.fill("absent");
      await browserExpect(options).toHaveCount(0);
      await browserExpect(page.locator("#agent-finder-status")).toHaveText(
        "No matching archived agents",
      );
      held.set("leaf", Promise.withResolvers<Route>());
      await query.fill("leaf");
      const afterEmpty = await held.get("leaf")!.promise;
      await screenshot(page, `platform-commands/archive-empty-${name}`);
      await browserExpect(page.locator("#agent-finder-status")).not.toHaveText(
        /Searching|Loading/,
      );
      await afterEmpty.fulfill({
        json: { agents: [rows[1]], next_offset: null },
      });
      await browserExpect
        .poll(() => options.count(), commandPoll(`${name} query`))
        .toBe(1);
      expect(queries.at(-1)).toBe("leaf");
      if (mobile) await options.first().tap();
      else await query.press("Enter");
      await finder.waitFor({ state: "detached" });
      expect(revived).toEqual([{ target: "oldkid.clear-1a2b", parent: null }]);
      await page
        .locator("#send-status", { hasText: "Revived Coordinator." })
        .waitFor();
      if (!mobile) {
        await composer.fill("/revive");
        await composer.press("Escape");
        await composer.press("Enter");
        await finder.waitFor();
        await query.press("Escape");
        await finder.waitFor({ state: "detached" });
        expect(
          (await page.evaluate("document.activeElement?.id")) === "input",
        ).toBe(true);
      }
      expect(errors).toEqual([]);
      await context.close();
    }
  },
  // Regression: #3481 the held-read wait no longer times the scrolls too
  async function test_clear_drops_rendered_thread_and_stale_reads(
    browser,
    base,
  ) {
    const cid = rootAgentId();
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    await gotoRoot(page, base);
    await page.locator(".agent").first().waitFor();
    expect(
      (
        await page.request.post(base + "__browser-test/seed-context-viewer")
      ).ok(),
    ).toBeTrue();
    const other = page.locator('.agent[data-id="context-other"]');
    const root = page.locator(`.agent[data-id="${cid}"]`);
    const viewUrl = `${base}api/conversations/${cid}/view`;
    let viewMode = "pass";
    let clearMode = "pass";
    const stalled: Route[] = [];
    await page.route(`${viewUrl}*`, (route) => {
      if (viewMode === "abort") return route.abort();
      if (viewMode === "stall") {
        stalled.push(route);
        return;
      }
      return route.continue();
    });
    await page.route(`${base}api/conversations/${cid}/clear`, (route) => {
      if (clearMode === "fail")
        return route.fulfill({ status: 500, json: { error: "clear failed" } });
      if (clearMode === "queued")
        return route.fulfill({
          status: 200,
          json: { id: cid, action: "clear", queued: true },
        });
      return route.continue();
    });
    const staleRow = (marker: string) =>
      page.locator(".msg", { hasText: marker });
    const clear = async () => {
      await page.locator("#input").fill("/clear");
      const action = page.locator("#skill-menu .skill-option.action", {
        hasText: "/clear",
      });
      await action.waitFor();
      page.once("dialog", (dialog) => void dialog.accept());
      const response = page.waitForResponse(
        `${base}api/conversations/${cid}/clear`,
      );
      await action.click();
      const completed = await response;
      await completed.finished();
      return completed;
    };
    const seedSnapshot = async (
      endpoint: string,
      label: string,
      many = false,
    ): Promise<string> => {
      let marker = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await page.request.post(base + endpoint);
        expect(response.ok(), endpoint).toBeTrue();
        marker = ((await response.json()) as { marker: string }).marker;
        const view = (await (await page.request.get(viewUrl)).json()) as {
          blocks?: Array<{ text?: string }>;
        };
        if (
          (view.blocks ?? []).some((block) =>
            (block.text ?? "").includes(marker),
          )
        ) {
          await other.click();
          await root.click();
          try {
            await browserExpect
              .poll(() => staleRow(marker).count(), commandPoll(label, 8_000))
              .toBe(1);
            if (many)
              await browserExpect
                .poll(
                  () => page.locator(".msg").count(),
                  commandPoll(`${label} (full snapshot)`, 8_000),
                )
                .toBeGreaterThanOrEqual(50);
            return marker;
          } catch {}
        }
      }
      throw new Error(`snapshot never rebuilt: ${label}`);
    };
    const bulk = await seedSnapshot(
      "__browser-test/seed-bulk-thread",
      "bulk",
      true,
    );
    viewMode = "abort";
    expect((await clear()).ok()).toBeTrue();
    await browserExpect
      .poll(
        () => staleRow(bulk).count(),
        commandPoll("cleared rows gone", 8_000),
      )
      .toBe(0);
    expect(await staleRow(bulk).count()).toBe(0);
    viewMode = "pass";
    const eventsResponse = page.waitForResponse(
      `${base}api/conversations/${cid}/events?*`,
    );
    const focusedRead = page.waitForResponse(
      (r) =>
        r.url().startsWith(`${base}api/conversations/${cid}?`) &&
        r.url().includes("focused=1"),
    );
    await other.click();
    await root.click();
    expect((await eventsResponse).ok()).toBeTrue();
    await (await focusedRead).finished();
    expect(await staleRow(bulk).count()).toBe(0);
    const small = await seedSnapshot(
      "__browser-test/seed-stale-thread",
      "small",
    );
    clearMode = "fail";
    expect((await clear()).ok()).toBeFalse();
    expect(await staleRow(small).count()).toBe(1);
    clearMode = "queued";
    expect((await clear()).ok()).toBeTrue();
    expect(await staleRow(small).count()).toBe(1);
    clearMode = "pass";
    const race = await seedSnapshot(
      "__browser-test/seed-bulk-thread",
      "race",
      true,
    );
    viewMode = "stall";
    await page.evaluate(
      "document.querySelector('#scroll').scrollTop = document.querySelector('#scroll').scrollHeight",
    );
    await browserExpect
      .poll(
        () => page.evaluate("document.querySelector('#scroll').scrollTop"),
        commandPoll("scrolled to bottom"),
      )
      .toBeGreaterThan(1000);
    await page.evaluate("document.querySelector('#scroll').scrollTop = 0");
    await browserExpect
      .poll(
        () => page.evaluate("document.querySelector('#scroll').scrollTop"),
        commandPoll("scrolled to top"),
      )
      .toBeLessThan(300);
    await browserExpect
      .poll(() => stalled.length, commandPoll("held view read"))
      .toBeGreaterThan(0);
    const oldPage = await (await page.request.get(viewUrl)).json();
    const predrop = [...stalled];
    expect(predrop.length).toBeGreaterThan(0);
    expect((await clear()).ok()).toBeTrue();
    await browserExpect
      .poll(
        () => staleRow(race).count(),
        commandPoll("race cleared before stale response", 8_000),
      )
      .toBe(0);
    for (const route of predrop)
      await route.fulfill({ status: 200, json: oldPage });
    stalled.splice(0, predrop.length);
    await Promise.all(
      predrop.map(async (route) => {
        const response = await route.request().response();
        if (response) await response.finished();
      }),
    );
    expect(await staleRow(race).count()).toBe(0);
    for (const route of stalled) await route.abort();
    stalled.length = 0;
    const refreshedRead = page.waitForResponse(
      (r) =>
        r.url().startsWith(`${base}api/conversations/${cid}?`) &&
        r.url().includes("focused=1"),
    );
    viewMode = "pass";
    await (await refreshedRead).finished();
    expect(await staleRow(race).count()).toBe(0);
    expect(
      (await page.request.post(base + "__browser-test/synchronous-clear")).ok(),
    ).toBeTrue();
    expect(errors).toEqual([]);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["platform-commands", tests]]);
