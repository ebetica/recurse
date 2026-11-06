#!/usr/bin/env bun
// Platform reminders reach models only through src/reminder_text.ts, where each
// kind has a spacing policy; fixed advice stays one short sentence.
import { readFile } from "node:fs/promises";
import { ADVICE_MAX_CHARS, REMINDERS } from "../../src/reminder_text.ts";

const OWNER = "src/reminder_text.ts";
const MARKER = /system[_-]reminder/i;
const proc = Bun.spawn(["git", "ls-files", "-z", "--", "src", "tools"], {
  stdout: "pipe",
});
const files = (await new Response(proc.stdout).text())
  .split("\0")
  .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && file !== OWNER);
if ((await proc.exited) !== 0) throw new Error("git ls-files failed");
let failures = 0;
for (const file of files) {
  const text = await readFile(file, "utf8").catch(() => "");
  text.split("\n").forEach((line, i) => {
    if (!MARKER.test(line)) return;
    console.error(
      `${file}:${i + 1}: write reminders with notice() or ReminderSpacing from ${OWNER}`,
    );
    failures++;
  });
}
for (const [kind, entry] of Object.entries(REMINDERS)) {
  if (entry.policy !== "advice" || entry.text.length <= ADVICE_MAX_CHARS)
    continue;
  console.error(
    `${OWNER}: ${kind} advice is ${entry.text.length} characters (limit ${ADVICE_MAX_CHARS})`,
  );
  failures++;
}
if (failures) process.exit(1);
console.log(`reminder check: ${files.length} files`);
