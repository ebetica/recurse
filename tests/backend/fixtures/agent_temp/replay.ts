// Spec replay for agent_temp parity fixtures (mirrors record.py's execute).
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createConfig } from "../../../../src/config";
import type { ConversationRecord } from "../../../../src/agents/conversation_store";
import {
  AgentTemp,
  type AgentTempDeps,
} from "../../../../src/agents/runtime/agent_temp";
import { AttachmentDrafts } from "../../../../src/agents/runtime/attachment_drafts";
import { logger } from "../../../../src/observability/runtime_logging";
import { flockExclusive } from "../../../../src/utils/flock";
import { treeSnapshot } from "../tree_snapshot";

export const NOW = 1_790_000_000.5;
type Leaf = {
  json?: unknown;
  hex?: string;
  link?: string;
  mode?: number;
  dir?: boolean;
};
export interface TempSpec {
  name: string;
  tree?: Record<string, Leaf>;
  conversations?: ConversationRecord[];
  rows?: string[];
  fenced?: string[];
  turn_tasks?: number;
  exclusive?: boolean;
  split_runtime?: boolean;
  ops: Array<Record<string, unknown>>;
}

export function layout(root: string, splitRuntime = false) {
  const data = join(root, "data");
  const scope = join(root, "tmp", "scope");
  const runtime = splitRuntime ? join(root, "rt", "scope") : scope;
  return {
    DATA_DIR: data,
    AGENT_FILES_DIR: join(data, "agent_files"),
    TITLE_LOCK_DIR: join(data, "title_locks"),
    MUTE_LOCK_DIR: join(data, "mute_locks"),
    TURN_PROMPT_DIR: join(data, "turn_prompts"),
    TRASH_DIR: join(data, "trash"),
    AGENT_TEMP_ROOT: join(root, "tmp"),
    AGENT_TEMP_INSTANCE_DIR: scope,
    AGENT_TEMP_TRASH_DIR: join(scope, ".trash"),
    AGENT_RUNTIME_ROOT: join(runtime, ".."),
    AGENT_RUNTIME_INSTANCE_DIR: runtime,
    AGENT_RUNTIME_TRASH_DIR: join(runtime, ".trash"),
    AGENT_TEMP_USES_SHORT_DEFAULT: false,
  };
}

function setup(root: string, spec: TempSpec): void {
  for (const [name, entry] of Object.entries(spec.tree ?? {})) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    if (entry.dir) {
      mkdirSync(path, { recursive: true });
      chmodSync(path, entry.mode ?? 0o700);
    } else if (entry.link !== undefined) symlinkSync(entry.link, path);
    else {
      writeFileSync(
        path,
        entry.json !== undefined
          ? JSON.stringify(entry.json)
          : Uint8Array.from(Buffer.from(entry.hex ?? "", "hex")),
      );
      chmodSync(path, entry.mode ?? 0o600);
    }
  }
}

/** Tree rows with random trash entry names collapsed to "T". */
export function snapshot(root: string): Record<string, unknown>[] {
  type Row = Record<string, unknown>;
  const key = (r: Record<string, unknown>) =>
    [r.path, r.kind, r.sha256 ?? ""].map(String);
  return treeSnapshot(root)
    .map((row): Row => {
      const parts = String(row.path).split("/");
      for (let i = 1; i < parts.length; i++)
        if (
          (parts[i - 1] === ".trash" || parts[i - 1] === "trash") &&
          /^[0-9a-f]{32}$/u.test(parts[i]!)
        )
          parts[i] = "T";
      return { ...row, path: parts.join("/") };
    })
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      for (let i = 0; i < 3; i++)
        if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
      return Number(a.size) - Number(b.size);
    });
}

function stable(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.replaceAll(root, "<ROOT>");
  if (Array.isArray(value)) return value.map((v) => stable(v, root));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, stable(v, root)]),
    );
  return value;
}

function counter(width: number): () => string {
  let n = 0;
  return () => (++n).toString(16).padStart(width, "0");
}

/** Build an AgentTemp + AttachmentDrafts pair over an in-memory store. */
export function build(
  root: string,
  spec: TempSpec,
  opIndex = () => 1,
  fenced = new Set(spec.fenced ?? []),
  extra: Partial<AgentTempDeps> = {},
) {
  const config = createConfig({ env: { CHAT_DATA_DIR: root }, cwd: root });
  Object.assign(config.paths, layout(root, spec.split_runtime));
  const records = new Map<string, ConversationRecord>();
  for (const c of spec.conversations ?? [])
    records.set(String(c.id), structuredClone(c));
  const rows = new Set(spec.rows ?? [...records.keys()]);
  const through = <T>(_cid: string, fn: (...a: never[]) => Promise<T>) =>
    fn(...([{}, {}] as never[]));
  // The delete-state guard is a real per-owner mutex, as reap relies on it.
  let tail: Promise<unknown> = Promise.resolve();
  const deleteGuard = <T>(_cid: string, fn: (...a: never[]) => Promise<T>) => {
    const run = tail.then(() => fn(...([{}, {}] as never[])));
    tail = run.catch(() => {});
    return run;
  };
  const conversations = {
    load: (cid: string) => {
      const record = records.get(cid);
      return record ? structuredClone(record) : null;
    },
    save: async (conv: ConversationRecord) => {
      records.set(String(conv.id), structuredClone(conv));
    },
    allConvs: () => [...records.values()].map((r) => structuredClone(r)),
    convRowExists: (cid: string) => rows.has(cid),
    withTitleGuard: through,
    withMuteGuard: through,
    withPermanentDeleteStateGuard: deleteGuard,
  };
  const temp = new AgentTemp(config, {
    conversations: conversations as never,
    logger: logger("agents.agent_temp", { write: () => {} }),
    ownerAdmits: (cid) => !fenced.has(cid),
    hasCollection: (conv) => !conv._no_collection,
    promptSidecarNames: (conv) =>
      Array.isArray(conv._prompts) ? conv._prompts.slice(0, 3) : [],
    now: () => NOW,
    nonce: counter(16),
    expireRetained: () => {},
    ...extra,
    ids: () => opIndex().toString(16).padStart(32, "0"),
  });
  const drafts = new AttachmentDrafts(config, conversations as never, temp, {
    now: () => NOW,
  });
  temp.attachDrafts(drafts);
  return { temp, drafts, records, conversations };
}

export async function runSpec(root: string, spec: TempSpec) {
  setup(root, spec);
  let index = 0;
  const { temp, records } = build(root, spec, () => index);
  const events: unknown[] = [];
  const held: Array<[number, () => void]> = [];
  for (const op of spec.ops) {
    index += 1;
    const s = (k: string) => String(op[k]);
    try {
      let result: unknown = null;
      switch (op.op) {
        case "utc_day":
          result = temp.utcDay(Number(op.ts));
          break;
        case "pool_scratch":
          result = await temp.newPoolScratch(s("owner"));
          break;
        case "workdir_file":
          result = temp.workdirFile(s("key"));
          break;
        case "uploads_dir":
          result = temp.uploadsDir(s("key"));
          break;
        case "ensure_uploads":
          result = await temp.ensureUploadsDir(s("key"));
          break;
        case "ensure_temp": {
          const conv = structuredClone(
            records.get(s("cid")) ?? { id: s("cid") },
          );
          const path = await temp.ensureAgentTemp(conv, {
            persist: (op.persist as boolean | undefined) ?? true,
          });
          result = { path, conv };
          break;
        }
        case "runtime_path":
          result = await temp.agentRuntimePath(
            structuredClone(records.get(s("cid"))!),
          );
          break;
        case "upload":
          result = await temp.addConversationUpload(
            s("cid"),
            Uint8Array.from(Buffer.from(s("hex"), "hex")),
            String(op.name ?? "f.txt"),
            { now: NOW },
          );
          break;
        case "remove_key":
          result = await temp.safeRemoveTempKey(s("key"));
          break;
        case "cleanup":
          await temp.cleanupAgentTemps(op.owners as Array<[string, unknown]>);
          break;
        case "retire_member":
          result = await temp.retireMemberCollection(s("cid"), s("key"));
          break;
        case "lock": {
          const fd = openSync(join(root, s("path")), "r");
          held.push([fd, await flockExclusive(fd, s("path"))]);
          break;
        }
        case "unlock":
          for (const [fd, unlock] of held.splice(0)) {
            unlock();
            closeSync(fd);
          }
          break;
        case "prune":
          result = await temp.pruneAgentTempStartup();
          break;
        case "reconcile":
          await temp.reconcileAgentTempStartup({
            sweepOrphans: op.sweep !== false,
          });
          break;
        default:
          throw new Error(`unknown op ${String(op.op)}`);
      }
      events.push({ result: stable(result, root) });
    } catch (error) {
      const err = error as Error;
      events.push({ error: { type: err.name, message: err.message } });
    }
  }
  for (const [fd] of held) closeSync(fd);
  return {
    events,
    records: stable(Object.fromEntries(records), root),
    tree: snapshot(root),
  };
}
