// Capture requests after hooks, before auth, and scoped completion replies.
// Refuse credential overrides; omit callbacks and AbortSignal from snapshots.
// A Worker encodes one uncapped capture per live conversation, images included.
// Forget on reap; idle captures move to files, which a newer request removes.
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { Api, Context, Model, Models } from "@earendil-works/pi-ai";
import { slowSpan } from "../../observability/slow_span";
import { RequestCaptureWorker } from "./request_capture_worker";

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

type PendingCapture = Omit<RequestCapture, "json"> & {
  json: Promise<string> | undefined;
};

export class RequestCaptures {
  private readonly captures = new Map<string, PendingCapture>();
  private readonly serializer: RequestCaptureWorker;
  private readonly ownsSerializer: boolean;
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
    private readonly onRequest?: (
      cid: string,
      capture: Pick<RequestCapture, "sessionId" | "method">,
      model: Model<Api>,
      context: Context,
      options?: Record<string, unknown>,
    ) => void,
    serializer?: RequestCaptureWorker,
  ) {
    this.serializer = serializer ?? new RequestCaptureWorker();
    this.ownsSerializer = serializer === undefined;
  }
  conversationId(sessionId: string): string | undefined {
    return this.conversationForSession(sessionId);
  }
  async latest(conversationId: string): Promise<RequestCapture | undefined> {
    const capture = this.captures.get(conversationId);
    if (capture?.json) return { ...capture, json: await capture.json };
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
    await Promise.allSettled([...this.captures.values()].map((c) => c.json));
    if (this.ownsSerializer) await this.serializer.close();
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
  forget(conversationId: string, after?: Promise<unknown>): void {
    this.captures.delete(conversationId);
    clearTimeout(this.timers.get(conversationId));
    this.timers.delete(conversationId);
    if (!this.files || this.closed || this.current.has(conversationId)) return;
    this.current.add(conversationId);
    const path = this.files.path(conversationId);
    this.queue(conversationId, async () => {
      if (after) await after;
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }
  private kept(conversationId: string): void {
    const files = this.files;
    if (!files || this.closed) return;
    const path = files.path(conversationId);
    clearTimeout(this.timers.get(conversationId));
    const timer = setTimeout(() => {
      this.timers.delete(conversationId);
      const capture = this.captures.get(conversationId);
      if (!capture?.json || this.closed) return;
      this.queue(conversationId, async () => {
        const encoding = capture.json;
        if (this.closed || !encoding) return;
        const json = await encoding;
        const tmp = `${path}.tmp`;
        const head = JSON.stringify({
          sessionId: capture.sessionId,
          method: capture.method,
        });
        // Invariant: Never create the directory: a deleted or cleared
        // conversation's storage must not reappear.
        try {
          await writeFile(tmp, `${head}\n${json}`, { mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        await rename(tmp, path);
        // Invariant: A request recorded during the write is newer than the
        // file, which must not outlive it.
        if (
          this.captures.get(conversationId) !== capture ||
          capture.json !== encoding
        )
          await unlink(path);
        else {
          capture.json = undefined;
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
    conversationId?: string,
  ): ((reply: unknown) => void) | undefined {
    const sessionId = options?.sessionId;
    if (typeof sessionId !== "string") return;
    const cid = conversationId ?? this.conversationForSession(sessionId);
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
    const serializableOptions = { ...options };
    delete serializableOptions.signal;
    const json = slowSpan("request_capture_snapshot", cid, () => {
      // Invariant: Only options are normalized here: their nested telemetry
      // callbacks cannot cross threads. Context and images are worker-encoded.
      const snapshot = JSON.parse(
        JSON.stringify({ options: serializableOptions }),
      ) as { options?: unknown };
      return this.serializer.serialize({
        model: { provider: modelRef.provider, modelId: modelRef.id },
        context,
        options: snapshot.options,
      });
    });
    const capture: PendingCapture = { sessionId, method, json };
    this.captures.set(cid, capture);
    void json.catch((error) => {
      if (this.captures.get(cid) === capture) this.files?.failed(cid, error);
    });
    this.kept(cid);
    this.onRequest?.(
      cid,
      capture,
      model as Model<Api>,
      context as Context,
      options,
    );
    return (reply) => {
      if (this.closed || this.captures.get(cid) !== capture) return;
      const request =
        capture.json ??
        this.latest(cid).then((stored) => {
          if (!stored) throw new Error("Request capture is unavailable");
          return stored.json;
        });
      this.forget(cid, request);
      this.captures.set(cid, capture);
      capture.json = (async () => {
        const response = this.serializer.serialize(reply);
        const [requestJson, replyJson] = await Promise.all([request, response]);
        return `${requestJson.slice(0, -1)},"reply":${replyJson}}`;
      })();
      void capture.json.catch((error) => {
        if (this.captures.get(cid) === capture) this.files?.failed(cid, error);
      });
      this.kept(cid);
    };
  }
}

// All Models entry points keep their binding; request calls capture (deferred
// calls record their handle).
export function captureRequests(
  models: Models,
  captures: RequestCaptures,
  conversationId?: string,
  failed?: (conversationId: string) => void,
): Models {
  const capture = <T>(operation: () => T): T | undefined => {
    try {
      return operation();
    } catch (error) {
      if (conversationId === undefined) throw error;
      try {
        failed?.(conversationId);
      } catch {}
      return undefined;
    }
  };
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
        // Invariant: Unscoped completions are compaction, not turn input.
        const completion = key === "complete" || key === "completeSimple";
        const reply =
          !completion || conversationId !== undefined
            ? capture(() =>
                captures.record(
                  String(key),
                  model,
                  context,
                  options,
                  conversationId,
                ),
              )
            : undefined;
        const sessionId = options?.sessionId;
        const result = slowSpan(
          "provider_setup",
          conversationId ??
            (typeof sessionId === "string"
              ? captures.conversationId(sessionId)
              : undefined),
          () => value.call(target, model, context, options),
        );
        return completion && reply
          ? Promise.resolve(result).then((response) => {
              capture(() => reply(response));
              return response;
            })
          : result;
      };
    },
  });
}
