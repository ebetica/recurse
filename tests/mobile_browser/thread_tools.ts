import { mkdir } from "node:fs/promises";
type Element = any;
declare const document: any;
declare const Node: any;
declare const getComputedStyle: any;
declare const innerWidth: number;
import { expect } from "bun:test";
import {
  captureErrors,
  conversationRead,
  gotoRoot,
  mockConversation,
  routeArtifacts,
  visibleAndUncovered,
  turn,
  type BrowserTest,
} from "./common";

export const toolsTests: BrowserTest[] = [
  async function test_activity_prose_precedes_later_tools(browser, base) {
    for (const live of [true, false]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      const errors = captureErrors(page);
      await routeArtifacts(page, base);
      const prose = "I will check the files now.";
      const rows: any[] = [
        {
          id: "u1",
          kind: "text",
          role: "user",
          origin: "operator",
          text: "Check files",
        },
        {
          id: "a1",
          kind: "text",
          role: "assistant",
          text: prose,
          live,
        },
        {
          id: "read-1",
          kind: "tool_call",
          role: "tool",
          name: "read",
          text: "",
          args: "file.py",
          stat: { kind: "read" },
          live,
        },
        {
          id: "blank",
          kind: "text",
          role: "assistant",
          text: " \n\t",
          usage: { input: 12, output: 3 },
        },
        {
          id: "bash-1",
          kind: "tool_call",
          role: "tool",
          name: "bash",
          text: "",
          input: "printf hello",
          args: "printf hello; printf world",
          stat: { kind: "shell" },
          live,
        },
      ];
      const publication: any = {
        id: "publish",
        kind: "tool_call",
        role: "tool",
        name: "publish_attachment",
        text: "",
        args: "{}",
        result: "published",
        stat: { kind: "other" },
      };
      rows.push(publication);
      const viewState = { revision: 1 };
      await page.route(`${base}api/conversations/main/view?*`, (route) =>
        route.fulfill({
          json: {
            status: "ready",
            instance_id: "chronology",
            revision: viewState.revision,
            blocks: rows,
            older: false,
          },
        }),
      );
      let eventsLast: any = null;
      let eventsRevision = 0;
      await page.route(`${base}api/conversations/main/events`, (route) => {
        if (rows !== eventsLast) {
          eventsLast = rows.map((row) => ({ ...row }));
          eventsRevision++;
        }
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            `retry: 3000\n\n` +
            `id: chronology:${eventsRevision}\n` +
            "event: snapshot\n" +
            `data: ${JSON.stringify({ status: "ready", instance_id: "chronology", revision: eventsRevision, blocks: rows, older: false, newer: false })}\n\n`,
        });
      });
      await page.route(conversationRead(base, "main"), (route) =>
        route.fulfill({
          json: {
            id: "main",
            title: "Chronology",
            status: live ? "running" : "idle",
            turns: [],
            msg_count: 2,
            window_cursor: 0,
            draft: live
              ? {
                  text: prose,
                  text_blocks: [{ text: prose, after_tools: 0 }],
                  tool_calls: [
                    { call_id: "read-1", name: "read", input: "file.py" },
                  ],
                  tools: 1,
                }
              : null,
          },
        }),
      );
      try {
        await gotoRoot(page, base);
        await page
          .locator(".msg.assistant .content", { hasText: prose })
          .waitFor();
        await page.locator(".activity-group-toggle").click();
        const series = page.locator(".turn-series-toggle");
        await series.waitFor();
        expect(
          await page
            .locator(".msg.assistant .content", { hasText: prose })
            .count(),
        ).toBe(1);
        expect(
          await page.evaluate(() => {
            const proseElement = document.querySelector(
              ".msg.assistant .content",
            );
            const tools = document.querySelector(".turn-series");
            return Boolean(
              proseElement &&
              tools &&
              proseElement.compareDocumentPosition(tools) &
                Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }),
        ).toBe(true);
        expect(await series.count()).toBe(1);
        expect(await series.innerText()).toContain("Read 1 file");
        expect((await series.innerText()).toLowerCase()).toContain(
          "ran 1 command",
        );
        await series.click();
        const shell = page.locator(".turn-tool", { hasText: "printf hello" });
        expect(await shell.locator(".turn-tool-detail").innerText()).toBe(
          "printf hello; printf world",
        );
        await shell.locator(".turn-tool-head").click();
        expect(await shell.locator(".tool-payload pre").innerText()).toBe(
          "printf hello; printf world",
        );
        publication.attachment = {
          id: "a".repeat(32),
          name: "published.txt",
          size: 10,
          media_type: "text/plain",
          inline_media_type: null,
        };
        viewState.revision++;
        await page
          .locator(".agent-attachment", { hasText: "published.txt" })
          .waitFor();
        await page.locator(".activity-group-toggle").click();
        expect(
          await page
            .locator(".agent-attachment", { hasText: "published.txt" })
            .isVisible(),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await context.close();
      }
    }
  },
  async function test_streaming_tool_row_shows_command_text(browser, base) {
    const shotDir = process.env.SCREENSHOT_DIR ?? "/tmp/streaming-cmd-text";
    await mkdir(shotDir, { recursive: true });
    const short = '{"command":"python tools/subagent.py create --titl';
    const grown =
      '{"command":"python tools/subagent.py create --title \\"Short name';
    const rows: any[] = [
      {
        id: "u1",
        kind: "text",
        role: "user",
        origin: "operator",
        text: "Make an agent",
      },
      {
        id: "a1#call1",
        kind: "tool_call",
        role: "tool",
        name: "bash",
        text: "",
        args: short,
        input: null,
        live: true,
        stat: { kind: "shell" },
      },
    ];
    const thread: any = {
      id: "main",
      title: "Streaming",
      parent: null,
      status: "running",
      active_run: "run-1",
      msg_count: 1,
      window_cursor: 0,
      turns: [],
      rows,
      draft: null,
    };
    const oneLine = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight),
        clipped: element.scrollWidth > element.clientWidth,
        whiteSpace: style.whiteSpace,
        overflow: style.overflowX,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    };
    for (const [viewport, mobile, tag] of [
      [{ width: 390, height: 844 }, true, "mobile"],
      [{ width: 1280, height: 800 }, false, "desktop"],
    ] as const) {
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await routeArtifacts(page, base);
        rows[1].args = short;
        let revision = 1;
        let eventsRevision = 0;
        let eventsRows: any[] | null = null;
        await page.route(`${base}api/conversations/main/view?*`, (route) =>
          route.fulfill({
            json: {
              status: "ready",
              instance_id: "streaming",
              revision,
              blocks: rows,
              older: false,
              newer: false,
            },
          }),
        );
        await page.route(`${base}api/conversations/main/events`, (route) => {
          if (eventsRows !== rows) {
            eventsRows = rows.map((row) => ({ ...row }));
            eventsRevision++;
          }
          return route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body:
              `retry: 3000\n\n` +
              `id: streaming:${eventsRevision}\n` +
              "event: snapshot\n" +
              `data: ${JSON.stringify({ status: "ready", instance_id: "streaming", revision: eventsRevision, blocks: rows, older: false, newer: false })}\n\n`,
          });
        });
        await page.route(conversationRead(base, "main"), (route) =>
          route.fulfill({
            json: thread,
          }),
        );
        await gotoRoot(page, base);
        await page.locator(".activity-group-toggle").click();
        await page.locator(".turn-series-toggle").click();
        const row = page.locator(".turn-tool-detail").first();
        await row.waitFor();
        expect(await row.evaluate((element) => element.textContent)).toBe(
          "python tools/subagent.py create --titl",
        );
        const box = await row.evaluate(oneLine);
        expect(box.height).toBeLessThanOrEqual(box.lineHeight + 1);
        expect(box.whiteSpace).toBe("nowrap");
        expect(box.overflow).toBe("hidden");
        expect(box.pageOverflow).toBeLessThanOrEqual(0);
        const panel = page.locator(".live-label");
        await panel.waitFor();
        const first = await panel.innerText();
        expect(first).toBe("Thinking");
        expect(first).not.toContain('{"command"');
        const panelBox = await panel.evaluate(oneLine);
        expect(panelBox.height).toBeLessThanOrEqual(panelBox.lineHeight + 1);
        expect(panelBox.whiteSpace).toBe("nowrap");
        rows[1].args = grown;
        revision++;
        await page
          .locator(".turn-tool-detail", { hasText: "Short name" })
          .waitFor({ timeout: 20_000 });
        expect(await row.evaluate((element) => element.textContent)).toBe(
          'python tools/subagent.py create --title "Short name',
        );
        const second = await panel.innerText();
        expect(second).toBe("Thinking");
        expect(second).not.toContain("python");
        await page.screenshot({ path: `${shotDir}/streaming-cmd-${tag}.png` });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_tool_row_clips_a_long_command(browser, base) {
    const command =
      "cd /repo && grep -rn 'needle' " +
      Array.from({ length: 120 }, (_, index) => `src/module_${index}.py`).join(
        " ",
      );
    const thread: any = {
      id: "main",
      title: "Tool row agent",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 2,
      window_cursor: 0,
      turns: [
        turn("t1", "Search the repo", "Searched the repo.", {
          tools: [
            {
              kind: "tool",
              offset: 40,
              seq: 1,
              name: "bash",
              input: "Run cd",
              input_full: command,
              status: "ok",
              stat: { kind: "shell" },
            },
          ],
        }),
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
        await mockConversation(page, base, "main", () => thread);
        await page.route(
          `${base}api/conversations/main/turn-prompt**`,
          (route) =>
            route.fulfill({
              json: {
                driving: "",
                message: "Searched the repo.",
                system: "",
                role: "assistant",
                steering: false,
              },
            }),
        );
        await gotoRoot(page, base);
        await page
          .locator("#messages")
          .filter({ hasText: "Searched the repo." })
          .waitFor();
        await page.locator(".turn.current .activity-group-toggle").click();
        await page.locator(".turn-series-toggle").click();
        const row = page.locator(".turn-tool-detail").first();
        await row.waitFor();
        await visibleAndUncovered(page, ".turn-tool-detail");
        expect((await row.innerText()).startsWith("cd /repo && grep")).toBe(
          true,
        );
        expect(await row.evaluate((element) => element.textContent)).toBe(
          command,
        );
        expect(await row.getAttribute("title")).toBe(command);
        expect(await row.getAttribute("aria-label")).toBe(command);
        const box = await row.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            lineHeight: parseFloat(style.lineHeight),
            clipped: element.scrollWidth > element.clientWidth,
            whiteSpace: style.whiteSpace,
            overflow: style.overflowX,
            pageOverflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        expect(box.height).toBeLessThanOrEqual(box.lineHeight + 1);
        expect(box.clipped).toBe(true);
        expect(box.whiteSpace).toBe("nowrap");
        expect(box.overflow).toBe("hidden");
        expect(box.pageOverflow).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
];
