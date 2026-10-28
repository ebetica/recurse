import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConfig } from "../../src/config";
import {
  AttachmentDrafts,
  type DraftDirs,
} from "../../src/agents/runtime/attachment_drafts";
import { flockExclusive, TreeLifecycleBusy } from "../../src/utils/flock";
import { runSpec } from "./fixtures/attachment_drafts/replay";

test("TypeScript recovery resumes a live rolling-back draft", async () =>
  withRoot(async (root) => {
    const output = await runSpec(root, {
      tree: {
        "attachment_counters.json": {
          json: { version: 1, files: 0, bytes: 0 },
        },
      },
      conversation: {
        id: "recovered-agent",
        tmp_key: "20260925-agent",
        title: "Already created",
      },
      ops: [
        { op: "create" },
        { op: "upload", hex: "7265636f766572", name: "resume.txt" },
        { op: "claim", agent: "recovered-agent" },
        { op: "set_state", state: "rolling_back" },
        { op: "finish_rollback" },
        { op: "recover" },
      ],
    });
    const token = (output.events[0] as { result: { id: string } }).result.id;
    const attachment = (output.events[1] as { result: { id: string } }).result
      .id;
    const recovered = output.events[5] as {
      result: {
        id?: unknown;
        title?: unknown;
        attachment_draft?: unknown;
      } | null;
    };
    expect(output.events[4]).toEqual({ result: null });
    expect(recovered.result?.id).toBe("recovered-agent");
    expect(recovered.result?.title).toBe("Already created");
    expect(recovered.result?.attachment_draft).toBeUndefined();
    const paths = output.tree
      .map((entry) => entry.path)
      .filter((path): path is string => typeof path === "string");
    expect(paths).toContain(`attachment_drafts/${token}.json`);
    expect(paths).toContain(
      `agent_temp/20260925-agent/uploads/${attachment}.blob`,
    );
    const receipt = output.tree.find(
      (entry) => entry.path === `attachment_drafts/${token}.json`,
    );
    expect(receipt?.json).toEqual(
      expect.objectContaining({
        state: "transferred",
        agent: "recovered-agent",
      }),
    );
  }));

test("draft lock reports its bounded async wait and remains usable", async () =>
  withRoot(async (root) => {
    const config = createConfig({
      env: { CHAT_DATA_DIR: root, RECURSE_TEMP_ROOT: `${root}-scratch` },
      cwd: root,
    });
    const temp = join(root, "agent_temp");
    const dirs: DraftDirs = {
      utcDay: () => "20260925",
      uploadsDir: (key) => join(temp, key, "uploads"),
      ensureUploadsDir: async (key) => {
        const path = join(temp, key, "uploads");
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
        return path;
      },
      ensureAgentTemp: async () => undefined,
      safeRemoveTempKey: async (key) =>
        rm(join(temp, key), { recursive: true, force: true }),
    };
    const conversations = { load: () => null, save: async () => {} };
    let next = 0;
    const drafts = new AttachmentDrafts(config, conversations as never, dirs, {
      ids: () => (++next).toString(16).padStart(32, "0"),
      now: () => 1_790_000_000,
      flock: { timeoutMs: 0 },
    });
    const token = (await drafts.createAttachmentDraft()).id;
    const lockPath = join(drafts.draftsDir, `${token}.lock`);
    const holder = await open(
      lockPath,
      constants.O_RDWR | constants.O_CREAT,
      0o644,
    );
    const unlock = await flockExclusive(holder.fd, lockPath);
    await expect(
      drafts.claimAttachmentDraft(token, "conversation-1"),
    ).rejects.toBeInstanceOf(TreeLifecycleBusy);
    expect((await holder.stat()).mode & 0o777).toBe(0o600);

    const badLockToken = (await drafts.createAttachmentDraft()).id;
    const expiredToken = (await drafts.createAttachmentDraft()).id;
    await drafts.addDraftUpload(
      expiredToken,
      new TextEncoder().encode("expired"),
      "expired.txt",
    );
    await mkdir(join(drafts.draftsDir, `${badLockToken}.lock`));
    expect(await drafts.expireAttachmentDrafts(3_000_000_000)).toBe(1);
    expect(
      await Bun.file(join(drafts.draftsDir, `${token}.json`)).exists(),
    ).toBe(true);
    expect(
      await Bun.file(join(drafts.draftsDir, `${badLockToken}.json`)).exists(),
    ).toBe(true);
    expect(
      await Bun.file(join(drafts.draftsDir, `${expiredToken}.json`)).exists(),
    ).toBe(false);

    unlock();
    await holder.close();
    await drafts.claimAttachmentDraft(token, "conversation-1");
  }));

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "attachment-drafts-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
