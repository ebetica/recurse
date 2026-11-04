import { expect, setSystemTime, test } from "bun:test";
import { ConnectedBackends } from "../../src/backends/connected";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../src/web/app";
import { publishLoopbackToken } from "../../src/web/request_auth";
import { BackendKeys } from "../../src/auth/backend_keys";
import { keyedLabel } from "../../src/backends/label";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { RelayQueue } from "../../src/web/relay_queue";
import { appWorld, PASSWORD } from "./web_app_support";
import { fauxHost, until } from "./fixtures/durable_host/host";

// Feature: #2935 Idle remotes pause home polls and tag streams (#3017).
test("an idle sleeping remote pauses home polls, queues messages and wakes on use", async () => {
  const checkins: string[] = [];
  let checkAnswer: "sleep" | "wake" | "error" = "sleep";
  let laptopAuth = "";
  let laptopPaused = 0;
  const checkIn = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const auth = request.headers.get("authorization") ?? "";
      checkins.push(`${new URL(request.url).pathname} ${auth.slice(0, 20)}`);
      const answer = auth === laptopAuth ? checkAnswer : "sleep";
      if (answer === "error") return new Response("down", { status: 500 });
      if (answer === "sleep" && auth === laptopAuth) laptopPaused++;
      return Response.json({
        requests: [],
        ...(answer === "sleep" ? { sleep_seconds: 1 } : {}),
      });
    },
  });
  const worlds = [
    appWorld({ password: true }),
    appWorld({ password: true }),
    appWorld(),
  ];
  worlds[0]!.env.CHAT_APP_NAME = "Home";
  worlds[2]!.env.CHAT_APP_NAME = "Laptop";
  worlds[1]!.env.RECURSE_SLEEP_WHEN_IDLE = "1";
  worlds[1]!.env.RECURSE_SLEEP_CHECK_URL = checkIn.url.origin;
  const fixtures = worlds.map(({ root }) =>
    fauxHost(join(root, "provider"), undefined, true),
  );
  const build = async (i: number) => {
    const app = await buildApp({
      env: worlds[i]!.env,
      sink: new WebLogSink(() => {}),
    });
    const deps = (app.instance.durable as unknown as { deps: DurableHostDeps })
      .deps;
    const provider = (fixtures[i]!.host as unknown as { deps: DurableHostDeps })
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
    return app;
  };
  const apps = await Promise.all(worlds.map((_, i) => build(i)));
  const servers = await Promise.all(apps.map((app) => app.serve({ port: 0 })));
  const [home, , laptop] = apps;
  const seen: Record<string, string[]> = { home: [], laptop: [] };
  const open: Record<string, number> = { home: 0, laptop: 0 };
  const slept: Record<string, number> = { home: 0, laptop: 0 };
  const paused: Record<string, boolean> = { home: false, laptop: false };
  const gateway = (name: string) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen[name]!.push(url.pathname + url.search);
        if (name === "laptop" && url.pathname === "/api/relay/requests")
          laptopAuth = request.headers.get("authorization") ?? "";
        open[name]!++;
        try {
          const headers = new Headers(request.headers);
          headers.set("accept-encoding", "identity");
          const response = await fetch(
            servers[1]!.url + url.pathname + url.search,
            {
              method: request.method,
              headers,
              body: request.body,
              signal: request.signal,
            },
          ).catch(() => new Response("remote restarting", { status: 502 }));
          const body = await response.text().catch((error: unknown) => {
            if (url.pathname === "/api/tree/events") return "";
            throw error;
          });
          const sleep =
            body.includes('"sleep_seconds":3600') &&
            body.includes(`"check_url":"${checkIn.url.origin}"`);
          if (url.pathname === "/api/relay/requests") paused[name] = sleep;
          if (!sleep) return new Response(body, response);
          slept[name]!++;
          return Response.json(
            JSON.parse(
              body.replace('"sleep_seconds":3600', '"sleep_seconds":1'),
            ),
          );
        } finally {
          open[name]!--;
        }
      },
    });
  const gateways = { home: gateway("home"), laptop: gateway("laptop") };
  const tokens: string[] = [];
  for (const [i, server] of servers.entries())
    tokens[i] = await publishLoopbackToken(
      worlds[i]!.env.CHAT_DATA_DIR!,
      server.port,
    );
  const cliPath = resolve(import.meta.dir, "../../tools/subagent.ts");
  const settled = (i: number, cid: string) => () =>
    apps[i]!.instance.durable.runningCount() === 0 &&
    apps[i]!.instance.durable.metadata(cid).pending.length === 0;
  const viewed = (i: number, cid: string, text: string) => async () =>
    JSON.stringify(await apps[i]!.instance.durable.view(cid)).includes(text);
  const learn = RelayQueue.prototype.learn;
  const sidebarStreams: AbortController[] = [];
  let laptopLearned = 0;
  RelayQueue.prototype.learn = async function (labels, name, key) {
    await learn.call(this, labels, name, key);
    if (labels.includes("Laptop")) laptopLearned++;
  };
  try {
    await until(() =>
      apps.every((app) => app.instance.lifecycle.readinessSnapshot().ready),
    );
    apps[1]!.connectedBackends.idleAfterMs = 3000;
    const ids = await Promise.all(
      apps.map(async (app, i) => {
        const id = String(
          (await app!.instance.create.create({ title: `Agent ${i}` })).id,
        );
        fixtures[i]!.faux.setResponses([fauxAssistantMessage("ready")]);
        await app!.instance.nodes.node(id).setSafety(true);
        await until(viewed(i, id, "ready"));
        await until(settled(i, id));
        return id;
      }),
    );
    const [h, r, p] = ids as [string, string, string];
    const login = await fetch(servers[0]!.url + "/login", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ password: PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const homeOrigin = new URL(servers[0]!.url).origin;
    const browser = { "sec-fetch-site": "same-origin" };
    const connectHome = await fetch(servers[0]!.url + "/api/backends", {
      method: "POST",
      headers: {
        ...browser,
        cookie,
        origin: homeOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        label: "R",
        url: gateways.home.url.origin,
        password: PASSWORD,
      }),
    });
    expect(connectHome.status).toBe(200);
    const connectLaptop = await fetch(servers[2]!.url + "/api/backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "R",
        url: gateways.laptop.url.origin,
        password: PASSWORD,
      }),
    });
    expect(connectLaptop.status).toBe(200);
    expect(
      (
        await fetch(servers[0]!.url + "/api/backends/R/tree", {
          headers: { ...browser, cookie },
        })
      ).status,
    ).toBe(200);
    const openSidebar = async () => {
      const controller = new AbortController();
      sidebarStreams.push(controller);
      const response = await fetch(
        servers[0]!.url + "/api/tree/events?backend=R",
        {
          headers: { ...browser, cookie },
          signal: controller.signal,
        },
      );
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let frame = "";
      while (!frame.includes("\n\n")) {
        const part = await reader.read();
        expect(part.done).toBe(false);
        frame += decoder.decode(part.value, { stream: true });
      }
      reader.releaseLock();
      const labels = JSON.parse(/^data: (.+)$/m.exec(frame)![1]!) as string[];
      return { controller, labels };
    };
    const sidebar = await openSidebar();
    await until(() => seen.home!.includes("/api/tree/events"));
    const callbacks = async () => {
      for await (const path of new Bun.Glob(
        "**/recurse-home-callbacks.json",
      ).scan({ cwd: worlds[1]!.root, dot: true, absolute: true }))
        return JSON.parse(await readFile(path, "utf8")) as {
          url: string;
          token: string;
          labels: string[];
        }[];
      return [];
    };
    await until(async () => (await callbacks()).length === 1, 30_000);
    expect(await callbacks()).toMatchObject([
      { url: homeOrigin, labels: ["Home"] },
    ]);
    const token = `Bearer ${(await callbacks())[0]!.token}`;
    const homeCall = (path: string, authorization: string, body?: object) =>
      fetch(servers[0]!.url + path, {
        method: body ? "POST" : "GET",
        headers: { authorization, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await homeCall("/api/tree", token)).status).toBe(401);
    expect(
      (await homeCall("/api/backends", token, { label: "x", url: homeOrigin }))
        .status,
    ).toBe(401);
    expect(
      (
        await homeCall(
          "/api/remote-events",
          token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"),
          {
            type: "relay",
          },
        )
      ).status,
    ).toBe(401);
    const polls = () =>
      seen.laptop!.filter((path) => path.startsWith("/api/relay/requests?"))
        .length;
    const quietly = async () => {
      await until(
        () =>
          open.home === 0 &&
          open.laptop === 0 &&
          paused.home! &&
          paused.laptop!,
        30_000,
      );
      const quiet = { home: seen.home!.length, laptop: seen.laptop!.length };
      await Bun.sleep(2000);
      expect({ home: seen.home!.length, laptop: seen.laptop!.length }).toEqual(
        quiet,
      );
      return quiet;
    };
    await until(() => slept.home > 0 && slept.laptop > 0, 30_000);
    const checked = checkins.length;
    const quiet = await quietly();
    sidebar.controller.abort();
    const sleepingSidebar = await openSidebar();
    expect(sleepingSidebar.labels).not.toContain("R");
    await quietly();
    expect(checkins.length).toBeGreaterThan(checked);
    expect(new Set(checkins)).toEqual(
      new Set(["/api/relay/requests Bearer recurse-link_"]),
    );
    const pair = await new BackendKeys(worlds[1]!.env.CHAT_DATA_DIR!).mint(
      "Pair",
    );
    const long = "abcdefghijklmnopqrstuvwxyz0123";
    const short = keyedLabel(long, pair.id).split(".")[0]!;
    const pairPoll = (labels: string) =>
      fetch(servers[1]!.url + `/api/relay/requests?labels=${labels}&wait=0`, {
        headers: { authorization: `Bearer ${pair.key}` },
      }).then(
        (response) =>
          response.json() as Promise<{
            requests: unknown[];
            sleep_seconds?: number;
          }>,
      );
    const pairSend = (content: string) =>
      fetch(servers[1]!.url + "/api/relay/messages", {
        method: "POST",
        headers: {
          "x-loopback-token": tokens[1]!,
          "x-recurse-agent": r,
          "x-recurse-bundled-tool": "subagent",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          target: `${p}@${keyedLabel(long, pair.id)}`,
          content,
        }),
      });
    expect(await pairPoll(long)).toMatchObject({ sleep_seconds: 3600 });
    const queuedForLong = await pairSend("For the long label");
    expect(queuedForLong.status).toBe(202);
    const { id: longId } = (await queuedForLong.json()) as { id: string };
    await until(
      async () =>
        (
          (await (
            await fetch(servers[1]!.url + `/api/relay/messages/${longId}`, {
              headers: {
                "x-loopback-token": tokens[1]!,
                "x-recurse-agent": r,
                "x-recurse-bundled-tool": "subagent",
              },
            })
          ).json()) as { state: string }
        ).state === "queued",
    );
    expect(await pairPoll(`${long},${short}`)).toMatchObject({
      sleep_seconds: 3600,
    });
    const refused = await pairSend("Which label?");
    expect([refused.status, await refused.json()]).toEqual([
      409,
      { detail: `no connected home routes to ${keyedLabel(long, pair.id)}` },
    ]);
    expect((await pairPoll(short)).requests).toEqual([]);
    const remoteSends = async (...targets: string[]) => {
      await until(settled(1, r));
      fixtures[1]!.faux.setResponses([
        ...targets.map((target) =>
          fauxAssistantMessage(
            fauxToolCall("bash", {
              command: `bun ${cliPath} send ${target} 'Remote update'`,
            }),
            { stopReason: "toolUse" },
          ),
        ),
        fauxAssistantMessage("remote done"),
      ]);
      await apps[1]!.instance.delivery.deliver(r, "Report back", {
        origin: "operator",
      });
    };
    fixtures[0]!.faux.setResponses([fauxAssistantMessage("home received")]);
    await remoteSends(`${h}@Home`, `${p}@Laptop`);
    await until(viewed(1, r, "remote done"), 30_000);
    await until(settled(1, r));
    const remoteView = JSON.stringify(await apps[1]!.instance.durable.view(r));
    expect(remoteView).toContain(`Delivered to ${h}@Home.`);
    expect(remoteView).toContain(
      "Queued: queued for Laptop, which gets it when it next polls.",
    );
    await until(viewed(0, h, "home received"));
    expect(JSON.stringify(await home!.instance.durable.prompt(h))).toContain(
      `[recurse-from: ${r}@R]`,
    );
    const pushed = seen.home!.slice(quiet.home);
    expect(
      pushed.find((path) => path.startsWith("/api/relay/requests?")),
    ).toContain("wait=0");
    expect(pushed.filter((path) => path === "/api/status")).toEqual([]);
    expect(seen.laptop!.length).toBe(quiet.laptop);
    const cli = (i: number, agent: string, ...args: string[]) => {
      const child = Bun.spawn([process.execPath, cliPath, ...args], {
        env: { ...worlds[i]!.env, RECURSE_AGENT_ID: agent },
        stdout: "pipe",
        stderr: "pipe",
      });
      return Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
    };
    const relayHeaders = () => ({
      "x-loopback-token": tokens[1]!,
      "x-recurse-agent": r,
      "x-recurse-bundled-tool": "subagent",
      "content-type": "application/json",
    });
    let reason = "";
    for (let i = 1; i <= 20; i++) {
      const sent = await fetch(servers[1]!.url + "/api/relay/messages", {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({
          target: `${p}@Laptop`,
          content: `Queued ${String(i).padStart(2, "0")}`,
        }),
      });
      expect(sent.status).toBe(202);
      const { id } = (await sent.json()) as { id: string };
      const outcome = async () =>
        (await (
          await fetch(servers[1]!.url + `/api/relay/messages/${id}`, {
            headers: relayHeaders(),
          })
        ).json()) as { state: string; reason: string };
      await until(async () => (await outcome()).state === "queued");
      reason = (await outcome()).reason;
    }
    expect(reason).toContain("dropped the 1 oldest queued message(s)");
    const remotePort = servers[1]!.port;
    await servers[1]!.close();
    await apps[1]!.instance.shutdown();
    await Promise.all(apps[1]!.detached);
    const queuePath = join(worlds[1]!.env.CHAT_DATA_DIR!, "relay-queue.json");
    const keyed = JSON.parse(await readFile(queuePath, "utf8")) as {
      labels: Record<string, { name: string; key: string; label?: string }>;
      requests: { label: string }[];
    };
    const laptopAddress = Object.keys(keyed.labels).find(
      (address) => keyed.labels[address]!.label === "Laptop",
    )!;
    expect(laptopAddress).toMatch(/^Laptop\.[a-f0-9]{6}$/);
    const legacy = {
      labels: Object.fromEntries(
        Object.values(keyed.labels).map(({ label, ...route }) => [
          label!,
          route,
        ]),
      ),
      requests: keyed.requests.map((r) => ({
        ...r,
        label: keyed.labels[r.label]!.label!,
      })),
    };
    expect(legacy.requests.map((r) => r.label)).toContain("Laptop");
    await writeFile(queuePath, JSON.stringify(legacy));
    apps[1] = await build(1);
    servers[1] = await apps[1].serve({ port: remotePort });
    tokens[1] = await publishLoopbackToken(
      worlds[1]!.env.CHAT_DATA_DIR!,
      remotePort,
    );
    await until(() => apps[1]!.instance.lifecycle.readinessSnapshot().ready);
    apps[1]!.connectedBackends.idleAfterMs = 3000;
    fixtures[2]!.faux.setResponses(
      Array.from({ length: 25 }, () => fauxAssistantMessage("laptop ok")),
    );
    const laptopPrompt = async () =>
      JSON.stringify(await laptop!.instance.durable.prompt(p));
    await Bun.sleep(2000);
    expect(seen.laptop!.length).toBe(quiet.laptop);
    const asleepPolls = polls();
    checkAnswer = "wake";
    await until(
      async () => (await laptopPrompt()).includes("Queued 20"),
      30_000,
    );
    checkAnswer = "sleep";
    expect(polls()).toBeGreaterThan(asleepPolls);
    const [statusOut, statusErr, statusCode] = await cli(
      2,
      p,
      "status",
      `${r}@R`,
      "--json",
    );
    expect([statusCode, statusErr]).toEqual([0, ""]);
    expect(JSON.parse(statusOut).id).toBe(r);
    expect(await laptopPrompt()).toContain("Queued 01");
    expect(await laptopPrompt()).not.toContain("Remote update");
    const migrated = JSON.parse(await readFile(queuePath, "utf8")) as {
      labels: Record<string, { label?: string }>;
    };
    expect(migrated.labels.Laptop).toBeUndefined();
    expect(migrated.labels[laptopAddress]).toMatchObject({ label: "Laptop" });
    await until(settled(2, p));
    let sleeps = slept.laptop;
    await until(() => slept.laptop > sleeps, 30_000);
    await quietly();
    const before = polls();
    const learnedBefore = laptopLearned;
    fixtures[1]!.faux.setResponses([
      async (_context, options) => {
        await until(
          () => laptopLearned > learnedBefore || !!options?.signal?.aborted,
          30_000,
        );
        return fauxAssistantMessage(
          fauxToolCall("bash", {
            command: `bun ${cliPath} send ${p}@Laptop 'Reply while awake'`,
          }),
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("remote replied"),
    ]);
    fixtures[2]!.faux.setResponses([fauxAssistantMessage("laptop ok")]);
    expect(await cli(2, p, "send", `${r}@R`, "Laptop says hi")).toEqual([
      `Delivered to ${r}@R.\n`,
      "",
      0,
    ]);
    await until(() => polls() > before, 30_000);
    await until(viewed(1, r, "remote replied"), 30_000);
    await until(
      async () =>
        JSON.stringify(await apps[1]!.instance.durable.view(r)).includes(
          `Delivered to ${p}@Laptop.`,
        ),
      30_000,
    );
    expect(JSON.stringify(await apps[1]!.instance.durable.view(r))).toContain(
      `Delivered to ${p}@Laptop.`,
    );
    await until(
      async () => (await laptopPrompt()).includes("Reply while awake"),
      30_000,
    );
    await until(settled(1, r));
    await until(settled(2, p));
    sleeps = slept.laptop;
    await until(() => slept.laptop > sleeps, 30_000);
    await quietly();
    checkAnswer = "error";
    const failedCheck = polls();
    await until(() => polls() > failedCheck, 30_000);
    checkAnswer = "sleep";
    const checksBefore = laptopPaused;
    await until(() => laptopPaused > checksBefore, 30_000);
    await quietly();
    expect(
      (await fetch(servers[2]!.url + "/api/backends/R", { method: "DELETE" }))
        .status,
    ).toBe(200);
    sleeps = slept.laptop;
    const reconnect = await fetch(servers[2]!.url + "/api/backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "R",
        url: gateways.laptop.url.origin,
        password: PASSWORD,
      }),
    });
    expect(reconnect.status).toBe(200);
    await until(() => slept.laptop > sleeps, 30_000);
    await quietly();
    for (const controller of sidebarStreams) controller.abort();
    const homePort = servers[0]!.port;
    await servers[0]!.close();
    await apps[0]!.instance.shutdown();
    await Promise.all(apps[0]!.detached);
    apps[0] = await build(0);
    servers[0] = await apps[0].serve({ port: homePort });
    tokens[0] = await publishLoopbackToken(
      worlds[0]!.env.CHAT_DATA_DIR!,
      homePort,
    );
    await until(() => apps[0]!.instance.lifecycle.readinessSnapshot().ready);
    fixtures[0]!.faux.setResponses([fauxAssistantMessage("home woke")]);
    await remoteSends(`${h}@Home`);
    await until(viewed(1, r, "remote done"), 30_000);
    await until(viewed(0, h, "home woke"), 30_000);
    const homeStatus = await cli(0, h, "status", `${r}@R`, "--json");
    expect([homeStatus[2], homeStatus[1]]).toEqual([0, ""]);
    expect(JSON.parse(homeStatus[0]).id).toBe(r);
    const remoteLogin = await fetch(servers[1]!.url + "/login", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ password: PASSWORD }),
    });
    const remoteCookie = remoteLogin.headers.get("set-cookie")!.split(";")[0]!;
    const keys = (await (
      await fetch(servers[1]!.url + "/api/backend-keys", {
        headers: { cookie: remoteCookie },
      })
    ).json()) as { id: string; name: string }[];
    const homeKey = keys.find((key) => key.name === "Home")!;
    expect(
      (
        await fetch(servers[1]!.url + `/api/backend-keys/${homeKey.id}`, {
          method: "DELETE",
          headers: { cookie: remoteCookie },
        })
      ).status,
    ).toBe(200);
    await remoteSends(`${h}@Home`);
    await until(
      viewed(1, r, "Failed: no connected home routes to Home."),
      30_000,
    );
    expect(await callbacks()).toEqual([]);
  } finally {
    for (const controller of sidebarStreams) controller.abort();
    RelayQueue.prototype.learn = learn;
    checkIn.stop(true);
    gateways.home.stop(true);
    gateways.laptop.stop(true);
    await Promise.all(servers.map((s) => s.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await Promise.all(fixtures.map((f) => f.host.close()));
    await Promise.all(apps.flatMap((app) => app.detached));
    await Promise.all(
      worlds.map(({ root }) => rm(root, { recursive: true, force: true })),
    );
  }
}, 240_000);

// Regression: #2994 Passive probes respect sleep and revoked keys (#3000, #3017).
test("passive probes allow sleep and revoked connections stay stopped until sign-in", async () => {
  const world = appWorld({ password: true });
  const homeWorld = appWorld();
  world.env.RECURSE_SLEEP_WHEN_IDLE = "1";
  const app = await buildApp({
    env: world.env,
    sink: new WebLogSink(() => {}),
  });
  const server = await app.serve({ port: 0 });
  const seen: string[] = [];
  let livePolls = 0;
  let rejectPolls = false;
  let rejectVersion = false;
  let injectCredential = false;
  let holdRelay = false;
  const heldRelay = Promise.withResolvers<void>();
  const revoked = Promise.withResolvers<void>();
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const live = url.pathname.startsWith("/live/");
      const path = live ? url.pathname.slice(5) : url.pathname;
      if (!live) seen.push(path);
      if (!live && rejectVersion && path === "/api/version")
        return new Response("sign-in required", { status: 401 });
      const headers = new Headers(request.headers);
      if (injectCredential && headers.has("authorization")) {
        const credential = headers
          .get("authorization")!
          .slice("Bearer ".length);
        headers.set("x-forwarded-for", credential);
        headers.set("user-agent", credential);
      }
      if (path === "/api/relay/requests") {
        if (live) livePolls++;
        url.searchParams.set("wait", "0");
        if (!live && holdRelay) {
          holdRelay = false;
          heldRelay.resolve();
          await revoked.promise;
        }
      }
      const response = await fetch(server.url + path + url.search, {
        headers,
        method: request.method,
        body: request.body,
        signal: request.signal,
      });
      if (
        path === "/api/relay/requests" &&
        response.ok &&
        (live || rejectPolls)
      )
        return Response.json({ requests: [], sleep_seconds: 0.01 });
      return response;
    },
  });
  let homeApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  let homeServer: Awaited<ReturnType<typeof app.serve>> | undefined;
  const startHome = async () => {
    homeApp = await buildApp({
      env: homeWorld.env,
      sink: new WebLogSink(() => {}),
    });
    homeServer = await homeApp.serve({ port: 0 });
    await until(() => homeApp!.instance.lifecycle.readinessSnapshot().ready);
  };
  const stopHome = async () => {
    await homeServer!.close();
    await homeApp!.instance.shutdown();
    await Promise.all(homeApp!.detached);
  };
  let now = Date.now();
  const advance = (ms: number) => setSystemTime((now += ms));
  advance(0);
  try {
    await until(() => app.instance.lifecycle.readinessSnapshot().ready);
    const passive = await ConnectedBackends.load(
      join(world.root, "passive"),
      "Passive",
      () => {},
    );
    await passive.connect("R", gateway.url.origin, PASSWORD);
    const signal = new AbortController().signal;
    advance(240_000);
    expect(app.connectedBackends.idle()).toBe(true);
    const streamController = new AbortController();
    const stream = await passive.treeEvents(
      "R",
      new Request(server.url + "/api/tree/events", {
        signal: streamController.signal,
      }),
    );
    expect(stream?.headers.get("content-type")).toContain("text/event-stream");
    expect(app.connectedBackends.idle()).toBe(true);
    streamController.abort();
    await stream?.body?.cancel().catch(() => {});
    const before = seen.length;
    await passive.refreshStale();
    expect(seen.slice(before)).toContain("/api/status");
    expect(app.connectedBackends.idle()).toBe(true);
    expect(
      (await passive.poll("R", ["Passive"], signal, 0)).data,
    ).toMatchObject({
      sleep_seconds: 3600,
    });
    advance(60_001);
    const paused = seen.length;
    expect(
      await passive.treeEvents(
        "R",
        new Request(server.url + "/api/tree/events"),
      ),
    ).toBeNull();
    await passive.refreshStale();
    expect(seen.length).toBe(paused);
    await passive.disconnect("R");
    setSystemTime();
    rejectPolls = true;
    injectCredential = true;
    await startHome();
    await homeApp!.connectedBackends.connect("R", gateway.url.origin, PASSWORD);
    await homeApp!.connectedBackends.connect(
      "Live",
      gateway.url.origin + "/live",
      PASSWORD,
    );
    holdRelay = true;
    await heldRelay.promise;
    const keys = new BackendKeys(world.env.CHAT_DATA_DIR!);
    const key = (await keys.list())[0]!;
    await keys.revoke(key.id);
    revoked.resolve();
    await until(
      () => homeApp!.connectedBackends.list()[0]?.state === "key_revoked",
    );
    const stopped = seen.length;
    const quiet = async (expected = stopped) => {
      const control = livePolls;
      homeApp!.connectedBackends.idleAfterMs = 0;
      homeApp!.connectedBackends.noteOperator(
        homeServer!.url.replace(/\/$/, ""),
      );
      homeApp!.connectedBackends.remoteEvent("R", "relay");
      await homeApp!.connectedBackends.refreshStale();
      await until(() => livePolls >= control + 3);
      expect(seen.length).toBe(expected);
      expect(
        homeApp!.connectedBackends.list().find((r) => r.label === "R"),
      ).toMatchObject({
        state: "key_revoked",
        reason: "Sign-in required; reconnect in Settings",
      });
    };
    await quiet();
    await stopHome();
    await startHome();
    await quiet();
    injectCredential = false;
    const opened = await fetch(homeServer!.url + "/api/backends/R/status");
    expect(opened.status).toBe(424);
    expect(seen.length).toBe(stopped);
    await expect(
      homeApp!.connectedBackends.checkRelay("R", signal),
    ).rejects.toThrow("key was revoked");
    const afterOpen = seen.length;
    expect(afterOpen).toBe(stopped + 1);
    const control = livePolls;
    await until(() => livePolls >= control + 3);
    expect(seen.length).toBe(afterOpen);
    expect(
      homeApp!.connectedBackends.list().find((r) => r.label === "R")!.state,
    ).toBe("key_revoked");
    const log = await readFile(
      join(world.env.CHAT_DATA_DIR!, "logs/recurse.log"),
      "utf8",
    );
    expect(log).toContain("event=backend_key_rejected");
    expect(log).toContain(`key_id=${key.id}`);
    expect(log).toContain("ip=unknown");
    expect(log).toContain("ip=127.0.0.1");
    expect(log).not.toMatch(/recurse-link_[a-f0-9]{16}_[a-f0-9]{64}/);
    injectCredential = false;
    const signedIn = await fetch(homeServer!.url + "/api/backends/R/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(signedIn.status).toBe(200);
    const resumed = seen.filter(
      (path) => path === "/api/relay/requests",
    ).length;
    await until(
      () =>
        seen.filter((path) => path === "/api/relay/requests").length > resumed,
    );
    expect(
      homeApp!.connectedBackends.list().find((r) => r.label === "R")!.state,
    ).toBe("connected");
    const newKeys = await keys.list();
    expect(newKeys.some((row) => row.id !== key.id)).toBe(true);
    rejectVersion = true;
    await expect(
      homeApp!.connectedBackends.checkRelay("R", signal),
    ).rejects.toThrow("key was revoked");
    await quiet(seen.length);
  } finally {
    revoked.resolve();
    setSystemTime();
    if (homeApp) await stopHome();
    gateway.stop(true);
    await server.close();
    await app.instance.shutdown();
    await Promise.all(app.detached);
    await rm(world.root, { recursive: true, force: true });
    await rm(homeWorld.root, { recursive: true, force: true });
  }
}, 30_000);
