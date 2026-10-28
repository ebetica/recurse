import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildInstance } from "../../src/agents/instance";
import { Config } from "../../src/config";
import { BackendKeys } from "../../src/auth/backend_keys";
import { publishLoopbackToken } from "../../src/web/request_auth";
import { tmpdir } from "node:os";
import { ConnectedBackends } from "../../src/backends/connected";
import { registerBackendRoutes } from "../../src/web/backends";
import { registerBackendProxy } from "../../src/web/backend_proxy";
import { jsonResponse } from "../../src/web/router";
import { buildAuthApp, PASSWORD } from "./http_auth_app";
import { until } from "./fixtures/durable_host/host";

// Regression: #2758 Sign-in timeouts remain actionable while credentials, operator gates and revocation remain protected.
test("home connects to password and open backends without exposing credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "connected-backends-"));
  const piDir = join(directory, "home", "pi");
  const warnings: { path: string; reason: string }[] = [];
  const warn = (path: string, reason: string) => {
    warnings.push({ path, reason });
  };
  const file = join(piDir, "recurse-backends.json");
  await mkdir(piDir, { recursive: true });
  const corrupt = '{"key":"private-corrupt-contents"';
  await writeFile(file, corrupt, { mode: 0o600 });
  const broken = await ConnectedBackends.load(piDir, "Home laptop!", warn);
  const unavailable = await buildAuthApp(join(directory, "home"), {
    extraRoutes: (router) => {
      registerBackendRoutes(router, broken);
      registerBackendProxy(router, broken);
    },
  });
  try {
    const cookie = `chat_auth=${await unavailable.operator.makeToken()}`;
    const base = `http://127.0.0.1:${unavailable.running.port}`;
    expect(
      (await fetch(base + "/api/tree", { headers: { cookie } })).status,
    ).toBe(200);
    for (const [path, method] of [
      ["/api/backends", "GET"],
      ["/api/backends", "POST"],
      ["/api/backends/work", "DELETE"],
      ["/api/backends/work/tree", "GET"],
    ]) {
      const response = await fetch(base + path, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(method === "POST"
          ? {
              body: JSON.stringify({
                label: "work",
                url: base,
                password: PASSWORD,
              }),
            }
          : {}),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        detail: `connected backends file is unreadable: fix or remove ${file}`,
      });
    }
    await broken.run(new AbortController().signal);
    expect(await readFile(file, "utf8")).toBe(corrupt);
    expect(warnings).toEqual([
      { path: file, reason: "invalid JSON or connection records" },
    ]);
    expect(JSON.stringify(unavailable.records)).not.toContain(
      "private-corrupt-contents",
    );
  } finally {
    await unavailable.running.close();
  }
  await rm(file);
  const store = await ConnectedBackends.load(piDir, "Home laptop!", warn);
  const status = (router: Parameters<typeof registerBackendRoutes>[0]) =>
    router.get("/api/status", async () =>
      jsonResponse({ ready: true, active_agents: 0 }),
    );
  const target = join(directory, "target");
  await mkdir(target);
  const instance = await buildInstance({
    config: new Config({
      env: {
        PATH: process.env.PATH!,
        HOME: join(directory, "home"),
        RECURSE_HOME: join(directory, "settings"),
        CHAT_DATA_DIR: join(directory, "agents"),
        CHAT_REPO_URL: target,
        PI_BG_SHELL: "0",
      },
    }),
    sink: { write() {} },
  });
  await instance.start();
  while (!instance.lifecycle.readinessSnapshot().ready) await Bun.sleep(20);
  const cid = String(
    (await instance.create.create({ title: "Backend requester" })).id,
  );
  const home = await buildAuthApp(join(directory, "home"), {
    backendKeys: true,
    extraRoutes: (router) => {
      registerBackendRoutes(router, store, {
        title: (id) =>
          instance.conversations.metadataSnapshot(id)
            ? "Backend requester"
            : undefined,
        deliverPlatformNote: (id, text) =>
          instance.delivery.deliver(id, text, {
            start: false,
            source: "platform",
            origin: "platform",
          }),
      });
      status(router);
    },
  });
  delete home.env.CHAT_AUTH_HASH;
  delete home.env.CHAT_AUTH_SALT;
  const remote = await buildAuthApp(join(directory, "remote"), {
    backendKeys: true,
    extraRoutes: status,
  });
  const controller = new AbortController();
  const health = store.run(controller.signal);
  const homeUrl = `http://127.0.0.1:${home.running.port}`;
  const remoteUrl = `http://127.0.0.1:${remote.running.port}`;
  const remoteHeaders = {
    cookie: `chat_auth=${await remote.operator.makeToken()}`,
  };
  const call = (path: string, method = "GET", body?: unknown, headers = {}) =>
    fetch(homeUrl + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const connect = (label: string, url: string, password = PASSWORD) =>
    call("/api/backends", "POST", { label, url, password });
  try {
    const token = JSON.parse(
      await readFile(join(directory, "home", "server.json"), "utf8"),
    ).token;
    for (const [path, method] of [
      ["/api/backends", "GET"],
      ["/api/backends", "POST"],
      ["/api/backends/work", "DELETE"],
    ]) {
      expect(
        (await call(path!, method!, undefined, { "x-loopback-token": token }))
          .status,
      ).toBe(403);
    }
    const homeKey = await new BackendKeys(join(directory, "home")).mint(
      "test-home",
    );
    for (const bearer of [
      homeKey.key,
      await readFile(join(directory, "home", "alpha-token"), "utf8"),
    ]) {
      for (const [path, method] of [
        ["/api/backends", "GET"],
        ["/api/backends", "POST"],
        ["/api/backends/work/sign-in", "POST"],
        ["/api/backends/work", "DELETE"],
      ])
        expect(
          (
            await call(path!, method!, undefined, {
              authorization: `Bearer ${bearer}`,
            })
          ).status,
        ).toBe(403);
    }
    await publishLoopbackToken(join(directory, "home"), home.running.port);
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn(
        [
          "bun",
          resolve(import.meta.dir, "../../tools/subagent.ts"),
          "backends",
          ...args,
        ],
        {
          env: {
            ...process.env,
            CHAT_DATA_DIR: join(directory, "home"),
            RECURSE_AGENT_ID: cid,
          },
          stderr: "pipe",
        },
      );
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      expect([await proc.exited, err]).toEqual([0, ""]);
      return out;
    };
    let hits = 0;
    const listener = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits++;
        return new Response("not a backend");
      },
    });
    const agentHeaders = { "x-loopback-token": token, "x-recurse-agent": cid };
    try {
      const url = `http://127.0.0.1:${listener.port}`;
      expect(await cli("add", "dismiss", url)).toBe(
        `Backend dismiss (${url}) needs sign-in: ask the operator to enter its password in Settings → Remotes.\n`,
      );
      expect(await cli("list")).toContain(
        `dismiss ${url} pending · Needs sign-in · Last contact never`,
      );
      const pendingDisk = JSON.parse(await readFile(file, "utf8"));
      expect(pendingDisk[0]).toMatchObject({
        key: null,
        requested_by: cid,
        pending: true,
      });
      const loaded = await ConnectedBackends.load(piDir, "home", warn);
      const stop = new AbortController();
      const task = loaded.run(stop.signal);
      stop.abort();
      await task;
      expect(hits).toBe(0);
      for (const [path, method, body] of [
        ["/api/backends/dismiss/sign-in", "POST", { password: PASSWORD }],
        ["/api/backend-keys", "GET", undefined],
        ["/api/backends/dismiss", "DELETE", undefined],
        ["/api/backends/work", "DELETE", undefined],
        [
          "/api/backends",
          "POST",
          { label: "forbidden", url, password: PASSWORD },
        ],
      ] as const)
        expect((await call(path, method, body, agentHeaders)).status).toBe(403);
      expect((await call("/api/backends/dismiss", "DELETE")).status).toBe(200);
      expect(hits).toBe(0);
      await cli("add", "requested", remoteUrl);
      expect(
        (
          await call("/api/backends/requested/sign-in", "POST", {
            password: "wrong",
          })
        ).status,
      ).toBe(422);
      expect(await cli("list")).toContain("pending · wrong password");
      expect(
        (
          await call("/api/backends/requested/sign-in", "POST", {
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
      await until(async () =>
        JSON.stringify(
          await instance.durable.transcript(cid, { limit: 50 }),
        ).includes("Backend requested is now connected"),
      );
      const transcript = JSON.stringify(
        await instance.durable.transcript(cid, { limit: 50 }),
      );
      expect(transcript).toContain(
        "Signing in to backend requested failed: wrong password",
      );
      expect(transcript).toContain("Backend requested is now connected");
      expect((await call("/api/backends/requested", "DELETE")).status).toBe(
        200,
      );
      for (let n = 0; n < 20; n++)
        expect(
          (
            await call(
              "/api/backends",
              "POST",
              { label: `pending${n}`, url },
              agentHeaders,
            )
          ).status,
        ).toBe(200);
      expect(
        (
          await call(
            "/api/backends",
            "POST",
            { label: "overflow", url },
            agentHeaders,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            "/api/backends",
            "POST",
            { label: "pending0", url },
            agentHeaders,
          )
        ).status,
      ).toBe(409);
      for (let n = 0; n < 20; n++)
        await call(`/api/backends/pending${n}`, "DELETE");
      expect(hits).toBe(0);
    } finally {
      listener.stop(true);
    }
    expect((await connect("invalid label", remoteUrl)).status).toBe(422);
    for (const label of [".", "..", "...", "........"]) {
      expect((await connect(label, remoteUrl)).status).toBe(422);
      expect(
        (
          await call(`/api/backends/${label}/sign-in`, "POST", {
            password: PASSWORD,
          })
        ).status,
      ).not.toBe(200);
      if (label.length > 2)
        expect([403, 404]).toContain(
          (await call(`/api/backends/${label}/tree`)).status,
        );
      expect(() => store.signIn(label, PASSWORD)).toThrow(
        "invalid backend label",
      );
      expect(
        (
          await fetch(homeUrl + "/api/backends", {
            method: "POST",
            headers: {
              "x-loopback-token": token,
              "x-recurse-agent": cid,
              "content-type": "application/json",
            },
            body: JSON.stringify({ label, url: remoteUrl }),
          })
        ).status,
      ).toBe(422);
    }
    expect((await connect("unsafe", "http://example.com")).status).toBe(422);
    expect(
      (await connect("credentials", "https://user:secret@example.com")).status,
    ).toBe(422);
    const wrong = await connect("wrong", remoteUrl, "not the password");
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toEqual({ detail: "wrong password" });
    expect((await connect("work", remoteUrl)).status).toBe(200);
    const remoteKeys = (await (
      await fetch(remoteUrl + "/api/backend-keys", { headers: remoteHeaders })
    ).json()) as { name: string }[];
    expect(remoteKeys).toHaveLength(1);
    expect(remoteKeys[0]!.name).toBe("Home-laptop-");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        ((await (await call("/api/backends")).json()) as { state: string }[])[0]
          ?.state === "connected"
      )
        break;
      await Bun.sleep(20);
    }
    const listing = (await (await call("/api/backends")).json()) as Record<
      string,
      unknown
    >[];
    expect(listing[0]).toMatchObject({
      label: "work",
      url: remoteUrl,
      has_key: true,
      state: "connected",
      reason: null,
    });
    expect(listing[0]!.last_contact).toBeNumber();
    expect(listing[0]).not.toHaveProperty("key");
    expect((await connect("work", remoteUrl)).status).toBe(409);
    expect((await connect("open", homeUrl, "ignored password")).status).toBe(
      200,
    );
    const saved = JSON.parse(
      await readFile(join(piDir, "recurse-backends.json"), "utf8"),
    );
    expect(
      saved.find((row: { label: string }) => row.label === "open").key,
    ).toBeNull();
    expect(
      (await stat(join(piDir, "recurse-backends.json"))).mode & 0o777,
    ).toBe(0o600);
    const secret = saved.find(
      (row: { label: string }) => row.label === "work",
    ).key;
    expect(JSON.stringify(listing)).not.toContain(secret);
    expect(JSON.stringify([...home.records, ...remote.records])).not.toContain(
      secret,
    );
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
    expect((await call("/api/backends/work", "DELETE")).status).toBe(200);
    expect(
      await (
        await fetch(remoteUrl + "/api/backend-keys", { headers: remoteHeaders })
      ).json(),
    ).toEqual([]);
    expect((await call("/api/backends/open", "DELETE")).status).toBe(200);
    expect(await (await call("/api/backends")).json()).toEqual([]);
    const stalled = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      await store.request("stalled", `http://127.0.0.1:${stalled.port}`, cid);
      const timedOut = await call("/api/backends/stalled/sign-in", "POST", {
        password: PASSWORD,
      });
      expect(timedOut.status).toBe(504);
      expect(await timedOut.json()).toEqual({
        detail:
          "the remote took too long during status check (10 second limit); try again",
      });
      expect(store.list()[0]).toMatchObject({
        state: "pending",
        has_key: false,
      });
    } finally {
      stalled.stop(true);
    }
  } finally {
    controller.abort();
    await health;
    await instance.shutdown();
    await home.running.close();
    await remote.running.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
