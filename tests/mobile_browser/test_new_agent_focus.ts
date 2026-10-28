import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gotoRoot, runBrowserTests, type BrowserTest } from "./common";

export const tests: BrowserTest[] = [
  // Regression: #2744 the sent message may paint after its new row is current. (also #2480 j moves the cursor without opening another conversation.; #2480 the displayed agent's trash cannot confirm another cursor's delete.; #2480 a vanished armed cursor must not confirm deletion of the displayed agent.)
  async function test_keyboard_actions_follow_the_open_conversation(
    browser,
    base,
  ) {
    for (const width of [1280, 412]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
      });
      const page = await context.newPage();
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const response = await page.request.post(`${base}api/conversations`, {
          data: { parent: null },
        });
        expect(response.ok()).toBe(true);
        ids.push((await response.json()).id);
      }
      await page.goto(`${base}#agent=${ids[1]}`);
      const selected = page.locator('.agent[aria-current="page"]');
      await selected.waitFor();
      if (width === 1280) await selected.focus();
      await page.locator("#new-top").click();
      await page.locator(".draft-row.cursor").waitFor();
      expect(
        await page.locator('.agent[data-id][aria-current="page"]').count(),
      ).toBe(0);
      expect(
        await page
          .locator("#input")
          .evaluate((input) => input.ownerDocument.activeElement === input),
      ).toBe(true);
      const created = page.waitForResponse(
        (response) =>
          response.url() === `${base}api/conversations` &&
          response.request().method() === "POST",
      );
      await page.locator("#input").fill("Focus newly created agent");
      await page.locator("#send").click();
      const response = await created;
      expect(response.ok()).toBe(true);
      const newId = (await response.json()).id as string;
      ids.push(newId);
      await page
        .locator(`.agent[data-id="${newId}"][aria-current="page"].cursor`)
        .waitFor();
      await page
        .locator("#messages:not([inert])", {
          hasText: "Focus newly created agent",
        })
        .waitFor();
      await page.locator("#input").press("Escape");
      if (width === 1280) await selected.focus();
      const order = await page
        .locator(".agent[data-id]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-id")!));
      const index = order.indexOf(newId);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(ids).toContain(order[index + 1]);
      expect(await selected.getAttribute("class")).toContain("cursor");
      await page.keyboard.press("j");
      const cursor = page.locator(".agent.cursor");
      let target = await cursor.getAttribute("data-id");
      expect(ids).toContain(target!);
      expect(target, JSON.stringify({ width, newId, ids, order, index })).toBe(
        order[index + 1],
      );
      expect(await selected.getAttribute("data-id")).toBe(newId);
      expect(new URL(page.url()).hash).toBe(`#agent=${newId}`);
      expect(await page.locator("#messages").textContent()).toContain(
        "Focus newly created agent",
      );
      if (width === 412) {
        await page.locator("#menu-btn").click();
        await page.waitForFunction(() => {
          const browser = globalThis as any;
          const rect = browser.document
            .querySelector("#sidebar")
            .getBoundingClientRect();
          return rect.left >= 0 && rect.right <= browser.innerWidth;
        });
      }
      const evidence = process.env.FOCUS_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: join(evidence, `cursor-after-j-${width}.png`),
        });
      }
      expect(await page.locator(".agent:focus").getAttribute("data-id")).toBe(
        target,
      );
      if (width === 412) {
        await page.locator("#menu-btn").click();
        await page.keyboard.press("Escape");
      }
      await page
        .locator("#messages:not([inert])")
        .waitFor({ state: "attached" });
      if (width === 1280) {
        await page.keyboard.press("d");
        await page.locator("#trash-btn").click();
        await page.locator(`.agent[data-id="${newId}"].cursor.armed`).waitFor();
        expect(await page.locator(`.agent[data-id="${target}"]`).count()).toBe(
          1,
        );
        await selected.focus();
        await page.keyboard.press("j");
        expect(await cursor.getAttribute("data-id")).toBe(target);
        await page.keyboard.press("d");
        const externalDelete = await page.request.delete(
          `${base}api/conversations/${target}`,
        );
        expect(externalDelete.ok()).toBe(true);
        await page
          .locator(`.agent[data-id="${target}"]`)
          .waitFor({ state: "detached" });
        await page
          .locator(`.agent[data-id="${newId}"].cursor:not(.armed)`)
          .waitFor();
        await selected.focus();
        await page.keyboard.press("d");
        await page.locator(`.agent[data-id="${newId}"].armed`).waitFor();
        await page.keyboard.press("Escape");
        await page.keyboard.press("j");
        target = await cursor.getAttribute("data-id");
        expect(ids).toContain(target!);
        expect(target).not.toBe(newId);
      }
      const deletion = page.waitForRequest(
        (request) => request.method() === "DELETE",
      );
      await page.keyboard.press("d");
      await page.keyboard.press("d");
      expect(new URL((await deletion).url()).pathname).toBe(
        `/api/conversations/${target}`,
      );
      await page.waitForFunction((id) => {
        const selected = (globalThis as any).document.querySelector(
          '.agent[aria-current="page"]',
        );
        return (
          selected &&
          selected.getAttribute("data-id") !== id &&
          selected.classList.contains("cursor")
        );
      }, target);
      if (width === 1280)
        expect(await page.locator(".agent:focus").getAttribute("data-id")).toBe(
          await selected.getAttribute("data-id"),
        );
      await page.waitForFunction(async (id) => {
        const response = await (globalThis as any).fetch("/api/tree");
        return (
          response.ok &&
          !(await response.json()).some((node: any) => node.id === id)
        );
      }, target);
      await page.keyboard.press("j");
      const opened = await cursor.getAttribute("data-id");
      expect(opened).not.toBe(newId);
      await page.keyboard.press("l");
      expect(await selected.getAttribute("data-id")).toBe(opened);
      expect(new URL(page.url()).hash).toBe(`#agent=${opened}`);
      await context.close();
    }
  },
  // Regression: #2480 a spawned child cannot steal the displayed parent's cursor. (also #2397 a pending delete cannot retarget keys to another agent.; #2397 deletion keeps selection on the nearest sibling.)
  async function test_delete_selects_next_sibling_without_retargeting_pending_keys(
    browser,
    base,
  ) {
    for (const width of [1280, 412]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
      });
      const page = await context.newPage();
      const create = async (title: string, parent: string | null) => {
        const response = await page.request.post(`${base}api/conversations`, {
          data: { parent },
        });
        expect(response.ok()).toBe(true);
        const id = (await response.json()).id as string;
        const rename = await page.request.post(
          `${base}api/conversations/${id}/rename`,
          { data: { title } },
        );
        expect(rename.ok()).toBe(true);
        return id;
      };
      const parent = await create("Delete parent", null);
      const next = await create("Delete next sibling", parent);
      const dying = await create("Delete displayed", parent);
      const previous = await create("Delete previous sibling", parent);
      await page.goto(`${base}#agent=${dying}`);
      await page
        .locator(`.agent[data-id="${dying}"][aria-current="page"]`)
        .waitFor();
      await page
        .locator("#messages:not([inert])")
        .waitFor({ state: "attached" });
      const child = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const spawn = await page.request.post(`${base}api/conversations/spawn`, {
        data: {
          id: child,
          parent: dying,
          title: "Agent-spawned child",
          prompt: "Reply briefly.",
        },
      });
      expect(spawn.ok()).toBe(true);
      await page
        .locator(`.agent[data-id="${child}"]`)
        .waitFor({ state: "attached" });
      expect(await page.locator(".agent.cursor").getAttribute("data-id")).toBe(
        dying,
      );
      expect(
        await page
          .locator('.agent[aria-current="page"]')
          .getAttribute("data-id"),
      ).toBe(dying);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let received!: () => void;
      const pending = new Promise<void>((resolve) => {
        received = resolve;
      });
      await page.route(`${base}api/conversations/${dying}`, async (route) => {
        if (route.request().method() !== "DELETE") return route.fallback();
        const response = await route.fetch();
        received();
        await gate;
        await route.fulfill({ response });
      });
      if (width === 1280) {
        await page.locator("#input").press("Escape");
        await page.locator(`.agent[data-id="${dying}"]`).focus();
        await page.keyboard.press("d");
        await page.keyboard.press("d");
      } else {
        await page.locator("#pane-fab").click();
        await page.locator("#trash-btn").click();
        await page.locator("#trash-btn").click();
      }
      await pending;
      expect(await page.locator(".agent.cursor").count()).toBe(0);
      expect(page.url()).toContain(dying);
      if (width === 412) await page.locator("#menu-btn").click();
      release();
      await page
        .locator(`.agent[data-id="${next}"][aria-current="page"].cursor`)
        .waitFor();
      expect(page.url()).toContain(next);
      expect(await page.locator(`.agent[data-id="${dying}"]`).count()).toBe(0);
      await page
        .locator("#messages:not([inert])")
        .waitFor({ state: "attached" });
      expect(await page.locator("#conv-title").textContent()).toBe(
        "Delete next sibling",
      );
      if (width === 1280)
        expect(await page.locator(".agent:focus").getAttribute("data-id")).toBe(
          next,
        );
      else {
        expect(await page.locator("#sidebar.open").count()).toBe(1);
        await page.waitForFunction(() => {
          const browser = globalThis as any;
          const rect = browser.document
            .querySelector("#sidebar")
            .getBoundingClientRect();
          return rect.left >= 0 && rect.right <= browser.innerWidth;
        });
      }
      const evidence = process.env.FOCUS_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: join(evidence, `delete-focus-${width}.png`),
        });
      }
      if (width === 412) await page.locator("#menu-btn").click();
      for (const neighbour of [previous, parent]) {
        await page
          .locator("#messages:not([inert])")
          .waitFor({ state: "attached" });
        if (width === 1280) {
          await page.keyboard.press("d");
          await page.keyboard.press("d");
        } else {
          if (!(await page.locator("#pane-menu.on").count()))
            await page.locator("#pane-fab").click();
          await page.locator("#trash-btn").click();
          await page.locator("#trash-btn").click();
        }
        await page
          .locator(`.agent[data-id="${neighbour}"][aria-current="page"].cursor`)
          .waitFor();
        expect(page.url()).toContain(neighbour);
      }
      await page.waitForFunction(
        async (ids) => {
          const response = await (globalThis as any).fetch("/api/tree");
          return (
            response.ok &&
            (await response.json()).every((node: any) => !ids.includes(node.id))
          );
        },
        [dying, previous, next],
      );
      await context.close();
    }
  },
  // Regression: #2397 draft promotion keeps its cursor until the tree catches up.
  async function test_new_agent_focus_after_tree_arrives(browser, base) {
    for (const width of [1280, 412]) {
      const context = await browser.newContext({
        viewport: { width, height: 800 },
      });
      const page = await context.newPage();
      await gotoRoot(page, base);
      for (let i = 0; i < 30; i++) {
        const response = await page.request.post(`${base}api/conversations`, {
          data: { title: `Existing ${i}`, parent: null },
        });
        expect(response.ok()).toBe(true);
      }
      await page.reload();
      await page.waitForFunction(
        "document.querySelectorAll('#agent-list .agent[data-id]').length >= 31",
      );
      for (const start of [
        "button",
        "keyboard",
        "deleted-before-tree",
      ] as const) {
        if (width === 412) await page.locator("#menu-btn").click();
        await page.locator("#agent-list").evaluate((list) => {
          list.scrollTop = list.scrollHeight;
        });
        if (width === 412) await page.locator("#menu-btn").click();
        if (start !== "keyboard") await page.locator("#new-top").click();
        else {
          await page.locator("#input").press("Escape");
          await page.keyboard.press("t");
          await page.keyboard.press("t");
        }
        await page.locator(".draft-row").waitFor({ state: "attached" });
        let releaseTree!: () => void;
        const treeGate = new Promise<void>((resolve) => {
          releaseTree = resolve;
        });
        await page.route(`${base}api/tree`, async (route) => {
          await treeGate;
          await route.continue();
        });
        const delivered = page.waitForResponse(
          (response) =>
            response.url().endsWith("/deliver") &&
            response.request().method() === "POST",
        );
        const created = page.waitForResponse(
          (response) =>
            response.url() === `${base}api/conversations` &&
            response.request().method() === "POST",
        );
        await page.locator("#input").fill("Hello new agent");
        await page.locator("#send").click();
        const { id } = await (await created).json();
        const delivery = await delivered;
        expect(await delivery.text()).toContain('"ok":true');
        await page.waitForFunction(
          (id) => (globalThis as any).location.hash.includes(id),
          id,
        );
        if (start === "deleted-before-tree") {
          const removed = await page.request.delete(
            `${base}api/conversations/${id}`,
          );
          expect(removed.ok()).toBe(true);
          releaseTree();
          await page.waitForFunction((id) => {
            const doc = (globalThis as any).document;
            const selected = doc.querySelector(
              '#agent-list .agent[aria-current="page"]',
            );
            return (
              selected &&
              selected.getAttribute("data-id") !== id &&
              selected.classList.contains("cursor")
            );
          }, id);
          await page.unroute(`${base}api/tree`);
          continue;
        }
        releaseTree();
        const row = page.locator(`#agent-list .agent[data-id="${id}"]`);
        await row.waitFor({ state: "attached" });
        expect(await row.getAttribute("aria-current")).toBe("page");
        expect(await row.getAttribute("class")).toContain("cursor");
        if (width === 412) await page.locator("#menu-btn").click();
        await page.waitForFunction((id) => {
          const browser = globalThis as any;
          const row = browser.document
            .querySelector(`#agent-list .agent[data-id="${id}"]`)
            .getBoundingClientRect();
          return row.left >= 0 && row.right <= browser.innerWidth;
        }, id);
        expect(
          await row.evaluate((el) => {
            const row = el.getBoundingClientRect();
            const list = el.closest("#agent-list")!.getBoundingClientRect();
            return row.top >= list.top && row.bottom <= list.bottom;
          }),
        ).toBe(true);
        const evidence = process.env.FOCUS_EVIDENCE_DIR;
        if (evidence) {
          await mkdir(evidence, { recursive: true });
          await page.screenshot({
            path: join(evidence, `focus-${width}-${start}.png`),
          });
        }
        await page.unroute(`${base}api/tree`);
        if (width === 412) await page.locator("#menu-btn").click();
      }
      await context.close();
    }
  },
];
if (import.meta.main) {
  if (process.argv.includes("--list"))
    console.log(tests.map((test) => test.name).join("\n"));
  else await runBrowserTests([["new-agent-focus", tests]]);
}
