import { expect, test } from "bun:test";
import { switchoverWorld } from "./fixtures/durable_host/host";
import { TurnPrep } from "../../src/agents/runtime/turn_prep";
import { collectionSnapshot } from "../../src/agents/runtime/node_files";

test("upload annotation refuses stale collections and reaping nodes", async () => {
  const world = await switchoverWorld();
  const { instance } = world;
  const cid = "annotation";
  const node = { reaping: false };
  const prep = new TurnPrep({
    conversations: instance.conversations,
    config: instance.config,
    existingNode: () => node,
  });
  try {
    await instance.conversations.save({
      id: cid,
      backend: "durable",
      model: "recurse-test/scripted",
      workdir: world.root,
      tmp_key: "20261011-agent-annotation",
    });
    const file = await instance.reap.admitConversationUpload(
      cid,
      new TextEncoder().encode("annotation document"),
      "notes.txt",
    );
    const snapshot = collectionSnapshot(
      instance.conversations.load(cid)!,
      instance.config,
    );
    const ids = [String(file.id)];
    const [annotated, images] = await prep.uploadParts(
      "read this",
      cid,
      snapshot,
      ids,
    );
    expect(annotated).toContain("[Attached file(s) are on disk");
    expect(annotated).toContain(`${file.id}.blob`);
    expect(images).toEqual([]);
    node.reaping = true;
    expect(await prep.uploadParts("read this", cid, snapshot, ids)).toEqual([
      "read this",
      [],
    ]);
    node.reaping = false;
    const conv = instance.conversations.load(cid)!;
    conv.tmp_key = "20261011-agent-replaced";
    await instance.conversations.save(conv);
    expect(await prep.uploadParts("read this", cid, snapshot, ids)).toEqual([
      "read this",
      [],
    ]);
  } finally {
    await world.close();
  }
});
