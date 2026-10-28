import { expect } from "bun:test";
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  runBrowserTests,
  themeColors,
  waitForLayout,
  type BrowserTest,
} from "./common";
import { compactConv, row, tree } from "./fixtures";
import { ConversationView } from "../../src/agents/view/conversation";
import captured from "../backend/fixtures/compaction/real-shapes.json";
import durableBoundary from "./fixtures/durable-compaction-boundary.json";
import durableUser from "./fixtures/durable-compaction-user.json";
import {
  projectionEntries,
  rowState,
} from "../../src/agents/durable/durable_rows";
import type { EntryRecord } from "@earendil-works/pi-durable";

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
        await gotoRoot(page, base);
        const divider = page.locator(".compacted-activity");
        const jump = page.locator(".compaction-jump-link");
        await jump.waitFor();
        expect(await divider.count()).toBe(0);
        expect(await jump.count()).toBe(1);
        expect(
          await page.locator(`[data-row-id="row:${keptMessageId}"]`).count(),
        ).toBe(0);
        await jump.click();
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
        const target = page.locator(
          `[data-row-id="row:${keptMessageId}"].file-jump-target`,
        );
        await target.waitFor();
        await waitForLayout(page);
        expect(
          await target.evaluate((element) => {
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
          await page.locator(".compacted-activity.file-jump-target").count(),
        ).toBe(0);
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
];

if (import.meta.main) await runBrowserTests([["compact-rows", tests]]);
