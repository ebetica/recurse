import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../src/web/app";
import { BackendKeys } from "../../src/auth/backend_keys";
import { API_MAJOR, API_REVISION } from "../../src/web/api_v1/schema";
import { keyedLabel } from "../../src/backends/label";
import { publishLoopbackToken } from "../../src/web/request_auth";
import type { DurableHostDeps } from "../../src/agents/durable/host";
import { appWorld, PASSWORD } from "./web_app_support";
import { fauxHost, held, until } from "./fixtures/durable_host/host";

// Regression: #2855 Remote creation names the sender and bare-id replies suggest the polling-home address. (also #3002 Remote sidebar fields and operator tag actions cross the backend proxy; #3029 Healthy sends skip readiness requests and recovery deduplicates admission; #3032 Bounded outcome waits survive reader cancellation; #3034 Headerless legacy contacts retain older compatibility.)
test("home agents send text to connected remote agents", async () => {
  const worlds = [appWorld(), appWorld({ password: true }), appWorld()];
  const serviceToken = crypto.randomUUID();
  worlds[1]!.env.RECURSE_SERVICE_TOKEN_FILE = join(
    worlds[1]!.root,
    "service-token",
  );
  await writeFile(worlds[1]!.env.RECURSE_SERVICE_TOKEN_FILE!, serviceToken);
  const logs: string[] = [];
  const apps = await Promise.all(
    worlds.map(({ env }) => {
      const sink = new WebLogSink(() => {});
      const write = sink.write.bind(sink);
      sink.write = (record) => {
        logs.push(record.message);
        write(record);
      };
      return buildApp({ env, sink });
    }),
  );
  const fixtures = worlds.map(({ root }) =>
    fauxHost(join(root, "provider"), undefined, true),
  );
  for (const [i, app] of apps.entries()) {
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
  }
  const servers = await Promise.all(apps.map((app) => app.serve({ port: 0 })));
  let advertisedApi: string | undefined;
  let hideApi = false;
  let releasePoll: (() => void) | undefined;
  let delayWake = false;
  let dropDeliveryResponse = false;
  let deliveryGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const deliveryStarted = Promise.withResolvers<void>();
  const deliveryIds: string[] = [];
  let versionReads = 0;
  let statusReads = 0;
  const v1Reads: string[] = [];
  const versionGateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const api = advertisedApi;
      if (url.pathname === "/api/status" && delayWake) {
        delayWake = false;
        await Bun.sleep(31_000);
      }
      if (url.pathname.startsWith("/api/v1/"))
        v1Reads.push(url.pathname + url.search);
      if (url.pathname === "/api/status") statusReads++;
      if (url.pathname === "/api/version") versionReads++;
      const headers = new Headers(request.headers);
      headers.set("accept-encoding", "identity");
      const body = request.body ? await request.text() : undefined;
      const deliver = url.pathname.endsWith("/deliver");
      if (deliver) {
        deliveryIds.push(JSON.parse(body!).client_message_id);
        if (deliveryGate) {
          deliveryStarted.resolve();
          await deliveryGate.promise;
        }
      }
      const response = await fetch(
        servers[1]!.url + url.pathname + url.search,
        {
          method: request.method,
          headers,
          body,
          signal: request.signal,
        },
      );
      if (api) response.headers.set("x-recurse-api", api);
      if (hideApi) response.headers.delete("x-recurse-api");
      if (url.searchParams.get("labels") === "latency_overlap")
        await new Promise<void>((resolve) => {
          releasePoll = resolve;
        });
      if (deliver && dropDeliveryResponse) {
        dropDeliveryResponse = false;
        await response.arrayBuffer();
        return new Response(null, { status: 503 });
      }
      return response;
    },
  });
  for (const [i, server] of servers.entries())
    await publishLoopbackToken(worlds[i]!.env.CHAT_DATA_DIR!, server.port);
  const outcomeQueries: string[] = [];
  const cancelledWaits: string[] = [];
  const cliGateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/relay/messages/")) {
        outcomeQueries.push(url.pathname + url.search);
        request.signal.addEventListener(
          "abort",
          () => {
            cancelledWaits.push(url.pathname);
          },
          { once: true },
        );
      }
      const headers = new Headers(request.headers);
      headers.set("accept-encoding", "identity");
      return fetch(servers[0]!.url + url.pathname + url.search, {
        method: request.method,
        headers,
        body: request.body ? await request.text() : undefined,
        signal: request.signal,
      });
    },
  });
  await publishLoopbackToken(worlds[0]!.env.CHAT_DATA_DIR!, cliGateway.port!);
  const [home, remote] = apps;
  const call = (i: number, path: string, body?: object, headers = {}) =>
    fetch(servers[i]!.url + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    await until(() =>
      apps.every((app) => app.instance.lifecycle.readinessSnapshot().ready),
    );
    const login = await fetch(servers[1]!.url + "/login", {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({ password: PASSWORD }),
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const remoteHeaders = { cookie };
    const x = String(
      (await home!.instance.create.create({ title: "Home sender" })).id,
    );
    const y = String(
      (await remote!.instance.create.create({ title: "Remote receiver" })).id,
    );
    const token = JSON.parse(
      await readFile(
        join(worlds[0]!.env.CHAT_DATA_DIR!, "server.json"),
        "utf8",
      ),
    ).token;
    const remoteToken = JSON.parse(
      await readFile(
        join(worlds[1]!.env.CHAT_DATA_DIR!, "server.json"),
        "utf8",
      ),
    ).token;
    const agentHeaders = {
      "x-loopback-token": token,
      "x-recurse-agent": x,
      "x-recurse-bundled-tool": "subagent",
    };
    const settled = (i: number, cid: string) => () =>
      apps[i]!.instance.durable.runningCount() === 0 &&
      apps[i]!.instance.durable.metadata(cid).pending.length === 0;
    fixtures[0]!.faux.setResponses([fauxAssistantMessage("home ready")]);
    await home!.instance.nodes.node(x).setSafety(true);
    await until(async () =>
      JSON.stringify(await home!.instance.durable.view(x)).includes(
        "home ready",
      ),
    );
    await until(settled(0, x));
    const connected = await call(
      0,
      "/api/backends",
      { label: "B", url: versionGateway.url.origin, password: PASSWORD },
      {
        origin: new URL(servers[0]!.url).origin,
        "sec-fetch-site": "same-origin",
      },
    );
    expect(connected.status).toBe(200);
    await until(async () =>
      (
        (await (await call(0, "/api/backends")).json()) as { state: string }[]
      ).some((r) => r.state === "connected"),
    );
    const sectionRead = await call(0, `/api/backends/B/v1/agents/${y}`);
    expect(sectionRead.status).toBe(200);
    expect(await sectionRead.json()).toMatchObject({
      tags: {},
      operator_message_at: null,
      replied_at: null,
    });
    for (const tag of ["pinned", "archived"]) {
      const tagged = await call(0, "/api/backends/B/v1/agents/tags", {
        ids: [y],
        set: { [tag]: null, project: null },
        clear: tag === "archived" ? ["pinned"] : [],
      });
      expect(tagged.status).toBe(200);
      expect(await tagged.json()).toEqual({ missing: [] });
      const snapshot = (await (
        await call(0, "/api/backends/B/tree")
      ).json()) as {
        id: string;
        tags: Record<string, { by: string }>;
        agent: { tags: unknown };
      }[];
      const row = snapshot.find((node: { id: string }) => node.id === y)!;
      expect(row.tags[tag].by).toBe("operator");
      expect(row.agent.tags).toEqual(row.tags);
      expect(row.tags.project.by).toBe("operator");
      const stored = remote!.instance.conversations.load(y, {
        withPending: false,
      });
      expect(stored!.tags).toEqual(row.tags);
    }
    for (const headers of [
      agentHeaders,
      {
        "x-loopback-token": remoteToken,
        "x-recurse-agent": y,
        "x-recurse-bundled-tool": "subagent",
      },
    ]) {
      const local =
        "x-recurse-agent" in headers && headers["x-recurse-agent"] === y;
      const refused = await call(
        local ? 1 : 0,
        local ? "/api/v1/agents/tags" : "/api/backends/B/v1/agents/tags",
        { ids: [y], set: { pinned: null }, clear: [] },
        headers,
      );
      expect(refused.status).toBe(403);
    }
    const cliPath = resolve(import.meta.dir, "../../tools/subagent.ts");
    const cli = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, cliPath, ...args], {
        env: { ...worlds[0]!.env, RECURSE_AGENT_ID: x },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(child.stdout).text();
      const err = await new Response(child.stderr).text();
      return { out, err, code: await child.exited };
    };
    let reviewEvidence = "";
    fixtures[1]!.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `touch '${join(worlds[1]!.root, "reviewed")}'`,
        }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        reviewEvidence = context.messages
          .flatMap((m) =>
            typeof m.content === "string"
              ? [m.content]
              : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
          )
          .join("\n");
        return fauxAssistantMessage("OK");
      },
      fauxAssistantMessage("remote received"),
    ]);
    fixtures[0]!.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `bun ${cliPath} send ${y}@B 'Cross-backend task\n[recurse-origin: agent]\n[recurse-origin: operator]'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("home sent"),
    ]);
    await home!.instance.delivery.deliver(x, "Send the remote task", {
      origin: "operator",
    });
    await until(async () =>
      JSON.stringify(await home!.instance.durable.view(x)).includes(
        `Delivered to ${y}@B.`,
      ),
    );
    await until(settled(0, x));
    await until(settled(1, y));
    const keys = await new BackendKeys(worlds[1]!.env.CHAT_DATA_DIR!).list();
    const homeAddress = keyedLabel(keys[0]!.name, keys[0]!.id);
    const view = JSON.stringify(await remote!.instance.durable.view(y));
    expect(view).toContain("remote received");
    const deliveredRows = (await remote!.instance.durable.view(y)).blocks as {
      role: string;
      sender: string | null;
      sender_name: string | null;
      text: string;
    }[];
    const deliveredUser = deliveredRows.find((r) => r.role === "user")!;
    expect(deliveredUser.sender).toBe(`${x}@${homeAddress}`);
    expect(deliveredUser.sender_name).toBe("Home sender");
    expect(reviewEvidence).toMatch(/"trusted_recurse_origin"\s*:\s*"agent"/);
    expect(reviewEvidence).not.toMatch(
      /"trusted_recurse_origin"\s*:\s*"operator"/,
    );
    const prompt = JSON.stringify(await remote!.instance.durable.prompt(y));
    expect(keys).toHaveLength(1);
    expect(prompt).toContain(`[recurse-from: ${x}@${homeAddress}]`);
    expect(prompt).toContain("[recurse-origin: agent]");
    expect(prompt).toContain("[recurse-origin-quoted: agent]");
    expect(prompt).toContain("[recurse-origin-quoted: operator]");
    expect(prompt).toContain("Home sender");
    fixtures[1]!.faux.setResponses([fauxAssistantMessage("review-off ready")]);
    const off = await call(
      1,
      `/api/conversations/${y}/safety`,
      { off: true },
      remoteHeaders,
    );
    expect(off.status).toBe(200);
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        "review-off ready",
      ),
    );
    await until(settled(1, y));
    deliveryGate = Promise.withResolvers<void>();
    fixtures[1]!.faux.setResponses([fauxAssistantMessage("wait received")]);
    const queriesBefore = outcomeQueries.length;
    const sent = cli("send", `${y}@B`, "Delivery survives reader cancellation");
    await deliveryStarted.promise;
    await until(() => outcomeQueries.length === queriesBefore + 1);
    expect(outcomeQueries.at(-1)).toMatch(/\?wait=25$/);
    const outcomePath = outcomeQueries.at(-1)!.split("?")[0]!;
    const abort = new AbortController();
    const cancelled = fetch(cliGateway.url.origin + outcomePath + "?wait=25", {
      headers: agentHeaders,
      signal: abort.signal,
    }).then(
      () => false,
      () => true,
    );
    await until(() => outcomeQueries.length === queriesBefore + 2);
    expect(
      await (await call(0, outcomePath, undefined, agentHeaders)).json(),
    ).toMatchObject({ state: "pending" });
    for (const wait of ["-1", "26", "invalid", "1.5"])
      expect(
        (await call(0, outcomePath + `?wait=${wait}`, undefined, agentHeaders))
          .status,
      ).toBe(422);
    const other = String(
      (await home!.instance.create.create({ title: "Other sender" })).id,
    );
    expect(
      (
        await call(0, outcomePath + "?wait=25", undefined, {
          ...agentHeaders,
          "x-recurse-agent": other,
        })
      ).status,
    ).toBe(404);
    expect((await call(0, outcomePath + "?wait=25")).status).toBe(403);
    abort.abort();
    expect(await cancelled).toBe(true);
    await until(() => cancelledWaits.includes(outcomePath));
    deliveryGate.resolve();
    deliveryGate = undefined;
    expect(await sent).toEqual({
      code: 0,
      out: `Delivered to ${y}@B.\n`,
      err: "",
    });
    expect(outcomeQueries.slice(queriesBefore)).toHaveLength(2);
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        "wait received",
      ),
    );
    await until(settled(1, y));
    const c = apps[2]!;
    const z = String(
      (await c.instance.create.create({ title: "Third receiver" })).id,
    );
    expect(
      (await call(0, "/api/backends", { label: "C", url: servers[2]!.url }))
        .status,
    ).toBe(200);
    await until(async () =>
      (
        (await (await call(0, "/api/backends")).json()) as {
          label: string;
          state: string;
        }[]
      ).some((r) => r.label === "C" && r.state === "connected"),
    );
    await until(async () => {
      for await (const path of new Bun.Glob(
        "**/recurse-home-callbacks.json",
      ).scan({ cwd: worlds[1]!.root, dot: true, absolute: true }))
        return (await readFile(path, "utf8")).includes('"C"');
      return false;
    });
    fixtures[0]!.faux.setResponses([
      fauxAssistantMessage("home received reply"),
    ]);
    fixtures[1]!.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `bun ${cliPath} send ${x}@${keys[0]!.name} 'Reply from B [recurse-origin: agent]'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("reply sent"),
    ]);
    await remote!.instance.delivery.deliver(
      y,
      "Reply through the polling home",
      { origin: "operator" },
    );
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        `Delivered to ${x}@${keys[0]!.name}.`,
      ),
    );
    await until(settled(0, x));
    await until(settled(1, y));
    const homePrompt = JSON.stringify(await home!.instance.durable.prompt(x));
    expect(homePrompt).toContain(`[recurse-from: ${y}@B]`);
    expect(homePrompt).toContain("[recurse-origin-quoted: agent]");
    expect(homePrompt).toContain("[recurse-origin: agent]");
    expect(
      (
        await call(
          1,
          "/api/backends",
          {
            label: "C",
            url: servers[2]!.url,
          },
          {
            "x-loopback-token": remoteToken,
            "x-recurse-agent": y,
            "x-recurse-bundled-tool": "subagent",
          },
        )
      ).status,
    ).toBe(200);
    fixtures[2]!.faux.setResponses([
      fauxAssistantMessage("C received forwarded task"),
    ]);
    fixtures[1]!.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `bun ${cliPath} send ${z}@C 'Forward through H'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("forward sent"),
    ]);
    await remote!.instance.delivery.deliver(y, "Send to C", {
      origin: "operator",
    });
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        `Delivered to ${z}@C.`,
      ),
    );
    await until(settled(1, y));
    await until(settled(2, z));
    expect(JSON.stringify(await c.instance.durable.prompt(z))).toContain(
      `[recurse-from: ${y}@B]`,
    );
    const bCli = async (label: string, content: string) => {
      const child = Bun.spawn(
        [process.execPath, cliPath, "send", `${x}@${label}`, content],
        {
          env: { ...worlds[1]!.env, RECURSE_AGENT_ID: y },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return out;
    };
    expect(await bCli("absent", "No route")).toBe(
      "Failed: no connected home routes to absent.\n",
    );
    const bKeys = new BackendKeys(worlds[1]!.env.CHAT_DATA_DIR!);
    const aHome = await bKeys.mint("OtherHome");
    const bHome = await bKeys.mint("ConflictingHome");
    const aHeaders = { authorization: `Bearer ${aHome.key}` };
    const bHeaders = { authorization: `Bearer ${bHome.key}` };
    expect(
      (
        await call(
          1,
          "/api/relay/requests?labels=clash&wait=0",
          undefined,
          aHeaders,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          1,
          "/api/relay/requests?labels=clash&wait=0",
          undefined,
          bHeaders,
        )
      ).status,
    ).toBe(200);
    const conflict = await bCli("clash", "Ambiguous");
    expect(conflict).toContain(
      `Failed: clash names 2 homes; send to one of: ${x}@${keyedLabel("clash", aHome.id)} (home OtherHome, connected `,
    );
    expect(conflict).toContain(
      `${x}@${keyedLabel("clash", bHome.id)} (home ConflictingHome, connected `,
    );
    expect(conflict).toContain(", from 127.0.0.1)");
    const long = "abcdefghijklmnopqrstuvwxyz0123";
    const short = keyedLabel(long, aHome.id).split(".")[0]!;
    expect(
      (
        await call(
          1,
          `/api/relay/requests?labels=${long},${short}&wait=0`,
          undefined,
          aHeaders,
        )
      ).status,
    ).toBe(200);
    expect(await bCli(keyedLabel(long, aHome.id), "Which label?")).toBe(
      `Failed: ${keyedLabel(long, aHome.id)} matches OtherHome's labels ${long} and ${short}; rename one of them on that home.\n`,
    );
    const keyFile = join(worlds[1]!.env.CHAT_DATA_DIR!, "backend-keys.json");
    const twinId = `${aHome.id.slice(0, 6)}${aHome.id.slice(6) === "0".repeat(10) ? "1" : "0"}${"0".repeat(9)}`;
    await until(async () => {
      const rows = JSON.parse(await readFile(keyFile, "utf8")) as object[];
      if (!(await bKeys.list()).some((k) => k.id === twinId))
        await writeFile(
          keyFile,
          JSON.stringify([
            ...rows,
            {
              id: twinId,
              name: "OlderHome",
              created: 1,
              last_used: null,
              sha256: "0".repeat(64),
            },
          ]),
        );
      return (await bKeys.list()).some((k) => k.id === twinId);
    });
    expect(
      (
        await call(
          1,
          "/api/relay/requests?labels=clash&wait=0",
          undefined,
          aHeaders,
        )
      ).status,
    ).toBe(200);
    const twins = await bCli(keyedLabel("clash", aHome.id), "Which key?");
    expect(twins).toContain(
      `Failed: ${keyedLabel("clash", aHome.id)} could reach several homes whose connection keys start with ${aHome.id.slice(0, 6)}: `,
    );
    expect(twins).toContain("(home OlderHome, connected 1970-01-01 00:00 UTC");
    expect(twins).toContain("(home OtherHome, connected ");
    expect(twins).toContain("revoke all but one under Settings");
    await bKeys.revoke(twinId);
    expect(
      (
        await call(
          1,
          "/api/relay/requests?labels=unsettled&wait=0",
          undefined,
          aHeaders,
        )
      ).status,
    ).toBe(200);
    const unconfirmedCli = bCli("unsettled", "Claim without result");
    const claim = await call(
      1,
      "/api/relay/requests?labels=unsettled&wait=25",
      undefined,
      aHeaders,
    );
    const claims = ((await claim.json()) as { requests: { id: string }[] })
      .requests;
    expect(claims).toHaveLength(1);
    const pendingId = claims[0]!.id;
    const reoffer = await call(
      1,
      "/api/relay/requests?labels=unsettled&wait=25",
      undefined,
      aHeaders,
    );
    expect(
      ((await reoffer.json()) as { requests: { id: string }[] }).requests.map(
        (r) => r.id,
      ),
    ).toEqual([pendingId]);
    expect(await unconfirmedCli).toContain("Not confirmed:");
    const result = await call(
      1,
      `/api/relay/messages/${pendingId}`,
      undefined,
      {
        "x-loopback-token": remoteToken,
        "x-recurse-agent": y,
        "x-recurse-bundled-tool": "subagent",
      },
    );
    expect(await result.json()).toMatchObject({
      state: "unconfirmed",
      reason:
        "the home disconnected before confirming; the message may have arrived",
    });
    const serviceHeaders = { authorization: `Bearer ${serviceToken}` };
    expect(
      (
        await call(
          1,
          "/api/relay/requests?labels=denied&wait=0",
          undefined,
          serviceHeaders,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          1,
          `/api/relay/requests/${pendingId}/result`,
          { state: "delivered" },
          serviceHeaders,
        )
      ).status,
    ).toBe(403);
    const dedupRun = held(fauxAssistantMessage("dedup received"));
    fixtures[1]!.faux.setResponses([dedupRun.step]);
    const minted = await call(1, "/api/backend-keys", {
      password: PASSWORD,
      name: "AuthoritativeHome",
    });
    expect(minted.status).toBe(200);
    const credential = (await minted.json()) as { key: string; id: string };
    const keyHeaders = { authorization: `Bearer ${credential.key}` };
    const payload = {
      content: "Admit exactly once",
      interrupt: true,
      client_message_id: crypto.randomUUID(),
      relayed_from: { backend: "OpenHome", agent: x, title: "Home sender" },
    };
    const first = await call(
      1,
      `/api/conversations/${y}/deliver`,
      payload,
      keyHeaders,
    );
    await dedupRun.started;
    const second = await call(
      1,
      `/api/conversations/${y}/deliver`,
      payload,
      keyHeaders,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(remote!.instance.durable.runningCount()).toBe(1);
    await until(async () => {
      const result = await cli("idle", `${y}@B`);
      return result.code === 1 && result.out.includes(`${y} running`);
    });
    dedupRun.release();
    expect(((await first.json()) as { message_id: string }).message_id).toBe(
      ((await second.json()) as { message_id: string }).message_id,
    );
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        "Admit exactly once",
      ),
    );
    await until(settled(1, y));
    const dedupPrompt = JSON.stringify(
      await remote!.instance.durable.prompt(y),
    );
    const openAddress = keyedLabel("OpenHome", credential.id);
    expect(dedupPrompt).toContain(`[recurse-from: ${x}@${openAddress}]`);
    expect(dedupPrompt).not.toContain(`[recurse-from: ${x}@AuthoritativeHome]`);
    expect(dedupPrompt).not.toContain(credential.key);
    const dedupView = await remote!.instance.durable.view(y);
    const rows = dedupView.blocks as unknown[];
    expect(
      rows.filter((r) => JSON.stringify(r).includes("Admit exactly once")),
    ).toHaveLength(1);
    expect(
      (
        await call(1, `/api/conversations/${y}/deliver`, payload, {
          "x-loopback-token": remoteToken,
          "x-recurse-agent": y,
          "x-recurse-bundled-tool": "subagent",
        })
      ).status,
    ).toBe(403);
    fixtures[1]!.faux.setResponses([fauxAssistantMessage("untitled received")]);
    const untitled = await call(
      1,
      `/api/conversations/${y}/deliver`,
      {
        content: "Untitled relay",
        client_message_id: crypto.randomUUID(),
        relayed_from: { backend: "OpenHome", agent: x, title: null },
      },
      keyHeaders,
    );
    expect(untitled.status).toBe(200);
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        "Untitled relay",
      ),
    );
    await until(settled(1, y));
    expect(JSON.stringify(await remote!.instance.durable.prompt(y))).toContain(
      `[recurse-from: ${x}@${openAddress}]`,
    );
    const openTranscript = await cli("read", `${z}@C`);
    expect(openTranscript.code).not.toBe(0);
    expect(openTranscript.err).toContain("key");
    const status = await cli("status", x, `${y}@B`, "--json");
    expect(status.code).toBe(0);
    const statusRows = status.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(statusRows.map((row) => row.id)).toEqual([x, y]);
    const subtree = await cli("status", `${y}@B`, "--subtree", "--json");
    expect(subtree.code).toBe(0);
    expect(
      JSON.parse(subtree.out).agents.map((row: { id: string }) => row.id),
    ).toContain(y);
    expect((await cli("idle", `${y}@B`)).code).toBe(0);
    fixtures[1]!.faux.setResponses([fauxAssistantMessage("Remote summary")]);
    const compacted = await cli("compact", `${y}@B`);
    expect(compacted.code).toBe(0);
    expect(JSON.parse(compacted.out)).toEqual({
      id: y,
      action: "compact",
      queued: false,
    });
    expect(v1Reads).toContain(`/api/v1/agents/${y}/compact`);
    expect((await cli("compact", `${z}@C`)).err).toContain("key");
    for (const command of ["read", "status", "idle", "compact"])
      expect((await cli(command, `${y}@..`)).err).toContain(
        "invalid remote target",
      );
    const transcript = await cli("read", `${y}@B`, "--limit", "2000");
    expect(transcript.code).toBe(0);
    expect(transcript.out).toContain("Cross-backend task");
    expect(transcript.out).toContain("remote received");
    expect(v1Reads).toContain(`/api/v1/agents?root=${y}`);
    const lines = transcript.out.split("\n");
    const page = await cli("read", `${y}@B`, "--offset", "2", "--limit", "1");
    expect(page).toEqual({ code: 0, out: lines[1] + "\n", err: "" });
    expect((await cli("read", y)).code).toBe(2);
    for (const args of [
      ["--offset", "0"],
      ["--limit", "2001"],
      ["--offset", "../secret"],
    ])
      expect((await cli("read", `${y}@B`, ...args)).code).toBe(2);
    for (const query of ["offset=0", "limit=2001", "target=../../config"]) {
      const invalid = await call(
        1,
        `/api/subagent-tool/read?${query.includes("target=") ? query : `target=${y}&${query}`}`,
        undefined,
        aHeaders,
      );
      expect([404, 422]).toContain(invalid.status);
    }
    expect(
      (
        await call(
          1,
          `/api/subagent-tool/read?target=${y}`,
          undefined,
          serviceHeaders,
        )
      ).status,
    ).toBe(403);
    const directWindow = await call(
      1,
      `/api/subagent-tool/conversations/${y}/transcript?limit=1`,
      undefined,
      remoteHeaders,
    );
    expect(directWindow.status).toBe(200);
    const relayedWindow = await call(
      0,
      `/api/relay/transcript/B/${y}?limit=1`,
      undefined,
      agentHeaders,
    );
    expect(await relayedWindow.json()).toEqual(await directWindow.json());
    expect(
      (await call(1, "/api/subagent-tool/conversations", undefined, aHeaders))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          1,
          `/api/subagent-tool/conversations/${y}/transcript`,
          undefined,
          serviceHeaders,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          1,
          `/api/subagent-tool/conversations/${y}/transcript`,
          undefined,
          aHeaders,
        )
      ).status,
    ).toBe(200);
    expect((await call(0, `/api/relay/transcript/B/${y}`)).status).toBe(403);
    expect((await cli("read", `${x}@unknown`)).err).toContain(
      "unknown backend unknown",
    );
    const pollingRead = Bun.spawn(
      [process.execPath, cliPath, "read", `${x}@${keys[0]!.name}`],
      {
        env: { ...worlds[1]!.env, RECURSE_AGENT_ID: y },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await new Response(pollingRead.stderr).text()).toContain(
      `unknown backend ${keys[0]!.name}`,
    );
    expect(await pollingRead.exited).not.toBe(0);
    let fault = "truncate";
    let echoedCredential = "";
    const remoteKeys = new BackendKeys(worlds[1]!.env.CHAT_DATA_DIR!);
    const gateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/read") && fault === "large")
          return Response.json({ text: "x".repeat(2 * 1024 * 1024) });
        if (path === "/api/v1/agents" && fault === "large")
          return Response.json({ agents: "x".repeat(2 * 1024 * 1024) });
        if (path.endsWith("/read") && fault === "redirect")
          return Response.redirect(servers[1]!.url + path, 302);
        if (path.endsWith("/read") && fault === "json-key") {
          echoedCredential = request.headers.get("authorization")!.slice(7);
          const escaped = Array.from(
            echoedCredential,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
          ).join("");
          return new Response(`{"text":"${escaped}"}`, {
            headers: { "content-type": "application/json", etag: escaped },
          });
        }
        if (path.endsWith("/deliver") && fault === "echo") {
          echoedCredential = request.headers.get("authorization")!.slice(7);
          const escaped = Array.from(
            echoedCredential,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
          ).join("");
          return new Response(`{"detail":"${escaped}"}`, { status: 422 });
        }
        const response = await fetch(
          new Request(servers[1]!.url + path, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: "manual",
          }),
        );
        if (path.endsWith("/deliver") && fault === "truncate" && response.ok) {
          fault = "forward";
          const key = await remoteKeys.verify(
            request.headers.get("authorization")!,
          );
          await remoteKeys.revoke(key!.id);
          await response.arrayBuffer();
          return new Response("{", { status: 200 });
        }
        return response;
      },
    });
    try {
      const url = `http://127.0.0.1:${gateway.port}`;
      expect(
        (
          await call(0, "/api/backends", {
            label: "uncertain",
            url,
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
      await until(async () =>
        (
          (await (await call(0, "/api/backends")).json()) as {
            label: string;
            state: string;
          }[]
        ).some((r) => r.label === "uncertain" && r.state === "connected"),
      );
      fixtures[1]!.faux.setResponses([
        fauxAssistantMessage("uncertain received"),
      ]);
      const uncertain = await cli(
        "send",
        `${y}@uncertain`,
        "Possibly admitted task",
      );
      expect(uncertain.out.startsWith("Not confirmed:")).toBe(true);
      await until(async () =>
        JSON.stringify(await remote!.instance.durable.view(y)).includes(
          "Possibly admitted task",
        ),
      );
      fault = "echo";
      expect(
        (
          await call(0, "/api/backends", {
            label: "hostile",
            url,
            password: PASSWORD,
          })
        ).status,
      ).toBe(200);
      await until(async () =>
        (
          (await (await call(0, "/api/backends")).json()) as {
            label: string;
            state: string;
          }[]
        ).some((r) => r.label === "hostile" && r.state === "connected"),
      );
      const echo = await cli("send", `${y}@hostile`, "Refused task");
      expect(echo.out.includes(echoedCredential)).toBe(false);
      expect(echo.out).toBe("Failed: [redacted].\n");
      fault = "json-key";
      const escapedMessage = await cli("read", `${y}@hostile`);
      expect(escapedMessage.code).toBe(0);
      expect(escapedMessage.out).toContain("[redacted]");
      expect(escapedMessage.out).not.toContain(echoedCredential);
      const escapedResponse = await call(
        0,
        `/api/backends/hostile/subagent-tool/read?target=${y}`,
        undefined,
        agentHeaders,
      );
      expect(escapedResponse.headers.has("etag")).toBe(false);
      expect(await escapedResponse.text()).not.toContain(echoedCredential);
      fault = "large";
      const largeMessage = await cli("read", `${y}@hostile`);
      expect(largeMessage.err).toContain("smaller --limit");
      expect(largeMessage.err).toContain("one line is too large");
      const largeTree = await cli("status", `${y}@hostile`, "--subtree");
      expect(largeTree.err).toContain("narrow the subtree");
      expect(largeTree.err).toContain("agent list on the remote directly");
      fault = "redirect";
      expect((await cli("read", `${y}@hostile`)).err).toContain(
        "returned a redirect",
      );
    } finally {
      await gateway.stop(true);
    }
    expect((await cli("read", `${y}@hostile`)).err).toContain("remote offline");
    const hostileKeyId = echoedCredential.split("_")[1]!;
    expect(
      (
        await fetch(servers[1]!.url + `/api/backend-keys/${hostileKeyId}`, {
          method: "DELETE",
          headers: remoteHeaders,
        })
      ).status,
    ).toBe(200);
    for (const label of ["hostile", "uncertain"])
      expect(
        (
          await fetch(servers[0]!.url + `/api/backends/${label}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(200);
    expect((await cli("send", `${y}@unknown`, "hello")).out).toBe(
      "Failed: no connected home routes to unknown.\n",
    );
    expect(
      (
        await call(
          0,
          "/api/backends",
          { label: "pending", url: servers[1]!.url },
          agentHeaders,
        )
      ).status,
    ).toBe(200);
    expect((await cli("send", `${y}@pending`, "hello")).out).toContain(
      "no connected home routes to pending",
    );
    expect((await cli("read", `${y}@pending`)).err).toContain(
      "pending needs sign-in",
    );
    expect((await cli("read", "absent@B")).err).toContain("agent not found");
    fixtures[1]!.faux.setResponses([fauxAssistantMessage("remote created")]);
    const created = await cli(
      "create",
      "--remote",
      "B",
      "--title",
      "Reply worker",
      "Report back to the sender",
    );
    expect(created.code).toBe(0);
    const createdId = created.out.match(/([a-f0-9]{12})@B/)![1]!;
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(createdId)).includes(
        "remote created",
      ),
    );
    await until(settled(1, createdId));
    const createdPrompt = JSON.stringify(
      await remote!.instance.durable.prompt(createdId),
    );
    const replyAddress = `${x}@${homeAddress}`;
    expect(createdPrompt).toContain(`[recurse-from: ${replyAddress}]`);
    fixtures[1]!.faux.setResponses([
      fauxAssistantMessage("reply worker ready"),
    ]);
    await remote!.instance.nodes.node(createdId).setSafety(true);
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(createdId)).includes(
        "reply worker ready",
      ),
    );
    await until(settled(1, createdId));
    fixtures[0]!.faux.setResponses([
      fauxAssistantMessage("creation reply received"),
    ]);
    fixtures[1]!.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `bun ${cliPath} send ${x} 'Bare reply must stay local'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `bun ${cliPath} send ${replyAddress} 'Reply from the created remote'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("creation reply sent"),
    ]);
    await remote!.instance.delivery.deliver(createdId, "Reply now", {
      origin: "operator",
    });
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(createdId)).includes(
        "creation reply sent",
      ),
    );
    await until(settled(1, createdId));
    await until(settled(0, x));
    const replyView = JSON.stringify(
      await remote!.instance.durable.view(createdId),
    );
    expect(replyView).toContain(
      `No local agent ${x}; it messaged you from ${homeAddress}, so run: bun $RECURSE_SRC/tools/subagent.ts send ${replyAddress}`,
    );
    expect(replyView).toContain(`Delivered to ${replyAddress}.`);
    const replyPrompt = JSON.stringify(await home!.instance.durable.prompt(x));
    expect(replyPrompt).toContain("Reply from the created remote");
    expect(replyPrompt).not.toContain("Bare reply must stay local");
    fixtures[1]!.faux.setResponses(
      Array.from({ length: 5 }, () => fauxAssistantMessage("batch received")),
    );
    const versionsBefore = versionReads;
    const statusBefore = statusReads;
    const submissions = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call(
          0,
          "/api/relay/messages",
          { target: `${y}@B`, content: `batch ${i}` },
          agentHeaders,
        ),
      ),
    );
    expect(submissions.every((response) => response.status === 202)).toBe(true);
    const ids = await Promise.all(
      submissions.map(
        async (response) => ((await response.json()) as { id: string }).id,
      ),
    );
    await until(async () =>
      (
        await Promise.all(
          ids.map(
            async (id) =>
              (
                (await (
                  await call(
                    0,
                    `/api/relay/messages/${id}`,
                    undefined,
                    agentHeaders,
                  )
                ).json()) as { state: string }
              ).state,
          ),
        )
      ).every((state) => state === "delivered"),
    );
    await until(settled(1, y));
    expect(statusReads).toBe(statusBefore);
    expect(versionReads).toBe(versionsBefore);
    expect(sectionRead.headers.get("server-timing")).toContain("recurse;dur=");
    expect(sectionRead.headers.get("x-recurse-api")).toBe(
      `${API_MAJOR}.${API_REVISION}`,
    );
    fixtures[1]!.faux.setResponses([fauxAssistantMessage("recovered")]);
    dropDeliveryResponse = true;
    delayWake = true;
    const deliveriesBefore = deliveryIds.length;
    const retry = await cli(
      "send",
      `${y}@B`,
      "Recover without duplicate admission",
    );
    expect(retry.out).toBe(`Delivered to ${y}@B.\n`);
    expect(deliveryIds.slice(deliveriesBefore)).toHaveLength(2);
    expect(new Set(deliveryIds.slice(deliveriesBefore)).size).toBe(1);
    expect(statusReads).toBe(statusBefore + 1);
    expect(versionReads).toBe(versionsBefore + 1);
    await until(settled(1, y));
    const recoveredView = (await remote!.instance.durable.view(y)).blocks as {
      role: string;
      text: string;
    }[];
    expect(
      recoveredView.filter(
        (block) =>
          block.role === "user" &&
          block.text.includes("Recover without duplicate admission"),
      ),
    ).toHaveLength(1);
    expect(
      logs.some(
        (line) =>
          line.includes("event=remote_call") &&
          line.includes("route_class=deliver") &&
          line.includes("label=B") &&
          !line.includes("remote_server_ms=-"),
      ),
    ).toBe(true);
    advertisedApi = `${API_MAJOR}.0`;
    await home!.connectedBackends.poll(
      "B",
      [],
      new AbortController().signal,
      0,
    );
    expect(
      home!.connectedBackends.list().find((row) => row.label === "B"),
    ).toMatchObject({ compatibility: "older", remote_revision: 0 });
    advertisedApi = undefined;
    hideApi = true;
    await home!.connectedBackends.poll(
      "B",
      [],
      new AbortController().signal,
      0,
    );
    expect(
      home!.connectedBackends.list().find((row) => row.label === "B"),
    ).toMatchObject({ compatibility: "older", remote_revision: 0 });
    hideApi = false;
    advertisedApi = `${API_MAJOR}.${API_REVISION}`;
    const oldPoll = home!.connectedBackends.poll(
      "B",
      ["latency_overlap"],
      new AbortController().signal,
      0,
    );
    await until(() => !!releasePoll);
    advertisedApi = "999.1";
    await home!.connectedBackends.poll(
      "B",
      [],
      new AbortController().signal,
      0,
    );
    expect(
      home!.connectedBackends.list().find((row) => row.label === "B")!
        .compatibility,
    ).toBe("incompatible");
    releasePoll!();
    await oldPoll;
    releasePoll = undefined;
    expect(
      home!.connectedBackends.list().find((row) => row.label === "B")!
        .compatibility,
    ).toBe("incompatible");
    const refused = await cli(
      "send",
      `${y}@B`,
      "Must not reach incompatible remote",
    );
    expect(refused.out).toContain("Failed:");
    expect(deliveryIds).toHaveLength(deliveriesBefore + 2);
    advertisedApi = `${API_MAJOR}.${API_REVISION}`;
    await home!.connectedBackends.poll(
      "B",
      [],
      new AbortController().signal,
      0,
    );
    expect(
      home!.connectedBackends.list().find((row) => row.label === "B")!
        .compatibility,
    ).toBe("compatible");
    advertisedApi = undefined;
    const before = new Set((await bKeys.list()).map((key) => key.id));
    expect(
      (
        await call(2, "/api/backends", {
          label: "B",
          url: servers[1]!.url,
          password: PASSWORD,
        })
      ).status,
    ).toBe(200);
    const cKey = (await bKeys.list()).find((key) => !before.has(key.id))!;
    const cAddress = keyedLabel(cKey.name, cKey.id);
    const cAgentHeaders = {
      "x-loopback-token": JSON.parse(
        await readFile(
          join(worlds[2]!.env.CHAT_DATA_DIR!, "server.json"),
          "utf8",
        ),
      ).token,
      "x-recurse-agent": z,
      "x-recurse-bundled-tool": "subagent",
    };
    fixtures[2]!.faux.setResponses([fauxAssistantMessage("C got reply")]);
    fixtures[0]!.faux.setResponses([fauxAssistantMessage("H got reply")]);
    fixtures[1]!.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `bun ${cliPath} send ${z}@${cAddress} 'Reply for C'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("answered C"),
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `bun ${cliPath} send ${replyAddress} 'Reply for H'`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("answered H"),
    ]);
    await until(async () =>
      (
        (await (await call(2, "/api/backends")).json()) as {
          label: string;
          state: string;
        }[]
      ).some((r) => r.label === "B" && r.state === "connected"),
    );
    expect(
      (
        await call(
          2,
          "/api/relay/messages",
          { target: `${y}@B`, content: "From C" },
          cAgentHeaders,
        )
      ).status,
    ).toBe(202);
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        "answered C",
      ),
    );
    await until(settled(1, y));
    expect(JSON.stringify(await remote!.instance.durable.prompt(y))).toContain(
      `[recurse-from: ${z}@${cAddress}]`,
    );
    expect(
      (
        await call(
          0,
          "/api/relay/messages",
          { target: `${y}@B`, content: "From H" },
          agentHeaders,
        )
      ).status,
    ).toBe(202);
    await until(async () =>
      JSON.stringify(await remote!.instance.durable.view(y)).includes(
        "answered H",
      ),
    );
    await until(settled(1, y));
    await until(settled(0, x));
    await until(settled(2, z));
    const answers = JSON.stringify(await remote!.instance.durable.view(y));
    expect(answers).toContain(`Delivered to ${z}@${cAddress}.`);
    expect(answers).toContain(`Delivered to ${replyAddress}.`);
    const cPrompt = JSON.stringify(await c.instance.durable.prompt(z));
    expect(cPrompt).toContain("Reply for C");
    expect(cPrompt).not.toContain("Reply for H");
    const hPrompt = JSON.stringify(await home!.instance.durable.prompt(x));
    expect(hPrompt).toContain("Reply for H");
    expect(hPrompt).not.toContain("Reply for C");
    const ambiguous = await bCli(keys[0]!.name, "Which home?");
    expect(ambiguous).toContain(
      `Failed: ${keys[0]!.name} names 2 homes; send to one of: `,
    );
    expect(ambiguous).toContain(
      `${x}@${homeAddress} (home ${keys[0]!.name}, connected `,
    );
    expect(ambiguous).toContain(`at ${new URL(servers[0]!.url).origin}`);
    expect(ambiguous).toContain(
      `${x}@${cAddress} (home ${keys[0]!.name}, connected `,
    );
    await until(settled(1, y));
    const liveText = (await cli("read", `${y}@B`, "--limit", "2000")).out;
    expect(await remote!.instance.durable.retire(y)).toBe(true);
    remote!.instance.conversations.discardConvProjection(y);
    const archived = await remote!.instance.durable.archive.get(y);
    expect(archived).not.toBeNull();
    const archivedRead = await cli(
      "read",
      `${archived!.archive_id}@B`,
      "--limit",
      "2000",
    );
    expect(archivedRead).toEqual({ code: 0, out: liveText, err: "" });
    expect((await cli("read", `${y}@B`, "--limit", "2000")).out).toBe(liveText);
    const revoked = await fetch(
      servers[1]!.url + `/api/backend-keys/${keys[0]!.id}`,
      { method: "DELETE", headers: remoteHeaders },
    );
    expect(revoked.status).toBe(200);
    expect((await cli("read", `${y}@B`)).err).toContain(
      "B\'s key was revoked: reconnect in Settings",
    );
    expect((await cli("send", `${y}@B`, "hello")).out).toBe(
      "Failed: B's key was revoked: reconnect in Settings.\n",
    );
    expect((await cli("interrupt", `${y}@B`)).err).toContain(
      "B's key was revoked: reconnect in Settings",
    );
    expect(
      (
        await call(0, "/api/relay/messages", {
          target: `${y}@B`,
          content: "operator denied",
        })
      ).status,
    ).toBe(403);
  } finally {
    deliveryGate?.resolve();
    releasePoll?.();
    cliGateway.stop(true);
    versionGateway.stop(true);
    await Promise.all(servers.map((s) => s.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await Promise.all(fixtures.map((f) => f.host.close()));
    await Promise.all(apps.flatMap((app) => app.detached));
    await Promise.all(
      worlds.map(({ root }) => rm(root, { recursive: true, force: true })),
    );
  }
}, 180_000);
