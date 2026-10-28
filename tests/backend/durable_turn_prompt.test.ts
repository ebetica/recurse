import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import {
  SupervisorReads,
  type ReadsDeps,
} from "../../src/agents/supervisor/reads";
import { registerConversationRoutes } from "../../src/web/conversations";
import { Router, type Exchange } from "../../src/web/router";
import { fauxHost, idle, until } from "./fixtures/durable_host/host";

// Regression: #2275 inspector confused Durable entry IDs with legacy offsets
test("turn-prompt serves the stored parent input and reply over Durable IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-inspector-"));
  const { host, faux, records } = fauxHost(root);
  records.c1!.parent = "coordinator";
  const reads = new SupervisorReads({
    claims: {
      metadataSnapshot: (cid: string) => records[cid] ?? null,
      existing: () => null,
      topologyEpoch: () => 0,
      dataDir: () => root,
      binding: () => {
        throw new Error("No legacy binding");
      },
    },
    durable: host,
  } as unknown as ReadsDeps);
  const router = new Router();
  registerConversationRoutes(router, { reads } as never);
  const get = async (offset: number, cid = "c1") => {
    const url = new URL(
      `http://localhost/api/conversations/${cid}/turn-prompt?offset=${offset}`,
    );
    return router.handle({
      request: new Request(url),
      url,
      path: url.pathname,
      scheme: "http",
      params: {},
      query: {},
      state: {},
      disableTimeout() {},
    } as Exchange);
  };
  try {
    let received: { messages: Record<string, unknown>[] } | undefined;
    faux.setResponses([
      (request) => {
        received = request as typeof received;
        return fauxAssistantMessage("INSPECTOR_REPLY");
      },
    ]);
    await host.send(
      "c1",
      "[recurse-origin: agent]\n[recurse-from: coordinator]\n[recurse-from-name: Coordinator]\nInspect this parent message.",
      "parent-message",
    );
    await until(() => received !== undefined);
    await until(idle(host));
    const view = await host.view("c1", {});
    const rows = view.blocks as Record<string, unknown>[];
    const input = rows.find((row) => row.role === "user")!;
    const reply = rows.find((row) => row.role === "assistant")!;
    expect(received).toBeDefined();
    const delivered = received!.messages.find(
      (message) => message.role === "user",
    )!;
    const { conversation } = await host.open("c1");
    const id = Number(input.offset) as EntryId;
    const stored = await conversation.entries(
      { minEntryId: id, maxEntryId: id },
      1,
      undefined,
      context,
    );
    const text = stored.items[0]!.model![0]!.content;
    expect(typeof text).toBe("string");
    expect(String(delivered.content)).toStartWith(String(text));
    expect(delivered.content).not.toBe(text);
    const response = await get(Number(input.offset));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      role: "user",
      input_source: "stored",
      driving: text,
    });
    const answer = await get(Number(reply.offset));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({
      role: "assistant",
      message: "INSPECTOR_REPLY",
    });
    expect((await get(999999)).status).toBe(404);
    expect((await get(-1)).status).toBe(404);
    expect((await get(Number(input.offset), "missing")).status).toBe(404);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
