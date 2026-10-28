// Shared operation-spec driver for the TS replay and reverse Python-open check.
import { Database } from "bun:sqlite";
import type { AgentStore } from "../../../../src/agents/agent_store";

export interface Operation {
  op: string;
  metadata?: Record<string, unknown>;
  body?: Record<string, unknown>;
  kind?: string;
  index?: number;
  id?: string;
}
export interface StoreCase {
  cid: string;
  ops: Operation[];
  ids: string[];
  now: number[];
  read: unknown;
  dump: unknown;
}
function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.$float === "nan" && Object.keys(object).length === 1)
      return Number.NaN;
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [key, materialize(item)]),
    );
  }
  return value;
}

export async function applySpec(
  store: AgentStore,
  spec: StoreCase,
): Promise<void> {
  const submitted: string[] = [];
  for (const op of spec.ops) {
    switch (op.op) {
      case "save":
        store.enqueueMetadata(
          spec.cid,
          materialize(op.metadata) as Record<string, unknown>,
        );
        break;
      case "submit":
        submitted.push(
          store.submit(
            spec.cid,
            op.kind!,
            materialize(op.body) as Record<string, unknown>,
          ),
        );
        break;
      case "retire":
        store.retire(spec.cid, op.id ?? submitted[op.index!]);
        break;
      case "dispatched":
        store.noteDispatched(spec.cid, submitted[op.index!]);
        break;
      case "undispatched":
        store.noteUndispatched(spec.cid, submitted[op.index!]);
        break;
      case "flush":
        if (!(await store.flush(spec.cid))) throw new Error("flush failed");
        break;
      case "drop_dispatches": {
        if (!(await store.flush(spec.cid))) throw new Error("flush failed");
        const db = new Database(store.dbPath(spec.cid));
        try {
          db.run("DROP TABLE dispatches");
        } finally {
          db.close();
        }
        break;
      }
      default:
        throw new Error(`unknown spec op: ${op.op}`);
    }
  }
  if (!(await store.flush(spec.cid))) throw new Error("flush failed");
}
