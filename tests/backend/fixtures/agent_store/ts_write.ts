// Reverse parity gate: write TS SQLite files for record.py to open with Python.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentStore } from "../../../../src/agents/agent_store";
import { applySpec, type StoreCase } from "./spec";
import fixture from "./cases.json";

const root = process.argv[2];
if (!root) throw new Error("usage: bun ts_write.ts <tempdir>");
for (let i = 0; i < fixture.cases.length; i++) {
  const spec = fixture.cases[i] as StoreCase;
  if (!spec.ops) continue;
  const dir = join(root, String(i));
  mkdirSync(dir, { recursive: true });
  const ids = [...spec.ids];
  const times = [...spec.now];
  const store = new AgentStore(dir, {
    ids: () => ids.shift()!,
    now: () => times.shift()!,
  });
  try {
    await applySpec(store, spec);
  } finally {
    await store.dispose();
  }
}
