import { mkdir } from "node:fs/promises";
import systemMessageExample from "./fixtures/system-messages.json";
const systemMessages = systemMessageExample.messages;
type Element = any;
type HTMLElement = any;
type DOMRect = any;
declare const document: any;
declare const NodeFilter: any;
declare const getComputedStyle: any;
declare const innerWidth: number;
declare const requestAnimationFrame: any;
import { expect } from "bun:test";
import { row as fixtureRow } from "./fixtures";
import {
  captureErrors,
  gotoRoot,
  mockConversation,
  waitForLayout,
  turn,
  type BrowserTest,
} from "./common";

export const disclosuresTests: BrowserTest[] = [
  async function test_system_messages_inspector_and_legacy_fallback(
    browser,
    base,
  ) {
    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 900 }],
      ["mobile", { width: 390, height: 844 }],
    ] as const) {
      const page = await browser.newPage({ viewport });
      const errors = captureErrors(page);
      await mockConversation(page, base, "main", () => ({
        id: "main",
        title: "Inspector",
        parent: null,
        status: "idle",
        turns: [],
      }));
      let messages: unknown[] | undefined = systemMessages;
      await page.route(`${base}api/conversations/main/prompt`, (route) =>
        route.fulfill({
          json: {
            system: "Legacy turn-start prompt",
            capture_status: "captured",
            system_messages: messages,
          },
        }),
      );
      await gotoRoot(page, base);
      await page.locator(".prompt-banner-row").click();
      expect(
        await page.locator(".prompt-block-head").first().innerText(),
      ).toContain("LATEST CAPTURED REQUEST");
      expect(
        await page.locator(".prompt-block-head").nth(1).innerText(),
      ).toContain("MESSAGE 1 · BASELINE");
      const delta = page.locator(".system-message").last();
      expect(await delta.locator(".prompt-block-head").innerText()).toContain(
        `MESSAGE ${systemMessages.length} · DELTA`,
      );
      expect(await delta.locator(".prompt-msg").innerText()).toBe(
        "Sets: project_context, cwd",
      );
      const section = delta.locator(".prompt-section").last();
      expect(await section.locator("summary").innerText()).toContain("cwd ·");
      expect(await section.getAttribute("open")).toBeNull();
      await section.locator("summary").click();
      expect(await section.locator("pre").innerText()).toBe(
        systemMessages.at(-1)!.sections.cwd,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.body.dataset.copied = text;
            },
          },
        });
      });
      await page
        .getByRole("button", { name: "Copy system messages", exact: true })
        .click();
      expect(await page.locator("body").getAttribute("data-copied")).toBe(
        JSON.stringify(systemMessages, null, 2),
      );
      await section.scrollIntoViewIfNeeded();
      if (process.env.SCREENSHOT_DIR) {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: `${process.env.SCREENSHOT_DIR}/system-messages-${name}.png`,
        });
      }
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth + 1",
        ),
      ).toBeTrue();
      messages = undefined;
      await page.locator(".prompt-banner-row").click();
      await page.locator(".prompt-banner-row").click();
      await page
        .getByText("Legacy turn-start prompt", { exact: true })
        .waitFor();
      expect(await page.locator(".prompt-block-head").innerText()).toContain(
        "SYSTEM MESSAGES UNAVAILABLE",
      );
      expect(errors).toEqual([]);
      await page.close();
    }
  },
  async function test_agent_wake_history_pages_add_visible_boundaries(
    browser,
    base,
  ) {
    const turns = Array.from({ length: 160 }, (_, index) => ({
      turn_id: `wake-${index}`,
      segments: [
        {
          user: [
            {
              id: `wake-${index}:user`,
              content: `Agent report ${index}`,
              from: "child-agent",
              origin: "agent",
            },
          ],
          tools: [],
          assistant: { content: `Agent reply ${index}` },
        },
      ],
    }));
    const thread = {
      id: "main",
      title: "Agent wake history",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: turns.length * 2,
      window_cursor: 0,
      turns,
    };
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      isMobile: false,
      hasTouch: false,
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await mockConversation(page, base, "main", () => thread);
    try {
      await gotoRoot(page, base);
      await page.locator(".activity-boundary").first().waitFor();
      let visibleBoundaries = await page.locator(".activity-boundary").count();
      expect(visibleBoundaries).toBeGreaterThan(0);
      for (let pageNumber = 0; pageNumber < 2; pageNumber += 1) {
        await page.locator("#scroll").evaluate((element: any) => {
          element.scrollTop = 0;
        });
        await page.waitForFunction(
          (previous: number) =>
            document.querySelectorAll(".activity-boundary").length > previous,
          visibleBoundaries,
        );
        const next = await page.locator(".activity-boundary").count();
        expect(next).toBeGreaterThan(visibleBoundaries);
        visibleBoundaries = next;
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_shift_g_scrolls_to_latest_message(browser, base) {
    const reply = Array.from(
      { length: 120 },
      (_, index) => `Message line ${index} keeps the thread scrollable.`,
    ).join("\\n\\n");
    const thread = {
      id: "main",
      title: "Keyboard scroll",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 2,
      window_cursor: 0,
      turns: [turn("keyboard-scroll", "Where are we?", reply)],
    };
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      isMobile: false,
      hasTouch: false,
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      await mockConversation(page, base, "main", () => thread);
      await gotoRoot(page, base);
      await page.locator(".msg.assistant .content").waitFor();
      const scrollable = await page.evaluate(() => {
        const scroll = document.querySelector("#scroll") as HTMLElement;
        scroll.scrollTop = 0;
        return scroll.scrollHeight > scroll.clientHeight;
      });
      expect(scrollable).toBe(true);
      await page.keyboard.press("Shift+G");
      await page.waitForFunction(() => {
        const scroll = document.querySelector("#scroll") as HTMLElement;
        return (
          scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 2
        );
      });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_katex_finalizes_after_message_sanitization(
    browser,
    base,
  ) {
    const longTex = Array.from({ length: 200 }, () => "x").join("+");
    const reply = String.raw`Same purpose—mapping to \((0,1)\)—but **not the same function**.

If \`log_a = 0\`, then exactly:
\[
e^{-\mathrm{softplus}(d)}=\sigma(-d).
\]

With learned \`log_a\`:
\[
a=\sigma(-d)^{\,e^{\text{log\_a}}}.
\]

Long expression:
\[
${longTex}
\]

So yes, it’s effectively a **sigmoid-like decay parameterization**. The meaningful change in your proposal is making it **data-dependent**, not choosing sigmoid versus exponential.

<span data-forged-katex class="katex" style="height:500em">forged CSS</span>
<span data-forged-placeholder data-math-placeholder="not-json"></span>
<span data-malformed-math data-math-placeholder='{"tex":"{","displayMode":false,"raw":"literal fallback"}'></span>
<code data-code-placeholder data-math-placeholder="not-json">code payload</code>`;
    const thread = {
      id: "main",
      title: "KaTeX finalization",
      parent: null,
      status: "idle",
      active_run: null,
      kind: null,
      msg_count: 2,
      window_cursor: 0,
      turns: [turn("katex-finalization", "Explain the distinction.", reply)],
      draft: null,
    };
    for (const [viewport, mobile] of [
      [{ width: 390, height: 844 }, true],
      [{ width: 1280, height: 800 }, false],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await mockConversation(page, base, "main", () => thread);
        await gotoRoot(page, base);
        await page.locator(".msg.assistant .content").waitFor();
        await page.waitForFunction(
          "document.querySelectorAll('.katex-display').length === 3",
        );
        const bounds = await page
          .locator(".katex-display")
          .evaluateAll((elements) =>
            elements.map((element) => {
              const measure = () => {
                const rangeRects: DOMRect[] = [];
                const walker = document.createTreeWalker(
                  element.querySelector(".katex-html")!,
                  NodeFilter.SHOW_TEXT,
                );
                let node;
                while ((node = walker.nextNode())) {
                  if (!node.textContent?.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  rangeRects.push(...Array.from(range.getClientRects()));
                }
                const rect = element.getBoundingClientRect();
                const glyph = {
                  left: Math.min(...rangeRects.map((item) => item.left)),
                  right: Math.max(...rangeRects.map((item) => item.right)),
                  top: Math.min(...rangeRects.map((item) => item.top)),
                  bottom: Math.max(...rangeRects.map((item) => item.bottom)),
                };
                return {
                  glyph,
                  box: {
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                  },
                  verticalVisible:
                    glyph.top >= rect.top - 1 &&
                    glyph.bottom <= rect.bottom + 1,
                  horizontalStartVisible: glyph.left >= rect.left - 1,
                  horizontalEndVisible: glyph.right <= rect.right + 1,
                };
              };
              const maxScroll = Math.max(
                0,
                element.scrollWidth - element.clientWidth,
              );
              const extremes = [0, maxScroll].map((scrollLeft) => {
                element.scrollLeft = scrollLeft;
                return { scrollLeft: element.scrollLeft, ...measure() };
              });
              return {
                extremes,
                maxScroll,
                overflowX: getComputedStyle(element).overflowX,
              };
            }),
          );
        expect(bounds).toHaveLength(3);
        expect(
          bounds.every(
            (item: any) =>
              item.overflowX === "auto" &&
              item.extremes[0].scrollLeft === 0 &&
              item.extremes[1].scrollLeft === item.maxScroll &&
              item.extremes[0].horizontalStartVisible &&
              item.extremes[1].horizontalEndVisible &&
              item.extremes.every((extreme: any) => extreme.verticalVisible),
          ),
        ).toBe(true);
        expect(bounds.some((item: any) => item.maxScroll > 1)).toBe(true);
        const forged = page.locator("[data-forged-katex]");
        expect(await forged.count()).toBe(0);
        expect(await page.locator("[data-forged-placeholder]").count()).toBe(0);
        expect(await page.locator("[data-malformed-math]").count()).toBe(0);
        const codePlaceholder = page.locator("[data-code-placeholder]");
        expect(await codePlaceholder.count()).toBe(0);
        const content = await page
          .locator(".msg.assistant .content")
          .innerText();
        expect(content).toContain(
          '<span data-forged-katex class="katex" style="height:500em">forged CSS</span>',
        );
        expect(content).toContain(
          '<span data-forged-placeholder data-math-placeholder="not-json"></span>',
        );
        expect(content).toContain(
          `<span data-malformed-math data-math-placeholder='{"tex":"{","displayMode":false,"raw":"literal fallback"}'></span>`,
        );
        expect(content).toContain(
          '<code data-code-placeholder data-math-placeholder="not-json">code payload</code>',
        );
        expect(await page.locator(".katex [style]").count()).toBeGreaterThan(0);
        expect(
          await page.evaluate<boolean>(
            "document.documentElement.scrollWidth <= innerWidth",
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #2060 folded reports preserve compaction disclosure
  async function test_agent_message_and_compaction_disclosures(browser, base) {
    const longMessage = `  ${"long-agent-message ".repeat(180)}  `;
    const platformMessage =
      "[Platform interruption] cleaned up detached processes";
    const platformEntry = {
      kind: "user",
      offset: 9,
      role: "user",
      content: platformMessage,
      source: "platform",
      ts: 0.5,
    };
    const agentEntry = {
      kind: "user",
      offset: 10,
      role: "user",
      content: longMessage,
      from: "sender",
      from_name: "Sender agent",
      ts: 1,
    };
    const compactEntry = {
      kind: "system",
      offset: 0,
      role: "marker",
      marker: "compact",
      content: "Conversation compacted",
      summary: "Exact compacted context",
      has_summary: true,
    };
    const thread: any = {
      id: "main",
      title: "Disclosure recipient",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 3,
      window_cursor: 10,
      generation_marker: compactEntry,
      turns: [
        {
          turn_id: "agent-message",
          cursor: 10,
          started_at: 1,
          ended_at: 2,
          open: false,
          status: "idle",
          summary: {},
          partial: false,
          segments: [
            {
              user: [platformEntry, agentEntry],
              tools: [],
              assistant: null,
              summary: {},
            },
          ],
        },
      ],
    };
    for (const [viewport, mobile, touch] of [
      [{ width: 390, height: 844 }, true, true],
      [{ width: 1280, height: 800 }, false, false],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: touch,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await page.route(`${base}api/tree*`, (route) =>
          route.fulfill({
            json: [
              {
                id: "main",
                parent: null,
                title: "Disclosure recipient",
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
        await mockConversation(page, base, "main", () => thread);
        const summaryRequests: string[] = [];
        await page.route(
          `${base}api/conversations/main/marker-summary**`,
          (route) => {
            summaryRequests.push(route.request().url());
            return route.fulfill({
              json: { summary: "Exact compacted context" },
            });
          },
        );
        await page.route(
          `${base}api/conversations/main/turn-prompt**`,
          (route) =>
            route.fulfill({
              json: {
                driving: "Delivered agent envelope",
                message: "",
                system: "",
                role: "user",
                steering: false,
              },
            }),
        );
        await gotoRoot(page, base);
        const agent = page.locator(
          ".agent-message:not(.platform-interruption)",
        );
        const platform = page.locator(".agent-message.platform-interruption");
        const marker = page.locator(".compacted-activity");
        await marker.waitFor();
        expect(await agent.count()).toBe(0);
        const platformRow = platform.locator(".agent-message-row");
        expect(await marker.locator(".disclosure-body").count()).toBe(0);
        expect(summaryRequests).toEqual([]);
        const activityBoundary = page
          .locator(".activity-boundary:not(.chunk-turn)")
          .last();
        const activityEye = activityBoundary.locator(".activity-group-toggle");
        await activityEye.focus();
        await page.keyboard.press("Enter");

        await page.getByText("Message from Sender agent").waitFor();
        expect(await marker.locator(".disclosure-body").count()).toBe(0);
        await platform.waitFor();
        expect(await platform.locator(".agent-message-body").count()).toBe(0);
        expect(await platformRow.getAttribute("aria-expanded")).toBe("false");
        const platformColor = await platformRow
          .locator(".lead")
          .evaluate((element) => getComputedStyle(element).color);
        const agentColor = await agent
          .locator(".agent-message-row")
          .locator(".lead")
          .evaluate((element) => getComputedStyle(element).color);
        expect(platformColor).not.toBe(agentColor);
        await platformRow.click();
        const platformBody = platform.locator(".agent-message-body");
        await platformBody.waitFor();
        expect(await platformRow.getAttribute("aria-expanded")).toBe("true");
        expect(
          await platformBody.locator(".agent-message-content").innerText(),
        ).toBe(platformMessage);
        await platformRow.click();
        expect(await platform.locator(".agent-message-body").count()).toBe(0);
        expect(await platformRow.getAttribute("aria-expanded")).toBe("false");
        expect(summaryRequests).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #2060 closing folded report preserves scroll anchor
  async function test_incoming_agent_messages_fold_and_tab_closes(
    browser,
    base,
  ) {
    const child = "deleted-child";
    const longReply = Array.from(
      { length: 80 },
      (_, index) => `latest reply line ${index}`,
    ).join("\n");
    const rows = [
      ...Array.from({ length: 15 }, (_, index) => [
        fixtureRow(`earlier-${index}`, "user", `Earlier assignment ${index}`),
        fixtureRow(`reply-${index}`, "assistant", `Earlier reply ${index}`),
      ]).flat(),
      fixtureRow("u1", "user", "start"),
      fixtureRow("reference", "assistant", "reference reply"),
      fixtureRow("a1", "assistant", "first reply"),
      fixtureRow("u2", "user", "child report", {
        origin: "agent",
        sender: child,
        sender_name: "Deleted child",
      }),
      fixtureRow("a2", "assistant", longReply),
      fixtureRow("u3", "user", "tail start"),
      fixtureRow("a3", "assistant", "tail reply"),
    ];
    const thread: any = {
      id: "main",
      title: "Incoming activity",
      parent: null,
      status: "idle",
      rows,
      msg_count: rows.length,
      window_cursor: 0,
    };
    for (const [viewport, mobile, touch] of [
      [{ width: 390, height: 844 }, true, true],
      [{ width: 1280, height: 800 }, false, false],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: touch,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await mockConversation(page, base, "main", () => thread);
        await gotoRoot(page, base);
        const boundary = page
          .locator(".activity-boundary:not(.chunk-turn)")
          .filter({ hasText: "latest reply line 0" });
        await boundary.waitFor();
        expect(await page.getByText("Message from Deleted child").count()).toBe(
          0,
        );
        expect(
          await boundary
            .locator(".activity-group-summary .turn-summary")
            .innerText(),
        ).not.toContain("Poked");
        const reference = (await page
          .locator('[data-row-id="row:reference"] > .content')
          .boundingBox())!;
        const first = (await page
          .locator('[data-row-id="row:a1"] > .content')
          .boundingBox())!;
        const next = (await page
          .locator('[data-row-id="row:a2"] > .content')
          .boundingBox())!;
        const hiddenLine = (await boundary
          .locator(".activity-group-summary")
          .boundingBox())!;
        expect(
          Math.abs(
            next.y -
              hiddenLine.y -
              hiddenLine.height -
              (first.y - reference.y - reference.height),
          ),
        ).toBeLessThanOrEqual(1);
        await boundary.locator(".activity-group-toggle").click();
        const group = boundary.locator(".activity-group").first();
        const eye = group.locator(".activity-group-toggle");
        await page.getByText("Message from Deleted child").waitFor();
        const tab = group.getByRole("button", {
          name: "Hide activity",
          exact: true,
        });
        expect(await tab.count()).toBe(1);
        expect(await eye.getAttribute("aria-expanded")).toBe("true");
        await tab.evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        await waitForLayout(page);
        const control = group.locator(".activity-group-summary");
        const before = await control.boundingBox();
        const beforeScroll = await page
          .locator("#scroll")
          .evaluate((element: any) => element.scrollTop);
        expect(before).not.toBeNull();
        const tabBox = (await tab.boundingBox())!;
        if (process.env.AGENT_ACTIVITY_SHOTS) {
          await page
            .getByText("Message from Deleted child")
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${process.env.AGENT_ACTIVITY_SHOTS}/${mobile ? "mobile" : "desktop"}-open.png`,
          });
          await tab.evaluate((element) =>
            element.scrollIntoView({ block: "center" }),
          );
        }
        if (touch)
          await page.touchscreen.tap(
            tabBox.x + 8,
            tabBox.y + tabBox.height / 2,
          );
        else await page.mouse.click(tabBox.x + 8, tabBox.y + tabBox.height / 2);
        await eye.locator('xpath=self::*[@aria-expanded="false"]').waitFor();
        await waitForLayout(page);
        const after = await control.boundingBox();
        const afterScroll = await page
          .locator("#scroll")
          .evaluate((element: any) => element.scrollTop);
        expect(await page.getByText("Message from Deleted child").count()).toBe(
          0,
        );
        expect(await tab.count()).toBe(0);
        expect(await eye.getAttribute("aria-expanded")).toBe("false");
        expect(
          await eye.evaluate(
            (element) => getComputedStyle(element).outlineStyle,
          ),
        ).toBe("none");
        if (process.env.AGENT_ACTIVITY_SHOTS) {
          await page
            .getByText("reference reply", { exact: true })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${process.env.AGENT_ACTIVITY_SHOTS}/${mobile ? "mobile" : "desktop"}-closed-gap.png`,
          });
          await eye.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${process.env.AGENT_ACTIVITY_SHOTS}/${mobile ? "mobile" : "desktop"}-closed.png`,
          });
        }
        expect(after).not.toBeNull();
        expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
        expect(Math.abs(afterScroll - beforeScroll)).toBeLessThan(
          longReply.length,
        );
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #2060 compaction disclosure has no stale activity footer
  async function test_compacted_head_toggles_summary(browser, base) {
    const compactEntry = {
      kind: "system",
      offset: 0,
      role: "marker",
      marker: "compact",
      content: "Conversation compacted",
      summary: `Exact compacted context\n\n${"Summary detail. ".repeat(600)}`,
      has_summary: true,
    };
    const thread: any = {
      id: "main",
      title: "Compacted toggle",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 2,
      window_cursor: 10,
      generation_marker: compactEntry,
      turns: [turn("compacted-toggle", "What changed?", "Nothing changed.")],
    };
    for (const [viewport, mobile, touch] of [
      [{ width: 390, height: 844 }, true, true],
      [{ width: 1280, height: 800 }, false, false],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: touch,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await mockConversation(page, base, "main", () => thread);
        await gotoRoot(page, base);
        const head = page.locator(".compacted-head");
        await head.waitFor();
        expect(await head.evaluate((element) => element.tagName)).toBe(
          "BUTTON",
        );
        expect(await head.getAttribute("aria-expanded")).toBe("false");
        expect(await head.getAttribute("aria-label")).toBe(
          "Show compacted summary",
        );
        const marker = page.locator(".compacted-activity");
        const boundary = marker.locator(
          "xpath=ancestor::section[contains(@class,'activity-boundary')]",
        );
        expect(await boundary.locator(".compaction-eye").count()).toBe(0);
        expect(await marker.locator(".disclosure-body").count()).toBe(0);
        expect(await boundary.locator(".turn-summary").count()).toBe(0);
        expect(
          await boundary.locator(".turn-foot .activity-group-toggle").count(),
        ).toBe(0);
        await head.click();
        const body = marker.locator(".disclosure-body", {
          hasText: "Exact compacted context",
        });
        await body.waitFor();
        const content = body.locator(":scope > .content");
        expect(
          await content.evaluate(
            (element) => getComputedStyle(element).overflow,
          ),
        ).toBe("auto");
        expect(
          await content.evaluate((element) => element.clientHeight <= 280),
        ).toBe(true);
        expect(
          await content.evaluate(
            (element) => element.scrollHeight > element.clientHeight,
          ),
        ).toBe(true);
        expect(await head.getAttribute("aria-expanded")).toBe("true");
        expect(await head.getAttribute("aria-label")).toBe(
          "Hide compacted summary",
        );
        expect(await head.getAttribute("aria-controls")).toBe(
          await body.getAttribute("id"),
        );
        await head.click();
        expect(await marker.locator(".disclosure-body").count()).toBe(0);
        expect(await head.getAttribute("aria-expanded")).toBe("false");
        await head.focus();
        await page.keyboard.press("Enter");
        await marker
          .locator(".disclosure-body", { hasText: "Exact compacted context" })
          .waitFor();
        expect(await head.getAttribute("aria-expanded")).toBe("true");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_disclosure_toggles_hold_scroll(browser, base) {
    const shotDir = process.env.COMPACT_SHOTS ?? "";
    const reply = Array.from(
      { length: 40 },
      (_, index) => `Sentence ${index} pads this reply.`,
    ).join(" ");
    const turns = Array.from({ length: 10 }, (_, index) =>
      turn(`hold-${index}`, `Question ${index}?`, reply, {
        tools: [
          {
            kind: "tool",
            offset: index * 100 + 40,
            seq: index + 1,
            name: "bash",
            input: `echo ${index}`,
            input_full: `echo ${index} && sleep 0`,
            status: "ok",
            stat: { kind: "shell" },
          },
        ],
      }),
    );
    const thread: any = {
      id: "main",
      title: "Disclosure scroll hold",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 2,
      window_cursor: 10,
      generation_marker: {
        kind: "system",
        offset: 0,
        role: "marker",
        marker: "compact",
        content: "Conversation compacted",
        summary: "Exact compacted context",
        has_summary: true,
      },
      turns,
    };
    const topOf = async (locator: any): Promise<number> =>
      (await locator.evaluate(
        (element: Element) => element.getBoundingClientRect().top,
      )) as number;
    const center = async (page: any, locator: any): Promise<void> => {
      await locator.evaluate((element: Element) =>
        element.scrollIntoView({ block: "center" }),
      );
      await waitForLayout(page);
    };
    const waitForScrollSettle = async (
      page: any,
      contentSelector: string,
      contentPresent: boolean,
    ): Promise<void> => {
      await page.waitForFunction(
        ({
          contentPresent,
          contentSelector,
        }: {
          contentPresent: boolean;
          contentSelector: string;
        }) => {
          const scroll = document.querySelector("#scroll");
          const content = document.querySelector(contentSelector);
          if (!scroll || (content !== null) !== contentPresent) return false;
          const initialTop = scroll.scrollTop;
          let frames = 0;
          return new Promise<boolean>((resolve) => {
            const check = () => {
              const stillPresent =
                document.querySelector(contentSelector) !== null;
              if (
                stillPresent !== contentPresent ||
                scroll.scrollTop !== initialTop
              ) {
                resolve(false);
                return;
              }
              frames += 1;
              if (frames === 3) resolve(true);
              else requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          });
        },
        { contentPresent, contentSelector },
        { polling: "raf", timeout: 15_000 },
      );
    };
    for (const [name, viewport, mobile, touch] of [
      ["desktop", { width: 1280, height: 800 }, false, false],
      ["mobile", { width: 390, height: 844 }, true, true],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: touch,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await mockConversation(page, base, "main", () => thread);
        await gotoRoot(page, base);
        const head = page.locator(".compacted-head");
        await head.waitFor();
        expect(await head.evaluate((element) => element.tagName)).toBe(
          "BUTTON",
        );
        await center(page, head);
        if (shotDir)
          await page.screenshot({ path: `${shotDir}/${name}-closed.png` });
        const headTop = await topOf(head);
        await head.click();
        const body = page.locator(".compacted-activity .disclosure-body", {
          hasText: "Exact compacted context",
        });
        await body.waitFor();
        await waitForScrollSettle(
          page,
          ".compacted-activity .disclosure-body",
          true,
        );
        expect(Math.abs((await topOf(head)) - headTop)).toBeLessThanOrEqual(1);
        if (shotDir)
          await page.screenshot({ path: `${shotDir}/${name}-open.png` });
        await head.click();
        await waitForScrollSettle(
          page,
          ".compacted-activity .disclosure-body",
          false,
        );
        expect(
          await page.locator(".compacted-activity .disclosure-body").count(),
        ).toBe(0);
        expect(Math.abs((await topOf(head)) - headTop)).toBeLessThanOrEqual(1);
        const eye = page
          .locator(".activity-boundary .activity-group-toggle")
          .nth(3);
        await center(page, eye);
        const eyeTop = await topOf(eye);
        const boundary = eye.locator(
          "xpath=ancestor::section[contains(@class,'activity-boundary')]",
        );
        await eye.click();
        await boundary.locator(".turn-series-toggle").first().waitFor();
        await waitForScrollSettle(
          page,
          ".activity-boundary .turn-series-toggle",
          true,
        );
        expect(Math.abs((await topOf(eye)) - eyeTop)).toBeLessThanOrEqual(1);
        await eye.click();
        await waitForScrollSettle(
          page,
          ".activity-boundary .turn-series-toggle",
          false,
        );
        expect(Math.abs((await topOf(eye)) - eyeTop)).toBeLessThanOrEqual(1);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  // Regression: #2060 compaction jump/activity close stay scoped, anchored
  async function test_turn_eyes_remain_independent_around_compaction_and_hold_scroll(
    browser,
    base,
  ) {
    const longReply = "Details stay in their own compaction range. ".repeat(12);
    const tool = (id: string, input: string) =>
      fixtureRow(id, "tool", "", {
        kind: "tool_call",
        name: "read",
        args: input,
        result: `${input} output`,
      });
    const rows = [
      fixtureRow("u1", "user", "first request"),
      tool("t1", "first-point-range"),
      fixtureRow("a1", "assistant", longReply.repeat(2)),
      fixtureRow("u2", "user", "second request"),
      tool("t2", "second-point-range"),
      fixtureRow("a2", "assistant", longReply),
      fixtureRow("c1", "compaction", "Context compacted", {
        kind: "marker",
        role: "compaction",
        meta: {
          compact_marker: true,
          firstKeptEntryId: "u2",
        },
      }),
      fixtureRow("u3", "user", "latest request"),
      tool("t3", "after-point"),
      fixtureRow("a3", "assistant", longReply.repeat(3)),
      fixtureRow(
        "notice",
        "compaction-notice",
        "Context compacted at 27k tokens.",
        {
          kind: "marker",
          meta: { summaryEntryId: "c1" },
        },
      ),
    ];
    const thread: any = {
      id: "main",
      title: "Compaction ranges",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: rows.length,
      window_cursor: 0,
      rows,
    };
    const shotDir = process.env.COMPACTION_RANGE_SHOTS ?? "";
    for (const [name, viewport, mobile, touch] of [
      ["desktop", { width: 1280, height: 800 }, false, false],
      ["mobile", { width: 390, height: 844 }, true, true],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: touch,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await mockConversation(page, base, "main", () => thread);
        await gotoRoot(page, base);
        const boundaries = page.locator(".activity-boundary");
        await boundaries.nth(2).waitFor();
        const marker = boundaries.nth(1).locator(".compacted-activity");
        const jump = page.locator(".compaction-jump-link");
        await jump.waitFor();
        expect(await jump.innerText()).toBe("Jump to first kept message");
        const startTop = await page.locator("#scroll").evaluate((element) => {
          const scope = globalThis as any;
          scope.jumpScrollEnd = undefined;
          const settled = () => {
            if (!document.querySelector(".file-jump-target")) return;
            element.removeEventListener("scrollend", settled);
            scope.jumpScrollEnd = element.scrollTop;
          };
          element.addEventListener("scrollend", settled);
          return element.scrollTop;
        });
        await jump.click();
        await page.waitForFunction(
          () => (globalThis as any).jumpScrollEnd !== undefined,
        );
        expect(
          await page.evaluate(() => (globalThis as any).jumpScrollEnd),
        ).not.toBe(startTop);
        const kept = page.locator('[data-row-id="row:u2"]');
        expect(await kept.getAttribute("class")).toContain("file-jump-target");
        expect(
          await kept.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const scroll = document
              .querySelector("#scroll")!
              .getBoundingClientRect();
            return (
              box.top >= scroll.top &&
              box.bottom <= scroll.bottom &&
              Math.abs(
                (box.top + box.bottom) / 2 - (scroll.top + scroll.bottom) / 2,
              ) <= 2
            );
          }),
        ).toBe(true);
        expect(await marker.locator(".disclosure-body").count()).toBe(0);
        await marker.locator(".compacted-head").click();
        expect(await marker.locator(".thread-marker").count()).toBe(1);
        expect(
          await marker
            .locator(".compacted-head")
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toBe(
          await page.evaluate(() => {
            const probe = document.createElement("span");
            probe.style.backgroundColor = "var(--panel-2)";
            document.body.append(probe);
            const color = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return color;
          }),
        );
        expect(await page.locator(".compaction-eye").count()).toBe(0);
        const firstEye = boundaries
          .nth(0)
          .locator(".activity-group-summary .activity-group-toggle");
        const secondEye = boundaries
          .nth(1)
          .locator(".activity-group-summary .activity-group-toggle");
        expect(await secondEye.getAttribute("aria-expanded")).toBe("true");
        await secondEye.click();
        expect(await boundaries.nth(0).locator(".turn-tool").count()).toBe(0);
        await firstEye.evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        await waitForLayout(page);
        const beforeGroup = (await firstEye.boundingBox())!;
        if (shotDir)
          await page.screenshot({ path: `${shotDir}/${name}-closed.png` });
        await firstEye.click();
        expect(await marker.locator(".disclosure-body").count()).toBe(1);
        expect(
          await marker.locator(".compacted-head").getAttribute("aria-expanded"),
        ).toBe("true");
        await waitForLayout(page);
        expect(
          Math.abs((await firstEye.boundingBox())!.y - beforeGroup.y),
        ).toBeLessThanOrEqual(2);
        expect(
          await boundaries.nth(0).locator(".turn-series-toggle").count(),
        ).toBe(1);
        expect(await boundaries.nth(1).locator(".turn-tool").count()).toBe(0);
        expect(await secondEye.getAttribute("aria-expanded")).toBe("false");
        await secondEye.click();
        expect(await secondEye.getAttribute("aria-expanded")).toBe("true");
        expect(
          await boundaries.nth(1).locator(".turn-series-toggle").count(),
        ).toBe(1);
        expect(await boundaries.nth(2).locator(".turn-tool").count()).toBe(0);
        expect(await boundaries.nth(1).locator(".turn-foot").count()).toBe(1);
        const rail = boundaries.nth(1).getByRole("button", {
          name: "Hide activity",
          exact: true,
        });
        await rail.evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        await waitForLayout(page);
        const railBox = (await rail.boundingBox())!;
        expect(railBox.y + railBox.height).toBeLessThan(
          (await marker.boundingBox())!.y,
        );
        if (shotDir)
          await page.screenshot({ path: `${shotDir}/${name}-open.png` });
        if (touch)
          await page.touchscreen.tap(
            railBox.x + 8,
            railBox.y + railBox.height / 2,
          );
        else
          await page.mouse.click(railBox.x + 8, railBox.y + railBox.height / 2);
        expect(await secondEye.getAttribute("aria-expanded")).toBe("false");
        expect(await firstEye.getAttribute("aria-expanded")).toBe("true");
        expect(
          await boundaries.nth(0).locator(".turn-series-toggle").count(),
        ).toBe(1);
        expect(await boundaries.nth(1).locator(".turn-tool").count()).toBe(0);
        expect(await marker.isVisible()).toBeTrue();

        const latestEye = page.locator(".activity-group-toggle").last();
        await latestEye.evaluate((element) =>
          element.scrollIntoView({ block: "center" }),
        );
        await waitForLayout(page);
        const before = await latestEye.boundingBox();
        expect(before).not.toBeNull();
        const beforeScroll = await page
          .locator("#scroll")
          .evaluate((element: any) => element.scrollTop);
        await latestEye.click();
        await boundaries.nth(2).locator(".turn-series-toggle").waitFor();
        await latestEye
          .locator('xpath=self::*[@aria-expanded="true"]')
          .waitFor();
        await waitForLayout(page);
        const after = await latestEye.boundingBox();
        const afterScroll = await page
          .locator("#scroll")
          .evaluate((element: any) => element.scrollTop);
        expect(after).not.toBeNull();
        expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
        expect(afterScroll).toBeGreaterThan(0);
        expect(Math.abs(afterScroll - beforeScroll)).toBeLessThan(
          longReply.length,
        );
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
];
