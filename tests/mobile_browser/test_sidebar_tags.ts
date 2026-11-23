import { expect } from "bun:test";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  captureErrors,
  focusComposer,
  gotoRoot,
  openPage,
  postFixture,
  ROOT,
  screenshot,
  showAgentList,
  type BrowserTest,
} from "./common";
import {
  edgesUncovered,
  enableTagSidebar,
  header,
  loadProjectSidebar,
  sectionOf,
  seedSections,
  serverTags,
  type SidebarSectionIds,
} from "./sidebar_support";

export const tests: BrowserTest[] = [
  async function test_sidebar_typed_tags(browser, base) {
    for (const width of [1280, 412]) {
      const tags = await browser.newContext({
        viewport: { width, height: 915 },
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      await typedTags(tags, base, await seedSections(tags, base), width);
      await tags.close();
    }
  },
  // Regression: #3017 tag actions precede POST answers; agent tags need no poll.
  async function test_sidebar_tag_updates(browser, base, data) {
    const { context, page } = await openPage(browser, {
      viewport: { width: 1280, height: 900 },
    });
    const ids = await seedSections(context, base);
    for (let i = 0; i < 40; i++) {
      const response = await context.request.post(`${base}api/conversations`, {
        data: {},
      });
      expect(response.ok()).toBeTrue();
    }
    const settings = await (
      await context.request.get(`${base}api/sidebar/script`)
    ).json();
    const script = settings.default
      .replaceAll("collapsed: true", "collapsed: false")
      .replace(
        "actions: stale.length ? [archiveStale] : [],",
        'actions: [ARCHIVE, PIN].map(a => ({...a, label: a.label + " all", rows: inbox})),',
      )
      .replace(
        "rowActions: [RESTORE],",
        'rowActions: [RESTORE], actions: [{...RESTORE, label: "Restore all", rows: archive}],',
      )
      .replace(
        "rowActions: [PIN],",
        'rowActions: [PIN], actions: [{...SNOOZE, label: "Snooze all", rows: inbox}],',
      );
    await postFixture(base, "save-sidebar-script", { script, by: "operator" });
    await page.clock.install();
    await gotoRoot(page, base);
    const row = page.locator(`.agent[data-id="${ids.fresh}"]`);
    await row.waitFor();
    await header(page, "Inbox")
      .getByRole("button", {
        name: "Archive all",
        exact: true,
        includeHidden: true,
      })
      .waitFor({ state: "attached" });
    const checkSection = (title: string) =>
      browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe(title);
    const act = async (action: string, bulk: boolean) => {
      if (bulk) {
        const section = header(
          page,
          action === "Restore"
            ? "Archive"
            : action === "Snooze"
              ? "Active"
              : "Inbox",
        );
        await section.hover();
        await section
          .getByRole("button", { name: `${action} all`, exact: true })
          .click();
      } else {
        await row.hover();
        await row
          .getByRole("button", { name: `${action} Fresh idle`, exact: true })
          .click();
      }
      if (action === "Snooze")
        await page
          .getByRole("dialog", { name: "Snooze until" })
          .getByRole("button", { name: "1 hour", exact: true })
          .click();
      if (bulk)
        await page
          .locator("#sidebar-popover")
          .getByRole("button", { name: action, exact: true })
          .click();
    };
    for (const bulk of [false, true]) {
      for (const [action, destination] of [
        ["Archive", "Archive"],
        ["Restore", "Inbox"],
        ["Pin", "Pinned"],
        ["Snooze", "Archive"],
        ["Restore", "Inbox"],
      ]) {
        if (action === "Snooze") {
          if (bulk) {
            const all = await (
              await context.request.get(`${base}api/tree`)
            ).json();
            expect(
              (
                await context.request.post(`${base}api/sidebar/tags`, {
                  data: {
                    ids: all.map((node: any) => node.id),
                    clear: ["pinned"],
                  },
                })
              ).ok(),
            ).toBeTrue();
            await checkSection("Inbox");
          } else {
            await row.hover();
            await row
              .getByRole("button", { name: "Unpin Fresh idle", exact: true })
              .click();
            await checkSection("Inbox");
          }
        }
        await beforeTagAnswer(
          page,
          () => act(action!, bulk),
          async () => {
            await checkSection(destination!);
            if (bulk) {
              const count = Number(
                await header(page, destination!)
                  .locator(".tree-section-count")
                  .innerText(),
              );
              expect(count).toBeGreaterThanOrEqual(40);
            }
          },
        );
      }
    }
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const proc = Bun.spawn(
      [
        process.execPath,
        join(ROOT, "tools/subagent.ts"),
        "tag",
        ids.fresh,
        "--add",
        "needs-review",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CHAT_DATA_DIR: join(data, "data"),
          RECURSE_HOME: join(data, "settings"),
          RECURSE_AGENT_ID: ids.fresh,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    await row.locator('[title="Tag: needs-review"]').waitFor();
    await context.close();
  },
];

async function typedTags(
  context: BrowserContext,
  base: string,
  ids: SidebarSectionIds,
  width: number,
): Promise<void> {
  expect(
    (
      await context.request.post(`${base}api/sidebar/tags`, {
        data: {
          ids: [ids.archived],
          set: { "recurse-dev": null, research: null },
        },
      })
    ).ok(),
  ).toBeTrue();
  const page = await context.newPage();
  const errors = captureErrors(page);
  await gotoRoot(page, base);
  if (width === 412) {
    await page.locator("#menu-btn").click();
    await page.waitForFunction(
      () =>
        (globalThis as any).document
          .querySelector("#sidebar")
          .getBoundingClientRect().x === 0,
    );
  }
  const newButton = page.locator(width === 412 ? "#new-list" : "#new-top");
  await page.locator(`.agent[data-id="${ids.fresh}"]`).waitFor();
  expect(await page.getByRole("button", { name: /^Tag… / }).count()).toBe(0);
  await newButton.click();
  await browserExpect(page.locator("#input")).toBeFocused();
  await page.locator("#draft-model-host").waitFor();
  expect(await page.locator("#draft-tag").count()).toBe(0);
  await screenshot(page, `sidebar/draft-built-in-${width}`);
  const tagScript = await enableTagSidebar(context, base, [
    "recurse-dev",
    "research",
  ]);
  await page.reload();
  await showAgentList(page);
  await header(page, "recurse-dev").waitFor();
  const row = page.locator(`.agent[data-id="${ids.fresh}"]`);
  const openHoldMenu = async (target: Locator) => {
    await target.scrollIntoViewIfNeeded();
    const touch = await context.newCDPSession(page);
    const box = (await target.boundingBox())!;
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 50, y: box.y + box.height / 2 }],
    });
    await page.locator("#hold-menu").getByRole("menu").waitFor();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await touch.detach();
  };
  const act = async (label: string) => {
    if (width === 1280) {
      await row.hover();
      await row
        .getByRole("button", { name: `${label} Fresh idle`, exact: true })
        .click();
    } else {
      await openHoldMenu(row);
      await page
        .locator("#hold-menu")
        .getByRole("menuitem", { name: label, exact: true })
        .tap();
    }
  };
  const input = page.getByRole("textbox", { name: "Tag name", exact: true });
  const dialog = page.getByRole("dialog", { name: "Tag name", exact: true });
  await row.waitFor();
  await act("Tag…");
  await browserExpect(input).toBeFocused();
  await input.fill("rcd");
  await browserExpect(dialog.locator(".tag-suggestions button")).toHaveText([
    "recurse-dev",
  ]);
  expect(
    await dialog.getByRole("button", { name: "pinned", exact: true }).count(),
  ).toBe(0);
  if (width === 412) {
    for (const control of await dialog.locator("input, button").all())
      expect(await edgesUncovered(control)).toBeTrue();
  }
  await screenshot(page, `sidebar/tag-box-${width}`);
  await input.press("Escape");
  await browserExpect(dialog).toHaveCount(0);
  expect((await serverTags(context, base, ids.fresh))["rcd"]).toBeUndefined();
  await act("Tag…");
  await input.fill("cancelled");
  await header(page, "Inbox").locator(".tree-section-title").click();
  await browserExpect(dialog).toHaveCount(0);
  await header(page, "Inbox").locator(".tree-section-toggle").click();
  await act("Tag…");
  for (const name of ["pinned", "archived", "snoozed"]) {
    await input.fill(name);
    await input.press("Enter");
    await browserExpect(dialog.getByRole("status")).toHaveText(
      "This tag is reserved. Choose another name.",
    );
  }
  await input.fill("");
  await input.pressSequentially("Recurse Dev");
  await browserExpect(input).toHaveValue("recurse-dev");
  await input.press("Enter");
  await browserExpect
    .poll(() => sectionOf(page, ids.fresh))
    .toBe("recurse-dev/Inbox");
  await browserExpect
    .poll(() => serverTags(context, base, ids.fresh))
    .toMatchObject({ "recurse-dev": { by: "operator" } });
  await screenshot(page, `sidebar/tag-section-${width}`);
  await act("Untag");
  await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Inbox");
  await browserExpect(header(page, "recurse-dev")).toHaveCount(1);
  await browserExpect
    .poll(
      async () => (await serverTags(context, base, ids.fresh))["recurse-dev"],
    )
    .toBeUndefined();
  await screenshot(page, `sidebar/tag-removed-${width}`);
  await act("Tag…");
  await input.fill("rcd");
  await input.press("ArrowDown");
  await input.press("Enter");
  await browserExpect
    .poll(() => sectionOf(page, ids.fresh))
    .toBe("recurse-dev/Inbox");
  await browserExpect(header(page, "research")).toHaveCount(0);
  expect(
    (
      await context.request.post(`${base}api/sidebar/tags`, {
        data: { ids: [ids.busy, ids.stale], set: { research: null } },
      })
    ).ok(),
  ).toBeTrue();
  const childHeader = (group: string, title: string) =>
    page.locator(
      `.tree-section-header[data-section-key='${JSON.stringify(["", group, title])}']`,
    );
  await childHeader("research", "Active").waitFor();
  await childHeader("recurse-dev", "Archive").waitFor();
  await browserExpect(childHeader("recurse-dev", "Active")).toHaveCount(0);
  await screenshot(page, `sidebar/nested-tags-${width}`);
  const recurseInbox = childHeader("recurse-dev", "Inbox").locator(
    ".tree-section-toggle",
  );
  await recurseInbox.click();
  await browserExpect(recurseInbox).toHaveAttribute("aria-expanded", "false");
  await browserExpect(
    childHeader("research", "Inbox").locator(".tree-section-toggle"),
  ).toHaveAttribute("aria-expanded", "true");
  await recurseInbox.click();
  const groupToggle = header(page, "recurse-dev").locator(
    ".tree-section-toggle",
  );
  await groupToggle.click();
  await browserExpect(childHeader("recurse-dev", "Inbox")).toHaveCount(0);
  await browserExpect(childHeader("recurse-dev", "Archive")).toHaveCount(0);
  await screenshot(page, `sidebar/nested-folded-${width}`);
  await groupToggle.press("Enter");
  await browserExpect(recurseInbox).toHaveAttribute("aria-expanded", "true");
  if (width === 412) {
    await page.locator("#new-list").focus();
    for (const toggle of await page.locator(".tree-section-toggle").all()) {
      await toggle.scrollIntoViewIfNeeded();
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await edgesUncovered(toggle)).toBeTrue();
    }
  }
  await newButton.click();
  await browserExpect(page.locator("#input")).toBeFocused();
  await page.locator("#draft-model-host").waitFor();
  expect(await dialog.count()).toBe(0);
  const tagControl = page.locator("#draft-tag");
  await browserExpect(tagControl).toHaveAccessibleName("No tag");
  expect(
    await tagControl.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return [
        [-21, -21],
        [21, -21],
        [21, 21],
        [-21, 21],
      ].every(([x, y]) => {
        const hit = button.ownerDocument.elementFromPoint(
          box.x + box.width / 2 + x!,
          box.y + box.height / 2 + y!,
        );
        return !!hit && button.contains(hit);
      });
    }),
  ).toBeTrue();
  await screenshot(page, `sidebar/draft-no-tag-${width}`);
  await tagControl.focus();
  await tagControl.press("Enter");
  await browserExpect(input).toBeFocused();
  await screenshot(page, `sidebar/draft-tag-box-${width}`);
  await input.press("Escape");
  await browserExpect(dialog).toHaveCount(0);
  await browserExpect(tagControl).toBeFocused();
  await tagControl.click();
  await input.fill("Recurse Dev");
  await input.press("Enter");
  await browserExpect(tagControl).toHaveAccessibleName("Tag: recurse-dev");
  await screenshot(page, `sidebar/draft-tag-chosen-${width}`);
  const sendDraft = async (text: string, tagged = true) => {
    const created = page.waitForResponse(
      (response) =>
        response.url() === `${base}api/conversations` &&
        response.request().method() === "POST",
    );
    await page.locator("#input").fill(text);
    await page.evaluate(() => {
      const browser = globalThis as any;
      browser.newAgentPlacements = [];
      browser.newAgentObserver = new browser.MutationObserver(() => {
        let section = "";
        for (const element of browser.document.querySelectorAll(
          "#agent-list .tree-section-header, #agent-list .agent[data-id]",
        )) {
          if (element.dataset.section)
            section = JSON.parse(element.dataset.sectionKey).slice(1).join("/");
          else
            browser.newAgentPlacements.push({
              id: element.dataset.id,
              section,
            });
        }
      });
      browser.newAgentObserver.observe(
        browser.document.querySelector("#agent-list"),
        { childList: true, subtree: true },
      );
    });
    await page.locator("#send").click();
    const response = await created;
    expect(response.ok()).toBeTrue();
    expect(response.request().postDataJSON().tags).toEqual(
      tagged ? ["recurse-dev"] : undefined,
    );
    const agent = await response.json();
    if (tagged)
      expect(agent.tags["recurse-dev"]).toMatchObject({ by: "operator" });
    else expect(agent.tags?.["recurse-dev"]).toBeUndefined();
    const sectionPattern = tagged
      ? /^recurse-dev\/(Active|Inbox)$/
      : /^(Active|Inbox)$/;
    await browserExpect
      .poll(() => sectionOf(page, agent.id))
      .toMatch(sectionPattern);
    const placements = await page.evaluate((id) => {
      const browser = globalThis as any;
      browser.newAgentObserver.disconnect();
      return browser.newAgentPlacements
        .filter((placement: any) => placement.id === id)
        .map((placement: any) => placement.section);
    }, agent.id);
    expect(placements.length).toBeGreaterThan(0);
    for (const section of new Set<string>(placements))
      expect(section).toMatch(sectionPattern);
    await showAgentList(page);
    return agent.id as string;
  };
  let deliveredFrom!: (rows: string[]) => void;
  const rowsWhileDelivering = new Promise<string[]>(
    (resolve) => (deliveredFrom = resolve),
  );
  await page.route(
    "**/api/conversations/*/deliver",
    async (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3];
      const rows = await page.waitForFunction((id) => {
        let section = null;
        const rows = [];
        for (const el of (globalThis as any).document.querySelectorAll(
          "#agent-list .tree-section-header, #agent-list .agent",
        )) {
          if (el.dataset.section)
            section = JSON.parse(el.dataset.sectionKey).slice(1).join("/");
          else if (el.dataset.id === id) rows.push(`agent in ${section}`);
          else if (el.classList.contains("draft-row"))
            rows.push(`draft in ${section}`);
        }
        return rows.some((row) => !row.endsWith(" in null")) && rows;
      }, id);
      deliveredFrom((await rows.jsonValue()) as string[]);
      await route.continue();
    },
    { times: 1 },
  );
  const newId = await sendDraft("New agent inside recurse-dev");
  const [draftRow, ...duplicates] = await rowsWhileDelivering;
  expect(draftRow).toMatch(/^draft in recurse-dev\/(Active|Inbox)$/);
  expect(duplicates).toEqual([]);
  await screenshot(page, `sidebar/new-agent-tagged-${width}`);
  const sectionAction = async (title: string, label: string, shot?: string) => {
    const section = header(page, title);
    if (width === 1280) await section.hover();
    else await openHoldMenu(section);
    if (shot) await screenshot(page, `sidebar/${shot}-${width}`);
    if (width === 1280)
      await section.getByRole("button", { name: label, exact: true }).click();
    else
      await page
        .locator("#hold-menu")
        .getByRole("menuitem", { name: label, exact: true })
        .tap();
  };
  await sectionAction("recurse-dev", "New agent", "new-agent-section-action");
  await page.locator(".draft-row").waitFor({ state: "attached" });
  expect(await dialog.count()).toBe(0);
  await browserExpect(tagControl).toHaveAccessibleName("Tag: recurse-dev");
  await screenshot(page, `sidebar/draft-tag-section-${width}`);
  const sectionId = await sendDraft("New agent from section action");
  expect(sectionId).not.toBe(newId);
  expect(
    (await serverTags(context, base, sectionId))["recurse-dev"],
  ).toMatchObject({ by: "operator" });
  await sectionAction("recurse-dev", "New agent");
  await browserExpect(tagControl).toHaveAccessibleName("Tag: recurse-dev");
  await tagControl.click();
  await dialog.getByRole("button", { name: "No tag", exact: true }).click();
  await browserExpect(tagControl).toHaveAccessibleName("No tag");
  await sendDraft("New agent with tag cleared", false);
  const defaultsScript = tagScript
    .replace(
      "defaults: { recurse: { effort: 3 }, research: { effort: 4 } }",
      'defaults: { "recurse-dev": { effort: 4 } }',
    )
    .replace("title: tag,", 'title: tag + " defaults",');
  await postFixture(base, "save-sidebar-script", {
    script: defaultsScript,
    by: "operator",
  });
  let releaseWorker!: () => void;
  const workerHeld = new Promise<void>((resolve) => (releaseWorker = resolve));
  await page.route("**/static/sidebar-worker.js?*", async (route) => {
    await workerHeld;
    await route.continue();
  });
  await page.reload();
  await showAgentList(page);
  await sectionAction("recurse-dev", "New agent");
  await browserExpect(page.locator("#input")).toBeFocused();
  const earlyCreation = page.waitForResponse(
    (response) =>
      response.url() === `${base}api/conversations` &&
      response.request().method() === "POST",
  );
  await page.locator("#input").fill("Send before tag defaults finish loading");
  await page.locator("#send").click();
  await page.locator("#messages .working").waitFor();
  releaseWorker();
  const earlyResponse = await earlyCreation;
  expect(earlyResponse.ok()).toBeTrue();
  expect(earlyResponse.request().postDataJSON().level).toBe(4);
  expect(earlyResponse.request().postDataJSON().tags).toEqual(["recurse-dev"]);
  const earlyAgent = await earlyResponse.json();
  await page
    .locator(`.agent.selected[data-id="${earlyAgent.id}"]`)
    .waitFor({ state: "attached" });
  await page.unroute("**/static/sidebar-worker.js?*");
  await showAgentList(page);
  await header(page, "recurse-dev defaults").waitFor();
  await newButton.click();
  await tagControl.click();
  await input.fill("rcdv");
  await dialog
    .getByRole("button", { name: "recurse-dev", exact: true })
    .click();
  await browserExpect(page.locator("#effort-range")).toHaveValue("4");
  await focusComposer(page);
  await page.locator("#model-trigger").click();
  await page.locator("#effort-range").focus();
  await page.locator("#effort-range").press("ArrowLeft");
  await browserExpect(page.locator("#effort-range")).toHaveValue("3");
  await showAgentList(page);
  const script = `export default rows => [{ title: "Projects", rows: rows.filter(r => r.depth === 0), actions: [{ label: "Tag all", ask: "tag", set: "fixed", clear: "research" }, { label: "Remove tag", ask: "tag", clear: "ask" }] }];`;
  await postFixture(base, "save-sidebar-script", { script, by: "operator" });
  await page.reload();
  await showAgentList(page);
  await header(page, "Projects").waitFor();
  await newButton.click();
  await page.locator(".draft-row").waitFor({ state: "attached" });
  expect(await dialog.count()).toBe(0);
  await browserExpect(tagControl).toHaveCount(0);
  await showAgentList(page);
  await sectionAction("Projects", "Tag all");
  await input.fill("team");
  await input.press("Enter");
  await page
    .locator("#sidebar-popover")
    .getByRole("button", { name: "Tag", exact: true })
    .click();
  for (const id of [ids.fresh, ids.busy, ids.archived])
    await browserExpect
      .poll(() => serverTags(context, base, id))
      .toMatchObject({ team: { by: "operator" }, fixed: { by: "operator" } });
  expect(
    (await serverTags(context, base, ids.archived)).research,
  ).toBeUndefined();
  await sectionAction("Projects", "Remove tag");
  const remove = page.getByRole("dialog", { name: "Remove tag", exact: true });
  const removeInput = remove.getByRole("textbox", {
    name: "Remove tag",
    exact: true,
  });
  await removeInput.fill("not-present");
  await browserExpect(remove.getByRole("status")).toHaveText(
    "Choose a tag on these conversations.",
  );
  await removeInput.fill("team");
  await remove.getByRole("button", { name: "team", exact: true }).click();
  await page
    .locator("#sidebar-popover")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await browserExpect
    .poll(async () => (await serverTags(context, base, ids.fresh)).team)
    .toBeUndefined();
  expect(errors).toEqual([]);
  const demo = await loadProjectSidebar();
  expect(
    (
      await context.request.post(`${base}api/sidebar/tags`, {
        data: { ids: [ids.busy], set: { "needs-you": null } },
      })
    ).ok(),
  ).toBeTrue();
  await postFixture(base, "save-sidebar-script", {
    script: demo,
    by: "operator",
  });
  for (const [id, tag] of [
    [ids.fresh, "recurse"],
    [ids.archived, "research"],
  ])
    expect(
      (
        await context.request.post(`${base}api/sidebar/tags`, {
          data: { ids: [id], set: { [tag!]: null } },
        })
      ).ok(),
    ).toBeTrue();
  await page.reload();
  await showAgentList(page);
  await header(page, "Needs you").waitFor();
  await header(page, "recurse").waitFor();
  await header(page, "research").waitFor();
  await screenshot(page, `sidebar/nested-demo-${width}`);
  const all = await (await context.request.get(`${base}api/tree`)).json();
  expect(
    (
      await context.request.post(`${base}api/sidebar/tags`, {
        data: {
          ids: all.map((row: any) => row.id),
          clear: ["fixed", "recurse", "recurse-dev", "research", "needs-you"],
        },
      })
    ).ok(),
  ).toBeTrue();
  expect(
    (
      await context.request.post(`${base}api/sidebar/script`, {
        data: { action: "reset" },
      })
    ).ok(),
  ).toBeTrue();
  if (width === 1280) {
    const tags = Array.from({ length: 9 }, (_, i) => `project-${i}`);
    expect(
      (
        await context.request.post(`${base}api/sidebar/tags`, {
          data: {
            ids: [ids.archived],
            set: Object.fromEntries(tags.map((name) => [name, null])),
          },
        })
      ).ok(),
    ).toBeTrue();
    expect(
      (
        await context.request.post(`${base}api/sidebar/tags`, {
          data: { ids: [ids.fresh], set: { "project-8": null } },
        })
      ).ok(),
    ).toBeTrue();
    await browserExpect.poll(() => sectionOf(page, ids.fresh)).toBe("Inbox");
    const settings = await (
      await context.request.get(`${base}api/sidebar/script`)
    ).json();
    const checked = await context.request.post(
      `${base}__browser-test/save-sidebar-script`,
      { data: { script: settings.default, by: "operator" } },
    );
    expect(checked.ok()).toBeTrue();
    expect((await checked.json()).sections).toHaveLength(4);
    expect(await page.getByRole("button", { name: /^Tag… / }).count()).toBe(0);
    expect(await header(page, "project-8").count()).toBe(0);
    expect(
      (
        await context.request.post(`${base}api/sidebar/tags`, {
          data: { ids: [ids.fresh, ids.archived], clear: tags },
        })
      ).ok(),
    ).toBeTrue();
    expect(
      (
        await context.request.post(`${base}api/sidebar/script`, {
          data: { action: "reset" },
        })
      ).ok(),
    ).toBeTrue();
  }
}

async function beforeTagAnswer(
  page: Page,
  act: () => Promise<void>,
  check: () => Promise<void>,
): Promise<void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const requested = new Promise<void>((resolve) => (arrived = resolve));
  const pattern = /\/api\/sidebar\/tags$/;
  const handler = async (route: import("playwright").Route) => {
    arrived();
    await held;
    await route.continue();
  };
  await page.route(pattern, handler);
  try {
    await act();
    await requested;
    await check();
  } finally {
    const answered = page.waitForResponse((response) =>
      pattern.test(response.url()),
    );
    release();
    await answered;
    await page.unroute(pattern, handler);
  }
}
