import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeRunId } from "../../src/agents/conversation_store";
import type { RuntimeLogRecord } from "../../src/observability/runtime_logging";
import { logger } from "../../src/observability/runtime_logging";
import {
  registerConversationRoutes,
  type ConversationsRoutesDeps,
} from "../../src/web/conversations";
import { loopbackAuthenticated } from "../../src/web/request_auth";
import { HttpError, Router } from "../../src/web/router";
import {
  STOP_DIAGNOSTIC_MAX,
  StopDiagnosticBuckets,
  deliverStop,
  registerTreeRoutes,
  type TreeRoutesDeps,
} from "../../src/web/tree";
import { Refs, runRefCases, type RefCase } from "./http_refs";
import { serveOpen } from "./http_open_app";
import corpus from "./fixtures/http_tree/cases.json";
import seed from "./fixtures/http_tree/seed.json";

type Rec = Record<string, unknown>;
type TreeCase = RefCase & { logs: unknown[] };

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

class World {
  convs: Record<string, Rec> = structuredClone(seed.conversations);
  live = new Map<string, [string, string]>(
    Object.entries(seed.live) as [string, [string, string]][],
  );
  load(cid: string): Rec | null {
    const conv = this.convs[cid];
    return conv ? structuredClone(conv) : null;
  }
}

async function buildTreeApp(world: World) {
  const dir = await mkdtemp(join(tmpdir(), "http-tree-"));
  dirs.push(dir);
  const lines: unknown[][] = [];
  const sink = {
    write: (record: RuntimeLogRecord) =>
      lines.push([record.conversation_id, record.run_id, record.message]),
  };
  const state = { ready: true, projection: true };
  let token = "";
  const deps: TreeRoutesDeps = {
    requireActionReady: () => {
      if (!(state.ready && state.projection))
        throw new HttpError(503, "service_storage_unavailable", {
          "retry-after": "2",
        });
    },
    tree: async () => structuredClone(seed.tree),
    loopbackAuthenticated: (ex) => loopbackAuthenticated(ex, token),
    projectionReady: () => state.ready && state.projection,
    nodeCids: () => [...seed.node_cids],
    cliIndex: async () => structuredClone(seed.cli_index),
    transcript: async () => null,
    changeEnvironment: async () => null,
    stopDiagnostics: new StopDiagnosticBuckets(),
    loadConversation: (cid) => world.load(cid),
    activeRunId,
    liveStatus: (cid) => world.live.get(cid) ?? [null, null],
    requestStopProcesses: async (cid, stopId, { expected }) => {
      if (seed.no_idle_stop.includes(cid)) return null;
      return {
        ok: true,
        stop_id: stopId,
        status: "stopped_processes",
        run_id: expected,
      };
    },
    requestStop: async (cid, { expectedRun }) => {
      const run = world.live.get(cid)?.[1] ?? null;
      if (run !== expectedRun || seed.refuse_stop.includes(cid)) return false;
      world.live.delete(cid);
      world.convs[cid]!.status = "idle";
      return true;
    },
    tokenHex: () => crypto.randomUUID().replaceAll("-", ""),
    nowSeconds: () => Date.now() / 1000,
    log: logger("web", sink),
  };
  const router = new Router();
  registerTreeRoutes(router, deps);
  const conversationDeps = new Proxy(
    {
      deliverStop: (cid: string, body: Rec) => deliverStop(deps, cid, body),
    } as Rec,
    { get: (target, name) => target[name as string] },
  ) as unknown as ConversationsRoutesDeps;
  registerConversationRoutes(router, conversationDeps);
  const served = await serveOpen(router, join(dir, "data"));
  token = served.loopbackToken;
  return { ...served, state, lines, deps };
}

describe("corpus", () => {
  test("http_tree", async () => {
    const world = new World();
    const app = await buildTreeApp(world);
    const refs = new Refs();
    refs.put("token", app.loopbackToken);
    try {
      const problems = await runRefCases(
        app.running.port,
        corpus.cases as unknown as TreeCase[],
        refs,
        {
          setup: (spec) => void Object.assign(app.state, spec),
          expect: (item) => {
            expect(refs.walk(app.lines.splice(0)), item.name).toEqual(
              (item as TreeCase).logs,
            );
            if (item.save?.tree_etag)
              expect(refs.values.get("tree_etag"), item.name).toBe(
                'W/"<sha256 of body>"',
              );
            if (item.save?.fresh_stop_id)
              expect(refs.values.get("fresh_stop_id"), item.name).toMatch(
                /^[0-9a-f]{32}$/,
              );
            return undefined;
          },
        },
      );
      expect(problems).toEqual([]);
    } finally {
      await app.running.close();
    }
  }, 60_000);
});

describe("stop diagnostics budget", () => {
  // test-check-allow: T9 Security: per-IP diagnostic abuse budget
  test("32 per IP per window, then silent until the window passes", () => {
    let now = 1000;
    const buckets = new StopDiagnosticBuckets(() => now);
    for (let i = 0; i < STOP_DIAGNOSTIC_MAX; i++)
      expect(buckets.allowed("1.2.3.4")).toBe(true);
    expect(buckets.allowed("1.2.3.4")).toBe(false);
    expect(buckets.allowed("5.6.7.8")).toBe(true);
    now += 60;
    expect(buckets.allowed("1.2.3.4")).toBe(true);
  });

  // test-check-allow: T9 Security: diagnostic IP-table memory bound
  test("at 1,024 tracked IPs a new IP is refused until one expires", () => {
    let now = 0;
    const buckets = new StopDiagnosticBuckets(() => now);
    for (let i = 0; i < 1024; i++) {
      now = i * 0.01;
      expect(buckets.allowed(`ip-${i}`)).toBe(true);
    }
    now = 59;
    expect(buckets.allowed("new")).toBe(false);
    expect(buckets.allowed("ip-5")).toBe(true);
    now = 60.005;
    expect(buckets.allowed("new")).toBe(true);
  });
});
