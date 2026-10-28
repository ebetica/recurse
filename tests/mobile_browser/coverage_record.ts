import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  cssRules,
  decodeMappings,
  functionSpans,
  type Span,
} from "../../tests/dev/affected_browser";

const ROOT = join(import.meta.dir, "../..");
const DIST = join(ROOT, "web/dist");
const CSS_SOURCES = ["web/theme.css", "web/panes/powerbar.css", "web/app.css"];

const TOKEN_SCRIPT = `(() => {
  const seen = new Set();
  let pending = [];
  const add = (el) => {
    if (!el || el.nodeType !== 1) return;
    for (const name of el.classList || []) {
      const key = "class:" + name;
      if (!seen.has(key)) seen.add(key), pending.push(key);
    }
    if (el.id && !seen.has("id:" + el.id))
      seen.add("id:" + el.id), pending.push("id:" + el.id);
  };
  const flush = () => {
    if (pending.length && globalThis.__coverageTokens) {
      globalThis.__coverageTokens(pending);
      pending = [];
    }
  };
  new MutationObserver((records) => {
    for (const record of records) {
      add(record.target);
      for (const node of record.addedNodes) {
        add(node);
        if (node.querySelectorAll) node.querySelectorAll("*").forEach(add);
      }
    }
    flush();
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "id"],
  });
})();`;

type SourceMap = {
  sources: string[];
  contents: Array<string | null>;
  segments: number[][];
};

export class CoverageRecorder {
  private js = new Map<string, Set<string>>();
  private css = new Map<string, Set<string>>();
  private tokens = new Set<string>();
  private cssKnown = new Map<string, Set<string>>();
  private live = new Set<Page>();
  private contexts = new WeakSet<BrowserContext>();
  private maps = new Map<string, SourceMap | null>();
  private spans = new Map<string, Span[]>();
  private lineStarts = new Map<string, number[]>();

  constructor(private readonly out: string) {}

  instrument(browser: Browser): void {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      await this.context(context);
      return context;
    };
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => {
      const page = await newPage(...args);
      await this.context(page.context());
      await this.page(page);
      return page;
    };
  }

  private async context(context: BrowserContext): Promise<void> {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    await context.exposeBinding(
      "__coverageTokens",
      (_source, list: string[]) => {
        for (const token of list) this.tokens.add(token);
      },
    );
    await context.addInitScript(TOKEN_SCRIPT);
    context.on("page", (page) => void this.page(page).catch(() => undefined));
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await this.page(page);
      return page;
    };
    const close = context.close.bind(context);
    context.close = async (...args) => {
      for (const page of context.pages()) await this.stop(page);
      return close(...args);
    };
  }

  private async page(page: Page): Promise<void> {
    if (this.live.has(page)) return;
    this.live.add(page);
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.coverage.startCSSCoverage({ resetOnNavigation: false });
    const close = page.close.bind(page);
    page.close = async (...args) => {
      await this.stop(page);
      return close(...args);
    };
  }

  async flush(): Promise<void> {
    for (const page of [...this.live]) await this.stop(page);
  }

  private async stop(page: Page): Promise<void> {
    if (!this.live.delete(page) || page.isClosed()) return;
    const [js, css] = await Promise.all([
      page.coverage.stopJSCoverage(),
      page.coverage.stopCSSCoverage(),
    ]).catch(() => [[], []] as const);
    for (const entry of js) this.script(entry);
    for (const entry of css)
      this.sheet(entry.url, entry.text ?? "", entry.ranges);
  }

  private add(target: Map<string, Set<string>>, file: string, key: string) {
    if (!target.has(file)) target.set(file, new Set());
    target.get(file)!.add(key);
  }

  private sourceMap(name: string): SourceMap | null {
    if (!this.maps.has(name)) {
      let map: SourceMap | null = null;
      try {
        const raw = JSON.parse(readFileSync(join(DIST, `${name}.map`), "utf8"));
        map = {
          sources: (raw.sources as string[]).map((source) =>
            relative(ROOT, normalize(join(DIST, source))),
          ),
          contents: raw.sourcesContent ?? [],
          segments: decodeMappings(raw.mappings),
        };
      } catch {
        map = null;
      }
      this.maps.set(name, map);
    }
    return this.maps.get(name)!;
  }

  private functions(file: string, text?: string | null): Span[] {
    if (!this.spans.has(file)) {
      const source = text ?? readFileSync(join(ROOT, file), "utf8");
      this.spans.set(file, functionSpans(file, source));
      const starts = [0];
      for (let k = 0; k < source.length; k++)
        if (source[k] === "\n") starts.push(k + 1);
      this.lineStarts.set(file, starts);
    }
    return this.spans.get(file)!;
  }

  private script(entry: {
    url: string;
    source?: string;
    functions: Array<{
      ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
    }>;
  }): void {
    const url = new URL(entry.url);
    if (!url.pathname.startsWith("/static/") || !entry.source) return;
    const map = this.sourceMap(url.pathname.slice("/static/".length));
    if (!map) {
      this.add(this.js, `unmapped:${url.pathname}`, "");
      return;
    }
    const starts = [0];
    for (let k = 0; k < entry.source.length; k++)
      if (entry.source[k] === "\n") starts.push(k + 1);
    const ranges = entry.functions
      .flatMap((fn) => fn.ranges)
      .sort(
        (a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset,
      );
    const stack: typeof ranges = [];
    let next = 0;
    const segments = map.segments
      .map((segment) => [
        starts[segment[0]!]! + segment[1]!,
        ...segment.slice(2),
      ])
      .sort((a, b) => a[0]! - b[0]!);
    for (const [offset, source, line, column] of segments) {
      while (next < ranges.length && ranges[next]!.startOffset <= offset!) {
        while (
          stack.length &&
          stack.at(-1)!.endOffset <= ranges[next]!.startOffset
        )
          stack.pop();
        stack.push(ranges[next++]!);
      }
      while (stack.length && stack.at(-1)!.endOffset <= offset!) stack.pop();
      if (!stack.length || stack.at(-1)!.count === 0) continue;
      const file = map.sources[source!]!;
      if (!file.startsWith("web/") || !file.endsWith(".ts")) continue;
      const spans = this.functions(file, map.contents[source!]);
      const position = this.lineStarts.get(file)![line!]! + column!;
      this.add(this.js, file, "");
      for (let k = innermostAt(spans, position); k >= 0; k = spans[k]!.parent)
        this.add(this.js, file, spans[k]!.key);
    }
  }

  private sheet(
    url: string,
    text: string,
    ranges: Array<{ start: number; end: number }>,
  ): void {
    const pathname = new URL(url).pathname;
    const sources: Array<[string, number, string]> = [];
    if (pathname === "/static/app.css") {
      let offset = 0;
      for (const file of CSS_SOURCES) {
        const body = readFileSync(join(ROOT, file), "utf8");
        const at = text.indexOf(body, offset);
        if (at < 0) {
          this.add(this.css, `unmapped:${pathname}`, "");
          return;
        }
        sources.push([file, at, body]);
        offset = at + body.length;
      }
    } else if (/^\/static\/[\w-]+\.css$/.test(pathname)) {
      const file = `web${pathname.slice("/static".length)}`;
      if (file === "web/katex.css") return;
      sources.push([file, 0, text]);
    } else {
      // test-check-allow: T1 maps the served <style> back to index.html rules
      const html = readFileSync(join(ROOT, "web/index.html"), "utf8");
      if (!text.trim() || !html.includes(text)) return;
      sources.push(["web/index.html", 0, text]);
    }
    for (const [file, offset, body] of sources) {
      this.add(this.css, file, "");
      for (const rule of cssRules(body)) {
        this.add(this.cssKnown, file, rule.key);
        const open = offset + body.indexOf("{", rule.start);
        if (ranges.some((r) => r.start < offset + rule.end && r.end > open))
          this.add(this.css, file, rule.key);
      }
    }
  }

  private server(label: string): void {
    const dir = join(this.out, "server", label);
    if (!existsSync(dir)) return;
    for (const port of readdirSync(dir)) {
      const lcov = join(dir, port, "lcov.info");
      if (!existsSync(lcov)) throw new Error(`no server coverage in ${lcov}`);
      for (const record of readFileSync(lcov, "utf8").split("end_of_record")) {
        const file = record.match(/^SF:(.+)$/m)?.[1];
        if (!file || file.startsWith("tests/mobile_browser/server_coverage"))
          continue;
        if (!/\.[cm]?[jt]s$/.test(file) || !existsSync(join(ROOT, file)))
          continue;
        const spans = this.functions(file);
        const starts = this.lineStarts.get(file)!;
        this.add(this.js, file, "");
        for (const [, line, count] of record.matchAll(/^DA:(\d+),(\d+)/gm)) {
          if (count === "0") continue;
          const start = starts[Number(line) - 1] ?? 0;
          const end = (starts[Number(line)] ?? start + 1) - 1;
          spans.forEach((span, k) => {
            if (span.start > end || span.end <= start) return;
            for (let up = k; up >= 0; up = spans[up]!.parent)
              this.add(this.js, file, spans[up]!.key);
          });
        }
      }
    }
  }

  async finishGroup(label: string): Promise<void> {
    await this.flush();
    this.server(label);
    const sets = (map: Map<string, Set<string>>) =>
      Object.fromEntries(
        [...map].map(([file, keys]) => [file, [...keys].sort()]),
      );
    const known = Object.fromEntries(
      [...this.js.keys()]
        .filter((file) => this.spans.has(file))
        .map((file) => [file, this.spans.get(file)!.map((span) => span.key)]),
    );
    writeFileSync(
      join(this.out, `${label}.json`),
      JSON.stringify({
        label,
        js: sets(this.js),
        known,
        css: sets(this.css),
        tokens: [...this.tokens].sort(),
        cssKnown: sets(this.cssKnown),
      }),
    );
    this.js = new Map();
    this.css = new Map();
    this.tokens = new Set();
  }
}

function innermostAt(spans: Span[], position: number): number {
  let found = -1;
  for (let k = 0; k < spans.length; k++)
    if (spans[k]!.start <= position && position < spans[k]!.end) found = k;
  return found;
}
