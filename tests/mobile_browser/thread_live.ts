type HTMLElement = any;
declare const document: any;
declare const innerWidth: number;
declare const requestAnimationFrame: any;
import { expect } from "bun:test";
import { tree as fixtureTree } from "./fixtures";
import { seedRevealThread } from "./thread_helpers";
import {
  captureErrors,
  conversationRead,
  fixtureRows,
  gotoRoot,
  mockConversation,
  summary,
  visibleAndUncovered,
  waitForLayout,
  turn,
  type BrowserTest,
} from "./common";

export const liveTests: BrowserTest[] = [
  async function test_running_tail_renders_latest_reply(browser, base) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      const response = await page.request.post(
        `${base}__browser-test/seed-reveal-backfill`,
      );
      const seeded = await response.json();
      await page.goto(`${base}#agent=${seeded.agent}`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .locator("#messages")
        .filter({ hasText: "pads the running tail" })
        .waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  // Regression: #2389 updates must arrive through SSE, not fallback view polling.
  async function test_delivery_receipts_do_not_duplicate_transcript_messages(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      const messages = [
        "First interruption",
        "Second interruption",
        "Third interruption",
      ];
      const messageIds = Object.fromEntries(
        messages.map((content, index) => [content, `steer-${index + 1}`]),
      );
      const tree = [
        {
          id: "main",
          parent: null,
          updated: 1,
          title: "Agent",
          kind: null,
          status: "running",
          children: 0,
          queued: 0,
          preview: "",
          muted: false,
        },
      ];
      const currentTurn: any = turn("turn-main", "Opening request", "");
      currentTurn.ended_at = null;
      currentTurn.open = true;
      currentTurn.status = "open";
      currentTurn.summary = null;
      const segment = currentTurn.segments[0];
      segment.assistant = null;
      segment.summary = null;
      segment.tools = [];
      const thread: any = {
        id: "main",
        title: "Agent",
        parent: null,
        status: "running",
        active_run: "run-main",
        msg_count: 1,
        window_cursor: 0,
        turns: [currentTurn],
        draft: { text: "", tools: 0, tool_active: 0 },
        pending: [],
      };
      const tool = (index: number) => ({
        kind: "tool",
        offset: 10 + index,
        seq: index,
        name: "bash",
        input: `step-${index}`,
        input_full: `step-${index}`,
        call_id: `call-${index}`,
        status: "ok",
        stat: { kind: "shell" },
      });
      const pollPhase = async (text: string) => {
        thread.draft.text = text;
        revision++;
        await page
          .locator('.agent[data-id="main"]')
          .evaluate((element) => (element as HTMLElement).click());
        await page
          .locator(".msg.assistant .content", { hasText: text })
          .waitFor();
      };
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({ json: tree }),
      );
      let revision = 0;
      let eventRevision = 0;
      let eventRows: any[] | null = null;
      const initialRows = structuredClone(fixtureRows(thread));
      await page.route(`${base}api/conversations/main/view?*`, (route) =>
        route.fulfill({
          json: {
            status: "ready",
            instance_id: "receipts",
            revision,
            blocks: initialRows,
            older: false,
            newer: false,
          },
        }),
      );
      await page.route(`${base}api/conversations/main/events`, (route) => {
        const currentRows = fixtureRows(thread);
        if (eventRows !== currentRows) {
          eventRows = currentRows;
          eventRevision++;
        }
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            `retry: 3000\n\n` +
            `id: receipts:${eventRevision}\n` +
            "event: snapshot\n" +
            `data: ${JSON.stringify({ status: "ready", instance_id: "receipts", revision: eventRevision, blocks: currentRows, older: false, newer: false })}\n\n`,
        });
      });
      await page.route(conversationRead(base, "main"), (route) =>
        route.fulfill({
          json: {
            id: "main",
            title: "Agent",
            status: thread.status,
            active_run: thread.active_run,
            msg_count: thread.msg_count,
            window_cursor: thread.window_cursor,
            turns: thread.turns,
            draft: thread.draft,
            pending: [],
          },
        }),
      );
      await page.route(`${base}api/conversations/main/deliver`, (route) => {
        const content = route.request().postDataJSON().content as string;
        const messageId = messageIds[content as keyof typeof messageIds];
        thread.pending.push({
          role: "user",
          content,
          id: messageId,
          steer: true,
          delivery_state: "accepted",
        });
        return route.fulfill({ json: { message_id: messageId, steer: true } });
      });
      await gotoRoot(page, base);
      const composer = page.locator("#input");
      segment.tools = [tool(1), tool(2)];
      await pollPhase("after step 2");
      for (const [content, tools, phase] of [
        [messages[0], [tool(3), tool(4)], "after step 4"],
        [messages[1], [tool(5)], "after step 5"],
        [messages[2], [tool(6)], "after step 6"],
      ] as const) {
        await composer.fill(content);
        await Promise.all([
          page.waitForResponse(`${base}api/conversations/main/deliver`),
          page.getByRole("button", { name: "Send message" }).click(),
        ]);
        segment.tools.push(...tools);
        await pollPhase(phase);
        expect(
          await page.locator(".msg.user", { hasText: content }).count(),
        ).toBe(1);
      }
      expect(await page.locator(".message-received").count()).toBe(0);
      thread.accepted_messages_hidden = 7;
      await pollPhase("accepted overflow");
      expect(await page.locator(".accepted-overflow").count()).toBe(0);
      thread.accepted_messages_hidden = 0;
      for (const message of thread.pending)
        message.delivery_state = "materialized";
      await pollPhase("materialized receipts");
      expect(await page.locator(".message-received").count()).toBe(0);
      currentTurn.segments = [
        {
          user: segment.user,
          tools: [tool(1), tool(2)],
          assistant: null,
          summary: null,
        },
        ...messages.map((content, index) => ({
          user: [
            {
              kind: "user",
              offset: 30 + index,
              role: "user",
              content,
            },
          ],
          tools:
            index === 0
              ? [tool(3), tool(4)]
              : index === 1
                ? [tool(5)]
                : [tool(6)],
          assistant: null,
          summary: null,
        })),
      ];
      await pollPhase("settled segments");
      await page.waitForFunction(
        "!document.querySelector('.msg.user.accepted')",
      );
      for (const content of messages)
        expect(
          await page.locator(".msg.user", { hasText: content }).count(),
        ).toBe(1);
      expect(await page.locator(".message-received").count()).toBe(0);
      const heldDelivery: any[] = [];
      const fastMessage = "Delivered before the response";
      await page.route(`${base}api/conversations/main/deliver`, (route) => {
        expect(route.request().postDataJSON().content).toBe(fastMessage);
        heldDelivery.push(route);
        thread.pending = [];
        currentTurn.segments.push({
          user: [
            {
              kind: "user",
              role: "user",
              offset: 100,
              content: fastMessage,
            },
          ],
          tools: [],
          assistant: null,
          summary: null,
        });
        revision++;
      });
      await composer.fill(fastMessage);
      await page.getByRole("button", { name: "Send message" }).click();
      await page
        .locator(".msg.user:not(.pending)", { hasText: fastMessage })
        .waitFor();
      await Promise.all([
        page.waitForResponse(`${base}api/conversations/main/deliver`),
        heldDelivery[0].fulfill({
          json: { message_id: "fast-delivery", steer: true },
        }),
      ]);
      await pollPhase("after fast delivery");
      expect(
        await page
          .locator(".msg.user.pending", { hasText: fastMessage })
          .count(),
      ).toBe(0);
      expect(
        await page.locator(".msg.user", { hasText: fastMessage }).count(),
      ).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_live_rows_separate_consecutive_replies(browser, base) {
    const replies = [
      "First completed reply.",
      "Second completed reply.",
      "Third completed reply.",
    ];
    const thread: any = {
      id: "main",
      title: "Live replies",
      status: "running",
      active_run: "run-live",
      rows: [
        {
          id: "u",
          kind: "text",
          role: "user",
          origin: "operator",
          text: "Keep coordinating",
        },
        ...replies.map((reply, index) => ({
          id: `a${index}`,
          kind: "text",
          role: "assistant",
          text: reply,
          live: true,
        })),
      ],
    };
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      await mockConversation(page, base, "main", () => thread);
      await gotoRoot(page, base);
      const paragraphs = page.locator(
        ".turn.current .msg.assistant > .content p",
      );
      await paragraphs.nth(1).waitFor();
      expect(await paragraphs.allInnerTexts()).toEqual([
        replies[0].trim(),
        replies.at(-1)!.trim(),
      ]);
      await page
        .locator(".activity-group-summary .activity-group-toggle")
        .click();
      expect(await paragraphs.allInnerTexts()).toEqual(
        replies.map((reply) => reply.trim()),
      );
      const boxes = await paragraphs.evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom };
        }),
      );
      expect(
        boxes.every(
          (box: any, index: number) =>
            index === 0 || box.top > boxes[index - 1].bottom,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_held_shell_finalizes_provider_segment_without_duplicate(
    browser,
    base,
  ) {
    const turnId = "held-shell-turn";
    const committedId = "1".repeat(24);
    const live: any = {
      turn_id: turnId,
      cursor: 2000,
      started_at: 1,
      ended_at: null,
      open: true,
      status: "open",
      partial: false,
      summary: null,
      segments: [
        {
          user: [
            {
              kind: "user",
              offset: 2010,
              role: "user",
              content: "Run the long check",
              ts: 1,
            },
          ],
          tools: [],
          assistant: {
            kind: "assistant",
            offset: 2020,
            role: "assistant",
            id: committedId,
            content: "The provider response is complete.",
            live: true,
          },
          summary: summary(),
        },
      ],
    };
    const thread: any = {
      id: "main",
      title: "Held shell",
      parent: null,
      status: "running",
      active_run: "run-held-shell",
      kind: null,
      msg_count: 2,
      window_cursor: 2000,
      turns: [live],
      draft: null,
      shells: {
        status: "ready",
        scope: "selected_agent_current_session",
        agent_id: "main",
        agent_title: "Held shell",
        items: [
          {
            command: "sleep 120",
            mode: "background",
            status: "running",
            started_at: 1,
            elapsed_seconds: 20,
          },
        ],
        truncated: false,
        active_count: 1,
      },
    };
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      await mockConversation(page, base, "main", () => thread);
      await gotoRoot(page, base);
      await page
        .locator('.turn.current .working .live-label[title="Thinking"]')
        .waitFor();
      const contents = page.locator(".turn.current .msg.assistant > .content");
      expect(await contents.allInnerTexts()).toEqual([
        "The provider response is complete.",
      ]);
      const workLabel = page.locator(".turn.current .working .live-label");
      expect(await workLabel.getAttribute("title")).toBe("Thinking");
      const chip = page.locator(".turn.current .shell-chip");
      expect(await chip.count()).toBe(1);
      expect((await chip.innerText()).trim()).toBe("1");
      expect(await chip.getAttribute("aria-label")).toBe(
        "1 active shell for Held shell",
      );
      expect(
        await page
          .locator("#conv-status")
          .evaluate((element) => element.classList.contains("running")),
      ).toBe(true);

      thread.draft = {
        turn: turnId,
        message_id: "2".repeat(24),
        text: "A later monitor response is streaming.",
        tools: 0,
      };
      await page.waitForFunction(() =>
        document
          .querySelector(".turn.current")
          ?.textContent?.includes("A later monitor response is streaming."),
      );
      expect(await contents.allInnerTexts()).toEqual([
        "The provider response is complete.",
        "A later monitor response is streaming.",
      ]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_failed_tail_turn_shows_its_outcome(browser, base) {
    const failed: any = turn("failed-tail", "Run the task", "");
    failed.status = "error";
    failed.segments[0].assistant.error = "Pi sender failed";
    const live: any = turn("next-live", "Try another task", "", {
      cursor: 100,
    });
    live.open = true;
    live.status = "open";
    live.ended_at = null;
    live.segments[0].assistant = null;
    const thread: any = {
      id: "main",
      title: "Failed turn",
      parent: null,
      status: "running",
      active_run: "next-run",
      kind: null,
      msg_count: 3,
      window_cursor: 0,
      turns: [failed, live],
      pending: [],
      draft: { turn: "next-live", text: "Trying again.", tools: 0 },
    };
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      await mockConversation(page, base, "main", () => thread);
      await gotoRoot(page, base);
      const outcome = page.locator(
        ".turn:not(.current) .turn-foot .turn-outcome.error",
      );
      await outcome.waitFor();
      expect(await outcome.innerText()).toBe("Failed");
      await visibleAndUncovered(
        page,
        ".turn:not(.current) .turn-outcome.error",
      );
      expect(
        await page.locator(".turn:not(.current) .error-note").innerText(),
      ).toBe("Pi sender failed");
      expect(await page.locator(".turn.current").innerText()).toContain(
        "Trying again.",
      );
      thread.status = "idle";
      thread.active_run = null;
      thread.draft = null;
      live.open = false;
      live.status = "idle";
      live.ended_at = 3;
      live.segments[0].assistant = {
        kind: "assistant",
        offset: 130,
        role: "assistant",
        content: "Done.",
      };
      await page.waitForFunction(() =>
        document.querySelector(".turn.current")?.textContent?.includes("Done."),
      );
      expect(await outcome.innerText()).toBe("Failed");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_live_working_row_separates_summary_from_latest_action(
    browser,
    base,
  ) {
    const rows: any[] = [
      {
        id: "u",
        kind: "text",
        role: "user",
        origin: "operator",
        text: "Implement the change",
      },
      { id: "a1", kind: "text", role: "assistant", text: "Earlier reply." },
      {
        id: "a1#c1",
        kind: "tool_call",
        role: "tool",
        text: "",
        name: "bash",
        args: '{"command":"echo done"}',
        result: "done",
        stat: { kind: "shell" },
      },
      {
        id: "a2",
        kind: "text",
        role: "assistant",
        text: "Latest reply.",
        live: true,
      },
      {
        id: "a2#c2",
        kind: "tool_call",
        role: "tool",
        text: "",
        name: "bash",
        input: "Run python",
        args: '{"command":"python task.py"}',
        running: true,
        stat: { kind: "shell" },
        live: true,
      },
    ];
    const thread: any = {
      id: "main",
      status: "running",
      active_run: "run",
      rows,
      turns: [
        {
          turn_id: "live-working",
          cursor: 0,
          started_at: 1,
          ended_at: null,
          open: true,
          status: "open",
          partial: false,
          summary: null,
          segments: [],
        },
      ],
    };
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
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
              title: "Agent",
              kind: null,
              status: thread.status,
              active_run: thread.active_run,
              updated: 1,
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
      await page.route(conversationRead(base, "main"), (route) =>
        route.fulfill({ json: thread }),
      );
      await gotoRoot(page, base);
      const label = page.locator(".working .live-label");
      await label.waitFor();
      expect(await label.innerText()).toBe("Thinking");
      expect(await label.getAttribute("title")).toBe("Thinking");
      expect(
        await page.locator(".turn.current .turn-summary.total").count(),
      ).toBe(0);
      expect(
        await page.getByText("Earlier reply.", { exact: true }).count(),
      ).toBe(1);
      expect(
        await page.getByText("Latest reply.", { exact: true }).count(),
      ).toBe(1);
      rows[4].running = false;
      rows[4].result = "finished";
      thread.status = "idle";
      await page
        .locator('.agent[data-id="main"]')
        .evaluate((element) => (element as HTMLElement).click());
      await page.locator("#messages .working").waitFor({ state: "detached" });
      expect(await page.locator(".turn-foot .turn-summary").count()).toBe(0);
      const hidden = page.locator(".activity-group-summary .turn-summary");
      await hidden.filter({ hasText: "Ran 2 commands" }).waitFor();
      expect(await hidden.allInnerTexts()).toEqual(["Ran 2 commands"]);
      expect(
        await page.getByText("Latest reply.", { exact: true }).count(),
      ).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_eye_toggle_keeps_summary_line_boxes(browser, base) {
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
        await seedRevealThread(page, base);
        const summaries = page
          .locator(".activity-boundary")
          .first()
          .locator(".activity-group-summary");
        expect(await summaries.count()).toBe(1);
        await summaries.first().scrollIntoViewIfNeeded();
        await waitForLayout(page);
        const before = (await summaries.first().boundingBox())!;
        await summaries.first().locator(".activity-group-toggle").click();
        await summaries
          .first()
          .locator('.activity-group-toggle[aria-expanded="true"]')
          .waitFor();
        await waitForLayout(page);
        const after = (await summaries.first().boundingBox())!;
        expect(await summaries.count()).toBe(1);
        expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
        expect(
          await summaries
            .first()
            .locator(".activity-group-toggle")
            .getAttribute("aria-expanded"),
        ).toBe("true");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_hidden_chunk_press_expands_series_in_place(
    browser,
    base,
  ) {
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
        await seedRevealThread(page, base);
        const chunk = page
          .locator(".activity-group-summary .activity-group-toggle")
          .first();
        const totalEyes = await page
          .locator(".activity-group-summary .activity-group-toggle")
          .count();
        const boundary = chunk.locator(
          "xpath=ancestor::section[contains(@class,'activity-boundary')]",
        );
        await chunk.scrollIntoViewIfNeeded();
        await waitForLayout(page);
        const before = await chunk.boundingBox();
        expect(before).not.toBeNull();
        await chunk.click();
        await boundary.locator(".activity-group.open").waitFor();
        await waitForLayout(page);
        expect(await boundary.locator(".activity-group.open").count()).toBe(1);
        expect(
          await page
            .locator(".activity-group-summary .activity-group-toggle")
            .count(),
        ).toBe(totalEyes);
        expect(await page.locator(".activity-group.open").count()).toBe(1);
        expect(
          await page
            .locator('.turn-series-toggle[aria-expanded="true"]')
            .count(),
        ).toBe(0);
        const box = await chunk.boundingBox();
        expect(box).not.toBeNull();
        expect(Math.abs(box!.y - before!.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(box!.height - before!.height)).toBeLessThanOrEqual(1);
        const series = boundary.locator(".turn-series-toggle").first();
        await series.click();
        expect(await series.getAttribute("aria-expanded")).toBe("true");
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_settled_reply_does_not_replay_on_send(browser, base) {
    const reply = "Spawned worker bee.";
    const thread: any = {
      id: "main",
      title: "Agent",
      parent: null,
      status: "idle",
      active_run: null,
      kind: null,
      msg_count: 2,
      window_cursor: 0,
      turns: [turn("settled-t1", "Please proceed.", reply)],
      draft: null,
      pending: [],
    };
    for (const [viewport, mobile] of [
      [{ width: 1280, height: 800 }, false],
      [{ width: 390, height: 844 }, true],
    ] as const) {
      thread.status = "idle";
      thread.active_run = null;
      const context = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
      });
      try {
        const page = await context.newPage();
        const errors = captureErrors(page);
        await mockConversation(page, base, "main", () => thread);
        await page.route(`${base}api/conversations/main/deliver`, (route) =>
          route.fulfill({ json: { message_id: "plain-1" } }),
        );
        await gotoRoot(page, base);
        await page.locator('.agent[data-id="main"]').waitFor();
        await page
          .locator('.agent[data-id="main"]')
          .evaluate((element) => (element as HTMLElement).click());
        const row = page.locator(".msg.assistant .content", { hasText: reply });
        await row.waitFor();
        thread.status = "running";
        thread.active_run = "run-1";
        await page
          .locator('.agent[data-id="main"]')
          .evaluate((element) => (element as HTMLElement).click());
        await page.locator("#conv-status.running").waitFor();
        expect(await row.innerText()).toBe(reply);
        expect(await row.locator(".reveal-chunk").count()).toBe(0);
        await page.locator("#input").fill("status update please");
        await Promise.all([
          page.waitForResponse(`${base}api/conversations/main/deliver`),
          page.getByRole("button", { name: "Send message" }).click(),
        ]);
        const samples: any[] = await row.evaluate(
          (element) =>
            new Promise<any[]>((resolve) => {
              const values: any[] = [];
              const started = performance.now();
              const tick = () => {
                values.push({
                  text: (element as HTMLElement).innerText,
                  chunks: element.querySelectorAll(".reveal-chunk").length,
                });
                if (performance.now() - started < 600)
                  requestAnimationFrame(tick);
                else resolve(values);
              };
              tick();
            }),
        );

        expect(
          samples.every(
            (sample) => sample.text === reply && sample.chunks === 0,
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  },
  async function test_queued_panel_shows_for_admitted_undispatched_send(
    browser,
    base,
  ) {
    const thread: any = {
      id: "main",
      title: "Agent",
      parent: null,
      status: "idle",
      active_run: null,
      msg_count: 0,
      window_cursor: 0,
      turns: [],
      draft: null,
      pending: [
        { role: "user", content: "is anyone there?", id: "m-queued-1" },
      ],
    };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      await mockConversation(page, base, "main", () => thread);
      await gotoRoot(page, base);
      const queued = page.locator(".live-panel-box.is-queued", {
        hasText: "Queued",
      });
      await queued.waitFor();
      expect(await queued.count()).toBe(1);
      expect(
        await page
          .locator(".msg.user.pending", { hasText: "is anyone there?" })
          .count(),
      ).toBe(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      thread.pending = [
        {
          role: "user",
          content: "is anyone there?",
          id: "m-queued-1",
          uncertain: true,
          error: "PiRPCError: provider not configured",
        },
      ];
      await page
        .locator('.agent[data-id="main"]')
        .evaluate((element) => (element as HTMLElement).click());
      await page.locator(".pending-failure").waitFor();
      expect(await page.locator(".live-panel-box.is-queued").count()).toBe(0);
      expect(await page.locator(".pending-failure").count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  },
  async function test_interrupted_turn_hides_error_and_keeps_one_live_panel(
    browser,
    base,
  ) {
    const stopped: any = turn("stopped", "Start the work", "");
    stopped.status = "interrupted";
    stopped.segments[0].assistant.error = "Request aborted";
    stopped.segments[0].assistant.error_detail = "AbortError";
    stopped.segments[0].assistant.stop_reason = "aborted";
    const thread: any = {
      id: "main",
      title: "Agent",
      parent: null,
      status: "idle",
      active_run: null,
      msg_count: 2,
      window_cursor: 0,
      turns: [stopped],
      draft: null,
      pending: [{ role: "user", content: "next", id: "m-queued-2" }],
      shells: {
        status: "ready",
        active_count: 2,
        background_count: 2,
        items: [],
      },
    };
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      const errors = captureErrors(page);
      await page.route(`${base}api/tree*`, (route) =>
        route.fulfill({
          json: [
            ...fixtureTree(),
            {
              ...fixtureTree()[0],
              id: "child-1",
              parent: "main",
              title: "Child 1",
              status: "running",
            },
            {
              ...fixtureTree()[0],
              id: "child-2",
              parent: "main",
              title: "Child 2",
              status: "running",
            },
          ],
        }),
      );
      await mockConversation(page, base, "main", () => thread);
      await gotoRoot(page, base);
      await page.getByText("Stopped", { exact: true }).waitFor();
      expect(await page.locator(".error-note").count()).toBe(0);
      expect(await page.locator(".live-panel").count()).toBe(1);
      expect(await page.locator(".live-panel-box.is-waiting").count()).toBe(0);
      expect(await page.locator(".live-panel-box.is-queued").count()).toBe(1);
      expect((await page.locator(".shell-chip").innerText()).trim()).toBe("2");
      expect(
        await page.locator(".shell-chip").getAttribute("aria-label"),
      ).toContain("2 active shells");
      expect((await page.locator(".agent-chip").innerText()).trim()).toBe("2");
      expect(
        await page.locator(".agent-chip").getAttribute("aria-label"),
      ).toContain("2 active agents");
      expect(errors).toEqual([]);

      await page.reload();
      await page.getByText("Stopped", { exact: true }).waitFor();
      expect(await page.locator(".error-note").count()).toBe(0);
      expect(await page.locator(".live-panel").count()).toBe(1);
      expect(await page.locator(".live-panel-box.is-waiting").count()).toBe(0);
      expect(await page.locator(".live-panel-box.is-queued").count()).toBe(1);
    } finally {
      await context.close();
    }
  },
];
