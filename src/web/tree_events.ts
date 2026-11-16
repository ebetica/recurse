// Browser tag/unread streams share one follower per awake remote label;
// the last subscriber aborts it. Admission is capped at 32 tree streams.
// Five-minute expiry releases abandoned proxy connections whose downstream
// disconnect never reached this server.
import type { TreeView } from "../agents/tree_view";
import type { ConnectedBackends } from "../backends/connected";
import {
  INFO,
  WARNING,
  logEvent,
  type RuntimeLogger,
} from "../observability/runtime_logging";
import { conversationEvents } from "./conversation_events";
import { HttpError, type Router } from "./router";

export function registerTreeEvents(
  router: Router,
  tree: TreeView,
  backends: ConnectedBackends,
  requireReady: () => void,
  log: RuntimeLogger,
): void {
  const subscribers = new Set<object>();
  const shared = new Map<
    string,
    { listeners: Set<() => void>; stop: () => void }
  >();
  const retry = async (signal: AbortSignal, delay: number) => {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      signal.addEventListener("abort", done, { once: true });
    });
  };
  const follow = async (
    label: string,
    url: string,
    signal: AbortSignal,
    notify: () => void,
    initialDelay: number,
  ) => {
    await retry(signal, initialDelay);
    let delay = 3000;
    let reported = false;
    const report = (status: number | null, failed: boolean) => {
      if (reported || signal.aborted) return;
      reported = true;
      logEvent(log, failed ? WARNING : INFO, "remote_tree_stream_ended", {
        fields: { label, status, retry_ms: delay },
      });
    };
    while (!signal.aborted) {
      let reader: { cancel(): Promise<void> } | undefined;
      let status: number | null = null;
      try {
        const response = await backends.treeEvents(
          label,
          new Request(url, { signal }),
        );
        if (!response) return;
        status = response.status;
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          const retryAfter = response.headers.get("retry-after") ?? "";
          if (/^\d+$/.test(retryAfter))
            delay = Math.min(
              Math.max(delay, Number(retryAfter) * 1000),
              60_000,
            );
          if ([401, 403, 404, 424].includes(response.status)) {
            report(status, true);
            return;
          }
          throw new Error("remote tree notices unavailable");
        }
        const incoming = response.body.getReader();
        reader = incoming;
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const chunk = await incoming.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (frame.includes("event: changed\n")) {
              delay = 3000;
              notify();
            }
          }
          if (buffer.length > 4096) throw new Error("invalid tree notice");
        }
        report(status, false);
      } catch {
        report(status, true);
      } finally {
        await reader?.cancel().catch(() => {});
      }
      await retry(signal, Math.min(delay * (1 + Math.random() * 0.2), 60_000));
      delay = Math.min(delay * 2, 60_000);
    }
  };
  const subscribeRemote = (label: string, url: string, notify: () => void) => {
    let entry = shared.get(label);
    if (!entry) {
      const listeners = new Set<() => void>();
      let controller: AbortController | undefined;
      let started = false;
      const unsubscribe = backends.subscribe(() => {
        if (!backends.awakeLabels().includes(label)) {
          controller?.abort();
          controller = undefined;
        } else if (!controller) {
          controller = new AbortController();
          void follow(
            label,
            url,
            controller.signal,
            () => {
              for (const listener of listeners) listener();
            },
            started ? Math.random() * 1000 : 0,
          );
          started = true;
        }
      });
      entry = {
        listeners,
        stop: () => {
          unsubscribe();
          controller?.abort();
        },
      };
      shared.set(label, entry);
    }
    entry.listeners.add(notify);
    return () => {
      entry.listeners.delete(notify);
      if (!entry.listeners.size) {
        shared.delete(label);
        entry.stop();
      }
    };
  };
  router.get(
    "/api/tree/events",
    (ex) => {
      requireReady();
      if (subscribers.size >= 32)
        throw new HttpError(429, "Too many tree event streams", {
          "retry-after": "30",
        });
      const requested = ex.url.searchParams.getAll("backend");
      const labels = backends
        .connectedLabels()
        .filter((l) => requested.includes(l));
      const dirty = new Set(["", ...labels]);
      let revision = 0;
      return conversationEvents(
        null,
        async () => {
          const awake = new Set(["", ...backends.awakeLabels()]);
          const labels = [...dirty].filter((label) => awake.has(label));
          dirty.clear();
          return [
            200,
            new TextEncoder().encode(
              `id: ${++revision}\nevent: changed\ndata: ${JSON.stringify(labels)}\n\n`,
            ),
          ];
        },
        (wake) => {
          const subscriber = {};
          subscribers.add(subscriber);
          const notify = (label: string) => {
            dirty.add(label);
            wake();
          };
          const unsubscribe = tree.subscribe(() => notify(""));
          const remotes = labels.map((label) =>
            subscribeRemote(label, ex.request.url, () => notify(label)),
          );
          return () => {
            subscribers.delete(subscriber);
            unsubscribe();
            for (const stop of remotes) stop();
          };
        },
        ex.request.signal,
        0,
        300_000,
      );
    },
    { longRunning: true },
  );
}
