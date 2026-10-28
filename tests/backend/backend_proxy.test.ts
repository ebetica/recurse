import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApp, WebLogSink } from "../../src/web/app";
import { BackendKeys } from "../../src/auth/backend_keys";
import { publishLoopbackToken } from "../../src/web/request_auth";
import { appWorld, PASSWORD } from "./web_app_support";
import { until } from "./fixtures/durable_host/host";

// Feature: #2692 Operators stream remote APIs and files without sharing credentials or active content.
test("connected backend proxy streams and enforces the operator boundary", async () => {
  const worlds = [appWorld(), appWorld({ password: true })];
  const serviceToken = crypto.randomUUID();
  worlds[0]!.env.RECURSE_SERVICE_TOKEN_FILE = join(
    worlds[0]!.root,
    "service-token",
  );
  await writeFile(worlds[0]!.env.RECURSE_SERVICE_TOKEN_FILE!, serviceToken);
  const apps = await Promise.all(
    worlds.map(({ env }) => buildApp({ env, sink: new WebLogSink(() => {}) })),
  );
  const servers = await Promise.all(apps.map((app) => app.serve({ port: 0 })));
  const counts = new Map<string, number>();
  let credential = "";
  let fault = "";
  let forwarded = new Headers();
  let streamCancelled = false;
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
      if (fault === "stream" && url.pathname.endsWith("/events"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(sink) {
              sink.enqueue(new TextEncoder().encode("data: live\\n\\n"));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      if (url.pathname === "/api/version") {
        forwarded = request.headers;
        credential = request.headers.get("authorization")?.slice(7) ?? "";
        if (fault === "redirect")
          return Response.redirect(servers[1]!.url + "/api/version", 302);
        if (fault === "echo")
          return new Response(credential, {
            headers: {
              "x-secret": credential,
              "content-disposition": credential,
              "content-security-policy": "sandbox; report-uri /" + credential,
            },
          });
      }
      const response = await fetch(
        servers[1]!.url + url.pathname + url.search,
        {
          method: request.method,
          headers: request.headers,
          body: request.body,
          redirect: "manual",
        },
      );
      const headers = new Headers(response.headers);
      if (url.pathname.endsWith("/preview") && response.status === 200) {
        const bytes = await response.arrayBuffer();
        const etag =
          '"' +
          createHash("sha256").update(new Uint8Array(bytes)).digest("hex") +
          '"';
        headers.set("etag", etag);
        return new Response(
          request.headers.get("if-none-match") === etag ? null : bytes,
          {
            status:
              request.headers.get("if-none-match") === etag
                ? 304
                : response.status,
            headers,
          },
        );
      }
      headers.set("set-cookie", "remote=hostile");
      headers.set("x-unlisted", "not-for-home");
      if (!headers.has("content-security-policy"))
        headers.set(
          "content-security-policy",
          "default-src *; script-src 'unsafe-inline'",
        );
      return new Response(response.body, { status: response.status, headers });
    },
  });
  const home = servers[0]!.url;
  const proxy = (path: string, init?: RequestInit) =>
    fetch(home + "/api/backends/B/" + path, init);
  const checked = async (response: Response) => {
    expect(response.status).not.toBe(401);
    expect(JSON.stringify([...response.headers])).not.toContain(
      credential || "recurse-link_",
    );
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-unlisted")).toBe(false);
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    const text = await response.text();
    expect(text).not.toContain(credential || "recurse-link_");
    return text;
  };
  try {
    await until(() =>
      apps.every((app) => app.instance.lifecycle.readinessSnapshot().ready),
    );
    const login = await fetch(servers[1]!.url + "/login", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ password: PASSWORD }),
    });
    const remoteHeaders = {
      cookie: login.headers.get("set-cookie")!.split(";")[0]!,
    };
    const cid = String(
      (await apps[1]!.instance.create.create({ title: "Remote proxy view" }))
        .id,
    );
    const connected = await fetch(home + "/api/backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "B",
        url: gateway.url.origin,
        password: PASSWORD,
      }),
    });
    expect(connected.status).toBe(200);
    const version = await proxy("version", {
      headers: {
        cookie: "home=private",
        "x-unlisted": "drop",
        "x-recurse-agent": "drop",
        "x-recurse-trace": "proxy-test",
      },
    });
    expect(JSON.parse(await checked(version))).toMatchObject({
      api: 1,
      display_name: expect.any(String),
    });
    expect(forwarded.get("cookie")).toBeNull();
    expect(forwarded.get("x-unlisted")).toBeNull();
    expect(forwarded.get("x-recurse-agent")).toBeNull();
    expect(forwarded.get("x-recurse-trace")).toBe("proxy-test");
    for (const path of ["tree", `conversations/${cid}/view`]) {
      const direct = await fetch(servers[1]!.url + "/api/" + path, {
        headers: remoteHeaders,
      });
      const through = await proxy(path);
      expect(through.status).toBe(direct.status);
      expect(JSON.parse(await checked(through))).toEqual(await direct.json());
    }
    const form = new FormData();
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><text>proxied file</text></svg>';
    form.set("file", new File([svg], "preview.svg", { type: "image/svg+xml" }));
    form.set("owner", cid);
    const upload = await proxy("attachments", { method: "POST", body: form });
    expect(upload.status).toBe(200);
    const uploaded = JSON.parse(await checked(upload)) as { url: string };
    const preview = uploaded.url.slice("/api/".length) + "/preview";
    const range = await proxy(preview, {
      headers: { range: "bytes=0-7", "accept-encoding": "gzip" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 0-7/${Buffer.byteLength(svg)}`,
    );
    expect(range.headers.get("content-encoding")).toBeNull();
    expect(await checked(range)).toBe(svg.slice(0, 8));
    const complete = await proxy(preview);
    const etag = complete.headers.get("etag")!;
    expect(await checked(complete)).toBe(svg);
    expect(
      (await proxy(preview, { headers: { "if-none-match": etag } })).status,
    ).toBe(304);
    const events = await proxy(`conversations/${cid}/events`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    expect(events.headers.get("content-encoding")).toBeNull();
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "data:",
    );
    await reader.cancel();
    fault = "stream";
    const live = await proxy(`conversations/${cid}/events`);
    const liveReader = live.body!.getReader();
    expect(new TextDecoder().decode((await liveReader.read()).value)).toContain(
      "data: live",
    );
    await liveReader.cancel();
    await until(() => streamCancelled);
    fault = "";
    const oversized = new FormData();
    oversized.set(
      "file",
      new File([new Uint8Array(27 * 1024 * 1024)], "too-big.bin"),
    );
    oversized.set("owner", cid);
    expect(
      (await proxy("attachments", { method: "POST", body: oversized })).status,
    ).toBe(413);
    for (const path of [
      "settings",
      "backend-keys",
      "conversations//view",
      "conversations/%252e%252e/settings",
      "conversations%2f../settings",
      "conversations/..%5csettings",
    ]) {
      const before = counts.get("/api/" + path) ?? 0;
      expect((await proxy(path)).status).toBe(403);
      expect(counts.get("/api/" + path) ?? 0).toBe(before);
    }
    const send = (path: string, body: unknown, method = "POST") =>
      proxy(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const contextWindow = "settings/maximum-context-window";
    const homeWindow = await (
      await fetch(`${home}/api/${contextWindow}`)
    ).json();
    expect(
      (await send(contextWindow, { maximum_context_window: 123_456 })).status,
    ).toBe(200);
    expect(await (await proxy(contextWindow)).json()).toEqual({
      maximum_context_window: 123_456,
    });
    expect(await (await fetch(`${home}/api/${contextWindow}`)).json()).toEqual(
      homeWindow,
    );
    expect(
      (await send("pi/openrouter-auth/api-key", { key: "sk-or-remote" }))
        .status,
    ).toBe(200);
    expect(await (await proxy("pi/openrouter-auth")).json()).toMatchObject({
      configured: true,
    });
    expect(
      await (await fetch(`${home}/api/pi/openrouter-auth`)).json(),
    ).toMatchObject({ configured: false });
    const mcp = { mcpServers: { docs: { url: "https://mcp.invalid/" } } };
    expect(
      (await send("settings/mcp-servers", { text: JSON.stringify(mcp) }, "PUT"))
        .status,
    ).toBe(200);
    expect(
      JSON.parse(
        (
          (await (await proxy("settings/mcp-servers")).json()) as {
            text: string;
          }
        ).text,
      ),
    ).toEqual(mcp);
    for (const path of [
      "settings/mcp-servers/sign-in",
      "settings/mcp-servers/oauth-callback",
      "settings/theme",
      "password",
    ]) {
      expect((await send(path, { name: "docs" })).status).toBe(403);
      expect(counts.get("/api/" + path) ?? 0).toBe(0);
    }
    expect((await fetch(home + "/api/backends/unknown/tree")).status).toBe(404);
    const token = await publishLoopbackToken(
      worlds[0]!.env.CHAT_DATA_DIR!,
      servers[0]!.port,
    );
    const homeKey = await new BackendKeys(worlds[0]!.env.CHAT_DATA_DIR!).mint(
      "proxy-caller",
    );
    for (const headers of [
      { "x-loopback-token": token },
      { authorization: `Bearer ${serviceToken}` },
      { authorization: `Bearer ${homeKey.key}` },
    ] as Record<string, string>[])
      expect((await proxy("tree", { headers })).status).toBe(403);
    expect(
      (
        await proxy("attachments", {
          method: "POST",
          headers: { origin: "https://attacker.invalid" },
        })
      ).status,
    ).toBe(403);
    const homeCid = String(
      (await apps[0]!.instance.create.create({ title: "Pending requester" }))
        .id,
    );
    expect(
      (
        await fetch(home + "/api/backends", {
          method: "POST",
          headers: {
            "x-loopback-token": token,
            "x-recurse-agent": homeCid,
            "content-type": "application/json",
          },
          body: JSON.stringify({ label: "pending", url: gateway.url.origin }),
        })
      ).status,
    ).toBe(200);
    const pending = await fetch(home + "/api/backends/pending/tree");
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({
      detail: "Backend pending needs sign-in in Settings",
    });
    fault = "echo";
    expect(await checked(await proxy("version"))).toBe("[redacted]");
    fault = "redirect";
    const redirect = await proxy("version");
    expect(redirect.status).toBe(502);
    expect(redirect.headers.has("location")).toBe(false);
    fault = "";
    const key = await new BackendKeys(worlds[1]!.env.CHAT_DATA_DIR!).verify(
      `Bearer ${credential}`,
    );
    await new BackendKeys(worlds[1]!.env.CHAT_DATA_DIR!).revoke(key!.id);
    const revoked = await proxy("tree");
    expect(revoked.status).toBe(424);
    expect(await revoked.text()).toContain(
      "key was revoked: reconnect in Settings",
    );
    await gateway.stop(true);
    const unreachable = await proxy("tree");
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toEqual({
      detail: "Backend B is unreachable",
    });
  } finally {
    await gateway.stop(true);
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await Promise.all(apps.flatMap((app) => app.detached));
    await Promise.all(
      worlds.map(({ root }) => rm(root, { recursive: true, force: true })),
    );
  }
}, 120_000);
