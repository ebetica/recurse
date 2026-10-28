import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { themePalettes } from "../../src/themes";
import {
  LOGIN,
  startServer,
  stopServer,
  runBrowserTests,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Feature: #2704 Operator-confirmed settings sync uses real remote validation, preserves secrets, and refuses stale preview values.
  async function test_settings_sync(browser, base) {
    const remote = await startServer({ auth: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const peer = await browser.newContext();
    const page = await context.newPage();
    try {
      const login = await peer.request.post(remote.base + "login", {
        form: { password: LOGIN },
        maxRedirects: 0,
      });
      expect(login.status()).toBe(303);
      await peer.addCookies([
        {
          name: "chat_auth",
          value: login
            .headers()
            ["set-cookie"]!.split(";")[0]!
            .slice("chat_auth=".length),
          url: remote.base,
        },
      ]);
      const get = async (path: string, other = false) => {
        const response = await (other ? peer : context).request.get(
          (other ? remote.base : base) + path,
        );
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const post = async (path: string, data: unknown, other = false) => {
        const response = await (other ? peer : context).request.post(
          (other ? remote.base : base) + path,
          { data },
        );
        expect(response.ok()).toBe(true);
        return response.json();
      };
      await post(
        "api/pi/codex-auth/api-key",
        { key: "browser-test-remote-credential" },
        true,
      );
      const credentialPath = join(
        remote.data,
        "settings",
        "pi-agent",
        "auth.json",
      );
      const credentials = await readFile(credentialPath, "utf8");
      const mcp = {
        text: JSON.stringify({
          mcpServers: {
            preserved: {
              command: "echo",
              args: ["<img src=x onerror=alert(1)>"],
              env: { PRIVATE: "keep-on-remote" },
            },
          },
        }),
      };
      const mcpResponse = await peer.request.put(
        remote.base + "api/settings/mcp-servers",
        { data: mcp },
      );
      expect(mcpResponse.ok()).toBe(true);
      const beforeMcp = await get("api/settings/mcp-servers", true);
      const beforeVersion = await get("api/version", true);
      expect(typeof beforeVersion.display_name).toBe("string");
      const remoteLadder = await get("api/settings/effort-levels", true);
      const hiddenModel = (await get("api/settings/effort-levels")).levels["1"]
        .model;
      await post(
        "api/settings/default-efforts",
        { efforts: { [hiddenModel]: "off" } },
        true,
      );
      expect(
        (await get("api/settings/default-efforts", true)).models.some(
          (model: any) => model.id === hiddenModel,
        ),
      ).toBe(false);
      remoteLadder.levels["1"].reasoning =
        remoteLadder.levels["1"].reasoning === "off" ? "high" : "off";
      await post("api/settings/effort-levels", remoteLadder, true);
      const homeTheme = await get("api/settings/theme");
      const otherTheme = homeTheme.themes.find(
        (theme: { name: string }) => theme.name !== homeTheme.theme,
      );
      const hostile = '<img src=x onerror="window.syncExecuted=true">';
      await post(
        "api/settings/theme",
        {
          theme: otherTheme.name,
          custom: [{ ...themePalettes[0], name: hostile }],
        },
        true,
      );
      const homeMaximum = await get("api/settings/maximum-context-window");
      await post(
        "api/settings/maximum-context-window",
        { maximum_context_window: 100000 },
        true,
      );
      await page.goto(base);
      await page.locator("#settings-btn").click();
      await page.locator('#settings-nav button[data-cat="account"]').click();
      const section = page.locator(".settings-section").filter({
        has: page.getByRole("heading", {
          name: "Remotes",
          exact: true,
        }),
      });
      await section
        .getByRole("button", { name: "Add a remote", exact: true })
        .click();
      await section.locator('input[name="label"]').fill("SyncPeer");
      await section.locator('input[name="url"]').fill(remote.base);
      await section.locator('input[name="password"]').fill(LOGIN);
      await section
        .getByRole("button", { name: "Connect remote", exact: true })
        .click();
      await section
        .getByRole("button", { name: "Sync settings from home", exact: true })
        .click();
      const previewRows = section.locator("li");
      await browserExpect(
        previewRows.filter({ hasText: " · change" }).first(),
      ).toContainText(" → ");
      await browserExpect(
        previewRows.filter({ hasText: " · same" }).first(),
      ).toBeVisible();
      await browserExpect(
        previewRows.filter({ hasText: " · unusable" }).first(),
      ).toContainText("not available on SyncPeer");
      await browserExpect(
        previewRows.filter({ hasText: "MCP servers" }),
      ).toContainText("not synced");
      await browserExpect(
        previewRows.filter({ hasText: "Theme:" }),
      ).toContainText(JSON.stringify(hostile));
      await browserExpect(
        previewRows.filter({ hasText: "Default efforts:" }),
      ).toContainText(hiddenModel);
      await post(
        "api/settings/default-efforts",
        { efforts: { [hiddenModel]: "high" } },
        true,
      );
      expect(await section.locator("li img").count()).toBe(0);
      expect(
        await page.evaluate(() => (globalThis as any).syncExecuted),
      ).toBeUndefined();
      await post(
        "api/settings/maximum-context-window",
        { maximum_context_window: 200000 },
        true,
      );
      await section
        .getByRole("button", {
          name: "Apply settings to SyncPeer",
          exact: true,
        })
        .click();
      await browserExpect(
        previewRows.filter({ hasText: "Maximum context window" }),
      ).toHaveText(
        "Maximum context window: refused: changed on SyncPeer since preview",
      );
      await browserExpect(
        previewRows.filter({ hasText: "Theme: applied" }),
      ).toBeVisible();
      await browserExpect(
        previewRows.filter({ hasText: "Default effort level: unchanged" }),
      ).toBeVisible();
      const remoteTheme = await get("api/settings/theme", true);
      expect(remoteTheme.theme).toBe(homeTheme.theme);
      expect((await get("api/settings/effort-levels", true)).levels).toEqual(
        remoteLadder.levels,
      );
      await browserExpect(
        previewRows.filter({ hasText: "Default efforts:" }),
      ).toHaveText(
        "Default efforts: refused: changed on SyncPeer since preview",
      );
      expect((await get("api/settings/default-efforts", true)).efforts).toEqual(
        { [hiddenModel]: "high" },
      );
      expect(
        (await get("api/settings/maximum-context-window", true))
          .maximum_context_window,
      ).toBe(200000);
      await section
        .getByRole("button", { name: "Sync settings from home", exact: true })
        .click();
      await section
        .getByRole("button", {
          name: "Apply settings to SyncPeer",
          exact: true,
        })
        .click();
      await browserExpect(
        previewRows.filter({ hasText: "Maximum context window: applied" }),
      ).toBeVisible();
      expect(await get("api/settings/maximum-context-window", true)).toEqual(
        homeMaximum,
      );
      await browserExpect(
        previewRows.filter({ hasText: "Default efforts: applied" }),
      ).toBeVisible();
      expect((await get("api/settings/default-efforts", true)).efforts).toEqual(
        {},
      );
      expect(await get("api/settings/mcp-servers", true)).toEqual(beforeMcp);
      expect((await get("api/version", true)).display_name).toBe(
        beforeVersion.display_name,
      );
      expect(await readFile(credentialPath, "utf8")).toBe(credentials);
      const invalid = await context.request.post(
        base + "api/backends/SyncPeer/settings-sync",
        { data: { preview: "tampered", signature: "0".repeat(64) } },
      );
      expect(invalid.status()).toBe(400);
      await context.request.delete(base + "api/backends/SyncPeer");
    } finally {
      await context.close();
      await peer.close();
      await stopServer(remote);
    }
  },
];
if (import.meta.main) await runBrowserTests([["settings-sync", tests]]);
