import { expect } from "bun:test";
import { mkdir } from "node:fs/promises";
declare const getComputedStyle: any;
import { row, tree } from "./fixtures";
import steeredOperatorRows from "../web/fixtures/steered-operator-rows.json";
import {
  gotoRoot,
  mockConversation,
  waitForLayout,
  type BrowserTest,
} from "./common";

const tool = (id: string) =>
  row(id, "tool", "", {
    kind: "tool_call",
    origin: "tool",
    name: "read",
    args: JSON.stringify({ path: `${id}.ts` }),
    result: "Read complete",
    stat: { kind: "read", lines: 1, from: 1, to: 1 },
  });
export const normalGroupRows = (parent = false) => [
  row(
    "assignment",
    "user",
    "Implement the assigned change.",
    parent
      ? { origin: "agent", sender: "parent", sender_name: "Coordinator" }
      : {},
  ),
  tool("pre-1"),
  tool("pre-2"),
  row("first", "assistant", "First reply stays visible."),
  tool("middle-1"),
  row("middle", "assistant", "Middle reply belongs to activity."),
  tool("middle-2"),
  row("final", "assistant", "Final reply stays visible."),
];

const resizeNote =
  "[Image: original 1008x2244, displayed at 898x2000. Multiply coordinates by 1.12 to map to original image.]";

export const wakeGroupRows = (count: number) => [
  row("assignment", "user", "Track incoming reports."),
  row("initial", "assistant", "I will track the reports."),
  ...Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const text =
      n === 1
        ? `${resizeNote}\nReport ${n} with a deliberately long folded activity header that reaches toward the close arrow`
        : `Report ${n}`;
    return [
      row(`wake-${n}`, "user", text, {
        origin: n % 2 ? "agent" : "platform",
        sender: n % 2 ? "child" : undefined,
        meta: { delivery: "steer" },
      }),
      row(`first-${n}`, "assistant", `Wake ${n} first.`),
      tool(`call-${n}`),
      row(`final-${n}`, "assistant", `Wake ${n} final.`),
    ];
  }).flat(),
];

const thought = (id: string, title: string) =>
  row(id, "assistant", "", { has_thinking: true, thinking_title: title });
export const singleReplyRows = () => [
  row("operator", "user", "Please review the sample text."),
  ..."read bash read bash bash bash bash bash bash bash write bash bash bash"
    .split(" ")
    .flatMap((name, index) => [
      ...([0, 1, 3, 6, 10, 13].includes(index)
        ? [thought(`thinking-${index}`, `Step ${index}`)]
        : []),
      row(`call-${index}`, "tool", "", {
        kind: "tool_call",
        origin: "tool",
        name,
        args: JSON.stringify({ path: `${index}.txt` }),
        result: "done",
        stat: { kind: name === "bash" ? "shell" : name, lines: 1 },
      }),
    ]),
  row("final", "assistant", "The sample is ready. Should I continue?", {
    has_thinking: true,
  }),
];

export const turnGroupTests: BrowserTest[] = [
  // Feature: #2318 folded replies expose their text size without a thoughts count.
  async function test_hidden_reply_words_in_summary(browser, base) {
    const summaries: string[] = [];
    for (const width of [412, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const rows = normalGroupRows();
        rows[5].has_thinking = true;
        rows[5].thinking_title = "Reviewing the change";
        await page.route(base + "api/tree", (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => ({
          id: "main",
          status: "idle",
          rows,
        }));
        await gotoRoot(page, base);
        const summary = page.locator(".activity-group-summary .turn-summary");
        await summary.waitFor();
        summaries.push(await summary.innerText());
        expect(
          await page.getByText(rows[3].text, { exact: true }).isVisible(),
        ).toBeTrue();
        expect(
          await page.getByText(rows[7].text, { exact: true }).isVisible(),
        ).toBeTrue();
        expect(
          await page.getByText(rows[5].text, { exact: true }).count(),
        ).toBe(0);
        expect(
          await summary.evaluate((el) => {
            const style = (
              el.ownerDocument.defaultView as any
            ).getComputedStyle(el);
            return (
              el.getBoundingClientRect().height <=
              parseFloat(style.lineHeight) + 1
            );
          }),
        ).toBeTrue();
        if (process.env.HIDDEN_REPLY_SHOTS) {
          await mkdir(process.env.HIDDEN_REPLY_SHOTS, { recursive: true });
          await page.screenshot({
            path: `${process.env.HIDDEN_REPLY_SHOTS}/${width}.png`,
          });
        }
      } finally {
        await page.close();
      }
    }
    for (const summary of summaries) {
      expect(summary).toBe("1 reply, 5 words hidden · read 4 files");
      expect(summary).not.toMatch(/\d+ thoughts?/);
    }
  },

  async function test_recorded_operator_steering_one_footer(browser, base) {
    const page = await browser.newPage({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      await page.route(base + "api/tree", (route) =>
        route.fulfill({ json: tree() }),
      );
      await mockConversation(page, base, "main", () => ({
        id: "main",
        status: "idle",
        rows: steeredOperatorRows.slice(0, 7),
      }));
      await gotoRoot(page, base);
      await page.locator(".activity-group-toggle").first().waitFor();
      await page.locator("#scroll").evaluate((el) => {
        el.scrollTop = 0;
      });
      if (process.env.STEER_GROUP_SHOT) {
        await mkdir(process.env.STEER_GROUP_SHOT, { recursive: true });
        await page.screenshot({
          path: `${process.env.STEER_GROUP_SHOT}/closed.png`,
        });
      }
      expect(
        await page
          .getByText(steeredOperatorRows[6].text, { exact: true })
          .count(),
      ).toBe(1);
      expect(await page.locator(".activity-group-toggle").count()).toBe(1);
      const operator = page.locator("#messages > .activity-boundary").first();
      expect(await operator.locator(".turn-foot").count()).toBe(1);
      expect(
        await operator
          .getByText(steeredOperatorRows[6].text, { exact: true })
          .count(),
      ).toBe(1);
      await page.locator(".activity-group-toggle").first().click();
      const first = page.locator(".activity-group").first();
      expect(
        await first.getByText("Read 1 file", { exact: true }).count(),
      ).toBe(1);
      if (process.env.STEER_GROUP_SHOT)
        await page.screenshot({
          path: `${process.env.STEER_GROUP_SHOT}/opened.png`,
        });
    } finally {
      await page.close();
    }
  },

  async function test_hide_chevron_straddles_cutout_border(browser, base) {
    const measurements: {
      centreError: number;
      overlaps: boolean;
      hit: boolean;
      footerGap: number;
      headerInset: number;
    }[] = [];
    for (const [name, viewport] of [
      ["phone", { width: 412, height: 915 }],
      ["desktop", { width: 1280, height: 900 }],
    ] as const) {
      const page = await browser.newPage({ viewport });
      try {
        await page.route(base + "api/tree", (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => ({
          id: "main",
          status: "idle",
          rows: [...normalGroupRows(), ...wakeGroupRows(1)],
        }));
        await gotoRoot(page, base);
        const group = page.locator(".activity-group").last();
        await group.locator(".activity-group-toggle").click();
        const hide = group.getByRole("button", {
          name: "Hide activity",
          exact: true,
        });
        await hide.scrollIntoViewIfNeeded();
        const button = (await hide.boundingBox())!;
        const surface = (await group
          .locator(".activity-group-body")
          .boundingBox())!;
        const header = (await group
          .locator(".agent-message-row")
          .first()
          .boundingBox())!;
        const footer = (await page
          .locator(".turn-foot-actions")
          .first()
          .boundingBox())!;
        const hitTop = await hide.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const extension = getComputedStyle(element, "::before");
          return box.y + parseFloat(extension.top || "0");
        });
        measurements.push({
          footerGap: hitTop - footer.y - footer.height,
          headerInset: surface.x + surface.width - header.x - header.width,
          centreError: Math.abs(button.y + button.height / 2 - surface.y),
          hit: false,
          overlaps:
            button.x < header.x + header.width &&
            button.x + button.width > header.x &&
            button.y < header.y + header.height &&
            button.y + button.height > header.y,
        });
        if (process.env.HIDE_BORDER_SHOTS) {
          await mkdir(process.env.HIDE_BORDER_SHOTS, { recursive: true });
          await page.screenshot({
            path: `${process.env.HIDE_BORDER_SHOTS}/${name}.png`,
          });
        }
        await page.mouse.click(button.x + button.width / 2, button.y - 8);
        measurements.at(-1)!.hit =
          (await group
            .locator(".activity-group-toggle")
            .getAttribute("aria-expanded")) === "false";
      } finally {
        await page.close();
      }
    }
    for (const measurement of measurements) {
      expect(measurement.centreError).toBeLessThanOrEqual(2);
      expect(measurement.overlaps).toBe(false);
      expect(measurement.hit).toBe(true);
      expect(measurement.footerGap).toBeGreaterThanOrEqual(0);
      expect(measurement.headerInset).toBeLessThanOrEqual(14);
    }
  },
  async function test_v_opens_activity_and_preserves_manual_rows(
    browser,
    base,
  ) {
    const page = await browser.newPage();
    try {
      const rows = [0, 1, 2].flatMap((n) =>
        normalGroupRows().map((entry) => ({
          ...entry,
          id: `${n}-${entry.id}`,
        })),
      );
      await page.route(base + "api/tree", (route) =>
        route.fulfill({ json: tree() }),
      );
      await mockConversation(page, base, "main", () => ({
        id: "main",
        status: "idle",
        rows,
      }));
      await gotoRoot(page, base);
      const groups = page.locator(".activity-group-toggle");
      await groups.last().waitFor();
      await groups.last().click();
      const states = () =>
        groups.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-expanded")),
        );
      expect(await states()).toEqual(["false", "false", "true"]);
      await page.keyboard.press("v");
      expect(await states()).toEqual(["true", "true", "true"]);
      expect(await page.locator(".turn-tool").count()).toBe(0);
      await page.keyboard.press("v");
      expect(await states()).toEqual(["false", "false", "true"]);
      await page.keyboard.press("Enter");
      expect(await states()).toEqual(["false", "false", "false"]);
      await page.keyboard.press("Space");
      expect(await states()).toEqual(["false", "false", "true"]);
      await page.locator("#scroll").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.keyboard.press("G");
      await page.waitForFunction(`(() => {
        const el = document.querySelector('#scroll');
        return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
      })()`);
      expect(
        await page
          .locator("#scroll")
          .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
      ).toBeLessThanOrEqual(2);
    } finally {
      await page.close();
    }
  },
  // Regression: #2513 hanging block controls must stay inside the viewport when toggled.
  async function test_block_footer_expands_all_and_scopes_usage(browser, base) {
    for (const mobile of [false, true]) {
      const page = await browser.newPage({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        hasTouch: mobile,
      });
      try {
        const history = Array.from({ length: 15 }, (_, n) => [
          row(`history-input-${n}`, "user", `Earlier assignment ${n}`),
          row(`history-reply-${n}`, "assistant", `Earlier reply ${n}`),
        ]).flat();
        const usage = (input: number) => ({
          input,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        });
        const grouped = normalGroupRows();
        grouped.at(-1)!.usage = usage(100);
        const shapes = {
          turn: [
            ...history,
            ...singleReplyRows().map((entry) => ({
              ...entry,
              id: `single-${entry.id}`,
            })),
            ...grouped,
            row("usage-only", "user", "How many files?"),
            row("usage-only-reply", "assistant", "Four files.", {
              usage: usage(400),
            }),
            row("plain", "user", "Thanks."),
            row("plain-reply", "assistant", "You are welcome."),
          ],
          chunk: [...history, ...wakeGroupRows(3)],
          short: normalGroupRows(),
        };
        let rows: any[] = [];
        await page.route(base + "api/tree", (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => ({
          id: "main",
          title: "Block footer",
          status: "idle",
          rows,
        }));
        for (const [shape, next] of Object.entries(shapes)) {
          rows = next;
          await gotoRoot(page, base);
          await page.reload();
          await page.getByText(rows.at(-1).text, { exact: true }).waitFor();
          const block = (text: string) =>
            page
              .locator("#messages > .activity-boundary")
              .filter({ hasText: text });
          const top = async (locator: any) =>
            (await locator.boundingBox())!.y as number;
          const press = async (locator: any) => {
            await locator.scrollIntoViewIfNeeded();
            const before = await top(locator);
            const expanded = await locator.getAttribute("aria-expanded");
            if (mobile) await locator.tap();
            else await locator.click();
            await page.waitForFunction(
              ({ node, expanded }) =>
                node.getAttribute("aria-expanded") !== expanded,
              { node: await locator.elementHandle(), expanded },
            );
            await waitForLayout(page);
            if (shape !== "short")
              expect(
                Math.abs((await top(locator)) - before),
              ).toBeLessThanOrEqual(2);
            const box = (await locator.boundingBox())!;
            const view = (await page.locator("#scroll").boundingBox())!;
            expect(box.y).toBeGreaterThanOrEqual(view.y);
            expect(box.y + box.height).toBeLessThanOrEqual(
              view.y + view.height,
            );
          };
          if (shape === "turn") {
            expect(
              await block("You are welcome.").locator(".turn-foot").count(),
            ).toBe(0);
            const usageOnly = block("Four files.").locator(".turn-foot");
            expect(
              await usageOnly.locator(".turn-tokens").getAttribute("title"),
            ).toBe("View activity token usage: 410 model tokens");
            expect(await usageOnly.locator(".turn-expand").count()).toBe(0);
            expect(await page.locator(".msg.user button").count()).toBe(0);
          }
          const target = block(
            shape === "chunk" ? "Wake 3 final." : "Final reply stays visible.",
          );
          const foot = target.locator(".turn-foot");
          const expand = foot.locator(".turn-expand");
          const usageButton = foot.locator(".turn-tokens");
          expect(await foot.count()).toBe(1);
          if (shape === "turn")
            expect(await usageButton.getAttribute("title")).toBe(
              "View activity token usage: 110 model tokens",
            );
          const sections = target.locator(
            ".activity-group-toggle, .turn-series-toggle, .agent-message-row",
          );
          const states = () =>
            sections.evaluateAll((nodes) =>
              nodes.map((node) => node.getAttribute("aria-expanded")),
            );
          expect(new Set(await states())).toEqual(new Set(["false"]));
          await press(expand);
          expect(await expand.getAttribute("aria-expanded")).toBe("true");
          expect(await expand.getAttribute("aria-label")).toBe("Collapse all");
          const opened = await states();
          expect(opened.length).toBe(shape === "chunk" ? 7 : 4);
          expect(new Set(opened)).toEqual(new Set(["true"]));
          expect(await target.locator(".turn-tool").count()).toBe(
            shape === "chunk" ? 3 : 4,
          );
          expect(await target.locator(".agent-message-body").count()).toBe(
            shape === "chunk" ? 3 : 0,
          );
          let grown = target;
          if (shape === "chunk") {
            rows = [...history, ...wakeGroupRows(4)];
            await page.getByText("Wake 4 final.", { exact: true }).waitFor();
            grown = block("Wake 4 final.");
            const all = await grown
              .locator(
                ".activity-group-toggle, .turn-series-toggle, .agent-message-row",
              )
              .evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute("aria-expanded")),
              );
            expect(all.length).toBe(9);
            expect(new Set(all)).toEqual(new Set(["true"]));
          }
          const close = grown.locator(".turn-foot .turn-expand");
          await press(close);
          expect(await close.getAttribute("aria-label")).toBe("Expand all");
          expect(await grown.locator(".turn-tool").count()).toBe(0);
          if (shape === "chunk") continue;
          expect(new Set(await states())).toEqual(new Set(["false"]));
          if (shape === "turn") {
            const single = block("The sample is ready. Should I continue?");
            await press(single.locator(".turn-foot .turn-expand"));
            expect(await single.locator(".turn-tool").count()).toBe(14);
            expect(
              await single.locator(".turn-thinking-toggle").count(),
            ).toBeGreaterThan(0);
            expect(
              await single
                .locator('.turn-thinking-toggle[aria-expanded="true"]')
                .count(),
            ).toBe(0);
            expect(await single.locator(".turn-thinking-body").count()).toBe(0);
            await usageButton.click();
            const modal = page.locator("#prompt-body");
            await modal
              .getByRole("button", { name: "View delivered input" })
              .waitFor();
            expect(await modal.innerText()).toContain("Totals for 1 turn");
            await page.keyboard.press("Escape");
          }
        }
        rows = [
          normalGroupRows()[0],
          ...Array.from({ length: 105 }, (_, index) => tool(`paged-${index}`)),
          ...normalGroupRows().slice(3, -1),
          row("paged-tail", "assistant", "Paged final padding. ".repeat(500)),
        ];
        await page.reload();
        const paged = page.locator(".turn-foot .turn-expand");
        await paged.waitFor();
        await paged.evaluate((element) => (element as any).click());
        await page
          .getByText("Implement the assigned change.", { exact: true })
          .waitFor();
        await page.waitForFunction(
          "document.querySelectorAll('.turn-tool').length === 107",
        );
        expect(
          await page
            .locator(
              '.activity-group-toggle[aria-expanded="false"], .turn-series-toggle[aria-expanded="false"]',
            )
            .count(),
        ).toBe(0);
        expect(await paged.getAttribute("aria-expanded")).toBe("true");
      } finally {
        await page.close();
      }
    }
  },
  async function test_activity_row_reads_in_entry_order(browser, base) {
    for (const mobile of [false, true]) {
      const page = await browser.newPage({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        hasTouch: mobile,
      });
      try {
        for (const shape of ["single", "multi"] as const) {
          const rows = [
            ...Array.from({ length: 15 }, (_, n) => [
              row(`history-input-${n}`, "user", `Earlier assignment ${n}`),
              row(`history-reply-${n}`, "assistant", `Earlier reply ${n}`),
            ]).flat(),
            ...(shape === "single" ? singleReplyRows() : normalGroupRows()),
          ];
          await page.route(base + "api/tree", (route) =>
            route.fulfill({ json: tree() }),
          );
          await mockConversation(page, base, "main", () => ({
            id: "main",
            title: "Activity",
            status: "idle",
            rows,
          }));
          await gotoRoot(page, base);
          await page.reload();
          const text = (value: string) =>
            page.getByText(value, { exact: true });
          const operator = text(rows[30].text);
          const firstReply = text("First reply stays visible.");
          const finalReply = text(rows.at(-1)!.text);
          await finalReply.waitFor();
          const group = page.locator(".activity-group").last();
          const summary = group.locator(":scope > .activity-group-summary");
          const toggle = summary.locator(".activity-group-toggle");
          const box = async (locator: typeof toggle) =>
            (await locator.boundingBox())!;
          await summary.scrollIntoViewIfNeeded();
          const assertClosed = async () => {
            const rowBox = await box(summary);
            const tops = [await box(operator)];
            if (shape === "multi") {
              expect(await firstReply.count()).toBe(1);
              tops.push(await box(firstReply));
            }
            for (const before of tops)
              expect(before.y + before.height).toBeLessThanOrEqual(rowBox.y);
            expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(
              (await box(finalReply)).y,
            );
            expect(await toggle.getAttribute("aria-expanded")).toBe("false");
          };
          await assertClosed();
          const closedReply = shape === "multi" ? await box(firstReply) : null;
          const shot = async (state: string) => {
            if (process.env.AGENT_ACTIVITY_SHOTS && mobile)
              await page.screenshot({
                path: `${process.env.AGENT_ACTIVITY_SHOTS}/${shape}-reply-${state}.png`,
              });
          };
          await shot("closed");
          const press = async () => {
            const target = await box(toggle);
            const expanded = await toggle.getAttribute("aria-expanded");
            const before = (await box(summary)).y;
            const x = target.x + target.width - 4;
            const y = target.y + target.height / 2;
            if (mobile) await page.touchscreen.tap(x, y);
            else await page.mouse.click(x, y);
            await page.waitForFunction(
              ({ node, expanded }) =>
                node.getAttribute("aria-expanded") !== expanded,
              { node: await toggle.elementHandle(), expanded },
            );
            await waitForLayout(page);
            expect(
              Math.abs((await box(summary)).y - before),
            ).toBeLessThanOrEqual(2);
            expect(
              await toggle.evaluate(
                (element) => element.ownerDocument.activeElement === element,
              ),
            ).toBeTrue();
          };
          expect((await box(toggle)).width).toBe((await box(summary)).width);
          expect(await summary.locator("button").count()).toBe(1);
          await press();
          expect(await toggle.getAttribute("aria-expanded")).toBe("true");
          const body = group.locator(":scope > .activity-group-body");
          const opened = await box(body);
          const rowBox = await box(summary);
          expect(
            (await box(operator)).y + (await box(operator)).height,
          ).toBeLessThanOrEqual(opened.y);
          expect(opened.y + opened.height).toBeLessThanOrEqual(rowBox.y);
          expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(
            (await box(finalReply)).y,
          );
          const runs = body.locator(".turn-series-toggle");
          if (shape === "multi") {
            expect(await firstReply.count()).toBe(1);
            const reply = await box(firstReply);
            expect(reply.x).toBe(closedReply!.x);
            expect(reply.width).toBe(closedReply!.width);
            expect((await box(runs.first())).y).toBeLessThan(reply.y);
            expect(reply.y).toBeLessThan(
              (await box(text("Middle reply belongs to activity."))).y,
            );
            expect(
              await firstReply.evaluate(
                (element) => element.closest(".activity-group-body") !== null,
              ),
            ).toBeTrue();
          } else expect(await runs.count()).toBeGreaterThan(0);
          await shot("open");
          await press();
          await assertClosed();
          if (closedReply) {
            const reply = await box(firstReply);
            expect([reply.x, reply.width]).toEqual([
              closedReply.x,
              closedReply.width,
            ]);
          }
        }
      } finally {
        await page.close();
      }
    }
  },

  async function test_groups_open_upward_with_minimized_rows_and_anchored_controls(
    browser,
    base,
  ) {
    for (const mobile of [false, true]) {
      const page = await browser.newPage({
        viewport: mobile
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
        hasTouch: mobile,
      });
      try {
        for (const historyCount of [0, 15]) {
          const history = Array.from({ length: historyCount }, (_, n) => [
            row(`history-input-${n}`, "user", `Earlier assignment ${n}`),
            row(`history-reply-${n}`, "assistant", `Earlier reply ${n}`),
          ]).flat();
          let rows = [...history, ...normalGroupRows()];
          await page.route(base + "api/tree", (route) =>
            route.fulfill({ json: tree() }),
          );
          await mockConversation(page, base, "main", () => ({
            id: "main",
            title: "Activity",
            status: "idle",
            rows,
          }));
          for (const count of [0, 1, 5]) {
            rows = [
              ...history,
              ...(count ? wakeGroupRows(count) : normalGroupRows()),
            ];
            rows.at(-1)!.usage = {
              input: 100,
              output: 10,
              cacheRead: 0,
              cacheWrite: 0,
            };
            await gotoRoot(page, base);
            await page.reload();
            const group = count
              ? page.locator('[data-group^="chunk:"]').first()
              : page.locator(".activity-group").last();
            const summary = group.locator(":scope > .activity-group-summary");
            const eye = summary.locator(".activity-group-toggle");
            await eye.scrollIntoViewIfNeeded();
            expect(await summary.locator(".turn-tokens").count()).toBe(0);
            const foot = group
              .locator(
                "xpath=ancestor::section[contains(@class,'activity-boundary')][last()]",
              )
              .locator(".turn-foot");
            expect(
              await foot.locator(".turn-tokens, .turn-expand").count(),
            ).toBe(2);
            expect(
              await foot.evaluate((element) => {
                const centers = [
                  ...element.querySelectorAll(".turn-tokens, .turn-expand"),
                ].map((node) => {
                  const box = node.getBoundingClientRect();
                  return box.y + box.height / 2;
                });
                return Math.max(...centers) - Math.min(...centers);
              }),
            ).toBeLessThanOrEqual(2);
            const y = async () => (await summary.boundingBox())!.y;
            const stable = async (
              before: number,
              opening: boolean,
              tolerance = 2,
            ) => {
              await eye
                .locator(`xpath=self::*[@aria-expanded="${opening}"]`)
                .waitFor();
              await waitForLayout(page);
              if (historyCount) {
                expect(Math.abs((await y()) - before)).toBeLessThanOrEqual(
                  tolerance,
                );
              } else {
                const box = (await summary.boundingBox())!;
                const viewport = await page.locator("#scroll").boundingBox();
                expect(box.y).toBeGreaterThanOrEqual(viewport!.y);
                expect(box.y + box.height).toBeLessThanOrEqual(
                  viewport!.y + viewport!.height,
                );
                expect(
                  await page
                    .locator("#scroll")
                    .evaluate(
                      (element, open) =>
                        Math.abs(
                          element.scrollTop -
                            (open
                              ? element.scrollHeight - element.clientHeight
                              : 0),
                        ),
                      opening,
                    ),
                ).toBeLessThanOrEqual(1);
              }
            };
            const replyWidth = (await page
              .locator(".msg.assistant > .content")
              .last()
              .boundingBox())!.width;
            let before = await y();
            await eye.click();
            await stable(before, true);
            expect(
              (await page
                .locator(".msg.assistant > .content")
                .last()
                .boundingBox())!.width,
            ).toBe(replyWidth);
            const body = group.locator(":scope > .activity-group-body");
            expect(
              (await body.boundingBox())!.y +
                (await body.boundingBox())!.height,
            ).toBeLessThanOrEqual(await y());
            expect(
              await body
                .locator(
                  ".activity-group-toggle, .agent-message-inspect, .aside-btn, .activity-group-summary",
                )
                .count(),
            ).toBe(0);
            expect(await body.locator(".activity-rail").count()).toBe(0);
            expect(
              await body.locator(".turn-tool, .agent-message-body").count(),
            ).toBe(0);
            expect(
              await body
                .locator('.turn-series-toggle[aria-expanded="false"]')
                .count(),
            ).toBe(count || 3);
            if (count) {
              expect(
                await body
                  .locator('.agent-message-row[aria-expanded="false"]')
                  .count(),
              ).toBe(count);
              const agentRow = body.locator(".agent-message-row").first();
              expect(
                await agentRow.locator(".agent-message-preview").count(),
              ).toBe(0);
              expect(await agentRow.textContent()).not.toContain("Report 1");
              await agentRow.click();
              expect(
                await body.locator(".agent-message-body").first().textContent(),
              ).toContain("Report 1");
              if (mobile) {
                await agentRow.click();
                const bodyBox = (await body.boundingBox())!;
                const agentBox = (await agentRow.boundingBox())!;
                await page.touchscreen.tap(
                  bodyBox.x + bodyBox.width - 40,
                  agentBox.y + agentBox.height / 2,
                );
                expect(await agentRow.getAttribute("aria-expanded")).toBe(
                  "true",
                );
              }
            }
            const firstRow = body
              .locator(".turn-series-toggle, .agent-message-row")
              .first();
            const firstRowText = firstRow
              .locator(".agent-message-preview, span")
              .last();
            const arrow = group.getByRole("button", {
              name: "Hide activity",
              exact: true,
            });
            const textBox = (await firstRowText.boundingBox())!;
            const arrowBox = (await arrow.boundingBox())!;
            const borderY = await arrow.evaluate(
              (button) => button.parentElement!.getBoundingClientRect().y,
            );
            expect(
              Math.abs(arrowBox.y + arrowBox.height / 2 - borderY),
            ).toBeLessThanOrEqual(2);
            expect(
              arrowBox.y + arrowBox.height <= textBox.y ||
                textBox.x + textBox.width <= arrowBox.x,
            ).toBe(true);
            if (
              mobile &&
              process.env.AGENT_ACTIVITY_SHOTS &&
              historyCount === 15 &&
              count === 1
            ) {
              await page.screenshot({
                path: `${process.env.AGENT_ACTIVITY_SHOTS}/mobile-long-first-row.png`,
              });
            }
            const shortRun = body.locator(".turn-series-toggle").first();
            if (mobile) {
              const bodyBox = (await body.boundingBox())!;
              const rowBox = (await shortRun.boundingBox())!;
              await page.touchscreen.tap(
                bodyBox.x + bodyBox.width - 40,
                rowBox.y + rowBox.height / 2,
              );
              expect(await shortRun.getAttribute("aria-expanded")).toBe("true");
            } else {
              await shortRun.click();
            }
            expect(await body.locator(".turn-tool").count()).toBe(
              count ? 1 : 2,
            );
            await eye.scrollIntoViewIfNeeded();
            before = await y();
            await eye.click();
            await stable(before, false);
            expect(await body.count()).toBe(0);
            await eye.click();
            const tab = group.getByRole("button", {
              name: "Hide activity",
              exact: true,
            });
            await tab.scrollIntoViewIfNeeded();
            before = await y();
            await tab.click();
            await stable(before, false, 1);
            expect(await eye.getAttribute("aria-expanded")).toBe("false");
          }
        }
      } finally {
        await page.close();
      }
    }
  },
  // Regression: #2514 agent headers are single-line labels without message previews.
  async function test_agent_headers_are_compact_without_previews(
    browser,
    base,
  ) {
    for (const width of [412, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const trigger =
          "(turn started by an agent message; received 1 operator; 1 earlier turn ended)";
        const senders = [
          [
            "child",
            "main",
            "Child with a deliberately very long name that must truncate",
          ],
          ["parent", null, "Coordinator"],
          ["sibling", "parent", "Sibling"],
          ["other", null, "Other"],
        ];
        await page.route(base + "api/tree", (route) =>
          route.fulfill({
            json: [
              { ...tree()[0], parent: "parent" },
              ...senders.map(([id, parent, title]) => ({
                ...tree()[0],
                id,
                parent,
                title,
              })),
            ],
          }),
        );
        await mockConversation(page, base, "main", () => ({
          id: "main",
          parent: "parent",
          title: "Activity",
          status: "idle",
          rows: [
            row("assignment", "user", "Review the report."),
            ...senders.map(([sender]) =>
              row(
                `report-${sender}`,
                "user",
                sender === "parent"
                  ? "Parent assignment remains fully visible."
                  : "Private report preview must not appear",
                {
                  origin: "agent",
                  sender,
                  meta: { delivery: "steer" },
                },
              ),
            ),
            tool("read-report"),
            row(
              "report",
              "user",
              `${trigger}\nChild ended ${trigger} with no final message. This report has enough words to wrap across two lines on a phone without cutting its first line in the middle.`,
              {
                origin: "agent",
                sender: "gone-agent",
                sender_name: "Eighth tool check",
                meta: { delivery: "steer" },
              },
            ),
            row("reply", "assistant", "Report reviewed."),
          ],
        }));
        await gotoRoot(page, base);
        const group = page.locator(".activity-group").last();
        await group.locator(".activity-group-toggle").click();
        const header = group.locator(".agent-message-row").first();
        await header.waitFor();
        const text = (await header.textContent()) ?? "";
        const headers = group.locator(
          ".agent-message-row, .agent-message-inline-head",
        );
        expect(await headers.count()).toBe(5);
        expect(await group.locator(".agent-message-preview").count()).toBe(0);
        const activity = group.locator(".turn-series-toggle").first();
        const activityHeight = (await activity.boundingBox())!.height;
        for (const [index, relationship] of [
          "child agent",
          "parent agent",
          "sibling agent",
          "agent",
          "removed agent",
        ].entries()) {
          const item = headers.nth(index);
          expect(await item.locator(".sub").textContent()).toBe(relationship);
          expect(await item.textContent()).not.toMatch(
            /Private report|Child ended|created by|supervisor|overseeing|another agent/,
          );
          if (relationship !== "parent agent") {
            const box = (await item.boundingBox())!;
            expect(box.height).toBe(activityHeight);
            const caret = (await item
              .locator(".disclosure-caret")
              .boundingBox())!;
            expect(caret.y + caret.height / 2).toBe(box.y + box.height / 2);
          }
        }
        const lead = headers.first().locator(".lead");
        expect(
          await lead.evaluate(
            (element) => element.scrollWidth > element.clientWidth,
          ),
        ).toBe(width === 412);
        expect(text).not.toContain(trigger);
        if (process.env.AGENT_ACTIVITY_SHOTS) {
          await mkdir(process.env.AGENT_ACTIVITY_SHOTS, { recursive: true });
          await page.screenshot({
            path: `${process.env.AGENT_ACTIVITY_SHOTS}/agent-message-${width}.png`,
          });
        }
        await headers.last().click();
        const body = group.locator(".agent-message-body").last();
        expect((await body.textContent()) ?? "").toContain(
          "Child ended with no final message.",
        );
        expect((await body.textContent()) ?? "").not.toContain(trigger);
      } finally {
        await page.close();
      }
    }
  },
  // Regression: #2513 sealed chunk controls share the final line with a small hang.
  async function test_fixed_wake_chunks_preserve_sealed_dom(browser, base) {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      try {
        const thread: any = {
          id: "main",
          title: "Wake chunks",
          status: "idle",
          rows: wakeGroupRows(10),
        };
        await page.route(base + "api/tree", (route) =>
          route.fulfill({ json: tree() }),
        );
        await mockConversation(page, base, "main", () => thread);
        await gotoRoot(page, base);
        await page.getByText("Wake 10 final.", { exact: true }).waitFor();
        const chunks = page.locator('[data-group^="chunk:"]');
        expect(await chunks.count()).toBe(2);
        expect(
          await chunks.first().evaluate((node) => {
            const frame = node.closest(".wake-chunk")!;
            const reply = frame.querySelector(".msg.assistant")!;
            const next = frame.nextElementSibling!.querySelector(
              ".activity-group-summary",
            )!;
            const foot = frame.querySelector(".turn-foot")!;
            const content = reply.querySelector(".content")!;
            const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
            const replyBox = reply.getBoundingClientRect();
            const footBox = foot.getBoundingClientRect();
            return (
              footBox.top >= replyBox.bottom - lineHeight - 1 &&
              footBox.top < replyBox.bottom &&
              footBox.bottom <= next.getBoundingClientRect().top
            );
          }),
        ).toBeTrue();
        expect(
          await page.getByText("Wake 1 first.", { exact: true }).count(),
        ).toBe(0);
        await chunks
          .first()
          .locator(":scope > .activity-group-summary .activity-group-toggle")
          .click();
        expect(
          await page.getByText("Wake 1 first.", { exact: true }).isVisible(),
        ).toBeTrue();
        expect(await page.locator(".turn-tool").count()).toBe(0);
        expect(
          await chunks.first().locator(".turn-series-toggle").count(),
        ).toBe(5);
        expect(
          await chunks
            .first()
            .locator(
              ".activity-group-body .activity-group-toggle, .activity-group-body .agent-message-inspect, .activity-group-body .aside-btn",
            )
            .count(),
        ).toBe(0);
        expect(await chunks.first().locator(".turn-foot").count()).toBe(0);
        expect(
          await chunks.first().locator(".activity-group-summary").count(),
        ).toBe(1);
        thread.rows = wakeGroupRows(12);
        await page.getByText("Wake 12 final.", { exact: true }).waitFor();
        expect(await chunks.count()).toBe(3);
        expect(
          await chunks
            .locator(":scope > .activity-group-summary .turn-summary")
            .allTextContents(),
        ).toEqual([
          "3 agent messages · 2 platform notes · 9 replies, 30 words hidden · read 5 files",
          "2 agent messages · 3 platform notes · 9 replies, 30 words hidden · read 5 files",
          "1 agent message · 1 platform note · 3 replies, 9 words hidden · read 2 files",
        ]);
        expect(
          await chunks
            .nth(1)
            .locator(":scope > .activity-group-summary .activity-group-toggle")
            .getAttribute("aria-expanded"),
        ).toBe("false");
        thread.rows = wakeGroupRows(100);
        thread.rows.at(-1).text += " History padding.".repeat(500);
        let olderReads = 0;
        await page.route(base + "api/conversations/main/view?*", (route) => {
          if (
            new URL(route.request().url()).searchParams.has("before") &&
            olderReads++ === 0
          )
            return route.fulfill({ status: 503 });
          return route.fallback();
        });
        await page.reload();
        await chunks.first().waitFor();
        const olderResponse = (status: number) =>
          page.waitForResponse(
            (response) =>
              response.url().includes("before=") &&
              response.status() === status,
            { timeout: 3000 },
          );
        const failedRead = olderResponse(503);
        await chunks
          .first()
          .locator(":scope > .activity-group-summary .activity-group-toggle")
          .evaluate((element) => element.click());
        await failedRead;
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              (globalThis as any).requestAnimationFrame(resolve),
            ),
        );
        await chunks
          .first()
          .locator(".activity-group-toggle")
          .evaluate((element) => element.click());
        const reopenedRead = olderResponse(200);
        await chunks
          .first()
          .locator(".activity-group-toggle")
          .evaluate((element) => element.click());
        await reopenedRead;
        await page.waitForFunction(
          "document.querySelectorAll('[data-group^=\"chunk:\"]').length === 10",
        );
        expect(await page.locator(".turn-tool").count()).toBe(0);
        expect(
          await page
            .locator(".activity-group.open .turn-series-toggle")
            .count(),
        ).toBe(5);
      } finally {
        await page.close();
      }
    }
  },
  async function test_per_turn_groups_end_to_end(browser, base) {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      for (const parent of [false, true]) {
        const page = await browser.newPage({ viewport });
        try {
          const thread: any = {
            id: "main",
            title: "Per-turn groups",
            parent: parent ? "parent" : null,
            status: "idle",
            rows: normalGroupRows(parent),
          };
          await page.route(base + "api/tree", (route) =>
            route.fulfill({ json: tree() }),
          );
          await mockConversation(page, base, "main", () => thread);
          await gotoRoot(page, base);
          await page
            .getByText("Final reply stays visible.", { exact: true })
            .waitFor();
          expect(
            await page
              .getByText("Implement the assigned change.", { exact: true })
              .isVisible(),
          ).toBeTrue();
          expect(
            await page
              .getByText("First reply stays visible.", { exact: true })
              .isVisible(),
          ).toBeTrue();
          expect(
            await page
              .getByText("Middle reply belongs to activity.", { exact: true })
              .count(),
          ).toBe(0);
          expect(await page.locator(".turn-foot .turn-summary").count()).toBe(
            0,
          );
          const eyes = page.locator(
            ".activity-group-summary .activity-group-toggle",
          );
          const outside = (locator: typeof eyes) =>
            locator.evaluate(
              (element) =>
                element.closest(".activity-group-body, .activity-body") ===
                null,
            );
          const allExpanded = (open: boolean) =>
            eyes.evaluateAll(
              (elements, expected) =>
                elements.every(
                  (element) =>
                    element.getAttribute("aria-expanded") === String(expected),
                ),
              open,
            );
          expect(await eyes.count()).toBe(1);
          await eyes.first().click();
          expect(await page.locator(".turn-tool").count()).toBe(0);
          expect(await page.locator(".turn-series-toggle").count()).toBe(3);
          expect(
            await page
              .getByText("Middle reply belongs to activity.", { exact: true })
              .isVisible(),
          ).toBeTrue();
          await page.locator(".turn-series-toggle").first().click();
          expect(await page.locator(".turn-tool").count()).toBe(2);
          await eyes.first().click();
          expect(await page.locator(".turn-series-toggle").count()).toBe(0);
          await page.evaluate("document.activeElement?.blur()");
          await page.keyboard.press("v");
          expect(await allExpanded(true)).toBeTrue();
          await page.keyboard.press("v");
          expect(await allExpanded(false)).toBeTrue();

          thread.rows = [
            ...normalGroupRows(parent),
            row("compact", "compaction", "Context compacted", {
              kind: "marker",
              meta: {
                compact_marker: true,
                body: "Context compacted at 27k tokens.",
              },
            }),
            row("next", "user", "Next assignment"),
            row("next-reply", "assistant", "Next reply"),
          ];
          await page.reload();
          const marker = page.locator(".compacted-activity");
          await marker.waitFor();
          expect(await page.locator(".compaction-eye").count()).toBe(0);
          expect(await outside(marker)).toBeTrue();
          await marker.locator(".compacted-head").click();
          await marker.locator(".disclosure-body").waitFor();
          expect(await allExpanded(false)).toBeTrue();
          await eyes.first().click();
          expect(await marker.isVisible()).toBeTrue();
          expect(await outside(marker)).toBeTrue();

          thread.status = "running";
          thread.rows = normalGroupRows(parent)
            .slice(0, -1)
            .map((entry, index, rows) =>
              index === rows.length - 1 ? { ...entry, live: true } : entry,
            );
          await page.reload();
          const panel = page.locator(".live-panel");
          await panel.waitFor();
          expect(
            await page
              .locator(".activity-group-summary .turn-summary")
              .last()
              .innerText(),
          ).toBe("Read 4 files");
          for (let index = 0; index < (await eyes.count()); index++) {
            expect(await panel.count()).toBe(1);
            expect(await outside(panel)).toBeTrue();
            await eyes.nth(index).click();
            expect(await panel.isVisible()).toBeTrue();
            expect(await outside(panel)).toBeTrue();
            await eyes.nth(index).click();
          }
          thread.rows.push(
            row("thinking", "assistant", "", {
              live: true,
              thinking_title: "Planning",
              has_thinking: true,
              live_thinking: true,
            }),
          );
          await page.reload();
          await panel.waitFor();
          expect(
            await panel.locator(".live-panel-box.is-thinking").count(),
          ).toBe(1);
          expect(await outside(panel)).toBeTrue();
          await eyes.first().click();
          expect(await outside(panel)).toBeTrue();

          thread.status = "idle";
          thread.rows = [
            normalGroupRows(parent)[0],
            ...Array.from({ length: 105 }, (_, index) =>
              tool(`paged-${index}`),
            ),
            ...normalGroupRows(parent).slice(3, -1),
            row("paged-tail", "assistant", "Paged final padding. ".repeat(500)),
          ];
          await page.reload();
          await eyes.first().waitFor();
          const assignment = page.getByText("Implement the assigned change.", {
            exact: true,
          });
          expect(await assignment.count()).toBe(0);
          await eyes.first().evaluate((element) => element.click());
          await assignment.waitFor();
          await page.locator(".turn-series-toggle").first().click();
          await page.waitForFunction(
            "document.querySelectorAll('.turn-tool').length === 105",
          );
          expect(await eyes.first().getAttribute("aria-expanded")).toBe("true");
        } finally {
          await page.close();
        }
      }
    }
  },
];
