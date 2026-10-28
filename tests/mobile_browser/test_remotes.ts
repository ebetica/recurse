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
} from "./common";

export const tests: BrowserTest[] = [
  // Feature: #2769 Signed-in remotes retain agents and credentials through offline periods. (also #2814 A hung remote read held back home tree updates, and removing a remote left its read running.; #2819 A remote tree read dropped a pending rename of a remote agent.)
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
    let flaky = false;
    const serve = (port: number) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        async fetch(request) {
          const url = new URL(request.url);
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
          return fetch(remote.base + url.pathname.slice(1) + url.search, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: request.signal,
            redirect: "manual",
          });
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
        },
        data: { label: "Requested", url: `http://127.0.0.1:${port}` },
      });
      expect(requested.ok()).toBe(true);
      await page.goto(base);
      await page.locator(".agent").first().waitFor();
      await page.locator("#menu-btn").click();
      await page.locator("#settings-btn").click();
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
      const password = section.getByLabel("Password for Requested");
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
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await section
          .getByRole("button", { name: "Add a remote", exact: true })
          .click();
        const addPassword = section.getByLabel(
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
        await browserExpect(section.getByLabel("Remote name")).toBeVisible();
        await browserExpect(section.getByLabel("Remote address")).toBeVisible();
        const connect = section.getByRole("button", {
          name: "Connect remote",
          exact: true,
        });
        await browserExpect(connect).toHaveClass("primary");
        expect(
          await connect.evaluate((button) => {
            const input = button.closest("form")!.querySelector("input")!;
            return (
              Math.abs(
                button.getBoundingClientRect().right -
                  input.getBoundingClientRect().right,
              ) <= 1
            );
          }),
        ).toBe(true);
        for (const control of await section.locator("input, button").all()) {
          if (!(await control.isVisible())) continue;
          await control.scrollIntoViewIfNeeded();
          expect(
            await control.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return [
                [-21, 0],
                [21, 0],
                [0, -21],
                [0, 21],
              ].every(([x, y]) =>
                element.contains(
                  element.ownerDocument.elementFromPoint(
                    box.x + box.width / 2 + x!,
                    box.y + box.height / 2 + y!,
                  ),
                ),
              );
            }),
          ).toBe(true);
        }
        expect(
          await section.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await section
          .getByRole("button", { name: "Add a remote", exact: true })
          .click();
      }
      await password.fill(LOGIN);
      await section
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      await browserExpect(
        section.getByText("Signed in", { exact: true }),
      ).toBeVisible();
      await page.locator("#settings-close").click();
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
      const sent = await context.request.post(base + "api/relay/messages", {
        headers: {
          "x-loopback-token": token,
          "x-recurse-agent": rootAgentId(),
        },
        data: {
          target: `${id}@Requested`,
          content: "Do not queue this offline message",
        },
      });
      expect(sent.status()).toBe(409);
      expect((await sent.json()).detail).toContain(
        "remote offline (last seen ",
      );
      await page.locator("#settings-btn").click();
      const offline = section.getByText(/^Offline · last seen /);
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
      const disconnect = section.getByRole("button", {
        name: "Disconnect",
        exact: true,
      });
      await disconnect.scrollIntoViewIfNeeded();
      expect(
        await disconnect.evaluate((button) => {
          const box = button.getBoundingClientRect();
          return [-21, 21].every((x) =>
            [-21, 21].every((y) =>
              button.contains(
                button.ownerDocument.elementFromPoint(
                  box.x + box.width / 2 + x,
                  box.y + box.height / 2 + y,
                ),
              ),
            ),
          );
        }),
      ).toBe(true);
      expect(
        await section.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
      await browserExpect(
        section.getByText(/^Offline · last seen /),
      ).not.toHaveClass(/err/);
      endpoint = serve(port);
      await page.locator("#settings-close").click();
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
        .poll(() => treeReads - unchangedFrom, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(4);
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
      await page.locator("#menu-btn").click();
      await page.locator("#settings-btn").click();
      await section
        .locator(".remote-entry")
        .filter({ hasText: "Requested" })
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      await browserExpect.poll(() => treeRead.state).toBe("aborted");
      await browserExpect(remoteSection).toHaveCount(0);
      await browserExpect(
        page.locator(`#agent-list .agent[data-id="${created.id}"]`),
      ).toBeAttached();
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
