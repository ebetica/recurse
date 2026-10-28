// Retain only recently used Harnesses. Idle checks include all live tasks,
// reports and forks; the host serializes verified close and reopen.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness, Conversation } from "@earendil-works/pi-durable";

interface IdleOpened {
  ready: boolean;
  parent?: string;
  attached: ReadonlyMap<string, unknown>;
  reporter: { caughtUp: boolean } | null;
  harness: Harness;
  conversation: Conversation;
}

export class IdleHarnesses<T extends IdleOpened> {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      idleMs(): number;
      get(cid: string): Promise<T> | undefined;
      blocked(cid: string): boolean;
      naming(cid: string): boolean;
      serial(cid: string, step: () => Promise<void>): Promise<void>;
      close(cid: string, opened: Promise<T>): Promise<void>;
      failed(cid: string, error: unknown): void;
    },
  ) {}

  retain(cid: string): void {
    this.forget(cid);
    if (!this.deps.get(cid) || this.deps.blocked(cid)) return;
    const timer = setTimeout(() => {
      void this.deps
        .serial(cid, () => this.expire(cid, timer))
        .catch((error) => {
          this.deps.failed(cid, error);
          this.retain(cid);
        });
    }, this.deps.idleMs());
    timer.unref();
    this.timers.set(cid, timer);
  }

  forget(cid: string): void {
    clearTimeout(this.timers.get(cid));
    this.timers.delete(cid);
  }

  close(): void {
    for (const cid of this.timers.keys()) this.forget(cid);
  }

  private async expire(
    cid: string,
    timer: ReturnType<typeof setTimeout>,
  ): Promise<void> {
    const opened = this.deps.get(cid);
    const handle = await opened?.catch(() => null);
    const current = () =>
      this.timers.get(cid) === timer &&
      this.deps.get(cid) === opened &&
      !this.deps.blocked(cid);
    if (!current()) return;
    if (!handle || handle.parent !== undefined) {
      this.forget(cid);
      return;
    }
    if (
      !handle.ready ||
      handle.attached.size ||
      this.deps.naming(cid) ||
      (handle.reporter !== null && !handle.reporter.caughtUp)
    ) {
      this.retain(cid);
      return;
    }
    const { LiveDoc, InboxDoc } = await import("@earendil-works/pi-durable");
    const run = await handle.harness.snapshot(
      LiveDoc,
      handle.conversation.id,
      context,
    );
    const inbox = await handle.harness.snapshot(
      InboxDoc,
      handle.conversation.id,
      context,
    );
    const inspection = await handle.harness.inspect(context);
    if (!current()) return;
    if (
      run?.run !== undefined ||
      inbox?.items.length ||
      inspection.tasks.length
    ) {
      this.retain(cid);
      return;
    }
    await this.deps.close(cid, opened!);
    if (this.timers.get(cid) === timer) this.forget(cid);
  }
}
