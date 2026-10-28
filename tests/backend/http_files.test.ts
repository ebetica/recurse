import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readlinkSync } from "node:fs";
import {
  appendFile,
  mkdtemp,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as artifacts from "../../src/artifacts";
import { ARTIFACT_ACTIVE_CSP } from "../../src/artifacts";
import { registerFile } from "../../src/agents/runtime/attachments/publish";
import { listPage } from "../../src/session_files";
import { collectionSnapshot } from "../../src/agents/runtime/node_files";
import { exchange, normalise, requestBytes } from "./http_corpus";
import { Refs } from "./http_refs";
import { buildRoutesApp, type RoutesApp } from "./http_routes_app";

import seed from "./fixtures/http_files/seed.json";

async function seedArtifacts(app: RoutesApp, refs: Refs) {
  refs.put("artifacts", app.artifacts.artifactsDir);
  const context = { ...app.artifacts, anyKind: true };
  for (const item of seed.artifacts) {
    const created = await artifacts.create(context, {
      owner: item.owner,
      title: item.title,
    });
    refs.put(item.ref, created.id);
    const repo = join(
      app.artifacts.artifactsDir,
      item.owner,
      String(created.id),
    );
    let previous: string | undefined;
    for (const version of item.versions) {
      for (const [name, text] of Object.entries(version.files))
        await writeFile(join(repo, name), text as string);
      const info = await artifacts.publish(
        context,
        item.owner,
        String(created.id),
      );
      expect(info.version).not.toBe(previous);
      previous = String(info.version);
      refs.put(version.ref, info.version);
    }
  }
}

let app: RoutesApp;
let dir: string;
let refs: Refs;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "http-files-"));
  app = await buildRoutesApp(dir, seed.conversations);
  refs = new Refs();
});
afterAll(async () => {
  await app.running.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string, method = "GET") =>
  normalise(
    await exchange(app.running.port, requestBytes({ method, path })),
    method,
  );

describe("http_files corpus", () => {
  // Regression: #1989 HTML artifact file was not previewed inline
  test("every recorded case matches", async () => {
    await seedArtifacts(app, refs);
    const artifact = refs.values.get("art_a")!;
    const html = await get(
      `/api/artifacts/${artifact}/file?agent=owner-a&path=index.html`,
    );
    expect(html.status).toBe(200);
    expect(html.headers["content-disposition"]).toBe(
      'inline; filename="index.html"',
    );
    expect(html.headers["content-security-policy"]).toBe(ARTIFACT_ACTIVE_CSP);
    const download = await get(
      `/api/artifacts/${artifact}/file?agent=owner-a&path=index.html&download=1`,
    );
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toBe(
      'attachment; filename="index.html"',
    );
    const page = await get(`/api/artifacts/${artifact}/page?agent=owner-a`);
    expect(page.status).toBe(200);
    expect(page.headers["content-disposition"]).toBe(
      'inline; filename="index.html"',
    );
    expect(page.headers["content-security-policy"]).toBe(ARTIFACT_ACTIVE_CSP);
    const pageBytes = await exchange(
      app.running.port,
      requestBytes({
        method: "GET",
        path: `/api/artifacts/${artifact}/page?agent=owner-a`,
      }),
    );
    const pageText = Buffer.from(pageBytes).toString("utf8");
    expect(pageText).toContain("<h1>hi</h1>");
    expect(pageText).toContain('id="recurse-theme"');
    expect(
      (await get(`/api/artifacts/${artifact}/page?agent=owner-b`)).status,
    ).toBe(404);
  }, 120_000);
});

describe("owner scoping", () => {
  test("a symlinked blob never redirects a download", async () => {
    const png = new Uint8Array(Buffer.from(seed.png, "hex"));
    const boundary = "b0undary";
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n\r\n` +
      Buffer.from(png).toString("latin1") +
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="owner"\r\n\r\nowner-b\r\n--${boundary}--\r\n`;
    const raw = await exchange(
      app.running.port,
      requestBytes({
        method: "POST",
        path: "/api/attachments",
        headers: [
          ["Content-Type", `multipart/form-data; boundary=${boundary}`],
        ],
        body: { hex: Buffer.from(body, "latin1").toString("hex") },
      }),
    );
    const { id } = (normalise(raw, "POST").body as { json: { id: string } })
      .json;
    const url = `/api/conversations/owner-b/attachments/${id}`;
    expect((await get(url)).status).toBe(200);
    const collection = app.temp.uploadsDir("20260925-owner-b");
    const secret = join(dir, "secret.png");
    await writeFile(secret, png);
    await unlink(join(collection, `${id}.blob`));
    await symlink(secret, join(collection, `${id}.blob`));
    const swapped = await get(url);
    expect(swapped.status).not.toBe(200);
    expect(JSON.stringify(swapped.body)).not.toContain("sha256");
  });

  // Regression: #2851 uploads disappeared when a restart cleared scratch.
  test("uploaded media survives a restart without scratch and still previews and seeks", async () => {
    const upload = async (filename: string, text: string) => {
      const boundary = "b0undary";
      const body =
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n${text}` +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="owner"\r\n\r\nowner-b\r\n--${boundary}--\r\n`;
      const raw = await exchange(
        app.running.port,
        requestBytes({
          method: "POST",
          path: "/api/attachments",
          headers: [
            ["Content-Type", `multipart/form-data; boundary=${boundary}`],
          ],
          body: { hex: Buffer.from(body, "latin1").toString("hex") },
        }),
      );
      const { id } = (normalise(raw, "POST").body as { json: { id: string } })
        .json;
      return `/api/conversations/owner-b/attachments/${id}/preview`;
    };
    const svg = await get(
      await upload("chart.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    );
    expect(svg.status).toBe(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["x-content-type-options"]).toBe("nosniff");
    expect(svg.headers["content-security-policy"]).toStartWith(
      "default-src 'none'; style-src 'unsafe-inline';",
    );
    expect(svg.headers["content-security-policy"]).toEndWith("; sandbox");
    const clip = await upload("clip.mp4", "0123456789");
    const raw = await exchange(
      app.running.port,
      requestBytes({
        method: "GET",
        path: clip,
        headers: [["Range", "bytes=2-5"]],
      }),
    );
    const part = normalise(raw, "GET");
    expect(part.status).toBe(206);
    expect(part.headers["content-type"]).toBe("video/mp4");
    expect(part.headers["content-range"]).toBe("bytes 2-5/10");
    expect(Buffer.from(raw).toString("latin1")).toEndWith("\r\n\r\n2345");
    expect((await get(await upload("notes.zip", "PK"))).status).toBe(404);
    await app.running.close();
    await rm(app.temp.config.paths.AGENT_TEMP_ROOT, {
      recursive: true,
      force: true,
    });
    app = await buildRoutesApp(dir, seed.conversations);
    await app.temp.reconcileAgentTempStartup();
    const snapshot = collectionSnapshot(
      app.records.get("owner-b")!,
      app.temp.config,
    )!;
    const page = await listPage(
      snapshot,
      {
        config: app.temp.config,
        boundSessionFile: () => null,
      },
      null,
      null,
      50,
    );
    expect(JSON.stringify(page)).toContain("clip.mp4");
    const restarted = await exchange(
      app.running.port,
      requestBytes({
        method: "GET",
        path: clip,
        headers: [["Range", "bytes=2-5"]],
      }),
    );
    expect(normalise(restarted, "GET").status).toBe(206);
    expect(Buffer.from(restarted).toString("latin1")).toEndWith("\r\n\r\n2345");
  });

  test("a large published file streams from its open blob", async () => {
    const size = 60 * 1024 * 1024;
    const source = join(dir, "clip.mp4");
    await writeFile(source, "x");
    await truncate(source, size - 10);
    await appendFile(source, "0123456789");
    const expected = createHash("sha256");
    for await (const chunk of Bun.file(source).stream()) expected.update(chunk);
    const collection = app.temp.uploadsDir("20260925-owner-b");
    const { id } = await registerFile(
      collection,
      "owner-b",
      "b".repeat(32),
      "call-big",
      source,
      "/",
    );
    const blob = join(collection, `${id}.blob`);
    const openBlobs = () =>
      readdirSync("/proc/self/fd").filter((fd) => {
        try {
          return readlinkSync(`/proc/self/fd/${fd}`) === blob;
        } catch {
          return false;
        }
      }).length;
    const url = `http://127.0.0.1:${app.running.port}/api/conversations/owner-b/attachments/${id}`;

    Bun.gc(true);
    const before = process.memoryUsage().rss;
    let peak = before;
    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    const digest = createHash("sha256");
    let length = 0;
    for await (const chunk of whole.body!) {
      digest.update(chunk);
      length += chunk.length;
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    expect(length).toBe(size);
    expect(digest.digest("hex")).toBe(expected.digest("hex"));
    console.log("published file peak RSS increase", peak - before);

    const tail = await fetch(`${url}/preview`, {
      headers: { range: `bytes=${size - 10}-` },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(
      `bytes ${size - 10}-${size - 1}/${size}`,
    );
    expect(await tail.text()).toBe("0123456789");
    const two = await fetch(`${url}/preview`, {
      headers: { range: `bytes=0-0,${size - 1}-` },
    });
    expect(two.headers.get("content-type")).toStartWith("multipart/byteranges");
    expect(await two.text()).toMatch(/\r\n\r\nx\r\n[\s\S]*\r\n\r\n9\r\n--/);
    expect(
      (await fetch(`${url}/preview`, { headers: { range: `bytes=${size}-` } }))
        .status,
    ).toBe(416);
    expect(openBlobs()).toBe(0);
    expect((await fetch(url, { method: "HEAD" })).status).toBe(200);
    expect(openBlobs()).toBe(0);

    const abort = new AbortController();
    const partial = await fetch(url, { signal: abort.signal });
    await partial.body!.getReader().read();
    expect(openBlobs()).toBe(1);
    abort.abort();
    for (let i = 0; i < 50 && openBlobs() > 0; i++) await Bun.sleep(50);
    expect(openBlobs()).toBe(0);
  }, 60_000);

  test("a reaping owner fails closed for downloads, uploads and deletes", async () => {
    const node = app.nodes.get("owner-b")!;
    node.reaping = true;
    try {
      const any = "/api/conversations/owner-b/attachments/" + "1".repeat(32);
      expect((await get(any)).status).toBe(404);
      const raw = await exchange(
        app.running.port,
        requestBytes({
          method: "DELETE",
          path: `/api/attachments/${"1".repeat(32)}?owner=owner-b`,
        }),
      );
      expect(normalise(raw, "DELETE").status).toBe(404);
    } finally {
      node.reaping = false;
    }
  });

  test("an artifact is addressable only under its owner", async () => {
    const other = refs.values.get("art_b")!;
    expect(
      (await get(`/api/artifacts/${other}/file?agent=owner-b&path=notes.md`))
        .status,
    ).toBe(200);
    for (const agent of ["owner-a", "owner-zz"])
      expect(
        (await get(`/api/artifacts/${other}/file?agent=${agent}&path=notes.md`))
          .status,
      ).toBe(404);
  });
});

test("an upload body past the cap is refused 413 before parsing", async () => {
  const raw = await exchange(
    app.running.port,
    requestBytes({
      method: "POST",
      path: "/api/attachments",
      headers: [["Content-Type", "multipart/form-data; boundary=b"]],
      body: { text: "x", repeat: 26 * 1024 * 1024 + 1 },
    }),
  );
  const got = normalise(raw, "POST");
  expect([got.status, got.body]).toEqual([
    413,
    { json: { detail: "file too large (max 25 MB)" } },
  ]);
});

test("every file route refuses an unauthenticated caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "http-files-auth-"));
  const locked = await buildRoutesApp(root, ["owner-a"], {
    authEnv: { CHAT_AUTH_SALT: "00", CHAT_AUTH_HASH: "00".repeat(32) },
  });
  try {
    for (const route of locked.router.routes()) {
      const path = route.path.replace(/\{[^}]+\}/g, "x");
      for (const method of route.methods) {
        const raw = await exchange(
          locked.running.port,
          requestBytes({ method, path }),
        );
        expect([method, path, normalise(raw, method).status]).toEqual([
          method,
          path,
          401,
        ]);
      }
    }
  } finally {
    await locked.running.close();
    await rm(root, { recursive: true, force: true });
  }
});
