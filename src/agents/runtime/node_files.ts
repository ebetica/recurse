// Per-node collection identity and file-operation leases. Reap joins admitted
// file work before database retirement; counters mutate without awaiting.
import { join } from "node:path";
import {
  AGENT_DRAFT_KEY_RE,
  AGENT_TEMP_KEY_RE,
  type Config,
} from "../../config";
import {
  WARNING,
  logEvent,
  type RuntimeLogger,
} from "../../observability/runtime_logging";
import { AsyncEvent, TimeoutError, withTimeout } from "../../utils/tasks";

export interface CollectionSnapshot {
  readonly collection: string;
  readonly owner: string;
  readonly temp_key: string;
}

/** Recorded collection identity for the supplied record, or null. */
export function collectionSnapshot(
  conv: Readonly<Record<string, unknown>>,
  config: Pick<Config, "agentTempLeaf" | "paths">,
): CollectionSnapshot | null {
  const cid = conv.id;
  const key = conv.tmp_key;
  if (typeof cid !== "string" || !cid) return null;
  if (
    typeof key !== "string" ||
    !(AGENT_TEMP_KEY_RE.test(key) || AGENT_DRAFT_KEY_RE.test(key))
  )
    return null;
  return Object.freeze({
    collection: join(
      config.paths.AGENT_FILES_DIR,
      config.agentTempLeaf(key),
      "uploads",
    ),
    owner: cid,
    temp_key: key,
  });
}

const pyTruthy = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : typeof value === "object" && value !== null
      ? Object.keys(value).length > 0
      : Boolean(value);

/** File-operation drain bound in seconds; matches the store-close bound. */
export const FILE_DRAIN_TIMEOUT = 10.0;

export interface FileLeasesDeps {
  /** conversation_store.load(cid, with_pending=False). */
  load(cid: string): Record<string, unknown> | null;
  log: RuntimeLogger;
  drainTimeoutSeconds?: number;
}

/** Admitted file-operation leases for one node. */
export class FileLeases {
  private leases = 0;
  private drained: AsyncEvent | null = null;

  constructor(
    private readonly cid: string,
    private readonly deps: FileLeasesDeps,
  ) {}

  /** Await-free: admit one file operation against this owner. */
  tryAdmit(admissible: boolean): boolean {
    if (!admissible) return false;
    const doomed = this.deps.load(this.cid);
    if (doomed !== null && pyTruthy(doomed.reap_deferred)) return false;
    this.leases += 1;
    if (this.drained === null) this.drained = new AsyncEvent();
    else this.drained.clear();
    return true;
  }

  /** Release one admitted file operation. */
  release(): void {
    if (this.leases > 0) this.leases -= 1;
    else
      logEvent(this.deps.log, WARNING, "file_lease_without_admission", {
        conversation_id: this.cid,
      });
    if (this.leases === 0 && this.drained !== null) this.drained.set();
  }

  /** Reap step: join admitted file operations, or park after the bound. */
  async drain(signal?: AbortSignal): Promise<[boolean, string | null]> {
    const seconds = this.deps.drainTimeoutSeconds ?? FILE_DRAIN_TIMEOUT;
    for (;;) {
      if (this.leases === 0 || this.drained === null) return [true, null];
      const event = this.drained;
      try {
        await withTimeout((inner) => event.wait(inner), seconds * 1000, signal);
      } catch (error) {
        if (error instanceof TimeoutError)
          return [false, "file operations would not quiesce"];
        throw error;
      }
    }
  }
}
