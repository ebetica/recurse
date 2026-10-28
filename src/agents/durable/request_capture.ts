// Capture exact requests after hooks, before auth, not HTTP payloads; refuse
// auth overrides; omit callbacks and AbortSignal. One uncapped capture per live
// conversation, images included, forgotten on reap; once idle it moves exactly
// to its file, which a newer request removes, so restarts read only the latest.
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { Models } from "@earendil-works/pi-ai";
import { slowSpan } from "../../observability/slow_span";

export interface RequestCapture {
  sessionId: string;
  method: string;
  json: string;
}
export interface CaptureFiles {
  /** The file that keeps the conversation's idle latest capture. */
  path(conversationId: string): string;
  /** How long a capture stays in memory after its request. */
  idleMs: number;
  /** A write failed; the capture stays in memory. */
  failed(conversationId: string, error: unknown): void;
}

export class RequestCaptures {
  private readonly captures = new Map<string, RequestCapture>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each conversation's file writes and removals, in order. */
  private readonly writes = new Map<string, Promise<void>>();
  /** Conversations whose file is known not to hold an older request. */
  private readonly current = new Set<string>();
  private closed = false;
  constructor(
    private readonly conversationForSession: (
      sessionId: string,
    ) => string | undefined,
    private readonly files?: CaptureFiles,
  ) {}
  conversationId(sessionId: string): string | undefined {
    return this.conversationForSession(sessionId);
  }
  async latest(conversationId: string): Promise<RequestCapture | undefined> {
    const capture = this.captures.get(conversationId);
    if (capture) return { ...capture };
    if (!this.files) return undefined;
    await this.writes.get(conversationId);
    const text = await readFile(this.files.path(conversationId), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (text === undefined) return undefined;
    const split = text.indexOf("\n");
    const head = JSON.parse(text.slice(0, split)) as {
      sessionId: string;
      method: string;
    };
    return {
      sessionId: head.sessionId,
      method: head.method,
      json: text.slice(split + 1),
    };
  }
  /** Stop moving captures to files and wait for writes in flight. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.writes.values());
  }
  private queue(conversationId: string, write: () => Promise<void>): void {
    const done = (this.writes.get(conversationId) ?? Promise.resolve())
      .then(write)
      .catch((error) => this.files!.failed(conversationId, error));
    this.writes.set(conversationId, done);
    void done.then(() => {
      if (this.writes.get(conversationId) === done)
        this.writes.delete(conversationId);
    });
  }
  /** Drop the conversation's capture, in memory and in its file. */
  forget(conversationId: string): void {
    this.captures.delete(conversationId);
    clearTimeout(this.timers.get(conversationId));
    this.timers.delete(conversationId);
    if (!this.files || this.closed || this.current.has(conversationId)) return;
    this.current.add(conversationId);
    const path = this.files.path(conversationId);
    this.queue(conversationId, () =>
      unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
    );
  }
  private kept(conversationId: string): void {
    const files = this.files;
    if (!files || this.closed) return;
    const path = files.path(conversationId);
    const timer = setTimeout(() => {
      this.timers.delete(conversationId);
      const capture = this.captures.get(conversationId);
      if (!capture || this.closed) return;
      this.queue(conversationId, async () => {
        if (this.closed) return;
        const tmp = `${path}.tmp`;
        const head = JSON.stringify({
          sessionId: capture.sessionId,
          method: capture.method,
        });
        // Invariant: Never create the directory: a deleted or cleared
        // conversation's storage must not reappear.
        try {
          await writeFile(tmp, `${head}\n${capture.json}`, { mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        await rename(tmp, path);
        // Invariant: A request recorded during the write is newer than the
        // file, which must not outlive it.
        if (this.captures.get(conversationId) !== capture) await unlink(path);
        else {
          this.captures.delete(conversationId);
          this.current.delete(conversationId);
        }
      });
    }, files.idleMs);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(conversationId, timer);
  }
  record(
    method: string,
    model: unknown,
    context: unknown,
    options: Record<string, unknown> | undefined,
  ): void {
    const sessionId = options?.sessionId;
    if (typeof sessionId !== "string") return;
    const cid = this.conversationForSession(sessionId);
    if (!cid) return;
    this.forget(cid);
    // Invariant: No credential-bearing options are allowed through this
    // inspector boundary.
    if (
      options?.apiKey ||
      options?.env ||
      options?.headers ||
      options?.transformHeaders
    )
      throw new Error(
        "Request capture requires Models-owned authentication and headers",
      );
    const modelRef = model as { provider?: string; id?: string };
    const serializableOptions = options && { ...options };
    if (serializableOptions) delete serializableOptions.signal;
    const json = slowSpan("request_capture", cid, () =>
      JSON.stringify({
        model: { provider: modelRef.provider, modelId: modelRef.id },
        context,
        options: serializableOptions,
      }),
    );
    this.captures.set(cid, { sessionId, method, json });
    this.kept(cid);
  }
}

// All Models entry points keep their binding; request calls capture (deferred
// calls record their handle).
export function captureRequests(
  models: Models,
  captures: RequestCaptures,
): Models {
  const methods = new Set([
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
    "streamDeferred",
    "fetchDeferred",
    "cancelDeferred",
    "generateImages",
    "classify",
  ]);
  return new Proxy(models, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!methods.has(String(key))) return value.bind(target);
      return (
        model: unknown,
        context: unknown,
        options?: Record<string, unknown>,
      ) => {
        // Invariant: Not complete/completeSimple: a generation streams, and
        // Durable's compaction summarizer completes. A summary request is not
        // the turn's input, and the Pi path's capture (the context event) never
        // sees one.
        if (key !== "complete" && key !== "completeSimple")
          captures.record(String(key), model, context, options);
        const sessionId = options?.sessionId;
        return slowSpan(
          "provider_setup",
          typeof sessionId === "string"
            ? captures.conversationId(sessionId)
            : undefined,
          () => value.call(target, model, context, options),
        );
      };
    },
  });
}
