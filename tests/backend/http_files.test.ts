import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readlinkSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

import * as artifacts from "../../src/artifacts";
import { ARTIFACT_ACTIVE_CSP } from "../../src/artifacts";
import { registerFile } from "../../src/agents/runtime/attachments/publish";
import { listPage } from "../../src/session_files";
import {
  THUMBNAIL_QUEUE,
  THUMBNAIL_SLOTS,
  thumbnail,
} from "../../src/web/thumbnails";
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
  // Feature: #3142 local image paths expose only validated snapshots to the operator.
  test("local images resolve document paths and refuse non-images and agent callers", async () => {
    const png = new Uint8Array(Buffer.from(seed.png, "hex"));
    const source = join(dir, "path-image.png");
    const documents = join(dir, "documents");
    await mkdir(documents);
    await writeFile(source, png);
    await writeFile(join(documents, "picture.png"), png);
    await writeFile(join(dir, "not-image.png"), "private text");
    await symlink(join(dir, "not-image.png"), join(dir, "linked.png"));
    await writeFile(
      join(dir, "chart.svg"),
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await writeFile(join(dir, "fake.svg"), "<html>private text</html>");
    await writeFile(
      join(dir, "entity.svg"),
      '<!DOCTYPE svg [<!ENTITY secret SYSTEM "file:///etc/passwd">]><svg>&secret;</svg>',
    );
    await writeFile(join(dir, "raster.svg"), png);
    const base = `http://127.0.0.1:${app.running.port}`;
    const url = (
      path: string,
      query: Record<string, string> = {},
      cid = "owner-a",
    ) =>
      `${base}/api/conversations/${cid}/path-image?${new URLSearchParams({ path, ...query })}`;
    for (const [path, query] of [
      [source, {}],
      ["path-image.png", {}],
      [`~/${relative(homedir(), source)}`, {}],
      ["picture.png", { document: "documents/report.md" }],
      ["picture.png", { document: join(documents, "report.md") }],
      ["raster.svg", {}],
      ["path-image.png", { thumbnail: "1" }],
    ] as [string, Record<string, string>][]) {
      const response = await fetch(url(path, query));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    }
    const head = await fetch(url(source), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(await head.text()).toBe("");
    const download = await fetch(url(source, { download: "1" }));
    expect(download.headers.get("content-disposition")).toStartWith(
      "attachment;",
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);
    const svg = await fetch(url("chart.svg"));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
    );
    for (const path of [
      "not-image.png",
      "documents/../not-image.png",
      "fake.svg",
      "entity.svg",
    ]) {
      for (const query of [{}, { download: "1" }] as Record<string, string>[]) {
        const refused = await fetch(url(path, query));
        expect(refused.status).toBe(415);
        expect(await refused.text()).not.toContain("private text");
      }
    }
    for (const path of ["missing.png", "linked.png", "documents", "/dev/null"])
      expect((await fetch(url(path))).status).toBe(404);
    const fifo = join(dir, "path-image.fifo");
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
    expect((await fetch(url(fifo))).status).toBe(404);
    const oversized = join(dir, "oversized.png");
    await writeFile(oversized, png);
    await truncate(oversized, 25 * 1024 * 1024 + 1);
    expect((await fetch(url(oversized))).status).toBe(413);
    expect((await fetch(url(source, {}, "missing-owner"))).status).toBe(404);
    for (const headers of [
      { "x-loopback-token": app.loopbackToken },
      { "x-recurse-agent": "owner-a" },
      { "x-recurse-agent-caller": "owner-a" },
    ] as Record<string, string>[])
      expect((await fetch(url(source), { headers })).status).toBe(403);
    const key = await app.backendKeys.mint("image-test");
    const authorization = `Bearer ${key.key}`;
    const remote = await fetch(url(source), { headers: { authorization } });
    expect(remote.status).toBe(200);
    expect(new Uint8Array(await remote.arrayBuffer())).toEqual(png);
    expect(
      (
        await fetch(url(source), {
          headers: { authorization, "x-recurse-agent-caller": "owner-a" },
        })
      ).status,
    ).toBe(403);
    const artifact = await artifacts.create(app.artifacts, {
      owner: "owner-a",
      title: "Image document",
    });
    const repo = String(artifact.repo_path);
    await mkdir(join(repo, "nested"));
    await writeFile(join(repo, "nested", "picture.png"), png);
    const query = {
      artifact: String(artifact.id),
      document: "nested/report.md",
    };
    const artifactImage = await fetch(url("picture.png", query));
    expect(artifactImage.status).toBe(200);
    expect(new Uint8Array(await artifactImage.arrayBuffer())).toEqual(png);
    expect((await fetch(url("picture.png", query, "owner-b"))).status).toBe(
      404,
    );
    expect(
      (await fetch(url("picture.png", { ...query, document: "../report.md" })))
        .status,
    ).toBe(404);
    const document = join(documents, "report.md");
    await writeFile(document, "![Picture](picture.png)");
    const saved = await registerFile(
      await app.temp.ensureUploadsDir("20260925-owner-a"),
      "owner-a",
      "a".repeat(32),
      "call-document",
      document,
      dir,
    );
    expect(saved.source_path).toBe(document);
    const page = await listPage(
      collectionSnapshot(app.records.get("owner-a")!, app.temp.config)!,
      { config: app.temp.config },
      null,
      null,
      50,
    );
    expect(page.files.find((file) => file.id === saved.id)?.source_path).toBe(
      document,
    );
  }, 30_000);
  // Feature: #2937 crop retries and cancellation remain owner-scoped and ordered.
  test("crop uploads replay, conflict, cancel and expire under the owner lock", async () => {
    const base = `http://127.0.0.1:${app.running.port}`;
    const capability = await fetch(
      `${base}/api/conversations/owner-a/attachment-crops`,
    );
    expect(capability.status).toBe(200);
    const info = (await capability.json()) as {
      idempotent: boolean;
      now: number;
    };
    expect(info.idempotent).toBe(true);
    expect(String(info.now)).toMatch(/^[0-9]{13}$/);
    expect(
      (await fetch(`${base}/api/conversations/missing-owner/attachment-crops`))
        .status,
    ).toBe(404);
    const key = "c".repeat(32);
    const expires = String(info.now + 3000);
    const upload = (
      owner: string,
      text = "crop bytes",
      filename = "crop.png",
      operation = key,
      expiry = expires,
    ) => {
      const form = new FormData();
      form.set("owner", owner);
      form.set("file", new File([text], filename));
      form.set("crop_key", operation);
      form.set("crop_expires", expiry);
      return fetch(`${base}/api/attachments`, { method: "POST", body: form });
    };
    const cancel = (owner: string, operation = key, expiry = expires) =>
      fetch(
        `${base}/api/conversations/${owner}/attachment-crops/${operation}?expires=${expiry}`,
        { method: "DELETE" },
      );
    const first = await upload("owner-a");
    expect(first.status).toBe(200);
    const saved = (await first.json()) as { id: string; url: string };
    const replay = await upload("owner-a");
    expect(await replay.json()).toEqual(saved);
    expect((await upload("owner-a", "other bytes")).status).toBe(409);
    expect((await upload("owner-a", "crop bytes", "other.png")).status).toBe(
      409,
    );
    expect((await cancel("missing-owner")).status).toBe(404);
    expect((await cancel("owner-b")).status).toBe(200);
    expect((await fetch(`${base}${saved.url}`)).status).toBe(200);
    expect((await upload("owner-b")).status).toBe(409);
    const delayed = "d".repeat(32);
    expect((await cancel("owner-a", delayed)).status).toBe(200);
    expect(
      (await upload("owner-a", "crop bytes", "crop.png", delayed)).status,
    ).toBe(409);
    expect(
      (await upload("owner-a", "crop bytes", "crop.png", "bad")).status,
    ).toBe(422);
    expect(
      (
        await upload(
          "owner-a",
          "crop bytes",
          "crop.png",
          "e".repeat(32),
          String(Date.now() + 7200000),
        )
      ).status,
    ).toBe(422);
    const removedKey = "1".repeat(32);
    const removedUpload = await upload(
      "owner-a",
      "crop bytes",
      "crop.png",
      removedKey,
    );
    expect(removedUpload.status).toBe(200);
    const removed = (await removedUpload.json()) as { url: string };
    expect(
      (await fetch(`${base}${removed.url}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await upload("owner-a", "crop bytes", "crop.png", removedKey)).status,
    ).toBe(409);
    const damagedKey = "2".repeat(32);
    const damagedUpload = await upload(
      "owner-a",
      "crop bytes",
      "crop.png",
      damagedKey,
    );
    expect(damagedUpload.status).toBe(200);
    const damaged = (await damagedUpload.json()) as { id: string };
    const collection = app.temp.uploadsDir("20260925-owner-a");
    await writeFile(join(collection, `${damaged.id}.blob`), "other data");
    expect(
      (await upload("owner-a", "crop bytes", "crop.png", damagedKey)).status,
    ).toBe(409);
    await Bun.sleep(Math.max(0, Number(expires) - Date.now() + 20));
    const expiredReplay = await upload("owner-a");
    expect(expiredReplay.status).toBe(200);
    expect(await expiredReplay.json()).toEqual(saved);
    expect(
      (await upload("owner-a", "crop bytes", "crop.png", delayed)).status,
    ).toBe(409);
    expect((await cancel("owner-a")).status).toBe(200);
    expect((await fetch(`${base}${saved.url}`)).status).toBe(404);
    expect((await upload("owner-a")).status).toBe(409);
    expect(
      readdirSync(collection).some((name) => name.startsWith(".crop-")),
    ).toBe(false);
    const nextExpiry = String(Date.now() + 60000);
    const reused = await upload(
      "owner-a",
      "new bytes",
      "crop.png",
      key,
      nextExpiry,
    );
    expect(reused.status).toBe(200);
    const nextFile = (await reused.json()) as { url: string };
    expect(nextFile.url).not.toBe(saved.url);
    expect((await cancel("owner-a", key, nextExpiry)).status).toBe(200);
    const expiredBarrier = join(collection, ".crop-barrier");
    await writeFile(expiredBarrier, String(Date.now() - 1));
    const freshKey = "3".repeat(32);
    expect(
      (await upload("owner-a", "crop bytes", "crop.png", freshKey, nextExpiry))
        .status,
    ).toBe(200);
    expect(await Bun.file(expiredBarrier).exists()).toBe(false);
    expect((await cancel("owner-a", freshKey, nextExpiry)).status).toBe(200);
    const quotaExpiry = String(Date.now() + 60000);
    const quotaKey = "f".repeat(32);
    const admitted = await upload(
      "owner-b",
      "crop bytes",
      "crop.png",
      quotaKey,
      quotaExpiry,
    );
    expect(admitted.status).toBe(200);
    const quotaFile = (await admitted.json()) as { url: string; id: string };
    const secondKey = "d".repeat(32);
    const second = await upload(
      "owner-b",
      "crop bytes",
      "crop.png",
      secondKey,
      quotaExpiry,
    );
    expect(second.status).toBe(200);
    const thirdKey = "a".repeat(32);
    const third = await upload(
      "owner-b",
      "crop bytes",
      "crop.png",
      thirdKey,
      quotaExpiry,
    );
    expect(third.status).toBe(200);
    const thirdFile = (await third.json()) as { url: string };
    for (let i = 0; i < 253; i++) {
      const operation = i.toString(16).padStart(32, "0");
      expect((await cancel("owner-b", operation, quotaExpiry)).status).toBe(
        200,
      );
    }
    const quotaCollection = app.temp.uploadsDir("20260925-owner-b");
    await writeFile(
      join(quotaCollection, `.crop-${quotaFile.id}-${quotaExpiry}`),
      "",
    );
    expect((await cancel("owner-b", secondKey, quotaExpiry)).status).toBe(200);
    const overflowKey = "e".repeat(32);
    expect((await cancel("owner-b", overflowKey, quotaExpiry)).status).toBe(
      200,
    );
    expect(
      (
        await upload(
          "owner-b",
          "crop bytes",
          "crop.png",
          overflowKey,
          quotaExpiry,
        )
      ).status,
    ).toBe(413);
    expect(
      await Bun.file(
        join(app.temp.uploadsDir("20260925-owner-b"), ".crop-barrier"),
      ).text(),
    ).toBe(quotaExpiry);
    expect(
      (await upload("owner-b", "crop bytes", "crop.png", thirdKey, quotaExpiry))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${base}${thirdFile.url}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await fetch(`${base}${quotaFile.url}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await upload("owner-b", "crop bytes", "crop.png", quotaKey, quotaExpiry))
        .status,
    ).toBe(409);
    const barrier = join(quotaCollection, ".crop-barrier");
    await unlink(barrier);
    const fifo = Bun.spawn(["mkfifo", barrier]);
    expect(await fifo.exited).toBe(0);
    expect(
      (
        await upload(
          "owner-b",
          "crop bytes",
          "crop.png",
          "b".repeat(32),
          quotaExpiry,
        )
      ).status,
    ).toBe(503);
    await unlink(barrier);
  }, 30000);
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

  test("thumbnails shrink large rasters and pass other previews through", async () => {
    let seed = 1;
    const noise = (width: number, height: number) => {
      const bmp = new Uint8Array(54 + width * height * 3);
      const view = new DataView(bmp.buffer);
      bmp.set([0x42, 0x4d]);
      view.setUint32(2, bmp.length, true);
      view.setUint32(10, 54, true);
      view.setUint32(14, 40, true);
      view.setInt32(18, width, true);
      view.setInt32(22, height, true);
      view.setUint16(26, 1, true);
      view.setUint16(28, 24, true);
      for (let at = 54; at < bmp.length; at++)
        bmp[at] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
      return bmp;
    };
    type Codec = {
      jpeg(options: { quality: number }): Codec;
      png(): Codec;
      bytes(): Promise<Uint8Array<ArrayBuffer>>;
      metadata(): Promise<{ width: number; height: number; format: string }>;
    };
    const Image = (Bun as unknown as { Image: new (data: Uint8Array) => Codec })
      .Image;
    const collection = app.temp.uploadsDir("20260925-owner-b");
    const publish = async (name: string, data: Uint8Array | string) => {
      const source = join(dir, name);
      await writeFile(source, data);
      const { id } = await registerFile(
        collection,
        "owner-b",
        "b".repeat(32),
        `call-${name}`,
        source,
        "/",
      );
      return `http://127.0.0.1:${app.running.port}/api/conversations/owner-b/attachments/${id}`;
    };
    const photo = await new Image(noise(2000, 1250))
      .jpeg({ quality: 90 })
      .bytes();
    const large = await publish("photo.jpg", photo);
    const thumb = await fetch(`${large}/thumbnail`);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect(thumb.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    const small = new Uint8Array(await thumb.arrayBuffer());
    expect(await new Image(small).metadata()).toEqual({
      width: 1024,
      height: 640,
      format: "webp",
    });
    expect(small.byteLength * 4).toBeLessThan(photo.byteLength);
    const localThumb = await fetch(
      `http://127.0.0.1:${app.running.port}/api/conversations/owner-b/path-image?${new URLSearchParams({ path: join(dir, "photo.jpg"), thumbnail: "1" })}`,
    );
    expect(localThumb.headers.get("content-type")).toBe("image/webp");
    expect(localThumb.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await localThumb.arrayBuffer())).toEqual(small);
    const together = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${large}/thumbnail`)),
    );
    for (const response of together)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(small);
    const head = await fetch(`${large}/thumbnail`, { method: "HEAD" });
    expect(head.headers.get("content-type")).toBe("image/webp");
    expect(head.headers.get("content-security-policy")).toContain("sandbox");
    expect(await head.text()).toBe("");
    const still = await new Image(noise(400, 300)).png().bytes();
    const control = new Uint8Array(20);
    control.set(new TextEncoder().encode("acTL"), 4);
    const fields = new DataView(control.buffer);
    fields.setUint32(0, 8);
    fields.setUint32(8, 1);
    fields.setUint32(16, Bun.hash.crc32(control.subarray(4, 16)));
    const animated = new Uint8Array(still.length + control.length);
    animated.set(still.subarray(0, 33));
    animated.set(control, 33);
    animated.set(still.subarray(33), 53);
    const moving = await fetch(
      `${await publish("moving.png", animated)}/thumbnail`,
    );
    expect(moving.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await moving.arrayBuffer())).toEqual(animated);
    const chunky = new Uint8Array(33 + 12 * 20_000);
    chunky.set(still.subarray(0, 33));
    for (let at = 33; at < chunky.length; at += 12)
      chunky.set(new TextEncoder().encode("tEXt"), at + 4);
    const unscanned = await fetch(
      `${await publish("chunky.png", chunky)}/thumbnail`,
    );
    expect(unscanned.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await unscanned.arrayBuffer())).toEqual(chunky);
    const settled: string[] = [];
    const read: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const resize = (name: string, signal = new AbortController().signal) =>
      thumbnail(async () => (read.push(name), await gate, photo), signal).then(
        (out) => {
          settled.push(name);
          return out;
        },
      );
    const busy = Array.from(
      { length: THUMBNAIL_SLOTS + THUMBNAIL_QUEUE - 1 },
      (_, index) => resize(`busy-${index}`),
    );
    const cancel = new AbortController();
    const cancelled = resize("cancelled", cancel.signal);
    expect(await resize("overflow")).toBe("busy");
    const overloaded = await fetch(`${large}/thumbnail`);
    expect(overloaded.headers.get("content-type")).toBe("image/jpeg");
    expect(overloaded.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await overloaded.arrayBuffer())).toEqual(photo);
    cancel.abort();
    expect(await cancelled).toBe("busy");
    expect(settled).toEqual(["overflow", "cancelled"]);
    expect(read).toEqual(["busy-0", "busy-1"]);
    release();
    for (const out of await Promise.all(busy))
      expect((out as Uint8Array).byteLength).toBe(small.byteLength);
    expect(read.filter((name) => !name.startsWith("busy-"))).toEqual([]);
    expect(await resize("after")).toEqual(small);
    const original = await fetch(`${large}/preview`);
    expect(original.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(photo);
    const icon = await new Image(noise(32, 20)).png().bytes();
    const tiny = await publish("icon.png", icon);
    const passed = await fetch(`${tiny}/thumbnail`);
    expect(passed.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await passed.arrayBuffer())).toEqual(icon);
    const svg = await fetch(
      `${await publish("chart.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')}/thumbnail`,
    );
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(await svg.text()).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
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
