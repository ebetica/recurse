// Server settings reads return loaded snapshots and refresh off-thread.
// Zero-window standalone reads stay synchronous. Async mutations serialize per
// file and publish snapshots only after atomic, private-mode disk replacement.
// Older reads cannot undo own writes; close aborts reads and drains writes.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type Snapshot = {
  text: string | undefined;
  value: unknown;
  checkedAt: number;
};

function parsed(text: string | undefined): unknown {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class ConfigFiles {
  private readonly files = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<void>>();
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
        // oxlint-disable-next-line no-restricted-properties -- known: zero-window CLI snapshots remain synchronous
        text = fs.readFileSync(path, "utf8");
      } catch {}
      return { text, value: parsed(text), checkedAt: this.now() };
    }
    const cached = this.files.get(path);
    if (!cached || this.now() - cached.checkedAt >= this.recheckMs)
      void this.refresh(path);
    return (
      this.files.get(path) ?? {
        text: undefined,
        value: undefined,
        checkedAt: this.now(),
      }
    );
  }

  text(path: string): string | undefined {
    return this.snapshot(path).text;
  }

  json(path: string): unknown {
    return this.snapshot(path).value;
  }

  private set(path: string, text: string): void {
    this.files.set(path, { text, value: parsed(text), checkedAt: this.now() });
    this.changed(path);
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
        const next = await update();
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
    const pending = this.pending.get(path);
    if (pending) return pending;
    if (this.controller.signal.aborted) return Promise.resolve();
    const entry: Snapshot = this.files.get(path) ?? {
      text: undefined,
      value: undefined,
      checkedAt: this.now(),
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
