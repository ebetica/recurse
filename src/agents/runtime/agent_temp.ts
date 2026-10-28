// Private 0700 scratch and files share a persisted nonce, not replayable ids.
// The scope hashes DATA_DIR; startup keeps live scratch until deletion.
// RECURSE_TEMP_IN_DATA_DIR=1 survives container loss; TMPDIR stays local.
// Startup migrates uploads before orphan sweeps; collection flock is async.
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  AGENT_DRAFT_KEY_RE,
  AGENT_TEMP_KEY_RE,
  type Config,
} from "../../config";
import * as runtimeLogging from "../../observability/runtime_logging";
import * as startupMetrics from "../../observability/startup_metrics";
import { flockExclusive } from "../../utils/flock";
import * as trash from "../../utils/trash";
import { sweepTrash } from "../../utils/trash_sweep";
import type {
  ConversationRecord,
  ConversationStore,
} from "../conversation_store";
import type { AttachmentDrafts, DraftDirs } from "./attachment_drafts";
import { AttachmentError, type Manifest } from "./attachments/base";
import * as publish from "./attachments/publish";
import * as store from "./attachments/store";

const TEMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

class TempValueError extends Error {
  override name = "ValueError";
}
class TempRuntimeError extends Error {
  override name = "RuntimeError";
}
class TempKeyError extends Error {
  override name = "KeyError";
  constructor(message: string) {
    super(`'${message}'`);
  }
}

const ownedKey = (key: string): boolean =>
  AGENT_TEMP_KEY_RE.test(key) || AGENT_DRAFT_KEY_RE.test(key);
const isSystemError = (error: unknown): boolean =>
  error instanceof Error && "code" in error;

async function lexists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}
async function migrationExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function listNames(path: string): Promise<string[] | null> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isSystemError(error)) return null;
    throw error;
  }
}
function retireOrFalse(path: string, root: string): boolean {
  try {
    return trash.retire(path, root);
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}
type Conversations = Pick<
  ConversationStore,
  | "load"
  | "save"
  | "allConvs"
  | "convRowExists"
  | "withTitleGuard"
  | "withMuteGuard"
  | "withPermanentDeleteStateGuard"
>;

export interface AgentTempDeps {
  conversations: Conversations;
  logger: runtimeLogging.RuntimeLogger;
  /** agent_nodes.owner_admits: whether the owner still admits file writes. */
  ownerAdmits(cid: string): boolean;
  /** node_files.collection_snapshot(conv) !== None. */
  hasCollection(conv: ConversationRecord): boolean;
  /** Leaf names of the prompt snapshot/transport/captured-system sidecars. */
  promptSidecarNames(conv: ConversationRecord): Iterable<string>;
  /** reap_history.expire and deleted_bin.expire, run before each drain. */
  expireRetained(): void | Promise<void>;
  /** Unix seconds for the day stamp. */
  now?: () => number;
  /** 16 lowercase hex characters per call. */
  nonce?: () => string;
  /** 32-hex upload ids forwarded to publication (fixtures pin them). */
  ids?: () => string;
  /** Monotonic seconds for the drain cadence. */
  monotonic?: () => number;
}

export const TRASH_DRAIN_INTERVAL = 30.0;

/** Scratch lifecycle for one instance; also the draft lifecycle's DraftDirs. */
export class AgentTemp implements DraftDirs {
  private drafts: AttachmentDrafts | null = null;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly monotonic: () => number;
  private drainRunning = false;
  private lastDrain = 0;
  private drainDue = false;

  constructor(
    readonly config: Config,
    private readonly deps: AgentTempDeps,
  ) {
    this.now = deps.now ?? (() => Date.now() / 1000);
    this.nonce =
      deps.nonce ?? (() => randomUUID().replaceAll("-", "").slice(0, 16));
    this.monotonic = deps.monotonic ?? (() => performance.now() / 1000);
  }

  attachDrafts(drafts: AttachmentDrafts): void {
    this.drafts = drafts;
  }
  private get draftLifecycle(): AttachmentDrafts {
    if (!this.drafts) throw new Error("attachment drafts not attached");
    return this.drafts;
  }
  private get paths() {
    return this.config.paths;
  }

  /** UTC day stamp scoping one temp directory generation. */
  utcDay(ts?: number): string {
    return new Date((ts ?? this.now()) * 1000)
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "");
  }

  /** Mint a fresh temp key for one conversation (no directory yet). */
  async newAgentTempKey(cid: string): Promise<string> {
    if (!TEMP_ID_RE.test(cid)) throw new TempValueError("unsafe agent id");
    const day = this.utcDay();
    // Invariant: The nonce distinguishes same-day reuse and prevents a replayed
    // id from adopting a stale directory left after metadata was removed.
    const names = new Set([
      ...((await listNames(this.paths.AGENT_TEMP_INSTANCE_DIR)) ?? []),
      ...((await listNames(this.paths.AGENT_FILES_DIR)) ?? []),
    ]);
    for (let attempt = 0; attempt < 10; attempt++) {
      const key = `${day}-${this.nonce()}`;
      if (names.has(key) || names.has(this.config.agentTempLeaf(key))) continue;
      const path = join(
        this.paths.AGENT_TEMP_INSTANCE_DIR,
        this.config.agentTempLeaf(key),
      );
      if (
        this.paths.AGENT_TEMP_USES_SHORT_DEFAULT &&
        Buffer.byteLength(path) > this.paths.AGENT_TEMP_PATH_MAX_BYTES
      )
        throw new TempRuntimeError(
          `default agent temp path exceeds ` +
            `${this.paths.AGENT_TEMP_PATH_MAX_BYTES}-byte socket-safe budget: ${path}`,
        );
      return key;
    }
    throw new TempRuntimeError("could not allocate private agent storage");
  }

  /** Mint one pool-reserved scratch key and ensure its directory. */
  async newPoolScratch(owner: string): Promise<[string, string]> {
    const key = await this.newAgentTempKey(owner);
    const scope = await this.ensureScope(
      this.paths.AGENT_TEMP_ROOT,
      this.paths.AGENT_TEMP_INSTANCE_DIR,
    );
    return [key, await this.ensureKeyDir(scope, this.tempLeaf(key))];
  }

  private tempLeaf(key: string): string {
    if (!ownedKey(key))
      throw new TempValueError("unsafe temporary-directory key");
    return this.config.agentTempLeaf(key);
  }

  /** A conversation's persisted effective-cwd file, not created. */
  workdirFile(tempKey: string): string {
    if (!AGENT_TEMP_KEY_RE.test(tempKey))
      throw new TempValueError("unsafe temporary-directory key");
    return join(
      this.paths.AGENT_TEMP_INSTANCE_DIR,
      this.tempLeaf(tempKey),
      "workdir.json",
    );
  }

  // Create a temp root and its instance scope, both 0700; parents keep modes.
  private async ensureScope(root: string, scope: string): Promise<string> {
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700);
    await mkdirExistOk(scope);
    await chmod(scope, 0o700);
    return scope;
  }

  private async ensureKeyDir(scope: string, name: string): Promise<string> {
    if (!ownedKey(name))
      throw new TempValueError("unsafe temporary-directory key");
    const path = join(scope, name);
    await mkdirExistOk(path);
    await chmod(path, 0o700);
    return path;
  }

  /** This conversation's immutable private temp dir, recreated when missing. */
  async ensureAgentTemp(
    conv: ConversationRecord,
    options: { persist?: boolean } = {},
  ): Promise<string> {
    let key = conv.tmp_key;
    if (typeof key !== "string" || !AGENT_TEMP_KEY_RE.test(key)) {
      const cid = String(conv.id);
      const convs = this.deps.conversations;
      if ((options.persist ?? true) && convs.convRowExists(cid)) {
        // Invariant: Serialize a legacy row's one-time key assignment under
        // title→mute. withMuteGuard takes only its own mute token; the title
        // token is for the nested save.
        key = await convs.withTitleGuard(cid, (title) =>
          convs.withMuteGuard(cid, async () => {
            const current = convs.load(cid, { withPending: false });
            const currentKey = current?.tmp_key;
            if (
              typeof currentKey === "string" &&
              AGENT_TEMP_KEY_RE.test(currentKey)
            )
              return currentKey;
            const fresh = await this.newAgentTempKey(cid);
            if (current) {
              current.tmp_key = fresh;
              await convs.save(current, title);
            }
            return fresh;
          }),
        );
      } else key = await this.newAgentTempKey(cid);
      conv.tmp_key = key;
    }
    const scope = await this.ensureScope(
      this.paths.AGENT_TEMP_ROOT,
      this.paths.AGENT_TEMP_INSTANCE_DIR,
    );
    return this.ensureKeyDir(scope, this.tempLeaf(key as string));
  }

  /** Concrete prompt/env path; narrowly Recurse-owned unlike TMPDIR. */
  agentTempPath(conv: ConversationRecord): Promise<string> {
    return this.ensureAgentTemp(conv);
  }

  /** One owner's persistent uploads directory (conversation or draft key). */
  uploadsDir(tempKey: string): string {
    if (!ownedKey(tempKey)) throw new TempValueError("unsafe temp key");
    return join(this.paths.AGENT_FILES_DIR, this.tempLeaf(tempKey), "uploads");
  }

  /** Create one owner's uploads directory before any publish may use it. */
  async ensureUploadsDir(tempKey: string): Promise<string> {
    const scope = await this.ensureScope(
      this.paths.DATA_DIR,
      this.paths.AGENT_FILES_DIR,
    );
    const leaf = await this.ensureKeyDir(scope, this.tempLeaf(tempKey));
    const uploads = join(leaf, "uploads");
    await mkdirExistOk(uploads);
    await chmod(uploads, 0o700);
    return this.uploadsDir(tempKey);
  }

  /** Admit uploads under the delete-state guard; KeyError once fenced. */
  admitUploadsDir(cid: string, tempKey: string): Promise<string> {
    return this.deps.conversations.withPermanentDeleteStateGuard(
      cid,
      async () => {
        if (!this.deps.ownerAdmits(cid))
          throw new TempKeyError("attachment owner not found");
        return this.ensureUploadsDir(tempKey);
      },
    );
  }

  // Resolve one live conversation and store an upload; fails closed after reap.
  async addConversationUpload(
    cid: string,
    data: Uint8Array,
    filename: string,
    options: { now?: number } = {},
  ): Promise<Manifest> {
    const conv = this.deps.conversations.load(cid);
    if (!conv || !this.deps.hasCollection(conv))
      throw new TempKeyError("attachment owner not found");
    const collection = await this.admitUploadsDir(cid, String(conv.tmp_key));
    return publish.addUpload(collection, cid, data, filename, {
      ...(this.deps.ids === undefined ? {} : { ids: this.deps.ids }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** Fast local scratch and generated files Pi may read while idle. */
  async agentRuntimePath(conv: ConversationRecord): Promise<string> {
    const scratch = await this.ensureAgentTemp(conv);
    if (
      this.paths.AGENT_RUNTIME_INSTANCE_DIR ===
      this.paths.AGENT_TEMP_INSTANCE_DIR
    )
      return scratch;
    const scope = await this.ensureScope(
      this.paths.AGENT_RUNTIME_ROOT,
      this.paths.AGENT_RUNTIME_INSTANCE_DIR,
    );
    return this.ensureKeyDir(scope, String(conv.tmp_key));
  }

  private async retireName(
    scope: string,
    trashDir: string,
    name: string,
  ): Promise<boolean> {
    if (!(await pathExists(scope))) return true;
    return retireOrFalse(join(scope, name), trashDir);
  }

  /** Retire files and scratch for bounded background reclamation. */
  async safeRemoveTempKey(key: string): Promise<boolean> {
    if (!ownedKey(key)) return false;
    const files = await this.retireName(
      this.paths.AGENT_FILES_DIR,
      this.paths.TRASH_DIR,
      this.tempLeaf(key),
    );
    const scratch = await this.retireName(
      this.paths.AGENT_TEMP_INSTANCE_DIR,
      this.paths.AGENT_TEMP_TRASH_DIR,
      this.tempLeaf(key),
    );
    const runtime = await this.safeRemoveRuntimeKey(key);
    return files && scratch && runtime;
  }

  private async safeRemoveRuntimeKey(key: string): Promise<boolean> {
    if (
      this.paths.AGENT_RUNTIME_INSTANCE_DIR ===
      this.paths.AGENT_TEMP_INSTANCE_DIR
    )
      return true;
    if (!ownedKey(key)) return false;
    return this.retireName(
      this.paths.AGENT_RUNTIME_INSTANCE_DIR,
      this.paths.AGENT_RUNTIME_TRASH_DIR,
      key,
    );
  }

  cleanupAgentTemp(cid: string, tempKey: unknown): Promise<void> {
    return this.cleanupAgentTemps([[cid, tempKey]]);
  }

  /** Release reaped owners; delayed cleanup matches immutable temp keys. */
  async cleanupAgentTemps(owners: Array<[string, unknown]>): Promise<void> {
    for (const [cid, tempKey] of owners) {
      if (typeof tempKey !== "string") continue;
      await this.retireCollectionUsage(cid, tempKey);
      await this.safeRemoveTempKey(tempKey);
    }
  }

  /** Retire one file collection key and verify the leaf is gone. */
  private async renameTempKeyVerified(tempKey: string): Promise<boolean> {
    const retired = await this.retireName(
      this.paths.AGENT_FILES_DIR,
      this.paths.TRASH_DIR,
      this.tempLeaf(tempKey),
    );
    const gone = !(await lexists(
      join(this.paths.AGENT_FILES_DIR, this.tempLeaf(tempKey)),
    ));
    return retired && gone;
  }

  // Retire the collection before its database under the member delete guard.
  // Only verified absence/rename succeeds; uncertainty parks with a reason.
  async retireMemberCollection(
    cid: string,
    tempKey: string,
  ): Promise<[boolean, string | null]> {
    let collection: string;
    try {
      collection = this.uploadsDir(tempKey);
    } catch (error) {
      if (error instanceof TempValueError) return [true, null];
      throw error;
    }
    if (!(await lexists(collection))) return [true, null];
    let owner;
    try {
      owner = await store.openCollection(collection);
    } catch (error) {
      if (error instanceof AttachmentError)
        return [false, `file collection unavailable: ${error.message}`];
      throw error;
    }
    try {
      return await this.retireOpenedCollection(cid, tempKey, collection, owner);
    } finally {
      await owner.close();
    }
  }

  private async retireOpenedCollection(
    _cid: string,
    tempKey: string,
    collection: string,
    owner: Awaited<ReturnType<typeof store.openCollection>>,
  ): Promise<[boolean, string | null]> {
    let unlock: () => void;
    try {
      unlock = await flockExclusive(owner.fd, collection, {
        timeoutMs: 0,
        log: () => {},
      });
    } catch {
      return [false, "file collection busy"];
    }
    try {
      if (!(await store.collectionIdentityMatches(collection, owner)))
        return [false, "file collection replaced during retirement"];
      let verified: boolean;
      try {
        verified = await this.renameTempKeyVerified(tempKey);
      } catch (error) {
        if (isSystemError(error) || error instanceof TempValueError)
          return [
            false,
            `file directory retirement failed: ${(error as Error).message}`,
          ];
        throw error;
      }
      if (!verified) return [false, "file directory retirement unverified"];
    } finally {
      try {
        unlock();
      } catch {}
    }
    return [true, null];
  }

  /** Retire a reaped owner's collection exactly once; never raises. */
  private async retireCollectionUsage(
    _cid: string,
    tempKey: string,
  ): Promise<void> {
    try {
      if (!(await this.renameTempKeyVerified(tempKey)))
        this.deps.logger.warning("reaped file directory retirement unverified");
    } catch (error) {
      if (isSystemError(error) || error instanceof TempValueError) {
        this.deps.logger.warning("reaped file directory retirement failed");
        return;
      }
      throw error;
    }
  }

  /** Every scope name a live owner may hold, raw and leaf-mapped. */
  private async liveLeafNames(
    conversations: ConversationRecord[],
  ): Promise<Set<string>> {
    const live = new Set<string>();
    const add = (key: string) => {
      live.add(key);
      live.add(this.config.agentTempLeaf(key));
    };
    for (const conv of conversations)
      if (typeof conv.tmp_key === "string") add(conv.tmp_key);
    for (const key of (await this.draftLifecycle.draftMetas()).keys()) add(key);
    return live;
  }

  private async sweepScope(
    scope: string,
    trashDir: string,
    live: Set<string>,
  ): Promise<[number, number]> {
    const names = await listNames(scope);
    if (names === null) return [0, 0];
    startupMetrics.count("temp_entries_scanned", names.length);
    let removed = 0;
    for (const name of names) {
      if (name === this.paths.AGENT_TEMP_TRASH_NAME || live.has(name)) continue;
      if (retireOrFalse(join(scope, name), trashDir)) removed += 1;
    }
    return [names.length, removed];
  }

  /** Retire temp entries and sidecars no live conversation owns. */
  async pruneAgentTempStartup(): Promise<number> {
    const conversations = this.deps.conversations.allConvs({
      withPending: false,
    });
    const live = await this.liveLeafNames(conversations);
    let [scanned, removed] = await this.sweepScope(
      this.paths.AGENT_FILES_DIR,
      this.paths.TRASH_DIR,
      live,
    );
    const [scratchScanned, scratchRemoved] = await this.sweepScope(
      this.paths.AGENT_TEMP_INSTANCE_DIR,
      this.paths.AGENT_TEMP_TRASH_DIR,
      live,
    );
    scanned += scratchScanned;
    removed += scratchRemoved;
    if (
      this.paths.AGENT_RUNTIME_INSTANCE_DIR !==
      this.paths.AGENT_TEMP_INSTANCE_DIR
    ) {
      const [s, r] = await this.sweepScope(
        this.paths.AGENT_RUNTIME_INSTANCE_DIR,
        this.paths.AGENT_RUNTIME_TRASH_DIR,
        live,
      );
      scanned += s;
      removed += r;
    }
    const sidecars =
      (await this.sweepLockSidecars(conversations)) +
      (await this.sweepPromptSidecars(conversations));
    runtimeLogging.logEvent(
      this.deps.logger,
      runtimeLogging.INFO,
      "agent_temp_startup_sweep",
      {
        fields: {
          conversations: conversations.length,
          scanned,
          retired: removed,
          retired_sidecars: sidecars,
        },
      },
    );
    return removed + sidecars;
  }

  private async sweepLockSidecars(
    conversations: ConversationRecord[],
  ): Promise<number> {
    const live = new Set(
      conversations.flatMap((c) => (typeof c.id === "string" ? [c.id] : [])),
    );
    let removed = 0;
    for (const directory of [
      this.paths.MUTE_LOCK_DIR,
      this.paths.TITLE_LOCK_DIR,
    ]) {
      for (const name of (await listNames(directory)) ?? []) {
        if (!name.endsWith(".lock")) continue;
        const cid = name.slice(0, -5);
        if (TEMP_ID_RE.test(cid) && !live.has(cid))
          removed += +retireOrFalse(
            join(directory, name),
            this.paths.TRASH_DIR,
          );
      }
    }
    return removed;
  }

  private async sweepPromptSidecars(
    conversations: ConversationRecord[],
  ): Promise<number> {
    const keep = new Set<string>();
    for (const conv of conversations)
      for (const name of this.deps.promptSidecarNames(conv)) keep.add(name);
    const names = await listNames(this.paths.TURN_PROMPT_DIR);
    if (names === null) return 0;
    let removed = 0;
    for (const name of names)
      if (
        !keep.has(name) &&
        !(name.startsWith("static-") && name.endsWith(".rpc.txt"))
      )
        removed += +retireOrFalse(
          join(this.paths.TURN_PROMPT_DIR, name),
          this.paths.TRASH_DIR,
        );
    return removed;
  }

  /** Move surviving legacy collections once, before any startup file writes. */
  async migrateUploads(): Promise<void> {
    const marker = join(this.paths.DATA_DIR, ".agent-files-v1");
    if (await migrationExists(marker)) return;
    const live = await this.liveLeafNames(this.deps.conversations.allConvs());
    await this.ensureScope(this.paths.DATA_DIR, this.paths.AGENT_FILES_DIR);
    for (const leaf of live) {
      if (!ownedKey(leaf)) continue;
      const source = join(this.paths.AGENT_TEMP_INSTANCE_DIR, leaf, "uploads");
      if (!(await migrationExists(source))) continue;
      const destination = join(this.paths.AGENT_FILES_DIR, leaf, "uploads");
      const completed = ".legacy-migration-complete";
      if (await migrationExists(destination)) {
        if (!(await migrationExists(join(destination, completed))))
          throw new Error(
            `legacy uploads conflict with persistent files: ${leaf}`,
          );
      } else {
        await this.ensureKeyDir(this.paths.AGENT_FILES_DIR, leaf);
        try {
          await rename(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          const staging = join(this.paths.AGENT_FILES_DIR, `.migrate-${leaf}`);
          trash.retire(staging, this.paths.TRASH_DIR);
          await cp(source, staging, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
          await writeFile(join(staging, completed), "1\n", { mode: 0o600 });
          await rename(staging, destination);
        }
      }
      trash.retire(source, this.paths.AGENT_TEMP_TRASH_DIR);
    }
    await writeFile(marker, "1\n", { mode: 0o600 });
  }

  // Repair live scratch; optionally retire unowned entries and expire drafts.
  async reconcileAgentTempStartup(
    options: { sweepOrphans?: boolean } = {},
  ): Promise<void> {
    const drafts = this.draftLifecycle;
    await this.migrateUploads();
    await drafts.finishRollingBackDrafts();
    for (const conv of this.deps.conversations.allConvs()) {
      startupMetrics.count("conversations_reconciled");
      const token = conv.attachment_draft;
      if (typeof token === "string")
        await drafts.transferAttachmentDraft(token, conv);
      await this.ensureAgentTemp(conv);
      try {
        await this.ensureUploadsDir(String(conv.tmp_key || ""));
      } catch (error) {
        if (error instanceof TempValueError) continue;
        throw error;
      }
    }
    if (!(options.sweepOrphans ?? true)) return;
    await this.pruneAgentTempStartup();
    await drafts.expireAttachmentDrafts();
  }

  /** A retirement landed: the next tick drains without waiting the interval. */
  markTrashDrainDue(): void {
    this.drainDue = true;
  }

  /** Reclaim a bounded batch of retired trees; single-flight and cadenced. */
  async drainTrash(
    options: { limit?: number; force?: boolean } = {},
  ): Promise<void> {
    if (this.drainRunning) return;
    if (
      !options.force &&
      !this.drainDue &&
      this.monotonic() - this.lastDrain < TRASH_DRAIN_INTERVAL
    )
      return;
    this.drainRunning = true;
    try {
      // Invariant: Expire first so a freed partition is reclaimed by this same
      // pass.
      await this.deps.expireRetained();
      const bound = options.limit ?? this.paths.TRASH_SWEEP_LIMIT;
      const started = this.monotonic();
      const removed = await sweepTrash(
        [
          this.paths.TRASH_DIR,
          this.paths.AGENT_TEMP_TRASH_DIR,
          this.paths.AGENT_RUNTIME_TRASH_DIR,
          this.paths.AGENT_STORE_TRASH_DIR,
        ],
        bound,
      );
      runtimeLogging.logEvent(
        this.deps.logger,
        runtimeLogging.INFO,
        "trash_drain",
        {
          fields: {
            retired: removed.reduce((sum, count) => sum + count, 0),
            elapsed_ms: Math.round((this.monotonic() - started) * 1000),
            limit_per_root: bound,
          },
        },
      );
    } finally {
      this.lastDrain = this.monotonic();
      this.drainDue = false;
      this.drainRunning = false;
    }
  }
}

async function mkdirExistOk(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await stat(path)).isDirectory()) throw error;
  }
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isSystemError(error)) return false;
    throw error;
  }
}
