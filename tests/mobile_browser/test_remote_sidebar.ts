import { expect } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retire } from "../../src/utils/trash";
import { installDependencies } from "../../src/local_dependencies";
import type { Route } from "playwright";
import { expect as browserExpect } from "playwright/test";
import {
  LOGIN,
  addServerCookie,
  ROOT,
  focusComposer,
  startServer,
  stopServer,
  runBrowserTests,
  type BrowserTest,
  openSettingsPanel,
  expectHitCorners,
} from "./common";
import { enableTagSidebar } from "./sidebar_support";
import { loadRecording } from "../backend/fixtures/model_response/replay";

export const tests: BrowserTest[] = [
  // Regression: #3445 a failed remote listing keeps the linked remote; #3112 cancel stalled discovery bodies after headers; #3067 keep the remote Stop generation live until cancellation. (also Feature #2702 connected agents support the home's operator actions, including safety, take-over, clear and delete, without exposing home failures; #2793 remote sends work through ingresses that reject chunked bodies; #2729 the optimistic Queued status bar precedes keyboard Stop; #3002 remote sections, tags and tag actions.)
  async function test_remote_sidebar(browser, base) {
    const remote = await startServer({ auth: true });
    let omitTagSupport = false;
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
        if (url.pathname === "/api/tree") headers.delete("if-none-match");
        const response = await fetch(
          remote.base.slice(0, -1) + url.pathname + url.search,
          {
            method: request.method,
            headers,
            body: request.body ? await request.arrayBuffer() : undefined,
            redirect: "manual",
          },
        );
        if (omitTagSupport && url.pathname === "/api/tree" && response.ok) {
          const nodes = (await response.json()) as any[];
          for (const node of nodes) if (node.agent) delete node.agent.tags;
          return Response.json(nodes);
        }
        return response;
      },
    });
    const remoteContext = await browser.newContext();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.clock.install();
    await page.addInitScript(() => {
      const w = globalThis as any;
      const original = w.fetch;
      w.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        if (
          String(args[0]) !== "/api/backends" ||
          !w.sessionStorage.getItem("stallRemoteDiscovery") ||
          !response.body
        )
          return response;
        w.sessionStorage.removeItem("stallRemoteDiscovery");
        const reader = response.body.getReader();
        const signal = args[1]?.signal;
        return new Response(
          new ReadableStream({
            async start(controller) {
              const next = await reader.read();
              controller.enqueue(next.value.subarray(0, 1));
              w.remoteDiscoveryStalled = true;
              const abort = () => {
                w.remoteDiscoveryCancelled = true;
                controller.error(new DOMException("Aborted", "AbortError"));
                void reader.cancel().catch(() => {});
              };
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            },
            cancel: () => reader.cancel(),
          }),
          { status: response.status, headers: response.headers },
        );
      };
    });
    let legacy: Awaited<ReturnType<typeof startServer>> | undefined;
    let legacySource: string | undefined;
    try {
      await addServerCookie(remoteContext, remote);
      await browserExpect
        .poll(async () =>
          (
            await remoteContext.request.get(
              remote.base + "__browser-test/ready",
            )
          ).status(),
        )
        .toBe(200);
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
      const root = remote.root;
      const files = await (
        await remoteContext.request.post(
          remote.base + "__browser-test/seed-files-pane",
        )
      ).json();
      const artifact = await (
        await remoteContext.request.post(
          `${remote.base}__browser-test/seed-artifact-app`,
          { data: { agent: root } },
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
      const recording = await loadRecording();
      remoteLadder.levels["4"] = {
        model: `${recording.provider}/${recording.requestedModel}`,
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
      const { models: remoteModels } = await (
        await remoteContext.request.get(
          remote.base + "api/settings/effort-levels",
        )
      ).json();
      const labelFor = (models: { id: string; label: string }[], id: string) =>
        models.find((model) => model.id === id)!.label;
      const remoteLabel = labelFor(
        remoteModels,
        remoteLadder.levels["4"].model,
      );
      expect(remoteLabel).not.toBe(
        labelFor(homeLadder.models, homeLadder.levels["4"].model),
      );
      const reason =
        remoteReasoning.charAt(0).toUpperCase() + remoteReasoning.slice(1);
      const pickRemoteLevel4 = async (owner: "draft" | "conversation") => {
        const saved = owner === "conversation";
        const description = saved ? `${remoteLabel} · ${reason}` : remoteLabel;
        await browserExpect(page.locator("#model-row")).toHaveClass(/\bon\b/);
        await browserExpect(page.locator("#model-row")).not.toHaveAttribute(
          "aria-disabled",
          "true",
        );
        const trigger = page.locator("#model-trigger");
        const range = page.locator("#effort-range");
        if (saved) await focusComposer(page);
        await trigger.click();
        await range.focus();
        const current = Number(await range.inputValue());
        for (let step = 0; step < Math.abs(4 - current); step++)
          await range.press(current < 4 ? "ArrowRight" : "ArrowLeft");
        await browserExpect(range).toHaveValue("4");
        await browserExpect(range).toHaveAttribute(
          "aria-valuetext",
          `Level 4: ${description}`,
        );
        await browserExpect(page.locator("#effort-model")).toHaveText(
          saved ? `${remoteLabel} ${reason}` : remoteLabel,
        );
        await browserExpect(trigger.locator(".model-name")).toHaveText(
          remoteLabel.replace(/^Claude /, ""),
        );
        const pending = saved ? "switches on your next message; " : "";
        await browserExpect(trigger).toHaveAttribute(
          "aria-label",
          `Level 4: ${description}: ${pending}choose effort level`,
        );
      };
      const connected = await context.request.post(base + "api/backends", {
        data: { label: "Laptop", url: ingress.url.href, password: LOGIN },
      });
      expect(connected.status()).toBe(200);
      await enableTagSidebar(context, base, [
        "agent-desktop",
        "agent-mobile",
        "project",
      ]);
      await page.goto(base);
      const section = page.locator('.backend-section[data-backend="Laptop"]');
      await section.locator("hr").waitFor();
      await section.locator("strong").filter({ hasText: "Laptop" }).waitFor();
      const create = section.getByRole("button", {
        name: "New agent on Laptop",
      });
      await create.click();
      const effort = page.locator("#effort-range");
      await browserExpect(effort).toHaveAttribute("max", "6");
      await page.locator("#model-trigger").click();
      await effort.press("End");
      await page.locator("#input").fill("Reply only REMOTE_SIX_OK");
      const ladderUrl = `${base}api/backends/Laptop/settings/effort-levels`;
      const creationUrl = `${base}api/backends/Laptop/conversations`;
      const firstRequest = page.waitForRequest(
        (request) =>
          request.url() === ladderUrl ||
          (request.url() === creationUrl && request.method() === "POST"),
      );
      const atSix = page.waitForResponse(
        (response) =>
          response.url() === creationUrl &&
          response.request().method() === "POST",
      );
      await page.locator("#send").click();
      expect((await firstRequest).url()).toBe(ladderUrl);
      const createdAtSix = await atSix;
      expect(createdAtSix.ok()).toBe(true);
      expect(createdAtSix.request().postDataJSON().level).toBe(6);
      await browserExpect(
        page.locator(".msg.assistant").filter({ hasText: "REMOTE_SIX_OK" }),
      ).toBeVisible();
      const sixthId = (await createdAtSix.json()).id;
      expect(
        (
          await remoteContext.request.delete(
            `${remote.base}api/conversations/${sixthId}`,
          )
        ).ok(),
      ).toBe(true);
      await browserExpect(
        section.locator(`.agent[data-id="Laptop/${sixthId}"]`),
      ).toHaveCount(0);
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
        await page.locator("#draft-model-host").waitFor();
        await page.getByRole("button", { name: "No tag", exact: true }).click();
        await page
          .getByRole("textbox", { name: "Tag name", exact: true })
          .fill("project");
        await page
          .getByRole("textbox", { name: "Tag name", exact: true })
          .press("Enter");
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
                  tags: ["project"],
                  creatorIndex: -1,
                  level: 6,
                },
              }),
            );
          });
          await page.reload();
          await browserExpect(page.locator("#input")).toHaveValue(
            "Recovered remote draft",
          );
          await browserExpect(page.locator("#effort-range")).toHaveValue("6");
        }
        const level = size === "desktop" ? 4 : remoteDefault;
        if (size === "desktop") await pickRemoteLevel4("draft");
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
        const creationBody = (await creation).postDataJSON();
        expect(creationBody.level).toBe(size === "desktop" ? 4 : undefined);
        expect(creationBody.tags).toEqual(["project"]);
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
        expect(conversation.tags.project).toMatchObject({ by: "operator" });
        expect(conversation.safety_off).not.toBe(true);
        expect(conversation).toMatchObject({
          level,
          effort: remoteLadder.levels[String(level)].reasoning,
        });
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
        if (size === "mobile") {
          await page.locator("#input").blur();
          await page.locator("#menu-btn").click();
        }
        await browserExpect(
          section.locator(`.agent[data-id="${qualified}"]`),
        ).toBeVisible();
        if (size === "desktop") {
          const row = section.locator(`.agent[data-id="${qualified}"]`);
          const sectionOf = () =>
            row.evaluate((element) => {
              let previous = element.previousElementSibling;
              while (previous && !previous.matches(".tree-section-header"))
                previous = previous.previousElementSibling;
              const key = (previous as any)?.dataset.sectionKey;
              return key ? JSON.parse(key).slice(1).join("/") : undefined;
            });
          await browserExpect.poll(sectionOf).toBe("project/Inbox");
          expect(
            (
              await remoteContext.request.post(
                `${remote.base}api/v1/agents/tags`,
                { data: { ids: [id], set: { project: null }, clear: [] } },
              )
            ).ok(),
          ).toBe(true);
          await browserExpect(row.getByTitle("Tag: project")).toBeVisible();
          await browserExpect.poll(sectionOf).toBe("project/Inbox");
          const projectInbox = section.locator(
            `.tree-section-header[data-section-key='${JSON.stringify(["Laptop", "project", "Inbox"])}'] .tree-section-toggle`,
          );
          await projectInbox.click();
          await browserExpect(projectInbox).toHaveAttribute(
            "aria-expanded",
            "false",
          );
          await page.clock.pauseAt(
            await page.evaluate(() => Date.now() + 1000),
          );
          const tag = `agent-${size}`;
          const tagged = Bun.spawn(
            [
              process.execPath,
              join(ROOT, "tools/subagent.ts"),
              "tag",
              id,
              "--add",
              tag,
            ],
            {
              cwd: ROOT,
              env: {
                ...process.env,
                CHAT_DATA_DIR: join(remote.data, "data"),
                RECURSE_HOME: join(remote.data, "settings"),
                RECURSE_AGENT_ID: agent,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          expect(await tagged.exited).toBe(0);
          await browserExpect(row.getByTitle(`Tag: ${tag}`)).toBeVisible();
          await browserExpect.poll(sectionOf).toBe(`${tag}/Inbox`);
          await browserExpect(
            section.locator(
              `.tree-section-header[data-section-key='${JSON.stringify(["Laptop", tag, "Inbox"])}'] .tree-section-toggle`,
            ),
          ).toHaveAttribute("aria-expanded", "true");
          await page.clock.resume();
          expect(
            (
              await remoteContext.request.post(
                `${remote.base}api/v1/agents/tags`,
                {
                  data: { ids: [id], clear: ["project", tag] },
                },
              )
            ).ok(),
          ).toBeTrue();
          await browserExpect.poll(sectionOf).toBe("Inbox");
          for (const [action, destination] of [
            ["Pin", "Pinned"],
            ["Unpin", "Inbox"],
            ["Archive", "Archive"],
            ["Restore", "Inbox"],
          ]) {
            const saved = page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                response.url().endsWith("/api/backends/Laptop/v1/agents/tags"),
            );
            await row.hover();
            await row
              .getByRole("button", {
                name: new RegExp(`^${action} `),
              })
              .click();
            expect((await saved).ok()).toBe(true);
            await browserExpect.poll(sectionOf).toBe(destination);
            const tags = (
              await (
                await remoteContext.request.get(
                  `${remote.base}api/v1/agents/${id}`,
                )
              ).json()
            ).tags;
            await browserExpect(
              section.locator('.tree-section-header[data-section="Pinned"]'),
            ).toHaveCount(action === "Pin" ? 1 : 0);
            await browserExpect(
              page.locator(
                '#agent-list > .tree-section-header[data-section="Pinned"]',
              ),
            ).toHaveCount(0);
            if (action === "Pin") expect(tags.pinned.by).toBe("operator");
            if (action === "Archive") expect(tags.archived.by).toBe("operator");
          }
          await row.hover();
          await row
            .getByRole("button", {
              name: /^Snooze /,
            })
            .click();
          const snoozed = page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/api/backends/Laptop/v1/agents/tags"),
          );
          await page
            .getByRole("dialog", { name: "Snooze until" })
            .getByRole("button", { name: "1 hour", exact: true })
            .click();
          expect((await snoozed).ok()).toBe(true);
          await browserExpect.poll(sectionOf).toBe("Archive");
          const restored = page.waitForResponse(
            (response) =>
              response.request().method() === "POST" &&
              response.url().endsWith("/api/backends/Laptop/v1/agents/tags"),
          );
          await row.hover();
          await row
            .getByRole("button", {
              name: /^Restore /,
            })
            .click();
          expect((await restored).ok()).toBe(true);
          await browserExpect.poll(sectionOf).toBe("Inbox");
          expect(
            (
              await remoteContext.request.post(
                `${remote.base}api/v1/agents/tags`,
                {
                  data: { ids: [id], set: { project: null } },
                },
              )
            ).ok(),
          ).toBeTrue();
          await browserExpect.poll(sectionOf).toBe("project/Inbox");
          await browserExpect(projectInbox).toHaveAttribute(
            "aria-expanded",
            "false",
          );
          await page.screenshot({
            path: join(
              process.env.RECURSE_SCREENSHOT_DIR ?? tmpdir(),
              "remote-sections-desktop.png",
            ),
            animations: "disabled",
          });
          omitTagSupport = true;
          await page.reload();
          await browserExpect(row.getByTitle("Tag: project")).toBeVisible();
          await browserExpect(row.locator(".row-actions button")).toHaveCount(
            0,
          );
          omitTagSupport = false;
          await page.addInitScript(() => {
            const w = globalThis as any;
            const original = w.fetch;
            w.fetch = (input: unknown, init?: RequestInit) => {
              if (w.top !== w || String(input) !== "/api/backends")
                return original(input, init);
              const headers = new Headers(init?.headers);
              headers.set("x-reloaded-document", "1");
              return original(input, { ...init, headers });
            };
          });
          const listings: number[] = [];
          const listing = (url: URL) => url.pathname === "/api/backends";
          await page.route(listing, async (route) => {
            if (!route.request().headers()["x-reloaded-document"])
              return route.continue();
            if (!listings.length) {
              listings.push(502);
              return route.fulfill({ status: 502 });
            }
            const response = await route.fetch();
            listings.push(response.status());
            return route.fulfill({ response });
          });
          await page.reload();
          await browserExpect(row).toHaveClass(/\bselected\b/);
          expect(listings.slice(0, 2)).toEqual([502, 200]);
          expect(new URL(page.url()).hash).toBe(
            `#agent=${encodeURIComponent(qualified)}`,
          );
          await browserExpect(row.locator(".row-actions button")).toHaveCount(
            3,
          );
          await page.unroute(listing);
        }
        await page.screenshot({
          path: join(tmpdir(), `remote-new-agent-${size}.png`),
          animations: "disabled",
        });
        if (size === "mobile") {
          await page.locator("#sidebar .agent.selected").click();
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
      const homeRoot = (
        await (await context.request.get(base + "api/tree")).json()
      ).find(
        (node: { id: string; parent: string | null }) =>
          !node.parent && node.id !== homeMatch.id,
      ).id;
      await page.locator(`.agent[data-id="${homeRoot}"]`).click();
      await browserExpect(page.locator("#input")).toBeEnabled();
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
        await focusComposer(page);
        await page.locator("#model-trigger").click();
        await (
          off
            ? page.locator("#safety-btn")
            : page.getByRole("switch", {
                name: /^Safety review off \(Yolo mode\)/,
              })
        ).click();
        if (off)
          await page
            .getByRole("button", {
              name: "Turn off safety review",
              exact: true,
            })
            .click();
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
      await page.evaluate(() => {
        (globalThis as any).sessionStorage.setItem("stallRemoteDiscovery", "1");
      });
      await page.reload();
      await page.waitForFunction("globalThis.remoteDiscoveryStalled === true");
      await page
        .locator(".msg.assistant")
        .filter({ hasText: "RECORDED_READ_OK" })
        .waitFor();
      expect(
        await page.evaluate(() => (globalThis as any).remoteDiscoveryCancelled),
      ).toBe(true);
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
      await pickRemoteLevel4("conversation");
      expect((await switched).ok()).toBe(true);
      await page.keyboard.press("Escape");
      await browserExpect(page.locator("#model-trigger")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
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
      await page.locator("#input").fill("/rename Composer remote");
      await page.locator("#input").press("Enter");
      await browserExpect(
        section.locator(`.agent[data-id="Laptop/${writable.id}"] .title`),
      ).toHaveText("Composer remote");
      await browserExpect
        .poll(async () => {
          const rows = await (
            await remoteContext.request.get(`${remote.base}api/tree`)
          ).json();
          return rows.find((node: { id: string }) => node.id === writable.id)
            ?.title;
        })
        .toBe("Composer remote");
      expect(
        await page.locator(".msg.user", { hasText: "/rename" }).count(),
      ).toBe(0);
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
              ).taken_over,
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
      const runningTree = page.waitForResponse(async (response) => {
        if (
          !response.url().endsWith("/api/backends/Laptop/tree") ||
          !response.ok()
        )
          return false;
        const nodes = (await response.json()) as {
          id: string;
          status: string;
        }[];
        return nodes.some(
          (node) => node.id === stopped.agent && node.status === "running",
        );
      });
      await page.locator("#input").fill("Run until stopped");
      await page.locator("#send").click();
      await page.locator(".working.status-bar").waitFor();
      await page.locator("#conv-status.running").waitFor();
      await runningTree;
      await browserExpect
        .poll(async () =>
          section
            .locator(`.agent[data-id="Laptop/${stopped.agent}"]`)
            .evaluate((element) => {
              let previous = element.previousElementSibling;
              while (previous && !previous.matches(".tree-section-header"))
                previous = previous.previousElementSibling;
              return (previous as any)?.dataset.section;
            }),
        )
        .toBe("Active");
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
      const localUpdates: Route[] = [];
      let localArrived = () => {};
      await page.route(`${base}api/settings/update`, (route) => {
        localUpdates.push(route);
        localArrived();
      });
      const nextLocalUpdate = async () => {
        while (!localUpdates.length)
          await new Promise<void>((resolve) => (localArrived = resolve));
        return localUpdates.shift()!;
      };
      const updateReads: string[] = [];
      const recordUpdateRead = (request: { url(): string }) => {
        if (new URL(request.url()).pathname.endsWith("/settings/update"))
          updateReads.push(request.url());
      };
      page.on("request", recordUpdateRead);
      await page.route(`${base}api/backends/Laptop/version`, (route) =>
        route.fulfill({
          json: { release: { version: "9.9.9", commit: "remote1" } },
        }),
      );
      const localStatus = (checking: boolean) => ({
        json: {
          release: { version: "0.1.0", commit: null },
          skipped: null,
          checking,
          channel: "release",
          installed: checking ? null : "v0.1.0",
          available: checking ? null : "v0.2.0",
          checked_at: 1,
          error: null,
          update: null,
        },
      });
      const footer = page.locator("#settings-release");
      const switchToRemote = async (held: Route) => {
        const cancelled = page.waitForEvent(
          "requestfailed",
          (request) => request === held.request(),
        );
        updateReads.length = 0;
        await page.locator("#settings-backend").selectOption("Laptop");
        await cancelled;
        await browserExpect(footer.locator(".settings-version")).toHaveText(
          "Recurse 9.9.9 (remote1)",
        );
        expect(updateReads).toEqual([]);
        await held.fulfill(localStatus(false));
        await browserExpect(footer.locator(".settings-version")).toHaveText(
          "Recurse 9.9.9 (remote1)",
        );
        await browserExpect(footer.locator(".settings-version")).toBeVisible();
        await browserExpect(footer.getByRole("status")).toHaveText("");
        await browserExpect(footer.locator(".update-now")).toBeHidden();
      };
      await openSettingsPanel(page);
      const settingsNav = page.locator("#settings-nav button");
      await browserExpect(settingsNav).toHaveCount(6);
      await switchToRemote(await nextLocalUpdate());
      await page.locator("#settings-backend").selectOption("");
      await (await nextLocalUpdate()).fulfill(localStatus(true));
      await browserExpect(footer.getByRole("status")).toHaveText(
        "Checking for updates…",
      );
      await switchToRemote(await nextLocalUpdate());
      expect(localUpdates).toHaveLength(0);
      page.off("request", recordUpdateRead);
      await page.unroute(`${base}api/settings/update`);
      await browserExpect(settingsNav).toHaveText([
        "Providers",
        "Models",
        "Agents",
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
      await settingsNav.getByText("Providers", { exact: true }).click();
      const claudeDetails = page.getByRole("region", {
        name: "Claude",
        exact: true,
      });
      await page.getByRole("button", { name: /^Claude / }).click();
      await claudeDetails.locator(".sub").click();
      await loginSeen;
      await page.locator("#settings-backend").selectOption("");
      const loginFinished = page.waitForEvent(
        "requestfinished",
        (request) => request.url() === loginUrl,
      );
      releaseLogin();
      await loginFinished;
      expect(await page.locator(".paste-sign-in").count()).toBe(0);
      await page.unroute(loginUrl);
      await page.locator("#settings-backend").selectOption("Laptop");
      await settingsNav.getByText("Models", { exact: true }).click();
      await page
        .getByRole("button", { name: /^Maximum context window / })
        .click();
      const windowDetails = page.getByRole("region", {
        name: "Maximum context window",
        exact: true,
      });
      const windowInput = windowDetails.locator("#maximum-context-window");
      await browserExpect(windowInput).not.toHaveValue("");
      await windowInput.fill("123456");
      const savedWindow = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response
            .url()
            .endsWith("/api/backends/Laptop/settings/maximum-context-window"),
      );
      await windowInput.press("Enter");
      expect((await savedWindow).ok()).toBe(true);
      const windowOf = async (request: typeof context.request, at: string) =>
        (
          await (
            await request.get(`${at}api/settings/maximum-context-window`)
          ).json()
        ).maximum_context_window;
      expect(await windowOf(remoteContext.request, remote.base)).toBe(123456);
      expect(await windowOf(context.request, base)).not.toBe(123456);
      await settingsNav.getByText("Agents", { exact: true }).click();
      await browserExpect(page.locator(".settings-section h3")).toHaveText([
        "MCP servers",
      ]);
      await page.getByRole("button", { name: /^MCP servers / }).click();
      const mcpDetails = page.getByRole("region", {
        name: "MCP servers",
        exact: true,
      });
      await mcpDetails
        .getByText("Sign in to MCP servers on Laptop from its own page", {
          exact: false,
        })
        .waitFor();
      const customKeysUrl = `${base}api/backends/Laptop/pi/custom-provider-auth`;
      for (const failure of [
        (route: Route) =>
          route.fulfill({ status: 403, json: { error: "Forbidden" } }),
        (route: Route) => route.abort("failed"),
      ]) {
        await page.route(customKeysUrl, failure, { times: 1 });
        await settingsNav.getByText("Agents", { exact: true }).click();
        const read = page.waitForRequest(customKeysUrl);
        await settingsNav.getByText("Providers", { exact: true }).click();
        await read;
        const customKeys = page.locator('.customkeys[aria-busy="false"]');
        await customKeys.waitFor({ state: "attached" });
        await browserExpect(
          page.getByRole("heading", { name: "Custom model keys", exact: true }),
        ).toBeVisible();
        await browserExpect(customKeys.locator("> *")).toHaveCount(0);
        const message = page.locator(".customkeys + .msg");
        await browserExpect(message).toHaveText(
          "Couldn't load custom model keys.",
        );
        await browserExpect(message).toBeVisible();
      }
      await page.locator("#settings-backend").selectOption("");
      await browserExpect(settingsNav).toHaveCount(6);
      await page.locator("#settings-close").click();
      await page.goto(`${base}#agent=Laptop/${writable.id}`);
      await page.locator("#input").waitFor();
      await page.evaluate(() => {
        (globalThis as any).remoteSidebarNoReload = true;
      });
      for (const name of ["spare-home", "spare-two", "spare-three"])
        expect(
          (
            await remoteContext.request.post(`${remote.base}api/backend-keys`, {
              data: { password: LOGIN, name },
            })
          ).status(),
        ).toBe(200);
      await openSettingsPanel(remotePage);
      await remotePage
        .locator('#settings-nav button[data-cat="remotes"]')
        .click();
      const incoming = remotePage.locator(".remotes-settings .remote-incoming");
      const homesList = incoming.locator(".group");
      const homes = incoming.locator(".remote-entry");
      const homeLabels = homes.locator(
        ":scope > .settings-row .settings-row-label",
      );
      await browserExpect(homes).toHaveCount(4);
      const homeName = await homeLabels
        .filter({ hasNotText: /^spare-/ })
        .innerText();
      await browserExpect(homeLabels).toHaveText([
        homeName,
        "spare-home",
        "spare-two",
        "spare-three",
      ]);
      const openHome = (name: string) =>
        incoming.getByRole("button", { name: new RegExp(`^${name} `) }).click();
      const backToRemotes = remotePage.getByRole("button", {
        name: "Back to Remotes",
        exact: true,
      });
      await openHome(homeName);
      const homeDetails = remotePage.getByRole("region", {
        name: homeName,
        exact: true,
      });
      await browserExpect(
        homeDetails.getByText(
          /^Created .+ · last seen .+ · agents here reach it as @/,
        ),
      ).toBeVisible();
      await browserExpect(homeDetails.locator(".hint")).toHaveCount(0);
      const revoke = homeDetails.getByRole("button", {
        name: "Revoke access",
        exact: true,
      });
      await expectHitCorners(revoke);
      const held: Route[] = [];
      let arrived = () => {};
      await remotePage.route(/\/api\/backend-keys(\/[^/]+)?$/, (route) => {
        held.push(route);
        arrived();
      });
      const nextRequest = async (method: string) => {
        while (!held.length)
          await new Promise<void>((resolve) => (arrived = resolve));
        const route = held.shift()!;
        expect(route.request().method()).toBe(method);
        return route;
      };
      const revokeHome = (name: string) =>
        remotePage
          .getByRole("region", { name, exact: true })
          .getByRole("button", { name: "Revoke access", exact: true })
          .click();
      await backToRemotes.click();
      await remotePage.setViewportSize({ width: 412, height: 800 });
      await openHome("spare-three");
      await revokeHome("spare-three");
      await (await nextRequest("DELETE")).continue();
      await (await nextRequest("GET")).continue();
      await browserExpect(homeLabels).toHaveText([
        homeName,
        "spare-home",
        "spare-two",
      ]);
      const focusedRow = remotePage.locator(
        ".settings-cat:not([hidden]) .settings-row:focus",
      );
      await browserExpect(focusedRow).toBeVisible();
      await expectHitCorners(focusedRow);
      await remotePage.setViewportSize({ width: 1280, height: 720 });
      await openHome("spare-two");
      await revokeHome("spare-two");
      const twoDelete = await nextRequest("DELETE");
      await backToRemotes.click();
      await openHome(homeName);
      await browserExpect(backToRemotes).toBeFocused();
      await twoDelete.continue();
      const twoRead = await nextRequest("GET");
      const listed = await (await twoRead.fetch()).json();
      await twoRead.fulfill({
        json: listed.map((home: { name: string }) =>
          home.name === homeName ? { ...home, label: "renamed-home" } : home,
        ),
      });
      await browserExpect(homeLabels).toHaveText([homeName, "spare-home"]);
      await browserExpect(homesList).toHaveAttribute("aria-busy", "false");
      await browserExpect(homeDetails).toBeVisible();
      await browserExpect(
        homeDetails.getByText(/ · agents here reach it as @renamed-home$/),
      ).toBeVisible();
      await browserExpect(backToRemotes).toBeVisible();
      await browserExpect(backToRemotes).toBeFocused();
      await backToRemotes.click();
      await openHome("spare-home");
      await revokeHome("spare-home");
      const spareDelete = await nextRequest("DELETE");
      await backToRemotes.click();
      await openHome(homeName);
      await revoke.click();
      const homeDelete = await nextRequest("DELETE");
      await spareDelete.continue();
      const olderRead = await nextRequest("GET");
      await browserExpect(homesList).toHaveAttribute("aria-busy", "true");
      await browserExpect(homeLabels).toHaveText([homeName, "spare-home"]);
      const olderCancelled = remotePage.waitForEvent(
        "requestfailed",
        (request) => request === olderRead.request(),
      );
      await homeDelete.continue();
      const newerRead = await nextRequest("GET");
      await olderCancelled;
      await browserExpect(homesList).toHaveAttribute("aria-busy", "true");
      await browserExpect(homesList).toBeVisible();
      await browserExpect(homeLabels).toHaveText([homeName, "spare-home"]);
      await newerRead.continue();
      await browserExpect(homesList).toHaveAttribute("aria-busy", "false");
      await browserExpect(incoming).toBeHidden();
      await browserExpect(
        remotePage.getByRole("button", { name: "Add a remote", exact: true }),
      ).toBeFocused();
      await olderRead.fulfill({
        json: [
          {
            id: "stale",
            name: "stale-home",
            created: 1_790_000_000,
            last_used: null,
            last_client: null,
            url: null,
            label: "stale-home",
          },
        ],
      });
      await browserExpect(homesList).toHaveAttribute("aria-busy", "false");
      await browserExpect(homesList).toHaveText("");
      await browserExpect(incoming).toBeHidden();
      expect(held).toHaveLength(0);
      await remotePage.unroute(/\/api\/backend-keys(\/[^/]+)?$/);
      await remotePage.locator("#settings-close").click();
      await page.locator("#input").fill("This send must fail visibly");
      await page.locator("#send").click();
      await page.getByText(/key was revoked.*Retry now/).waitFor();
      await section
        .getByText("key revoked", { exact: true })
        .waitFor({ timeout: 20_000 });
      await section.locator(".backend-settings").click();
      await browserExpect(
        page.locator('#settings-nav button[data-cat="remotes"]'),
      ).toBeFocused();
      await browserExpect(
        page.getByRole("heading", { name: "Remotes", exact: true }),
      ).toBeVisible();
      await page.locator("#settings-close").click();
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
      await installDependencies(legacySource);
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
