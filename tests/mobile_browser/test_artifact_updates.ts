import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { expect as browserExpect } from "playwright/test";
import * as artifacts from "../../src/artifacts";
import {
  ARTIFACT,
  ARTIFACT_VERSION,
  LOGIN,
  captureErrors,
  gotoRoot,
  openPage,
  rootAgentId,
  runBrowserTests,
  startServer,
  stopServer,
  type BrowserTest,
} from "./common";

type ArtifactRemote = {
  base: string;
  data: string;
  root: string;
  cookie: string;
};

async function withRemoteArtifactServer(
  base: string,
  label: string,
  test: (remote: ArtifactRemote) => Promise<void>,
): Promise<void> {
  const remote = await startServer({ auth: true });
  let testFailed = false;
  try {
    await test(remote);
  } catch (error) {
    testFailed = true;
    throw error;
  } finally {
    const errors: unknown[] = [];
    try {
      const response = await fetch(`${base}api/backends/${label}`, {
        method: "DELETE",
      });
      if (!response.ok && !(testFailed && response.status === 404))
        throw Error(`Could not disconnect ${label}: HTTP ${response.status}`);
    } catch (error) {
      errors.push(error);
    }
    try {
      await stopServer(remote);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      const failure = new AggregateError(errors, `Cleanup failed for ${label}`);
      if (!testFailed) throw failure;
      console.error(failure);
    }
  }
}

async function assertRemoteAppRevalidation(
  browser: Browser,
  base: string,
  remote: ArtifactRemote,
): Promise<void> {
  const { cookie, root: remoteOwner } = remote;
  const remoteContext = {
    artifactsDir: join(remote.data, "data", "artifact_repos"),
    trashDir: join(remote.data, "data", "trash"),
  };
  const app = await artifacts.create(remoteContext, {
    owner: remoteOwner,
    title: "Remote app",
  });
  await writeFile(
    join(String(app.repo_path), "index.html"),
    '<button id="count" onclick="this.textContent=\'clicked\'">click</button>',
  );
  const published = await artifacts.publish(
    remoteContext,
    remoteOwner,
    String(app.id),
  );
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  expect(
    (
      await page.request.post(base + "api/backends", {
        data: { label: "CacheRemote", url: remote.base, password: LOGIN },
      })
    ).ok(),
  ).toBeTrue();
  const path = `/api/backends/CacheRemote/artifacts/${app.id}/page`;
  const initial = page.waitForResponse(
    (response) => new URL(response.url()).pathname === path,
  );
  void initial.catch(() => {});
  await page.goto(
    `${base}#agent=${encodeURIComponent(`CacheRemote/${remoteOwner}`)}&artifact=${app.id}`,
  );
  const frame = page.frameLocator("iframe.artifact-embed-page");
  await frame.locator("#count").click();
  await frame.getByText("clicked", { exact: true }).waitFor();
  const pane = page.locator('.pane-col[data-pane="report"]');
  await pane.locator(".pane-body").focus();
  await page.keyboard.press("h");
  await pane.locator(".artifact-list").waitFor();
  await page.keyboard.press("Enter");
  await frame.getByText("clicked", { exact: true }).waitFor();
  const etag = (await initial).headers().etag;
  expect(etag).toBeTruthy();
  const unauthorized = await fetch(
    `${remote.base}api/artifacts/${app.id}/page?agent=${remoteOwner}&version=${published.version}`,
    { headers: { "If-None-Match": etag! } },
  );
  expect(unauthorized.status).not.toBe(304);
  expect(unauthorized.ok).toBeFalse();
  const revalidation = page.waitForRequest(
    (request) => new URL(request.url()).pathname === path,
  );
  void revalidation.catch(() => {});
  await page.reload();
  expect((await (await revalidation).allHeaders())["if-none-match"]).toBe(etag);
  await frame.locator("#count").click();
  await frame.getByText("clicked", { exact: true }).waitFor();
  await mkdir(join(remote.data, "data/config"), { recursive: true });
  await writeFile(
    join(remote.data, "data/config/themes.json"),
    JSON.stringify({ theme: "Ocean" }),
  );
  const themed = await fetch(
    `${remote.base}api/artifacts/${app.id}/page?agent=${remoteOwner}&version=${published.version}`,
    {
      headers: { cookie, "If-None-Match": etag! },
    },
  );
  expect(themed.status).toBe(200);
  expect(themed.headers.get("etag")).not.toBe(etag);
  await page.close();
}

export const tests: BrowserTest[] = [
  // Feature: #2728 Git commits publish into the already-open Artifact pane.
  async function test_artifact_commit_updates_open_pane(browser, base, data) {
    const page = await browser.newPage();
    await gotoRoot(page, base);
    await page.locator(`.agent.selected[data-id="${rootAgentId()}"]`).waitFor();
    const context = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    for (const kind of ["document", "app"]) {
      const item = await artifacts.create(context, {
        owner: rootAgentId(),
        title: `Commit ${kind}`,
      });
      const repo = String(item.repo_path);
      const entry = kind === "document" ? "index.md" : "index.html";
      const content = (text: string) =>
        kind === "document"
          ? `# ${text}`
          : `<h1>${text}</h1><button>Try</button>`;
      await writeFile(join(repo, entry), content("Initial commit"));
      await artifacts.publish(context, rootAgentId(), String(item.id));
      await page.goto(`${base}#artifact=${item.id}`);
      const visible = (text: string) =>
        kind === "document"
          ? page.getByRole("heading", { name: text, exact: true })
          : page
              .frameLocator("iframe.artifact-embed-page")
              .getByRole("heading", {
                name: text,
                exact: true,
              });
      await visible("Initial commit").waitFor();
      await writeFile(join(repo, entry), content("Committed update"));
      await Bun.$`git -C ${repo} add --all`.quiet();
      const start = performance.now();
      const commit = Bun.spawn(
        ["git", "-C", repo, "commit", "-m", `Update ${kind}`],
        {
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      let output = "";
      let published: number | undefined;
      const completion = (async () => {
        for await (const chunk of commit.stderr) {
          output += new TextDecoder().decode(chunk);
          if (published === undefined && /"command":\s*"publish"/.test(output))
            published = Math.round(performance.now() - start);
        }
        return {
          exitCode: await commit.exited,
          completed: Math.round(performance.now() - start),
        };
      })();
      await visible("Committed update").waitFor();
      console.log(
        `ARTIFACT_LATENCY ${kind} viewer=${Math.round(performance.now() - start)}ms`,
      );
      const { exitCode, completed } = await completion;
      console.log(
        `ARTIFACT_LATENCY ${kind} published=${published}ms completion=${completed}ms`,
      );
      expect(exitCode).toBe(0);
      const head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim();
      expect(
        (await artifacts.get(context, rootAgentId(), String(item.id))).version,
      ).toBe(head);
      if (kind === "app") {
        expect(output).toMatch(/"command":\s*"check"/);
        expect(output).toMatch(/"ok":\s*true/);
        await writeFile(
          join(repo, entry),
          '<script type="module" src="./missing.ts"></script>',
        );
        await Bun.$`git -C ${repo} add --all`.quiet();
        const failed =
          await Bun.$`git -C ${repo} commit -m ${"Broken app"}`.quiet();
        expect(failed.stderr.toString()).toMatch(/"code":\s*"build"/);
        expect(
          (await artifacts.get(context, rootAgentId(), String(item.id)))
            .version,
        ).toBe(head);
        await visible("Committed update").waitFor();
      }
    }
    await page.close();
  },

  // Regression: #2740 content settled with Refresh disabled until an unrelated toolbar render.
  async function test_artifact_disk_publication_refresh(browser, base, data) {
    await withRemoteArtifactServer(base, "ArtifactRemote", async (remote) => {
      const remoteOwner = remote.root;
      for (const [directory, label, owner] of [
        [data, "", rootAgentId()],
        [remote.data, "ArtifactRemote", remoteOwner],
      ] as const) {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        const errors = captureErrors(page);
        await page.addInitScript(() => {
          const dom = globalThis as any;
          new dom.MutationObserver((records: any[]) => {
            for (const record of records) {
              const pane = record.target;
              if (
                record.attributeName !== "aria-busy" ||
                pane.getAttribute("aria-busy") !== "false" ||
                !pane.textContent?.includes("Initial disk content")
              )
                continue;
              const refresh = pane.parentElement?.querySelector(
                ".artifact-refresh-btn",
              );
              if (
                refresh &&
                (globalThis as any).__settledArtifactRefreshDisabled ===
                  undefined
              )
                (globalThis as any).__settledArtifactRefreshDisabled =
                  refresh.disabled;
            }
          }).observe(dom.document, { subtree: true, attributes: true });
        });
        const agent = label ? `${label}/${owner}` : owner;
        const apiBase = label ? `/api/backends/${label}` : "/api";
        if (label) {
          expect(
            (
              await page.request.post(base + "api/backends", {
                data: { label, url: remote.base, password: LOGIN },
              })
            ).ok(),
          ).toBeTrue();
          await page.goto(base);
          await page
            .locator(
              `.backend-section[data-backend="${label}"] .agent[data-id="${agent}"]`,
            )
            .waitFor();
        }
        const context = {
          artifactsDir: join(directory, "data", "artifact_repos"),
          trashDir: join(directory, "data", "trash"),
        };
        const item = await artifacts.create(context, {
          owner,
          title: "Disk refresh",
        });
        const repo = String(item.repo_path);
        const publish = async (text: string) => {
          await writeFile(
            join(repo, "index.md"),
            `${text}\n\n![Disk image](figure.svg)`,
          );
          await writeFile(
            join(repo, "figure.svg"),
            `<svg xmlns="http://www.w3.org/2000/svg" width="${text.length * 10}" height="40"><rect width="100%" height="100%" fill="steelblue"/></svg>`,
          );
          await artifacts.publish(context, owner, String(item.id));
        };
        await publish("Initial disk content");
        const revisionRead = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            `${apiBase}/artifacts/revision`,
        );
        void revisionRead.catch(() => {});
        await page.goto(
          `${base}#agent=${encodeURIComponent(agent)}&artifact=${item.id}`,
        );
        await page.getByText("Initial disk content", { exact: true }).waitFor();
        await page.waitForFunction(
          () =>
            typeof (globalThis as any).__settledArtifactRefreshDisabled ===
            "boolean",
        );
        expect(
          await page.evaluate(
            () => (globalThis as any).__settledArtifactRefreshDisabled,
          ),
        ).toBeFalse();
        const revision = await revisionRead;
        expect(revision.status()).toBe(200);
        expect(new URL(revision.url()).searchParams.get("agent")).toBe(owner);
        const waitForRevision = async (
          expected: string | null,
          etag?: string,
        ) => {
          expect(typeof expected).toBe("string");
          const deadline = performance.now() + 2000;
          for (;;) {
            const response = await page.request.get(
              base + apiBase.slice(1) + "/tree",
              {
                headers: etag ? { "If-None-Match": etag } : {},
              },
            );
            const actual =
              response.status() === 200
                ? (await response.json()).find((row: any) => row.id === owner)
                    ?.artifacts_revision
                : null;
            if (actual === expected || performance.now() >= deadline) {
              expect(response.status()).toBe(200);
              expect(actual).toBe(expected);
              return response;
            }
            await Bun.sleep(100);
          }
        };
        const oldRevision = await artifacts.revision(context, owner);
        const treeResponse = await waitForRevision(oldRevision);
        const treeEtag = treeResponse.headers().etag!;
        expect(
          (
            await page.request.get(base + apiBase.slice(1) + "/tree", {
              headers: { "If-None-Match": treeEtag },
            })
          ).status(),
        ).toBe(304);
        const fileRequests: string[] = [];
        page.on("request", (request) => {
          if (
            new URL(request.url()).pathname.endsWith(
              `/artifacts/${item.id}/file`,
            )
          )
            fileRequests.push(request.url());
        });
        await publish("Manually refreshed disk content");
        const publishedRevision = await artifacts.revision(context, owner);
        expect(publishedRevision).not.toBe(oldRevision);
        const changedTree = await waitForRevision(publishedRevision, treeEtag);
        expect(changedTree.headers().etag).not.toBe(treeEtag);
        await page
          .getByRole("button", { name: "Refresh artifact", exact: true })
          .click({ timeout: 2000 });
        await page
          .getByText("Manually refreshed disk content", { exact: true })
          .waitFor({ timeout: 2000 });
        await page.waitForFunction(
          () =>
            (globalThis as any).document.querySelector(".artifact-image")
              ?.naturalWidth ===
            "Manually refreshed disk content".length * 10,
        );
        expect(
          fileRequests.some(
            (url) => new URL(url).searchParams.get("path") === "figure.svg",
          ),
        ).toBeTrue();
        fileRequests.length = 0;
        await Promise.all([
          page.waitForRequest(
            (request) =>
              new URL(request.url()).searchParams.get("path") === "figure.svg",
          ),
          page
            .getByRole("button", { name: "Refresh artifact", exact: true })
            .click(),
        ]);
        const text = "Automatically refreshed disk content";
        await publish(text);
        const paragraph = page.getByRole("paragraph").filter({ hasText: text });
        await paragraph.waitFor({ timeout: 2000 });
        expect(
          fileRequests.every((url) =>
            new URL(url).pathname.startsWith(apiBase + "/"),
          ),
        ).toBeTrue();
        if (label) {
          await paragraph.scrollIntoViewIfNeeded();
          const box = (await paragraph.boundingBox())!;
          const y = box.y + box.height / 2;
          await page.mouse.move(box.x + 1, y);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width - 1, y, { steps: 6 });
          await page.mouse.up();
          await page
            .getByRole("textbox", { name: "Comment on selected text" })
            .fill("Keep this unsent comment");
          const latest = await artifacts.get(context, owner, String(item.id));
          await artifacts.deleteArtifact(
            context,
            owner,
            String(item.id),
            String(latest.version),
          );
          await browserExpect(paragraph).toBeHidden();
          await browserExpect(
            page.getByRole("textbox", { name: `Comment on “${text}”` }),
          ).toHaveValue("Keep this unsent comment");
        }
        expect(errors).toEqual([]);
        await page.close();
      }
    });
  },

  async function test_remote_artifact_app_revalidates(browser, base) {
    await withRemoteArtifactServer(base, "CacheRemote", (remote) =>
      assertRemoteAppRevalidation(browser, base, remote),
    );
  },

  // Regression: #2497 an open Artifact waited for the 15-second list refresh during a turn.
  async function test_artifact_follows_publication_during_running_turn(
    browser,
    base,
    data,
  ) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const { agent } = await (
      await page.request.post(`${base}__browser-test/seed-live-tools`, {
        data: { mode: "long" },
      })
    ).json();
    const context = {
      artifactsDir: join(data, "data", "artifact_repos"),
      trashDir: join(data, "data", "trash"),
    };
    const item = await artifacts.create(context, {
      owner: agent,
      title: "Live publication",
    });
    const repo = String(item.repo_path);
    await writeFile(
      join(repo, "index.html"),
      "<!doctype html><body>Initial version</body>",
    );
    const initial = await artifacts.publish(context, agent, String(item.id));
    await page.goto(`${base}#agent=${agent}&artifact=${item.id}`);
    await page
      .frameLocator("iframe.artifact-embed-page")
      .getByText("Initial version", { exact: true })
      .waitFor();
    const delivered = await page.request.post(
      `${base}api/conversations/${agent}/deliver`,
      { data: { content: "Run tools." } },
    );
    expect(delivered.ok()).toBeTrue();
    await page
      .locator(`.agent[data-id="${agent}"] .agent-state.running`)
      .waitFor();
    await writeFile(
      join(repo, "index.html"),
      "<!doctype html><body>Latest version</body>",
    );
    const latest = await artifacts.publish(context, agent, String(item.id));
    expect(latest.version).not.toBe(initial.version);
    await page
      .frameLocator("iframe.artifact-embed-page")
      .getByText("Latest version", { exact: true })
      .waitFor({ timeout: 3000 });
    const tree = await (await page.request.get(`${base}api/tree`)).json();
    expect(tree.find((node: { id: string }) => node.id === agent).status).toBe(
      "running",
    );
    await page.close();
  },

  // Regression: #3203 closed Artifact discovery must update availability without another metadata refresh.
  async function test_artifact_published_mid_session_becomes_reachable(
    browser,
    base,
  ) {
    const { context, page, errors } = await openPage(browser, {
      viewport: { width: 390, height: 844 },
      touch: true,
    });
    let published = false;
    let nonemptyHeld = false;
    let metadataHeld = false;
    let releaseArtifacts = () => {};
    let releaseMetadata = () => {};
    const artifactsReady = new Promise<void>(
      (resolve) => (releaseArtifacts = resolve),
    );
    const metadataReady = new Promise<void>(
      (resolve) => (releaseMetadata = resolve),
    );
    await page.exposeFunction("artifactMetadataApplied", () => {
      if (metadataHeld) releaseArtifacts();
    });
    await page.addInitScript(() => {
      const browser = globalThis as any;
      const fetch = browser.fetch.bind(browser);
      browser.fetch = async (...args: any[]) => {
        const response = await fetch(...args);
        const url = new URL(response.url);
        if (
          url.pathname.startsWith("/api/conversations/") &&
          url.searchParams.get("focused") === "1"
        ) {
          const json = response.json.bind(response);
          response.json = async () => {
            const body = await json();
            browser.requestAnimationFrame(() =>
              browser.requestAnimationFrame(() =>
                browser.artifactMetadataApplied(),
              ),
            );
            return body;
          };
        }
        return response;
      };
    });
    await page.route(`${base}api/conversations/*?focused=1`, async (route) => {
      const selected = nonemptyHeld && !metadataHeld;
      if (selected) metadataHeld = true;
      const response = await route.fetch();
      if (metadataHeld && !selected) await metadataReady;
      await route.fulfill({ response });
    });
    await page.route(`${base}api/artifacts**`, async (route) => {
      const url = route.request().url();
      if (url.includes("/file"))
        return route.fulfill({
          body: "# Browser artifact\nVisible body.\n",
          contentType: "text/markdown; charset=utf-8",
        });
      if (url.includes("/versions"))
        return route.fulfill({
          json: [
            {
              version: ARTIFACT_VERSION,
              status: "ready",
              created_at: ARTIFACT.created_at,
            },
          ],
        });
      if (published) {
        nonemptyHeld = true;
        await page.keyboard.press("Shift");
        await artifactsReady;
      }
      return route.fulfill({ json: published ? [ARTIFACT] : [] });
    });
    try {
      const emptyArtifacts = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/artifacts",
      );
      await gotoRoot(page, base);
      await page.locator(".agent").first().waitFor();
      const entry = page.locator(
        '#pane-menu .pane-menu-item[data-pane="report"]',
      );
      await (await emptyArtifacts).finished();
      await entry.waitFor({ state: "detached" });
      expect(await entry.count()).toBe(0);
      published = true;
      await entry.waitFor({ state: "attached", timeout: 25_000 });
      await page.locator("#pane-fab").click();
      await entry.click();
      await page.locator(".report-doc").waitFor();
      expect(errors).toEqual([]);
    } finally {
      releaseArtifacts();
      releaseMetadata();
      await page.unrouteAll({ behavior: "wait" });
      await context.close();
    }
  },
];

if (import.meta.main) await runBrowserTests([["panes-artifacts", tests]]);
