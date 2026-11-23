import { expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { postFixture, ROOT } from "./common";

export const loadProjectSidebar = () =>
  readFile(join(ROOT, "playground/sidebar/projects.js"), "utf8");

export async function enableTagSidebar(
  context: BrowserContext,
  base: string,
  projects: string[],
): Promise<string> {
  const settings = await (
    await context.request.get(`${base}api/sidebar/script`)
  ).json();
  const demo = await loadProjectSidebar();
  const script =
    demo
      .replace('["recurse", "research"]', JSON.stringify(projects))
      .replace("function sidebar(rows)", "function sidebar(rows, now)")
      .replace(
        `    {
      title: "Other agents",
      hideWhenEmpty: true,
      rows: rows.sort(byRank),
      rowActions: [TAG],
    },`,
        `    ...plain(rows, now).map(section => ({
      ...section, rowActions: [...section.rowActions, TAG],
    })),`,
      ) +
    `\nconst plain = (() => { ${settings.default.replace("export default function sidebar", "return function sidebar")} })();`;
  await postFixture(base, "save-sidebar-script", { script, by: "operator" });
  return script;
}

export type SidebarSectionIds = Record<
  "fresh" | "stale" | "busy" | "archived" | "child" | "grandchild",
  string
>;
export const seedSections = async (context: BrowserContext, base: string) => {
  const response = await context.request.post(
    `${base}__browser-test/seed-sidebar-sections`,
  );
  expect(response.ok()).toBe(true);
  const ids = (await response.json()) as SidebarSectionIds;
  const archived = await context.request.post(`${base}api/sidebar/tags`, {
    data: { ids: [ids.archived], set: { archived: null } },
  });
  expect(archived.ok()).toBe(true);
  return ids;
};
export const sectionOf = (page: Page, id: string) =>
  page.evaluate((id) => {
    const doc = (globalThis as any).document;
    let section = null;
    for (const el of doc.querySelectorAll(
      "#agent-list .tree-section-header, #agent-list .agent",
    )) {
      if (el.dataset.section)
        section = JSON.parse(el.dataset.sectionKey).slice(1).join("/");
      else if (el.dataset.id === id) return section;
    }
    return null;
  }, id);
export const edgesUncovered = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return [
      [box.left + 1, box.y + box.height / 2],
      [box.right - 1, box.y + box.height / 2],
      [box.x + box.width / 2, box.top + 1],
      [box.x + box.width / 2, box.bottom - 1],
    ].every(([x, y]) => {
      const hit = element.ownerDocument.elementFromPoint(x!, y!);
      return !!hit && element.contains(hit);
    });
  });
export const header = (page: Page, title: string) =>
  page.locator(
    `.tree-section-header[data-section-key='${JSON.stringify(["", title])}']`,
  );
export const serverTags = async (
  context: BrowserContext,
  base: string,
  id: string,
) =>
  ((await (await context.request.get(`${base}api/tree`)).json()) as any[]).find(
    (row) => row.id === id,
  ).tags;
