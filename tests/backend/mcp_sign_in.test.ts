import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpCredentials, McpServers } from "../../src/extensions/extra/mcp/mcp";
import { McpChecks } from "../../src/mcp_checks";
import { durableModels, providerToken } from "../../src/agents/durable/models";
import { ProcessLifecycle } from "../../src/process_lifecycle";
import { ShellRegistry } from "../../src/pi_bg_shell";
import { TaskSet } from "../../src/utils/tasks";
import { MCP_PASTE_REDIRECT } from "../../src/mcp_sign_in";
import { registerMcpServerRoutes } from "../../src/web/settings";
import { buildAuthApp, type AuthApp } from "./http_auth_app";
import { until } from "./fixtures/durable_host/host";
import { startOAuthMcpServer } from "./fixtures/mcp_oauth_server";

// Feature: #2761 Settings signs in with registered or operator-owned OAuth clients and refreshes their grants.
test("Settings signs an HTTP MCP server in through the Recurse callback, across a restart, then refreshes and revokes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-sign-in-"));
  const fixture = startOAuthMcpServer();
  const insecure = startOAuthMcpServer({
    registrationEndpoint: "http://registration.example/register",
  });
  const redirecting = startOAuthMcpServer({
    tokenRedirect: `${fixture.origin}/token`,
  });
  const ownAppOptions = {
    registrationEndpoint: null,
    clientSecret: "operator-$client-secret",
    tokenRedirect: undefined as string | undefined,
  };
  const ownApp = startOAuthMcpServer(ownAppOptions);
  const pastedApp = startOAuthMcpServer({
    registrationEndpoint: null,
    clientSecret: "!pasted-$secret",
    metadataPath: "/as-metadata",
  });
  const documents = startOAuthMcpServer({
    registrationEndpoint: null,
    clientDocuments: true,
  });
  const configPath = join(root, "mcp.json");
  const config = {
    mcpServers: {
      tracker: { url: fixture.url },
      insecure: { url: insecure.url },
      redirecting: { url: redirecting.url },
      ownApp: { url: ownApp.url },
      pasted: {
        url: pastedApp.url,
        auth: "oauth",
        oauth: {
          clientId: "public-app",
          clientSecret: `!cat '${join(root, "pasted-secret")}'`,
          callbackPort: 3118,
          scope: "read write",
          authServerMetadataUrl: `${pastedApp.origin}/as-metadata`,
        },
      },
      document: { url: documents.url, oauth: { clientRegistration: "cimd" } },
      viaLogin: { url: fixture.url, auth: { provider: "openai" } },
    },
  };
  await writeFile(configPath, JSON.stringify(config));
  const processes = new ProcessLifecycle({
    registry: new ShellRegistry({
      enabled: true,
      stateDir: root,
      processStartedMs: Date.now(),
    }),
    shellStateDir: root,
    termGraceMs: 100,
    killGraceMs: 100,
  });
  const tasks = new TaskSet();
  const shutdown = new AbortController();
  const checks = new McpChecks({
    configPath,
    temporaryRoot: root,
    trashDir: join(root, "trash"),
    env: { PATH: process.env.PATH! },
    processes,
    tasks,
    signal: shutdown.signal,
    providerToken: (provider) => providerToken(durableModels(root), provider),
  });
  const start = (port?: number) =>
    buildAuthApp(join(root, "http"), {
      port,
      extraRoutes: (router) =>
        registerMcpServerRoutes(router, {
          piAgentDir: async () => root,
          mutateExternalStorage: (work) => work(),
          mcpChecks: checks,
        }),
    });
  let app: AuthApp = await start();
  const cookie = `chat_auth=${await app.operator.makeToken()}`;
  const at = (path: string) => new URL(path, app.running.url).href;
  const post = (path: string, body: unknown, origin?: string, host?: string) =>
    fetch(at(path), {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
        ...(host ? { host } : {}),
      },
      body: JSON.stringify(body),
    });
  const tracker = async (name = "tracker") =>
    (
      (await (
        await fetch(at("/api/settings/mcp-servers/status"), {
          headers: { cookie },
        })
      ).json()) as {
        servers: {
          name: string;
          state: string;
          toolCount?: number;
          signedIn?: boolean;
          checking?: boolean;
        }[];
      }
    ).servers.find((server) => server.name === name)!;
  const checked = async (name = "tracker") => {
    await until(async () => !(await tracker(name)).checking);
    return tracker(name);
  };
  const begin = (name: string) =>
    post(
      "/api/settings/mcp-servers/sign-in",
      { name },
      new URL(app.running.url).origin,
    );
  const authorize = async (name = "tracker", server = fixture) => {
    const begun = await begin(name);
    expect(begun.status).toBe(200);
    const { url } = (await begun.json()) as { url: string };
    expect(url.startsWith(`${server.origin}/authorize?`)).toBe(true);
    expect(decodeURIComponent(url)).not.toContain("operator-$client-secret");
    const consent = await fetch(url, { redirect: "manual" });
    expect(consent.status).toBe(302);
    return consent.headers.get("location")!;
  };
  const conversation = new McpServers({
    configPath,
    scope: async () => ({ cwd: root, env: { PATH: process.env.PATH! } }),
    own: async () => {},
    release: async () => true,
    report: () => {},
  });
  const callWhoami = async () => {
    const [tool] = await conversation.tools();
    expect(tool?.name).toBe("mcp__tracker__whoami");
    const result = (await tool!.execute(
      {},
      undefined as never,
      {} as never,
    )) as { output: { type: string; text: string }[] };
    return result.output[0]!.text;
  };
  const stored = async () =>
    JSON.parse(await readFile(join(root, "mcp-auth.json"), "utf8")) as Record<
      string,
      { tokens?: { access_token: string; refresh_token: string } }
    >;
  const trackerState = async () =>
    Object.entries(await stored()).find(([key]) =>
      key.endsWith(`|${fixture.url}`),
    )?.[1];
  try {
    expect(
      (await post("/api/settings/mcp-servers/check", { name: "tracker" }))
        .status,
    ).toBe(202);
    expect(await checked()).toMatchObject({
      state: "needs-sign-in",
      signedIn: false,
    });
    expect(await conversation.section()).toContain(
      "MCP server tracker needs sign-in",
    );
    expect(await conversation.tools()).toEqual([]);

    for (const origin of [undefined, "https://attacker.example", "null"]) {
      const refused = await post(
        "/api/settings/mcp-servers/sign-in",
        { name: "tracker" },
        origin,
      );
      expect(refused.status).toBe(origin === undefined ? 400 : 403);
    }
    expect(fixture.clients.size).toBe(0);

    const refused = await begin("insecure");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { detail: string }).detail).toContain(
      "not https",
    );
    expect(insecure.clients.size).toBe(0);
    const redirected = await fetch(
      await authorize("redirecting", redirecting),
      { headers: { cookie }, redirect: "manual" },
    );
    expect(redirected.status).toBe(400);
    expect(redirecting.tokenRequests()).toBe(1);
    expect(fixture.tokenRequests()).toBe(0);

    let callback = await authorize();
    expect(
      callback.startsWith(at("/api/settings/mcp-servers/oauth-callback?")),
    ).toBe(true);
    expect([...fixture.clients.values()]).toEqual([
      { redirect_uris: [at("/api/settings/mcp-servers/oauth-callback")] },
    ]);
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(401);

    const port = app.running.port;
    await app.running.close();
    app = await start(port);

    const pending = mcpCredentials(configPath).forServer(
      "tracker",
      fixture.url,
    );
    for (const signInStartedAt of [
      undefined,
      Date.now() - 2 * 60 * 60 * 1000 - 1,
    ]) {
      const aged = { ...(await pending.load())!, signInStartedAt };
      await pending.save(aged);
      const expired = await fetch(callback, {
        headers: { cookie },
        redirect: "manual",
      });
      expect(expired.status).toBe(400);
      expect(await expired.text()).toContain(
        "This sign-in is no longer pending; start sign-in again from Settings",
      );
      const cleared = await pending.load();
      expect(cleared?.oauthState).toBeUndefined();
      expect(cleared?.codeVerifier).toBeUndefined();
      callback = await authorize();
    }

    const forged = new URL(callback);
    forged.searchParams.set("state", "0".repeat(64));
    const stale = await fetch(forged.href, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("start sign-in again");

    const finished = await fetch(callback, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(finished.status).toBe(303);
    expect(finished.headers.get("location")).toBe("/");
    expect(fixture.grants).toEqual(["authorization_code"]);
    const replay = await fetch(callback, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("start sign-in again");

    expect(await checked()).toMatchObject({
      state: "connected",
      toolCount: 1,
      signedIn: true,
    });
    const [clientId] = [...fixture.clients.keys()];
    expect(await callWhoami()).toBe(`client ${clientId}`);
    const first = (await trackerState())!.tokens!;
    expect((await stat(join(root, "mcp-auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(configPath, "utf8")).not.toContain(
      first.access_token,
    );
    expect(JSON.stringify(await tracker())).not.toContain(first.access_token);
    const checkLogin = async () => {
      expect(
        (await post("/api/settings/mcp-servers/check", { name: "viaLogin" }))
          .status,
      ).toBe(202);
      return checked("viaLogin");
    };
    expect(await checkLogin()).toMatchObject({
      state: "failed",
      reason: "needs a openai sign-in in Settings",
    });
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: first.access_token } }),
    );
    const viaLogin = await checkLogin();
    expect(viaLogin).toMatchObject({ state: "connected", toolCount: 1 });
    expect(viaLogin.signedIn).toBeUndefined();

    fixture.expireAccessTokens();
    const release = fixture.holdRefreshes();
    const refreshed = callWhoami();
    await until(() => fixture.heldRefreshes() === 1);
    const signedOut = post("/api/settings/mcp-servers/sign-out", {
      name: "tracker",
    });
    await Promise.race([signedOut, Bun.sleep(200)]);
    release();
    expect(await refreshed).toBe(`client ${clientId}`);
    expect((await signedOut).status).toBe(200);
    expect(fixture.grants).toEqual(["authorization_code", "refresh_token"]);
    expect(fixture.revoked).toHaveLength(1);
    expect(fixture.revoked[0]).not.toBe(first.refresh_token);
    expect(await trackerState()).toBeUndefined();
    expect(await tracker()).toMatchObject({
      state: "needs-sign-in",
      signedIn: false,
    });

    const tailnet = `recurse.tailnet.example:${app.running.port}`;
    const pasteBegun = await post(
      "/api/settings/mcp-servers/sign-in",
      { name: "tracker" },
      `http://${tailnet}`,
      tailnet,
    );
    expect(pasteBegun.status).toBe(200);
    const consent = await fetch(
      ((await pasteBegun.json()) as { url: string }).url,
      { redirect: "manual" },
    );
    const landed = consent.headers.get("location")!;
    expect(landed.startsWith(`${MCP_PASTE_REDIRECT}?`)).toBe(true);
    expect([...fixture.clients.values()].at(-1)).toEqual({
      redirect_uris: [MCP_PASTE_REDIRECT],
    });
    const paste = (url: string) =>
      post("/api/settings/mcp-servers/finish-sign-in", { url });
    const pasteRefusal = async (url: string) => {
      const response = await paste(url);
      expect(response.status).toBe(400);
      return ((await response.json()) as { detail: string }).detail;
    };
    const viaRecurse = at(
      `/api/settings/mcp-servers/oauth-callback${new URL(landed).search}`,
    );
    for (const malformed of ["", "not a url", viaRecurse])
      expect(await pasteRefusal(malformed)).toContain("Paste the full address");
    expect(
      (
        await fetch(viaRecurse, {
          headers: { cookie, host: "127.0.0.1" },
          redirect: "manual",
        })
      ).status,
    ).toBe(400);
    const forgedPaste = new URL(landed);
    forgedPaste.searchParams.set("state", "0".repeat(64));
    expect(await pasteRefusal(forgedPaste.href)).toContain(
      "start sign-in again",
    );
    const pasted = await paste(`  ${landed}\n`);
    expect(pasted.status).toBe(200);
    expect(await pasted.json()).toEqual({ signedIn: true });
    expect(await pasteRefusal(landed)).toContain("start sign-in again");
    expect(await checked()).toMatchObject({
      state: "connected",
      signedIn: true,
    });
    expect(fixture.grants).toEqual([
      "authorization_code",
      "refresh_token",
      "authorization_code",
    ]);
    const third = (await trackerState())!.tokens!;
    expect(JSON.stringify(await tracker())).not.toContain(third.access_token);

    const missingApp = await begin("ownApp");
    expect(missingApp.status).toBe(400);
    const missingDetail = ((await missingApp.json()) as { detail: string })
      .detail;
    expect(missingDetail).toContain("This server needs your own OAuth app");
    expect(missingDetail).toContain(
      at("/api/settings/mcp-servers/oauth-callback"),
    );
    const configured = {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        ownApp: {
          url: ownApp.url,
          oauth: {
            clientId: "operator-app",
            clientSecret: "operator-$$client-secret",
          },
        },
      },
    };
    const save = (text: string) =>
      fetch(at("/api/settings/mcp-servers"), {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    const configuredResponse = await save(JSON.stringify(configured));
    expect(configuredResponse.status).toBe(200);
    const masked = ((await configuredResponse.json()) as { text: string }).text;
    expect(masked).not.toContain("client-secret");
    expect(JSON.parse(masked).mcpServers.ownApp.oauth.clientSecret).toBe(
      "********",
    );
    expect((await save(masked)).status).toBe(200);
    expect(
      JSON.parse(await readFile(configPath, "utf8")).mcpServers.ownApp.oauth
        .clientSecret,
    ).toBe("operator-$$client-secret");
    ownApp.clients.set("operator-app", {
      redirect_uris: [at("/api/settings/mcp-servers/oauth-callback")],
    });
    const ownCallback = await authorize("ownApp", ownApp);
    const ownPort = app.running.port;
    await app.running.close();
    app = await start(ownPort);
    expect(ownCallback).not.toContain("operator-$client-secret");
    expect(
      (await fetch(ownCallback, { headers: { cookie }, redirect: "manual" }))
        .status,
    ).toBe(303);
    expect(await checked("ownApp")).toMatchObject({
      state: "connected",
      toolCount: 1,
      signedIn: true,
    });
    expect(ownApp.grants).toEqual(["authorization_code"]);
    ownApp.expireAccessTokens();
    expect(
      (await post("/api/settings/mcp-servers/check", { name: "ownApp" }))
        .status,
    ).toBe(202);
    expect(await checked("ownApp")).toMatchObject({
      state: "connected",
      toolCount: 1,
      signedIn: true,
    });
    expect(ownApp.grants).toEqual(["authorization_code", "refresh_token"]);
    expect(ownApp.clients.size).toBe(1);
    expect(JSON.stringify(await tracker("ownApp"))).not.toContain(
      "operator-$client-secret",
    );
    const readConfig = await fetch(at("/api/settings/mcp-servers"), {
      headers: { cookie },
    });
    expect(await readConfig.text()).not.toContain("operator-$client-secret");
    const moved = JSON.parse(masked);
    moved.mcpServers.ownApp.oauth.clientId = "different-app";
    expect((await save(JSON.stringify(moved))).status).toBe(400);
    ownAppOptions.tokenRedirect = `${fixture.origin}/token`;
    const otherTokenRequests = fixture.tokenRequests();
    ownApp.expireAccessTokens();
    expect(
      (await post("/api/settings/mcp-servers/check", { name: "ownApp" }))
        .status,
    ).toBe(202);
    expect((await checked("ownApp")).state).not.toBe("connected");
    expect(fixture.tokenRequests()).toBe(otherTokenRequests);
    await writeFile(join(root, "pasted-secret"), "!pasted-$secret");
    pastedApp.clients.set("public-app", {
      redirect_uris: ["http://127.0.0.1:3118/callback"],
    });
    const signIns = [
      [pastedApp, "pasted", "public-app", "http://127.0.0.1:3118/callback"],
      [
        documents,
        "document",
        /^https:\/\/pi\.dev\/oauth\/[\w-]{12}\/client\.json$/,
        /^http:\/\/127\.0\.0\.1\/callback\/[\w-]{12}$/,
      ],
    ] as const;
    for (const [server, name, client, redirect] of signIns) {
      const begun = await begin(name);
      expect(begun.status).toBe(200);
      const started = (await begun.json()) as {
        url: string;
        redirectUrl: string;
      };
      expect(started.redirectUrl).toMatch(redirect);
      const query = new URL(started.url).searchParams;
      expect(query.get("redirect_uri")).toBe(started.redirectUrl);
      expect(query.get("client_id")).toMatch(client);
      const consent = await fetch(started.url, { redirect: "manual" });
      const answer = consent.headers.get("location")!;
      expect(answer.startsWith(`${started.redirectUrl}?`)).toBe(true);
      const elsewhere = at(
        `/api/settings/mcp-servers/oauth-callback${new URL(answer).search}`,
      );
      expect(await pasteRefusal(elsewhere)).toContain(
        `Paste the full address starting with ${started.redirectUrl}`,
      );
      expect((await paste(answer)).status).toBe(200);
      expect(await checked(name)).toMatchObject({ state: "connected" });
      await rm(join(root, "pasted-secret"));
      expect(
        (await post("/api/settings/mcp-servers/check", { name })).status,
      ).toBe(202);
      expect(await checked(name)).toMatchObject({ state: "connected" });
      await writeFile(join(root, "pasted-secret"), "!pasted-$secret");
      server.expireAccessTokens();
      expect(
        (await post("/api/settings/mcp-servers/check", { name })).status,
      ).toBe(202);
      expect(await checked(name)).toMatchObject({
        state: "connected",
        signedIn: true,
      });
      expect(server.grants).toEqual(["authorization_code", "refresh_token"]);
    }
    expect(pastedApp.scopes).toEqual(["read write"]);
    const saved = await fetch(at("/api/settings/mcp-servers"), {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ text: JSON.stringify({ mcpServers: {} }) }),
    });
    expect(saved.status).toBe(200);
    expect(fixture.revoked).toEqual([fixture.revoked[0], third.refresh_token]);
    expect(await stored()).toEqual({});
  } finally {
    shutdown.abort();
    await conversation.close();
    await tasks.drain();
    await processes.shutdownCleanup();
    await app.running.close();
    await Promise.all(
      [fixture, insecure, redirecting, ownApp, pastedApp, documents].map((s) =>
        s.stop(),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
