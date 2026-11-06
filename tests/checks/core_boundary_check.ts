#!/usr/bin/env bun
// Core must not depend on the optional deployment and examples directory.
import { lstat, readFile, readlink } from "node:fs/promises";

const directory = ["play", "ground"].join("");
const forbidden = new RegExp(`\\b${directory}\\b`, "i");
/** The optional deployment owns its workflow. */
const optionalWorkflow = `:(exclude).github/workflows/${directory}.yml`;
const proc = Bun.spawn(
  [
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    `:(glob,exclude)${directory}/**`,
    ":(exclude)docs/**",
    ":(exclude)tests/backend/sidebar_script.test.ts",
    ":(exclude)tests/mobile_browser/test_sidebar.ts",
    ":(exclude)README.md",
    ":(exclude)web/dist/**",
    optionalWorkflow,
  ],
  { stdout: "pipe" },
);
const files = (await new Response(proc.stdout).text())
  .split("\0")
  .filter(Boolean);
if ((await proc.exited) !== 0) throw new Error("git ls-files failed");
let failures = 0;
for (const file of files) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) continue;
  const lines = (
    stat.isSymbolicLink() ? await readlink(file) : await readFile(file, "utf8")
  ).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!forbidden.test(lines[i]!)) continue;
    console.error(`${file}:${i + 1}: core must not reference ${directory}/`);
    failures++;
  }
}
if (failures) process.exit(1);
console.log(`core boundary check: ${files.length} files`);
