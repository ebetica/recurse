import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ReportDoc } from "../../src/agents/durable/report";
import { buildApp, WebLogSink } from "../../src/web/app";
import { BackendKeys } from "../../src/auth/backend_keys";
import { publishLoopbackToken } from "../../src/web/request_auth";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { appWorld, PASSWORD } from "./web_app_support";
import { fauxHost, held, until } from "./fixtures/durable_host/host";

// Regression: #2841 Local agent markers cannot reach operator settings or sign-in routes.
test("local agents cannot change operator settings or authentication", async () => {
  const world = appWorld({ password: true });
  const app = await buildApp({
    env: world.env,
    sink: new WebLogSink(() => {}),
  });
  const server = await app.serve({ port: 0 });
  const token = await publishLoopbackToken(
    world.env.CHAT_DATA_DIR!,
    server.port,
  );
  const request = (path: string, init: RequestInit = {}) =>
    fetch(server.url + path, { redirect: "manual", ...init });
  const operator = (path: string, init: RequestInit = {}) =>
    request(path, {
      ...init,
      headers: {
        "x-loopback-token": token,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  const snapshot = async () =>
    Promise.all(
      ["/api/settings/theme", "/api/settings/mcp-servers", "/api/pi/auth"].map(
        async (path) => (await operator(path)).text(),
      ),
    );
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    const caller = String(
      (await app.instance.create.create({ title: "Caller" })).id,
    );
    const before = await snapshot();
    for (const markers of [
      [caller],
      [""],
      ["invalid,marker"],
      [caller, caller],
    ]) {
      for (const [path, method, body] of [
        [
          "/api/settings/theme",
          "POST",
          JSON.stringify({ appearance: "light" }),
        ],
        ["/api/settings", "GET", undefined],
        [
          "/api/settings/mcp-servers",
          "PUT",
          JSON.stringify({ text: '{"mcpServers":{}}' }),
        ],
        [
          "/api/settings/mcp-servers/sign-in",
          "POST",
          JSON.stringify({ name: "missing" }),
        ],
        ["/api/settings/mcp-servers/oauth-callback", "GET", undefined],
        ["/api/settings/mcp-servers/finish-sign-in", "POST", "{}"],
        [
          "/api/pi/auth/api-key",
          "POST",
          JSON.stringify({ key: "sk-test-blocked" }),
        ],
        ["/api/pi/auth/logout", "POST", undefined],
        ["/logout", "POST", undefined],
        [
          "/api/password",
          "POST",
          JSON.stringify({ current: PASSWORD, new: "changed-password-123" }),
        ],
        [
          "/login",
          "POST",
          new URLSearchParams({ password: PASSWORD }).toString(),
        ],
      ] as const) {
        const headers = new Headers({
          "x-loopback-token": token,
          "content-type":
            path === "/login"
              ? "application/x-www-form-urlencoded"
              : "application/json",
        });
        for (const marker of markers) headers.append("x-recurse-agent", marker);
        const response = await request(path, { method, body, headers });
        expect({ path, status: response.status }).toEqual({
          path,
          status: 403,
        });
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(await snapshot()).toEqual(before);
      }
    }
    expect(
      (
        await operator("/api/settings/theme", {
          method: "POST",
          body: JSON.stringify({ appearance: "light" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await operator("/api/settings/mcp-servers", {
          method: "PUT",
          body: JSON.stringify({ text: '{"mcpServers":{}}' }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await operator("/api/pi/auth/api-key", {
          method: "POST",
          body: JSON.stringify({ key: "sk-test-operator" }),
        })
      ).status,
    ).toBe(200);
    expect(await (await operator("/api/pi/auth")).json()).toMatchObject({
      configured: true,
    });
    expect(
      (await operator("/api/pi/auth/logout", { method: "POST" })).status,
    ).toBe(200);
    const login = await request("/login", {
      method: "POST",
      body: new URLSearchParams({ password: PASSWORD }),
    });
    expect(login.status).toBe(303);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(
      (
        await request("/logout", {
          method: "POST",
          headers: { cookie: login.headers.get("set-cookie")!.split(";")[0]! },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await operator("/api/password", {
          method: "POST",
          body: JSON.stringify({
            current: PASSWORD,
            new: "changed-password-123",
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/login", {
          method: "POST",
          body: new URLSearchParams({ password: "changed-password-123" }),
        })
      ).status,
    ).toBe(303);
  } finally {
    await server.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    await rm(world.root, { recursive: true, force: true });
  }
});

// Feature: #2805 Live agents manage remote agents through a credential-free, restricted home gateway.
test("agent CLI creates and manages a connected remote agent", async () => {
  const worlds = [appWorld(), appWorld({ password: true })];
  const apps = await Promise.all(
    worlds.map(({ env }) => buildApp({ env, sink: new WebLogSink(() => {}) })),
  );
  const fixture = fauxHost(join(worlds[1]!.root, "provider"), undefined, true);
  const provider = (fixture.host as unknown as { deps: DurableHostDeps }).deps;
  for (const app of apps) {
    const deps = (app.instance.durable as unknown as { deps: DurableHostDeps })
      .deps;
    Object.assign(deps, {
      models: provider.models,
      settings: provider.settings,
    });
    const agentEnv = deps.agentEnv;
    deps.agentEnv = async (...args) => {
      const env = { ...(await agentEnv(...args)) };
      delete env.RECURSE_MODEL_POLICY;
      return env;
    };
  }
  const servers = await Promise.all(apps.map((app) => app.serve({ port: 0 })));
  let offlineTrap: ReturnType<typeof Bun.serve> | undefined;
  let holdStreams = false;
  const ingress = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const response = await fetch(
        servers[1]!.url + url.pathname + url.search,
        {
          method: request.method,
          headers: request.headers,
          body: request.body ? await request.arrayBuffer() : undefined,
          signal: request.signal,
        },
      ).catch(() => new Response(null, { status: 502 }));
      if (!holdStreams || !url.pathname.endsWith("/events") || !response.ok)
        return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
          },
        }),
        { headers },
      );
    },
  });
  const token = await publishLoopbackToken(
    worlds[0]!.env.CHAT_DATA_DIR!,
    servers[0]!.port,
  );
  const home = apps[0]!.instance;
  const remote = apps[1]!.instance;
  const homeUrl = servers[0]!.url;
  let caller = "";
  const gateway = (path: string, init?: RequestInit) =>
    fetch(homeUrl + "/api/backends/B/" + path, {
      ...init,
      headers: {
        "x-loopback-token": token,
        "x-recurse-agent": caller,
        ...init?.headers,
      },
    });
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../tools/subagent.ts"),
        ...args,
      ],
      {
        cwd: worlds[0]!.env.CHAT_REPO_URL,
        env: { ...worlds[0]!.env, RECURSE_AGENT_ID: caller },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  try {
    await until(() =>
      apps.every((app) => app.instance.lifecycle.readinessSnapshot().ready),
    );
    caller = String((await home.create.create({ title: "Home caller" })).id);
    const connected = await fetch(homeUrl + "/api/backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "B",
        url: ingress.url.origin,
        password: PASSWORD,
      }),
    });
    expect(connected.status).toBe(200);
    const homeKey = await new BackendKeys(worlds[0]!.env.CHAT_DATA_DIR!).mint(
      "not-an-agent",
    );
    const rejectedCallers: Record<string, string>[] = [
      { "x-loopback-token": token },
      { "x-loopback-token": token, "x-recurse-agent": "missing-agent" },
      { authorization: `Bearer ${homeKey.key}`, "x-recurse-agent": caller },
    ];
    for (const rejected of rejectedCallers) {
      expect(
        (await fetch(homeUrl + "/api/backends/B/tree", { headers: rejected }))
          .status,
      ).toBe(403);
    }
    const remoteKey = await new BackendKeys(worlds[1]!.env.CHAT_DATA_DIR!).mint(
      "home-agent",
    );
    for (const [path, method] of [
      ["settings", "GET"],
      ["settings/effort-levels", "POST"],
      ["settings/effort-levels", "GET"],
      ["settings/mcp-servers", "PUT"],
      ["settings/mcp-servers/sign-in", "POST"],
      ["pi/auth/login-url", "POST"],
      ["pi/auth/api-key", "POST"],
      ["pi/openrouter-auth/api-key", "POST"],
      ["password", "POST"],
      ["backend-keys", "GET"],
      ["backends", "GET"],
      ["auth", "GET"],
      ["conversations/anything/safety", "POST"],
    ]) {
      const response = await gateway(path!, { method });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("recurse-link_");
      const direct = await fetch(servers[1]!.url + "/api/" + path, {
        method,
        headers: {
          authorization: `Bearer ${remoteKey.key}`,
          "x-recurse-agent-caller": caller,
        },
      });
      expect(direct.status).toBe(403);
      expect(await direct.text()).toContain("remote agent not allowed");
    }
    for (const key of ["safety", "safety_off", "safety_off_active"]) {
      const denied = await gateway("conversations/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "unsafe-spawn",
          title: "Unsafe",
          [key]: true,
        }),
      });
      expect(denied.status).toBe(422);
      expect(await denied.text()).toContain("safety");
    }
    const incompatible = await cli(
      "create",
      "--remote",
      "B",
      "--taken-over",
      "--title",
      "Invalid",
      "Task",
    );
    expect(incompatible.code).toBe(2);
    expect(incompatible.stderr).toContain(
      "--remote cannot be combined with --taken-over",
    );
    fixture.faux.setResponses([fauxAssistantMessage("Operator-only reply")]);
    const takenOver = await cli(
      "create",
      "--taken-over",
      "--title",
      "Operator worker",
      "Answer the operator",
    );
    expect(takenOver).toMatchObject({ code: 0, stderr: "" });
    expect(takenOver.stdout).toContain("its replies are not reported to you");
    const heldId = takenOver.stdout.match(/[a-f0-9]{12}/)![0];
    expect(home.conversations.load(heldId)).toMatchObject({
      parent: caller,
      pinned: true,
      muted: true,
      pinned_order: expect.any(String),
    });
    const opened = await home.durable.open(heldId);
    await until(
      async () =>
        ((
          await opened.harness.snapshot(
            ReportDoc,
            opened.conversation.id,
            context,
          )
        )?.after ?? -1) >= 0,
    );
    expect(JSON.stringify(await home.durable.view(heldId))).toContain(
      "Operator-only reply",
    );
    expect(home.nodes.node(caller).inboxMessages()).toEqual([]);
    expect(JSON.stringify(await home.durable.view(caller))).not.toContain(
      "Operator-only reply",
    );
    expect(JSON.stringify(await home.durable.view(caller))).not.toContain(
      "User has taken control",
    );
    const heldState = home.conversations.load(heldId)!;
    for (const markers of [
      [caller],
      ["invalid,marker"],
      [""],
      [caller, caller],
    ]) {
      for (const pinned of [false, true]) {
        const headers = new Headers({
          "x-loopback-token": token,
          "content-type": "application/json",
        });
        for (const marker of markers) headers.append("x-recurse-agent", marker);
        const denied = await fetch(
          `${homeUrl}/api/conversations/${heldId}/pin`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ pinned }),
          },
        );
        expect(denied.status).toBe(403);
        expect(home.conversations.load(heldId)).toMatchObject({
          pinned: heldState.pinned,
          muted: heldState.muted,
          pinned_order: heldState.pinned_order,
        });
      }
    }
    for (const pinned of [false, true]) {
      const allowed = await fetch(
        `${homeUrl}/api/conversations/${heldId}/pin`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned }),
        },
      );
      expect(allowed.status).toBe(200);
      expect(home.conversations.load(heldId)).toMatchObject({
        pinned,
        muted: pinned,
      });
    }
    fixture.faux.setResponses([
      fauxAssistantMessage("Top-level operator reply"),
    ]);
    const sibling = await cli(
      "create",
      "--sibling",
      "--taken-over",
      "--title",
      "Operator sibling",
      "Answer the operator",
    );
    expect(sibling).toMatchObject({ code: 0, stderr: "" });
    const siblingId = sibling.stdout.match(/[a-f0-9]{12}/)![0];
    await until(async () =>
      JSON.stringify(await home.durable.view(siblingId)).includes(
        "Top-level operator reply",
      ),
    );
    expect(home.conversations.load(siblingId)).toMatchObject({
      parent: null,
      pinned: true,
      muted: true,
      pinned_order: expect.any(String),
    });
    fixture.faux.setResponses([fauxAssistantMessage("Remote gateway reply")]);
    const created = await cli(
      "create",
      "--remote",
      "B",
      "--title",
      "Remote worker",
      "--effort",
      "2",
      "Answer from the remote instance",
    );
    expect(created).toMatchObject({ code: 0 });
    const target = created.stdout.match(/([a-f0-9]{12})@B/)?.[0];
    expect(target).toBeDefined();
    const cid = target!.split("@")[0]!;
    await until(async () =>
      JSON.stringify(await remote.durable.view(cid)).includes(
        "Remote gateway reply",
      ),
    );
    const stored = remote.conversations.load(cid)!;
    expect(stored.parent).toBeNull();
    expect(stored.workdir).toBe(worlds[1]!.env.CHAT_REPO_URL);
    expect(stored.level).toBe(2);
    expect(remote.durable.safetyReviewOff(cid)).toBe(false);
    expect(home.conversations.load(cid)).toBeNull();
    for (const args of [
      ["tail", target!],
      ["wait", target!, "--timeout", "5"],
    ]) {
      const result = await cli(...args);
      expect(result).toMatchObject({ code: 0 });
      expect(result.stdout).toContain("Remote gateway reply");
      expect(result.stdout + result.stderr).not.toContain("recurse-link_");
    }
    const local = await cli("tail", caller);
    expect(local.code).toBe(0);
    expect(local.stdout).toContain(worlds[0]!.env.CHAT_REPO_URL!);
    expect(local.stdout).not.toContain("Remote gateway reply");
    for (const [agent, off, status, reviewOff] of [
      [caller, true, 403, false],
      [null, true, 200, true],
      [caller, false, 403, true],
      [null, false, 200, false],
    ] as const) {
      const toggled = await fetch(
        `${servers[1]!.url}/api/conversations/${cid}/safety`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${remoteKey.key}`,
            "content-type": "application/json",
            ...(agent ? { "x-recurse-agent-caller": agent } : {}),
          },
          body: JSON.stringify({ off }),
        },
      );
      expect(toggled.status).toBe(status);
      expect(remote.durable.safetyReviewOff(cid)).toBe(reviewOff);
    }
    const streams: {
      controller: AbortController;
      reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">;
    }[] = [];
    holdStreams = true;
    try {
      for (let i = 0; i < 16; i++) {
        const controller = new AbortController();
        const response = await gateway(`conversations/${cid}/events`, {
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        streams.push({ controller, reader });
      }
      expect((await gateway(`conversations/${cid}/events`)).status).toBe(429);
      streams[0]!.controller.abort();
      await streams[0]!.reader.cancel().catch(() => {});
      await until(async () => {
        const response = await gateway("status");
        await response.body?.cancel();
        return response.status === 200;
      });
    } finally {
      holdStreams = false;
      for (const { controller, reader } of streams) {
        controller.abort();
        await reader.cancel().catch(() => {});
      }
    }
    await until(async () => (await gateway("status")).status === 200);
    const blocked = held(fauxAssistantMessage("Must be interrupted"));
    fixture.faux.setResponses([blocked.step]);
    await remote.delivery.deliver(cid, "Wait until interrupted", {
      origin: "operator",
    });
    await blocked.started;
    expect(remote.durable.runningCount()).toBe(1);
    const interrupted = await cli("interrupt", target!);
    expect(interrupted.code).toBe(0);
    await until(() => remote.durable.runningCount() === 0);
    expect(JSON.stringify(await remote.durable.view(cid))).not.toContain(
      "Must be interrupted",
    );
    await remote.create.setPinned(cid, true);
    expect((await cli("rm", target!)).code).not.toBe(0);
    expect(remote.conversations.load(cid)!.pinned).toBe(true);
    expect(
      (
        await gateway(`conversations/${cid}/pin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned: false }),
        })
      ).status,
    ).toBe(403);
    await remote.create.setPinned(cid, false);
    const child = await remote.create.create({
      parent: cid,
      title: "Operator child",
    });
    await remote.create.setPinned(String(child.id), true);
    expect((await cli("rm", target!)).code).not.toBe(0);
    expect(remote.conversations.load(cid)!.status).not.toBe("deleting");
    expect(remote.conversations.load(String(child.id))!.pinned).toBe(true);
    await remote.create.setPinned(String(child.id), false);
    const removed = await cli("rm", target!);
    expect(removed.code).toBe(0);
    await until(() => !remote.conversations.load(cid));
    const keyless = await fetch(homeUrl + "/api/backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Open", url: homeUrl }),
    });
    expect(keyless.status).toBe(200);
    const operatorOpen = await fetch(homeUrl + "/api/backends/Open/status");
    expect(operatorOpen.status).toBe(200);
    await operatorOpen.body?.cancel();
    const open = await fetch(homeUrl + "/api/backends/Open/tree", {
      headers: { "x-loopback-token": token, "x-recurse-agent": caller },
    });
    expect(open.status).toBe(403);
    expect(await open.text()).toContain("requires a backend key");
    await servers[1]!.close();
    ingress.stop(true);
    const offline = await cli("tail", target!);
    expect(offline.code).not.toBe(0);
    expect(offline.stderr).toContain("remote offline (last seen");
    let outboundSpawns = 0;
    offlineTrap = Bun.serve({
      hostname: "127.0.0.1",
      port: ingress.port,
      fetch(request) {
        if (new URL(request.url).pathname === "/api/conversations/spawn")
          outboundSpawns++;
        return new Response(null, { status: 503 });
      },
    });
    expect(
      (
        await cli(
          "create",
          "--remote",
          "B",
          "--title",
          "Offline",
          "Must not queue",
        )
      ).code,
    ).not.toBe(0);
    expect(outboundSpawns).toBe(0);
  } finally {
    offlineTrap?.stop(true);
    ingress.stop(true);
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await fixture.host.close();
    await Promise.all(apps.flatMap((app) => app.detached));
    await Promise.all(
      worlds.map(({ root }) => rm(root, { recursive: true, force: true })),
    );
  }
}, 120_000);
