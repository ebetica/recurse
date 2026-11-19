import { expect } from "bun:test";
import type { Route } from "playwright";
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
  expectHitCorners,
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
      const requestRemote = async (label: string, url: string) => {
        const requested = await context.request.post(base + "api/backends", {
          headers: {
            "x-loopback-token": token,
            "x-recurse-agent": rootAgentId(),
            "x-recurse-bundled-tool": "subagent",
          },
          data: { label, url },
        });
        expect(requested.ok()).toBe(true);
      };
      const address = `http://127.0.0.1:${port}`;
      for (const label of ["Requested", "Second", "Moved"])
        await requestRemote(label, address);
      await page.goto(base);
      await page.locator(".agent").first().waitFor();
      await openSettingsPanel(page);
      const homesUrl = `${base}api/backend-keys`;
      await page.route(homesUrl, (route) =>
        route.fulfill({ status: 500, json: { error: "unavailable" } }),
      );
      const remotesNav = page.locator(
        '#settings-nav button[data-cat="remotes"]',
      );
      await remotesNav.click();
      const section = page.locator(".remotes-settings");
      const homes = section.locator(".remote-incoming");
      const homesRead = homes.locator('.group[aria-busy="false"]');
      await homesRead.waitFor({ state: "attached" });
      await browserExpect(homesRead).toHaveText(
        "Could not load incoming connections. Reopen Settings to retry.",
      );
      await browserExpect(homesRead).toBeVisible();
      await page.unroute(homesUrl);
      await page.locator(".settings-cat:not([hidden]) .settings-back").click();
      await remotesNav.click();
      await browserExpect(
        page.getByRole("heading", { name: "Connected homes", exact: true }),
      ).toHaveCount(0);
      await homesRead.waitFor({ state: "attached" });
      await browserExpect(homes).toBeHidden();
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
        await page
          .getByRole("button", {
            name: width <= 700 ? "Close Add a remote" : "Back to Remotes",
            exact: true,
          })
          .click();
        await browserExpect(addDetails).not.toBeVisible();
      }
      const addRemote = section.getByRole("button", {
        name: "Add a remote",
        exact: true,
      });
      const rowLabels = section.locator(
        ".remote-entry > .settings-row .settings-row-label",
      );
      const modal = page.locator("dialog:modal");
      const second = page.getByRole("dialog", { name: "Second", exact: true });
      const secondPassword = second.getByLabel("Password for Second");
      const moved = page.getByRole("dialog", { name: "Moved", exact: true });
      const movedPassword = moved.getByLabel("Password for Moved");
      const movedAddress = `${address}/moved`;
      const moveRemote = async (url: string) => {
        expect(
          (await context.request.delete(base + "api/backends/Moved")).ok(),
        ).toBe(true);
        await requestRemote("Moved", url);
      };
      const heldReads: Route[] = [];
      let readArrived: (() => void) | null = null;
      await page.route(`${base}api/backends`, (route) => {
        if (
          !readArrived ||
          route.request().method() !== "GET" ||
          route.request().headers()["x-test-read"] === "refresh"
        )
          return route.fallback();
        heldReads.push(route);
        return readArrived();
      });
      const holdReads = () =>
        new Promise<void>((resolve) => (readArrived = resolve));
      const releaseReads = async () => {
        readArrived = null;
        for (const route of heldReads.splice(0)) await route.continue();
      };
      await section.getByRole("button", { name: /^Second/ }).click();
      await secondPassword.fill("typed");
      let readHeld = holdReads();
      await moveRemote(movedAddress);
      await readHeld;
      await browserExpect(
        section.getByText(movedAddress, { exact: true }),
      ).toHaveCount(0);
      await releaseReads();
      await browserExpect(
        section.getByText(movedAddress, { exact: true }),
      ).toHaveCount(1);
      await browserExpect(rowLabels).toHaveText([
        "Requested",
        "Second",
        "Moved",
      ]);
      await browserExpect(secondPassword).toBeFocused();
      await browserExpect(secondPassword).toHaveValue("typed");
      await browserExpect(modal).toHaveAccessibleName("Second");
      await second
        .getByRole("button", { name: "Close Second", exact: true })
        .click();
      await section.getByRole("button", { name: /^Moved/ }).click();
      await movedPassword.fill("old draft");
      readHeld = holdReads();
      await moveRemote(address);
      await readHeld;
      await browserExpect(movedPassword).toBeFocused();
      await browserExpect(movedPassword).toHaveValue("old draft");
      await releaseReads();
      await browserExpect(moved).toBeHidden();
      await browserExpect(addRemote).toBeVisible();
      await browserExpect(addRemote).toBeFocused();
      await section.getByRole("button", { name: /^Moved/ }).click();
      await browserExpect(
        moved.getByText(address, { exact: true }),
      ).toBeVisible();
      await browserExpect(movedPassword).toHaveValue("");
      let dismiss = (_route: Route) => {};
      const dismissHeld = new Promise<Route>((resolve) => (dismiss = resolve));
      await page.route(`${base}api/backends/Moved`, (route) => dismiss(route));
      await moved.getByRole("button", { name: "Dismiss", exact: true }).click();
      const heldDismiss = await dismissHeld;
      await moved
        .getByRole("button", { name: "Close Moved", exact: true })
        .click();
      await section.getByRole("button", { name: /^Second/ }).click();
      await secondPassword.fill("typed again");
      await page.evaluate(() => {
        const browser = globalThis as any;
        browser.addEventListener(
          "recurse:refresh-remotes",
          () => {
            const read = browser.fetch;
            browser.fetch = (input: unknown, init: any) => {
              browser.fetch = read;
              const headers = new browser.Headers(init?.headers);
              headers.set("x-test-read", "refresh");
              return read(input, { ...init, headers });
            };
          },
          { once: true },
        );
      });
      const refreshRead = page.waitForResponse(
        (response) => response.request().headers()["x-test-read"] === "refresh",
      );
      readHeld = holdReads();
      await heldDismiss.continue();
      await refreshRead;
      await browserExpect(rowLabels).toHaveText(["Requested", "Second"]);
      await browserExpect(secondPassword).toBeFocused();
      await browserExpect(secondPassword).toHaveValue("typed again");
      await browserExpect(modal).toHaveAccessibleName("Second");
      await releaseReads();
      await page.unroute(`${base}api/backends/Moved`);
      await page.unroute(`${base}api/backends`);
      await second
        .getByRole("button", { name: "Close Second", exact: true })
        .click();
      let signIn = (_route: Route) => {};
      const signInHeld = new Promise<Route>((resolve) => (signIn = resolve));
      await page.route(`${base}api/backends/Requested/sign-in`, (route) =>
        signIn(route),
      );
      await section.getByRole("button", { name: /^Requested/ }).click();
      await password.fill(LOGIN);
      await requestedDetails
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      const heldSignIn = await signInHeld;
      await requestedDetails
        .getByRole("button", { name: "Close Requested", exact: true })
        .click();
      await section.getByRole("button", { name: /^Second/ }).click();
      await secondPassword.fill("typed");
      await heldSignIn.continue();
      await browserExpect(rowLabels).toHaveText(["Second", "Requested"]);
      await browserExpect(secondPassword).toBeFocused();
      await browserExpect(secondPassword).toHaveValue("typed");
      await browserExpect(modal).toHaveAccessibleName("Second");
      await page.unroute(`${base}api/backends/Requested/sign-in`);
      await secondPassword.fill(LOGIN);
      await second
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await browserExpect(
        second.getByRole("button", {
          name: "Sync settings from home",
          exact: true,
        }),
      ).toBeVisible();
      await browserExpect(secondPassword).toHaveCount(0);
      await browserExpect(modal).toHaveAccessibleName("Second");
      await browserExpect(rowLabels).toHaveText(["Requested", "Second"]);
      await second
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await browserExpect(second).toBeHidden();
      await browserExpect(rowLabels).toHaveText(["Requested"]);
      await browserExpect(addRemote).toBeVisible();
      await browserExpect(addRemote).toBeFocused();
      await section.getByRole("button", { name: /^Requested/ }).click();
      await browserExpect(
        requestedDetails.getByRole("button", {
          name: "Sync settings from home",
          exact: true,
        }),
      ).toBeVisible();
      await requestedDetails
        .getByRole("button", { name: "Close Requested", exact: true })
        .click();
      await browserExpect(requestedDetails).not.toBeVisible();
      await page.setViewportSize({ width: 1280, height: 1000 });
      const [remotes, adding] = await section.evaluate((section) =>
        [
          section.querySelector(".remote-entry")!.parentElement!,
          section.querySelector(".remote-add")!.closest(".settings-detail")!,
        ].map((part) => {
          const box = part.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
          };
        }),
      );
      expect(adding!.left).toBe(remotes!.left);
      expect(adding!.right).toBe(remotes!.right);
      expect(adding!.top).toBeGreaterThan(remotes!.bottom);
      await expectHitCorners(
        section.getByRole("button", { name: /^Requested / }),
      );
      await expectHitCorners(addRemote);
      await section.getByRole("button", { name: /^Requested / }).click();
      const entry = page.getByRole("region", {
        name: "Requested",
        exact: true,
      });
      await browserExpect(entry).toBeVisible();
      const layout = await entry.evaluate((content) => {
        const textLeft = (element: any) => {
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().left;
        };
        const action = content.querySelector(".remote-buttons button")!;
        const address = content.querySelector(".remote-info")!;
        return {
          actionInset: textLeft(action) - textLeft(address),
          below:
            action.getBoundingClientRect().top >=
            address.getBoundingClientRect().bottom,
          repeatedName: content.querySelector(".remote-info strong") !== null,
        };
      });
      expect(layout.actionInset).toBeCloseTo(0, 0);
      expect(layout.below).toBe(true);
      expect(layout.repeatedName).toBeFalse();
      await expectHitCorners(entry.locator(".remote-buttons button").first());
      await page.locator('#settings-nav button[data-cat="models"]').click();
      const ladder = page.locator(".settings-section").filter({
        has: page.getByRole("heading", { name: "Effort levels", exact: true }),
      });
      await browserExpect(
        ladder.getByRole("button", { name: /^Level [1-5] / }),
      ).toHaveCount(5);
      const safetyRows = ladder.getByRole("button", {
        name: /^Safety review\b/,
        includeHidden: true,
      });
      await browserExpect(safetyRows).toHaveCount(1);
      await browserExpect(safetyRows).toBeVisible();
      await browserExpect(safetyRows).toHaveAccessibleName(
        "Safety review Same as level 1",
      );
      const labelLefts = await ladder
        .locator("h3, .settings-row-label:visible")
        .evaluateAll((labels) =>
          labels.map((label) => label.getBoundingClientRect().left),
        );
      expect(labelLefts).toHaveLength(8);
      expect(new Set(labelLefts).size).toBe(1);
      await page.locator('#settings-nav button[data-cat="agents"]').click();
      await page.getByRole("button", { name: /^MCP servers / }).click();
      await browserExpect(
        page.getByText("No MCP servers configured.", { exact: true }),
      ).toBeVisible();
      const mcpInsets = await page
        .getByRole("dialog", { name: "MCP servers", exact: true })
        .evaluate((page) =>
          [
            page.querySelector("h2")!,
            page.querySelector(".settings-detail-content")!,
          ].map((part) => part.getBoundingClientRect().left),
        );
      expect(new Set(mcpInsets).size).toBe(1);
      await page.locator('#settings-nav button[data-cat="remotes"]').click();
      await context.request.post(remote.base + "login", {
        form: { password: LOGIN },
      });
      const incomingPage = await context.newPage();
      await incomingPage.setViewportSize({ width: 1280, height: 1000 });
      await incomingPage.goto(remote.base);
      await incomingPage.locator(".agent").first().waitFor();
      await openSettingsPanel(incomingPage);
      await incomingPage
        .locator('#settings-nav button[data-cat="remotes"]')
        .click();
      const incoming = incomingPage.locator(".remote-incoming .remote-entry");
      await browserExpect(incoming).toHaveCount(1);
      await incoming.locator(":scope > .settings-row").click();
      await browserExpect(incoming.locator(".remote-info")).toBeVisible();
      const incomingLayout = await incoming.evaluate((entry) => {
        const textLeft = (element: any) => {
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          return range.getBoundingClientRect().left;
        };
        const button = entry.querySelector("button.danger")!;
        const info = entry.querySelector(".remote-info")!;
        return {
          inset: textLeft(button) - textLeft(info),
          below:
            button.getBoundingClientRect().top >=
            info.getBoundingClientRect().bottom,
        };
      });
      expect(incomingLayout.inset).toBeCloseTo(0, 0);
      expect(incomingLayout.below).toBe(true);
      await expectHitCorners(incoming.locator("button.danger"));
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
      await browserExpect
        .poll(
          async () =>
            (
              await (await context.request.get(base + "api/backends")).json()
            ).find((row: { label: string }) => row.label === "Requested").state,
        )
        .toBe("unreachable");
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="remotes"]').click();
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
      await page.locator('#settings-nav button[data-cat="remotes"]').click();
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
      await page.reload();
      await page.locator(".agent").first().waitFor({ state: "attached" });
      await openSettingsPanel(page);
      await page.locator('#settings-nav button[data-cat="remotes"]').click();
      await section.getByRole("button", { name: /^Revoked/ }).click();
      await browserExpect(
        page
          .getByRole("dialog", { name: "Revoked", exact: true })
          .getByText("Sign-in revoked. Disconnect and add this remote again."),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Close Revoked", exact: true })
        .click();
      await requestRemote("Moved", address);
      let dismissAgain = (_route: Route) => {};
      const dismissAgainHeld = new Promise<Route>(
        (resolve) => (dismissAgain = resolve),
      );
      await page.route(`${base}api/backends/Moved`, (route) =>
        dismissAgain(route),
      );
      await page.route(`${base}api/backends`, (route) => {
        if (!readArrived || route.request().method() !== "GET")
          return route.fallback();
        heldReads.push(route);
        return readArrived();
      });
      await section.getByRole("button", { name: /^Moved/ }).waitFor();
      readHeld = holdReads();
      await section.getByRole("button", { name: /^Moved/ }).click();
      const dismissMoved = moved.getByRole("button", {
        name: "Dismiss",
        exact: true,
      });
      await dismissMoved.click();
      const heldDismissAgain = await dismissAgainHeld;
      const dismissed = await heldDismissAgain.fetch();
      expect(dismissed.ok()).toBe(true);
      await browserExpect(dismissMoved).toBeDisabled();
      await browserExpect(modal).toHaveAccessibleName("Moved");
      await browserExpect
        .poll(() =>
          page.evaluate(() => {
            const document = (globalThis as any).document;
            return document.activeElement === document.body;
          }),
        )
        .toBe(true);
      await readHeld;
      await releaseReads();
      await browserExpect(moved).toBeHidden();
      await browserExpect(rowLabels).toHaveText(["Revoked"]);
      await browserExpect(addRemote).toBeVisible();
      await browserExpect(addRemote).toBeFocused();
      await heldDismissAgain.fulfill({ response: dismissed });
      await browserExpect(rowLabels).toHaveText(["Revoked"]);
      await browserExpect(addRemote).toBeFocused();
      await page.unroute(`${base}api/backends/Moved`);
      await page.unroute(`${base}api/backends`);
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
