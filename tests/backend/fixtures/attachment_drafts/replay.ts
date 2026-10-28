// Spec replay for attachment-draft parity fixtures.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConfig } from "../../../../src/config";
import type { ConversationRecord } from "../../../../src/agents/conversation_store";
import {
  AttachmentDrafts,
  type DraftDirs,
} from "../../../../src/agents/runtime/attachment_drafts";
import { snapshot } from "../attachments_common";

const DAY = "20260925";
const CONV_KEY = `${DAY}-agent`;
const NOW = 1_790_000_000.5;
const id = (n: number): string => n.toString(16).padStart(32, "0");
type Leaf = { json?: unknown; hex?: string; link?: string; mode?: number };
export interface DraftSpec {
  tree?: Record<string, Leaf>;
  owners?: Array<{ id: string; tmp_key: string }>;
  conversation?: Record<string, unknown>;
  ops: Array<Record<string, unknown>>;
}
export interface RunOutput {
  events: unknown[];
  tokens: string[];
  tree: Array<Record<string, unknown>>;
}

function setup(root: string, spec: DraftSpec): void {
  for (const [name, entry] of Object.entries(spec.tree ?? {})) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    if (entry.link !== undefined) symlinkSync(entry.link, path);
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
function draftDirs(root: string): DraftDirs {
  const temp = join(root, "agent_temp");
  const keyPath = (key: string): string => join(temp, key);
  const ensureKey = async (key: string): Promise<string> => {
    const path = keyPath(key);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
    return path;
  };
  return {
    utcDay: () => DAY,
    uploadsDir: (key) => join(keyPath(key), "uploads"),
    ensureUploadsDir: async (key) => {
      const path = join(await ensureKey(key), "uploads");
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
      return path;
    },
    ensureAgentTemp: async (conv) => ensureKey(String(conv.tmp_key)),
    safeRemoveTempKey: (key) =>
      rm(keyPath(key), { recursive: true, force: true }),
  };
}
function idSource(): () => string {
  let next = 0;
  return () => id(++next);
}

export async function runSpec(
  root: string,
  spec: DraftSpec,
): Promise<RunOutput> {
  setup(root, spec);
  const config = createConfig({
    env: { CHAT_DATA_DIR: root, RECURSE_TEMP_ROOT: `${root}-scratch` },
    cwd: root,
  });
  const records = new Map<string, ConversationRecord>();
  if (spec.conversation && typeof spec.conversation.id === "string")
    records.set(spec.conversation.id, structuredClone(spec.conversation));
  const conversations = {
    load: (cid: string) => {
      const record = records.get(cid);
      return record ? structuredClone(record) : null;
    },
    save: async (conv: ConversationRecord) => {
      records.set(String(conv.id), structuredClone(conv));
    },
  };
  const drafts = new AttachmentDrafts(
    config,
    conversations as never,
    draftDirs(root),
    {
      ids: idSource(),
      now: () => NOW,
    },
  );
  const tokens: string[] = [];
  const vars: Record<string, unknown> = {};
  const events: unknown[] = [];
  for (const op of spec.ops) {
    try {
      let result: unknown = null;
      const token = (): string => String(vars[String(op.token ?? "token")]);
      if (op.op === "create") {
        result = await drafts.createAttachmentDraft();
        vars[String(op.as ?? "token")] = (result as { id: string }).id;
        tokens.push((result as { id: string }).id);
      } else if (op.op === "upload") {
        const item = await drafts.addDraftUpload(
          token(),
          Uint8Array.from(Buffer.from(String(op.hex ?? ""), "hex")),
          String(op.name ?? "file.txt"),
        );
        vars[String(op.as ?? "attachment")] = item.id;
        result = item;
      } else if (op.op === "read") {
        const [manifest, data] = await drafts.readDraftFile(
          token(),
          String(vars[String(op.id ?? "attachment")]),
        );
        result = { manifest, hex: Buffer.from(data).toString("hex") };
      } else if (op.op === "release") {
        result = await drafts.releaseDraftFile(
          token(),
          String(vars[String(op.id ?? "attachment")]),
        );
      } else if (op.op === "abandon") {
        result = await drafts.abandonAttachmentDraft(token());
      } else if (op.op === "claim") {
        await drafts.claimAttachmentDraft(
          token(),
          String(op.agent ?? "conversation-1"),
        );
      } else if (op.op === "transfer") {
        const conv = structuredClone(
          (op.conversation as ConversationRecord | undefined) ?? {
            id: "conversation-1",
            tmp_key: CONV_KEY,
            attachment_draft: token(),
          },
        );
        records.set(String(conv.id), conv);
        await drafts.transferAttachmentDraft(token(), conv);
        result = conv;
      } else if (op.op === "recover") {
        result = await drafts.recoverTransferredAttachmentDraft(token());
      } else if (op.op === "expire") {
        result = await drafts.expireAttachmentDrafts(Number(op.now));
      } else if (op.op === "set_state") {
        const path = join(root, "attachment_drafts", `${token()}.json`);
        const meta = await Bun.file(path).json();
        meta.state = op.state;
        await Bun.write(path, JSON.stringify(meta));
      } else if (op.op === "finish_rollback") {
        await drafts.finishRollingBackDrafts();
      } else {
        throw new Error(`unknown draft operation: ${String(op.op)}`);
      }
      events.push({ result });
    } catch (error) {
      const err = error as Error;
      events.push({ error: { type: err.name, message: err.message } });
    }
  }
  return { events, tokens, tree: snapshot(root) };
}
export const fixtureTime = NOW;
export const fixtureConversationKey = CONV_KEY;
