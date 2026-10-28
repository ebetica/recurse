import { expect } from "bun:test";
import type { Page } from "playwright";
import {
  captureErrors,
  fixtureRows,
  gotoRoot,
  mockConversation,
  rootAgentId,
  themeColors,
  runBrowserTests,
  waitForLayout,
  type BrowserTest,
} from "./common";

const channels = (css: string) => {
  const srgb =
    /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(css);
  if (!srgb) return css;
  const [r, g, b] = srgb.slice(1, 4).map((v) => Math.round(Number(v) * 255));
  return srgb[4]
    ? `rgba(${r}, ${g}, ${b}, ${srgb[4]})`
    : `rgb(${r}, ${g}, ${b})`;
};

const usage = {
  output: 75,
  input: 300,
  cacheRead: 1900,
  cacheWrite: 40,
  calls: 2,
  replies: 2,
  partial: false,
};
const summary = (extra: Record<string, unknown> = {}) => ({
  tools: 0,
  shell: 0,
  read_files: 0,
  edit_files: 0,
  added: 0,
  removed: 0,
  write_files: 0,
  agents: 0,
  searches: 0,
  web: 0,
  prs: [],
  truncated: false,
  ...extra,
});
const turn = (id: string, ask: string, reply: string, cursor = 0): any => ({
  turn_id: id,
  cursor,
  started_at: 1,
  ended_at: 2,
  open: false,
  status: "idle",
  partial: false,
  summary: summary(),
  segments: [
    {
      user: [
        {
          kind: "user",
          offset: cursor + 10,
          role: "user",
          content: ask,
          ts: 1,
        },
      ],
      tools: [],
      assistant: {
        kind: "assistant",
        offset: cursor + 90,
        role: "assistant",
        content: reply,
        usage: { input: 120, output: 40, cacheRead: 900, cacheWrite: 60 },
      },
      summary: summary(),
    },
  ],
});
const openThread = async (page: Page, base: string, thread: any) => {
  await mockConversation(page, base, "main", () => thread);
  await gotoRoot(page, base);
};
async function pageOlderUntil(
  page: Page,
  base: string,
  text: string,
  pages: number,
): Promise<void> {
  const cursors = new Set<string>();
  for (let i = 0; i < pages; i++) {
    if (await page.getByText(text, { exact: true }).count()) break;
    const previous = await page
      .locator("#messages .msg.user")
      .first()
      .textContent();
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.ok() &&
        response.url().startsWith(`${base}api/conversations/main/view?`) &&
        url.searchParams.has("before")
      );
    });
    await page.locator("#scroll").evaluate((e) => {
      e.scrollTop = 0;
      e.dispatchEvent(new Event("scroll"));
    });
    const older = await response;
    const cursor = new URL(older.url()).searchParams.get("before")!;
    if (cursors.has(cursor)) throw new Error("older-page cursor repeated");
    cursors.add(cursor);
    await older.finished();
    await page.waitForFunction((previous) => {
      const { document } = globalThis as any;
      const first = document.querySelector("#messages .msg.user");
      return first && first.textContent !== previous;
    }, previous);
    await waitForLayout(page);
  }
}

const node = (id: string, title: string, parent: string | null) => ({
  id,
  parent,
  updated: 1,
  title,
  kind: null,
  status: "running",
  children: 0,
  queued: 0,
  preview: "",
  muted: false,
});

// Regression: #2017 live-panel shell chip has an unobstructed phone touch target
async function test_background_shells_inline_details_and_scoped(
  browser: any,
  base: string,
) {
  const mainCommand = "echo monitor command\n" + "x".repeat(500);
  const shellSpecs = [
    [mainCommand, "monitor"],
    ["echo background one\n" + "y".repeat(260), "background"],
    ["echo background two\n" + "z".repeat(260), "background"],
  ];
  const liveThread = (
    id: string,
    title: string,
    command: string,
    specs: any[] = [[command, "background"]],
    active = 1,
    backgrounds = 1,
    truncated = false,
    turnSummary: any = null,
  ) => ({
    id,
    title,
    parent: id === "main" ? null : "main",
    status: "running",
    active_run: `run-${id}`,
    kind: null,
    msg_count: 1,
    turns: [
      {
        turn_id: `live-${id}`,
        cursor: 0,
        started_at: 1,
        ended_at: null,
        open: true,
        status: "open",
        summary: null,
        partial: false,
        segments: [
          {
            user: [
              {
                kind: "user",
                offset: 1,
                role: "user",
                content: "Keep working",
                ts: 1,
              },
            ],
            tools: [],
            assistant: null,
            summary: null,
          },
        ],
      },
    ],
    draft: {
      text: "",
      tools: 0,
      tool_active: 0,
      tool_phase: "running",
      tool_calls: [],
      summary: null,
      turn: turnSummary ? `live-${id}` : null,
      turn_summary: turnSummary,
      attachments: [],
    },
    shells: {
      status: "ready",
      scope: "selected_agent_current_session",
      agent_id: id,
      agent_title: title,
      items: specs.map(([value, mode], index) => ({
        command: value,
        mode,
        status: "running",
        started_at: 1 + index,
        elapsed_seconds: 4,
      })),
      truncated,
      active_count: active,
      background_count: backgrounds,
    },
  });
  const tree = [
    node("main", "Coordinator", null),
    node("kid", "Neighbour", "main"),
  ];
  const threads: any = {
    main: liveThread(
      "main",
      "Coordinator",
      mainCommand,
      shellSpecs,
      4,
      4,
      true,
      summary({ tools: 4, shell: 4 }),
    ),
    kid: liveThread("kid", "Neighbour", "echo neighbour command"),
  };
  threads.kid.shells.items[0].status = "stopping";
  threads.main.draft.tools = 1;
  threads.main.draft.tool_active = 1;
  threads.main.draft.tool_action = {
    name: "read",
    input: "src/agents/runtime/pi_agent.py",
  };
  threads.main.draft.tool_calls = [
    {
      name: "read",
      input: "src/agents/runtime/pi_agent.py",
      active: true,
      call_id: "c".repeat(24),
    },
  ];
  const exercise = async (page: Page, mobile: boolean) => {
    const errors = captureErrors(page);
    await page.route(`${base}api/tree`, (route: any) =>
      route.fulfill({ json: tree }),
    );
    await mockConversation(page, base, "main", () => threads.main);
    await mockConversation(page, base, "kid", () => threads.kid);
    await gotoRoot(page, base);
    expect(await page.locator(".work-shells").count()).toBe(0);
    const activity = page.locator(".working .live-label");
    await activity.waitFor();
    expect((await activity.innerText()).startsWith("Thinking")).toBeTrue();
    expect((await activity.getAttribute("title")) ?? "").toBe("Thinking");
    expect(await page.locator(".activity-body.open").count()).toBe(0);
    const chip = page.locator(".shell-chip");
    await chip.waitFor();
    expect(await chip.getAttribute("aria-expanded")).toBe("false");
    expect((await chip.innerText()).trim()).toBe("4");
    expect(await chip.getAttribute("aria-label")).toContain("4 active shells");
    expect(await page.locator(".shell-command").count()).toBe(0);
    expect(
      await chip
        .locator(
          "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' live-panel ')]",
        )
        .count(),
    ).toBe(1);
    const style: any = await chip.evaluate((element) => {
      const s = (globalThis as any).getComputedStyle(element),
        b = element.getBoundingClientRect();
      return {
        fontSize: s.fontSize,
        padding: s.padding,
        border: s.borderColor,
        background: s.backgroundColor,
        color: s.color,
        height: b.height,
      };
    });
    for (const key of ["border", "background", "color"])
      style[key] = channels(style[key]);
    expect(style.fontSize).toBe(mobile ? "10.5px" : "9.45px");
    expect(style.padding).toBe("0px 8px");
    const [border, background, running, accent] = (
      await themeColors(
        page,
        "color-mix(in srgb, var(--running) 30%, transparent)",
        "color-mix(in srgb, var(--running) 10%, transparent)",
        "var(--running)",
        "var(--accent)",
      )
    ).map(channels);
    expect(style.border).toBe(border);
    expect(style.background).toBe(background);
    expect(style.color).toBe(running);
    expect(JSON.stringify(style)).not.toContain(accent.slice(4, -1));
    await chip.focus();
    expect(
      await chip.evaluate((element) => {
        const s = (globalThis as any).getComputedStyle(element);
        return { outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle };
      }),
    ).toEqual({ outlineWidth: "2px", outlineStyle: "solid" });
    if (mobile) {
      const chipBox = await chip.boundingBox();
      const panel = chip.locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' live-panel-box ')]",
      );
      const panelBox = await panel.boundingBox();
      const agentChip = page.locator(".agent-chip");
      await agentChip.waitFor();
      const agentBox = await agentChip.boundingBox();
      expect(
        Boolean(
          chipBox &&
          agentBox &&
          panelBox &&
          chipBox.height === 18 &&
          chipBox.y >= panelBox.y &&
          chipBox.y + chipBox.height <= panelBox.y + panelBox.height &&
          chipBox.x + chipBox.width <= panelBox.x + panelBox.width &&
          agentBox.x + agentBox.width <= panelBox.x + panelBox.width,
        ),
      ).toBeTrue();
      const tapPoint = {
        x: chipBox!.x + chipBox!.width / 2,
        y: chipBox!.y + chipBox!.height / 2 - 20,
      };
      expect(
        await page.evaluate(({ x, y }) => {
          const browser = globalThis as any;
          return (
            browser.document.elementFromPoint(x, y) ===
            browser.document.querySelector(".shell-chip")
          );
        }, tapPoint),
      ).toBeTrue();
      await page.mouse.click(tapPoint.x, tapPoint.y);
    } else {
      expect(style.height).toBeLessThanOrEqual(28);
      await chip.click();
    }
    const surface = page.locator(".shell-surface");
    await surface.waitFor();
    expect(await chip.getAttribute("aria-expanded")).toBe("true");
    expect(await surface.locator("h2").innerText()).toBe(
      "Background shells for Coordinator",
    );
    expect(await surface.locator(".shell-command").first().innerText()).toBe(
      mainCommand,
    );
    expect(await surface.locator(".shell-row").count()).toBe(3);
    const list = surface.locator(".shell-list");
    expect(
      await list.evaluate((e: any) => e.scrollHeight > e.clientHeight),
    ).toBeTrue();
    await list.evaluate((e: any) => {
      e.scrollTop = e.scrollHeight;
    });
    await surface.locator(".shell-row").last().scrollIntoViewIfNeeded();
    expect(await surface.innerText()).toContain(
      "Showing 3 of 4 active background shells",
    );
    const sb = await surface.boundingBox(),
      tb = await page.locator("#topbar").boundingBox(),
      cb = await page.locator("#composer-wrap").boundingBox();
    expect(Boolean(sb && tb && cb)).toBeTrue();
    expect(sb!.width).toBeLessThanOrEqual(mobile ? 390 : 1280);
    expect(sb!.y).toBeGreaterThanOrEqual(tb!.y + tb!.height);
    expect(sb!.y + sb!.height).toBeLessThanOrEqual(cb!.y + 1);
    const close = surface.locator(".shell-surface-close");
    await close.focus();
    await (
      await page.waitForResponse(`${base}api/conversations/main/events`)
    ).finished();
    expect(
      await page.evaluate(
        "document.activeElement?.classList.contains('shell-surface-close')",
      ),
    ).toBeTrue();
    await close.click();
    expect(await page.locator(".shell-surface").count()).toBe(0);
    expect(await chip.getAttribute("aria-expanded")).toBe("false");
    expect(
      await page.evaluate("document.activeElement?.matches('.shell-chip')"),
    ).toBeTrue();
    await chip.press("Enter");
    expect(await chip.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("Escape");
    expect(await page.locator(".shell-surface").count()).toBe(0);
    await chip.press(" ");
    expect(await page.locator(".shell-surface").count()).toBe(1);
    await page.locator("#topbar").click({ position: { x: 200, y: 10 } });
    expect(await page.locator(".shell-surface").count()).toBe(0);
    threads.main.shells.active_count = 5;
    threads.main.shells.background_count = 5;
    await page.waitForFunction(
      "document.querySelector('.shell-chip')?.getAttribute('aria-label')?.includes('5 active shells')",
    );
    if (mobile) await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="kid"]').click();
    const kidChip = page.locator('.shell-chip[data-agent-id="kid"]');
    await kidChip.waitFor();
    expect(await page.locator(".shell-chip").count()).toBe(1);
    expect((await kidChip.innerText()).trim()).toBe("1");
    expect(await kidChip.getAttribute("aria-expanded")).toBe("false");
    expect(await kidChip.getAttribute("aria-label")).toBe(
      "1 active shell for Neighbour",
    );
    await kidChip.click();
    expect(
      await page
        .locator(".shell-surface")
        .filter({ hasText: "Neighbour" })
        .locator(".shell-state")
        .innerText(),
    ).toBe("Stopping");
    threads.kid.shells.items = [];
    threads.kid.shells.active_count = 0;
    threads.kid.shells.background_count = 0;
    await page.waitForFunction("!document.querySelector('.shell-surface')");
    expect(
      await page.evaluate(
        "document.activeElement?.id === 'conv-title' || document.activeElement?.id === 'input'",
      ),
    ).toBeTrue();
    threads.kid.shells.items = [
      {
        command: "echo neighbour command",
        mode: "background",
        status: "stopping",
        started_at: 1,
        elapsed_seconds: 4,
      },
    ];
    threads.kid.shells.active_count = 1;
    threads.kid.shells.background_count = 1;
    if (mobile) await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="main"]').click();
    const mainChip = page.locator('.shell-chip[data-agent-id="main"]');
    await mainChip.waitFor();
    expect(await page.locator(".shell-chip").count()).toBe(1);
    expect(await mainChip.getAttribute("aria-expanded")).toBe("false");
    expect(await mainChip.getAttribute("aria-label")).toBe(
      "5 active shells for Coordinator",
    );
    expect(await page.locator(".shell-surface").count()).toBe(0);
    const mainTurn = threads.main.turns[0];
    mainTurn.open = false;
    mainTurn.status = "idle";
    mainTurn.ended_at = 2;
    threads.main.draft.tool_active = 0;
    threads.main.draft.tool_action = null;
    threads.main.draft.tool_calls = [];
    threads.main.status = "idle";
    if (mobile) await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="kid"]').click();
    if (mobile) await page.locator("#menu-btn").click();
    await page.locator('.agent[data-id="main"]').click();
    const idleChip = page.locator('.shell-chip[data-agent-id="main"]');
    await idleChip.waitFor();
    expect(await idleChip.isVisible()).toBeTrue();
    const idleWork = idleChip.locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' working ')]",
    );
    await idleWork.waitFor();
    expect((await idleWork.locator(".shell-chip").innerText()).trim()).toBe(
      "5",
    );
    expect(
      await idleWork.locator(".shell-chip").getAttribute("aria-label"),
    ).toContain("5 active shells");
    expect(await idleWork.innerText()).not.toContain(
      "Background work is still running",
    );
    threads.main.status = "running";
    mainTurn.open = true;
    mainTurn.status = "open";
    mainTurn.ended_at = null;
    threads.main.draft.tool_active = 1;
    threads.main.draft.tool_action = {
      name: "read",
      input: "src/agents/runtime/pi_agent.py",
    };
    threads.main.draft.tool_calls = [
      {
        name: "read",
        input: "src/agents/runtime/pi_agent.py",
        active: true,
        call_id: "c".repeat(24),
      },
    ];
    expect(errors).toEqual([]);
  };
  let context = await browser.newContext({
    viewport: { width: 1280, height: 360 },
  });
  await exercise(await context.newPage(), false);
  await context.close();
  threads.main.shells.active_count = 4;
  threads.main.shells.background_count = 4;
  context = await browser.newContext({
    viewport: { width: 360, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await exercise(await context.newPage(), true);
  await context.close();
}

async function test_turn_collapses_expands_and_pages(
  browser: any,
  base: string,
) {
  const rows: any[] = [];
  for (let i = 0; i < 130; i++)
    rows.push(
      {
        id: `u${i}`,
        kind: "text",
        role: "user",
        origin: "operator",
        text: `Question ${i}`,
      },
      { id: `a${i}`, kind: "text", role: "assistant", text: `Answer ${i}` },
    );
  rows.push(
    {
      id: "latest-u",
      kind: "text",
      role: "user",
      origin: "operator",
      text: "Inspect the file",
    },
    {
      id: "latest-a",
      kind: "text",
      role: "assistant",
      text: "Checking the file.",
    },
    {
      id: "latest-a#read",
      kind: "tool_call",
      role: "tool",
      text: "",
      name: "read",
      args: '{"path":"src/web.py"}',
      result: "line one\nline two",
      stat: { kind: "read" },
    },
    {
      id: "latest-final",
      kind: "text",
      role: "assistant",
      text: "Finished inspecting.",
    },
  );
  const thread = { id: "main", title: "Paged rows", status: "idle", rows };
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await openThread(page, base, thread);
  await page.getByText("Finished inspecting.", { exact: true }).waitFor();
  const current = page.locator(".turn.current");
  expect(await current.innerText()).toContain("Checking the file.");
  expect(await current.locator(".turn-tool").count()).toBe(0);
  await current.locator(".activity-group-toggle").click();
  await current.locator(".turn-series-toggle").click();
  const tool = current.locator(".turn-tool");
  await tool.waitFor();
  await tool.click();
  const output = tool.getByLabel("Output", { exact: true });
  await output.waitFor();
  expect(await output.innerText()).toBe("line one\nline two");
  await current.locator(".activity-group-toggle").click();
  expect(await current.locator(".turn-tool").count()).toBe(0);
  expect(await current.innerText()).toContain("Checking the file.");
  expect(await page.getByText("Answer 0", { exact: true }).count()).toBe(0);
  await pageOlderUntil(page, base, "Answer 0", 4);
  await page.getByText("Answer 0", { exact: true }).waitFor();
  expect(
    await page.getByText("Finished inspecting.", { exact: true }).count(),
  ).toBe(1);
  expect(errors).toEqual([]);
  await context.close();
}

async function test_scroll_up_pages_past_compaction_markers(
  browser: any,
  base: string,
) {
  const rows: any[] = [
    {
      id: "ancient-u",
      kind: "text",
      role: "user",
      origin: "operator",
      text: "Ancient question",
    },
    {
      id: "ancient-a",
      kind: "text",
      role: "assistant",
      text: "Ancient answer",
    },
    {
      id: "compact-1",
      kind: "marker",
      role: "compaction",
      text: "Summary of older work",
      detail: "Summary of older work",
      meta: { compact_marker: true },
    },
  ];
  for (let i = 0; i < 110; i++)
    rows.push(
      {
        id: `u${i}`,
        kind: "text",
        role: "user",
        origin: "operator",
        text: `Question ${i}`,
      },
      { id: `a${i}`, kind: "text", role: "assistant", text: `Answer ${i}` },
    );
  rows.push(
    {
      id: "latest-u",
      kind: "text",
      role: "user",
      origin: "operator",
      text: "Newest question",
    },
    { id: "latest-a", kind: "text", role: "assistant", text: "Newest answer" },
  );
  const thread = {
    id: "main",
    title: "Compacted thread",
    status: "idle",
    rows,
  };
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await openThread(page, base, thread);
  await page.getByText("Newest answer", { exact: true }).waitFor();
  expect(await page.getByText("Ancient answer", { exact: true }).count()).toBe(
    0,
  );
  expect(await page.locator(".compacted-activity").count()).toBe(0);
  await pageOlderUntil(page, base, "Ancient answer", 5);
  await page.getByText("Ancient answer", { exact: true }).waitFor();
  expect(await page.getByText("Newest answer", { exact: true }).count()).toBe(
    1,
  );
  const marker = page.locator(".compacted-activity");
  expect(await marker.count()).toBe(1);
  expect(await marker.locator(".disclosure-body").count()).toBe(0);
  await marker.locator(".compacted-head").click();
  await marker
    .locator(".disclosure-body", { hasText: "Summary of older work" })
    .waitFor();
  expect(errors).toEqual([]);
  await context.close();
}

async function test_background_completion_renders_as_platform_message(
  browser: any,
  base: string,
) {
  const completion =
    "[Background shell completion] shell `done`: killed by SIGTERM.";
  const t = turn("shell-completion", "Run it", "Finished.", 100);
  t.segments.push({
    user: [],
    tools: [],
    assistant: {
      kind: "assistant",
      offset: 130,
      role: "assistant",
      content: "",
      notices: [completion],
    },
    summary: summary(),
  });
  const noticeOnlyCompletion =
    "[Background shell completion] shell `only`: killed by SIGTERM.";
  const only = turn("only-shell-completion", "Wait", "", 200);
  only.segments.at(-1).assistant.notices = [noticeOnlyCompletion];
  const thread = {
    id: "main",
    title: "Shell completion",
    parent: null,
    status: "idle",
    msg_count: 4,
    window_cursor: 0,
    turns: [t, only],
  };
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await mockConversation(page, base, "main", () => thread);
  await page.goto(`${base}#agent=${rootAgentId()}`, {
    waitUntil: "domcontentloaded",
  });
  const boundary = page
    .locator(".activity-boundary")
    .filter({ hasText: "Finished." });
  await boundary.waitFor();
  const platformEyes = page
    .locator(".activity-group-summary")
    .filter({ hasText: "platform note" })
    .locator(".activity-group-toggle");
  for (let index = 0; index < (await platformEyes.count()); index++)
    await platformEyes.nth(index).click();
  const frames = ".activity-boundary:not(.wake-chunk)";
  const noticeBoundary = page
    .locator(".activity-boundary")
    .filter({ hasText: "Platform message" })
    .first();
  const notice = noticeBoundary.locator(".agent-message.platform-interruption");
  await notice.waitFor();
  expect(await notice.count()).toBe(1);
  expect(await notice.locator(".lead").innerText()).toBe("Platform message");
  expect(await notice.locator(".sub").innerText()).toBe("system activity");
  expect(await notice.locator(".agent-message-body").count()).toBe(0);
  await notice.locator(".agent-message-row").click();
  await notice.locator(".agent-message-body").waitFor();
  expect(await notice.locator(".agent-message-row").count()).toBe(1);
  expect(
    (await notice.locator(".agent-message-content").innerText()).trim(),
  ).toBe(completion);
  expect(await notice.locator(".notice-note").count()).toBe(0);
  expect(await boundary.locator(".activity-group-toggle").count()).toBe(0);
  const ob = page.locator(".activity-boundary").filter({ hasText: "Wait" });
  const on = page
    .locator(frames)
    .filter({ hasText: "Platform message" })
    .nth(1)
    .locator(".agent-message.platform-interruption");
  await on.waitFor();
  expect(await on.count()).toBe(1);
  await on.locator(".agent-message-row").click();
  expect((await on.locator(".agent-message-content").innerText()).trim()).toBe(
    noticeOnlyCompletion,
  );
  expect(await ob.locator(".msg.assistant").count()).toBe(0);
  expect(errors).toEqual([]);
  await context.close();
}

function expandable(
  id: string,
  ask: string,
  reply: string,
  cursor: number,
): any {
  const t = turn(id, ask, reply, cursor);
  t.segments = [
    {
      user: [
        {
          kind: "user",
          offset: cursor + 10,
          role: "user",
          content: ask,
          ts: 1,
        },
      ],
      tools: [
        {
          name: "read",
          input: '{"path":"context.txt"}',
          result: "Earlier context.",
        },
      ],
      assistant: {
        kind: "assistant",
        offset: cursor + 20,
        role: "assistant",
        final: false,
        content: "Earlier context.",
      },
      summary: summary(),
    },
    {
      user: [],
      tools: [],
      assistant: {
        kind: "assistant",
        offset: cursor + 30,
        role: "assistant",
        final: true,
        content: reply,
      },
      summary: summary(),
    },
  ];
  return t;
}
async function test_response_eyes_keyboard_shortcut(
  browser: any,
  base: string,
) {
  const older = expandable(
      "older-keyboard",
      "Older question",
      "Older answer.",
      100,
    ),
    latest = expandable(
      "latest-keyboard",
      "Latest question",
      "Latest answer.",
      200,
    );
  const thread = {
    id: "main",
    title: "Keyboard turns",
    status: "idle",
    msg_count: 4,
    window_cursor: 0,
    turns: [older, latest],
  };
  let context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  let page = await context.newPage();
  let errors = captureErrors(page);
  await openThread(page, base, thread);
  await page
    .locator("#messages")
    .filter({ hasText: "Latest answer." })
    .waitFor();
  let olderEye = page.locator(".turn:not(.current) .activity-group-toggle"),
    latestEye = page.locator(".turn.current .activity-group-toggle");
  expect(await olderEye.count()).toBe(1);
  expect(await latestEye.count()).toBe(1);
  expect(await olderEye.getAttribute("aria-expanded")).toBe("false");
  expect(await latestEye.getAttribute("aria-expanded")).toBe("false");
  await page.evaluate("document.activeElement?.blur()");
  await page.keyboard.press("v");
  await page.waitForFunction(
    "document.querySelector('.turn.current .activity-group-toggle')?.getAttribute('aria-expanded') === 'true'",
  );
  expect(await olderEye.getAttribute("aria-expanded")).toBe("true");
  expect(await page.locator(".turn.current").innerText()).toContain(
    "Earlier context.",
  );
  await page.keyboard.press("v");
  await page.waitForFunction(
    "document.querySelector('.turn.current .activity-group-toggle')?.getAttribute('aria-expanded') === 'false'",
  );
  expect(await olderEye.getAttribute("aria-expanded")).toBe("false");
  expect(await page.locator(".turn.current").innerText()).toContain(
    "Earlier context.",
  );
  expect(errors).toEqual([]);
  await context.close();
  const plain = turn(
    "latest-plain",
    "Latest plain question",
    "Latest plain answer.",
    200,
  );
  const plainThread = { ...thread, msg_count: 3, turns: [older, plain] };
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  page = await context.newPage();
  errors = captureErrors(page);
  await openThread(page, base, plainThread);
  await page
    .locator("#messages")
    .filter({ hasText: "Latest plain answer." })
    .waitFor();
  olderEye = page.locator(".turn:not(.current) .activity-group-toggle");
  expect(await olderEye.count()).toBe(1);
  expect(
    await page.locator(".turn.current .activity-group-toggle").count(),
  ).toBe(0);
  await page.evaluate("document.activeElement?.blur()");
  await page.keyboard.press("v");
  await olderEye.locator('xpath=self::*[@aria-expanded="true"]').waitFor();
  expect(await olderEye.getAttribute("aria-expanded")).toBe("true");
  expect(await page.locator(".turn:not(.current)").innerText()).toContain(
    "Earlier context.",
  );
  expect(errors).toEqual([]);
  await context.close();
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  page = await context.newPage();
  errors = captureErrors(page);
  await openThread(page, base, { ...plainThread, status: "running" });
  await page
    .locator("#messages")
    .filter({ hasText: "Latest plain answer." })
    .waitFor();
  olderEye = page.locator(".turn:not(.current) .activity-group-toggle");
  expect(await olderEye.count()).toBe(1);
  expect(
    await page.locator(".turn.current .activity-group-toggle").count(),
  ).toBe(0);
  await page.evaluate("document.activeElement?.blur()");
  await page.keyboard.press("v");
  await olderEye.locator('xpath=self::*[@aria-expanded="true"]').waitFor();
  expect(await olderEye.getAttribute("aria-expanded")).toBe("true");
  expect(errors).toEqual([]);
  await context.close();
}

async function test_turn_footer_controls_keep_order_and_hover_guard(
  browser: any,
  base: string,
) {
  const t = expandable(
    "footer-controls",
    "Footer question",
    "Footer answer.",
    100,
  );
  t.summary = summary({ tools: 1, usage });
  t.segments = [
    {
      user: [
        {
          kind: "user",
          offset: 110,
          role: "user",
          content: "Earlier question",
          ts: 1,
        },
      ],
      tools: [
        {
          call_id: "footer-controls:c0",
          name: "read",
          input: '{"path":"context.txt"}',
          result: "Earlier context.",
        },
      ],
      assistant: {
        id: "footer-controls:a0",
        kind: "assistant",
        offset: 120,
        role: "assistant",
        final: false,
        content: "Earlier context.",
      },
      summary: summary(),
    },
    {
      user: [],
      tools: [],
      assistant: {
        id: "footer-controls:a1",
        kind: "assistant",
        offset: 130,
        role: "assistant",
        final: true,
        content: "Footer answer.",
        usage,
      },
      summary: summary({ tools: 1 }),
    },
  ];
  const thread = {
    id: "main",
    title: "Footer controls",
    status: "idle",
    msg_count: 2,
    window_cursor: 0,
    turns: [t],
  };
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  await openThread(page, base, thread);
  await page.locator(".turn.current .turn-foot-actions").waitFor();
  const controls = page.locator(".turn.current .turn-foot-actions > *");
  const classes = await controls.evaluateAll((nodes: any[]) =>
    nodes.map((node: any) => node.className.split(" ").filter(Boolean)),
  );
  expect(classes).toEqual([["turn-tokens", "activity-usage"], ["turn-expand"]]);
  expect(
    await page.locator(".turn.current .turn-foot .turn-summary").count(),
  ).toBe(0);
  await page.mouse.move(1279, 799);
  expect(
    await controls.evaluateAll((nodes: any[]) =>
      nodes.map((e: any) => (globalThis as any).getComputedStyle(e).opacity),
    ),
  ).toEqual(["1", "1"]);
  expect(errors).toEqual([]);
  await context.close();
}

// Feature: #2424 reply controls share the reply line. (also #2503 inline footer centered the last text line and separated its buttons.; #2513 list/summary endings stranded a footer row and inflated wrapped lines.)
async function test_turn_footer_shares_reply_line(browser: any, base: string) {
  const measurements: any[] = [];
  for (const width of [412, 1280]) {
    for (const shape of [
      "short",
      "long",
      "bullets",
      "nested",
      "long-word",
      "summary",
      "code",
      "image",
      "inline-code",
      "running",
      "no-reply",
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: width === 412 ? 2.625 : 1,
        isMobile: width === 412,
        hasTouch: width === 412,
      });
      const page = await context.newPage();
      const reply =
        shape === "long"
          ? `All checks passed.  \nAll checks passed.  \n${"W".repeat(width === 412 ? 20 : 52)} finished`
          : shape === "bullets"
            ? "- **README:** OK on version 2 in the text box?\n- **Deploy tool:** A, idle instances sleep, or B, always on?\n\n"
            : shape === "nested"
              ? "- **Result:**\n  - Final nested bullet with **normal spacing.**\n\n"
              : shape === "long-word"
                ? `- Final bullet: **${"W".repeat(120)}**\n\n`
                : shape === "inline-code"
                  ? "The result is `finished`"
                  : shape === "image"
                    ? "Caption ![chart](/api/attachments/chart.png)"
                    : shape === "code"
                      ? "Here is the result:\n\n```text\nAll checks passed.\n```"
                      : shape === "short"
                        ? "All checks passed.  \nAll checks passed."
                        : "All checks passed.";
      if (shape === "image")
        await page.route(`${base}api/attachments/chart.png`, (route: any) =>
          route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
          }),
        );
      const t = expandable("inline-footer", "Check the result", reply, 100);
      t.summary = summary({ tools: 1, usage });
      t.segments[1].assistant.usage = usage;
      if (shape === "summary") {
        t.segments[0].assistant = null;
        t.segments[1].assistant.content = "";
        t.segments[0].tools = Array.from({ length: 4 }, (_, i) => ({
          name: "bash",
          input: i
            ? `echo check-${i}`
            : "bun tools/subagent.ts send child done",
          result: "checked",
        }));
      }
      const running = shape === "running" || shape === "no-reply";
      if (running) {
        t.open = true;
        t.ended_at = null;
        t.status = "open";
        t.segments[1].assistant.live = true;
        if (shape === "no-reply") {
          t.segments[0].assistant = null;
          t.segments[1].assistant = null;
        }
      }
      const tree = [
        node("main", "Inline block controls", null),
        node("kid", "Active child", "main"),
      ];
      if (running)
        await page.route(`${base}api/tree`, (route: any) =>
          route.fulfill({ json: tree }),
        );
      const rows =
        shape === "no-reply" || shape === "summary"
          ? fixtureRows({ turns: [t] })
          : undefined;
      if (shape === "no-reply") rows!.at(-1)!.live = true;
      if (shape === "summary") {
        rows!.push({
          id: "checks-finished",
          kind: "marker",
          role: "shell-notice",
          origin: "platform",
          text: "[Background shell completion] shell `checks`: exited with code 0.",
          live: false,
        });
        for (const [i, row] of rows!
          .filter((r: any) => r.kind === "tool_call")
          .entries())
          row.stat = i
            ? { kind: "shell" }
            : { kind: "shell", action: "subagent_send" };
      }
      const thread = {
        id: "main",
        title: "Inline block controls",
        status: running ? "running" : "idle",
        msg_count: 2,
        window_cursor: 0,
        turns: [t],
        rows,
      };
      if (!running)
        thread.rows = [
          ...fixtureRows(thread),
          {
            id: "next-message",
            kind: "text",
            role: "user",
            origin: "operator",
            text: "Next message",
            live: false,
          },
        ];
      await openThread(page, base, thread);
      const target = page.locator(".activity-boundary.turn").first();
      await target.locator(".turn-foot-actions").waitFor();
      if (running) await target.locator(".live-panel").waitFor();
      if (shape === "short" || shape === "running")
        await target.locator(".content > p").last().waitFor();
      const measure = () =>
        target.evaluate((block: any) => {
          const foot = block.querySelector(".turn-foot")!;
          const actions = foot.querySelector(".turn-foot-actions")!;
          const reply =
            block.querySelector(
              ".activity-body > .msg.assistant:last-of-type .content",
            ) ?? block.querySelector(".activity-group .turn-summary");
          const rect = (element: any) =>
            element?.getBoundingClientRect().toJSON();
          const doc = (globalThis as any).document;
          const range = doc.createRange();
          const text: any[] = [];
          if (reply) {
            const end =
              reply.querySelector(
                "li:has(.turn-tail):not(:has(li .turn-tail))",
              ) ??
              reply.querySelector(
                ":scope > p:last-child, :scope > .reveal-chunk:last-child > p:last-child, :scope > ul:last-child > li:last-child",
              ) ??
              reply;
            const walker = doc.createTreeWalker(end, 4);
            while (walker.nextNode()) {
              range.selectNodeContents(walker.currentNode);
              text.push(
                ...Array.from(range.getClientRects()).map((r: any) =>
                  r.toJSON(),
                ),
              );
            }
          }
          const code = reply?.querySelector("code");
          if (code) range.selectNodeContents(code);
          return {
            inlineCode: rect(code),
            codeText: code ? rect(range) : undefined,
            foot: rect(actions),
            reply: rect(reply),
            container: rect(foot.parentElement),
            nextMessage: rect(
              Array.from(doc.querySelectorAll(".msg.user")).at(-1),
            ),
            summary: block.querySelector(".activity-group .turn-summary")
              ?.textContent,
            text,
            panel: rect(block.querySelector(".live-panel")),
            lineHeight: reply
              ? parseFloat(
                  (globalThis as any).getComputedStyle(reply).lineHeight,
                )
              : 0,
            icons: Array.from(actions.querySelectorAll("svg")).map(rect),
            targets: Array.from(actions.children).map(rect),
            usage: actions.querySelectorAll(".activity-usage").length,
            label: block.querySelector(".live-thinking-title")?.textContent,
          };
        });
      if (shape === "image")
        await target.locator("img").evaluate((image: any) => image.decode());
      const metrics = await measure();
      if (process.env.FOOTER_SCREENSHOTS && shape !== "no-reply") {
        await page.screenshot({
          path: `${process.env.FOOTER_SCREENSHOTS}/${width}-${shape}.png`,
          scale: "css",
        });
      }
      if (shape === "short" || shape === "running") {
        const text = metrics.text[0];
        const right = Math.max(
          ...metrics.text
            .filter((r: any) => r.top === text.top)
            .map((r: any) => r.right),
        );
        await page.mouse.move(text.left, text.top + text.height / 2);
        await page.mouse.down();
        await page.mouse.move(right, text.top + text.height / 2, {
          steps: 3,
        });
        await page.mouse.up();
        (metrics as any).selected = await page.evaluate(() =>
          (globalThis as any).getSelection()?.toString(),
        );
        await page.evaluate(() =>
          (globalThis as any).getSelection()?.removeAllRanges(),
        );
      }
      if (shape === "running") {
        t.segments[1].assistant.content += " Again.";
        await page
          .locator(".turn.current .content > .reveal-chunk > p")
          .waitFor();
        const revealing = await measure();
        t.segments.push({
          user: [],
          tools: [],
          summary: summary(),
          assistant: {
            kind: "assistant",
            role: "assistant",
            content: "New reply.",
            live: true,
          },
        });
        await page.getByText("New reply.", { exact: true }).waitFor();
        (metrics as any).newReplyFooters = await page
          .locator(".turn.current .msg.assistant")
          .filter({ hasText: "New reply." })
          .locator(".turn-foot")
          .count();
        thread.status = "idle";
        for (const item of tree) item.status = "idle";
        t.segments[1].assistant.live = false;
        t.segments[2].assistant.live = false;
        await page
          .locator(".turn.current .live-panel")
          .waitFor({ state: "hidden" });
        await page.locator(".turn.current .content > p").last().waitFor();
        (metrics as any).transitions = [revealing, await measure()];
      }
      measurements.push({ width, shape, ...metrics });
      await context.close();
    }
  }
  console.log(JSON.stringify(measurements));
  for (const m of measurements) {
    if (
      ["short", "long", "bullets", "nested", "long-word", "summary"].includes(
        m.shape,
      )
    ) {
      expect(m.targets[1].left - m.targets[0].right).toBe(
        m.width === 412 ? 4 : 8,
      );
      const lines = [
        ...new Set(
          m.text.filter((r: any) => r.width > 0).map((r: any) => r.top),
        ),
      ].sort((a: any, b: any) => a - b) as number[];
      for (let i = 1; i < lines.length; i++)
        expect(
          Math.abs(lines[i]! - lines[i - 1]! - m.lineHeight),
        ).toBeLessThanOrEqual(1);
      const last = m.text.filter((r: any) => r.width > 0).at(-1);
      expect(m.foot.top).toBeGreaterThanOrEqual(last.top - 4);
      expect(m.foot.top).toBeLessThan(last.bottom);
      expect(m.container.bottom - last.bottom).toBeLessThanOrEqual(24);
      expect(last.right).toBeLessThanOrEqual(m.foot.left);
      if (m.shape === "long") expect(lines.length).toBeGreaterThan(3);
      expect(m.nextMessage.top - last.bottom).toBeLessThanOrEqual(32);
      if (m.shape === "summary")
        expect(m.summary).toBe(
          "Poked 1 agent, ran 3 commands, 1 background shell finished",
        );
    }
    if (m.shape === "short" || m.shape === "running") {
      expect(m.foot.top).toBeLessThan(m.reply.bottom);
      expect(m.foot.top).toBeLessThan(m.text.at(-1).bottom);
      expect(m.text.at(-1).right).toBeLessThanOrEqual(m.foot.left);
      expect(m.selected).toBe("All checks passed.");
      if (m.transitions) {
        expect(m.newReplyFooters).toBe(1);
        expect(m.transitions[0].label).toBe("Thinking");
        expect(m.transitions[0].usage).toBe(0);
        expect(m.transitions[1].panel).toBeUndefined();
        expect(m.transitions[1].usage).toBe(1);
        expect(
          Math.abs(m.transitions[0].foot.bottom - m.foot.bottom),
        ).toBeLessThanOrEqual(2);
        for (const transition of m.transitions) {
          expect(transition.foot.top).toBeLessThan(transition.reply.bottom);
          expect(transition.text.at(-1).right).toBeLessThanOrEqual(
            transition.foot.left,
          );
        }
      }
    }
    for (const target of m.targets) {
      expect(target.width).toBe(m.width === 412 ? 22 : 24);
      expect(target.height).toBe(m.width === 412 ? 22 : 24);
    }
    for (const icon of m.icons) {
      expect(icon.width).toBe(m.width === 412 ? 12 : 14);
      expect(icon.height).toBe(m.width === 412 ? 12 : 14);
    }
    if (m.shape === "inline-code") {
      expect(m.inlineCode.width - m.codeText.width).toBeLessThanOrEqual(12);
      expect(m.foot.top).toBeLessThan(m.text.at(-1).bottom);
      expect(m.text.at(-1).right).toBeLessThanOrEqual(m.foot.left);
    }
    if (m.shape === "code" || m.shape === "image") {
      expect(m.foot.top).toBeGreaterThanOrEqual(m.reply.bottom);
    }
    if (m.panel) {
      expect(m.foot.bottom).toBeLessThanOrEqual(m.panel.top);
      expect(m.usage).toBe(0);
      expect(m.label).toBe("Thinking");
      expect(m.label).not.toContain("Ran");
    }
  }
}

async function test_changes_opens_small_files_and_fetches_each_patch(
  browser: any,
  base: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  const calls: string[] = [];
  const diff = {
    available: true,
    base: "origin/main",
    version: "v1",
    files: [
      { path: "one.txt", additions: 1, deletions: 1, status: "modified" },
      { path: "two.txt", additions: 1, deletions: 1, status: "modified" },
    ],
    truncated: false,
    untracked: [],
    currentPr: null,
  };
  await page.route(`${base}api/conversations/main/diff**`, (route: any) =>
    route.fulfill({ json: diff }),
  );
  await page.route(
    `${base}api/conversations/main/diff/files**`,
    (route: any) => {
      calls.push(route.request().url());
      const path = new URL(route.request().url()).searchParams.get("path");
      const patch =
        path === "one.txt"
          ? "diff --git a/one.txt b/one.txt\nindex 111..222 100644\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one\n+one\n"
          : "diff --git a/two.txt b/two.txt\nindex 333..444 100644\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-two\n+two\n";
      return route.fulfill({ json: { available: true, path, patch } });
    },
  );
  await gotoRoot(page, base);
  await page.locator(".agent").first().waitFor();
  await page
    .locator('#pane-rail button[aria-label="Changes"]')
    .waitFor({ timeout: 15000 });
  await page.locator('#pane-rail button[aria-label="Changes"]').click();
  await page.locator(".diff-file").first().waitFor();
  expect(await page.locator(".diff-file").count()).toBe(2);
  const first = page.locator(".diff-file").first();
  await first.locator(".diff-file-toggle").waitFor();
  expect(calls).toHaveLength(2);
  expect(errors).toEqual([]);
  await context.close();
}
async function test_changes_marks_a_truncated_summary(
  browser: any,
  base: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const errors = captureErrors(page);
  const calls: string[] = [];
  const diff = {
    available: true,
    base: "origin/main",
    version: "v1",
    files: [
      { path: "one.txt", additions: 1, deletions: 1, status: "modified" },
    ],
    moreFiles: 1,
    truncated: true,
    untracked: [],
    currentPr: null,
  };
  await page.route(`${base}api/conversations/main/diff**`, (route: any) =>
    route.fulfill({ json: diff }),
  );
  await page.route(
    `${base}api/conversations/main/diff/files**`,
    (route: any) => {
      calls.push(route.request().url());
      return route.abort();
    },
  );
  await gotoRoot(page, base);
  await page.locator(".agent").first().waitFor();
  await page
    .locator('#pane-rail button[aria-label="Changes"]')
    .waitFor({ timeout: 15000 });
  await page.locator('#pane-rail button[aria-label="Changes"]').click();
  await page.locator(".diff-file").first().waitFor();
  expect(calls).toEqual([]);
  expect(await page.locator(".diff-group-count").first().textContent()).toBe(
    "1+",
  );
  expect(await page.locator(".diff-trunc").count()).toBeGreaterThanOrEqual(1);
  expect(errors).toEqual([]);
  await context.close();
}

export const tests: BrowserTest[] = [
  test_background_completion_renders_as_platform_message,
  test_response_eyes_keyboard_shortcut,
  test_turn_footer_controls_keep_order_and_hover_guard,
  test_turn_footer_shares_reply_line,
  test_background_shells_inline_details_and_scoped,
  test_turn_collapses_expands_and_pages,
  test_scroll_up_pages_past_compaction_markers,
  test_changes_opens_small_files_and_fetches_each_patch,
  test_changes_marks_a_truncated_summary,
];
if (import.meta.main) await runBrowserTests([["turns", tests]]);
