import { expect } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LOGIN,
  rootAgentId,
  runBrowserTests,
  startServer,
  stopServer,
  type BrowserTest,
  openSettingsPanel,
} from "./common";

export const tests: BrowserTest[] = [
  // Feature: #2769 Signed-in remotes retain agents and credentials through offline periods. (also #2814 A hung remote read held back home tree updates, and removing a remote left its read running.; #2819 A remote tree read dropped a pending rename of a remote agent.; #3000 Revoked sign-in remains visible in Settings; #3034 Legacy remote fixtures omit API headers and newer fixtures advertise consistent versions.)
  async function test_remotes(browser, base, data) {
    const remote = await startServer({ auth: true });
    type Held = {
      kind: "tree" | "conversation" | "rename";
      state: "pending" | "answered" | "aborted";
      release: () => void;
    };
    const held: Held[] = [];
    const holding = new Set<Held["kind"]>();
    const release = (kind: Held["kind"]) => {
      holding.delete(kind);
      for (const entry of held) if (entry.kind === kind) entry.release();
    };
    let treeReads = 0;
    let remoteRequests = 0;
    let explorerRequests = 0;
    let flaky = false;
    let versionOverride: "older" | "incompatible" | null = null;
    let directMismatch = false;
    let revoked = false;
    const serve = (port: number) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        async fetch(request) {
          remoteRequests++;
          const url = new URL(request.url);
          if (/\/conversations\/[^/]+\/tree(?:\/|$)/.test(url.pathname))
            explorerRequests++;
          if (revoked && request.headers.has("authorization"))
            return new Response("sign-in required", { status: 401 });
          const kind =
            request.method !== "GET"
              ? url.pathname.endsWith("/rename")
                ? "rename"
                : null
              : url.pathname === "/api/tree"
                ? "tree"
                : /^\/api\/conversations\/[^/]+$/.test(url.pathname)
                  ? "conversation"
                  : null;
          if (kind && holding.has(kind)) {
            const entry: Held = { kind, state: "pending", release: () => {} };
            held.push(entry);
            await new Promise<void>((resolve) => {
              entry.release = resolve;
              request.signal.addEventListener(
                "abort",
                () => {
                  entry.state = "aborted";
                  resolve();
                },
                { once: true },
              );
            });
            if (entry.state === "aborted")
              return new Response(null, { status: 503 });
            entry.state = "answered";
          }
          if (kind === "tree" && flaky && ++treeReads % 2)
            return new Response("flaky", { status: 502 });
          if (kind === "tree" && !flaky) treeReads++;
          const mismatch =
            directMismatch &&
            request.headers.get("accept-encoding") === "identity";
          const headers = new Headers(request.headers);
          if (url.pathname === "/api/version" && (versionOverride || mismatch))
            headers.delete("if-none-match");
          const response = await fetch(
            remote.base + url.pathname.slice(1) + url.search,
            {
              method: request.method,
              headers,
              body: request.body,
              signal: request.signal,
              redirect: "manual",
            },
          );
          if (versionOverride === "older")
            response.headers.delete("x-recurse-api");
          else if (versionOverride === "incompatible" || mismatch) {
            const advertised = response.headers.get("x-recurse-api");
            if (advertised) {
              const [major, revision] = advertised.split(".");
              response.headers.set(
                "x-recurse-api",
                `${Number(major) + 1}.${revision}`,
              );
            }
          }
          if (
            url.pathname === "/api/version" &&
            (versionOverride || mismatch) &&
            response.ok
          ) {
            const version = (await response.json()) as {
              api: number;
              api_revision?: number;
            };
            if (versionOverride === "older") delete version.api_revision;
            else version.api++;
            return Response.json(version);
          }
          return response;
        },
      });
    let endpoint = serve(0);
    const port = endpoint.port!;
    const context = await browser.newContext({
      viewport: { width: 412, height: 900 },
    });
    const page = await context.newPage();
    try {
      const token = JSON.parse(
        await readFile(join(data, "data", "server.json"), "utf8"),
      ).token;
      const requested = await context.request.post(base + "api/backends", {
        headers: {
          "x-loopback-token": token,
          "x-recurse-agent": rootAgentId(),
          "x-recurse-bundled-tool": "subagent",
        },
        data: { label: "Requested", url: `http://127.0.0.1:${port}` },
      });
      expect(requested.ok()).toBe(true);
      await page.goto(base);
      await page.locator(".agent").first().waitFor();
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="account"]').click();
      const section = page.locator(".remotes-settings");
      await browserExpect(
        page.getByRole("heading", { name: "Connected homes", exact: true }),
      ).toHaveCount(0);
      await browserExpect(
        section.getByRole("heading", {
          name: "Homes with access to this instance",
        }),
      ).toBeVisible();
      await browserExpect(
        section.getByText("No homes have access."),
      ).toBeVisible();
      await browserExpect(section.locator('input[name="url"]')).toBeHidden();
      await section.getByRole("button", { name: /^Requested/ }).click();
      const requestedDetails = page.getByRole("dialog", {
        name: "Requested",
        exact: true,
      });
      const password = requestedDetails.getByLabel("Password for Requested");
      await browserExpect(password).toHaveAttribute("type", "password");
      await browserExpect(password).toHaveAttribute(
        "autocomplete",
        "current-password",
      );
      for (const attribute of [
        "data-1p-ignore",
        "data-lpignore",
        "data-bwignore",
      ]) {
        await browserExpect(password).toHaveAttribute(attribute, "true");
      }
      await requestedDetails
        .getByRole("button", { name: "Close Requested", exact: true })
        .click();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width <= 700)
          await section
            .getByRole("button", { name: "Add a remote", exact: true })
            .click();
        const addDetails = page.getByRole("region", {
          name: "Add a remote",
          exact: true,
        });
        const addPassword = addDetails.getByLabel(
          "Password for that Recurse instance",
        );
        await browserExpect(addPassword).toHaveAttribute("type", "password");
        await browserExpect(addPassword).toHaveAttribute(
          "autocomplete",
          "current-password",
        );
        for (const attribute of [
          "data-1p-ignore",
          "data-lpignore",
          "data-bwignore",
        ]) {
          await browserExpect(addPassword).toHaveAttribute(attribute, "true");
        }
        await browserExpect(addDetails.getByLabel("Remote name")).toBeVisible();
        await browserExpect(
          addDetails.getByLabel("Remote address"),
        ).toBeVisible();
        await browserExpect(
          addDetails.getByRole("button", {
            name: "Connect remote",
            exact: true,
          }),
        ).toBeVisible();
        if (width <= 700) {
          await page
            .getByRole("button", { name: "Close Add a remote", exact: true })
            .click();
          await browserExpect(addDetails).not.toBeVisible();
        }
      }
      await section.getByRole("button", { name: /^Requested/ }).click();
      await password.fill(LOGIN);
      await requestedDetails
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await browserExpect(requestedDetails).not.toBeVisible();
      await page.setViewportSize({ width: 1280, height: 1000 });
      const layout = await section.evaluate((section) => {
        const browser = globalThis as any;
        const remote = section.querySelector(".remote-entry")!;
        const add = section
          .querySelector(".remote-add")!
          .closest(".settings-detail")!;
        const summary = add.querySelector(".settings-detail-summary")!;
        const field = add.querySelector(".item.field")!;
        const action = remote.querySelector(".remote-buttons button")!;
        const address = remote.querySelector(".remote-info")!;
        const title = remote.querySelector(
          ".settings-detail-summary .settings-row-label",
        )!;
        const left = (el: any) =>
          el.getBoundingClientRect().left +
          parseFloat(browser.getComputedStyle(el).paddingLeft);
        return {
          gap:
            add.getBoundingClientRect().top -
            remote.getBoundingClientRect().bottom,
          radius: browser.getComputedStyle(add).borderRadius,
          groupRadius: browser.getComputedStyle(remote.parentElement)
            .borderRadius,
          fieldInset: left(field) - left(summary),
          actionInset: left(action) - left(address),
          titleGap:
            address.getBoundingClientRect().top -
            title.getBoundingClientRect().bottom,
          actionGap:
            action.getBoundingClientRect().top -
            address.getBoundingClientRect().bottom,
          repeatedName: remote.querySelector(".remote-info strong") !== null,
        };
      });
      expect(layout.gap).toBe(24);
      expect(layout.radius).toBe(layout.groupRadius);
      expect(layout.fieldInset).toBe(0);
      expect(layout.actionInset).toBe(0);
      expect(layout.repeatedName).toBeFalse();
      expect(layout.titleGap).toBe(4);
      expect(layout.actionGap).toBe(8);
      await page.locator('#settings-nav button[data-cat="models"]').click();
      const ladder = page.getByRole("region", {
        name: "Effort ladder",
        exact: true,
      });
      await browserExpect(ladder.locator(".model-box-input")).toHaveCount(5);
      const ladderLayout = await ladder.evaluate((content) => {
        const heading = content.parentElement!.querySelector(
          ".settings-detail-summary .settings-row-label",
        )!;
        const update = content.querySelector(".model-list-update-button")!;
        const level = content.querySelector(
          ".effort .settings-detail-summary .settings-row-label",
        )!;
        const input = content.querySelector(".model-box-input")!;
        const row = level.parentElement!;
        return {
          left: [heading, update, level, input].map(
            (el) => el.getBoundingClientRect().left,
          ),
          rowGap:
            row.getBoundingClientRect().top -
            update.getBoundingClientRect().bottom,
          editorGap:
            input.getBoundingClientRect().top -
            row.getBoundingClientRect().bottom,
        };
      });
      expect(new Set(ladderLayout.left).size).toBe(1);
      expect(ladderLayout.rowGap).toBe(0);
      expect(ladderLayout.editorGap).toBe(0);
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      await browserExpect(
        page.getByText("No MCP servers configured.", { exact: true }),
      ).toBeVisible();
      const mcpInsets = await page
        .getByRole("region", { name: "MCP servers", exact: true })
        .evaluate((content) => {
          const title = content.parentElement!.querySelector(
            ".settings-detail-summary .settings-row-label",
          )!;
          const list = content.querySelector(".mcp-status")!;
          return [
            title.getBoundingClientRect().left,
            list.getBoundingClientRect().left +
              parseFloat(
                (globalThis as any).getComputedStyle(list).paddingLeft,
              ),
          ];
        });
      expect(mcpInsets[0]).toBe(mcpInsets[1]);
      await page.locator('#settings-nav button[data-cat="account"]').click();
      await context.request.post(remote.base + "login", {
        form: { password: LOGIN },
      });
      const incomingPage = await context.newPage();
      await incomingPage.setViewportSize({ width: 1280, height: 1000 });
      await incomingPage.goto(remote.base);
      await incomingPage.locator(".agent").first().waitFor();
      await openSettingsPanel(incomingPage);
      const incoming = incomingPage.locator(".remote-incoming .remote-entry");
      await browserExpect(incoming).toHaveCount(1);
      const incomingLayout = await incoming.evaluate((entry) => {
        const button = entry.querySelector("button.danger")!;
        const info = entry.querySelector(".remote-info")!;
        return {
          inset:
            button.getBoundingClientRect().left +
            parseFloat(
              (globalThis as any).getComputedStyle(button).paddingLeft,
            ) -
            info.getBoundingClientRect().left,
          height: button.getBoundingClientRect().height,
        };
      });
      expect(incomingLayout.inset).toBe(0);
      expect(incomingLayout.height).toBe(44);
      await incomingPage.close();
      await page.setViewportSize({ width: 390, height: 1000 });
      await section.getByRole("button", { name: /^Requested/ }).click();
      await browserExpect(
        requestedDetails.getByRole("button", {
          name: "Sync settings from home",
        }),
      ).toBeVisible();
      await requestedDetails
        .getByRole("button", { name: "Close Requested", exact: true })
        .click();
      await page.locator("#settings-close").click();
      if (!(await page.locator("#sidebar.open").count()))
        await page.locator("#menu-btn").click();
      const remoteSection = page.locator(
        '.backend-section[data-backend="Requested"]',
      );
      const agent = remoteSection.locator(".agent").first();
      await browserExpect(agent).toBeVisible();
      const id = (await agent.getAttribute("data-id"))!.split("/")[1]!;
      endpoint.stop(true);
      await remoteSection.getByText(/^Offline · last seen /).waitFor();
      await browserExpect(agent).toBeVisible();
      const relayHeaders = {
        "x-loopback-token": token,
        "x-recurse-agent": rootAgentId(),
        "x-recurse-bundled-tool": "subagent",
      };
      const sent = await context.request.post(base + "api/relay/messages", {
        headers: relayHeaders,
        data: {
          target: `${id}@Requested`,
          content: "Do not queue this offline message",
        },
      });
      expect(sent.status()).toBe(202);
      const messageUrl = `${base}api/relay/messages/${(await sent.json()).id}`;
      const outcome = async () =>
        (await (
          await context.request.get(messageUrl, { headers: relayHeaders })
        ).json()) as { state: string; reason: string };
      await browserExpect
        .poll(async () => (await outcome()).state)
        .toBe("failed");
      expect((await outcome()).reason).toContain("remote offline (last seen ");
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="account"]').click();
      await section.getByRole("button", { name: /^Requested/ }).click();
      const offline = requestedDetails.getByText(/^Offline · last seen /);
      await browserExpect(offline).toHaveText(
        /^Offline · last seen \d+ (sec|min|hr|days?) ago$/,
      );
      const backends = await (
        await context.request.get(base + "api/backends")
      ).json();
      const lastContact = backends.find(
        (row: { label: string }) => row.label === "Requested",
      ).last_contact;
      const exactTime = await page.evaluate(
        (seconds) => new Date(seconds * 1000).toLocaleString(),
        lastContact,
      );
      await browserExpect(offline).toHaveAttribute("title", exactTime);
      const sidebarOffline = remoteSection.getByText(/^Offline · last seen /);
      await browserExpect(sidebarOffline).toHaveText(
        /^Offline · last seen \d+ (sec|min|hr|days?) ago$/,
      );
      expect(await sidebarOffline.getAttribute("title")).toBeTruthy();
      await browserExpect(
        requestedDetails.getByRole("button", {
          name: "Disconnect",
          exact: true,
        }),
      ).toBeVisible();
      await browserExpect(offline).not.toHaveClass(/err/);
      endpoint = serve(port);
      await requestedDetails
        .getByRole("button", { name: "Close Requested", exact: true })
        .click();
      await page.locator("#settings-close").click();
      if (!(await page.locator("#sidebar.open").count()))
        await page.locator("#menu-btn").click();
      await remoteSection.getByText("connected", { exact: true }).waitFor();
      await browserExpect(agent).toBeVisible();
      const rows = await (
        await context.request.get(base + "api/backends")
      ).json();
      expect(
        rows.find((row: { label: string }) => row.label === "Requested")
          .has_key,
      ).toBe(true);
      await page.evaluate(() => {
        const browser = globalThis as any;
        browser.rowMutations = 0;
        new browser.MutationObserver((records: any[]) => {
          for (const record of records) {
            const element =
              record.target instanceof browser.Element
                ? record.target
                : record.target.parentElement;
            if (
              element?.closest(".backend-section .agent") &&
              !element.closest(".time")
            )
              browser.rowMutations++;
          }
        }).observe(browser.document.querySelector("#agent-list"), {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
      const unchangedFrom = treeReads;
      await browserExpect
        .poll(() => treeReads - unchangedFrom, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(3);
      flaky = true;
      const flakyFrom = treeReads;
      await remoteSection.getByText(/^Offline · last seen /).waitFor();
      await browserExpect
        .poll(() => treeReads - flakyFrom, { timeout: 30_000 })
        .toBeGreaterThanOrEqual(4);
      flaky = false;
      await remoteSection.getByText("connected", { exact: true }).waitFor();
      expect(await page.evaluate(() => (globalThis as any).rowMutations)).toBe(
        0,
      );
      await agent.click();
      await browserExpect
        .poll(() =>
          page.evaluate(() =>
            decodeURIComponent((globalThis as any).location.hash),
          ),
        )
        .toContain(`Requested/${id}`);
      await page.setViewportSize({ width: 1280, height: 900 });
      const title = remoteSection.locator(
        `.agent[data-id="Requested/${id}"] .title`,
      );
      const original = (await title.textContent())!;
      holding.add("rename");
      await page.keyboard.press("Escape");
      await page.keyboard.press("r");
      await page.locator(".rename-input").fill("Renamed while held");
      await page.locator(".rename-input").press("Enter");
      await browserExpect
        .poll(() => held.some((entry) => entry.kind === "rename"))
        .toBe(true);
      await browserExpect(title).toHaveText("Renamed while held");
      await page.evaluate(
        ([row, original]) => {
          const browser = globalThis as any;
          browser.revertedTitle = false;
          new browser.MutationObserver(() => {
            const shown = browser.document.querySelector(
              `.agent[data-id="${row}"] .title`,
            )?.textContent;
            if (shown === original) browser.revertedTitle = true;
          }).observe(browser.document.querySelector("#agent-list"), {
            subtree: true,
            childList: true,
            characterData: true,
          });
        },
        [`Requested/${id}`, original],
      );
      const remoteRows = await remoteSection.locator(".agent").count();
      expect(
        (
          await context.request.post(
            base + "api/backends/Requested/conversations",
            { data: { parent: null } },
          )
        ).ok(),
      ).toBe(true);
      await browserExpect(remoteSection.locator(".agent")).toHaveCount(
        remoteRows + 1,
      );
      release("rename");
      await browserExpect(title).toHaveText("Renamed while held");
      expect(await page.evaluate(() => (globalThis as any).revertedTitle)).toBe(
        false,
      );
      await page.setViewportSize({ width: 412, height: 900 });
      holding.add("conversation");
      await browserExpect
        .poll(() => held.some((entry) => entry.state === "pending"), {
          timeout: 10_000,
        })
        .toBe(true);
      const focusedRead = held.find((entry) => entry.kind === "conversation")!;
      const input = page.locator("#input");
      await input.fill("");
      await input.pressSequentially("typed while remote hangs");
      for (let i = 0; i < 5; i++) await input.press("ArrowLeft");
      const created = await (
        await context.request.post(base + "api/conversations", {
          data: { parent: null },
        })
      ).json();
      await page
        .locator(`#agent-list .agent[data-id="${created.id}"]`)
        .waitFor({ state: "attached" });
      expect(focusedRead.state).toBe("pending");
      expect(
        await input.evaluate((element: any) => [
          element.value,
          element.selectionStart,
          element.selectionEnd,
        ]),
      ).toEqual(["typed while remote hangs", 19, 19]);
      holding.add("tree");
      await browserExpect
        .poll(() => held.some((entry) => entry.kind === "tree"))
        .toBe(true);
      const treeRead = held.find((entry) => entry.kind === "tree")!;
      release("conversation");
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="account"]').click();
      await section.getByRole("button", { name: /^Requested/ }).click();
      await requestedDetails
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await browserExpect.poll(() => treeRead.state).toBe("aborted");
      await browserExpect(remoteSection).toHaveCount(0);
      await browserExpect(
        page.locator(`#agent-list .agent[data-id="${created.id}"]`),
      ).toBeAttached();
      release("tree");
      directMismatch = true;
      await section
        .getByRole("button", { name: "Add a remote", exact: true })
        .click();
      await section.getByLabel("Remote name").fill("Recover");
      await section
        .getByLabel("Remote address")
        .fill(`http://127.0.0.1:${port}`);
      await section
        .getByLabel("Password for that Recurse instance")
        .fill(LOGIN);
      await section
        .getByRole("button", { name: "Connect remote", exact: true })
        .click();
      await section.getByRole("button", { name: /^Recover/ }).click();
      const recover = page.getByRole("dialog", {
        name: "Recover",
        exact: true,
      });
      const recoverSidebar = page.locator(
        '.backend-section[data-backend="Recover"]',
      );
      await browserExpect(recoverSidebar).toContainText("incompatible version");
      directMismatch = false;
      await page.evaluate(() =>
        (globalThis as any).dispatchEvent(new Event("recurse:refresh-remotes")),
      );
      await browserExpect(recoverSidebar).toContainText("connected");
      const startHeld = held.length;
      holding.add("tree");
      await browserExpect
        .poll(
          () =>
            held.slice(startHeld).find((item) => item.kind === "tree")?.state,
        )
        .toBe("pending");
      const staleTree = held
        .slice(startHeld)
        .find((item) => item.kind === "tree")!;
      versionOverride = "incompatible";
      const refreshVersion = await context.request.post(
        base + "api/relay/messages",
        {
          headers: {
            "x-loopback-token": token,
            "x-recurse-agent": rootAgentId(),
            "x-recurse-bundled-tool": "subagent",
          },
          data: { target: "missing@Recover", content: "check compatibility" },
        },
      );
      expect(refreshVersion.ok()).toBe(true);
      await browserExpect(
        recover.getByText("Incompatible versions. Update both instances."),
      ).toBeVisible({ timeout: 15_000 });
      await page.evaluate(() =>
        (globalThis as any).dispatchEvent(new Event("recurse:refresh-remotes")),
      );
      await browserExpect(recoverSidebar).toContainText("incompatible version");
      await browserExpect.poll(() => staleTree.state).toBe("aborted");
      release("tree");
      await browserExpect(recoverSidebar).toContainText("incompatible version");
      await recover
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      versionOverride = null;
      for (const mode of ["older", "incompatible"] as const) {
        versionOverride = mode;
        await section
          .getByRole("button", { name: "Add a remote", exact: true })
          .click();
        await section.getByLabel("Remote name").fill(mode);
        await section
          .getByLabel("Remote address")
          .fill(`http://127.0.0.1:${port}`);
        await section
          .getByLabel("Password for that Recurse instance")
          .fill(LOGIN);
        await section
          .getByRole("button", { name: "Connect remote", exact: true })
          .click();
        await section
          .getByRole("button", { name: new RegExp(`^${mode}`) })
          .click();
        const entry = page.getByRole("dialog", { name: mode, exact: true });
        await browserExpect(
          entry.getByText(
            mode === "older"
              ? "Older version: some agent commands need an update."
              : "Incompatible versions. Update both instances.",
          ),
        ).toBeVisible();
        if (mode === "older") {
          await browserExpect
            .poll(async () => {
              const rows = await (
                await context.request.get(base + "api/backends")
              ).json();
              return rows.find((row: { label: string }) => row.label === mode)
                ?.state;
            })
            .toBe("connected");
          const explorerRequestsBefore = explorerRequests;
          const explorer = await context.request.get(
            base + "api/backends/older/conversations/missing/tree",
          );
          expect(explorer.status()).toBe(409);
          expect((await explorer.json()).detail).toBe(
            "Update this remote to browse its files.",
          );
          expect(explorerRequests).toBe(explorerRequestsBefore);
          versionOverride = "incompatible";
          const admitted = await context.request.post(
            base + "api/relay/messages",
            {
              headers: {
                "x-loopback-token": token,
                "x-recurse-agent": rootAgentId(),
                "x-recurse-bundled-tool": "subagent",
              },
              data: {
                target: `missing@${mode}`,
                content: "check compatibility",
              },
            },
          );
          expect(admitted.ok()).toBe(true);
          await browserExpect(
            entry.getByText("Incompatible versions. Update both instances."),
          ).toBeVisible({ timeout: 15_000 });
          await page.evaluate(() =>
            (globalThis as any).dispatchEvent(
              new Event("recurse:refresh-remotes"),
            ),
          );
          await browserExpect(
            page.locator('.backend-section[data-backend="older"]'),
          ).toContainText("incompatible version");
        }
        await entry
          .getByRole("button", { name: "Disconnect", exact: true })
          .click();
      }
      versionOverride = null;
      await section
        .getByRole("button", { name: "Add a remote", exact: true })
        .click();
      await section.getByLabel("Remote name").fill("Revoked");
      await section
        .getByLabel("Remote address")
        .fill(`http://127.0.0.1:${port}`);
      await section
        .getByLabel("Password for that Recurse instance")
        .fill(LOGIN);
      await section
        .getByRole("button", { name: "Connect remote", exact: true })
        .click();
      await section.getByRole("button", { name: /^Revoked/ }).waitFor();
      revoked = true;
      expect(
        (
          await context.request.get(base + "api/backends/Revoked/status")
        ).status(),
      ).toBe(424);
      await section.getByRole("button", { name: /^Revoked/ }).click();
      await browserExpect(
        page
          .getByRole("dialog", { name: "Revoked", exact: true })
          .getByText("Sign-in revoked. Disconnect and add this remote again."),
      ).toBeVisible();
      const stoppedRequests = remoteRequests;
      await page.reload();
      await page.locator(".agent").first().waitFor({ state: "attached" });
      for (let i = 0; i < 3; i++) {
        const created = await (
          await context.request.post(base + "api/conversations", {
            data: { parent: null },
          })
        ).json();
        await page
          .locator(`#agent-list .agent[data-id="${created.id}"]`)
          .waitFor({ state: "attached" });
      }
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="account"]').click();
      await section.getByRole("button", { name: /^Revoked/ }).click();
      await browserExpect(
        page
          .getByRole("dialog", { name: "Revoked", exact: true })
          .getByText("Sign-in revoked. Disconnect and add this remote again."),
      ).toBeVisible();
      expect(remoteRequests).toBe(stoppedRequests);
    } finally {
      release("conversation");
      release("tree");
      release("rename");
      endpoint.stop(true);
      await context.close();
      await stopServer(remote);
    }
  },
];
if (import.meta.main) await runBrowserTests([["remotes", tests]]);
