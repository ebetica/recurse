import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrowserTests, type BrowserTest } from "./common";

const probe: BrowserTest = async (browser, base, _data, serverPid) => {
  const page = await browser.newPage();
  await page.goto(base);
  const response = await page.request.post(`${base}__browser-test/server-log`);
  if (!response.ok()) throw Error("server log probe failed");
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const chrome = processInfo.find((entry) => entry.type === "browser")!.id;
  const directory = (await readdir(tmpdir())).find((name) =>
    name.startsWith("recurse-browser-log-"),
  )!;
  await Bun.write(
    join(tmpdir(), "probe.json"),
    JSON.stringify({
      server: serverPid,
      chrome,
      log: join(tmpdir(), directory, "logging.log"),
    }),
  );
  if (process.argv[2] === "fail") {
    let intercepted!: () => void;
    const held = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route(`${base}held-cleanup`, intercepted);
    await page.evaluate(() => {
      void fetch("held-cleanup").catch(() => {});
    });
    await held;
    throw Error("deliberate logging failure with held route");
  }
};
if (!["pass", "fail"].includes(process.argv[2] ?? ""))
  throw Error("Use pass or fail");
const afterCleanup: BrowserTest = async (browser, base) => {
  const page = await browser.newPage();
  await page.goto(base);
};
await runBrowserTests([["logging", [probe, afterCleanup]]]);
