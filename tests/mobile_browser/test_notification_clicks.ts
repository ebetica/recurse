import { expect } from "bun:test";
import type { Subprocess } from "bun";
import {
  chromium,
  expect as browserExpect,
  type BrowserContext,
} from "playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retire } from "../../src/utils/trash";
import { LOGIN, startServer, stopServer, type BrowserTest } from "./common";

async function nativeNotifications() {
  for (const command of ["Xvfb", "dbus-daemon", "dunst", "dunstctl"])
    if (!Bun.which(command))
      throw new Error(
        `Notification click tests require ${command} (Linux desktop notification tools).`,
      );
  const profile = await mkdtemp(join(tmpdir(), "recurse-notifications-"));
  const processes: Subprocess[] = [];
  let context: BrowserContext | undefined;
  const close = async () => {
    try {
      await context?.close();
    } finally {
      for (const child of processes.reverse()) {
        child.kill();
        await child.exited;
      }
      retire(profile, join(tmpdir(), ".trash"));
    }
  };
  const launch = (cmd: string[], env = process.env) => {
    const child = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "inherit" });
    processes.push(child);
    return child;
  };
  const line = async (child: ReturnType<typeof launch>) => {
    const reader = child.stdout.getReader();
    let text = "";
    try {
      while (!text.includes("\n")) {
        const part = await reader.read();
        if (part.done)
          throw new Error(
            `Desktop process exited before startup: ${child.pid}`,
          );
        text += new TextDecoder().decode(part.value);
      }
      return text.split("\n")[0]!;
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const display = await line(
      launch([
        "Xvfb",
        "-displayfd",
        "1",
        "-screen",
        "0",
        "1280x900x24",
        "-nolisten",
        "tcp",
      ]),
    );
    const address = await line(
      launch(["dbus-daemon", "--session", "--nofork", "--print-address=1"]),
    );
    const env = {
      ...process.env,
      DISPLAY: `:${display}`,
      DBUS_SESSION_BUS_ADDRESS: address,
    };
    launch(["dunst"], env);
    const control = async (...args: string[]) => {
      const child = Bun.spawn(["dunstctl", ...args], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      if (await child.exited)
        throw new Error(`dunstctl ${args.join(" ")}: ${error}`);
      return output.trim();
    };
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: false,
      permissions: ["notifications"],
      env,
    });
    return {
      context,
      click: async () => {
        await browserExpect.poll(() => control("count", "displayed")).toBe("1");
        await control("action");
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export const tests: BrowserTest[] = [
  // Regression: #3152 ignore non-app windows when opening notifications.
  async function test_notification_clicks_open_conversations(_browser, _base) {
    const server = await startServer({ auth: true });
    let desktop: Awaited<ReturnType<typeof nativeNotifications>> | undefined;
    try {
      desktop = await nativeNotifications();
      const { context, click } = desktop;
      const page = context.pages()[0]!;
      await page.goto(server.base);
      await page.locator('input[name="password"]').fill(LOGIN);
      await page.locator("form button").click();
      await page.locator("#input").waitFor();
      const created = await context.request.post(
        `${server.base}api/conversations`,
        { data: {} },
      );
      expect(created.ok()).toBeTrue();
      const cid = (await created.json()).id as string;
      await page.goto(`${server.base}#agent=${cid}`);
      await page
        .locator("#input")
        .fill("Reply only Notification conversation ready");
      await page.locator("#send").click();
      await page
        .getByText("Notification conversation ready", { exact: true })
        .waitFor();
      await page.evaluate(async () => {
        const nav = (globalThis as any).navigator;
        await nav.serviceWorker.register("/push-worker.js", { scope: "/" });
        await nav.serviceWorker.ready;
      });
      const worker = context
        .serviceWorkers()
        .find((entry) => entry.url().endsWith("/push-worker.js"))!;
      const show = () =>
        worker.evaluate(async (cid) => {
          await (globalThis as any).registration.showNotification(
            "Agent finished",
            {
              tag: `agent-${cid}`,
              data: { cid },
            },
          );
        }, cid);
      expect(
        await page.evaluate(
          () => (globalThis as any).navigator.serviceWorker.controller,
        ),
      ).toBeNull();
      const keepAlive = await context.newPage();
      const unrelatedEvent = page.waitForEvent("popup");
      await page.evaluate(() =>
        (globalThis as any).open(
          "/api/status",
          "_blank",
          "width=640,height=480",
        ),
      );
      const otherWindow = await unrelatedEvent;
      await otherWindow.waitForURL(`${server.base}api/status`);
      await otherWindow.bringToFront();
      await show();
      await click();
      await browserExpect
        .poll(() =>
          page.evaluate(() => (globalThis as any).document.hasFocus()),
        )
        .toBe(true);
      expect(context.pages()).toHaveLength(3);
      await page.close();
      await show();
      const openedEvent = context.waitForEvent("page");
      await click();
      const opened = await openedEvent;
      await browserExpect(opened).toHaveURL(`${server.base}#agent=${cid}`);
      await opened
        .getByText("Notification conversation ready", { exact: true })
        .waitFor();
      expect(
        await opened.evaluate(() => (globalThis as any).opener),
      ).toBeNull();
      await browserExpect
        .poll(() =>
          opened.evaluate(() => (globalThis as any).document.hasFocus()),
        )
        .toBe(true);
      expect(otherWindow.url()).toBe(`${server.base}api/status`);
      await otherWindow.close();
      await opened.locator("#input").fill("Keep my unsent draft");
      const popupEvent = opened.waitForEvent("popup");
      await opened.evaluate(() =>
        (globalThis as any).open("/", "_blank", "width=960,height=720"),
      );
      const secondWindow = await popupEvent;
      const otherCreated = await context.request.post(
        `${server.base}api/conversations`,
        { data: {} },
      );
      const otherCid = (await otherCreated.json()).id as string;
      await secondWindow.goto(`${server.base}#agent=${otherCid}`);
      await secondWindow.locator("#input").waitFor();
      await secondWindow.bringToFront();
      await show();
      await click();
      await browserExpect(opened.locator("#input")).toHaveValue(
        "Keep my unsent draft",
      );
      await browserExpect
        .poll(() =>
          opened.evaluate(() => (globalThis as any).document.hasFocus()),
        )
        .toBe(true);
      expect(context.pages()).toHaveLength(3);
      await secondWindow.close();
      await opened.goto(`${server.base}#agent=${otherCid}`);
      await opened.locator("#input").waitFor();
      await show();
      await click();
      await browserExpect(opened).toHaveURL(`${server.base}#agent=${cid}`);
      await opened
        .getByText("Notification conversation ready", { exact: true })
        .waitFor();
      await browserExpect(opened.locator("#input")).toHaveValue(
        "Keep my unsent draft",
      );
      await opened.close();
      await show();
      const coldEvent = context.waitForEvent("page");
      await click();
      const cold = await coldEvent;
      await browserExpect(cold).toHaveURL(`${server.base}#agent=${cid}`);
      await cold
        .getByText("Notification conversation ready", { exact: true })
        .waitFor();
      await browserExpect
        .poll(() =>
          cold.evaluate(() => (globalThis as any).document.hasFocus()),
        )
        .toBe(true);
      await keepAlive.close();
    } finally {
      try {
        await desktop?.close();
      } finally {
        await stopServer(server);
      }
    }
  },
];
