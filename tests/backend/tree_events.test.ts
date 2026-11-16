import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { buildApp, WebLogSink } from "../../src/web/app";
import { retire } from "../../src/utils/trash";
import { appWorld } from "./web_app_support";
import { openSseConnection } from "../../web/connection/sse-transport";
import { until } from "./fixtures/durable_host/host";

// Regression: #3403 Browser tree streams share one upstream and release it on disconnect.
test("tree event subscribers share and release a remote follower", async () => {
  const worlds = [appWorld(), appWorld()];
  const apps = await Promise.all(
    worlds.map((world) =>
      buildApp({ env: world.env, sink: new WebLogSink(() => {}) }),
    ),
  );
  const servers = await Promise.all(apps.map((app) => app.serve({ port: 0 })));
  let opened = 0;
  let active = 0;
  const gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const tree = url.pathname === "/api/tree/events";
      if (tree) {
        opened++;
        active++;
        request.signal.addEventListener("abort", () => active--, {
          once: true,
        });
      }
      return fetch(servers[1]!.url + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.body ? await request.text() : undefined,
        signal: request.signal,
      });
    },
  });
  const subscriptions: {
    controller: AbortController;
    reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel">;
  }[] = [];
  const open = async () => {
    const controller = new AbortController();
    const response = await fetch(
      servers[0]!.url + "/api/tree/events?backend=R",
      {
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    subscriptions.push({ controller, reader });
    expect((await reader.read()).done).toBe(false);
    return subscriptions.at(-1)!;
  };
  try {
    await until(() =>
      apps.every((app) => app.instance.lifecycle.readinessSnapshot().ready),
    );
    await apps[0]!.connectedBackends.connect(
      "R",
      gateway.url.origin,
      undefined,
    );
    const remoteAgent = await apps[1]!.instance.create.create({
      title: "Remote tree",
    });
    const anchor = await open();
    await until(() => active === 1);
    for (let i = 0; i < 8; i++) {
      const stream = await open();
      const changed = await fetch(servers[1]!.url + "/api/v1/agents/tags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: [remoteAgent.id],
          set: { [`change${i}`]: null },
        }),
      });
      expect(changed.status).toBe(200);
      let frame = "";
      while (!frame.includes('data: ["R"]'))
        frame += new TextDecoder().decode((await stream.reader.read()).value);
      expect(opened).toBe(1);
      expect(active).toBe(1);
      stream.controller.abort();
      await stream.reader.cancel().catch(() => {});
    }
    expect(opened).toBe(1);
    for (let i = 0; i < 31; i++) await open();
    const rejected = await fetch(servers[0]!.url + "/api/tree/events");
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("30");
    const delays: number[] = [];
    let resume: (() => void) | undefined;
    const throttled = openSseConnection(
      servers[0]!.url + "/api/tree/events",
      {
        sleep: (ms) => {
          delays.push(ms);
          return new Promise<void>((resolve) => {
            resume = resolve;
          });
        },
      },
      { onEvent: () => {}, onFailure: () => {} },
    );
    try {
      await until(() => delays.length > 0);
      expect(delays).toEqual([30_000]);
    } finally {
      throttled?.close();
      resume?.();
    }
    for (const stream of subscriptions.slice(1)) {
      stream.controller.abort();
      await stream.reader.cancel().catch(() => {});
    }
    anchor.controller.abort();
    await anchor.reader.cancel().catch(() => {});
    await until(() => active === 0);
    console.log(
      `tree streams: upstream opened=${opened}, active=${active}, downstream opened=${subscriptions.length}`,
    );
  } finally {
    for (const { controller, reader } of subscriptions) {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    gateway.stop(true);
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(apps.map((app) => app.instance.shutdown()));
    await Promise.all(apps.flatMap((app) => app.detached));
    for (const world of worlds)
      retire(
        world.root,
        join(dirname(world.root), `tree-events-trash-${process.pid}`),
      );
  }
});
