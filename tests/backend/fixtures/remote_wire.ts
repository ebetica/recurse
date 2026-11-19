// Two real HTTP apps and Pi Durable fake providers; no transport or host mocks.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { buildApp, WebLogSink } from "../../../src/web/app";
import type { DurableHostDeps } from "../../../src/agents/durable/host";
import { publishLoopbackToken } from "../../../src/web/request_auth";
import { retire } from "../../../src/utils/trash";
import { appWorld, PASSWORD } from "../web_app_support";
import { fauxHost, until } from "./durable_host/host";

type App = Awaited<ReturnType<typeof buildApp>>;
type Server = Awaited<ReturnType<App["serve"]>>;
interface WireSide {
  app: App;
  server: Server;
  world: ReturnType<typeof appWorld>;
  provider: ReturnType<typeof fauxHost>;
  agent: string;
  headers: Record<string, string>;
}

export function request(
  side: WireSide,
  path: string,
  body?: object,
  headers = side.headers,
) {
  return fetch(side.server.url + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function outcome(side: WireSide, id: string) {
  let result: { state: string; reason?: string } = { state: "pending" };
  await until(async () => {
    const response = await request(side, `/api/relay/messages/${id}?wait=25`);
    if (!response.ok) throw new Error(`outcome HTTP ${response.status}`);
    result = (await response.json()) as typeof result;
    return result.state !== "pending";
  });
  return result;
}

export function settled(side: WireSide) {
  return (
    side.app.instance.durable.runningCount() === 0 &&
    side.app.instance.durable.metadata(side.agent).pending.length === 0
  );
}

export async function connect(home: WireSide, url: string) {
  const response = await request(
    home,
    "/api/backends",
    { label: "R", url, password: PASSWORD },
    {},
  );
  if (!response.ok) throw new Error(`connect HTTP ${response.status}`);
  await until(() =>
    home.app.connectedBackends
      .list()
      .some((row) => row.label === "R" && row.state === "connected"),
  );
}

export async function forward(remote: WireSide, incoming: Request) {
  const url = new URL(incoming.url);
  const headers = new Headers(incoming.headers);
  headers.set("accept-encoding", "identity");
  return fetch(remote.server.url + url.pathname + url.search, {
    method: incoming.method,
    headers,
    body: incoming.body ? await incoming.text() : undefined,
    signal: incoming.signal,
  });
}

export async function withRemoteWire(
  sleep: boolean,
  use: (home: WireSide, remote: WireSide) => Promise<void>,
) {
  const worlds: ReturnType<typeof appWorld>[] = [];
  const apps: App[] = [];
  const providers: ReturnType<typeof fauxHost>[] = [];
  const servers: Server[] = [];
  const sides: WireSide[] = [];
  try {
    for (const i of [0, 1]) {
      const world = appWorld({ password: i === 1 });
      worlds.push(world);
      world.env.CHAT_APP_NAME = i === 0 ? "Home" : "Remote";
      if (i === 1 && sleep) world.env.RECURSE_SLEEP_WHEN_IDLE = "1";
      const provider = fauxHost(join(world.root, "provider"), undefined, true);
      providers.push(provider);
      const app = await buildApp({
        env: world.env,
        sink: new WebLogSink(() => {}),
      });
      apps.push(app);
      app.connectedBackends.pollWaitSeconds = 0.05;
      if (sleep) app.connectedBackends.idleAfterMs = 0;
      const deps = (
        app.instance.durable as unknown as { deps: DurableHostDeps }
      ).deps;
      const fake = (provider.host as unknown as { deps: DurableHostDeps }).deps;
      Object.assign(deps, { models: fake.models, settings: fake.settings });
      const agentEnv = deps.agentEnv;
      deps.agentEnv = async (...args) => {
        const env = { ...(await agentEnv(...args)) };
        delete env.RECURSE_MODEL_POLICY;
        return env;
      };
      const server = await app.serve({ port: 0 });
      servers.push(server);
      await publishLoopbackToken(world.env.CHAT_DATA_DIR!, server.port);
      await until(() => app.instance.lifecycle.readinessSnapshot().ready);
      const agent = String(
        (
          await app.instance.create.create({
            title: `${i ? "Remote" : "Home"} agent`,
          })
        ).id,
      );
      const { token } = JSON.parse(
        await readFile(join(world.env.CHAT_DATA_DIR!, "server.json"), "utf8"),
      );
      const side: WireSide = {
        app,
        server,
        world,
        provider,
        agent,
        headers: {
          "x-loopback-token": token,
          "x-recurse-agent": agent,
          "x-recurse-bundled-tool": "subagent",
        },
      };
      sides.push(side);
      provider.faux.setResponses([fauxAssistantMessage("wire ready")]);
      await app.instance.nodes.node(agent).setSafety(true);
      await until(async () =>
        JSON.stringify(await app.instance.durable.view(agent)).includes(
          "wire ready",
        ),
      );
      await until(() => settled(side));
    }
    await use(sides[0]!, sides[1]!);
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await Promise.all(providers.map((provider) => provider.host.close()));
    await Promise.all(apps.flatMap((app) => app.detached));
    for (const world of worlds)
      retire(
        world.root,
        join(dirname(world.root), `remote-wire-trash-${process.pid}`),
      );
  }
}
