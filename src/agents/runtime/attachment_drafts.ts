// Draft-upload staging: draft lock always precedes collection lock.
// Pinned-parent lock paths fail closed; reused locks are 0600, waits bounded.
// Atomic JSON fsyncs the file, not parent. Expiry isolates failures/skips busy
// locks; startup completes live-owner rollback instead of leaving it stuck.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_DRAFT_KEY_RE } from "../../config";
import type { Config } from "../../config";
import type {
  ConversationGuardToken,
  ConversationRecord,
  ConversationStore,
} from "../conversation_store";
import { atomicJson, openPinnedLockFile, readJson } from "../fs_utils";
import {
  flockExclusive,
  TreeLifecycleBusy,
  type FlockOptions,
} from "../../utils/flock";
import {
  AttachmentError,
  AttachmentNotFound,
  ID_REGEX,
  SOURCE_UPLOAD,
  type Manifest,
} from "./attachments/base";
import * as attachmentPreview from "./attachments/preview";
import * as publish from "./attachments/publish";
import * as published from "./attachments/published";

export type DraftMeta = Record<string, unknown>;
export interface DraftDirs {
  utcDay(): string;
  ensureUploadsDir(tempKey: string): string | Promise<string>;
  uploadsDir(tempKey: string): string;
  ensureAgentTemp(conv: ConversationRecord): unknown | Promise<unknown>;
  safeRemoveTempKey(tempKey: string): unknown | Promise<unknown>;
}
export interface DraftOptions {
  /** 32-character lowercase hex ids, shared with attachment publication. */
  ids?: () => string;

  now?: () => number;
  /** Tests may shorten the shared async flock deadline. */
  flock?: FlockOptions;
}
type ConversationAccess = Pick<ConversationStore, "load" | "save">;

const TOKEN_RE = ID_REGEX;
const STATES = new Set([
  "active",
  "transferring",
  "transferred",
  "rolling_back",
]);
const defaultId = (): string => randomUUID().replaceAll("-", "");
const systemNow = (): number => Date.now() / 1000;
const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;
const missing = (error: unknown): boolean =>
  isNodeError(error) && error.code === "ENOENT";
const isValueError = (error: unknown): boolean =>
  error instanceof Error && error.name === "ValueError";
const isOSError = (error: unknown): boolean => isNodeError(error);

class DraftValueError extends Error {
  override name = "ValueError";
}
class DraftRuntimeError extends Error {
  override name = "RuntimeError";
}
class DraftKeyError extends Error {
  override name = "KeyError";
  constructor(message: string) {
    super(`'${message}'`);
  }
}

function keyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One draft lifecycle with explicit configuration and agent-temp services. */
export class AttachmentDrafts {
  readonly draftsDir: string;
  private readonly ids: () => string;
  private readonly now: () => number;
  private readonly flock: FlockOptions | undefined;

  constructor(
    readonly config: Config,
    readonly conversations: ConversationAccess,
    readonly dirs: DraftDirs,
    options: DraftOptions = {},
  ) {
    this.draftsDir = join(config.paths.DATA_DIR, "attachment_drafts");
    this.ids = options.ids ?? defaultId;
    this.now = options.now ?? systemNow;
    this.flock = options.flock;
  }

  private draftPath(token: string): string {
    return join(this.draftsDir, `${token}.json`);
  }
  private lockPath(token: string): string {
    return join(this.draftsDir, `${token}.lock`);
  }
  private ownerLabel(token: string): string {
    return `draft:${token}`;
  }
  private checkToken(token: unknown): string {
    if (typeof token !== "string" || !TOKEN_RE.test(token))
      throw new DraftValueError("bad attachment draft");
    return token;
  }
  private async readMeta(token: string): Promise<DraftMeta | null> {
    const value = await readJson(this.draftPath(token));
    if (
      !value ||
      value.id !== token ||
      typeof value.tmp_key !== "string" ||
      !AGENT_DRAFT_KEY_RE.test(value.tmp_key) ||
      typeof value.state !== "string" ||
      !STATES.has(value.state)
    )
      return null;
    return value;
  }
  private async writeMeta(token: string, meta: DraftMeta): Promise<void> {
    await atomicJson(this.draftPath(token), meta, this.ids);
  }

  /** Serialize mutations of one token; lock order is draft then collection. */
  private async withLocked<T>(token: string, fn: () => Promise<T>): Promise<T> {
    await mkdir(this.draftsDir, { recursive: true });
    const directory = await open(
      this.draftsDir,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
    );
    let lock;
    let unlock: (() => void) | undefined;
    try {
      try {
        lock = await openPinnedLockFile(`${token}.lock`, directory);
      } catch {
        throw new AttachmentError("attachment draft is unavailable");
      }
      unlock = await flockExclusive(lock.fd, this.lockPath(token), this.flock);
      return await fn();
    } finally {
      try {
        try {
          unlock?.();
        } catch {
          // Invariant: Python's best-effort LOCK_UN does not replace the
          // operation result.
        }
      } finally {
        try {
          await lock?.close();
        } finally {
          await directory.close();
        }
      }
    }
  }
  private async unlinkMissing(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  private async removeLock(token: string): Promise<void> {
    await this.unlinkMissing(this.lockPath(token));
  }

  /** Allocate authenticated staging before a frontend draft has an id. */
  async createAttachmentDraft(): Promise<{ id: string }> {
    await mkdir(this.draftsDir, { recursive: true });
    for (let attempt = 0; attempt < 10; attempt++) {
      const token = this.ids();
      if (!TOKEN_RE.test(token)) continue;
      try {
        await access(this.draftPath(token));
        continue;
      } catch {
        // Invariant: Path.exists() in the Python implementation also treats
        // inaccessible or broken entries as absent; atomic publication remains
        // authoritative.
      }
      const key = `draft-${this.dirs.utcDay()}-${token}`;
      await this.dirs.ensureUploadsDir(key);
      const now = this.now();
      await this.writeMeta(token, {
        id: token,
        tmp_key: key,
        created: now,
        updated: now,
        state: "active",
        attachments: [],
      });
      return { id: token };
    }
    throw new DraftRuntimeError("could not allocate attachment draft");
  }

  /** Remove one staged upload unless its token has already transferred. */
  async releaseDraftFile(
    tokenValue: unknown,
    attachmentId: string,
  ): Promise<boolean> {
    const token = this.checkToken(tokenValue);
    return this.withLocked(token, async () => {
      const meta = await this.readMeta(token);
      if (!meta || meta.state !== "active") return false;
      let collection: string;
      try {
        collection = this.dirs.uploadsDir(String(meta.tmp_key || ""));
      } catch (error) {
        if (isValueError(error)) return false;
        throw error;
      }
      const removed = await publish.removeFile(
        collection,
        this.ownerLabel(token),
        attachmentId,
      );
      if (removed) {
        const attachments = meta.attachments;
        if (Array.isArray(attachments))
          meta.attachments = attachments.filter(
            (item) => item !== attachmentId,
          );
        meta.updated = this.now();
        await this.writeMeta(token, meta);
      }
      return removed;
    });
  }

  /** Read one staged file; KeyError when no active draft holds it. */
  async readDraftFile(
    tokenValue: unknown,
    attachmentId: string,
  ): Promise<[Manifest, Uint8Array]> {
    const token = this.checkToken(tokenValue);
    const meta = await this.readMeta(token);
    if (!meta || meta.state !== "active")
      throw new DraftKeyError("attachment draft not found");
    try {
      return await attachmentPreview.readDownload(
        this.dirs.uploadsDir(String(meta.tmp_key || "")),
        this.ownerLabel(token),
        attachmentId,
      );
    } catch (error) {
      if (
        error instanceof AttachmentNotFound ||
        error instanceof AttachmentError
      )
        throw new DraftKeyError("attachment not found");
      throw error;
    }
  }

  /** Append one browser upload, serialized against transfer and expiry. */
  async addDraftUpload(
    tokenValue: unknown,
    data: Uint8Array,
    filename: string,
    options: { now?: number } = {},
  ): Promise<Manifest> {
    const token = this.checkToken(tokenValue);
    return this.withLocked(token, async () => {
      const meta = await this.readMeta(token);
      if (!meta || meta.state !== "active")
        throw new DraftKeyError("attachment draft not found");
      const collection = this.dirs.uploadsDir(String(meta.tmp_key));
      const item = await publish.addUpload(
        collection,
        this.ownerLabel(token),
        data,
        filename,
        {
          now: options.now ?? this.now(),
          ids: this.ids,
        },
      );
      const current = await this.readMeta(token);
      if (current && current.state === "active") {
        let attachments: unknown = current.attachments;
        if (attachments === undefined) attachments = [];
        if (!Array.isArray(attachments))
          throw new DraftKeyError("attachment draft not found");
        const manifestId = item.id;
        if (typeof manifestId !== "string")
          throw new AttachmentError("attachment manifest is corrupt");
        if (!attachments.includes(manifestId)) attachments.push(manifestId);
        current.attachments = attachments;
        current.updated = this.now();
        await this.writeMeta(token, current);
      }
      return item;
    });
  }

  private async releaseDraftFiles(
    meta: DraftMeta,
    token: string,
  ): Promise<void> {
    let collection: string;
    try {
      collection = this.dirs.uploadsDir(String(meta.tmp_key || ""));
    } catch (error) {
      if (isValueError(error)) return;
      throw error;
    }
    const owner = this.ownerLabel(token);
    let files: Manifest[];
    try {
      files = await published.publishedFiles(collection, owner);
    } catch (error) {
      if (error instanceof AttachmentError) return;
      throw error;
    }
    for (const item of files) {
      const aid = item.id;
      if (typeof aid === "string")
        await publish.removeFile(collection, owner, aid);
    }
  }

  /** Release an active draft and its staged uploads. */
  async abandonAttachmentDraft(tokenValue: unknown): Promise<boolean> {
    const token = this.checkToken(tokenValue);
    let key = "";
    const abandoned = await this.withLocked(token, async () => {
      const meta = await this.readMeta(token);
      if (!meta || meta.state !== "active") return false;
      await this.releaseDraftFiles(meta, token);
      await this.unlinkMissing(this.draftPath(token));
      key = String(meta.tmp_key || "");
      return true;
    });
    if (!abandoned) return false;
    if (AGENT_DRAFT_KEY_RE.test(key)) await this.dirs.safeRemoveTempKey(key);
    await this.removeLock(token);
    return true;
  }

  /** Reserve an active token for exactly one newly-created conversation. */
  async claimAttachmentDraft(tokenValue: unknown, cid: string): Promise<void> {
    const token = this.checkToken(tokenValue);
    await this.withLocked(token, async () => {
      const meta = await this.readMeta(token);
      if (!meta || meta.state !== "active")
        throw new DraftValueError("attachment draft not found");
      meta.state = "transferring";
      meta.agent = cid;
      meta.updated = this.now();
      await this.writeMeta(token, meta);
    });
  }

  private async adoptStagedFiles(
    draftCollection: string,
    draftOwner: string,
    conversationCollection: string,
    cid: string,
    staged: Manifest[],
  ): Promise<{ landed: string[]; failures: number }> {
    const landed: string[] = [];
    let failures = 0;
    for (const item of staged) {
      if (
        await this.adoptDraftFile(
          draftCollection,
          draftOwner,
          conversationCollection,
          cid,
          item,
        )
      ) {
        if (typeof item.id === "string") landed.push(item.id);
      } else failures++;
    }
    return { landed, failures };
  }

  /** Move staged files idempotently; reuse any caller-held title guard token.
   * The guard is not reentrant, so both saves must share that token. */
  transferAttachmentDraft(
    tokenValue: unknown,
    conv: ConversationRecord,
    titleToken?: ConversationGuardToken,
  ): Promise<void> {
    return this.transferDraft(tokenValue, conv, false, titleToken);
  }

  private async transferDraft(
    tokenValue: unknown,
    conv: ConversationRecord,
    resumeRollingBack: boolean,
    titleToken?: ConversationGuardToken,
  ): Promise<void> {
    const token = this.checkToken(tokenValue);
    await this.withLocked(token, async () => {
      let meta = await this.readMeta(token);
      if (!meta) {
        if (conv.attachment_draft === token) {
          delete conv.attachment_draft;
          await this.conversations.save(conv, titleToken);
        }
        return;
      }
      if (
        meta.state !== "active" &&
        meta.state !== "transferring" &&
        !(resumeRollingBack && meta.state === "rolling_back")
      )
        throw new DraftValueError("attachment draft is not active");
      const claimedBy = meta.agent;
      if (claimedBy != null && claimedBy !== conv.id)
        throw new DraftValueError(
          "attachment draft belongs to another conversation",
        );
      meta.state = "transferring";
      meta.agent = conv.id;
      meta.updated = this.now();
      await this.writeMeta(token, meta);
      await this.dirs.ensureAgentTemp(conv);
      const draftOwner = this.ownerLabel(token);
      let draftCollection: string;
      try {
        draftCollection = this.dirs.uploadsDir(String(meta.tmp_key));
      } catch (error) {
        if (isValueError(error))
          throw new DraftValueError("unsafe attachment transfer key");
        throw error;
      }
      let staged: Manifest[];
      try {
        staged = await published.publishedFiles(draftCollection, draftOwner);
      } catch (error) {
        if (!(error instanceof AttachmentError)) throw error;
        staged = [];
      }
      const conversationCollection = await this.dirs.ensureUploadsDir(
        String(conv.tmp_key),
      );
      const { landed, failures } = await this.adoptStagedFiles(
        draftCollection,
        draftOwner,
        conversationCollection,
        String(conv.id),
        staged,
      );
      await this.dropOrphanedAdoptions(conv, conversationCollection, landed);
      let remaining: Manifest[];
      try {
        remaining = await published.publishedFiles(draftCollection, draftOwner);
      } catch (error) {
        if (!(error instanceof AttachmentError)) throw error;
        remaining = failures ? staged : [];
      }
      meta = (await this.readMeta(token)) ?? meta;
      await this.finishDraftTransfer(
        token,
        meta,
        conv,
        remaining,
        failures,
        titleToken,
      );
    });
  }

  private async dropOrphanedAdoptions(
    conv: ConversationRecord,
    conversationCollection: string,
    landedIds: string[],
  ): Promise<void> {
    const live = this.conversations.load(String(conv.id));
    if (live !== null && live.tmp_key === conv.tmp_key) return;
    for (const id of landedIds)
      await publish.removeFile(conversationCollection, String(conv.id), id);
  }

  private async finishDraftTransfer(
    token: string,
    meta: DraftMeta,
    conv: ConversationRecord,
    remaining: Manifest[],
    failures: number,
    titleToken: ConversationGuardToken | undefined,
  ): Promise<void> {
    meta.attachments = remaining.flatMap((item) =>
      typeof item.id === "string" ? [item.id] : [],
    );
    if (remaining.length) meta.state = "transferring";
    else meta.state = "transferred";
    meta.updated = this.now();
    await this.writeMeta(token, meta);
    if (!remaining.length) {
      const key = String(meta.tmp_key || "");
      if (AGENT_DRAFT_KEY_RE.test(key)) await this.dirs.safeRemoveTempKey(key);
      await this.removeLock(token);
    }
    if (failures && !remaining.length)
      throw new AttachmentError("attachment draft transfer failed");
    delete conv.attachment_draft;
    await this.conversations.save(conv, titleToken);
  }

  private adoptedImportArgs(
    item: Manifest,
    manifest: Manifest,
    aid: string,
  ): [string, string, number, string | null] {
    const sha256 = manifest.sha256;
    if (typeof sha256 !== "string")
      throw new AttachmentError("draft bytes are missing");
    const created = manifest.created_at || this.now();
    if (typeof created !== "number" && typeof created !== "boolean")
      throw new AttachmentError("attachment timestamp is invalid");
    const rawName = item.name || manifest.name || aid;
    if (typeof rawName !== "string")
      throw new AttachmentError("attachment needs a safe display filename");
    const inline =
      typeof item.inline_media_type === "string"
        ? item.inline_media_type
        : null;
    return [rawName, sha256, created as number, inline];
  }

  private async dropIfAlreadyAdopted(
    draftCollection: string,
    conversationCollection: string,
    cid: string,
    aid: string,
    size: number,
  ): Promise<boolean> {
    let landed: Manifest | null;
    try {
      landed = await attachmentPreview.describe(
        conversationCollection,
        cid,
        aid,
      );
    } catch (error) {
      if (error instanceof AttachmentError) return false;
      throw error;
    }
    if (landed && Number(landed.size) === size) {
      await this.dropDraftCopy(draftCollection, `${aid}.blob`, aid);
      console.warn("draft copy already adopted, charge kept for reconcile");
      return true;
    }
    return false;
  }

  private async adoptDraftFile(
    draftCollection: string,
    draftOwner: string,
    conversationCollection: string,
    cid: string,
    item: Manifest,
  ): Promise<boolean> {
    const aid = item.id;
    if (typeof aid !== "string") return false;
    const size = item.size;
    if (
      (typeof size !== "number" && typeof size !== "boolean") ||
      (typeof size === "number" && !Number.isInteger(size))
    )
      return false;
    const numericSize = Number(size);
    if (
      await this.dropIfAlreadyAdopted(
        draftCollection,
        conversationCollection,
        cid,
        aid,
        numericSize,
      )
    )
      return true;
    let opened: Awaited<ReturnType<typeof attachmentPreview.openFile>> = null;
    try {
      opened = await attachmentPreview.openFile(
        draftCollection,
        draftOwner,
        aid,
      );
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error;
    }
    if (!opened) return false;
    const { blob, manifest } = opened;
    try {
      if (Number(manifest.size) !== numericSize)
        throw new AttachmentError("draft bytes are missing");
      const [name, sha256, created, inlineMediaType] = this.adoptedImportArgs(
        item,
        manifest,
        aid,
      );
      const readChunk = async (): Promise<Uint8Array> => {
        const buffer = new Uint8Array(64 * 1024);
        const { bytesRead } = await blob.read(buffer, 0, buffer.length, null);
        return buffer.slice(0, bytesRead);
      };
      await publish.importFile(conversationCollection, cid, {
        fileId: aid,
        name,
        size: numericSize,
        sha256,
        created,
        source: SOURCE_UPLOAD,
        published: true,
        readChunk,
        inlineMediaType,
        ids: this.ids,
      });
    } catch (error) {
      if (!(error instanceof AttachmentError) && !isOSError(error)) throw error;
      console.warn("draft transfer copy failed", {
        error: keyErrorMessage(error),
      });
      return false;
    } finally {
      await blob.close();
    }
    await this.dropDraftCopy(draftCollection, `${aid}.blob`, aid);
    return true;
  }

  private async dropDraftCopy(
    collection: string,
    blob: string,
    aid: string,
  ): Promise<void> {
    for (const name of [blob, `${aid}.json`]) {
      try {
        await unlink(join(collection, name));
      } catch {}
    }
  }

  /** Recover the conversation already created from a one-shot token. */
  async recoverTransferredAttachmentDraft(
    token: unknown,
  ): Promise<ConversationRecord | null> {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    return this.withLocked(token, async () => {
      const meta = await this.readMeta(token);
      if (!meta || meta.state !== "transferred") return null;
      if (typeof meta.agent !== "string") return null;
      return this.conversations.load(meta.agent);
    });
  }

  private async expireDraftToken(
    token: string,
    now: number,
  ): Promise<string | null> {
    if (!TOKEN_RE.test(token)) return null;
    let key = "";
    const expired = await this.withLocked(token, async () => {
      const meta = await this.readMeta(token);
      if (!meta || meta.state === "rolling_back") return false;
      const touchedValue = meta.updated || meta.created || now;
      if (typeof touchedValue !== "number" && typeof touchedValue !== "boolean")
        return false;
      if (now - Number(touchedValue) < this.config.paths.AGENT_TEMP_DRAFT_TTL)
        return false;
      await this.releaseDraftFiles(meta, token);
      await this.unlinkMissing(this.draftPath(token));
      key = String(meta.tmp_key || "");
      return true;
    });
    if (!expired) return null;
    if (AGENT_DRAFT_KEY_RE.test(key)) await this.dirs.safeRemoveTempKey(key);
    await this.removeLock(token);
    return key;
  }

  /** Expire idle drafts and return the number of retired temp keys. */
  async expireAttachmentDrafts(now = this.now()): Promise<number> {
    let tokens: string[];
    try {
      tokens = (await readdir(this.draftsDir))
        .filter(
          (name) => name.endsWith(".json") && TOKEN_RE.test(name.slice(0, -5)),
        )
        .map((name) => name.slice(0, -5))
        .sort();
    } catch {
      return 0;
    }
    let expired = 0;
    for (const token of tokens) {
      try {
        if ((await this.expireDraftToken(token, now)) !== null) expired++;
      } catch (error) {
        if (
          !isOSError(error) &&
          !isValueError(error) &&
          !(error instanceof AttachmentError) &&
          !(error instanceof TreeLifecycleBusy)
        )
          throw error;
      }
    }
    return expired;
  }

  /** Draft metas keyed by staging tmp_key (agent_temp's live-owner scan). */
  async draftMetas(): Promise<Map<string, [string, DraftMeta]>> {
    const out = new Map<string, [string, DraftMeta]>();
    let names: string[];
    try {
      names = await readdir(this.draftsDir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const token = name.slice(0, -5);
      if (!TOKEN_RE.test(token)) continue;
      const meta = await this.readMeta(token);
      if (meta && typeof meta.tmp_key === "string")
        out.set(meta.tmp_key, [join(this.draftsDir, name), meta]);
    }
    return out;
  }

  /** Finish recovery markers: transfer to a live conversation, else abandon. */
  async finishRollingBackDrafts(): Promise<void> {
    for (const [, [, meta]] of await this.draftMetas()) {
      if (meta.state !== "rolling_back") continue;
      const token = String(meta.id);
      const agent = meta.agent;
      const conv =
        typeof agent === "string" ? this.conversations.load(agent) : null;
      try {
        if (conv) {
          conv.attachment_draft = token;
          await this.transferDraft(token, conv, true);
        } else {
          await this.withLocked(token, async () => {
            const live = await this.readMeta(token);
            if (!live || live.state !== "rolling_back") return;
            await this.releaseDraftFiles(live, token);
            await this.unlinkMissing(this.draftPath(token));
            const key = String(live.tmp_key || "");
            if (AGENT_DRAFT_KEY_RE.test(key))
              await this.dirs.safeRemoveTempKey(key);
            await this.removeLock(token);
          });
        }
      } catch (error) {
        if (
          !isOSError(error) &&
          !isValueError(error) &&
          !(error instanceof AttachmentError)
        )
          throw error;
      }
    }
  }
}
