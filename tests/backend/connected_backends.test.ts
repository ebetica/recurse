import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { buildInstance } from "../../src/agents/instance";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import { Config } from "../../src/config";
import { BackendKeys } from "../../src/auth/backend_keys";
import { publishLoopbackToken } from "../../src/web/request_auth";
import { tmpdir } from "node:os";
import { ConnectedBackends } from "../../src/backends/connected";
import { registerBackendRoutes } from "../../src/web/backends";
import { registerBackendProxy } from "../../src/web/backend_proxy";
import { jsonResponse } from "../../src/web/router";
import { conditionalJson } from "../../src/web/caching";
import { API_MAJOR, API_REVISION } from "../../src/web/api_v1/schema";
import { buildAuthApp, PASSWORD } from "./http_auth_app";
import { until } from "./fixtures/durable_host/host";

// Regression: #2758 Sign-in timeouts remain actionable while credentials, operator gates and revocation remain protected. (also #3029 Unknown compatibility still probes readiness.)
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
  let version: {
    api: number;
    api_revision?: number;
    release: { version: string; commit: null };
  } | null = {
    api: API_MAJOR,
    api_revision: API_REVISION,
    release: { version: "test", commit: null },
  };
  let versionUnavailable: "json" | "text" | null = null;
  let holdStatus: number | null = null;
  let holdBefore = false;
  let statusHits = 0;
  let abortedVersions = 0;
  let versionReplies = 0;
  let releaseVersion: (() => void) | undefined;
  const conditionalRequests: (string | null)[] = [];
  const status = (router: Parameters<typeof registerBackendRoutes>[0]) => {
    router.get("/api/status", async () => {
      statusHits++;
      return jsonResponse({ ready: true, active_agents: 0 });
    });
    router.get("/api/v1/version", async () => jsonResponse({ api: 1 }));
    router.get("/api/v1/agents/{id}/idle", async () =>
      jsonResponse({ idle: true }),
    );
    router.get("/api/v1/agents/{id}/messages", async () =>
      jsonResponse({ messages: [] }),
    );
    router.get("/api/version", async (ex) => {
      conditionalRequests.push(ex.request.headers.get("if-none-match"));
      if (versionUnavailable === "json")
        return jsonResponse({ detail: "not ready" }, 503);
      if (versionUnavailable === "text")
        return new Response("not ready", { status: 503 });
      if (holdBefore) {
        holdBefore = false;
        ex.request.signal.addEventListener("abort", () => abortedVersions++, {
          once: true,
        });
        await new Promise<void>((resolve) => {
          releaseVersion = resolve;
        });
      }
      const response = version
        ? conditionalJson(ex.request, version)
        : new Response("not JSON");
      if (response.status === holdStatus) {
        holdStatus = null;
        await new Promise<void>((resolve) => {
          releaseVersion = resolve;
        });
      }
      versionReplies++;
      return response;
    });
  };
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
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = (instance.durable as unknown as { deps: DurableHostDeps }).deps;
  deps.models = models;
  deps.settings = () => ["faux/faux-1", "off"];
  instance.durable.remoteSettings = store;
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
      registerBackendProxy(router, store);
    },
  });
  delete home.env.CHAT_AUTH_HASH;
  delete home.env.CHAT_AUTH_SALT;
  const remote = await buildAuthApp(join(directory, "remote"), {
    backendKeys: true,
    extraRoutes: status,
  });
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
    const opened = await instance.durable.open(cid);
    await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
    let turn = 0;
    const settings = async (args: Record<string, string>) => {
      let out = "";
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: `text(await tools.recurse_settings(${JSON.stringify(args)}));`,
          }),
          { stopReason: "toolUse" },
        ),
        (request) => {
          out = JSON.stringify(
            request.messages.findLast(
              (message) => message.role === "toolResult",
            ),
          );
          return fauxAssistantMessage("Done.");
        },
      ]);
      await instance.delivery.deliver(cid, "Manage the requested remote", {
        origin: "operator",
        messageId: `remote-settings-${++turn}`,
      });
      await opened.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(out).not.toContain(token);
      expect(out).not.toContain(homeKey.key);
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
    const agentHeaders = {
      "x-loopback-token": token,
      "x-recurse-agent": cid,
      "x-recurse-bundled-tool": "subagent",
    };
    try {
      const url = `http://127.0.0.1:${listener.port}`;
      expect(
        await settings({ action: "add_remote", label: "dismiss", url }),
      ).toContain(
        `Backend dismiss (${url}) needs sign-in: ask the operator to enter its password in Settings → Remotes.`,
      );
      const listed = await settings({ action: "list_remotes" });
      expect(listed).toContain("pending");
      expect(listed).toContain("Needs sign-in");
      expect(listed).toContain("Backend requester");
      expect(listed).toContain(url);
      expect(
        await settings({ action: "add_remote", label: "invalid label", url }),
      ).toContain("invalid backend label");
      const pendingDisk = JSON.parse(await readFile(file, "utf8"));
      expect(pendingDisk[0]).toMatchObject({
        key: null,
        requested_by: cid,
        pending: true,
      });
      const loaded = await ConnectedBackends.load(piDir, "home", warn);
      await loaded.refreshStale();
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
      await settings({
        action: "add_remote",
        label: "requested",
        url: remoteUrl,
      });
      expect(
        (
          await call("/api/backends/requested/sign-in", "POST", {
            password: "wrong",
          })
        ).status,
      ).toBe(422);
      expect(await settings({ action: "list_remotes" })).toContain(
        "wrong password",
      );
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
              "x-recurse-bundled-tool": "subagent",
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
    expect(listing[0]).toMatchObject({
      compatibility: "compatible",
      remote_api: API_MAJOR,
      remote_revision: API_REVISION,
      remote_release: "test",
    });
    await store.checkRelay("work", new AbortController().signal);
    expect(conditionalRequests.some(Boolean)).toBe(true);
    expect((await call("/api/backends/work/v1/version")).status).toBe(200);
    expect(
      (await call(`/api/backends/work/v1/agents/${cid}/messages`)).status,
    ).toBe(200);
    versionUnavailable = "json";
    expect((await connect("unknown", remoteUrl)).status).toBe(200);
    const unknown = await call("/api/backends/unknown/v1/version");
    expect(unknown.status).toBe(409);
    expect(await unknown.text()).toContain("revision 3");
    expect((await call("/api/backends/unknown/status")).status).toBe(200);
    const unknownStatusBefore = statusHits;
    const unknownVersionsBefore = conditionalRequests.length;
    await store.checkRelay("unknown", new AbortController().signal, false);
    expect(statusHits).toBe(unknownStatusBefore + 1);
    expect(conditionalRequests).toHaveLength(unknownVersionsBefore + 1);
    expect((await call("/api/backends/unknown", "DELETE")).status).toBe(200);
    versionUnavailable = null;
    version = { api: API_MAJOR, release: { version: "old", commit: null } };
    await store.checkRelay("work", new AbortController().signal);
    expect(store.list().find((row) => row.label === "work")).toMatchObject({
      compatibility: "older",
      remote_revision: 0,
      remote_release: "old",
    });
    expect(await settings({ action: "list_remotes" })).toContain("older");
    const old = await call("/api/backends/work/v1/version");
    expect(old.status).toBe(409);
    expect(await old.text()).toContain("revision 3");
    expect((await call("/api/backends/work/status")).status).toBe(200);
    for (const revision of [1, 2]) {
      version = {
        api: API_MAJOR,
        api_revision: revision,
        release: { version: "old", commit: null },
      };
      await store.checkRelay("work", new AbortController().signal);
      for (const path of [
        "v1/version",
        `v1/agents/${cid}/idle`,
        `v1/agents/${cid}/messages`,
      ]) {
        const denied = await call(`/api/backends/work/${path}`);
        expect(denied.status).toBe(409);
        expect(await denied.text()).toContain("revision 3");
      }
      expect(
        (
          await call(`/api/backends/work/v1/agents/${cid}/messages`, "POST", {
            text: "hello",
          })
        ).status,
      ).toBe(409);
      expect((await call("/api/backends/work/status")).status).toBe(200);
    }
    version = { api: API_MAJOR, release: { version: "old", commit: null } };
    await store.checkRelay("work", new AbortController().signal);
    holdBefore = true;
    const finalWaiter = new AbortController();
    const abandoned = store.checkRelay("work", finalWaiter.signal).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await until(() => !!releaseVersion);
    finalWaiter.abort();
    expect(await abandoned).toContain("aborted");
    await until(() => abortedVersions > 0);
    version = {
      api: API_MAJOR + 1,
      api_revision: 0,
      release: { version: "future", commit: null },
    };
    await expect(
      store.checkRelay("work", new AbortController().signal),
    ).rejects.toThrow(`speaks API v${API_MAJOR + 1}`);
    const repliesBefore = versionReplies;
    version = { api: API_MAJOR, release: { version: "old", commit: null } };
    releaseVersion!();
    releaseVersion = undefined;
    await until(() => versionReplies > repliesBefore);
    expect(
      store.list().find((row) => row.label === "work")?.compatibility,
    ).toBe("incompatible");
    await store.checkRelay("work", new AbortController().signal);
    for (const beforeResponse of [false, true]) {
      if (beforeResponse) holdBefore = true;
      else holdStatus = 304;
      const cancel = new AbortController();
      const first = store.checkRelay("work", cancel.signal).then(
        () => "resolved",
        (error: Error) => error.message,
      );
      await until(() => !!releaseVersion);
      const statusBefore = statusHits;
      const versionsBefore = conditionalRequests.length;
      const second = store
        .checkRelay("work", new AbortController().signal)
        .then(
          () => "resolved",
          (error: Error) => error.message,
        );
      await until(() => statusHits > statusBefore);
      const state = store as unknown as {
        rows: { label: string }[];
        versionChecks: WeakMap<object, { waiters: number }>;
      };
      await until(
        () =>
          (state.versionChecks.get(
            state.rows.find((row) => row.label === "work")!,
          )?.waiters ?? 0) === 2,
      );
      expect(conditionalRequests).toHaveLength(versionsBefore);
      cancel.abort();
      expect(await first).toContain("aborted");
      version = {
        api: API_MAJOR + 1,
        api_revision: 0,
        release: { version: "future", commit: null },
      };
      releaseVersion!();
      releaseVersion = undefined;
      if (beforeResponse)
        expect(await second).toContain(`speaks API v${API_MAJOR + 1}`);
      else {
        expect(await second).toBe("resolved");
        await expect(
          store.checkRelay("work", new AbortController().signal),
        ).rejects.toThrow(`speaks API v${API_MAJOR + 1}`);
        version = { api: API_MAJOR, release: { version: "old", commit: null } };
        await store.checkRelay("work", new AbortController().signal);
      }
    }
    expect(store.list().find((row) => row.label === "work")).toMatchObject({
      compatibility: "incompatible",
      remote_api: API_MAJOR + 1,
    });
    expect(() => store.relayReady("work")).toThrow("speaks API");
    expect(() => store.transcript("work", cid, new URLSearchParams())).toThrow(
      "speaks API",
    );
    await expect(
      store.proxy("work", "/api/tree", new Request(homeUrl), false),
    ).rejects.toThrow("speaks API");
    for (const failure of ["json", "text"] as const) {
      versionUnavailable = failure;
      await expect(
        store.checkRelay("work", new AbortController().signal),
      ).rejects.toThrow(`speaks API v${API_MAJOR + 1}`);
    }
    versionUnavailable = null;
    version = null;
    await expect(
      store.checkRelay("work", new AbortController().signal),
    ).rejects.toThrow("invalid API version");
    version = {
      api: API_MAJOR,
      api_revision: API_REVISION,
      release: { version: "test", commit: null },
    };
    await store.checkRelay("work", new AbortController().signal);
    expect(
      store.list().find((row) => row.label === "work")?.compatibility,
    ).toBe("compatible");
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
    releaseVersion?.();
    await instance.shutdown();
    await home.running.close();
    await remote.running.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
