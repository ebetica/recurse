import {
  chromium,
  expect as browserExpect,
  type Browser,
} from "playwright/test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { retire } from "../../src/utils/trash";

export async function standalonePhone(base: string) {
  const scratch = await mkdtemp(join(tmpdir(), "recurse-standalone-"));
  const processes: Subprocess[] = [];
  let browser: Browser | undefined;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      for (const child of processes.reverse()) {
        child.kill();
        await child.exited;
      }
      retire(scratch, join(tmpdir(), ".trash"));
    }
  };
  try {
    await mkdir(join(scratch, "home"));
    const display = Bun.spawn(
      [
        "Xvfb",
        "-displayfd",
        "1",
        "-screen",
        "0",
        "1280x1100x24",
        "-nolisten",
        "tcp",
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    processes.push(display);
    const reader = display.stdout.getReader();
    let output = "";
    try {
      while (!output.includes("\n")) {
        const part = await reader.read();
        if (part.done)
          throw new Error("Standalone display exited before startup");
        output += new TextDecoder().decode(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const probe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const port = probe.port;
    await probe.stop(true);
    if (!port || port === 8000)
      throw new Error("Standalone browser needs a private port");
    const chrome = Bun.spawn(
      [
        chromium.executablePath(),
        "--no-sandbox",
        "--disable-dev-shm-usage",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${join(scratch, "profile")}`,
        `--app=${base}`,
      ],
      {
        stdout: "ignore",
        stderr: "inherit",
        env: {
          PATH: process.env.PATH,
          DISPLAY: `:${output.split("\n")[0]}`,
          HOME: join(scratch, "home"),
          XDG_DATA_HOME: join(scratch, "data"),
          XDG_CONFIG_HOME: join(scratch, "config"),
          XDG_CACHE_HOME: join(scratch, "cache"),
        },
      },
    );
    processes.push(chrome);
    const endpoint = `http://127.0.0.1:${port}`;
    await browserExpect
      .poll(async () => {
        if (chrome.exitCode !== null)
          throw new Error("Standalone Chromium exited before startup");
        return fetch(`${endpoint}/json/version`).then(
          (response) => response.ok,
          () => false,
        );
      })
      .toBe(true);
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
    const context = browser.contexts()[0]!;
    await browserExpect.poll(() => context.pages().length).toBeGreaterThan(0);
    const page = context.pages()[0]!;
    const session = await context.newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 412,
      height: 915,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 412,
      screenHeight: 915,
    });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    return { context, page, session, close };
  } catch (error) {
    await close();
    throw error;
  }
}
