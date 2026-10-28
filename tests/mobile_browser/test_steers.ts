import { expect } from "bun:test";
import type { Route } from "playwright";
import {
  TURN_TOTAL_USAGE,
  captureErrors,
  gotoRoot,
  mockConversation,
  runBrowserTests,
  summary,
  turn,
  visibleAndUncovered,
  type BrowserTest,
} from "./common";

function rowsFor(thread: any): any[] {
  const rows: any[] = [];
  for (const current of thread.turns ?? []) {
    const key = String(current.turn_id);
    for (const [index, segment] of (current.segments ?? []).entries()) {
      for (const [at, user] of (segment.user ?? []).entries())
        rows.push({
          id: user.id ?? `${key}:u${index}:${at}`,
          kind: "text",
          role: "user",
          origin:
            user.origin ?? user.source ?? (user.from ? "agent" : "operator"),
          text: user.content ?? "",
          name: null,
          args: "",
          result: null,
          result_truncated: false,
          live: false,
          sender: user.from,
          sender_name: user.from_name,
          steer: user.steer,
          steer_batch_size: user.steer_batch_size,
          steer_batch_id: user.steer_batch_id,
        });
      for (const [at, tool] of (segment.tools ?? []).entries())
        rows.push({
          id: tool.call_id ?? `${key}:c${index}:${at}`,
          kind: "tool_call",
          role: "tool",
          origin: "tool",
          text: "",
          name: tool.name ?? "tool",
          args: tool.input_full ?? tool.input ?? "",
          result: tool.result,
          result_truncated: false,
          live: false,
          input: tool.input,
          stat: tool.stat,
        });
      if (segment.assistant) {
        for (const [at, attachment] of (
          segment.assistant.attachments ?? []
        ).entries())
          rows.push({
            id: `${key}:publication:${index}:${at}`,
            kind: "tool_call",
            role: "tool",
            origin: "tool",
            text: "",
            name: "publish_attachment",
            args: "",
            result: "published",
            result_truncated: false,
            live: false,
            attachment,
          });
        rows.push({
          id: segment.assistant.id ?? `${key}:a${index}`,
          kind: "text",
          role: "assistant",
          origin: "assistant",
          text: segment.assistant.content ?? "",
          name: null,
          args: "",
          result: null,
          result_truncated: false,
          live: false,
          usage: segment.assistant.usage,
          error: segment.assistant.error,
        });
      }
    }
  }
  return rows;
}

export const tests: BrowserTest[] = [
  async function test_grouped_steers_have_no_summary_label(browser, base) {
    const grouped = turn("grouped-steers", "First steer", "Grouped reply", {
      cursor: 500,
    });
    grouped.segments[0].user = [
      {
        kind: "user",
        offset: 510,
        role: "user",
        content: "First steer",
        ts: 1,
        steer: true,
        steer_batch_size: 2,
        steer_batch_id: "batch",
      },
      {
        kind: "user",
        offset: 520,
        role: "user",
        content: "Second steer",
        ts: 1,
        steer: true,
        steer_batch_size: 2,
        steer_batch_id: "batch",
      },
    ];
    const thread: any = {
      id: "main",
      title: "Grouped steers",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 3,
      window_cursor: 500,
      turns: [grouped],
    };
    thread.rows = rowsFor(thread);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({
        json: [
          {
            id: "main",
            parent: null,
            title: "Grouped steers",
            kind: null,
            status: "idle",
            updated: 1,
            children: 0,
            queued: 0,
            preview: "",
            muted: false,
          },
        ],
      }),
    );
    await mockConversation(page, base, "main", () => thread);
    await gotoRoot(page, base);
    await page
      .locator("#messages")
      .filter({ hasText: "Grouped reply" })
      .waitFor();
    expect(await page.locator("#messages .msg.user").count()).toBe(2);
    expect(
      await page
        .locator(".turn-summary", { hasText: "messages steered together" })
        .count(),
    ).toBe(0);
    expect(await page.locator("#messages").innerText()).toContain(
      "First steer",
    );
    expect(await page.locator("#messages").innerText()).toContain(
      "Second steer",
    );
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_visible_replies_stay_on_their_side_of_steer_boundaries(
    browser,
    base,
  ) {
    const segment = (
      ask: string | null,
      reply: string,
      offset: number,
      attachments: any[] = [],
      steer = false,
    ) => ({
      user:
        ask === null
          ? []
          : [
              {
                kind: "user",
                offset,
                role: "user",
                content: ask,
                ts: 1,
                ...(steer ? { steer: true } : {}),
              },
            ],
      tools: [],
      summary: null,
      assistant: {
        kind: "assistant",
        offset: offset + 10,
        role: "assistant",
        content: reply,
        attachments,
      },
    });
    const hidden = {
      id: "h".repeat(32),
      name: "hidden.txt",
      size: 10,
      media_type: "text/plain",
      inline_media_type: null,
    };
    const final = {
      id: "f".repeat(32),
      name: "final.txt",
      size: 20,
      media_type: "text/plain",
      inline_media_type: null,
    };
    const visible = {
      id: "v".repeat(32),
      name: "visible.txt",
      size: 12,
      media_type: "text/plain",
      inline_media_type: null,
    };
    const steered = {
      turn_id: "two-steers",
      cursor: 500,
      started_at: 1,
      ended_at: 4,
      open: false,
      status: "idle",
      partial: false,
      summary: summary(),
      segments: [
        segment("First request", "first 😀", 510, [hidden]),
        segment(null, "Before steer one", 530, [visible]),
        segment("Steer one", "二nd", 550, [], true),
        segment(null, "Before steer two", 570),
        segment("  Steer two  ", "Final answer", 590, [final], true),
        segment(null, "Wrapped up.", 610),
      ],
    };
    const thread: any = {
      id: "main",
      title: "Steered agent",
      parent: null,
      status: "idle",
      kind: null,
      msg_count: 9,
      window_cursor: 500,
      turns: [steered],
    };
    thread.rows = rowsFor(thread);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    await page.route(`${base}api/tree*`, (route) =>
      route.fulfill({
        json: [
          {
            id: "main",
            parent: null,
            updated: 1,
            title: "Steered agent",
            kind: null,
            status: "idle",
            children: 0,
            queued: 0,
            preview: "",
            muted: false,
          },
        ],
      }),
    );
    await mockConversation(page, base, "main", () => thread);
    await gotoRoot(page, base);
    await page
      .locator("#messages")
      .filter({ hasText: "Wrapped up." })
      .waitFor();
    const group = async (ask: string) => {
      const boundaries = page.locator("#messages .activity-boundary");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const matched = [];
        for (let index = 0; index < (await boundaries.count()); index++) {
          const candidate = boundaries.nth(index);
          if (
            (await candidate.locator(".msg.user").count()) === 1 &&
            (await candidate.locator(".msg.user").innerText()) === ask
          )
            matched.push(candidate);
        }
        if (matched.length === 1) return matched[0];
        // test-check-allow: T6 Bounded poll for a unique native DOM boundary.
        await page.waitForTimeout(100);
      }
      throw new Error(`timed out waiting for ${ask}`);
    };
    const first = await group("First request");
    const second = await group("Steer one");
    const third = await group("Steer two");
    expect(await third.locator(".msg.user > .bubble").textContent()).toBe(
      "Steer two",
    );
    for (const [boundary, replies, others, eyeCount] of [
      [first, ["first 😀", "Before steer one"], ["二nd", "Final answer"], 1],
      [second, ["二nd", "Before steer two"], ["first 😀", "Wrapped up."], 0],
      [third, ["Final answer", "Wrapped up."], ["first 😀", "二nd"], 1],
    ] as const) {
      const text = await boundary.innerText();
      for (const reply of replies) expect(text).toContain(reply);
      for (const other of others) expect(text).not.toContain(other);
      expect(await boundary.locator(".turn-foot .turn-summary").count()).toBe(
        0,
      );
      expect(await boundary.locator(".activity-group-toggle").count()).toBe(
        eyeCount,
      );
    }
    expect(await first.locator(".agent-attachment-item").count()).toBe(2);
    expect(await second.locator(".agent-attachment-item").count()).toBe(0);
    expect(await third.locator(".agent-attachment-item").count()).toBe(1);
    expect(
      await first
        .locator(".msg.assistant", { hasText: "Before steer one" })
        .locator(".agent-attachment-item")
        .count(),
    ).toBe(1);
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_steered_turn_shows_one_token_control_per_response(
    browser,
    base,
  ) {
    const opened = await openSteeredThread(
      browser,
      base,
      steeredTurn(TURN_TOTAL_USAGE),
    );
    const { context, page, errors, asked } = opened;
    expect(await page.locator(".turn-tokens").count()).toBe(2);
    expect(
      await page
        .locator(".msg .turn-tokens:not(.turn-foot .turn-tokens)")
        .count(),
    ).toBe(0);
    expect(await page.locator(".turn-foot-actions .turn-tokens").count()).toBe(
      2,
    );
    expect(
      await page
        .locator(".turn-foot-actions .turn-tokens")
        .first()
        .getAttribute("title"),
    ).toBe("View activity token usage: 530 model tokens");
    expect(
      await page
        .locator(".turn-foot-actions .turn-tokens")
        .last()
        .getAttribute("title"),
    ).toBe("View activity token usage: 1.8k model tokens");
    const eyeCount = await page.locator(".activity-group-toggle").count();
    for (let index = 0; index < eyeCount; index++)
      await page.locator(".activity-group-toggle").nth(index).click();
    await page.locator(".turn-series-toggle").first().waitFor();
    expect(await page.locator(".turn-tool").count()).toBe(0);
    for (const series of await page.locator(".turn-series-toggle").all())
      await series.click();
    expect(await page.locator(".turn-tool").count()).toBe(3);
    expect(
      await page
        .locator(".msg.assistant", { hasText: "Started the migration." })
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator(".msg.assistant", { hasText: "Dropped the index." })
        .count(),
    ).toBe(1);
    expect(await page.locator(".turn-series-toggle").count()).toBe(2);
    expect(await page.locator(".msg.collapsed").count()).toBe(0);
    await page.locator(".turn-series-toggle").first().click();
    expect(await page.locator(".turn-tool").count()).toBe(1);
    await page.locator(".turn-series-toggle").first().click();
    expect(await page.locator(".turn-tool").count()).toBe(3);
    expect(await page.locator(".turn-tokens").count()).toBe(2);
    expect(
      await page
        .locator(".msg.assistant .turn-tokens:not(.turn-foot .turn-tokens)")
        .count(),
    ).toBe(0);
    expect(await page.locator(".turn-tool .turn-tokens").count()).toBe(0);
    const finalTokens = page.locator(".turn-foot-actions .turn-tokens").last();
    const finalLabel = "View activity token usage: 1.8k model tokens";
    expect(await finalTokens.getAttribute("title")).toBe(finalLabel);
    expect(await finalTokens.getAttribute("aria-label")).toBe(finalLabel);
    const body = await clickTokens(page);
    expect(asked).toEqual([]);
    expect(body).toContain(
      "Totals for 1 turn: 1 message and 1 tool call (1 model request).",
    );
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_single_reply_turn_explains_its_tool_loop_total(
    browser,
    base,
  ) {
    const total = {
      output: 96,
      input: 4_000,
      cacheRead: 160_000,
      cacheWrite: 120,
      calls: 4,
      replies: 1,
      partial: false,
    };
    const single = steeredTurn(total);
    single.segments = single.segments.slice(1);
    const rows = [
      {
        id: "user",
        kind: "text",
        role: "user",
        origin: "operator",
        text: "Inspect",
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `call-${index}`,
        kind: "text",
        role: "assistant",
        text: index === 3 ? "Dropped the index." : "",
        usage: { input: 1000, output: 24, cacheRead: 40_000, cacheWrite: 30 },
      })),
    ];
    const { context, page, errors, asked } = await openSteeredThread(
      browser,
      base,
      single,
      rows,
    );
    expect(
      await page
        .locator(".turn-foot-actions .turn-tokens")
        .getAttribute("title"),
    ).toBe("View activity token usage: 164.2k model tokens");
    const body = await clickTokens(page);
    expect(asked).toEqual([]);
    expect(body).toContain("Totals for 1 turn: 4 messages and 0 tool calls.");
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_partial_turn_total_says_how_much_it_covers(
    browser,
    base,
  ) {
    const steered = steeredTurn(null);
    const rows = rowsFor({ turns: [steered] });
    for (const row of rows) delete row.usage;
    rows.find((row) => row.text === "Started the migration.").usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    rows.splice(-1, 0, {
      id: "missing-usage",
      kind: "text",
      role: "assistant",
      text: "",
      usage: TURN_TOTAL_USAGE,
    });
    const { context, page, errors, asked } = await openSteeredThread(
      browser,
      base,
      steered,
      rows,
    );
    expect(await page.locator(".turn-tokens").count()).toBe(2);
    const tokens = page.locator(".turn-foot-actions .turn-tokens").last();
    expect(await tokens.getAttribute("title")).toBe(
      "View activity token usage: 2.3k model tokens",
    );
    expect(await tokens.getAttribute("aria-label")).toBe(
      "View activity token usage: 2.3k model tokens",
    );
    const body = await clickTokens(page);
    expect(asked).toEqual([]);
    expect(body).toContain(
      "Totals for 1 turn: 2 messages and 1 tool call (1 model request).",
    );
    expect(errors).toEqual([]);
    await context.close();
  },
  async function test_response_without_a_recorded_total_shows_one_summed_pill(
    browser,
    base,
  ) {
    const steered = steeredTurn(null);
    steered.segments = steered.segments.slice(1);
    const { context, page, errors, asked } = await openSteeredThread(
      browser,
      base,
      steered,
    );
    expect(await page.locator(".turn-tokens").count()).toBe(1);
    expect(
      await page
        .locator(".msg .turn-tokens:not(.turn-foot .turn-tokens)")
        .count(),
    ).toBe(0);
    expect(await page.locator(".turn-foot-actions .turn-tokens").count()).toBe(
      1,
    );
    const tokens = page.locator(".turn-foot-actions .turn-tokens");
    const label = "View activity token usage: 1.8k model tokens";
    expect(await tokens.getAttribute("title")).toBe(label);
    expect(await tokens.getAttribute("aria-label")).toBe(label);
    const body = await clickTokens(page);
    expect(asked).toEqual([]);
    expect(body).toContain(
      "Totals for 1 turn: 1 message and 1 tool call (1 model request).",
    );
    expect(errors).toEqual([]);
    await context.close();
  },
];

const FIRST_ANSWER_USAGE = {
  input: 100,
  output: 20,
  cacheRead: 400,
  cacheWrite: 10,
};
const FINAL_ANSWER_USAGE = {
  input: 200,
  output: 55,
  cacheRead: 1_500,
  cacheWrite: 30,
};
const STEERED_FINAL_OFFSET = 750;
function steeredTurn(total: any): any {
  const segment = (
    ask: string,
    reply: string,
    offset: number,
    usage: any,
    tools: any[],
  ) => ({
    user: [{ kind: "user", offset, role: "user", content: ask, ts: 1 }],
    tools,
    assistant: {
      kind: "assistant",
      offset: offset + 50,
      role: "assistant",
      content: reply,
      usage,
    },
    summary: summary({ tools: tools.length, shell: tools.length }),
  });
  const sum = summary({ tools: 3, shell: 3 });
  if (total !== null) sum.usage = total;
  return {
    turn_id: "steered",
    cursor: 500,
    started_at: 1,
    ended_at: 4,
    open: false,
    status: "idle",
    partial: false,
    summary: sum,
    segments: [
      segment(
        "Start the migration",
        "Started the migration.",
        510,
        FIRST_ANSWER_USAGE,
        [
          {
            kind: "tool",
            offset: 520,
            seq: 1,
            name: "bash",
            input: "Run ls",
            input_full: "ls /repo",
            status: "ok",
            stat: { kind: "shell" },
          },
          {
            kind: "tool",
            offset: 530,
            seq: 2,
            name: "bash",
            input: "/repo/schema.sql",
            input_full: "cat /repo/schema.sql",
            status: "ok",
            stat: { kind: "read", lines: 0, from: 1, to: 1 },
          },
        ],
      ),
      segment(
        "Actually drop the index first",
        "Dropped the index.",
        700,
        FINAL_ANSWER_USAGE,
        [
          {
            kind: "tool",
            offset: 720,
            seq: 3,
            name: "bash",
            input: "Run psql",
            input_full: "psql -c 'drop index'",
            status: "ok",
            stat: { kind: "shell" },
          },
        ],
      ),
    ],
  };
}
async function openSteeredThread(
  browser: any,
  base: string,
  current: any,
  rows?: any[],
) {
  const thread: any = {
    id: "main",
    title: "Steered agent",
    parent: null,
    status: "idle",
    kind: null,
    msg_count: 4,
    window_cursor: 500,
    turns: [current],
  };
  if (rows) thread.rows = rows;
  else thread.rows = rowsFor(thread);
  const asked: string[] = [];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await page.route(`${base}api/tree*`, (route: Route) =>
    route.fulfill({
      json: [
        {
          id: "main",
          parent: null,
          updated: 1,
          title: "Coordinator",
          kind: null,
          status: "idle",
          children: 0,
          queued: 0,
          preview: "",
          muted: false,
        },
      ],
    }),
  );
  await mockConversation(page, base, "main", () => thread);
  await page.route(
    `${base}api/conversations/main/turn-prompt**`,
    (route: Route) => {
      asked.push(route.request().url());
      const offset = Number(
        new URL(route.request().url()).searchParams.get("offset"),
      );
      return route.fulfill({
        json: {
          driving: "",
          message: "",
          system: "",
          role: "assistant",
          steering: false,
          usage:
            offset === STEERED_FINAL_OFFSET
              ? FINAL_ANSWER_USAGE
              : FIRST_ANSWER_USAGE,
        },
      });
    },
  );
  await gotoRoot(page, base);
  await page
    .locator("#messages")
    .filter({ hasText: "Dropped the index." })
    .waitFor();
  return { context, page, errors, asked };
}
async function clickTokens(page: any): Promise<string> {
  const tokens = page.locator(".turn.current .turn-foot-actions .turn-tokens");
  await page.locator(".turn.current .turn-foot-actions").hover();
  await page.waitForFunction(
    "getComputedStyle(document.querySelector('.turn.current .turn-foot-actions .turn-tokens')).opacity === '1'",
  );
  await visibleAndUncovered(
    page,
    ".turn.current .turn-foot-actions .turn-tokens",
  );
  await tokens.click();
  await page.locator(".turn-usage-caption").waitFor();
  return page.locator("#prompt-body").innerText();
}

if (import.meta.main) await runBrowserTests([["steers", tests]]);
