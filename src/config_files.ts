// Server settings reads return loaded snapshots and refresh off-thread.
// Zero-window standalone reads stay synchronous. Async mutations serialize per
// file and publish snapshots only after atomic, private-mode disk replacement.
// Older reads cannot undo own writes; close aborts reads and drains writes.
import { randomUUID } from "node:crypto";
import { slowSpan } from "./observability/slow-span";
import fs from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pyCompactJson } from "./utils/python-json";

type Snapshot = {
  text: string | undefined;
  value: unknown;
  checkedAt: number;
  revision: number;
};

function parsed(text: string | undefined): unknown {
  try {
    return text === undefined
      ? undefined
      : slowSpan("settings_json_decode", undefined, () => JSON.parse(text));
  } catch {
    return undefined;
  }
}

export class ConfigFiles {
  private readonly files = new Map<string, Snapshot>();
  private readonly synchronousVersions = new Map<
    string,
    Pick<Snapshot, "text" | "revision">
  >();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly controller = new AbortController();

  constructor(
    private readonly recheckMs: number,
    private readonly now: () => number,
    private readonly changed: (path: string) => void,
  ) {}

  private snapshot(path: string): Snapshot {
    if (!(this.recheckMs > 0)) {
      let text: string | undefined;
      try {
        text = slowSpan("settings_read_sync", undefined, () =>
          // oxlint-disable-next-line no-restricted-properties -- known: zero-window CLI snapshots remain synchronous
          fs.readFileSync(path, "utf8"),
        );
      } catch {}
      return { text, value: parsed(text), checkedAt: this.now(), revision: 0 };
    }
    const cached = this.files.get(path);
    if (
      (!cached || this.now() - cached.checkedAt >= this.recheckMs) &&
      !this.pending.has(path)
    )
      void this.refresh(path);
    return (
      this.files.get(path) ?? {
        text: undefined,
        value: undefined,
        checkedAt: this.now(),
        revision: 0,
      }
    );
  }

  /** Monotonic per-file version, including external edits in zero-window mode. */
  versioned(path: string): Readonly<Snapshot> {
    const snapshot = this.snapshot(path);
    if (this.recheckMs > 0) return snapshot;
    const previous = this.synchronousVersions.get(path);
    const revision =
      (previous?.revision ?? 0) + Number(previous?.text !== snapshot.text);
    if (revision !== previous?.revision)
      this.synchronousVersions.set(path, { text: snapshot.text, revision });
    return { ...snapshot, revision };
  }

  text(path: string): string | undefined {
    return this.snapshot(path).text;
  }

  /** Parsed Settings snapshot (undefined when unreadable); never mutate it. */
  json(path: string): unknown {
    return this.snapshot(path).value;
  }

  private set(path: string, text: string): void {
    this.files.set(path, {
      text,
      value: parsed(text),
      checkedAt: this.now(),
      revision: (this.files.get(path)?.revision ?? 0) + 1,
    });
    this.changed(path);
  }

  writeJson(
    path: string,
    value: unknown | (() => unknown),
    sort = true,
  ): Promise<void> {
    return this.write<void>(path, () => {
      const next = typeof value === "function" ? value() : value;
      return {
        value: undefined,
        ...(next === undefined
          ? {}
          : {
              text: pyCompactJson(next, {
                separators: "default",
                sortKeys: sort,
                javascriptScalars: true,
              }),
            }),
      };
    });
  }

  write<T>(
    path: string,
    update: () =>
      | { text?: string; mode?: number; value: T }
      | Promise<{ text?: string; mode?: number; value: T }>,
  ): Promise<T> {
    const work = (this.writes.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const next = await slowSpan("settings_update", undefined, update);
        if (next.text === undefined) return next.value;
        await mkdir(dirname(path), { recursive: true });
        const tmp = join(
          dirname(path),
          `.${basename(path)}.${randomUUID()}.tmp`,
        );
        const mode = next.mode ?? 0o600;
        const file = await open(tmp, "wx", mode);
        try {
          try {
            await file.writeFile(next.text);
            await file.chmod(mode);
          } finally {
            await file.close();
          }
          await rename(tmp, path);
          this.set(path, next.text);
        } finally {
          await rm(tmp, { force: true }).catch(() => undefined);
        }
        return next.value;
      });
    this.writes.set(path, work);
    void work
      .catch(() => undefined)
      .finally(() => {
        if (this.writes.get(path) === work) this.writes.delete(path);
      });
    return work;
  }

  refresh(path: string): Promise<void> {
    // Invariant: A refresh reads after it is called, so it sees an edit made
    // while an older read was in flight; callers meanwhile share one queued
    // read, which keeps its turn until it starts.
    const queued = this.queued.get(path);
    if (queued) return queued;
    const pending = this.pending.get(path);
    if (!pending) return this.read(path);
    const next = pending.then(() => {
      this.queued.delete(path);
      return this.read(path);
    });
    this.queued.set(path, next);
    return next;
  }

  private read(path: string): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    const entry: Snapshot = this.files.get(path) ?? {
      text: undefined,
      value: undefined,
      checkedAt: this.now(),
      revision: 0,
    };
    this.files.set(path, entry);
    const work = readFile(path, {
      encoding: "utf8",
      signal: this.controller.signal,
    })
      .catch(() => undefined)
      .then((text) => {
        if (this.controller.signal.aborted || this.files.get(path) !== entry)
          return;
        entry.checkedAt = this.now();
        if (entry.text === text) return;
        entry.text = text;
        entry.value = parsed(text);
        entry.revision += 1;
        this.changed(path);
      })
      .finally(() => {
        this.pending.delete(path);
      });
    this.pending.set(path, work);
    return work;
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.writes.values()]);
  }
}

export type Dict = Record<string, unknown>;

export function isObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function valueError(message: string): Error {
  const error = new Error(message);
  error.name = "ValueError";
  return error;
}
