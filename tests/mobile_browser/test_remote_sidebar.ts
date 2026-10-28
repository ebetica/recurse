import { expect } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retire } from "../../src/utils/trash";
import { expect as browserExpect } from "playwright/test";
import {
  LOGIN,
  ROOT,
  startServer,
  stopServer,
  runBrowserTests,
  type BrowserTest,
} from "./common";

export const tests: BrowserTest[] = [
  // Feature: #2702 Connected agents support the home's operator actions, including safety, take-over, clear and delete, without exposing home failures. (also #2793 Remote sends must work through ingresses that reject chunked request bodies.; #2729 The optimistic Queued panel appears before keyboard Stop is available.)
  async function test_remote_sidebar(browser, base) {
    const remote = await startServer({ auth: true });
    const ingress = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.headers.get("transfer-encoding")?.includes("chunked"))
          return new Response(
            "Ingress does not accept chunked request bodies",
            {
              status: 500,
            },
          );
        const url = new URL(request.url);
        const headers = new Headers(request.headers);
        headers.delete("host");
        return fetch(remote.base.slice(0, -1) + url.pathname + url.search, {
          method: request.method,
          headers,
          body: request.body ? await request.arrayBuffer() : undefined,
          redirect: "manual",
        });
      },
    });
    const remoteContext = await browser.newContext();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let legacy: Awaited<ReturnType<typeof startServer>> | undefined;
    let legacySource: string | undefined;
    try {
      const login = await fetch(remote.base + "login", {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({ password: LOGIN }),
      });
      expect(login.status).toBe(303);
      await remoteContext.addCookies([
        {
          name: "chat_auth",
          value: login.headers
            .get("set-cookie")!
            .split(";")[0]!
            .slice("chat_auth=".length),
          url: remote.base,
        },
      ]);
      const seed = await remoteContext.request.post(
        remote.base + "__browser-test/seed-provider-replay",
        { data: { name: "openai-codex-read" } },
      );
      expect(seed.ok()).toBe(true);
      const { agent } = await seed.json();
      const hostileTitle =
        '<img src=x onerror="window.remoteTitleExecuted=true">';
      expect(
        (
          await remoteContext.request.post(
            `${remote.base}api/conversations/${agent}/rename`,
            { data: { title: hostileTitle } },
          )
        ).ok(),
      ).toBe(true);
      const remotePage = await remoteContext.newPage();
      await remotePage.goto(`${remote.base}#agent=${agent}`);
      await remotePage
        .locator("#input")
        .fill("Read live-seed.txt, then reply RECORDED_READ_OK.");
      await remotePage.locator("#send").click();
      await remotePage
        .locator(".msg.assistant")
        .filter({ hasText: "RECORDED_READ_OK" })
        .waitFor({ timeout: 60_000 });
      await browserExpect
        .poll(
          async () =>
            (
              await (
                await remoteContext.request.get(
                  `${remote.base}api/conversations/${agent}`,
                )
              ).json()
            ).status,
        )
        .toBe("idle");
      const tree = await (
        await remoteContext.request.get(remote.base + "api/tree")
      ).json();
      const root = tree.find(
        (node: { parent: string | null }) => node.parent === null,
      ).id;
      const files = await (
        await remoteContext.request.post(
          remote.base + "__browser-test/seed-files-pane",
        )
      ).json();
      const artifact = await (
        await remoteContext.request.post(
          `${remote.base}__browser-test/seed-artifact-app?agent=${root}`,
        )
      ).json();
      const writable = await (
        await remoteContext.request.post(remote.base + "api/conversations", {
          data: { parent: root, title: "Remote actions" },
        })
      ).json();
      expect(
        (
          await remoteContext.request.post(
            `${remote.base}api/conversations/${writable.id}/rename`,
            { data: { title: "Remote actions" } },
          )
        ).ok(),
      ).toBe(true);
      const disposable = await (
        await remoteContext.request.post(remote.base + "api/conversations", {
          data: { parent: root },
        })
      ).json();
      const stopped = await (
        await remoteContext.request.post(
          remote.base + "__browser-test/seed-durable-stop",
        )
      ).json();
      const homeLadder = await (
        await context.request.get(base + "api/settings/effort-levels")
      ).json();
      const remoteLadder = await (
        await remoteContext.request.get(
          remote.base + "api/settings/effort-levels",
        )
      ).json();
      const defaultLevel: number = remoteLadder.default_level;
      expect(defaultLevel).toBeLessThan(4);
      const remoteReasoning = ["low", "medium", "high"].find(
        (reasoning) => reasoning !== homeLadder.levels["4"].reasoning,
      )!;
      const remoteDefault = [1, 2, 3].find(
        (level) => level !== homeLadder.default_level && level !== defaultLevel,
      )!;
      remoteLadder.levels["4"] = {
        model: remoteLadder.levels[String(defaultLevel)].model,
        reasoning: remoteReasoning,
      };
      remoteLadder.levels[String(remoteDefault)] =
        remoteLadder.levels[String(defaultLevel)];
      expect(
        (
          await remoteContext.request.post(
            remote.base + "api/settings/effort-levels",
            {
              data: {
                levels: remoteLadder.levels,
                default_level: defaultLevel,
              },
            },
          )
        ).ok(),
      ).toBe(true);
      const pickRemoteLevel4 = async () => {
        await browserExpect(page.locator("#model-row")).toHaveClass(/\bon\b/);
        await browserExpect(page.locator("#model-row")).not.toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await page.locator("#model-trigger").click();
        await page.locator("#effort-range").focus();
        for (let level = defaultLevel; level < 4; level++)
          await page.keyboard.press("ArrowRight");
        await browserExpect(page.locator("#effort-range")).toHaveValue("4");
        await browserExpect(page.locator("#effort-model")).toHaveText(
          new RegExp(` ${remoteReasoning}$`),
        );
      };
      const connected = await context.request.post(base + "api/backends", {
        data: { label: "Laptop", url: ingress.url.href, password: LOGIN },
      });
      expect(connected.status()).toBe(200);
      await page.goto(base);
      const section = page.locator('.backend-section[data-backend="Laptop"]');
      await section.locator("hr").waitFor();
      await section.locator("strong").filter({ hasText: "Laptop" }).waitFor();
      const create = section.getByRole("button", {
        name: "New agent on Laptop",
      });
      for (const [size, width, height] of [
        ["desktop", 1280, 800],
        ["mobile", 390, 844],
      ] as const) {
        await page.setViewportSize({ width, height });
        if (size === "mobile") {
          expect(
            (
              await remoteContext.request.post(
                remote.base + "api/settings/effort-levels",
                {
                  data: {
                    levels: remoteLadder.levels,
                    default_level: remoteDefault,
                  },
                },
              )
            ).ok(),
          ).toBe(true);
          await page.locator("#menu-btn").click();
        }
        await browserExpect(create).toBeEnabled();
        await create.scrollIntoViewIfNeeded();
        expect(
          await create.evaluate((button) => {
            const box = button.getBoundingClientRect();
            return [
              [-21, 0],
              [21, 0],
              [0, -21],
              [0, 21],
            ].every(([x, y]) =>
              button.contains(
                button.ownerDocument.elementFromPoint(
                  box.x + box.width / 2 + x,
                  box.y + box.height / 2 + y,
                ),
              ),
            );
          }),
        ).toBe(true);
        await create.click();
        if (size === "desktop") {
          await page.evaluate(() => {
            (globalThis as any).sessionStorage.setItem(
              "recurse.authRecovery.v1",
              JSON.stringify({
                version: 1,
                owner: null,
                input: "Recovered remote draft",
                attachments: [],
                jobs: [],
                draft: {
                  parent: null,
                  backendLabel: "Laptop",
                  creatorIndex: -1,
                },
              }),
            );
          });
          await page.reload();
          await browserExpect(page.locator("#input")).toHaveValue(
            "Recovered remote draft",
          );
        }
        const level = size === "desktop" ? 4 : remoteDefault;
        if (size === "desktop") await pickRemoteLevel4();
        else
          await browserExpect(page.locator("#effort-range")).toHaveValue(
            String(remoteDefault),
          );
        await browserExpect(section.locator(".draft-row")).toHaveCount(1);
        await browserExpect(
          page.locator("#agent-list > .draft-row"),
        ).toHaveCount(0);
        const reply = `REMOTE_NEW_${size.toUpperCase()}_OK`;
        await page.locator("#file-input").setInputFiles({
          name: "first-message.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Remote draft upload"),
        });
        await page
          .locator(".attach-chip:not(.uploading):not(.failed)")
          .waitFor();
        await page.locator("#input").fill(`Reply only ${reply}`);
        const creation = page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            request.url().endsWith("/api/backends/Laptop/conversations"),
        );
        await page.locator("#send").click();
        expect((await creation).postDataJSON().level).toBe(
          size === "desktop" ? 4 : undefined,
        );
        await page
          .locator(".msg.assistant")
          .filter({ hasText: reply })
          .waitFor();
        const qualified = new URLSearchParams(
          new URL(page.url()).hash.slice(1),
        ).get("agent")!;
        expect(qualified).toStartWith("Laptop/");
        const id = qualified.slice("Laptop/".length);
        const created = await remoteContext.request.get(
          `${remote.base}api/conversations/${id}`,
        );
        expect(created.ok()).toBe(true);
        const conversation = await created.json();
        expect(conversation.parent).toBeNull();
        expect(conversation.safety_off).not.toBe(true);
        expect(conversation.level).toBe(level);
        const createdView = await (
          await remoteContext.request.get(
            `${remote.base}api/conversations/${id}/view`,
          )
        ).json();
        const first = createdView.blocks.find(
          (block: any) => block.role === "user" && block.text.includes(reply),
        );
        expect(first.origin).toBe("operator");
        expect(first.text).toContain("first-message.txt");
        const homeNodes = await (
          await context.request.get(base + "api/tree")
        ).json();
        expect(homeNodes.some((node: any) => node.id === id)).toBe(false);
        if (size === "mobile") await page.locator("#menu-btn").click();
        await browserExpect(
          section.locator(`.agent[data-id="${qualified}"]`),
        ).toBeVisible();
        await page.screenshot({
          path: join(tmpdir(), `remote-new-agent-${size}.png`),
          animations: "disabled",
        });
        if (size === "mobile") {
          await page.locator("#menu-btn").click();
          expect(
            (
              await remoteContext.request.delete(
                `${remote.base}api/conversations/${id}`,
              )
            ).ok(),
          ).toBe(true);
          await browserExpect(
            section.locator(`.agent[data-id="${qualified}"]`),
          ).toHaveCount(0, { timeout: 20_000 });
          await browserExpect
            .poll(() =>
              new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
                "agent",
              ),
            )
            .not.toBe(qualified);
        }
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await browserExpect(page.locator("#input")).toBeEnabled();
      const homeMatch = await (
        await context.request.post(base + "api/conversations", {
          data: { title: "Remote actions" },
        })
      ).json();
      expect(
        (
          await context.request.post(
            `${base}api/conversations/${homeMatch.id}/rename`,
            { data: { title: "Remote actions" } },
          )
        ).ok(),
      ).toBe(true);
      await browserExpect(
        page.locator(`.agent[data-id="${homeMatch.id}"] .title`),
      ).toHaveText("Remote actions");
      await page.locator("#input").fill("can you message @Remote act");
      const options = page.locator("#agent-menu .agent-option");
      await browserExpect(options).toHaveCount(2);
      await browserExpect(options.nth(0)).not.toContainText("Remote · Laptop");
      await browserExpect(options.nth(1)).toContainText("Remote · Laptop");
      await page.screenshot({
        path: join(tmpdir(), "remote-agent-mention.png"),
      });
      await options.nth(1).click();
      await browserExpect(page.locator("#input")).toHaveValue(
        `can you message @Remote actions (agent ${writable.id}@Laptop) `,
      );
      await page.locator("#input").fill("");
      await section.locator(`.agent[data-id="Laptop/${root}"]`).click();
      await browserExpect(
        section.locator(`.agent[data-id="Laptop/${agent}"] .title`),
      ).toHaveText(hostileTitle);
      expect(await section.locator(".title img").count()).toBe(0);
      await section.locator(`.agent[data-id="Laptop/${agent}"]`).click();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "RECORDED_READ_OK" })
        .waitFor();
      await browserExpect(page.locator("#input")).toBeEnabled();
      for (const off of [true, false]) {
        const toggled = page.waitForResponse((response) =>
          response
            .url()
            .endsWith(`/api/backends/Laptop/conversations/${agent}/safety`),
        );
        await page.locator("#safety-btn").click();
        expect((await toggled).ok()).toBe(true);
        expect(
          (
            await (
              await remoteContext.request.get(
                `${remote.base}api/conversations/${agent}`,
              )
            ).json()
          ).safety_off,
        ).toBe(off);
      }
      expect(new URL(page.url()).hash).toContain(
        encodeURIComponent(`Laptop/${agent}`),
      );
      await page.reload();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "RECORDED_READ_OK" })
        .waitFor();
      await section.locator(`.agent[data-id="Laptop/${files.demo}"]`).click();
      const image = page.locator('#messages img[alt="browser-image.png"]');
      await browserExpect
        .poll(() =>
          image.evaluate((img: any) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
      expect(await image.getAttribute("src")).toStartWith(
        "/api/backends/Laptop/",
      );
      await page.goto(`${base}#agent=Laptop/${root}`);
      await page.locator(`a[href="#artifact=${artifact.id}"]`).click();
      const frame = page.frameLocator("iframe.artifact-embed-page");
      await frame.locator("body[data-ready]").waitFor();
      await frame.locator("#count").click();
      await browserExpect(frame.locator("#count")).toHaveText("1");
      expect(
        await frame
          .locator("img")
          .evaluate((img: any) => img.complete && img.naturalWidth > 0),
      ).toBe(true);
      expect(
        await frame.locator("body").evaluate((body: any) => {
          try {
            return !!body.ownerDocument.defaultView.parent.document;
          } catch {
            return false;
          }
        }),
      ).toBe(false);
      const src = await page
        .locator("iframe.artifact-embed-page")
        .getAttribute("src");
      expect(src).toStartWith("/api/backends/Laptop/");
      const response = await context.request.get(base.slice(0, -1) + src);
      expect(response.headers()["content-security-policy"]).toContain(
        "sandbox allow-scripts",
      );
      expect(response.headers()["content-security-policy"]).not.toContain(
        "allow-same-origin",
      );
      await page.goto(`${base}#agent=Laptop/${writable.id}`);
      await browserExpect(page.locator("#input")).toBeEnabled();
      const switched = page.waitForResponse((response) =>
        response
          .url()
          .endsWith(`/api/backends/Laptop/conversations/${writable.id}/model`),
      );
      await pickRemoteLevel4();
      expect((await switched).ok()).toBe(true);
      await page.keyboard.press("Escape");
      await page.locator("#input").fill("Reply only REMOTE_TEXT_OK");
      const sent = page.waitForResponse((response) =>
        response.url().endsWith(`/conversations/${writable.id}/deliver`),
      );
      await page.locator("#send").click();
      expect((await sent).status()).toBe(200);
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "REMOTE_TEXT_OK" })
        .waitFor();
      expect(
        (
          await (
            await remoteContext.request.get(
              `${remote.base}api/conversations/${writable.id}`,
            )
          ).json()
        ).level,
      ).toBe(4);
      await page.locator("#file-input").setInputFiles({
        name: "remote-note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Remote attachment arrived"),
      });
      await page.locator(".attach-chip:not(.uploading):not(.failed)").waitFor();
      await page.locator("#input").fill("Reply only REMOTE_ACTIONS_OK");
      await page.locator("#send").click();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "REMOTE_ACTIONS_OK" })
        .waitFor();
      const view = await (
        await remoteContext.request.get(
          `${remote.base}api/conversations/${writable.id}/view`,
        )
      ).json();
      const input = view.blocks.find(
        (block: any) =>
          block.role === "user" && block.text.includes("REMOTE_ACTIONS_OK"),
      );
      expect(input.origin).toBe("operator");
      expect(input.text).toContain("remote-note.txt");
      const downloadLink = page
        .locator("#messages a[download]")
        .filter({ hasText: "remote-note.txt" });
      const downloadEvent = page.waitForEvent("download");
      await downloadLink.click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe("remote-note.txt");
      expect(await Bun.file((await download.path())!).text()).toBe(
        "Remote attachment arrived",
      );
      await page.locator(`.agent[data-id="Laptop/${writable.id}"]`).click();
      await page.keyboard.press("Escape");
      await page.keyboard.press("r");
      await page.locator(".rename-input").fill("Renamed remote");
      await page.locator(".rename-input").press("Enter");
      await browserExpect(
        section.locator(`.agent[data-id="Laptop/${writable.id}"] .title`),
      ).toHaveText("Renamed remote");
      for (const pressed of ["true", "false"]) {
        await page.locator("#takeover-btn.on").click();
        await browserExpect(page.locator("#takeover-btn")).toHaveAttribute(
          "aria-pressed",
          pressed,
        );
        await browserExpect
          .poll(
            async () =>
              (
                await (
                  await remoteContext.request.get(
                    `${remote.base}api/conversations/${writable.id}`,
                  )
                ).json()
              ).pinned,
          )
          .toBe(pressed === "true");
      }
      await section
        .locator(`.agent[data-id="Laptop/${disposable.id}"]`)
        .click();
      await browserExpect(page.locator("#input")).toBeEnabled();
      await page.locator("#input").fill("/clear");
      const cleared = page.waitForResponse((response) =>
        response.url().endsWith(`/conversations/${disposable.id}/clear`),
      );
      page.once("dialog", (dialog) => void dialog.accept());
      await page
        .locator("#skill-menu .skill-option.action", { hasText: "/clear" })
        .click();
      expect((await cleared).ok()).toBe(true);
      const deleted = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          response.url().endsWith(`/conversations/${disposable.id}`),
      );
      await page.locator("#trash-btn").click();
      await page.locator("#trash-btn").click();
      expect((await deleted).ok()).toBe(true);
      await browserExpect(
        section.locator(`.agent[data-id="Laptop/${disposable.id}"]`),
      ).toHaveCount(0);
      await browserExpect
        .poll(async () =>
          (
            await remoteContext.request.get(
              `${remote.base}api/conversations/${disposable.id}`,
            )
          ).status(),
        )
        .toBe(404);
      await page.goto(`${base}#agent=Laptop/${stopped.agent}`);
      await page.locator("#input").fill("Run until stopped");
      await page.locator("#send").click();
      await page.locator(".working.live-panel").waitFor();
      await page.locator("#conv-status.running").waitFor();
      const stopResponse = page.waitForResponse(
        (response) =>
          response.url().includes(`/conversations/${stopped.agent}/deliver`) &&
          !!response.request().postDataJSON()?.stop_id,
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("q");
      await page.keyboard.press("q");
      expect((await stopResponse).ok()).toBe(true);
      await browserExpect
        .poll(
          async () =>
            (
              await (
                await remoteContext.request.get(
                  `${remote.base}api/conversations/${stopped.agent}`,
                )
              ).json()
            ).status,
        )
        .not.toBe("running");
      if (!(await page.locator("#settings-btn").isVisible()))
        await page.locator("#menu-btn").click();
      await page.locator("#settings-btn").click();
      const settingsNav = page.locator("#settings-nav button");
      await browserExpect(settingsNav).toHaveCount(5);
      await page.locator("#settings-backend").selectOption("Laptop");
      await browserExpect(settingsNav).toHaveText([
        "Authentication",
        "Models",
        "MCPs",
      ]);
      const loginUrl = `${base}api/backends/Laptop/pi/auth/login-url`;
      let releaseLogin!: () => void;
      const loginHeld = new Promise<void>(
        (resolve) => (releaseLogin = resolve),
      );
      let loginFetched!: () => void;
      const loginSeen = new Promise<void>(
        (resolve) => (loginFetched = resolve),
      );
      await page.route(loginUrl, async (route) => {
        const response = await route.fetch();
        loginFetched();
        await loginHeld;
        await route.fulfill({ response });
      });
      const popups: unknown[] = [];
      context.on("page", (opened) => popups.push(opened));
      await page
        .locator(".settings-section", { hasText: "Claude auth" })
        .locator(".sub")
        .click();
      await loginSeen;
      await page.locator("#settings-backend").selectOption("");
      const loginFinished = page.waitForEvent(
        "requestfinished",
        (request) => request.url() === loginUrl,
      );
      releaseLogin();
      await loginFinished;
      await page.unroute(loginUrl);
      await page.locator("#settings-backend").selectOption("Laptop");
      await settingsNav.getByText("Models", { exact: true }).click();
      const windowInput = page.locator("#maximum-context-window");
      await browserExpect(windowInput).not.toHaveValue("");
      await windowInput.fill("123456");
      const savedWindow = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response
            .url()
            .endsWith("/api/backends/Laptop/settings/maximum-context-window"),
      );
      await windowInput
        .locator("xpath=ancestor::form")
        .getByRole("button", { name: "Save" })
        .click();
      expect((await savedWindow).ok()).toBe(true);
      const windowOf = async (request: typeof context.request, at: string) =>
        (
          await (
            await request.get(`${at}api/settings/maximum-context-window`)
          ).json()
        ).maximum_context_window;
      expect(await windowOf(remoteContext.request, remote.base)).toBe(123456);
      expect(await windowOf(context.request, base)).not.toBe(123456);
      await settingsNav.getByText("MCPs", { exact: true }).click();
      await page
        .getByText("Sign in to MCP servers on Laptop from its own page", {
          exact: false,
        })
        .waitFor();
      expect(popups).toHaveLength(0);
      await page.locator("#settings-backend").selectOption("");
      await browserExpect(settingsNav).toHaveCount(5);
      await page.locator("#settings-close").click();
      await page.goto(`${base}#agent=Laptop/${writable.id}`);
      await page.locator("#input").waitFor();
      await page.evaluate(() => {
        (globalThis as any).remoteSidebarNoReload = true;
      });
      if (!(await remotePage.locator("#settings-btn").isVisible()))
        await remotePage.locator("#menu-btn").click();
      await remotePage.locator("#settings-btn").click();
      const incoming = remotePage.locator(".remotes-settings .remote-incoming");
      await browserExpect(
        incoming.getByText(/^Access allowed · last seen /),
      ).toBeVisible();
      await browserExpect(incoming.locator(".hint")).toHaveCount(0);
      const revoke = incoming.getByRole("button", {
        name: "Revoke access",
        exact: true,
      });
      await revoke.scrollIntoViewIfNeeded();
      expect(
        await revoke.evaluate((button) => {
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
      await revoke.click();
      await browserExpect(
        incoming.getByText("No homes have access."),
      ).toBeVisible();
      await page.locator("#input").fill("This send must fail visibly");
      await page.locator("#send").click();
      await page.getByText(/key was revoked.*Retry now/).waitFor();
      await section
        .getByText("key revoked", { exact: true })
        .waitFor({ timeout: 20_000 });
      await browserExpect(create).toBeDisabled();
      expect(
        await page.evaluate(() => (globalThis as any).remoteSidebarNoReload),
      ).toBe(true);
      const homeTree = await (
        await context.request.get(base + "api/tree")
      ).json();
      const home = homeTree.find(
        (node: { parent: string | null }) => node.parent === null,
      ).id;
      await page.locator(`.agent[data-id="${home}"]`).click();
      await browserExpect(page.locator("#input")).toBeEnabled();
      await page.locator("#input").fill("@Renamed rem");
      const offlineMention = page.locator("#agent-menu .agent-option");
      await browserExpect(offlineMention).toContainText(
        "Remote · Laptop · Offline",
      );
      await offlineMention.click();
      await browserExpect(page.locator("#input")).toHaveValue(
        `@Renamed remote (agent ${writable.id}@Laptop) `,
      );
      await page.locator("#input").fill("Reply only HOME_STILL_WORKS");
      await page.locator("#send").click();
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "HOME_STILL_WORKS" })
        .waitFor();
      expect((await context.request.get(base + "api/version")).ok()).toBe(true);
      legacySource = await mkdtemp(
        join(tmpdir(), "remote-before-api-contract-"),
      );
      const archive = Bun.spawn(
        ["git", "archive", "f48815e38647c50294f74acb384f16d626e57544"],
        { cwd: ROOT, stdout: "pipe", stderr: "inherit" },
      );
      const extract = Bun.spawn(["tar", "-x", "-C", legacySource], {
        stdin: archive.stdout,
        stdout: "ignore",
        stderr: "inherit",
      });
      expect(await archive.exited).toBe(0);
      expect(await extract.exited).toBe(0);
      await symlink(
        join(ROOT, "node_modules"),
        join(legacySource, "node_modules"),
      );
      await symlink(join(ROOT, "web/dist"), join(legacySource, "web/dist"));
      legacy = await startServer({ sourceRoot: legacySource, auth: true });
      expect(
        (
          await context.request.post(base + "api/backends", {
            data: { label: "Older", url: legacy.base, password: LOGIN },
          })
        ).status(),
      ).toBe(200);
      await page.reload();
      const incompatible = page.locator(
        '.backend-section[data-backend="Older"]',
      );
      await incompatible
        .getByText("incompatible version", { exact: true })
        .waitFor();
      expect(await incompatible.locator(".agent").count()).toBe(0);
      await browserExpect(incompatible.locator("a")).toHaveAttribute(
        "href",
        legacy.base.replace(/\/$/, ""),
      );
    } finally {
      await context.close();
      await remoteContext.close();
      await ingress.stop(true);
      await stopServer(remote);
      if (legacy) await stopServer(legacy);
      if (legacySource)
        await retire(legacySource, join(tmpdir(), "remote-sidebar-trash"));
    }
  },
];

if (import.meta.main) await runBrowserTests([["remote-sidebar", tests]]);
