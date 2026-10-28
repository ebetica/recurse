import { expect, test } from "bun:test";
import {
  switchoverWorld,
  until,
  held,
  testDeps,
} from "./fixtures/durable_host/host";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { DurableHost } from "../../src/agents/durable/host";
import { collectionSnapshot } from "../../src/agents/runtime/node_files";
import { registerFile } from "../../src/agents/runtime/attachments/publish";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { randomFillSync } from "node:crypto";
import { Database } from "bun:sqlite";
import { WARNING } from "../../src/observability/runtime_logging";

function tallPng(width = 16, height = 2244, noisy = false): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(body));
    return new Uint8Array([...size, ...body, ...crc]);
  };
  const header = Buffer.from("00000010000008c40802000000", "hex");
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const rows = new Uint8Array((width * 3 + 1) * height);
  if (noisy) randomFillSync(rows);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return new Uint8Array([
    ...Buffer.from("89504e470d0a1a0a", "hex"),
    ...chunk("IHDR", new Uint8Array(header)),
    ...chunk("IDAT", new Uint8Array(deflateSync(rows))),
    ...chunk("IEND", new Uint8Array()),
  ]);
}

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("Durable operator attachments reach the provider, transcript and inspector after reopen", async () => {
  const world = await switchoverWorld();
  const { instance } = world;
  const cid = "uploads";
  try {
    await instance.conversations.save({
      id: cid,
      backend: "durable",
      model: "recurse-test/scripted",
      effort: "off",
      workdir: world.root,
      title: cid,
      status: "idle",
      tmp_key: "20261009-agent-uploads",
    });
    const image = await instance.reap.admitConversationUpload(
      cid,
      new Uint8Array(Buffer.from(PNG, "base64")),
      "pixel.png",
    );
    const file = await instance.reap.admitConversationUpload(
      cid,
      new TextEncoder().encode("operator document"),
      "notes.txt",
    );
    const ids = [String(image.id), String(file.id)];
    await instance.delivery.deliver(cid, "Inspect both attachments", {
      attachmentIds: ids,
    });
    await until(() => world.requests.length === 1);
    await until(
      async () =>
        (await instance.durable.view(cid, { limit: 50 })).turn_status ===
        "idle",
    );
    const wire = JSON.stringify(world.requests[0]);
    expect(wire).toContain("[Attached file(s) are on disk");
    for (const id of ids) expect(wire).toContain(`${id}.blob`);
    expect(wire).toContain(`data:image/png;base64,${PNG}`);
    const prompt = await instance.durable.prompt(cid);
    expect(JSON.stringify(prompt.request)).toContain(PNG);
    expect(
      JSON.stringify(await instance.durable.view(cid, { limit: 50 })),
    ).toContain(`${ids[1]}.blob`);
    await instance.durable.close();
    await world.host.send(cid, "What was attached?", "after-reopen");
    await until(() => world.requests.length === 2);
    expect(JSON.stringify(world.requests[1])).toContain(
      `data:image/png;base64,${PNG}`,
    );
    for (const id of ids)
      expect(JSON.stringify(world.requests[1])).toContain(`${id}.blob`);
  } finally {
    await world.close();
  }
});

test("queued attachment content survives shutdown before the queued request starts", async () => {
  const world = await switchoverWorld();
  const { instance } = world;
  const cid = "queued";
  const faux = fauxProvider({ tokensPerSecond: 20000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const logs: unknown[] = [];
  const deps = {
    ...testDeps(
      instance.config.paths.DATA_DIR,
      (id) => instance.conversations.load(id, { withPending: false }),
      () => [cid],
    ),
    models,
    log: (...args: unknown[]) => void logs.push(args),
    uploadParts: (id: string, text: string, ids: readonly string[]) =>
      instance.turnPrep.uploadParts(
        text,
        id,
        collectionSnapshot(instance.conversations.load(id)!, instance.config),
        ids,
      ),
  };
  let host = new DurableHost(deps);
  try {
    await instance.conversations.save({
      id: cid,
      backend: "durable",
      model: "faux/faux-1",
      effort: "off",
      workdir: world.root,
      tmp_key: "20261009-agent-queued",
    });
    const original = tallPng();
    const image = await instance.reap.admitConversationUpload(
      cid,
      original,
      "phone.png",
    );
    const corrupt = await instance.reap.admitConversationUpload(
      cid,
      original.subarray(0, 40),
      "corrupt.png",
    );
    const dense = tallPng(1800, 1800, true);
    expect(Buffer.from(dense).toString("base64").length).toBeGreaterThan(
      4.5 * 1024 * 1024,
    );
    const large = await instance.reap.admitConversationUpload(
      cid,
      dense,
      "dense.png",
    );
    const gate = held(fauxAssistantMessage("first"));
    faux.setResponses([gate.step]);
    await host.send(cid, "first", "first");
    await gate.started;
    await host.send(cid, "queued upload", "queued-upload", {
      attachmentIds: [String(image.id), String(corrupt.id), String(large.id)],
    });
    expect(logs).toContainEqual([
      "upload_image_failed",
      { cid, mime_type: "image/png" },
      WARNING,
    ]);
    await until(() => host.metadata(cid).pending.length === 1);
    await host.close();
    const db = new Database(
      `${instance.config.paths.DATA_DIR}/conversations/${cid}/durable/session.sqlite`,
      { readonly: true },
    );
    const stored = JSON.stringify(
      db
        .query(
          "SELECT content FROM document_revisions r JOIN documents d ON r.document_id = d.id WHERE d.kind = ?",
        )
        .all(JSON.stringify("pi.inbox")),
    );
    db.close();
    expect(stored).not.toContain(Buffer.from(original).toString("base64"));
    const received: string[] = [];
    const answer = (request: unknown) => {
      const wire = JSON.stringify(request);
      if (wire.includes("queued upload")) received.push(wire);
      return fauxAssistantMessage("resumed");
    };
    faux.setResponses([answer, answer]);
    host = new DurableHost(deps);
    await host.view(cid, { limit: 50 });
    await until(() => received.length === 1);
    const queued = received[0]!;
    const request = JSON.parse(queued);
    const blocks = request.messages.flatMap((message: { content?: unknown }) =>
      Array.isArray(message.content) ? message.content : [],
    );
    const boundedImages = blocks.filter(
      (block: { type: string }) => block.type === "image",
    );
    expect(boundedImages).toHaveLength(1);
    for (const block of boundedImages)
      expect(block.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024);
    const bounded = boundedImages[0];
    expect(bounded.mimeType).toBe("image/png");
    const bytes = Buffer.from(bounded.data, "base64");
    expect(
      Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20)),
    ).toBeLessThanOrEqual(2000);
    expect(bounded.data.length).toBeLessThanOrEqual(4.5 * 1024 * 1024);
    expect(queued).toContain(`${image.id}.blob`);
    expect(queued).toContain(`${large.id}.blob`);
    expect(queued).not.toContain(Buffer.from(dense).toString("base64"));
    expect(stored).toContain(bounded.data);
    expect(JSON.stringify(await host.prompt(cid))).toContain(bounded.data);
  } finally {
    await host.close();
    await world.close();
  }
}, 20000);

// Regression: #2209 new Durable conversation had no publishing collection
test("a Durable conversation created after startup can publish from its first turn", async () => {
  const world = await switchoverWorld();
  const { instance } = world;
  const cid = "publisher";
  try {
    await instance.conversations.save({
      id: cid,
      backend: "durable",
      model: "recurse-test/scripted",
      effort: "off",
      workdir: world.root,
      title: cid,
      status: "idle",
      tmp_key: "20261010-agent-publisher",
    });
    await instance.delivery.deliver(cid, "Publish a file");
    await until(() => world.requests.length === 1);
    await writeFile(join(world.root, "report.txt"), "published text\n");
    const { collection } = collectionSnapshot(
      instance.conversations.load(cid)!,
      instance.config,
    )!;
    const item = await registerFile(
      collection,
      cid,
      "b".repeat(32),
      "call-publish",
      "report.txt",
      world.root,
      { manyPerCall: true },
    );
    expect([item.name, item.size]).toEqual(["report.txt", 15]);
  } finally {
    await world.close();
  }
});
