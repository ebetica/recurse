// Revive settles passive before note/index publication; crashes can retry.
// Reap IDs must be absent; clear/import use new IDs. Failed create rolls back.
// Foreign process ownership is dropped; safety resets on for imported stores.
// TaskSet work outlives HTTP; concurrent revives share it.
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  isDirectory,
  moveStore,
  type AgentArchive,
  type ArchivedAgent,
} from "../durable/archive";
import type { ReviveState } from "../durable/revive_doc";
import type { TaskSet } from "../../utils/tasks";
import type { ConversationRecord } from "../conversation_store";
import type { CreateOptions } from "./create";
import type { SupervisorDelivery } from "./delivery";

/** A revive the caller can act on: `status` is its HTTP status. */
export class ReviveRefused extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly candidates: ArchivedAgent[] = [],
  ) {
    super(message);
  }
}

export interface ReviveDeps {
  archive: Pick<AgentArchive, "root" | "get" | "search" | "markRevived"> &
    Partial<Pick<AgentArchive, "hold">>;
  importFrom?(path: string): Promise<ArchivedAgent>;
  /** conversations/<cid>/durable. */
  storageDir(cid: string): string;
  load(cid: string): ConversationRecord | null;
  create(options: CreateOptions): Promise<ConversationRecord>;
  /** Initial foreign open drops protected env; later operator edits survive. */
  revived(cid: string): Promise<ReviveState | undefined>;
  deliver: SupervisorDelivery["deliver"];
  /** Log an event, at INFO unless `warning`. */
  log(event: string, fields: Record<string, unknown>, warning?: boolean): void;
  tasks: TaskSet;
}

const CANDIDATES = 10;
type Revived = Record<string, unknown>;

export class SupervisorRevive {
  private readonly inFlight = new Map<string, Promise<Revived>>();

  constructor(private readonly deps: ReviveDeps) {}

  // An archive id, an agent id, or a fuzzy query naming exactly one archive.
  async resolve(target: string): Promise<ArchivedAgent> {
    const exact = await this.deps.archive.get(target);
    if (exact !== null) return exact;
    const found = await this.deps.archive.search(target, 0, CANDIDATES + 1);
    if (found.length === 1) return found[0]!;
    if (!found.length)
      throw new ReviveRefused(`No archived agent matches '${target}'.`, 404);
    throw new ReviveRefused(
      `'${target}' matches several archived agents; pass an id.`,
      409,
      found.slice(0, CANDIDATES),
    );
  }

  /** Revive one archive under `parent` (null: top level). */
  async revive(target: string, parent: string | null) {
    const entry = await this.resolve(target);
    let work = this.inFlight.get(entry.archive_id);
    // Invariant: The TaskSet owns the work, so a caller that leaves never
    // cancels it.
    if (work === undefined) {
      const release = this.deps.archive.hold?.(entry.archive_id);
      work = this.reviveOnce(entry, parent).finally(() => release?.());
      this.inFlight.set(entry.archive_id, work);
      const done = work.catch(() => undefined);
      void this.deps.tasks.spawn(`revive:${entry.archive_id}`, () => done);
      void done.then(() => this.inFlight.delete(entry.archive_id));
    }
    return work;
  }

  // Copy an external source to this archive; every call gets a new identity.
  async reviveFrom(path: string, parent: string | null) {
    const work = (async () => {
      if (!this.deps.importFrom)
        throw new ReviveRefused("Path revive is unavailable.", 422);
      const entry = await this.deps.importFrom(path);
      const release = this.deps.archive.hold?.(entry.archive_id);
      try {
        return await this.reviveOnce(entry, parent);
      } finally {
        release?.();
      }
    })();
    void this.deps.tasks.spawn("revive-from-path", () =>
      work.catch(() => undefined),
    );
    return work;
  }

  private async reviveOnce(
    entry: ArchivedAgent,
    parent: string | null,
  ): Promise<Revived> {
    const { archive, load } = this.deps;
    if (entry.revived_as)
      throw new ReviveRefused(
        `Archive ${entry.archive_id} was already revived as ${entry.revived_as}.`,
      );
    const cid =
      entry.reason === "reap" || entry.reason === "import"
        ? entry.cid
        : createHash("sha256")
            .update(entry.archive_id)
            .digest("hex")
            .slice(0, 12);
    const notes: string[] = [];
    let conv = load(cid);
    if (conv !== null && conv.revived_from !== entry.archive_id)
      throw new ReviveRefused(
        entry.reason === "reap"
          ? `Agent ${cid} still exists (its deletion has not finished); try again shortly.`
          : `Agent id ${cid} is taken.`,
      );
    if (conv === null) {
      const from = join(archive.root, entry.archive_id);
      conv = await this.restoreAndCreate(from, entry, cid, parent, notes);
    }
    // Invariant: The archive counts as revived only once the store settled and
    // the note is in; a failure or crash before then leaves it to retry (both
    // steps run once: recurse.revive and the note's message id).
    await this.note(entry, conv, notes);
    await archive.markRevived(entry.archive_id, cid);
    this.deps.log("agent_revived", { cid, archive_id: entry.archive_id });
    const { title = null, parent: up = null, workdir = null } = conv;
    const { archive_id, reason } = entry;
    return { id: cid, title, parent: up, workdir, archive_id, reason, notes };
  }

  /**
   * Move the store in directory `from` (any store directory, not only an
   * indexed archive) to conversations/<cid> and create its record from `entry`.
   */
  private async restoreAndCreate(
    from: string,
    entry: ArchivedAgent,
    cid: string,
    parent: string | null,
    notes: string[],
  ): Promise<ConversationRecord> {
    const dir = this.deps.storageDir(cid);
    if (!(await moveStore(from, dir)))
      throw new ReviveRefused(
        `The archived history of ${entry.archive_id} is missing.`,
        410,
      );
    const keepDir =
      entry.workdir !== null && (await isDirectory(entry.workdir));
    const parentDir =
      !keepDir && parent !== null ? this.deps.load(parent)?.workdir : null;
    const fallbackDir =
      typeof parentDir === "string" && (await isDirectory(parentDir))
        ? parentDir
        : null;
    const base: CreateOptions = {
      cid,
      title:
        entry.reason === "clear"
          ? `${entry.title ?? entry.cid} (before clear)`
          : entry.title,
      parent,
      revivedFrom: entry.archive_id,
      workdir: keepDir ? entry.workdir : fallbackDir,
    };
    const model: CreateOptions =
      entry.level !== null
        ? { level: entry.level }
        : { model: entry.model, effort: entry.effort };
    try {
      let conv: ConversationRecord;
      try {
        conv = await this.deps.create({ ...base, ...model });
      } catch (error) {
        if (!/^unsupported /.test((error as Error).message)) throw error;
        conv = await this.deps.create(base);
        notes.push(
          `Its model (${entry.model ?? `level ${entry.level}`}) is no longer available; it now uses ${String(conv.model)}.`,
        );
      }
      if (
        entry.reason === "import" &&
        entry.model !== null &&
        entry.model !== conv.model &&
        !notes.some((note) => note.includes("no longer available"))
      )
        notes.push(
          `Its model (${entry.model}) is no longer available; it now uses ${String(conv.model)}.`,
        );
      if (!keepDir && entry.workdir !== null)
        notes.push(
          `Its working directory ${entry.workdir} no longer exists; it now starts in ${String(conv.workdir)}.`,
        );
      return conv;
    } catch (error) {
      await moveStore(dir, from).catch((undo: unknown) =>
        this.deps.log(
          "agent_revive_undo_failed",
          { cid, error: String(undo) },
          true,
        ),
      );
      throw error;
    }
  }

  /** The platform note; delivered once per archive (its message id). */
  private async note(
    entry: ArchivedAgent,
    conv: ConversationRecord,
    notes: string[],
  ): Promise<void> {
    const cid = String(conv.id);
    const state = await this.deps.revived(cid);
    if (state?.oldCwd)
      notes.push(
        `Its working directory ${state.oldCwd} no longer exists; it is now ${String(conv.workdir)}.`,
      );
    const when = new Date(entry.archived * 1000).toISOString();
    const how =
      entry.reason === "import"
        ? `copied from ${entry.origin_path}`
        : entry.reason === "clear"
          ? `cleared (${entry.cid})`
          : "deleted";
    const lines = [
      `Revived from the agent archive: this conversation was ${how} at ${when}. Its history is restored; it starts no turn until it gets a message.`,
      ...notes,
    ];
    const queued = state?.queued ?? [];
    if (queued.length)
      lines.push(
        "Input still queued when it was archived was not run; verbatim:",
        ...queued.map((text) => `---\n${text}`),
        "---",
      );
    const delivered = await this.deps.deliver(cid, lines.join("\n"), {
      source: "platform",
      origin: "platform",
      messageId: `revive-${entry.archive_id}`,
      nextTurnOnly: true,
    });
    if (delivered === null) throw new Error(`${cid} refused its revive note`);
  }
}
