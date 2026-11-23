import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { buildInstance } from "../../src/agents/instance";
import { Config } from "../../src/config";
import type { RuntimeLogRecord } from "../../src/observability/runtime_logging";
import { appWorld } from "./web_app_support";

test("a save that cannot refresh the tree logs the failure and keeps the old row", async () => {
  const { root, env } = appWorld();
  const records: RuntimeLogRecord[] = [];
  const instance = await buildInstance({
    config: new Config({ env }),
    sink: { write: (record) => void records.push(record) },
  });
  const { conversations, treeView } = instance;
  try {
    await conversations.save({ id: "a", title: "before", updated: 1 });
    expect(treeView.serve()).toMatchObject([{ id: "a", title: "before" }]);
    await conversations.save({ id: "a", title: "malformed", last: 5 });

    expect(records).toContainEqual(
      expect.objectContaining({
        conversation_id: "a",
        message: expect.stringContaining("event=tree_view_refresh_failed"),
      }),
    );
    expect(treeView.serve()).toMatchObject([{ id: "a", title: "before" }]);
  } finally {
    await instance.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
