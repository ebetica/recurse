// Check app pages under pane CSP: opaque-origin sandbox, no network.
// Report source-mapped errors, control failures, blocked loads and screenshots.
// Chromium checks run in the commit publisher with private HOME/temp, no keys.
// Browser group closes on completion or the overall deadline.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { ARTIFACT_ACTIVE_CSP, ArtifactError } from "../artifacts";
import { themedHtml } from "./theme";
import { readTheme } from "../themes";
import { createConfig } from "../config";

const ORIGIN = "https://artifact-check.invalid";
const PAGE_URL = `${ORIGIN}/`;
const WIDTHS = { wide: 1200, narrow: 390 } as const;
const VIEWPORT_HEIGHT = 800;
const MAX_SHOT_HEIGHT = 3_000;
const QUIET_MS = 300;
const SETTLE_MAX_MS = 3_000;
const MAX_CLICKS = 12;
const MAX_ISSUES = 40;
const MAX_MESSAGE = 500;
const DEADLINE_MS = 90_000;
const CONTROLS =
  'button, [role="button"], [role="tab"], summary, input[type="checkbox"], input[type="radio"]';

/** The browser could not run, so the page was not checked. */
export class ArtifactCheck extends ArtifactError {}

export interface CheckIssue {
  level: "error" | "warning";
  message: string;
  /** Source file:line:column, when the source map names one. */
  source?: string;
  /** The click that raised it; absent while the page loads. */
  after?: string;
  fix?: string;
}

type Width = keyof typeof WIDTHS;

export interface CheckReport {
  ok: boolean;
  issues: CheckIssue[];
  screenshots: Record<Width, string>;
  layout: Record<
    Width,
    { height: number; blank: boolean; scrolls_sideways: boolean }
  >;
  clicked: string[];
}

const FIXES: readonly (readonly [RegExp, string])[] = [
  [
    /^Loading the \w+ 'https?:/u,
    "The page has no network. Install the library from npm and import it, or put the file in the Artifact and reference it by a relative path.",
  ],
  [
    /^Connecting to /u,
    "fetch, XHR, and WebSockets reach nothing. Import data instead: import data from './data.json'.",
  ],
  [
    /localStorage|sessionStorage|cookie|indexedDB/iu,
    "Storage is unavailable in the sandbox; keep state in memory.",
  ],
  [
    /'(?:alert|confirm|prompt)\(\)'/u,
    "alert, confirm, and prompt do nothing; show messages in the page.",
  ],
  [/\bWorker\b/u, "Workers are blocked; do the work on the main thread."],
];

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode source-map mappings to per-line [column, source, line, column]. */
function decodeMappings(mappings: string): number[][][] {
  const state = [0, 0, 0, 0];
  return mappings.split(";").map((line) => {
    state[0] = 0;
    const segments: number[][] = [];
    for (const text of line.split(",")) {
      if (!text) continue;
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const char of text) {
        const digit = BASE64.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0;
        shift = 0;
      }
      segments.push(fields.map((delta, index) => (state[index]! += delta)));
    }
    return segments;
  });
}

type Mapper = (line: number, column: number) => string | undefined;

// Where the text of the script element containing `offset` begins, or -1. Scans
// element by element, skipping comments and script bodies, so markup quoted
// inside code is never taken for a tag.
function scriptStart(html: string, offset: number): number {
  let at = 0;
  for (;;) {
    const comment = html.indexOf("<!--", at);
    const open = html.indexOf("<script", at);
    if (open < 0 || open > offset) return -1;
    if (comment >= 0 && comment < open) {
      const end = html.indexOf("-->", comment + 4);
      if (end < 0) return -1;
      at = end + 3;
      continue;
    }
    const body = html.indexOf(">", open) + 1;
    const close = html.indexOf("</script", body);
    if (body <= 0 || close < 0) return -1;
    if (offset >= body && offset < close) return body;
    at = close;
  }
}

// Map a 1-based page line and column, as Chromium reports them, to the source.
// Bun inlines the bundle into one module script that ends with the map's debug
// id; the map's positions are relative to that script's text.
export function sourceMapper(html: string, sourceMap: string | null): Mapper {
  if (!sourceMap) return () => undefined;
  const map = JSON.parse(sourceMap) as {
    sources: string[];
    mappings: string;
    debugId?: string;
  };
  const marker = map.debugId ? html.indexOf(`debugId=${map.debugId}`) : -1;
  const start = marker < 0 ? -1 : scriptStart(html, marker);
  if (start < 0) return () => undefined;
  const before = html.slice(0, start);
  const startLine = before.split("\n").length;
  const startColumn = start - before.lastIndexOf("\n") - 1;
  const lines = decodeMappings(map.mappings);
  return (line, column) => {
    const row = line - startLine;
    const target = column - 1 - (row === 0 ? startColumn : 0);
    let best: number[] | undefined;
    for (const segment of lines[row] ?? []) {
      if (segment[0]! > target) break;
      best = segment;
    }
    if (!best || best.length < 4) return undefined;
    const source = (map.sources[best[1]!] ?? "").replace(
      /^(?:\.\.\/)*(?:src\/)?/u,
      "",
    );
    return `${source}:${best[2]! + 1}:${best[3]! + 1}`;
  };
}

/** The first stack frame in the agent's own code, else the first mapped one. */
function locate(stack: string, map: Mapper): string | undefined {
  let fallback: string | undefined;
  const frame = /artifact-check\.invalid\/:(\d+):(\d+)/gu;
  for (const match of stack.matchAll(frame)) {
    const at = map(Number(match[1]), Number(match[2]));
    if (!at) continue;
    if (!at.startsWith("node_modules/")) return at;
    fallback ??= at;
  }
  return fallback;
}

/**
 * Wait until the page stops changing its DOM (chart libraries animate their
 * first draw), so a screenshot shows the finished page.
 */
function settle(page: Page): Promise<void> {
  return page.evaluate(
    ([quiet, max]: number[]) =>
      new Promise<void>((done) => {
        let timer: ReturnType<typeof setTimeout>;
        const observer = new (globalThis as any).MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(finish, quiet);
        });
        const finish = () => {
          observer.disconnect();
          done();
        };
        observer.observe((globalThis as any).document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        timer = setTimeout(finish, quiet);
        setTimeout(finish, max);
      }),
    [QUIET_MS, SETTLE_MAX_MS],
  );
}

// Check a built page. `sourceMap` is Bun's external map for that build.
// Screenshots are written to `outDir` as wide.png and narrow.png. The whole
// check, page loads included, ends within `deadlineMs`.
export async function checkPage(
  html: Buffer,
  sourceMap: string | null,
  outDir: string,
  { deadlineMs = DEADLINE_MS }: { deadlineMs?: number } = {},
): Promise<CheckReport> {
  const { chromium } = await import("playwright");
  await mkdir(outDir, { recursive: true });
  const home = await mkdtemp(join(outDir, ".browser-"));
  const servedHtml = themedHtml(
    html.toString("utf8"),
    (await readTheme(createConfig().paths.THEMES_FILE)).css,
  );
  const map = sourceMapper(servedHtml, sourceMap);
  const issues: CheckIssue[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  const add = (issue: CheckIssue) => {
    const key = `${issue.level}\0${issue.message}\0${issue.source}\0${after}`;
    if (seen.has(key) || issues.length >= MAX_ISSUES) return;
    const message = issue.message.split("\n", 1)[0]!.slice(0, MAX_MESSAGE);
    seen.add(key);
    const fix = FIXES.find(([pattern]) => pattern.test(message))?.[1];
    // Invariant: Only keys with values: the report is printed as strict JSON.
    issues.push({
      level: issue.level,
      message,
      ...(issue.source ? { source: issue.source } : {}),
      ...(after ? { after } : {}),
      ...(fix ? { fix } : {}),
    });
  };
  const report: CheckReport = {
    ok: false,
    issues,
    screenshots: { wide: "", narrow: "" },
    layout: {} as CheckReport["layout"],
    clicked: [],
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
      },
    });
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    const missing = /Executable doesn't exist|playwright install/iu.test(
      String(error),
    );
    throw new ArtifactCheck(
      missing
        ? "Chromium for Playwright is not installed; run `bun x playwright install chromium` in $RECURSE_SRC"
        : "the browser could not start",
    );
  }
  const deadline = setTimeout(() => void browser.close(), deadlineMs);
  try {
    for (const [name, width] of Object.entries(WIDTHS) as [Width, number][]) {
      const context = await browser.newContext({
        viewport: { width, height: VIEWPORT_HEIGHT },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.on("pageerror", (error) =>
        add({
          level: "error",
          message: `${error.name}: ${error.message}`,
          source: locate(error.stack ?? "", map),
        }),
      );
      page.on("console", (message) => {
        const type = message.type();
        if (type !== "error" && type !== "warning") return;
        const text = message.text();
        // Invariant: Chromium repeats each blocked load as a generic network
        // failure.
        if (/^Failed to load resource/u.test(text)) return;
        const { url, lineNumber, columnNumber } = message.location();
        add({
          // Invariant: React reports development warnings through
          // console.error.
          level:
            type === "error" && !text.startsWith("Warning:")
              ? "error"
              : "warning",
          message: text,
          source:
            url === PAGE_URL && (lineNumber || columnNumber)
              ? map(lineNumber + 1, columnNumber + 1)
              : undefined,
        });
      });
      await page.route("**/*", (route) =>
        route.request().url() === PAGE_URL
          ? route.fulfill({
              contentType: "text/html; charset=utf-8",
              headers: { "content-security-policy": ARTIFACT_ACTIVE_CSP },
              body: servedHtml,
            })
          : route.abort(),
      );
      after = undefined;
      await page.goto(PAGE_URL, { waitUntil: "load", timeout: deadlineMs });
      await settle(page);
      const measure = () =>
        page.evaluate(() => {
          const doc = (globalThis as any).document;
          const root = doc.documentElement;
          const body = doc.body;
          const drawn = [
            ...(body?.querySelectorAll("canvas, svg, img, video") ?? []),
          ].some((el: any) => el.getBoundingClientRect().width > 0);
          return {
            height: Math.ceil(root.scrollHeight),
            blank: !body || (!body.innerText.trim() && !drawn),
            scrolls_sideways:
              root.scrollWidth > (globalThis as any).innerWidth + 1,
          };
        });
      const layout = await measure();
      report.layout[name] = layout;
      const shot = join(outDir, `${name}.png`);
      await page.screenshot({
        path: shot,
        fullPage: true,
        clip: {
          x: 0,
          y: 0,
          width,
          height: Math.min(Math.max(layout.height, 1), MAX_SHOT_HEIGHT),
        },
      });
      report.screenshots[name] = shot;
      if (name === "wide") {
        const controls = await page.$$(CONTROLS);
        for (const control of controls.slice(0, MAX_CLICKS)) {
          if (!(await control.isVisible().catch(() => false))) continue;
          const label = await control
            .evaluate((el: any) => {
              const text = (el.getAttribute("aria-label") || el.innerText || "")
                .trim()
                .replace(/\s+/gu, " ")
                .slice(0, 40);
              return `${el.tagName.toLowerCase()}${text ? ` "${text}"` : ""}`;
            })
            .catch(() => "a control");
          after = `clicking ${label}`;
          report.clicked.push(label);
          await control.click({ timeout: 2_000 }).catch(() => undefined);
          await settle(page);
          if (!layout.blank && (await measure()).blank)
            add({ level: "error", message: "the page went blank" });
        }
      }
      await context.close();
    }
  } catch (error) {
    if (!browser.isConnected())
      throw new ArtifactCheck(
        `the page did not finish within ${deadlineMs / 1000}s`,
      );
    const reason = String((error as Error)?.message ?? error).split("\n", 1)[0];
    throw new ArtifactCheck(`the page could not be checked: ${reason}`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await rm(home, { recursive: true, force: true });
  }
  after = undefined;
  if (report.layout.wide?.blank)
    issues.unshift({ level: "error", message: "the page shows nothing" });
  report.ok = !issues.some((issue) => issue.level === "error");
  return report;
}
