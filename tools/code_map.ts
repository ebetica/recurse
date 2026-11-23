#!/usr/bin/env bun
/**
 * Show each file's source header and each folder's README or index summary.
 * Usage: bun tools/code_map.ts [folder] [--depth N]
 * Defaults to the current folder and depth 1; depth may be 1–8.
 * Skip dotfiles, dependencies, build output and symlinks; inspect at most 256 entries.
 */
import { lstat, opendir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { marked, type Tokens } from "marked";
import { toolHelp } from "./_help.ts";
import {
  HEADER_BYTES,
  isHeaderSource,
  sourceHeader,
} from "./code_map_headers.ts";

const ENTRY_LIMIT = 256;
const SKIP = new Set(["node_modules", "dist", "vendor"]);
const INDEX = [
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.mts",
  "index.mjs",
  "index.cts",
  "index.cjs",
  "index.html",
  "__init__.py",
];

async function prefix(file: string): Promise<string> {
  try {
    return (await lstat(file)).isFile()
      ? await Bun.file(file).slice(0, HEADER_BYTES).text()
      : "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function folderSummary(folder: string): Promise<string | undefined> {
  const readme = await prefix(join(folder, "README.md"));
  const paragraph = marked
    .lexer(readme)
    .find((token): token is Tokens.Paragraph => token.type === "paragraph");
  if (paragraph) {
    const prose = paragraph.text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (prose) return prose.match(/^.*?(?:[.!?](?=\s|$)|$)/)?.[0];
  }
  for (const name of INDEX) {
    const file = join(folder, name);
    const header = sourceHeader(file, await prefix(file));
    if (header) return header;
  }
  return undefined;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean" }, depth: { type: "string" } },
  });
  if (values.help) {
    console.log(toolHelp(import.meta.url));
    return;
  }
  const depth = values.depth ?? "1";
  if (positionals.length > 1 || !/^[1-8]$/.test(depth))
    throw new Error("expected one folder and a depth from 1 to 8; see --help");
  const root = resolve(positionals[0] ?? ".");
  if (!(await lstat(root)).isDirectory()) throw new Error("expected a folder");
  let inspected = 0;
  let truncated = false;
  async function list(folder: string, level: number): Promise<void> {
    const entries = [];
    for await (const entry of await opendir(folder)) {
      if (inspected >= ENTRY_LIMIT) {
        truncated = true;
        break;
      }
      inspected++;
      if (
        !entry.name.startsWith(".") &&
        !SKIP.has(entry.name) &&
        (entry.isFile() || entry.isDirectory())
      )
        entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(folder, entry.name);
      const directory = entry.isDirectory();
      const summary = directory
        ? await folderSummary(file)
        : isHeaderSource(file)
          ? (sourceHeader(file, await prefix(file)) ?? "Missing source header")
          : undefined;
      console.log(
        `${"  ".repeat(level)}${entry.name}${directory ? "/" : ""}${summary ? ` — ${summary}` : ""}`,
      );
      if (directory && level < Number(depth)) {
        if (inspected === ENTRY_LIMIT) truncated = true;
        else await list(file, level + 1);
      }
    }
  }
  console.log(`${relative(process.cwd(), root) || "."}/`);
  await list(root, 1);
  if (truncated)
    console.log(
      `Stopped after inspecting ${ENTRY_LIMIT} entries; choose a smaller folder.`,
    );
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(
      `code map: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
