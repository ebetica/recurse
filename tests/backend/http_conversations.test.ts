import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxHost, until } from "./fixtures/durable_host/host";
import { DurableHost } from "../../src/agents/durable/host";
import { DurableViews } from "../../src/agents/durable/durable_rows";
import { captureFixture } from "./fixture_subprocess";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ExternalKeyConflict } from "../../src/agents/conversation_store";
import { TreeLifecycleBusy } from "../../src/agents/mutation_guard";
import { CreateSlots } from "../../src/web/conversations";
import { logger } from "../../src/observability/runtime_logging";
import { exchange, normalise, requestBytes } from "./http_corpus";

import {
  buildConversationsApp,
  type ConversationsApp,
} from "./http_conversations_app";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function app(
  options: Parameters<typeof buildConversationsApp>[1] = {},
): Promise<ConversationsApp> {
  const dir = await mkdtemp(join(tmpdir(), "http-conv-"));
  dirs.push(dir);
  return buildConversationsApp(dir, options);
}

const ALPHA = ["Authorization", "Bearer recurse_alpha_alpha-secret"] as const;
const send = async (
  port: number,
  method: string,
  path: string,
  headers: (readonly [string, string])[] = [],
  text?: string,
) =>
  normalise(
    await exchange(
      port,
      requestBytes({
        method,
        path,
        headers,
        ...(text === undefined ? {} : { body: { text } }),
      }),
    ),
    method,
  );

// Regression: #2800 Changes follows the cwd committed by Durable's chdir tool.
test("diff follows an agent chdir into another worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diff-chdir-"));
  dirs.push(dir);
  const { host, faux, records } = fauxHost(dir);
  const built = await app({
    patch: (deps, world) => {
      const conv = { ...world.load("conv-a")!, backend: "durable" };
      world.convs.set("conv-a", conv);
      records["conv-a"] = conv;
      Object.assign(deps, { durable: host });
    },
  });
  const original = String(records["conv-a"]!.workdir);
  const target = join(dir, "other-worktree");
  try {
    const result = await captureFixture(
      ["git", "worktree", "add", "--detach", target, "HEAD"],
      { cwd: original },
    );
    expect(result.exitCode).toBe(0);
    await writeFile(join(target, "chdir-only.txt"), "target worktree change\n");
    expect(
      (await captureFixture(["git", "add", "chdir-only.txt"], { cwd: target }))
        .exitCode,
    ).toBe(0);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("chdir", { directory: target }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("changed directory"),
    ]);
    await host.send("conv-a", "Change into the other worktree", "chdir-diff");
    await until(
      () =>
        host.runningCount() === 0 &&
        host.metadata("conv-a").pending.length === 0,
    );
    for (const suffix of ["/diff", "/diff/files?path=chdir-only.txt"]) {
      const got = await send(
        built.running.port,
        "GET",
        `/api/conversations/conv-a${suffix}`,
      );
      expect(got.status).toBe(200);
      expect(JSON.stringify(got.body)).toContain("chdir-only.txt");
      expect(JSON.stringify(got.body)).toContain("target worktree change");
    }
  } finally {
    await built.running.close();
    await host.close();
  }
});

test("idle history loads over HTTP without opening a runtime, then a message runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "http-cold-view-"));
  dirs.push(dir);
  const seeded = fauxHost(dir);
  const conv = { ...seeded.records.c1, id: "conv-a" };
  seeded.records["conv-a"] = conv;
  const path = seeded.host.storagePath("conv-a");
  await mkdir(dirname(path), { recursive: true });
  new Database(path, { create: true }).close();
  expect((await seeded.host.view("conv-a")).blocks).toEqual([]);
  seeded.faux.setResponses([fauxAssistantMessage("stored reply")]);
  await seeded.host.send("conv-a", "old question", "old-message");
  await until(
    async () =>
      seeded.host.runningCount() === 0 &&
      seeded.host.metadata("conv-a").pending.length === 0 &&
      JSON.stringify(await seeded.host.view("conv-a")).includes("stored reply"),
  );
  await seeded.host.close();
  const events: string[] = [];
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let environments = 0;
  const host = new DurableHost({
    ...seeded.host.deps,
    agentEnv: async (record) => {
      environments += 1;
      reached.resolve();
      await release.promise;
      return seeded.host.deps.agentEnv(record);
    },
    log: (event) => events.push(event),
  });
  const built = await app({
    patch: (deps, world) => {
      world.convs.set("conv-a", conv);
      Object.assign(deps, { durable: host });
      deps.reads.readViewWindow = (cid, options) => host.view(cid, options);
      deps.delivery.deliver = (cid, content) =>
        host.send(cid, content, "new-message");
    },
  });
  try {
    const first = await send(
      built.running.port,
      "GET",
      "/api/conversations/conv-a/view",
    );
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).toContain("stored reply");
    expect(host.opened.has("conv-a")).toBe(false);
    expect(environments).toBe(0);
    expect(events).toEqual(["durable_view_storage"]);
    seeded.faux.setResponses([fauxAssistantMessage("new reply")]);
    const delivered = send(
      built.running.port,
      "POST",
      "/api/conversations/conv-a/deliver",
      [["Content-Type", "application/json"]],
      JSON.stringify({ content: "new question" }),
    );
    await reached.promise;
    const during = await send(
      built.running.port,
      "GET",
      "/api/conversations/conv-a/view",
    );
    expect(during.status).toBe(200);
    expect(JSON.stringify(during.body)).toContain("stored reply");
    expect(events).not.toContain("durable_open");
    release.resolve();
    expect((await delivered).status).toBe(200);
    await until(async () =>
      JSON.stringify(await host.view("conv-a")).includes("new reply"),
    );
    expect(host.opened.has("conv-a")).toBe(true);
    expect(environments).toBe(1);
    expect(events).toContain("durable_open");
  } finally {
    release.resolve();
    await built.running.close();
    await host.close();
  }
});

// Regression: #3005 paging older rows must not turn the next live poll into a reset.
test("view polls exclude paged history and still deliver live rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "view-history-"));
  dirs.push(dir);
  const { host, faux, records } = fauxHost(dir);
  const pageSize = 2;
  const historyTurns = 4;
  host.views = new DurableViews(undefined, pageSize);
  const built = await app({
    patch: (deps, world) => {
      records["conv-a"] = { ...world.load("conv-a")!, backend: "durable" };
      deps.reads.readViewWindow = (cid, options) => host.view(cid, options);
    },
  });
  const read = async (query: string) => {
    const response = await fetch(
      `http://127.0.0.1:${built.running.port}/api/conversations/conv-a/view?limit=${pageSize}&${query}`,
    );
    expect(response.status).toBe(200);
    return (await response.json()) as {
      revision: number;
      instance_id: string;
      blocks: { id: string; text: string }[];
      older: boolean;
      reset: boolean;
    };
  };
  const say = async (n: number) => {
    faux.setResponses([fauxAssistantMessage(`Answer ${n}`)]);
    await host.send("conv-a", `Question ${n}`, `history-${n}`);
    await until(
      () =>
        host.runningCount() === 0 &&
        host.metadata("conv-a").pending.length === 0,
    );
  };
  try {
    for (let n = 0; n < historyTurns; n++) await say(n);
    const initial = await read("");
    let older = initial;
    for (let n = 0; n < 2; n++) {
      expect(older.older).toBe(true);
      older = await read(`before=${encodeURIComponent(older.blocks[0].id)}`);
    }
    const query = `since=${initial.revision}&instance=${initial.instance_id}`;
    const quiet = await read(query);
    expect(quiet.reset).toBe(false);
    expect(quiet.revision).toBe(initial.revision);
    expect(quiet.blocks).toEqual([]);
    await say(historyTurns);
    const live = await read(query);
    expect(live.reset).toBe(false);
    expect(live.blocks.map((row) => row.text)).toEqual([
      `Question ${historyTurns}`,
      `Answer ${historyTurns}`,
    ]);
  } finally {
    await built.running.close();
    await host.close();
  }
});

describe("thinking disclosure", () => {
  test("serves the bounded read and returns 404 for an unavailable entry", async () => {
    const built = await app({
      patch: (deps) => {
        deps.reads.readThinkingText = async (_cid, offset) => {
          return offset === 7 ? { text: "private thought" } : null;
        };
      },
    });
    try {
      const got = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/thinking?offset=7",
      );
      expect(got.status).toBe(200);
      const missing = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/thinking?offset=8",
      );
      expect([missing.status, missing.body]).toEqual([
        404,
        { json: { detail: "Not Found" } },
      ]);
    } finally {
      await built.running.close();
    }
  });
});

describe("service create", () => {
  test("two creates hold the slots; a third waits, then 429", async () => {
    const gates: (() => void)[] = [];
    const built = await app({
      slots: new CreateSlots(2),
      patch: (deps) => {
        const real = deps.create.createOrRejoinServiceConversation;
        deps.create.createOrRejoinServiceConversation = async (o) => {
          await new Promise<void>((resolve) => gates.push(resolve));
          return real(o);
        };
      },
    });
    try {
      const create = () =>
        send(built.running.port, "POST", "/api/service/conversations", [ALPHA]);
      const first = create();
      const second = create();
      while (gates.length < 2) await Bun.sleep(5);
      const started = Date.now();
      const third = await create();
      console.log("busy create refusal ms", Date.now() - started);
      expect([third.status, third.body]).toEqual([
        429,
        { json: { detail: "service create is busy" } },
      ]);
      for (const gate of gates) gate();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
    } finally {
      await built.running.close();
    }
  }, 20_000);

  test("a failed bind rolls the published row back and frees the slot", async () => {
    const built = await app({
      patch: (deps) => {
        deps.store.bindServiceConversation = async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        };
      },
    });
    try {
      const got = await send(
        built.running.port,
        "POST",
        "/api/service/conversations",
        [ALPHA],
      );
      expect([got.status, got.body]).toEqual([
        503,
        { json: { detail: "service_storage_unavailable" } },
      ]);
    } finally {
      await built.running.close();
    }
  });
});

describe("service create bind phase", () => {
  const keyed = (port: number, key: string) =>
    send(
      port,
      "POST",
      "/api/service/conversations",
      [ALPHA, ["Content-Type", "application/json"]],
      JSON.stringify({ external_key: key }),
    );

  test("a lost bind race rolls back and rejoins the winner", async () => {
    const built = await app({
      patch: (deps, world) => {
        deps.store.bindExternalKey = async (p, k) => {
          world.external.set(`${p}\0${k}`, "svc-winner");
          throw new ExternalKeyConflict("external_key binding is unavailable");
        };
      },
    });
    try {
      const got = await keyed(built.running.port, "late");
      expect(got.status).toBe(200);
      expect((got.body as { json: { created: boolean } }).json.created).toBe(
        false,
      );
    } finally {
      await built.running.close();
    }
  });

  test("quota is rechecked under the bind lease", async () => {
    let calls = 0;
    const built = await app({
      patch: (deps) => {
        deps.store.serviceOwnedConversationCount = async () =>
          calls++ === 0 ? 0 : 5;
      },
    });
    try {
      const got = await keyed(built.running.port, "q");
      expect([got.status, got.body]).toEqual([
        429,
        { json: { detail: "max_owned_conversations exceeded" } },
      ]);
    } finally {
      await built.running.close();
    }
  });

  test("a busy lease is 429 and a precheck OSError is 503", async () => {
    const built = await app({
      patch: (deps) => {
        let n = 0;
        deps.mutateExternalStorage = async () => {
          if (n++ === 0) throw new TreeLifecycleBusy("tree lifecycle is busy");
          throw Object.assign(new Error("io"), { code: "EIO" });
        };
      },
    });
    try {
      const busy = await keyed(built.running.port, "b");
      expect([busy.status, busy.body]).toEqual([
        429,
        { json: { detail: "service create is busy" } },
      ]);
      const broken = await keyed(built.running.port, "b");
      expect([broken.status, broken.body]).toEqual([
        503,
        { json: { detail: "service_storage_unavailable" } },
      ]);
    } finally {
      await built.running.close();
    }
  });
});

describe("events", () => {
  test("SSE is gzip-compressed and lifts the idle timeout", async () => {
    const built = await app();
    try {
      const got = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/events",
        [
          ["Accept-Encoding", "gzip"],
          ["Last-Event-ID", "big"],
        ],
      );
      expect(got.headers["content-encoding"]).toBe("gzip");
      expect(got.headers["content-type"]).toBe(
        "text/event-stream; charset=utf-8",
      );
    } finally {
      await built.running.close();
    }
  });
});

// Regression: #2989 a per-switch query string made every revisit a full read.
test("a timed switch read logs its trace and revalidates on a revisit", async () => {
  const messages: string[] = [];
  const built = await app({
    patch: (deps) =>
      Object.assign(deps, {
        log: logger("web", {
          write: (record) => messages.push(record.message),
        }),
      }),
  });
  try {
    const url = `http://127.0.0.1:${built.running.port}/api/conversations/conv-a?focused=1`;
    const trace = "0123456789abcdef0123456789abcdef";
    const timed = {
      "x-recurse-trace": trace,
      "x-recurse-client-dispatch-ms": "4.500",
    };
    const first = await fetch(url, { headers: timed });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-recurse-switch-trace")).toBe(trace);
    await first.arrayBuffer();
    const revisit = await fetch(url, {
      headers: { ...timed, "if-none-match": first.headers.get("etag")! },
    });
    expect(revisit.status).toBe(304);
    const untimed = await fetch(url, {
      headers: { "x-recurse-trace": trace },
    });
    expect(untimed.headers.get("x-recurse-switch-trace")).toBeNull();
    await untimed.arrayBuffer();
    expect(
      messages.filter((m) => m.includes("switch_request_started")),
    ).toEqual(
      Array(2).fill(
        `event=conversation_switch_request_started client_dispatch_ms=4.500 trace_id=${trace}`,
      ),
    );
  } finally {
    await built.running.close();
  }
});

test("the safety toggle leaves the running turn's state alone", async () => {
  const built = await app();
  try {
    const got = await send(
      built.running.port,
      "POST",
      "/api/conversations/conv-run/safety",
      [["Content-Type", "application/json"]],
      '{"off": true}',
    );
    expect(got.body).toEqual({
      json: { id: "conv-run", safety_off: true, safety_off_active: false },
    });
    expect(built.world.drain()).toEqual([
      ["set_safety", "conv-run", true],
      ["request_run", "conv-run"],
    ]);
  } finally {
    await built.running.close();
  }
});

test("every conversation route refuses an unauthenticated caller", async () => {
  const locked = await app({
    authEnv: { CHAT_AUTH_SALT: "00", CHAT_AUTH_HASH: "00".repeat(32) },
  });
  try {
    for (const route of locked.router.routes()) {
      const path = route.path.replace(/\{[^}]+\}/g, "x");
      for (const method of route.methods) {
        const got = await send(locked.running.port, method, path);
        expect([method, path, got.status]).toEqual([method, path, 401]);
      }
    }
    expect(locked.world.drain()).toEqual([]);
  } finally {
    await locked.running.close();
  }
});

test("a working-tree edit after a Changes read shows in the next read", async () => {
  const built = await app();
  try {
    const repo = String(built.world.convs.get("conv-a")!.workdir);
    const read = async () => {
      const got = await send(
        built.running.port,
        "GET",
        "/api/conversations/conv-a/diff",
      );
      expect(got.status).toBe(200);
      return (got.body as { json: { diff: string } }).json.diff;
    };
    expect(await read()).not.toContain("+four");
    await Bun.write(join(repo, "src/app.txt"), "one\ntwo\nthree\nfour\n");
    expect(await read()).toContain("+four");
  } finally {
    await built.running.close();
  }
});
