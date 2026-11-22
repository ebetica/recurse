import { expect } from "bun:test";
import type { Locator } from "playwright";
declare const window: any;
declare const MutationObserver: any;
declare const requestAnimationFrame: any;
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  postFixture,
  recordJumpHighlight,
  runBrowserTests,
  themeColors,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { compactConv, row, tree } from "./fixtures";
import { ConversationView } from "../../src/agents/view/conversation";
import captured from "../backend/fixtures/compaction/real-shapes.json";
import { SERVER_COMPACTION_MARKER } from "../../src/extensions/core/context/server-compaction";
import durableBoundary from "./fixtures/durable-compaction-boundary.json";
import recorded from "./fixtures/durable-compaction-jump.json";
import durableUser from "./fixtures/durable-compaction-user.json";
import {
  projectionEntries,
  rowState,
} from "../../src/agents/durable/durable_rows";
import type { EntryRecord } from "@earendil-works/pi-durable";

const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;

async function openCompactedSummary(divider: Locator, text: string) {
  expect(await divider.locator(".disclosure-body").count()).toBe(0);
  await divider.locator(".compacted-head").click();
  await divider.locator(".disclosure-body").waitFor({ timeout: 15_000 });
  await divider.getByText(text, { exact: false }).first().waitFor();
}

export const tests: BrowserTest[] = [
  // Regression: #2831 retained user and tool boundaries jump without expanding compacted activity.
  async function test_recorded_compaction_summary_and_paged_jump(
    browser,
    base,
  ) {
    const entries = Array.from({ length: 65 }, (_, turn) => [
      {
        type: "message",
        id: `u${turn}`,
        parentId: turn ? `a${turn - 1}` : null,
        message: { role: "user", content: `Assignment ${turn}` },
      },
      ...(turn === 2
        ? [
            {
              type: "custom",
              id: "cut-meta",
              parentId: "u2",
              customType: "metadata",
              data: {},
            },
          ]
        : []),
      {
        type: "message",
        id: `a${turn}`,
        parentId: turn === 2 ? "cut-meta" : `u${turn}`,
        message: {
          role: "assistant",
          content:
            turn === 2
              ? [
                  {
                    type: "toolCall",
                    id: "read",
                    name: "read",
                    arguments: { path: "synthetic.ts" },
                  },
                ]
              : `Answer ${turn}`,
        },
      },
    ]).flat();
    for (const [width, cut] of [
      [390, "user"],
      [1280, "user"],
      [390, "tool"],
      [1280, "tool"],
      [390, "server"],
      [1280, "server"],
      [390, null],
      [1280, null],
    ] as const) {
      const durable = cut !== null;
      const recorded = durable
        ? projectionEntries(
            (cut === "user"
              ? durableUser
              : durableBoundary) as unknown as EntryRecord[],
            rowState(),
          )
        : width === 390
          ? captured.manual
          : captured.automatic;
      if (cut === "server")
        for (const entry of recorded)
          if (entry.type === "compaction")
            entry.summary = SERVER_COMPACTION_MARKER;
      const summaryId = durable
        ? cut === "user"
          ? "65997"
          : "71709"
        : width === 390
          ? "entry-31"
          : "entry-33";
      const keptMessageId = durable
        ? cut === "user"
          ? "65733"
          : "71480"
        : width === 390
          ? "entry-27"
          : "u0";
      const view = new ConversationView("main", "captured", "v");
      const completion = recorded.findIndex(
        (entry) => entry.customType === "recurse.compaction-notice",
      );
      view.ingest([
        ...recorded.slice(0, completion),
        ...entries,
        ...recorded.slice(completion),
      ]);
      const rows = view.window({ limit: 200 }).blocks;
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await page.route(`${base}api/tree*`, (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => ({
          ...compactConv(),
          status: "idle",
          rows,
        }));
        await page.clock.install();
        await gotoRoot(page, base);
        const divider = page.locator(".compacted-activity");
        const jump = page.locator(".compaction-jump-link");
        const kept = page.locator(`[data-row-id="row:${keptMessageId}"]`);
        await jump.waitFor();
        expect(await divider.count()).toBe(0);
        expect(await jump.count()).toBe(1);
        expect(await kept.count()).toBe(0);
        await page.evaluate((rowId) => {
          const browser = globalThis as any;
          const { document } = browser;
          const scroll = document.querySelector("#scroll");
          const order: string[] = (browser.keptJumpOrder = []);
          const once = (event: string) =>
            order.includes(event) || order.push(event);
          const row = () => document.querySelector(`[data-row-id="${rowId}"]`);
          browser.jumpTargets = [];
          new browser.MutationObserver(() => {
            for (const element of document.querySelectorAll(
              ".file-jump-target",
            ))
              browser.jumpTargets.push(element.dataset.rowId);
            if (row()?.classList.contains("file-jump-target")) once("add");
            else if (order.includes("add")) once("remove");
          }).observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ["class"],
          });
          scroll.addEventListener("scrollend", () => {
            if (!order.includes("add") || order.includes("scrollend")) return;
            once("scrollend");
            const box = row().getBoundingClientRect();
            const view = scroll.getBoundingClientRect();
            if (
              row().classList.contains("file-jump-target") &&
              box.top < view.bottom &&
              box.bottom > view.top
            )
              once("shown");
          });
        }, `row:${keptMessageId}`);
        await jump.click();
        await page.waitForFunction(() =>
          (globalThis as any).keptJumpOrder.includes("add"),
        );
        await page.clock.fastForward(2000);
        await page.waitForFunction(() =>
          (globalThis as any).keptJumpOrder.includes("remove"),
        );
        expect(
          await page.evaluate(() => (globalThis as any).keptJumpOrder),
        ).toEqual(["add", "scrollend", "shown", "remove"]);
        if (durable) {
          await divider.waitFor();
          await waitForLayout(page);
          const compactedActivity = divider.locator("..");
          expect(
            await compactedActivity.locator(".activity-group.open").count(),
          ).toBe(0);
          expect(
            await compactedActivity.locator(".turn-thinking-toggle").count(),
          ).toBe(0);
        }
        await waitForLayout(page);
        expect(
          await kept.evaluate((element) => {
            const browser = globalThis as any;
            const bounds = element.getBoundingClientRect();
            const viewport = browser.document
              .querySelector("#scroll")
              .getBoundingClientRect();
            return bounds.top < viewport.bottom && bounds.bottom > viewport.top;
          }),
        ).toBe(true);
        expect(await divider.getAttribute("data-row-id")).toBe(
          `row:${summaryId}`,
        );
        expect(await divider.locator(".disclosure-body").count()).toBe(0);
        expect(
          await page.evaluate(() => (globalThis as any).jumpTargets),
        ).not.toContain(`row:${summaryId}`);
        if (cut === "server") {
          expect(await divider.innerText()).toBe(SERVER_COMPACTION_MARKER);
          expect(await divider.locator("button").count()).toBe(0);
          await divider.scrollIntoViewIfNeeded();
          const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
          if (shots)
            await page.screenshot({
              path: `${shots}/server-compaction-${width}.png`,
            });
          expect(errors).toEqual([]);
          continue;
        }
        const head = divider.locator(".compacted-head");
        const [background] = await themeColors(page, "var(--panel-2)");
        expect(
          await head.evaluate((element) => {
            const style = (globalThis as any).getComputedStyle(element);
            return {
              border: style.borderTopWidth,
              background: style.backgroundColor,
              height: element.getBoundingClientRect().height,
            };
          }),
        ).toEqual({ border: "1px", background, height: 34 });
        expect(await head.getAttribute("aria-expanded")).toBe("false");
        const shots = process.env.RECURSE_BROWSER_SCREENSHOT_DIR;
        await divider.scrollIntoViewIfNeeded();
        if (shots)
          await page.screenshot({
            path: `${shots}/compaction-${width}-closed.png`,
          });
        await head.click();
        expect(await head.getAttribute("aria-expanded")).toBe("true");
        await divider
          .getByText("Captured compaction summary", { exact: true })
          .waitFor();
        await head.scrollIntoViewIfNeeded();
        if (shots)
          await page.screenshot({
            path: `${shots}/compaction-${width}-summary.png`,
          });
        expect(await head.getAttribute("aria-expanded")).toBe("true");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_compact_failure_replaces_pending_divider(browser, base) {
    for (const [viewport, isMobile, hasTouch] of [
      [{ width: 390, height: 844 }, true, true],
      [{ width: 1280, height: 800 }, false, false],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile,
        hasTouch,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await page.route(`${base}api/tree*`, (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => ({
          ...compactConv(),
          compacting: true,
          pending_actions: ["compact"],
        }));
        await gotoRoot(page, base);
        const failed = page.locator(".thread-marker", {
          hasText:
            "Compaction failed: instant-auth-unavailable. Retry with /compact",
        });
        await failed.waitFor();
        expect(await failed.count()).toBe(1);
        expect(await page.locator(".thread-marker.pending").count()).toBe(0);
        expect(
          await page
            .locator(".thread-marker", { hasText: "Compacting…" })
            .count(),
        ).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #2060 completed compaction replaces stale pending divider
  async function test_compaction_marker_replaces_stale_pending(browser, base) {
    const thread = {
      ...compactConv(),
      compacting: true,
      pending_actions: ["compact"],
      rows: [
        row("kept", "user", "Retained assignment"),
        row("final-compaction", "compaction", "Final summary", {
          kind: "marker",
          role: "compaction",
          meta: {
            compact_marker: true,
            body: "Context compacted at 27k tokens.",
            firstKeptEntryId: "kept",
          },
        }),
      ],
    };
    for (const [viewport, isMobile, hasTouch, customPending] of [
      [{ width: 390, height: 844 }, true, true, false],
      [{ width: 1280, height: 800 }, false, false, false],
      [{ width: 390, height: 844 }, true, true, true],
      [{ width: 1280, height: 800 }, false, false, true],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile,
        hasTouch,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await page.route(`${base}api/tree*`, (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => ({
          ...thread,
          rows: customPending
            ? [
                row("legacy-pending", "custom", "Compacting…", {
                  kind: "marker",
                  role: "custom",
                  meta: { compact_marker: true },
                }),
                row("intervening-reply", "assistant", "Compaction is running."),
                ...thread.rows,
              ]
            : thread.rows,
        }));
        await gotoRoot(page, base);
        expect(await page.locator(".thread-marker.pending").count()).toBe(0);
        expect(
          await page
            .locator(".thread-marker", { hasText: "Compacting…" })
            .count(),
        ).toBe(0);
        await page.locator(".compacted-activity").waitFor();
        expect(await page.locator(".compacted-activity").count()).toBe(1);
        expect(await page.locator(".compaction-jump-link").count()).toBe(0);
        await page.locator(".compacted-head").click();
        await page
          .locator(".disclosure-body")
          .getByText("Final summary", { exact: true })
          .waitFor();
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #2060 historical compaction cannot mask current action progress
  async function test_historical_compaction_does_not_hide_later_actions(
    browser,
    base,
  ) {
    for (const [
      pending_actions,
      compacting,
      expected,
      active,
      width,
      later = false,
    ] of [
      [["compact"], false, "Summarizing context…", false, 390],
      [
        ["clear"],
        true,
        "Deleting this history and starting fresh…",
        false,
        390,
      ],
      [["compact"], true, "Summarizing context…", false, 390],
      [["compact"], true, "Compacting…", true, 390],
      [["compact"], true, "Compacting…", true, 1280],
      [["compact"], true, "Summarizing context…", false, 390, true],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 800 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        const marker = row("old-compaction", "compaction", "Old summary", {
          kind: "marker",
          role: "compaction",
          meta: {
            compact_marker: true,
            body: "Context compacted at 20k tokens.",
          },
        });
        await page.route(`${base}api/tree*`, (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => ({
          ...compactConv(),
          status: "idle",
          compacting,
          pending_actions,
          rows: [
            ...(compacting &&
            !active &&
            pending_actions[0] === "compact" &&
            !later
              ? []
              : [marker]),
            ...(later ? [row("later-reply", "assistant", "Later reply")] : []),
            ...(active
              ? [
                  row("active-compaction", "custom", "Compacting…", {
                    kind: "marker",
                    role: "custom",
                    meta: { compact_marker: true },
                  }),
                ]
              : []),
          ],
        }));
        await gotoRoot(page, base);
        const pending = page.locator(".thread-marker", {
          hasText: expected,
        });
        await pending.waitFor();
        expect(await pending.count()).toBe(1);
        expect(await page.locator(".thread-marker.pending").count()).toBe(
          active ? 0 : 1,
        );
        expect(
          await page
            .locator(".thread-marker", { hasText: "Compacting…" })
            .count(),
        ).toBe(active ? 1 : 0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },

  // Feature: #2514 compaction jumps reveal the recorded kept message.
  async function test_durable_compaction_jump_reveals_first_recorded_kept_message(
    browser,
    base,
  ) {
    const [kept, input, summary, response] = recorded;
    const rows = [
      row("prior", "user", "Prior request"),
      row("prior-response", "assistant", "Prior response"),
      row(String(summary!.id), "compaction", summary!.text, {
        kind: "marker",
        meta: { compact_marker: true, firstKeptEntryId: String(summary!.head) },
      }),
      row(String(kept!.id), "user", kept!.text, {
        origin: "agent",
        sender: "sender",
      }),
      row("kept-response", "assistant", "Kept response"),
      row(String(input!.id), "user", input!.text),
      row(String(response!.id), "assistant", response!.text),
      row("notice", "compaction-notice", "Context compacted.", {
        kind: "marker",
        meta: { summaryEntryId: String(summary!.id) },
      }),
    ];
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = captureErrors(page);
    await mockConversation(page, base, "main", () => ({
      id: "main",
      title: "Recorded compaction",
      parent: null,
      backend: "durable",
      status: "idle",
      msg_count: rows.length,
      rows,
    }));
    await gotoRoot(page, base);
    const jump = page.locator(".compaction-jump-link");
    await jump.waitFor();
    expect(await page.getByText(kept!.text, { exact: true }).count()).toBe(0);
    const highlighted = await recordJumpHighlight(page);
    await jump.click();
    expect(await highlighted()).toBe(`row:${kept!.id}`);
    if (shots)
      await page.screenshot({ path: `${shots}/durable-first-kept.png` });
    expect(await page.getByText(kept!.text, { exact: true }).isVisible()).toBe(
      true,
    );
    expect(await jump.innerText()).toBe("Jump to first kept message");
    expect(errors).toEqual([]);
    await page.close();
  },

  // Regression: #2874 #3348 restore readers and resize after live work settles.
  async function test_durable_jump_pages_past_compaction(browser, base) {
    for (const width of [390, 1280]) {
      const mobile = width === 390;
      const { agent } = await postFixture(base, "seed-durable-history", {
        agent: `durable-history-${width}`,
        neighbours: 8,
      });
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        hasTouch: mobile,
        isMobile: mobile,
      });
      const errors = captureErrors(page);
      await page.goto(`${base}#agent=${agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByText("Answer 69", { exact: true }).waitFor();
      const jump = page.locator(".compaction-jump-link");
      await jump.waitFor();
      if (shots)
        await page.screenshot({ path: `${shots}/durable-notice-${width}.png` });
      const highlighted = await recordJumpHighlight(page);
      await jump.click();
      await highlighted();
      const divider = page.locator(".compacted-activity");
      await openCompactedSummary(divider, "Summary of turns 0-19.");
      const top = async (text: string) =>
        (await page.getByText(text, { exact: true }).boundingBox())!.y;
      const at = (await divider.boundingBox())!.y;
      expect(at).toBeLessThan(await top("Answer 40"));
      expect(await page.getByText("Answer 25", { exact: true }).count()).toBe(
        1,
      );
      if (shots)
        await page.screenshot({
          path: `${shots}/durable-summary-${width}.png`,
        });
      const open = async (id: string, title: string) => {
        if (mobile) await page.locator("#menu-btn").click();
        await page.locator(`.agent[data-id="${id}"]`).click();
        await page.locator("#conv-title", { hasText: title }).waitFor();
        await page
          .locator("#conv-freshness:not(.on)")
          .waitFor({ state: "attached" });
      };
      await postFixture(base, "durable-history-more", {
        agent,
        from: 70,
        to: 71,
        report: true,
      });
      await postFixture(base, "durable-history-more", {
        agent,
        from: 71,
        to: 76,
      });
      const turn = page.locator(".activity-boundary", { hasText: "Answer 70" });
      await turn.locator(".activity-group-toggle").click();
      const report = await turn
        .locator(".agent-message[data-row-id]")
        .getAttribute("data-row-id");
      const reader = page.locator(`#scroll [data-row-id="${report}"]`);
      const readerTop = () =>
        reader.evaluate(
          (row) =>
            row.getBoundingClientRect().top -
            document.querySelector("#scroll")!.getBoundingClientRect().top,
        );
      await waitForLayout(page);
      await reader.evaluate((row) => {
        row.scrollIntoView({ block: "start" });
        document.querySelector("#scroll")!.scrollTop += 4;
      });
      await waitForLayout(page);
      const left = await readerTop();
      expect(left).toBeCloseTo(-4, 0);
      if (mobile) {
        await page.getByText("Answer 75", { exact: true }).waitFor();
        await page.locator("#live-bar[hidden]").waitFor({ state: "attached" });
        await waitForLayout(page);
        const viewport = page.viewportSize()!;
        const paneHeight = await page
          .locator("#scroll")
          .evaluate((element) => element.clientHeight);
        for (const height of [viewport.height + 1, viewport.height]) {
          await page.setViewportSize({ ...viewport, height });
          await waitForLayout(page);
          const after = await readerTop();
          const resizedHeight = await page
            .locator("#scroll")
            .evaluate((element) => element.clientHeight);
          expect(resizedHeight).toBe(paneHeight + height - viewport.height);
          expect(after).toBeCloseTo(left, 0);
        }
      }
      for (let n = 0; n < 8; n += 1)
        await open(`${agent}-${n}`, `Neighbour ${n}`);
      await postFixture(base, "durable-history-more", {
        agent,
        from: 76,
        to: 128,
        compact: true,
      });
      await open(agent, "Durable history");
      await page.getByText("Answer 127", { exact: true }).waitFor();
      await reader.waitFor();
      await waitForLayout(page);
      expect(await readerTop()).toBeCloseTo(left, 0);
      const fromBottom = () =>
        page.evaluate(() => {
          const scroll = document.querySelector("#scroll")!;
          return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
        });
      const beforeJump = await page
        .locator("#scroll")
        .evaluate((el) => el.scrollTop);
      await page.locator("#scroll-btn.visible").click();
      await page.waitForFunction((before) => {
        const scroll = document.querySelector("#scroll")!;
        return (
          scroll.scrollTop > before &&
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 140
        );
      }, beforeJump);
      await postFixture(base, "durable-history-more", {
        agent,
        from: 128,
        to: 129,
      });
      await page.getByText("Answer 128", { exact: true }).waitFor();
      await page.waitForFunction(() => {
        const scroll = document.querySelector("#scroll")!;
        return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 1;
      });
      await open("main", "Agent");
      await postFixture(base, "durable-history-more", {
        agent,
        from: 129,
        to: 130,
      });
      await open(agent, "Durable history");
      await page.getByText("Answer 129", { exact: true }).waitFor();
      await waitForLayout(page);
      expect(await fromBottom()).toBeLessThan(1);
      expect(errors).toEqual([]);
      await page.close();
    }
  },

  // Regression: #3341 #3313 #3317 keep following after a hidden jump.
  async function test_durable_operator_compact_two_places(browser, base) {
    const { agent } = await postFixture(base, "seed-durable-compactable");
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    const errors = captureErrors(page);
    await page.goto(`${base}#agent=${agent}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByText("Reply 29", { exact: true }).waitFor();
    const composer = page.locator("#input");
    await composer.fill("/compact");
    await page
      .locator("#skill-menu .skill-option.action", { hasText: "/compact" })
      .waitFor();
    const response = page.waitForResponse(
      `${base}api/conversations/${agent}/compact`,
    );
    await composer.press("Escape");
    await composer.press("Enter");
    expect((await response).ok()).toBe(true);
    const compacting = page.locator(".thread-marker", {
      hasText: "Compacting…",
    });
    await compacting.waitFor({ timeout: 10_000 });
    expect(await compacting.count()).toBe(1);
    if (shots)
      await page.screenshot({ path: `${shots}/durable-compacting.png` });
    await postFixture(base, "release", { agent, gate: "reply" });
    const jump = page.locator(".compaction-jump-link");
    await jump.waitFor({ timeout: 15_000 });
    await compacting.waitFor({ state: "detached" });
    const notice = (await jump.boundingBox())!.y;
    expect(notice).toBeGreaterThan(
      (await page.getByText("Reply 29", { exact: true }).boundingBox())!.y,
    );
    expect(
      await page
        .getByText("Your context was just compacted", {
          exact: false,
        })
        .count(),
    ).toBe(0);
    if (shots)
      await page.screenshot({ path: `${shots}/durable-compact-notice.png` });
    const highlighted = await recordJumpHighlight(page);
    await jump.click();
    const kept = page.locator(`[data-row-id="${await highlighted()}"]`);
    const inView = (row: any) => {
      const box = row.getBoundingClientRect();
      const view = document.querySelector("#scroll")!.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom;
    };
    await waitForLayout(page);
    expect(await kept.evaluate(inView)).toBe(true);
    const divider = page.locator(".compacted-activity");
    await openCompactedSummary(divider, "Summary of the early tasks.");
    expect((await divider.boundingBox())!.y).toBeLessThan(
      (await page.getByText("Reply 29", { exact: true }).boundingBox())!.y,
    );
    if (shots) {
      await divider.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: `${shots}/durable-compact-summary.png` });
    }
    const scroller = page.locator("#scroll");
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await waitForLayout(page);
    await scroller.evaluate((el) => {
      const started = new MutationObserver((changes: any[]) => {
        if (
          !changes.some(
            (change) =>
              !change.oldValue?.split(" ").includes("file-jump-target") &&
              change.target.classList.contains("file-jump-target"),
          )
        )
          return;
        started.disconnect();
        el.style.display = "none";
        const show = () => {
          el.style.display = "";
          window.__shownAgain = true;
        };
        requestAnimationFrame(() => requestAnimationFrame(show));
      });
      started.observe(document.querySelector("#messages"), {
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
        attributeOldValue: true,
      });
    });
    await jump.click();
    await page.waitForFunction(() => window.__shownAgain);
    await waitForLayout(page);
    await postFixture(base, "durable-history-more", {
      agent,
      from: 30,
      to: 31,
    });
    const answer = page.getByText("Answer 30", { exact: true });
    await answer.waitFor();
    await waitForLayout(page);
    expect(await answer.evaluate(inView)).toBe(true);
    await scroller.evaluate((el) => (el.scrollTop -= el.clientHeight));
    await waitForLayout(page);
    const again = await recordJumpHighlight(page);
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await jump.click();
    await postFixture(base, "durable-history-more", {
      agent,
      from: 31,
      to: 32,
    });
    await page.getByText("Answer 31", { exact: true }).waitFor();
    await scroller.evaluate((el) => {
      const start = el.scrollTop;
      const shift = () => {
        if (Math.abs(el.scrollTop - start) <= 1) return;
        el.removeEventListener("scroll", shift);
        el.style.paddingBottom = "1px";
      };
      el.addEventListener("scroll", shift);
    });
    await page.clock.resume();
    const target = page.locator(`[data-row-id="${await again()}"]`);
    await target.and(page.locator(".file-jump-target")).waitFor({
      state: "detached",
    });
    await waitForLayout(page);
    expect(await target.evaluate(inView)).toBe(true);
    expect(errors).toEqual([]);
  },
];

if (import.meta.main) await runBrowserTests([["compact-rows", tests]]);
