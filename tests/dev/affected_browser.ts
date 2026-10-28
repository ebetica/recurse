/**
 * Browser coverage keys and the browser half of tests/dev/affected_tests.ts.
 * Map keys are content-based; unknown keys fall back, never to nothing.
 */
import ts from "typescript";

export type CoverageMap = {
  commit: string;
  date: string;
  groups: string[];
  /** Files the capture saw; an unlisted changed file is new since capture. */
  files: string[];
  /** Script -> function key ("" = ran) -> group indexes ([] = never ran). */
  js: Record<string, Record<string, number[]>>;
  /** CSS source -> rule key -> group indexes ([] = unused); "" = loaded. */
  css: Record<string, Record<string, number[]>>;
  /** "class:name" / "id:name" seen in a group's pages. */
  tokens: Record<string, number[]>;
};

export type Rule = {
  key: string;
  start: number;
  end: number;
  /** At-rules other than grouping ones: they apply wherever the sheet loads. */
  global: boolean;
};

const GROUPING = /^@(?:media|supports|container|layer|scope)\b/;

/** Blank out comments, keeping offsets. */
function uncomment(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** Style rules with their @media/@supports chain plus selector as key. */
export function cssRules(source: string): Rule[] {
  const text = uncomment(source);
  const rules: Rule[] = [];
  const stack: string[] = [];
  const seen = new Map<string, number>();
  let i = 0;
  const skipString = (at: number) => {
    const quote = text[at];
    let j = at + 1;
    while (j < text.length && text[j] !== quote) j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  const blockEnd = (open: number) => {
    let depth = 0;
    for (let j = open; j < text.length; j++) {
      if (text[j] === '"' || text[j] === "'") j = skipString(j) - 1;
      else if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) return j + 1;
    }
    return text.length;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "}") (stack.pop(), i++);
    else {
      let j = i;
      while (j < text.length && text[j] !== "{" && text[j] !== ";") {
        if (text[j] === '"' || text[j] === "'") j = skipString(j);
        else j++;
      }
      const prelude = text.slice(i, j).replace(/\s+/g, " ").trim();
      if (text[j] !== "{") {
        i = j + 1;
        continue;
      }
      if (GROUPING.test(prelude)) {
        stack.push(prelude);
        i = j + 1;
        continue;
      }
      const end = blockEnd(j);
      const base = [...stack, prelude].join(" | ");
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      rules.push({
        key: count ? `${base} #${count + 1}` : base,
        start: i,
        end,
        global: prelude.startsWith("@"),
      });
      i = end;
    }
  }
  return rules;
}

/**
 * Class/id tokens one selector needs, or null when it names none.
 */
export function selectorNeeds(selector: string): Array<string[] | null> {
  let flat = selector.replace(/\[[^\]]*\]/g, "");
  for (let prev = ""; prev !== flat; ) {
    prev = flat;
    flat = flat.replace(/::?[\w-]+\([^()]*\)/g, "");
  }
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let k = 0; k < flat.length; k++) {
    if (flat[k] === "(") depth++;
    else if (flat[k] === ")") depth--;
    else if (flat[k] === "," && depth === 0)
      (parts.push(flat.slice(last, k)), (last = k + 1));
  }
  parts.push(flat.slice(last));
  return parts.map((part) => {
    const needs = [...part.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)].map(
      ([, kind, name]) => `${kind === "." ? "class" : "id"}:${name}`,
    );
    return needs.length ? needs : null;
  });
}

export type Span = {
  key: string;
  start: number;
  end: number;
  parent: number;
  /** Another function here shares its name path; the key may have moved. */
  ambiguous: boolean;
};

function nameOf(node: ts.Node, text: string): string {
  const named = (node as { name?: ts.Node }).name;
  if (named && (ts.isIdentifier(named) || ts.isPrivateIdentifier(named)))
    return named.text;
  if (named && ts.isStringLiteral(named)) return named.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name)
  )
    return parent.name.text;
  if (ts.isBinaryExpression(parent) && parent.right === node)
    return parent.left.getText();
  const start = node.getStart();
  const line = text.slice(start, text.indexOf("\n", start) >>> 0);
  return `@${line.trim().slice(0, 80)}`;
}

/**
 * Each function's key, stable across edits outside its own name or first line.
 */
export function functionSpans(file: string, text: string): Span[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const spans: Span[] = [];
  const seen = new Map<string, number>();
  const bases: string[] = [];
  const visit = (node: ts.Node, prefix: string, parent: number) => {
    let next = prefix;
    let index = parent;
    if (ts.isFunctionLike(node) && (node as { body?: ts.Node }).body) {
      const base = `${prefix}${prefix ? "." : ""}${nameOf(node, text)}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      next = count ? `${base}#${count + 1}` : base;
      index = spans.push({
        key: next,
        start: node.getStart(),
        end: node.end,
        parent,
        ambiguous: false,
      });
      bases.push(base);
      index--;
    } else if (ts.isClassLike(node) && node.name)
      next = `${prefix}${prefix ? "." : ""}${node.name.text}`;
    ts.forEachChild(node, (child) => visit(child, next, index));
  };
  visit(source, "", -1);
  spans.forEach((span, k) => (span.ambiguous = seen.get(bases[k]!)! > 1));
  return spans;
}

/** The innermost span containing [start, end), as an index, or -1. */
export function innermost(spans: Span[], start: number, end = start): number {
  let found = -1;
  for (let k = 0; k < spans.length; k++)
    if (spans[k]!.start <= start && end <= spans[k]!.end) found = k;
  return found;
}

const VLQ = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Source map segments: [gen line, col, source, orig line, col]. */
export function decodeMappings(mappings: string): number[][] {
  const out: number[][] = [];
  let line = 0;
  const state = [0, 0, 0, 0];
  for (const group of mappings.split(";")) {
    let column = 0;
    for (const segment of group.split(",")) {
      if (!segment) continue;
      const values: number[] = [];
      let shift = 0;
      let value = 0;
      for (const char of segment) {
        const digit = VLQ.indexOf(char);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = shift = 0;
        }
      }
      column += values[0]!;
      if (values.length < 4) continue;
      for (let k = 0; k < 3; k++) state[k] += values[k + 1]!;
      out.push([line, column, state[0]!, state[1]!, state[2]!]);
    }
    line++;
  }
  return out;
}

export type FileChange = {
  path: string;
  /** Text before and after, or null when absent or the hunks skip lines. */
  before: string | null;
  after: string | null;
  /** 1-based line numbers removed (before) and added (after). */
  removed: number[];
  added: number[];
};

/** Parse `git diff --no-renames -U<large>` output. */
export function fileChanges(diff: string): FileChange[] {
  const out: FileChange[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const header = chunk.match(/^diff --git a\/(\S+) b\/(\S+)$/m);
    if (!header) continue;
    const created = /^new file mode/m.test(chunk);
    const deleted = /^deleted file mode/m.test(chunk);
    const before: string[] = [];
    const after: string[] = [];
    const removed: number[] = [];
    const added: number[] = [];
    let whole = !/^Binary files /m.test(chunk);
    let hunks = 0;
    let oldLine = 0;
    let newLine = 0;
    for (const line of chunk.split("\n")) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Math.max(Number(hunk[1]) - 1, 0);
        newLine = Math.max(Number(hunk[2]) - 1, 0);
        if (++hunks > 1 || oldLine > 0 || newLine > 0) whole = false;
      } else if (!hunks || line.startsWith("\\")) continue;
      else if (line.startsWith("-"))
        (before.push(line.slice(1)), removed.push(++oldLine));
      else if (line.startsWith("+"))
        (after.push(line.slice(1)), added.push(++newLine));
      else if (line.startsWith(" "))
        (before.push(line.slice(1)),
          after.push(line.slice(1)),
          oldLine++,
          newLine++);
    }
    out.push({
      path: header[2]!,
      before: created || !whole ? null : before.join("\n"),
      after: deleted || !whole ? null : after.join("\n"),
      removed,
      added,
    });
  }
  return out;
}

export type BrowserPlan = {
  /** Group labels a change reaches through the map. */
  labels: Set<string>;
  /** Why the whole suite must run; empty when the map placed everything. */
  whole: string[];
  /** How changes were placed, for the reader. */
  notes: string[];
};

/** [start, end] offsets of 1-based lines in a text. */
function lineSpans(text: string, lines: number[]): Array<[number, number]> {
  const starts = [0];
  for (let k = 0; k < text.length; k++)
    if (text[k] === "\n") starts.push(k + 1);
  return lines.map((line) => [
    starts[line - 1] ?? text.length,
    (starts[line] ?? text.length + 1) - 1,
  ]);
}

/** Indexes of groups that showed every token. */
function showed(map: CoverageMap, needs: string[]): number[] {
  let ids: number[] | null = null;
  for (const token of needs) {
    const seen: number[] = map.tokens[token] ?? [];
    ids = ids === null ? seen : ids.filter((id) => seen.includes(id));
  }
  return ids ?? [];
}

/**
 * Groups that ran the functions a change touches; null without full text or
 * when the map recorded nothing for the file.
 */
export function scriptGroups(
  change: FileChange,
  map: CoverageMap,
): number[] | null {
  const keys = map.js[change.path];
  if (!keys) return null;
  const ids = new Set<number>();
  for (const [text, lines] of [
    [change.before, change.removed],
    [change.after, change.added],
  ] as const) {
    if (!lines.length) continue;
    if (text === null) return null;
    const spans = functionSpans(change.path, text);
    for (const [start, end] of lineSpans(text, lines)) {
      let k = innermost(spans, start, end);
      for (let up = k; up >= 0; up = spans[up]!.parent)
        if (spans[up]!.ambiguous) k = spans[up]!.parent;
      while (k >= 0 && !(spans[k]!.key in keys)) k = spans[k]!.parent;
      for (const id of keys[k >= 0 ? spans[k]!.key : ""] ?? []) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Groups that used the rules a change touches in a CSS text. At-rules that
 * apply sheet-wide (@keyframes, @font-face) take every group that loaded it.
 */
function ruleGroups(
  map: CoverageMap,
  file: string,
  text: string,
  css: string,
  offset: number,
  lines: number[],
): number[] {
  const keys = map.css[file]!;
  const rules = cssRules(css);
  const ids = new Set<number>();
  const add = (list: number[] | undefined) =>
    list?.forEach((id) => ids.add(id));
  for (const [start, end] of lineSpans(text, lines)) {
    const touched = rules.filter(
      (rule) => offset + rule.start <= end && start < offset + rule.end,
    );
    if (!touched.length) add(keys[""]);
    for (const rule of touched) {
      if (rule.global) add(keys[""]);
      else if (rule.key in keys) add(keys[rule.key]);
      else {
        const selector = rule.key
          .split(" | ")
          .at(-1)!
          .replace(/ #\d+$/, "");
        for (const needs of selectorNeeds(selector))
          add(needs ? showed(map, needs) : keys[""]);
      }
    }
  }
  return [...ids];
}

/** The style block of web/index.html as [start, end) offsets, or null. */
function styleBlock(html: string): [number, number] | null {
  const start = html.indexOf("<style>");
  const end = html.indexOf("</style>", start);
  return start < 0 || end < 0 ? null : [start + "<style>".length, end];
}

/**
 * Map changed frontend files to browser groups. `importers` names the mapped
 * web files that (transitively) import a path, for files new since capture.
 */
export function frontendPlan(
  changes: FileChange[],
  map: CoverageMap,
  importers: (path: string) => string[],
): BrowserPlan {
  const plan: BrowserPlan = { labels: new Set(), whole: [], notes: [] };
  const known = new Set(map.files);
  const take = (path: string, ids: number[] | null, how: string) => {
    if (ids === null) {
      plan.whole.push(`${path}: ${how}`);
      return;
    }
    for (const id of ids) plan.labels.add(map.groups[id]!);
    plan.notes.push(
      `${path}: ${how} -> ${ids.length ? ids.map((id) => map.groups[id]).join(" ") : "no group"}`,
    );
  };
  for (const change of changes) {
    const { path } = change;
    if (/^web\/(?!vendor\/|dist\/).*\.ts$/.test(path)) {
      if (!map.js[path]) {
        const how = known.has(path)
          ? "the map recorded no code for it"
          : "new since capture";
        const users = importers(path).filter((file) => map.js[file]);
        const ids = users.flatMap((file) => map.js[file]![""] ?? []);
        if (users.length)
          take(
            path,
            [...new Set(ids)],
            `${how}; groups that loaded ${users.join(", ")}`,
          );
        else take(path, null, `${how} and no mapped file imports it`);
      } else
        take(
          path,
          scriptGroups(change, map),
          "groups that ran the changed functions",
        );
    } else if (/^web\/[^/]+\.css$/.test(path)) {
      if (!map.css[path])
        take(path, null, "stylesheet the map recorded nothing for");
      else {
        const ids = new Set<number>();
        let partial = false;
        for (const [text, lines] of [
          [change.before, change.removed],
          [change.after, change.added],
        ] as const) {
          if (!lines.length) continue;
          if (text === null) partial = true;
          else
            ruleGroups(map, path, text, text, 0, lines).forEach((id) =>
              ids.add(id),
            );
        }
        take(
          path,
          partial ? null : [...ids],
          partial
            ? "diff lacks full context"
            : "groups that used the changed rules",
        );
      }
    } else if (path === "web/index.html") {
      const ids = new Set<number>();
      let outside = "";
      for (const [text, lines] of [
        [change.before, change.removed],
        [change.after, change.added],
      ] as const) {
        if (!lines.length) continue;
        const block = text === null ? null : styleBlock(text);
        if (text === null || !block || !map.css["web/index.html"]) {
          outside = "diff lacks full context, or the map has no <style> rules";
          continue;
        }
        const spans = lineSpans(text, lines);
        const inside = lines.filter(
          (_, k) => spans[k]![0] >= block[0] && spans[k]![1] <= block[1],
        );
        if (inside.length < lines.length) outside = "markup or script changed";
        ruleGroups(
          map,
          "web/index.html",
          text,
          text.slice(...block),
          block[0],
          inside,
        ).forEach((id) => ids.add(id));
      }
      take(
        path,
        outside ? null : [...ids],
        outside || "groups that used the changed rules in its <style>",
      );
    } else take(path, null, "frontend file the map does not cover");
  }
  return plan;
}
