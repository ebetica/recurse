#!/usr/bin/env bun
// Docs check: every Markdown link and backticked repo path in AGENTS.md,
// README.md files and docs/ resolves, and the code map names every source part.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOTS = /^(?:src|web|docs|tools|scripts|tests|playground)\//;
const BUILT = /^web\/dist(?:\/|$)/;
const MAP = "docs/agents/repository-map.md";

async function tracked(...specs: string[]): Promise<string[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z", "--", ...specs], {
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("git ls-files failed");
  return out.split("\0").filter(Boolean);
}

function expandBraces(text: string): string {
  return text.replace(
    /([\w./-]*)\{([\w.,-]+)\}(\/?)/g,
    (_, head: string, list: string, tail: string) =>
      list
        .split(",")
        .map((part) => head + part + tail)
        .join(" "),
  );
}

const problems: string[] = [];
const docs = (
  await tracked("AGENTS.md", "README.md", ":(glob)docs/**/*.md", "**/README.md")
).filter((file) => !file.startsWith("node_modules/"));
for (const file of docs) {
  const text = await readFile(file, "utf8");
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(?:[a-z]+:|#)/i.test(target!)) continue;
    const path = join(dirname(file), target!.replace(/#.*$/, ""));
    if (!existsSync(path)) problems.push(`${file}: broken link ${target}`);
  }
  for (const [, path] of text.matchAll(/`([^`\s]+)`/g)) {
    if (!ROOTS.test(path!) || BUILT.test(path!) || /[<>*{}$]/.test(path!))
      continue;
    if (!existsSync(path!)) problems.push(`${file}: missing path ${path}`);
  }
}

const map = expandBraces(await readFile(MAP, "utf8"));
const parts = new Set<string>();
for (const file of await tracked("src")) {
  const match = /^(src\/extensions\/(?:core|extra)\/[^/]+|src\/[^/]+)\//.exec(
    file,
  );
  if (match) parts.add(`${match[1]}/`);
}
for (const part of parts)
  if (!map.includes(part)) problems.push(`${MAP}: does not name ${part}`);

for (const problem of problems) console.error(problem);
if (problems.length) process.exit(1);
console.log(`docs check: ${docs.length} files, ${parts.size} code-map parts`);
