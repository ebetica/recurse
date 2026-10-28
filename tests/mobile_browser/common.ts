import { expect } from "bun:test";
import { pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { retire } from "../../src/utils/trash";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";

export const ROOT = join(import.meta.dir, "../..");
export const LOGIN = "browser-test-password";
export const ARTIFACT_VERSION = "a".repeat(40);
export const OLDER_ARTIFACT_VERSION = "b".repeat(40);
export const TOOL_ARTIFACT_ID = "c".repeat(24);
export const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
export const SVG_IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>',
);
export const ARTIFACT: any = {
  schema: 1,
  id: "browser-artifact",
  title: "Browser artifact",
  kind: "report",
  format: "markdown",
  status: "ready",
  entry: "browser.md",
  filename: "browser.md",
  owner_agent_id: "main",
  created_at: "2026-07-24T00:00:00Z",
  updated_at: "2026-07-24T00:00:00Z",
  version: ARTIFACT_VERSION,
  size_bytes: 24,
  asset_count: 0,
  changed: false,
};

export type BrowserTest = (
  browser: Browser,
  base: string,
  data: string,
  serverPid: number,
) => Promise<void>;

export async function themeColors(page: Page, ...colors: string[]) {
  return page.evaluate((colors) => {
    const browser = globalThis as any;
    const probe = browser.document.createElement("span");
    browser.document.body.append(probe);
    const resolved = colors.map((color) => {
      probe.style.color = color;
      return browser.getComputedStyle(probe).color as string;
    });
    probe.remove();
    return resolved;
  }, colors);
}

let layoutCheck = 0;

export async function waitForLayout(page: Page): Promise<void> {
  const key = `__layoutCheck${layoutCheck++}`;
  await page.waitForFunction(
    (key) => {
      const browser = globalThis as any;
      const { document } = browser;
      const scroll = document.querySelector("#scroll");
      if (!scroll) return false;
      const snapshot = () =>
        [
          scroll.scrollTop,
          scroll.scrollHeight,
          ...Array.from(
            scroll.querySelectorAll("button, .activity-group-summary"),
            (node: any) => {
              const box = node.getBoundingClientRect();
              return `${box.x},${box.y},${box.width},${box.height}`;
            },
          ),
        ].join(";");
      const current = snapshot();
      const previous = browser[key];
      const frames = previous?.snapshot === current ? previous.frames + 1 : 0;
      browser[key] = { snapshot: current, frames };
      if (frames < 2) return false;
      delete browser[key];
      return true;
    },
    key,
    { polling: "raf" },
  );
}
let rootId: string | undefined;
export const rootAgentId = (): string => {
  if (!rootId) throw new Error("browser test server has not started");
  return rootId;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitReady(
  base: string,
  deadline = Date.now() + 30_000,
): Promise<void> {
  let last = "unknown";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}__browser-test/ready`, {
        signal: AbortSignal.timeout(1000),
      });
      last = String(response.status);
      if (response.status === 200 || response.status === 401) return;
    } catch (error) {
      last = String(error);
    }
    await sleep(100);
  }
  throw new Error(
    `browser test server did not become ready (/__browser-test/ready: ${last})`,
  );
}

export function scrubServerLogTail(lines: readonly string[]): string {
  return lines
    .slice(-40)
    .map((line) => {
      const text = line.replace(/^\S+ \d+ (?:stdout|stderr): /, "").trim();
      if (
        /^\[startup\] step=[a-z_]+ duration_seconds=[\d.]+(?: [a-z_]+=\d+)*$/.test(
          text,
        )
      )
        return text;
      const code = text.match(
        /\b(EADDRINUSE|EACCES|ENOENT|ENOSPC|ENOMEM|EMFILE|ENFILE|ECONNREFUSED|EROFS|EINVAL|EIO|EBUSY|ETIMEDOUT)\b/,
      );
      if (code) return `native error: ${code[1]}`;
      const frame = text.match(/^at ([\w.<> ]+) \(([^()]+):(\d+):(\d+)\)$/);
      if (frame)
        return `at ${frame[1]} (${basename(frame[2]!).replace(/[^\w.-]/g, "_")}:${frame[3]}:${frame[4]})`;
      const type = text.match(/^(\w*Error|error):/);
      if (type) return `${type[1]}: <message redacted>`;
      return "<redacted>";
    })
    .join("\n")
    .slice(-8192);
}

let coverageGroup = "";
function browserProgress(step: string): void {
  console.log(`Browser progress: group=${coverageGroup} step=${step}`);
}
let groupLog: { file: FileHandle; readers: Promise<void>[] } | undefined;

export async function startServer(
  options: { auth?: boolean; sourceRoot?: string } = {},
): Promise<{
  process: any;
  base: string;
  data: string;
}> {
  browserProgress("server-prepare");
  if (!options.auth) rootId = undefined;
  const data = await mkdtemp(join(tmpdir(), "recurse-browser-"));
  await mkdir(join(data, "home"), { recursive: true });
  await mkdir(join(data, "data"), { recursive: true });
  await mkdir(join(data, "settings", "pi-agent"), {
    recursive: true,
    mode: 0o700,
  });
  const target = join(data, "target-repo");
  await mkdir(target, { recursive: true });
  const env: Record<string, string> = {
    HOME: join(data, "home"),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TZ: "UTC",
    CHAT_DATA_DIR: join(data, "data"),
    CHAT_REPO_URL: target,
    RECURSE_HOME: join(data, "settings"),
    PI_CODING_AGENT_DIR: join(data, "settings", "pi-agent"),
    RECURSE_TEMP_ROOT: join(data, "scratch"),
    PI_BG_SHELL_STATE_DIR: join(data, "pi-bg"),
    RECURSE_BROWSER_VERSION: "browser-e2e-current",
    RECURSE_FRONTEND_LIVE: "0",
    RECURSE_ISOLATED_ROOT: data,
    PORT: "0",
  };
  if (options.auth) {
    const salt = "00112233445566778899aabbccddeeff";
    env.CHAT_AUTH_SALT = salt;
    env.CHAT_AUTH_HASH = pbkdf2Sync(
      LOGIN,
      Buffer.from(salt, "hex") as unknown as Uint8Array<ArrayBuffer>,
      600_000,
      32,
      "sha256",
    ).toString("hex");
  }
  const recording = options.sourceRoot
    ? undefined
    : process.env.RECURSE_BROWSER_COVERAGE;
  if (recording) env.RECURSE_SERVER_COVERAGE_PORT = "0";
  let announce!: (port: number) => void;
  const listening = new Promise<number>((resolve) => (announce = resolve));
  const deadline = Date.now() + 30_000;
  const child = Bun.spawn(
    recording
      ? [
          "bun",
          "test",
          "--coverage",
          "--coverage-reporter=lcov",
          `--coverage-dir=${join(recording, "server", coverageGroup, basename(data))}`,
          join(import.meta.dir, "server_coverage.test.ts"),
        ]
      : [
          "bun",
          join(
            options.sourceRoot ?? ROOT,
            "tests/mobile_browser/browser_test_app.ts",
          ),
          "0",
        ],
    {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      ipc(message) {
        if (
          message?.type === "browser-test-listening" &&
          Number.isSafeInteger(message.port) &&
          message.port > 0 &&
          message.port <= 65535
        )
          announce(message.port);
      },
    },
  );
  browserProgress(`server-listen pid=${child.pid}`);
  const log = groupLog;
  const tail: string[] = [];
  const readers = (
    [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ] as const
  ).map(([name, stream]) => {
    const capture = (async () => {
      for await (const line of createInterface({
        input: Readable.fromWeb(stream as any),
      })) {
        tail.push(line.slice(0, 2048));
        if (tail.length > 40) tail.shift();
        await log?.file.write(
          `${new Date().toISOString()} ${child.pid} ${name}: ${line}\n`,
        );
      }
    })();
    void capture.catch(() => undefined);
    log?.readers.push(capture);
    return capture;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await Promise.race([
      listening,
      child.exited.then((code) => {
        throw new Error(
          `browser test server exited before listening (exit ${code})`,
        );
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "browser test server did not announce its listening port",
              ),
            ),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
    clearTimeout(timer);
    const listeningMs = Date.now() - (deadline - 30_000);
    const base = `http://127.0.0.1:${port}/`;
    browserProgress(`server-ready pid=${child.pid}`);
    await waitReady(base, deadline);
    console.log(
      `Server startup: ${JSON.stringify({ group: coverageGroup, pid: child.pid, listening_ms: listeningMs, ready_ms: Date.now() - (deadline - 30_000) })}`,
    );
    if (options.auth) return { process: child, base, data };
    browserProgress(`server-root pid=${child.pid}`);
    const rootDeadline = Date.now() + 5_000;
    while (Date.now() < rootDeadline && !rootId) {
      const response = await fetch(`${base}api/tree`);
      if (response.status === 200) {
        const tree = (await response.json()) as any[];
        rootId = tree.find((node) => node.parent == null)?.id;
      }
      if (!rootId) await sleep(50);
    }
    if (!rootId) throw new Error("browser test server returned no root agent");
    ARTIFACT.owner_agent_id = rootId;
    return { process: child, base, data };
  } catch (error) {
    await stopServer({ process: child, data });
    await Promise.allSettled(readers);
    console.error(
      `Browser server log tail (exit ${child.exitCode}, scrubbed):\n${scrubServerLogTail(tail) || "<no output>"}`,
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopServer(server: {
  process: any;
  data: string;
}): Promise<void> {
  const pid = Number(server.process.pid);
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const groupExists = (): boolean => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  const waitForExit = async (ms: number): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        server.process.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  browserProgress(`server-stop pid=${pid}`);
  signalGroup("SIGTERM");
  await waitForExit(10_000);
  if (groupExists()) signalGroup("SIGKILL");
  await waitForExit(5_000);
  for (let attempt = 0; attempt < 250 && groupExists(); attempt++) {
    signalGroup("SIGKILL");
    await sleep(20);
  }
  if (groupExists())
    throw new Error(`browser backend process group ${pid} survived cleanup`);
  browserProgress(`server-data-remove pid=${pid}`);
  await rm(server.data, { recursive: true, force: true });
}

export async function closeWithRoutes(
  target: Page | BrowserContext,
  deadlineMs = 5_000,
): Promise<void> {
  const pages = "pages" in target ? target.pages() : [target];
  const holder = pages.map((page) => page.url()).join(", ");
  const bounded = async (phase: string, work: () => Promise<void>) => {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  `Browser cleanup ${phase} exceeded ${deadlineMs}ms; pages=${holder}`,
                ),
              ),
            deadlineMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
      browserProgress(
        `cleanup-${phase} elapsed_ms=${Math.round(performance.now() - started)} pages=${holder}`,
      );
    }
  };
  try {
    await bounded("route-drain", async () => {
      if ("pages" in target)
        for (const page of pages) await page.unrouteAll({ behavior: "wait" });
      await target.unrouteAll({ behavior: "wait" });
    });
  } finally {
    await bounded("close", () => target.close());
  }
}

export async function gotoRoot(page: Page, base: string): Promise<void> {
  await page.goto(`${base}#agent=${rootAgentId()}`, {
    waitUntil: "domcontentloaded",
  });
}

export function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      errors.push(message.text());
  });
  return errors;
}

export function conversationRead(base: string, id: string): RegExp {
  return new RegExp(
    `${escapeRegExp(`${base}api/conversations/${id}`)}(?:\\?[^/]*)?$`,
  );
}
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function fixtureRows(conv: any): any[] {
  if (conv.rows)
    return conv.rows.map((row: any, order: number) => ({
      offset: order * 100,
      ...row,
      order,
    }));
  const rows: any[] = [];
  if (conv.generation_marker)
    rows.push({
      id: "fixture-compaction",
      kind: "marker",
      role: "compaction",
      origin: "custom",
      text:
        conv.generation_marker.summary ?? conv.generation_marker.content ?? "",
      meta: { compact_marker: true },
      live: false,
    });
  for (const turn of conv.turns ?? [])
    for (const [segmentIndex, segment] of (turn.segments ?? []).entries()) {
      for (const [userIndex, user] of (segment.user ?? []).entries())
        rows.push({
          id: user.id ?? `${turn.turn_id}:u${segmentIndex}:${userIndex}`,
          kind: "text",
          role: "user",
          origin:
            user.origin ?? user.source ?? (user.from ? "agent" : "operator"),
          sender: user.from ?? null,
          sender_name: user.from_name ?? null,
          text: user.content ?? "",
          live: false,
        });
      for (const [toolIndex, tool] of (segment.tools ?? []).entries())
        rows.push({
          id: tool.call_id ?? `${turn.turn_id}:c${segmentIndex}:${toolIndex}`,
          kind: "tool_call",
          role: "tool",
          origin: "tool",
          text: "",
          name: tool.name,
          args: tool.input_full ?? tool.input ?? "",
          result: tool.result,
          live: false,
        });
      if (segment.assistant) {
        for (const [noticeIndex, notice] of (
          segment.assistant.notices ?? []
        ).entries())
          rows.push({
            id: `${turn.turn_id}:notice:${segmentIndex}:${noticeIndex}`,
            kind: "text",
            role: "user",
            origin: "platform",
            text: notice,
            live: false,
          });
        for (const [attachmentIndex, attachment] of (
          segment.assistant.attachments ?? []
        ).entries())
          rows.push({
            id: `${turn.turn_id}:publication:${segmentIndex}:${attachmentIndex}`,
            kind: "tool_call",
            role: "tool",
            origin: "tool",
            text: "",
            name: "publish_attachment",
            result: "published",
            attachment,
            live: false,
          });
        rows.push({
          id: segment.assistant.id ?? `${turn.turn_id}:a${segmentIndex}`,
          kind: "text",
          role: "assistant",
          origin: "assistant",
          text: segment.assistant.content ?? "",
          usage: segment.assistant.usage ?? null,
          error: segment.assistant.error ?? null,
          error_detail: segment.assistant.error_detail ?? null,
          stop_reason: segment.assistant.stop_reason ?? null,
          live: Boolean(segment.assistant.live),
        });
      }
    }
  if (conv.draft) {
    if (conv.draft.text)
      rows.push({
        id: conv.draft.message_id ?? "stream",
        kind: "text",
        role: "assistant",
        origin: "assistant",
        text: conv.draft.text,
        live: true,
      });
    for (const [toolIndex, tool] of (conv.draft.tool_calls ?? []).entries())
      rows.push({
        id:
          tool.call_id ?? `${conv.draft.message_id ?? "stream"}:c${toolIndex}`,
        kind: "tool_call",
        role: "tool",
        origin: "tool",
        text: "",
        name: tool.name ?? "tool",
        args: tool.args ?? tool.input_full ?? tool.input ?? "",
        result: tool.result ?? tool.output,
        running: Boolean(tool.active),
        input: tool.input,
        live: true,
        stat: tool.stat,
      });
  }
  return rows.map((row, order) => ({
    offset: order * 100,
    ...row,
    name: row.name ?? null,
    args: row.args ?? "",
    result: row.result ?? null,
    result_truncated: row.result_truncated ?? false,
    order,
  }));
}

export async function mockConversation(
  page: Page,
  base: string,
  id: string,
  read: () => any,
): Promise<void> {
  await page.route(conversationRead(base, id), (route) => {
    const value = read();
    return route.fulfill({
      json: Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => key !== "turns" && key !== "draft",
        ),
      ),
    });
  });
  let revision = 0;
  let previous = "";
  const view = async (route: Route) => {
    const conv = read();
    const rows = fixtureRows(conv);
    const encoded = JSON.stringify(rows);
    if (encoded !== previous) {
      previous = encoded;
      revision++;
    }
    const url = new URL(route.request().url());
    const before = url.searchParams.get("before");
    const end = before
      ? Math.max(
          0,
          rows.findIndex((row) => row.id === before),
        )
      : rows.length;
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const start = Math.max(0, end < 0 ? rows.length - limit : end - limit);
    const instance = `fixture:${id}:${conv.thread_generation ?? 0}`;
    return route.fulfill({
      json: {
        status: "ready",
        instance_id: instance,
        revision,
        blocks:
          url.searchParams.get("since") === String(revision)
            ? []
            : rows.slice(start, end),
        older: start > 0,
        newer: end < rows.length,
        reset:
          Boolean(url.searchParams.get("instance")) &&
          url.searchParams.get("instance") !== instance,
        removed: conv.removed ?? [],
      },
    });
  };
  await page.route(`${base}api/conversations/${id}/view?*`, view);
  let lastEvents = "";
  let eventsRevision = 0;
  await page.route(`${base}api/conversations/${id}/events`, (route) => {
    const conv = read();
    const rows = fixtureRows(conv);
    const encoded = JSON.stringify(rows);
    if (encoded !== lastEvents) {
      lastEvents = encoded;
      eventsRevision++;
    }
    const instance = `fixture:${id}:${conv.thread_generation ?? 0}`;
    const end = rows.length;
    const start = Math.max(0, end - 100);
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        `retry: 3000\n\n` +
        `id: ${instance}:${eventsRevision}\n` +
        "event: snapshot\n" +
        `data: ${JSON.stringify({ status: "ready", instance_id: instance, revision: eventsRevision, blocks: rows.slice(start, end), older: start > 0, newer: false })}\n\n`,
    });
  });
}

export async function routeArtifacts(
  page: Page,
  base: string,
  content = "# Browser artifact\nVisible body.\n\n![SVG chart](chart.svg)\n",
): Promise<void> {
  await page.route(`${base}api/artifacts**`, (route) => {
    const url = route.request().url();
    if (url.includes("/file"))
      return route.fulfill({
        body: url.includes("chart.svg") ? SVG_IMAGE : content,
        contentType: url.includes("chart.svg")
          ? "image/svg+xml"
          : "text/markdown; charset=utf-8",
      });
    if (url.includes("/versions"))
      return route.fulfill({
        json: [
          {
            version: ARTIFACT_VERSION,
            created_at: ARTIFACT.created_at,
            status: "ready",
          },
          {
            version: OLDER_ARTIFACT_VERSION,
            created_at: "2026-07-23T00:00:00Z",
            status: "ready",
          },
        ],
      });
    return route.fulfill({ json: [ARTIFACT] });
  });
}

export async function visibleAndUncovered(
  page: Page,
  selector: string,
): Promise<any> {
  const result: any = await page.locator(selector).evaluate((element) => {
    const browser = globalThis as any;
    const rect = element.getBoundingClientRect();
    const style = browser.getComputedStyle(element);
    const x = Math.max(
      0,
      Math.min(browser.innerWidth - 1, rect.left + rect.width / 2),
    );
    const y = Math.max(
      0,
      Math.min(browser.innerHeight - 1, rect.top + rect.height / 2),
    );
    const top = browser.document.elementFromPoint(x, y);
    return {
      width: rect.width,
      height: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      color: style.color,
      uncovered: Boolean(top && (top === element || element.contains(top))),
    };
  });
  if (
    !(
      result.width > 0 &&
      result.height > 0 &&
      result.display !== "none" &&
      result.visibility === "visible" &&
      Number(result.opacity) > 0 &&
      result.uncovered
    )
  )
    throw new Error(
      `${selector} is not visible and uncovered: ${JSON.stringify(result)}`,
    );
  if (result.color.includes("rgba(0, 0, 0, 0)"))
    throw new Error(`${selector} is transparent`);
  return result;
}

export async function postFixture(
  base: string,
  name: string,
  data?: unknown,
): Promise<any> {
  const response = await fetch(`${base}__browser-test/${name}`, {
    method: "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return response.json();
}

export const TURN_TOTAL_USAGE = {
  output: 75,
  input: 300,
  cacheRead: 1_900,
  cacheWrite: 40,
  calls: 2,
  replies: 2,
  partial: false,
};

export function summary(counts: Record<string, any> = {}): any {
  return {
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
    ...counts,
  };
}

export function turn(
  turnId: string,
  ask: string,
  reply: string,
  options: { tools?: any[]; cursor?: number; summary?: any } = {},
): any {
  const tools = options.tools ?? [];
  const cursor = options.cursor ?? 0;
  const sum =
    options.summary ?? summary({ tools: tools.length, shell: tools.length });
  const segments = [
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
      tools,
      assistant: {
        kind: "assistant",
        offset: cursor + 90,
        role: "assistant",
        content: reply,
        usage: { input: 120, output: 40, cacheRead: 900, cacheWrite: 60 },
      },
      summary: sum,
    },
  ];
  return {
    turn_id: turnId,
    cursor,
    started_at: 1,
    ended_at: 2,
    open: false,
    status: "idle",
    summary: sum,
    partial: false,
    segments,
    rows: [
      {
        id: `${turnId}:u0`,
        kind: "text",
        role: "user",
        origin: "operator",
        text: ask,
        live: false,
      },
      ...tools.map((tool: any, index: number) => ({
        id: `${turnId}:t${index}`,
        kind: "tool_call",
        role: "tool",
        origin: "tool",
        text: "",
        name: tool.name,
        args: tool.input_full ?? tool.input ?? "",
        input: tool.input,
        result: tool.result,
        stat: tool.stat,
        live: false,
      })),
      {
        id: `${turnId}:a0`,
        kind: "text",
        role: "assistant",
        origin: "assistant",
        text: reply,
        usage: { input: 120, output: 40, cacheRead: 900, cacheWrite: 60 },
        live: false,
      },
    ],
  };
}

export async function dispatchArtifactSelection(
  page: Page,
  pointerType = "mouse",
  needle = "Visible body",
): Promise<void> {
  await page.evaluate(
    ({ pointerType, needle }) => {
      const browser = globalThis as any;
      const root = browser.document.querySelector(".report-doc");
      const walker = browser.document.createTreeWalker(
        root,
        browser.NodeFilter.SHOW_TEXT,
      );
      let node;
      while (
        (node = walker.nextNode()) &&
        !node.textContent?.includes(needle)
      ) {}
      if (!root || !node) throw new Error("artifact text is not rendered");
      const text = node.textContent;
      const start = text.indexOf(needle);
      const range = browser.document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + needle.length);
      const selection = browser.window.getSelection();
      selection.removeAllRanges();
      root.dispatchEvent(
        new browser.PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 17,
          pointerType,
        }),
      );
      selection.addRange(range);
      browser.document.dispatchEvent(new browser.Event("selectionchange"));
      root.dispatchEvent(
        new browser.PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 17,
          pointerType,
        }),
      );
    },
    { pointerType, needle },
  );
}

export async function dispatchArtifactTap(
  page: Page,
  pointerType = "mouse",
): Promise<void> {
  await page.evaluate((pointerType) => {
    const browser = globalThis as any;
    const target = browser.document.querySelector(".artifact-markdown p");
    if (!target) throw new Error("artifact paragraph is not rendered");
    target.dispatchEvent(
      new browser.PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 23,
        pointerType,
      }),
    );
    browser.window.getSelection()?.removeAllRanges();
    browser.document.dispatchEvent(new browser.Event("selectionchange"));
    target.dispatchEvent(
      new browser.PointerEvent("pointerup", {
        bubbles: true,
        pointerId: 23,
        pointerType,
      }),
    );
    target.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
  }, pointerType);
}

export async function assertArtifactVersionMenuEscape(
  page: Page,
): Promise<void> {
  const pane = page.locator('.pane-col[data-pane="report"]');
  const button = page.locator(".artifact-version-btn");
  await button.click();
  await page.locator('.artifact-version-menu[role="menu"]').waitFor();
  await page.waitForFunction(
    "document.activeElement?.closest('.artifact-version-menu') !== null",
  );
  expect(await button.getAttribute("aria-expanded")).toBe("true");
  await page.waitForFunction(
    "document.querySelectorAll('.artifact-version-menu [role^=\\\"menuitem\\\"]').length >= 2",
  );
  const items = page.locator('.artifact-version-menu [role^="menuitem"]');
  const first = items.first();
  const last = items.last();
  await first.focus();
  expect(
    await first.evaluate((element) => {
      const browser = globalThis as any;
      return browser.document.activeElement === element;
    }),
  ).toBeTrue();
  await page.keyboard.press("ArrowUp");
  expect(
    await last.evaluate((element) => {
      const browser = globalThis as any;
      return browser.document.activeElement === element;
    }),
  ).toBeTrue();
  await page.keyboard.press("ArrowDown");
  expect(
    await first.evaluate((element) => {
      const browser = globalThis as any;
      return browser.document.activeElement === element;
    }),
  ).toBeTrue();
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    "!document.querySelector('.artifact-version-menu')",
  );
  expect(await button.getAttribute("aria-expanded")).toBe("false");
  expect(
    await button.evaluate((element) => {
      const browser = globalThis as any;
      return browser.document.activeElement === element;
    }),
  ).toBeTrue();
  expect(await pane.isVisible()).toBeTrue();
}

export async function runBrowserTests(
  groups: Array<[string, BrowserTest[]]>,
): Promise<void> {
  if (!(await Bun.file(join(ROOT, "web/dist/app.js")).exists())) {
    console.log("SKIP: build web/dist before the Chromium regression");
    return;
  }
  const coverage = process.env.RECURSE_BROWSER_COVERAGE
    ? new (await import("./coverage_record")).CoverageRecorder(
        process.env.RECURSE_BROWSER_COVERAGE,
      )
    : undefined;
  let total = 0;
  const failures: string[] = [];
  let interrupted = false;
  let activeCleanup: (() => Promise<void>) | undefined;
  const interrupt = () => {
    interrupted = true;
    void activeCleanup?.().catch(() => undefined);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    for (const [label, tests] of groups) {
      if (interrupted) break;
      const groupStarted = performance.now();
      total += tests.length;
      coverageGroup = label;
      browserProgress("group-log-open");
      const logDirectory = await mkdtemp(
        join(tmpdir(), "recurse-browser-log-"),
      );
      const logPath = join(logDirectory, `${label}.log`);
      const log = {
        file: await open(logPath, "a"),
        readers: [] as Promise<void>[],
      };
      groupLog = log;
      const previousFailures = failures.length;
      let passed = false;
      try {
        const server = await startServer();
        let browser: Browser | undefined;
        let cleanupPromise: Promise<void> | undefined;
        const cleanup = () =>
          (cleanupPromise ??= (async () => {
            browserProgress("browser-close");
            await browser?.close().catch(() => undefined);
            await stopServer(server);
          })());
        try {
          browserProgress(`browser-launch server_pid=${server.process.pid}`);
          browser = await chromium.launch({
            timeout: 30_000,
            headless: true,
            handleSIGINT: false,
            handleSIGTERM: false,
          });
          activeCleanup = cleanup;
          coverage?.instrument(browser);
          for (const test of tests) {
            if (interrupted) break;
            try {
              browserProgress(
                `test:${test.name} server_pid=${server.process.pid}`,
              );
              await test(browser, server.base, server.data, server.process.pid);
              console.log(`PASS: ${label}/${test.name}`);
            } catch (error) {
              failures.push(
                `${label}/${test.name}: ${error instanceof Error ? error.stack : error}`,
              );
              console.error(`FAIL: ${label}/${test.name}`);
              console.error(error);
            } finally {
              browserProgress(`test-cleanup:${test.name}`);
              await coverage?.flush();
              for (const context of browser.contexts()) {
                try {
                  await closeWithRoutes(context);
                } catch (error) {
                  failures.push(`${label}/${test.name} cleanup: ${error}`);
                  console.error(`FAIL: ${label}/${test.name} cleanup`, error);
                }
              }
            }
          }
        } finally {
          await cleanup();
          activeCleanup = undefined;
          browserProgress("coverage-finish");
          await coverage?.finishGroup(label);
        }
        passed = !interrupted && failures.length === previousFailures;
      } finally {
        groupLog = undefined;
        try {
          browserProgress("server-log-drain");
          const reads = await Promise.allSettled(log.readers);
          const failed = reads.find((read) => read.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        } catch (error) {
          passed = false;
          throw error;
        } finally {
          await log.file.close();
          if (passed) retire(logDirectory, join(tmpdir(), ".trash"));
          else console.error(`Browser server log: ${logPath}`);
          console.log(
            `Group timing: ${JSON.stringify({ name: label, seconds: (performance.now() - groupStarted) / 1000 })}`,
          );
        }
      }
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  if (interrupted) throw Error("Browser suite interrupted");
  if (failures.length)
    throw new Error(`FAILURES (${failures.length})\n${failures.join("\n")}`);
  console.log(`PASS: all ${total} browser tests`);
}
