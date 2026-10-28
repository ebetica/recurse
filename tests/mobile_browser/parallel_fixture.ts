import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserTest } from "./common";
import { browserArguments, runBrowserGroups } from "./parallel";

const test_pass: BrowserTest = async (browser, base) => {
  const page = await browser.newPage();
  await page.goto(base);
};
const test_failure: BrowserTest = async (...args) => {
  await test_pass(...args);
  throw Error("deliberate browser-worker failure");
};
const test_hold: BrowserTest = async (browser, base, _data, serverPid) => {
  const page = await browser.newPage();
  await page.goto(base);
  const closed = page.waitForEvent("close");
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const chrome = processInfo.find((entry) => entry.type === "browser")!.id;
  const file = join(process.env.BROWSER_PROBE_DIR!, `${process.pid}.json`);
  await Bun.write(
    `${file}.tmp`,
    JSON.stringify({ worker: process.pid, server: serverPid, chrome }),
  );
  await rename(`${file}.tmp`, file);
  if (process.env.BROWSER_PROBE_BLOCK)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  await closed;
};
const groups: Array<[string, BrowserTest[]]> = [
  ["pass", [test_pass]],
  ["fail", [test_failure]],
  ["hold-a", [test_hold]],
  ["hold-b", [test_hold]],
];
const { workers, names } = browserArguments(process.argv.slice(2));
console.log(`Browser worker cap: ${workers}`);
await runBrowserGroups(
  groups.filter(([name]) => names.includes(name)),
  workers,
  import.meta.filename,
  undefined,
  process.env.BROWSER_PROBE_IDLE_MS
    ? Number(process.env.BROWSER_PROBE_IDLE_MS)
    : undefined,
);
