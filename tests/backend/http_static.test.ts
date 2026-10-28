import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  FrontendCache,
  fileResponse,
  generationReloadScript,
  registerStaticRoutes,
} from "../../src/web/static";
import { Router } from "../../src/web/router";
import { readRelease } from "../../src/release";
import { copyFrontendAssets } from "../../src/launcher/frontend_assets";
import {
  exchange,
  materialise,
  requestBytes,
  type BodySpec,
} from "./http_corpus";
import { Refs, runRefCases, type RefCase } from "./http_refs";
import { serveOpen } from "./http_open_app";
import corpus from "./fixtures/http_static/cases.json";
import seed from "./fixtures/http_static/seed.json";

interface StaticCase extends Omit<RefCase, "response"> {
  current: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
    theme?: boolean;
    refs?: Record<string, string>;
  };
}

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function buildRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "http-static-"));
  dirs.push(root);
  for (const [rel, spec] of Object.entries(seed.files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), materialise(spec as BodySpec));
  }
  for (const [rel, target] of Object.entries(seed.links))
    await symlink(target, join(root, rel));
  return root;
}

async function rawEtag(port: number, path: string): Promise<string> {
  const raw = Buffer.from(
    await exchange(port, requestBytes({ method: "GET", path })),
  ).toString("latin1");
  return /\r\netag: ([^\r]*)/i.exec(raw)![1]!;
}

describe("corpus", () => {
  test("http_static", async () => {
    const root = await buildRoot();
    const htmlPath = join(root, "index.html");
    const staticDir = join(root, "web", "dist");
    let now = 0;
    const frontend = await FrontendCache.create({
      htmlPath,
      staticDir,
      fallbackShell: "",
      fixedVersion: "unused",
      live: true,
      nowMs: () => now,
    });
    const state: { readiness: unknown } = {
      readiness: { ready: true, active_agents: 0 },
    };
    const router = new Router();
    const release = await readRelease();
    registerStaticRoutes(router, {
      frontend,
      staticDir,
      themesFile: join(root, "data/config/themes.json"),
      displayName: "Recurse",
      release,
      readinessSnapshot: () => {
        if (state.readiness === "raise") throw new Error("readiness failed");
        return state.readiness;
      },
    });
    const { running } = await serveOpen(router, join(root, "data"));
    const refs = new Refs();
    try {
      const generation = (await frontend.snapshot())[2];
      const unpinned = await fetch(
        `http://127.0.0.1:${running.port}/static/app.js`,
      );
      expect(unpinned.status).toBe(200);
      expect(unpinned.headers.get("content-type")).toBe(
        "application/javascript",
      );
      expect(await unpinned.text()).toBe(generationReloadScript(generation));
      const problems = await runRefCases(
        running.port,
        corpus.cases as unknown as RefCase[],
        refs,
        {
          setup: async (spec) => {
            if (spec.etag) {
              const [name, path] = spec.etag as [string, string];
              refs.put(name, await rawEtag(running.port, refs.resolve(path)));
            }
            if ("readiness" in spec) state.readiness = spec.readiness;
            const write = (spec.write ?? {}) as Record<string, BodySpec>;
            for (const [rel, body] of Object.entries(write))
              await writeFile(join(root, rel), materialise(body));
            const remove = (spec.remove ?? []) as string[];
            for (const rel of remove) await unlink(join(root, rel));
            if (spec.write || spec.remove) {
              now += 1100;
              await frontend.snapshot();
            }
          },
          expect: (item, got) => {
            const current = (item as unknown as StaticCase).current;
            expect(got.status, item.name).toBe(current.status);
            expect(got.headers, item.name).toEqual(current.headers);
            let body = got.body;
            if (current.theme) {
              const {
                theme,
                release: served,
                ...json
              } = (
                body as {
                  json: Record<string, unknown>;
                }
              ).json;
              expect(theme, item.name).toMatch(/^[0-9a-f]{12}$/);
              expect(served, item.name).toEqual(release);
              body = { json };
            }
            expect(body, item.name).toEqual(current.body);
            for (const [name, value] of Object.entries(current.refs ?? {}))
              expect(refs.values.get(name), item.name).toBe(value);
            if (["escape link", "dot dot", "absolute"].includes(item.name)) {
              expect(got.status, item.name).toBe(404);
              expect(JSON.stringify(got.body)).not.toContain("secret();");
            }
            if (item.name === "svg" || item.name === "svg alias link") {
              expect(got.status, item.name).toBe(200);
              const content = seed.files["web/dist/icon.svg"].text;
              expect(got.body).toEqual({
                bytes: Buffer.byteLength(content),
                sha256: createHash("sha256").update(content).digest("hex"),
              });
            }
            return null;
          },
        },
      );
      expect(problems).toEqual([]);
    } finally {
      await running.close();
    }
  }, 60_000);
});

test("shell import map aliases lazy chunks to the versioned entry", async () => {
  const root = await buildRoot();
  await copyFrontendAssets(process.cwd(), join(root, "web/dist"));
  await writeFile(
    join(root, "index.html"),
    // test-check-allow: T1 Real build input; verifies served import maps.
    await Bun.file("web/index.html").text(),
  );
  await copyFile("web/icons.ts", join(root, "web/icons.ts"));
  const frontend = await FrontendCache.create({
    htmlPath: join(root, "index.html"),
    staticDir: join(root, "web/dist"),
    fallbackShell: "",
    fixedVersion: "unused",
    live: true,
  });
  const router = new Router();
  registerStaticRoutes(router, {
    frontend,
    staticDir: join(root, "web/dist"),
    themesFile: join(root, "data/config/themes.json"),
    displayName: "Recurse",
    release: await readRelease(),
    readinessSnapshot: () => ({ ready: true, active_agents: 0 }),
  });
  const { running } = await serveOpen(router, join(root, "data"));
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/`);
    const shell = await response.text();
    const importMap = JSON.parse(
      shell.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ??
        "null",
    ) as { imports?: Record<string, string> };
    const version = (await frontend.snapshot())[2];
    expect(importMap.imports?.["/static/app.js"]).toBe(
      `/static/app.js?v=${version}`,
    );
    expect(shell).toContain(`src="/static/app.js?v=${version}"`);
    const faviconUrl = shell.match(
      /<link rel="icon" href="([^"]+)" type="image\/svg\+xml"/,
    )?.[1];
    expect(faviconUrl).toBe("/static/brand/favicon.svg");
    const favicon = await fetch(
      `http://127.0.0.1:${running.port}${faviconUrl}`,
    );
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await favicon.text()).toContain('viewBox="0 0 64 64"');
    for (const name of ["favicon-32.png", "apple-touch-icon.png"]) {
      const image = await fetch(
        `http://127.0.0.1:${running.port}/static/brand/${name}`,
      );
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
    }
  } finally {
    await running.close();
  }
});

describe("static", () => {
  test("multi-range answers Starlette's multipart/byteranges", async () => {
    const root = await buildRoot();
    const path = join(root, "web/dist/fonts/face.woff2");
    const data = materialise(
      seed.files["web/dist/fonts/face.woff2"] as BodySpec,
    );
    const response = await fileResponse(
      new Request("http://x/", { headers: { range: "bytes=0-1, 10-12" } }),
      path,
      "font/woff2",
      {},
    );
    expect(response.status).toBe(206);
    const type = response.headers.get("content-type")!;
    const boundary = /^multipart\/byteranges; boundary=([0-9a-f]{26})$/.exec(
      type,
    )![1]!;
    const body = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(body.length);
    const hex = (text: string) => Buffer.from(text).toString("hex");
    const part = (start: number, end: number) =>
      hex(
        `--${boundary}\r\nContent-Type: font/woff2\r\nContent-Range: bytes ${start}-${end - 1}/1000\r\n\r\n`,
      ) +
      Buffer.from(data.subarray(start, end)).toString("hex") +
      hex("\r\n");
    expect(Buffer.from(body).toString("hex")).toBe(
      part(0, 2) + part(10, 13) + hex(`--${boundary}--`),
    );
  });

  test("a refresh in flight never delays another reader", async () => {
    const root = await buildRoot();
    let now = 0;
    const frontend = await FrontendCache.create({
      htmlPath: join(root, "index.html"),
      staticDir: join(root, "web/dist"),
      fallbackShell: "",
      fixedVersion: "x",
      live: true,
      nowMs: () => now,
    });
    const before = await frontend.snapshot();
    await writeFile(join(root, "web/dist/app.js"), "changed();\n");
    now = 5000;
    const refreshing = frontend.snapshot();
    expect(await frontend.snapshot()).toBe(before);
    const after = await refreshing;
    expect(after[2]).not.toBe(before[2]);
    await writeFile(join(root, "web/dist/app.js"), "again();\n");
    now = 5500;
    expect(await frontend.snapshot()).toBe(after);
  });
});
