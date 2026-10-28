import { expect } from "bun:test";
import { EventEmitter, once } from "node:events";
import { join } from "node:path";
import type { Page, Route } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  mockConversation,
  postFixture,
  rootAgentId,
  runBrowserTests,
  type BrowserTest,
} from "./common";

async function waitValue(
  page: Page,
  read: () => Promise<number> | number,
  ok: (value: number) => boolean,
  label: string,
  seconds = 15,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let value = await read();
  while (!ok(value) && Date.now() < deadline) {
    // test-check-allow: T6 Deadline-bounded polling reads actual browser/request state rather than assuming it has settled.
    await page.waitForTimeout(50);
    value = await read();
  }
  expect(ok(value), `${label}: ${value}`).toBeTrue();
}
async function mockConv(
  page: Page,
  base: string,
  id: string,
  title: string,
  parent: string | null,
): Promise<void> {
  await mockConversation(page, base, id, () => ({
    id,
    title,
    parent,
    status: "idle",
    turns: [
      {
        turn_id: `${id}-turn`,
        cursor: 0,
        started_at: 1,
        ended_at: 2,
        open: false,
        status: "idle",
        partial: false,
        segments: [
          {
            user: [
              {
                id: `${id}-user`,
                kind: "user",
                offset: 10,
                role: "user",
                content: `Ask ${id}`,
                ts: 1,
              },
            ],
            tools: [],
            assistant: {
              id: `${id}-assistant`,
              kind: "assistant",
              offset: 90,
              role: "assistant",
              content: `${title} thread body`,
              usage: {},
            },
          },
        ],
      },
    ],
  }));
}
const linkTitles: Record<string, string> = {
  main: "Coordinator",
  branch: "Branch agent",
  leaf: "Leaf agent",
};
const linkParents: Record<string, string | null> = {
  main: null,
  branch: "main",
  leaf: "branch",
};
function linkNodes(...ids: string[]) {
  return ids.map((id) => ({
    id,
    parent: linkParents[id],
    updated: 1,
    title: linkTitles[id],
    kind: null,
    status: "idle",
    children: id === "leaf" ? 0 : 1,
    queued: 0,
    preview: "",
    muted: false,
  }));
}
const LINK_PROBE = `(() => { window.__focusedReads=[]; window.__treeReads=0; window.__uiStatus=[]; window.__titles=[]; const realFetch=window.fetch.bind(window); window.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input.url,location.href); if(url.pathname.startsWith('/api/conversations/')&&url.searchParams.has('focused')) window.__focusedReads.push(url.pathname.split('/').pop()); const done=realFetch(input,init); if(url.pathname==='/api/tree') done.then(()=>window.__treeReads+=1,()=>{}); return done;}; window.addEventListener('recurse:ui-status',event=>window.__uiStatus.push(event.detail.message)); document.addEventListener('DOMContentLoaded',()=>{const title=document.querySelector('#conv-title'); new MutationObserver(()=>window.__titles.push(title?.textContent ?? '')).observe(title,{childList:true,subtree:true,characterData:true});}); })()`;
async function routeLinkTree(
  page: Page,
  base: string,
  nodes: () => unknown[],
  gate?: { open: boolean; held: Route[]; events?: EventEmitter },
): Promise<void> {
  await page.route(`${base}api/tree`, (route) => {
    if (gate && !gate.open) {
      gate.held.push(route);
      gate.events?.emit("held");
      return;
    }
    return route.fulfill({ json: nodes() });
  });
  await page.route(
    new RegExp(
      `${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}api/conversations/[\\w-]+(?:\\?[^/]*)?$`,
    ),
    (route) => route.fulfill({ status: 404, json: { detail: "not found" } }),
  );
  for (const [id, title] of Object.entries(linkTitles))
    await mockConv(page, base, id, title, linkParents[id]);
}

export const tests: BrowserTest[] = [
  // Feature: #2745 /btw opens a read-only side conversation in the Side pane's single embedded frame
  async function test_side_conversation_pane(browser, base) {
    const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
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
    await input.fill("/btw Reply only Side answer");
    await input.press("Enter");
    const pane = page.locator('.pane-col[data-pane="side"]');
    const frames = page.locator("iframe.side-frame");
    const side = page.frameLocator("iframe.side-frame");
    await side
      .locator(".msg.assistant .content", { hasText: "Side answer" })
      .waitFor();
    expect(
      await side
        .locator(".msg.assistant .content", { hasText: "Parent ready" })
        .count(),
    ).toBe(1);
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
    if (shots) await page.screenshot({ path: `${shots}/side-pane-1280.png` });

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
    await pane.locator("#side-picker").selectOption(first);
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
    await pane.getByRole("button", { name: /^Close / }).click();
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
    if (shots) await phone.screenshot({ path: `${shots}/side-pane-412.png` });
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
    for (const [name, viewport, mobile, touch] of [
      ["phone", { width: 390, height: 844 }, true, true],
      ["desktop", { width: 1280, height: 800 }, false, false],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: touch,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const cid = rootAgentId();
      await page.route(base + "api/tree", (route) =>
        route.fulfill({
          json: [
            {
              id: cid,
              parent: null,
              title: "Coordinator",
              kind: null,
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
      await waitValue(
        page,
        () => stale.count(),
        (v) => v === 1,
        `${name} stale row after external session replacement`,
      );
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
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      const queries: string[] = [];
      await page.route(`${base}api/agent-archive?*`, (route) => {
        const q = new URL(route.request().url()).searchParams.get("q") ?? "";
        queries.push(q);
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
      await waitValue(
        page,
        () => options.count(),
        (v) => v === 2,
        name,
      );
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
      const shots = process.env.REVIVE_SCREENSHOT_DIR;
      if (shots)
        await page.screenshot({ path: join(shots, `revive-${name}.png`) });
      const query = page.locator("#agent-finder-query");
      expect(
        (await page.evaluate("document.activeElement?.id")) ===
          "agent-finder-query",
      ).toBe(true);
      await query.fill("leaf");
      await waitValue(
        page,
        () => options.count(),
        (v) => v === 1,
        `${name} query`,
      );
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
  async function test_clear_drops_rendered_thread_and_stale_reads(
    browser,
    base,
  ) {
    const cid = rootAgentId();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
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
    const heldViews = new EventEmitter();
    await page.route(`${viewUrl}*`, (route) => {
      if (viewMode === "abort") return route.abort();
      if (viewMode === "stall") {
        stalled.push(route);
        heldViews.emit("held");
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
            await waitValue(
              page,
              () => staleRow(marker).count(),
              (v) => v === 1,
              label,
              8,
            );
            if (many)
              await waitValue(
                page,
                () => page.locator(".msg").count(),
                (v) => v >= 50,
                `${label} (full snapshot)`,
                8,
              );
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
    await waitValue(
      page,
      () => staleRow(bulk).count(),
      (v) => v === 0,
      "cleared rows gone",
      8,
    );
    expect(await staleRow(bulk).count()).toBe(0);
    viewMode = "pass";
    const eventsResponse = page.waitForResponse(
      `${base}api/conversations/${cid}/events`,
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
    const heldView = once(heldViews, "held", {
      signal: AbortSignal.timeout(3000),
    });
    viewMode = "stall";
    await Promise.all([
      heldView,
      (async () => {
        await page.evaluate(
          "document.querySelector('#scroll').scrollTop = document.querySelector('#scroll').scrollHeight",
        );
        await waitValue(
          page,
          () => page.evaluate("document.querySelector('#scroll').scrollTop"),
          (v) => v > 1000,
          "scrolled to bottom",
        );
        await page.evaluate("document.querySelector('#scroll').scrollTop = 0");
        await waitValue(
          page,
          () => page.evaluate("document.querySelector('#scroll').scrollTop"),
          (v) => v < 300,
          "scrolled to top",
        );
      })(),
    ]);
    expect(stalled.length).toBeGreaterThan(0);
    const oldPage = await (await page.request.get(viewUrl)).json();
    const predrop = [...stalled];
    expect(predrop.length).toBeGreaterThan(0);
    expect((await clear()).ok()).toBeTrue();
    await waitValue(
      page,
      () => staleRow(race).count(),
      (v) => v === 0,
      "race cleared before stale response",
      8,
    );
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
  async function test_agent_link_opens_that_agent_and_follows_the_selection(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(LINK_PROBE);
    await context.addInitScript(
      "localStorage.setItem('recurse.lastAgent','branch')",
    );
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeLinkTree(page, base, () => linkNodes("main", "branch", "leaf"));
    await page.goto(`${base}#agent=leaf`, { waitUntil: "domcontentloaded" });
    await page.locator("#conv-title", { hasText: "Leaf agent" }).waitFor();
    await page
      .locator("#messages", { hasText: "Leaf agent thread body" })
      .waitFor();
    expect(await page.locator('.agent[data-id="leaf"].selected').count()).toBe(
      1,
    );
    for (const id of ["main", "branch", "leaf"])
      expect(await page.locator(`.agent[data-id="${id}"]`).count()).toBe(1);
    await page.waitForFunction("window.__focusedReads.length > 0");
    expect(
      new Set((await page.evaluate("window.__focusedReads")) as string[]),
    ).toEqual(new Set(["leaf"]));
    expect(
      ((await page.evaluate("window.__titles")) as string[]).toString(),
    ).not.toContain("Coordinator");
    expect(page.url()).toBe(`${base}#agent=leaf`);
    await page.evaluate(
      "window.__reloaded=false; addEventListener('beforeunload',()=>window.__reloaded=true)",
    );
    await page.locator('.agent[data-id="branch"]').click();
    await page.locator("#conv-title", { hasText: "Branch agent" }).waitFor();
    expect(page.url()).toBe(`${base}#agent=branch`);
    await page.locator('.agent[data-id="main"]').click();
    await page.locator("#conv-title", { hasText: "Coordinator" }).waitFor();
    expect(page.url()).toBe(`${base}#agent=main`);
    expect((await page.evaluate("window.__reloaded")) as boolean).toBeFalse();
    await page.goBack();
    await page.locator("#conv-title", { hasText: "Branch agent" }).waitFor();
    expect(page.url()).toBe(`${base}#agent=branch`);
    expect(
      await page.locator('.agent[data-id="branch"].selected').count(),
    ).toBe(1);
    await page.goBack();
    await page.locator("#conv-title", { hasText: "Leaf agent" }).waitFor();
    expect(page.url()).toBe(`${base}#agent=leaf`);
    expect(await page.locator('.agent[data-id="leaf"].selected').count()).toBe(
      1,
    );
    await page.goForward();
    await page.locator("#conv-title", { hasText: "Branch agent" }).waitFor();
    expect(page.url()).toBe(`${base}#agent=branch`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator("#messages", { hasText: "Branch agent thread body" })
      .waitFor();
    await page.waitForFunction(
      "window.__focusedReads.includes('branch') && document.querySelector('.agent[data-id=\"branch\"].selected')",
    );
    expect(page.url()).toBe(`${base}#agent=branch`);
    expect(
      await page.locator('.agent[data-id="branch"].selected').count(),
    ).toBe(1);
    await page.evaluate("localStorage.setItem('recurse.lastAgent','leaf')");
    await page.goto(`${base}#agent=main`, { waitUntil: "domcontentloaded" });
    await page
      .locator("#messages", { hasText: "Coordinator thread body" })
      .waitFor();
    expect(page.url()).toBe(`${base}#agent=main`);
    expect(await page.locator('.agent[data-id="main"].selected').count()).toBe(
      1,
    );
    expect(
      ((await page.evaluate("window.__titles")) as string[]).toString(),
    ).not.toContain("Leaf agent");
    expect(errors).toEqual([]);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  },
  async function test_unopenable_agent_link_falls_back_and_says_so(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(LINK_PROBE);
    await context.addInitScript(
      "localStorage.setItem('recurse.lastAgent','branch')",
    );
    const live: unknown[][] = [linkNodes("main", "branch", "leaf")];
    for (const hash of [
      "#agent=missing",
      "#agent=..%2Fmain",
      "#agent=",
      `#agent=${"a".repeat(65)}`,
      "#agent=constructor",
      "#agent=toString",
    ]) {
      const page = await context.newPage();
      const errors = captureErrors(page);
      await routeLinkTree(page, base, () => live[0]);
      await page.goto(base + hash, { waitUntil: "domcontentloaded" });
      await page
        .locator("#messages", { hasText: "Coordinator thread body" })
        .waitFor();
      expect(page.url(), hash).toBe(`${base}#agent=main`);
      expect(
        await page.locator('.agent[data-id="main"].selected').count(),
        hash,
      ).toBe(1);
      expect(
        (await page.evaluate("window.__uiStatus.slice(-1)")) as string[],
      ).toEqual(["That agent link is not available"]);
      expect(
        new Set((await page.evaluate("window.__focusedReads")) as string[]),
        hash,
      ).toEqual(new Set(["main"]));
      expect(
        (await page.evaluate("localStorage.getItem('recurse.lastAgent')")) as
          | string
          | null,
        hash,
      ).toBe("main");
      expect(errors, hash).toEqual([]);
      await page.close();
    }
    const page = await context.newPage();
    const errors = captureErrors(page);
    await routeLinkTree(page, base, () => live[0]);
    await page.goto(`${base}#agent=leaf`, { waitUntil: "domcontentloaded" });
    await page
      .locator("#messages", { hasText: "Leaf agent thread body" })
      .waitFor();
    const entries = (await page.evaluate("history.length")) as number;
    live[0] = linkNodes("main", "branch");
    await page
      .locator("#conv-title", { hasText: "Branch agent" })
      .waitFor({ timeout: 15_000 });
    expect(page.url()).toBe(`${base}#agent=branch`);
    expect((await page.evaluate("history.length")) as number).toBe(entries);
    expect(errors).toEqual([]);
    await page.close();
    live[0] = linkNodes("main", "branch", "leaf");
    const page2 = await context.newPage();
    const errors2 = captureErrors(page2);
    await routeLinkTree(page2, base, () => live[0]);
    await gotoRoot(page2, base);
    await page2.locator('.agent[data-id="branch"]').click();
    await page2.locator('.agent[data-id="leaf"]').click();
    await page2.locator("#conv-title", { hasText: "Leaf agent" }).waitFor();
    await page2.locator('.agent[data-id="main"]').click();
    await page2.locator("#conv-title", { hasText: "Coordinator" }).waitFor();
    const reads = (await page2.evaluate("window.__treeReads")) as number;
    live[0] = linkNodes("main", "branch");
    await page2.waitForFunction(`window.__treeReads >= ${reads + 2}`);
    await page2.goBack();
    await page2.waitForFunction(
      "window.__uiStatus.at(-1) === 'That agent link is not available'",
    );
    expect(page2.url()).toBe(`${base}#agent=leaf`);
    expect(await page2.locator('.agent[data-id="main"].selected').count()).toBe(
      1,
    );
    live[0] = linkNodes("main", "branch", "leaf");
    await page2.reload({ waitUntil: "domcontentloaded" });
    await page2
      .locator("#messages", { hasText: "Leaf agent thread body" })
      .waitFor();
    expect(errors2).toEqual([]);
    await page2.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  },
  async function test_agent_link_under_a_base_path_and_a_manual_override(
    browser,
    base,
  ) {
    const prefixed = base + "proxy/app/";
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(LINK_PROBE);
    await context.route(prefixed, async (route) => {
      const body = await (await route.fetch({ url: base })).text();
      return route.fulfill({ status: 200, body, contentType: "text/html" });
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const gate = {
      open: true,
      held: [] as Route[],
      events: new EventEmitter(),
    };
    await routeLinkTree(
      page,
      base,
      () => linkNodes("main", "branch", "leaf"),
      gate,
    );
    await page.goto(`${prefixed}#agent=leaf`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("#messages", { hasText: "Leaf agent thread body" })
      .waitFor();
    expect(page.url()).toBe(`${prefixed}#agent=leaf`);
    await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="main"]').click();
    await page.locator("#conv-title", { hasText: "Coordinator" }).waitFor();
    expect(page.url()).toBe(`${prefixed}#agent=main`);
    await page.close();
    gate.open = false;
    const page2 = await context.newPage();
    await routeLinkTree(
      page2,
      base,
      () => linkNodes("main", "branch", "leaf"),
      gate,
    );
    const treeHeld = once(gate.events, "held", {
      signal: AbortSignal.timeout(15_000),
    });
    await page2.goto(`${prefixed}#agent=leaf`, {
      waitUntil: "domcontentloaded",
    });
    await treeHeld;
    expect(gate.held.length).toBeGreaterThan(0);
    await page2.locator("#new-top").click();
    await page2.waitForFunction("location.hash === ''");
    expect((await page2.evaluate("document.activeElement.id")) as string).toBe(
      "input",
    );
    expect(page2.url()).toBe(prefixed);
    gate.open = true;
    for (const route of gate.held)
      await route
        .fulfill({ json: linkNodes("main", "branch", "leaf") })
        .catch(() => undefined);
    await page2
      .locator('.agent[data-id="main"]')
      .waitFor({ state: "attached" });
    await page2.locator(".agent.draft-row").waitFor({ state: "attached" });
    await page2.locator("#menu-btn").click();
    await page2.locator('.agent[data-id="main"]').waitFor();
    await page2.waitForFunction(
      "document.activeElement === document.querySelector('#shortcut-pane > summary')",
    );
    expect(
      await page2
        .locator('.agent[data-id="main"]')
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(await page2.locator('.agent[data-id="branch"]').count()).toBe(0);
    expect(await page2.locator(".agent.draft-row").count()).toBe(1);
    expect(
      await page2.evaluate(
        "document.activeElement === document.querySelector('#shortcut-pane > summary')",
      ),
    ).toBeTrue();
    expect(page2.url()).toBe(prefixed);
    await page2.goBack();
    await page2
      .locator("#messages", { hasText: "Leaf agent thread body" })
      .waitFor();
    expect(page2.url()).toBe(`${prefixed}#agent=leaf`);
    expect(errors).toEqual([]);
    await closeWithRoutes(context);
  },
];
if (import.meta.main) await runBrowserTests([["platform-commands", tests]]);
