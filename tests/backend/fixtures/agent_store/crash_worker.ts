// Test-only wrapper: crash once with an uncommitted write; the replacement Worker
// handles the retained batch with the real production handler.
import "../../../../src/agents/agent_store_worker";
import { existsSync, unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { WorkerRequest } from "../../../../src/agents/agent_store";
declare const self: {
  onmessage: (event: MessageEvent<WorkerRequest>) => void;
  close(): void;
};
const handle = self.onmessage;
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const marker = `${event.data.path}.crash`;
  if (event.data.kind === "apply" && existsSync(marker)) {
    unlinkSync(marker);
    const db = new Database(event.data.path);
    db.run("BEGIN IMMEDIATE");
    db.run("UPDATE agent SET data = '{\"partial\":true}' WHERE cid = ?", [
      event.data.cid,
    ]);
    // No COMMIT, ROLLBACK, or close: losing this Worker must release the
    // connection and roll its uncommitted transaction back.
    self.close();
    return;
  }
  handle.call(self, event);
};
