import { expect } from "bun:test";
import { EventEmitter, once } from "node:events";
import type { Page, Route } from "playwright";
import {
  captureErrors,
  closeWithRoutes,
  gotoRoot,
  mockConversation,
  openPage,
  postFixture,
  runBrowserTests,
  screenshot,
  startNewAgent,
  turn,
  visibleAndUncovered,
  type BrowserTest,
} from "./common";
import { idleConv, row, tree } from "./fixtures";

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
      turn(`${id}-turn`, `Ask ${id}`, `${title} thread body`, {
        includeRows: false,
        rowIds: { user: `${id}-user`, assistant: `${id}-assistant` },
        usage: {},
      }),
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

async function layerAt(page: any, at: string | [number, number]) {
  const [x, y] = Array.isArray(at)
    ? at
    : await page.locator(at).evaluate((el: any) => {
        const r = el.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
  return page.evaluate(
    `document.elementFromPoint(${x}, ${y})?.closest("#sidebar, #topbar, #panes, #pane-backdrop, #pane-menu")?.id`,
  );
}

export const tests: BrowserTest[] = [
  async function test_phone_list_is_root_and_conversations_replace(
    browser,
    base,
  ) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
    });
    await routeLinkTree(page, base, () => linkNodes("main", "branch", "leaf"));
    await page.goto(`${base}?before-phone`);
    await page.locator("#sidebar.open .agent").first().waitFor();
    await page.goto(base);
    await page.locator("#sidebar.open .agent").first().waitFor();
    expect(page.url()).toBe(base);
    expect(await page.locator("#input").isVisible()).toBeFalse();
    expect(await page.locator("#new-list").isVisible()).toBeTrue();
    expect(await page.locator("#settings-btn").isVisible()).toBeTrue();
    await screenshot(page, "platform-commands/phone-list");
    await page.locator('.agent[data-id="main"]').click();
    await page.locator("#conv-title", { hasText: "Coordinator" }).waitFor();
    expect(await page.locator("#new-top").isVisible()).toBeTrue();
    expect(await page.locator("#phone-nav").count()).toBe(0);
    await screenshot(page, "platform-commands/phone-conversation");
    await page.locator("#pane-fab").click();
    await screenshot(page, "platform-commands/phone-more");
    expect(
      await page.locator("#settings-menu-btn, #new-agent-menu-btn").count(),
    ).toBe(0);
    await page.goBack();
    await page.locator("#sidebar.open").waitFor();
    expect(await page.locator("#pane-menu.on").count()).toBe(0);
    expect(page.url()).toBe(base);
    await page.locator('.agent[data-id="main"]').click();
    await page.locator("#menu-btn").click();
    await page.locator("#sidebar.open").waitFor();
    await page.goBack();
    expect(page.url()).toBe(`${base}?before-phone`);
    await page.goto(`${base}#agent=leaf`);
    await page.locator("#conv-title", { hasText: "Leaf agent" }).waitFor();
    await page.locator("#up-top").click();
    await page.locator("#conv-title", { hasText: "Branch agent" }).waitFor();
    await page.locator("#up-top").click();
    await page.locator("#conv-title", { hasText: "Coordinator" }).waitFor();
    await page.goBack();
    await page.locator("#sidebar.open").waitFor();
    expect(page.url()).toBe(base);
    await page.goto(`${base}#agent=leaf`);
    await page.locator("#conv-title", { hasText: "Leaf agent" }).waitFor();
    await page.reload();
    await page.locator("#conv-title", { hasText: "Leaf agent" }).waitFor();
    await page.goBack();
    await page.locator("#sidebar.open").waitFor();
    expect(page.url()).toBe(base);
    await page.locator('.agent[data-id="main"]').click();
    await page.setViewportSize({ width: 1280, height: 915 });
    await page.locator('.agent[data-id="branch"]').click();
    await page.locator('.agent[data-id="leaf"]').click();
    await page.setViewportSize({ width: 412, height: 915 });
    await page.locator("#menu-btn").click();
    await page.locator("#sidebar.open").waitFor();
    expect(page.url()).toBe(base);
    expect(errors).toEqual([]);
    await closeWithRoutes(context);
  },
  async function test_agent_link_opens_that_agent_and_follows_the_selection(
    browser,
    base,
  ) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(LINK_PROBE);
    await context.addInitScript(
      "localStorage.setItem('recurse.lastAgent','branch')",
    );
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
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
    await context.addInitScript(LINK_PROBE);
    await context.route(prefixed, async (route) => {
      const body = await (await route.fetch({ url: base })).text();
      return route.fulfill({ status: 200, body, contentType: "text/html" });
    });
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
    await startNewAgent(page2);
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
    await page2.locator("#input").blur();
    await page2.locator("#menu-btn").click();
    await page2.locator('.agent[data-id="main"]').waitFor();
    await page2.locator("#sidebar.open").waitFor();
    expect(
      await page2
        .locator('.agent[data-id="main"]')
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(await page2.locator('.agent[data-id="branch"]').count()).toBe(0);
    expect(await page2.locator(".agent.draft-row").count()).toBe(1);
    expect(
      await page2.locator("#main").evaluate((el) => (el as any).inert),
    ).toBeTrue();
    expect(page2.url()).toBe(prefixed);
    await page2.locator('.agent[data-id="main"]').click();
    await page2.locator("#conv-title", { hasText: "Coordinator" }).waitFor();
    await page2.goBack();
    await page2.locator("#sidebar.open").waitFor();
    expect(page2.url()).toBe(prefixed);
    expect(errors).toEqual([]);
    await closeWithRoutes(context);
  },
  async function test_phone_back_closes_pane_before_returning_to_list(
    browser,
    base,
  ) {
    const fixture = await postFixture(base, "seed-files-pane");
    const { context, page } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
    });
    const fab = page.locator("#pane-fab");
    await page.goto(`${base}#agent=${fixture.demo}`);
    await page.locator("#pane-fab.on").waitFor();
    await fab.click();
    await page.locator('#pane-menu [data-pane="files"]').click();
    await page.locator("#panes.overlay .files-card").first().waitFor();
    expect(await layerAt(page, [206, 600])).toBe("panes");
    expect(await layerAt(page, "#menu-btn")).toBe("topbar");
    await fab.click();
    await page.locator("#pane-menu.on").waitFor();
    expect(await layerAt(page, '#pane-menu [data-pane="files"]')).toBe(
      "pane-menu",
    );
    await fab.click();
    await page.locator("#pane-menu.on").waitFor({ state: "detached" });
    await page.goBack();
    await page.locator("#panes.on").waitFor({ state: "detached" });
    await visibleAndUncovered(page, "#input");
    expect(await layerAt(page, "#menu-btn")).toBe("topbar");
    expect(await layerAt(page, "#pane-fab")).toBe("topbar");
    await page.locator("#menu-btn").click();
    await page.locator("#sidebar.open").waitFor();
    expect(await layerAt(page, [100, 600])).toBe("sidebar");
    expect(await layerAt(page, [400, 600])).toBe("sidebar");
    await context.close();
  },
  async function test_mobile_sidebar_parent_control(browser, base) {
    const { context, page } = await openPage(browser, {
      viewport: { width: 412, height: 915 },
      touch: true,
    });
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({
        json: [
          { ...tree()[0], parent: "parent" },
          { ...tree("parent")[0], title: "Parent", children: 1 },
        ],
      }),
    );
    await mockConversation(page, base, "main", () => ({
      ...idleConv([
        row(
          "a1",
          "assistant",
          "```text\n" + "long line ".repeat(100) + "\n```",
        ),
      ]),
      parent: "parent",
    }));
    await mockConversation(page, base, "parent", () => ({
      ...idleConv(),
      id: "parent",
      title: "Parent",
    }));
    await gotoRoot(page, base);
    await page.locator(".content pre").waitFor();
    await page.locator("#menu-btn").tap();
    expect(await page.locator("#up-top.on").count()).toBe(1);
    await page.locator("#sidebar .agent.selected").tap();
    await page.locator("#up-top").tap();
    await page.waitForFunction(
      "document.querySelector('#conv-title')?.textContent === 'Parent'",
    );
    expect(await page.locator("#up-top.on").count()).toBe(0);
    await context.close();
  },
];
if (import.meta.main) await runBrowserTests([["agent-navigation", tests]]);
