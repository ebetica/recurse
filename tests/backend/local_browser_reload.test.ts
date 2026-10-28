import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildApp, WebLogSink } from "../../src/web/app";
import {
  FrontendCache,
  fillIconSlots,
  frontendGeneration,
} from "../../src/web/static";
import { PRIVATE_REVALIDATE } from "../../src/web/caching";
import { SEND_ICON, SETTINGS_ICON } from "../../web/icons";
import { appWorld } from "./web_app_support";

const ROOT = resolve(import.meta.dir, "../..");
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function sourceRoot(): string {
  const root = temp("recurse-browser-source-");
  mkdirSync(join(root, "web/dist"), { recursive: true });
  copyFileSync(join(ROOT, "web/index.html"), join(root, "web/index.html"));
  copyFileSync(join(ROOT, "web/icons.ts"), join(root, "web/icons.ts"));
  writeFileSync(join(root, "web/dist/app.js"), "console.log('bundle');");
  writeFileSync(join(root, "web/dist/app.css"), "body {}");
  return root;
}

async function client(version: string, live: boolean) {
  const { root, env } = appWorld();
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  env.RECURSE_BROWSER_VERSION = version;
  env.RECURSE_FRONTEND_LIVE = live ? "1" : "0";
  const app = await buildApp({
    env,
    sourceRoot: sourceRoot(),
    sink: new WebLogSink(() => {}),
  });
  cleanup.push(() => app.instance.shutdown());
  const running = await app.serve({ port: 0 });
  cleanup.push(() => running.close());
  return (path: string) => fetch(`${running.url}${path}`);
}

test("test_local_browser_version_is_no_store_and_cache_busted", async () => {
  const get = await client("abc123", false);
  const page = await get("/");
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe(PRIVATE_REVALIDATE);
  const text = await page.text();
  expect(text).toContain('<body data-version="abc123">');
  expect(text).toContain("/static/app.js?v=abc123");
  expect(text).toContain("/static/app.css?v=abc123");
  expect(text).not.toContain("__VERSION__");
  expect(text).not.toContain("data-icon");
  expect(text).toContain(`<button id="settings-btn" title="Settings">
    ${SETTINGS_ICON}`);
  expect(text).toContain(SEND_ICON);

  const version = await get("/api/version");
  expect(version.status).toBe(200);
  const body = (await version.json()) as { version: string; theme: string };
  expect(body.version).toBe("abc123");
  expect(text).toContain(`id="theme" data-version="${body.theme}"`);
  expect(version.headers.get("cache-control")).toBe(PRIVATE_REVALIDATE);
});

test("test_live_frontend_page_uses_content_generation", async () => {
  const get = await client("startup-generation", true);
  const page = await get("/");
  const versionResponse = await get("/api/version");
  const { version } = (await versionResponse.json()) as { version: string };
  expect(version).not.toBe("startup-generation");
  expect(version).toMatch(/^[0-9a-f]{20}$/);
  const text = await page.text();
  expect(text).toContain(`<body data-version="${version}">`);
  expect(text).toContain(`/static/app.js?v=${version}`);
  expect(text).toContain(`/static/app.css?v=${version}`);
  expect(page.headers.get("cache-control")).toBe(PRIVATE_REVALIDATE);
  expect(versionResponse.headers.get("cache-control")).toBe(PRIVATE_REVALIDATE);
});

test("test_unsafe_browser_version_is_not_injected", async () => {
  const get = await client('"</script><script>alert(1)</script>', false);
  const text = await (await get("/")).text();
  expect(text).not.toContain("alert(1)");
  const { version } = (await (await get("/api/version")).json()) as {
    version: string;
  };
  expect(version).toMatch(/^[0-9a-f]{20}$/);
  expect(text).toContain(`<body data-version="${version}">`);
});

test("test_frontend_generation_covers_shell_and_bundle", async () => {
  const dir = temp("recurse-frontend-generation-");
  writeFileSync(join(dir, "app.js"), "first");
  writeFileSync(join(dir, "app.css"), "styles");
  const initial = await frontendGeneration("<body>shell</body>", dir);
  expect(initial).toMatch(/^[0-9a-f]{20}$/);
  writeFileSync(join(dir, "app.js"), "second");
  expect(await frontendGeneration("<body>shell</body>", dir)).not.toBe(initial);
  expect(await frontendGeneration("<body>new shell</body>", dir)).not.toBe(
    await frontendGeneration("<body>shell</body>", dir),
  );
});

async function cache(root: string, fallback: string, live: boolean) {
  let now = 0;
  const frontend = await FrontendCache.create({
    htmlPath: join(root, "index.html"),
    staticDir: join(root, "dist"),
    fallbackShell: fallback,
    fixedVersion: "pinned",
    live,
    nowMs: () => now,
  });
  return { frontend, expire: () => (now += 10_000) };
}

test("test_live_frontend_version_tracks_disk_without_restart", async () => {
  const root = temp("recurse-live-version-");
  const shell = join(root, "index.html");
  writeFileSync(shell, "<body>shell</body>");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/app.js"), "first");
  writeFileSync(join(root, "dist/app.css"), "styles");

  const off = await cache(root, "<body>shell</body>", false);
  expect((await off.frontend.snapshot())[2]).toBe("pinned");
  writeFileSync(join(root, "dist/app.js"), "changed-but-ignored");
  off.expire();
  expect((await off.frontend.snapshot())[2]).toBe("pinned");

  writeFileSync(join(root, "dist/app.js"), "first");
  const on = await cache(root, "<body>fallback</body>", true);
  const v1 = (await on.frontend.snapshot())[2];
  expect(v1).not.toBe("pinned");
  writeFileSync(join(root, "dist/app.js"), "second");
  on.expire();
  const v2 = (await on.frontend.snapshot())[2];
  expect(v2).not.toBe(v1);
  writeFileSync(shell, "<body>new shell</body>");
  on.expire();
  const [liveShell, , v3] = await on.frontend.snapshot();
  expect(v3).not.toBe(v2);
  expect(liveShell).toBe("<body>new shell</body>");

  unlinkSync(shell);
  const missing = await cache(root, "fallback-shell", true);
  expect((await missing.frontend.snapshot())[0]).toBe("fallback-shell");
});

test("test_live_frontend_cache_serves_last_good_without_waiting", async () => {
  const root = temp("recurse-frontend-cache-");
  const shell = join(root, "index.html");
  writeFileSync(shell, "<body>first</body>");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/app.js"), "first-js");
  writeFileSync(join(root, "dist/app.css"), "first-css");
  const { frontend, expire } = await cache(root, "fallback", true);
  const initial = await frontend.snapshot();

  expire();
  writeFileSync(shell, "<body>second</body>");
  writeFileSync(join(root, "dist/app.js"), "second-js");
  const inFlight = frontend.snapshot();
  const started = performance.now();
  expect(await frontend.snapshot()).toBe(initial);
  console.log("last-good frontend read ms", performance.now() - started);
  const changed = await inFlight;
  expect(changed[0]).toBe("<body>second</body>");
  expect(new TextDecoder().decode(changed[1].get("app.js"))).toBe("second-js");
  expect(changed[2]).not.toBe(initial[2]);
});

test("test_frontend_cache_retries_missing_and_rejects_torn_reads", async () => {
  const root = temp("recurse-frontend-stable-");
  writeFileSync(join(root, "index.html"), "<body>shell</body>");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/app.css"), "styles");
  const text = (bytes: Uint8Array | undefined) =>
    bytes === undefined ? undefined : new TextDecoder().decode(bytes);

  const { frontend, expire } = await cache(root, "fallback", true);
  expect((await frontend.snapshot())[1].has("app.js")).toBe(false);
  writeFileSync(join(root, "dist/app.js"), "bundle");
  expire();
  expect(text((await frontend.snapshot())[1].get("app.js"))).toBe("bundle");

  const complete = await frontend.snapshot();
  unlinkSync(join(root, "dist/app.js"));
  expire();
  expect(await frontend.snapshot()).toBe(complete);
  writeFileSync(join(root, "dist/app.js"), "new-bundle");
  expire();
  expect(text((await frontend.snapshot())[1].get("app.js"))).toBe("new-bundle");
});

test("shell icon slots follow web/icons.ts and fail loudly when unknown", async () => {
  const root = temp("recurse-icon-slots-");
  writeFileSync(
    join(root, "index.html"),
    '<b><svg data-icon="A_ICON"></svg></b>',
  );
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "web"));
  writeFileSync(join(root, "dist/app.js"), "bundle");
  writeFileSync(join(root, "dist/app.css"), "styles");
  const icons = join(root, "web/icons.ts");
  writeFileSync(icons, 'export const A_ICON = "<svg>one</svg>";');
  const live = await cache(root, "fallback", true);
  const [shell, , v1] = await live.frontend.snapshot();
  expect(shell).toBe("<b><svg>one</svg></b>");
  writeFileSync(icons, 'export const A_ICON = "<svg>second</svg>";');
  live.expire();
  const [edited, , v2] = await live.frontend.snapshot();
  expect(edited).toBe("<b><svg>second</svg></b>");
  expect(v2).not.toBe(v1);
  await expect(
    fillIconSlots('<svg data-icon="NO_SUCH_ICON"></svg>', icons),
  ).rejects.toThrow("unknown icon slot NO_SUCH_ICON");
});
