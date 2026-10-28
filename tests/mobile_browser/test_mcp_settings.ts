import { expect } from "bun:test";
import { join } from "node:path";
import {
  captureErrors,
  gotoRoot,
  runBrowserTests,
  type BrowserTest,
} from "./common";
import { startOAuthMcpServer } from "../backend/fixtures/mcp_oauth_server";

export const tests: BrowserTest[] = [
  async function test_real_mcp_checks_show_safe_status_without_a_conversation(
    browser,
    base,
  ) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const errors = captureErrors(page);
    const oauth = startOAuthMcpServer();
    const probe = join(
      import.meta.dir,
      "../backend/fixtures/mcp_probe_server.mjs",
    );
    const config = {
      mcpServers: {
        healthy: {
          command: process.execPath,
          args: [probe, "--stubborn", "--spawn-child"],
        },
        broken_stdio: {
          command: process.execPath,
          args: [probe, "--exit-17"],
          env: { TOKEN: "private-mcp-browser-token" },
        },
        closed_http: { url: "http://127.0.0.1:0/mcp?token=private-url-token" },
        disabled: { command: "unused", enabled: false },
        unused: { command: process.execPath, args: [probe] },
        tracker: { url: oauth.url },
      },
    };
    try {
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      const agents = await page.locator(".agent").count();
      await page.locator("#settings-btn").click();
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      const section = page.locator(".settings-section").filter({
        has: page.getByRole("heading", { name: "MCP servers", exact: true }),
      });
      const callback = page.getByRole("textbox", {
        name: "OAuth callback URL",
      });
      expect(await callback.inputValue()).toBe(
        new URL("/api/settings/mcp-servers/oauth-callback", base).href,
      );
      expect(await callback.getAttribute("readonly")).not.toBeNull();
      await section
        .getByRole("button", { name: "Copy callback URL", exact: true })
        .waitFor();
      const input = page.getByRole("textbox", { name: "MCP servers JSON" });
      await page.waitForFunction(
        () =>
          !(globalThis as any).document
            .querySelector('textarea[aria-label="MCP servers JSON"]')
            .closest("form")
            .querySelector("button").disabled,
      );
      await input.fill(JSON.stringify(config, null, 2));
      await section.getByRole("button", { name: "Save", exact: true }).click();
      await section.locator(".msg.ok").waitFor();
      const row = (name: string) =>
        page
          .locator(".mcp-server")
          .filter({ has: page.getByText(name, { exact: true }) });
      await row("unused").getByText("Not used", { exact: true }).waitFor();
      expect(
        await row("disabled")
          .getByRole("button", { name: "Check disabled", exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(await row("unused").innerText()).toContain("Never checked");
      await row("healthy")
        .getByRole("button", { name: "Check healthy", exact: true })
        .click();
      await row("healthy")
        .getByText("Checking…", { exact: true })
        .first()
        .waitFor();
      await row("healthy").getByText("Connected", { exact: true }).waitFor();
      expect(await row("healthy").innerText()).toContain("5 tools");
      for (const name of ["broken_stdio", "closed_http"]) {
        await row(name)
          .getByRole("button", { name: `Check ${name}`, exact: true })
          .click();
        await row(name).getByText("Failed", { exact: true }).waitFor();
      }
      expect(await row("broken_stdio").innerText()).toContain(
        "exited with code 17",
      );
      expect(await row("closed_http").innerText()).toContain(
        "connection refused",
      );
      expect(await row("closed_http").innerText()).not.toContain("Retry");
      await row("tracker")
        .getByRole("button", { name: "Check tracker", exact: true })
        .click();
      await row("tracker")
        .getByText("Needs sign-in", { exact: true })
        .waitFor();
      await Promise.all([
        page.waitForURL((url) => url.href === new URL("/", base).href),
        row("tracker")
          .getByRole("button", { name: "Sign in to tracker", exact: true })
          .click(),
      ]);
      expect(oauth.grants).toEqual(["authorization_code"]);
      await page.locator(".agent").first().waitFor();
      await page.locator("#settings-btn").click();
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      await row("tracker").getByText("Connected", { exact: true }).waitFor();
      expect(await row("tracker").innerText()).toContain("1 tools");
      await row("tracker")
        .getByRole("button", { name: "Sign out of tracker", exact: true })
        .click();
      await row("tracker")
        .getByText("Needs sign-in", { exact: true })
        .waitFor();
      expect(oauth.revoked).toHaveLength(1);
      expect(await row("healthy").innerText()).toContain("Last checked:");
      const status = page.locator(".mcp-status");
      expect(await status.innerText()).not.toContain(
        "private-mcp-browser-token",
      );
      expect(await status.innerText()).not.toContain("secret-looking-stderr");
      expect(await status.innerText()).not.toContain("http://");
      expect(await status.innerText()).not.toContain("private-url-token");
      expect(await status.innerText()).not.toContain(process.execPath);
      expect(
        await section
          .locator(".hint")
          .evaluate((el) => (globalThis as any).getComputedStyle(el).color),
      ).toBe(
        await row("healthy")
          .locator("strong")
          .evaluate((el) => (globalThis as any).getComputedStyle(el).color),
      );
      await page.setViewportSize({ width: 412, height: 915 });
      await row("healthy").scrollIntoViewIfNeeded();
      const box = await row("healthy").boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(412);
      await row("healthy")
        .getByRole("button", { name: "Check healthy", exact: true })
        .click();
      await page.locator("#settings-close").click();
      await page.waitForFunction(async () => {
        const response = await fetch("/api/settings/mcp-servers/status");
        const result = (await response.json()) as {
          servers: { checking?: boolean }[];
        };
        return !result.servers.some(
          (server: { checking?: boolean }) => server.checking,
        );
      });
      expect(await page.locator(".agent").count()).toBe(agents);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await oauth.stop();
    }
  },
  // Feature: #2839 plain-http tailnet pages sign in by pasting the loopback address.
  async function test_mcp_sign_in_by_pasting_the_loopback_address(
    browser,
    base,
  ) {
    const port = new URL(base).port;
    const remote = `http://recurse.tailnet.example:${port}/`;
    const oauth = startOAuthMcpServer();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      proxy: { server: `http://127.0.0.1:${port}` },
    });
    await context.route(`${oauth.origin}/**`, async (route) => {
      const answer = await fetch(route.request().url(), { redirect: "manual" });
      await route.fulfill({
        status: answer.status,
        headers: Object.fromEntries(answer.headers),
        body: await answer.text(),
      });
    });
    await context.route("http://127.0.0.1/mcp-oauth-callback**", (route) =>
      route.fulfill({ status: 404, body: "unreachable" }),
    );
    const page = await context.newPage();
    const errors = captureErrors(page);
    try {
      const configured = await fetch(`${base}api/settings/mcp-servers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: JSON.stringify({ mcpServers: { paste: { url: oauth.url } } }),
        }),
      });
      expect(configured.status).toBe(200);
      await gotoRoot(page, remote);
      await page.locator(".agent").first().waitFor();
      expect(
        await page.evaluate(
          () => (globalThis as any).matchMedia("(pointer: coarse)").matches,
        ),
      ).toBe(true);
      await page.locator("#menu-btn").tap();
      await page.locator("#settings-btn").tap();
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      expect(
        await page
          .getByRole("textbox", { name: "OAuth callback URL" })
          .inputValue(),
      ).toBe("http://127.0.0.1/mcp-oauth-callback");
      const row = page
        .locator(".mcp-server")
        .filter({ has: page.getByText("paste", { exact: true }) });
      const needsSignIn = row.getByText("Needs sign-in", { exact: true });
      for (let tries = 0; !(await needsSignIn.isVisible()); tries++) {
        expect(tries).toBeLessThan(50);
        const check = row.getByRole("button", {
          name: "Check paste",
          exact: true,
        });
        if (await check.isEnabled()) await check.click();
        await Bun.sleep(200);
      }
      await row
        .getByRole("button", { name: "Sign in to paste", exact: true })
        .click();
      const open = page.getByRole("link", { name: "Open paste sign-in" });
      const answer = page.getByRole("textbox", {
        name: "Address after signing in to paste",
      });
      const finish = page.getByRole("button", { name: "Finish sign-in" });
      for (const control of [open, answer, finish]) {
        await control.waitFor();
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(
          44,
        );
      }
      const [provider] = await Promise.all([
        context.waitForEvent("page"),
        open.tap(),
      ]);
      await provider.waitForURL(/^http:\/\/127\.0\.0\.1\/mcp-oauth-callback\?/);
      await answer.fill(
        `http://127.0.0.1/somewhere-else${new URL(provider.url()).search}`,
      );
      await finish.tap();
      await page
        .getByText("Paste the full address", { exact: false })
        .waitFor();
      await answer.fill(provider.url());
      await finish.tap();
      await row.getByText("Connected", { exact: true }).waitFor();
      expect(oauth.grants).toEqual(["authorization_code"]);
      expect(await answer.count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await oauth.stop();
    }
  },
];

if (import.meta.main) await runBrowserTests([["mcp-settings", tests]]);
