// A fresh marker means live Durable work, not merely an open SQLite owner.
// Writes serialize; idle/close removes the marker after admitted refreshes.
import { writeFile, unlink } from "node:fs/promises";
import type { CommitPublication, Harness } from "@earendil-works/pi-durable";

export class DurableActivity {
  private readonly tasks = new Set<number>();
  private timer?: ReturnType<typeof setInterval>;
  private tail = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly busy: () => boolean,
    private readonly failed: (error: unknown) => void,
  ) {}

  start(inspection: Awaited<ReturnType<Harness["inspect"]>>): void {
    for (const { record } of inspection.tasks)
      this.tasks.add(Number(record.id));
    this.started = true;
    this.refresh();
  }

  committed(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type !== "task") continue;
      const { id, state } = change.value;
      if (state.status === "terminal") this.tasks.delete(Number(id));
      else this.tasks.add(Number(id));
    }
    queueMicrotask(() => this.refresh());
  }

  refresh(): void {
    if (!this.started || this.closed) return;
    const active = this.tasks.size > 0 || this.busy();
    if (active) {
      if (this.timer) return;
      this.timer = setInterval(() => this.persist(true), 60_000);
      this.timer.unref();
    } else {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.persist(active);
  }

  private persist(active: boolean): void {
    this.tail = this.tail
      .then(async () => {
        if (active) await writeFile(this.path, "active\n", { mode: 0o600 });
        else
          await unlink(this.path).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
      })
      .catch(this.failed);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.persist(false);
    await this.tail;
  }
}
