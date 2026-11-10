// Tag and unread notices share the focused conversation's coalesced SSE.
// One browser stream includes connected backends so HTTP/1 connection limits
// cannot starve tree reads. Remote streams close during existing sleep pauses;
// notifications precede durable metadata flushes.
import type { TreeView } from "../agents/tree_view";
import type { ConnectedBackends } from "../backends/connected";
import { conversationEvents } from "./conversation_events";
import type { Router } from "./router";

export function registerTreeEvents(
  router: Router,
  tree: TreeView,
  backends: ConnectedBackends,
  requireReady: () => void,
): void {
  router.get(
    "/api/tree/events",
    (ex) => {
      requireReady();
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
          const following = new Map<string, AbortController>();
          const notify = (label: string) => {
            dirty.add(label);
            wake();
          };
          const unsubscribe = tree.subscribe(() => notify(""));
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
          const follow = async (label: string, signal: AbortSignal) => {
            let delay = 3000;
            while (!signal.aborted) {
              let reader: { cancel(): Promise<void> } | undefined;
              try {
                const request = new Request(ex.request.url, { signal });
                const response = await backends.treeEvents(label, request);
                if (!response) return;
                if (!response.ok || !response.body) {
                  await response.body?.cancel();
                  if ([401, 403, 404, 424].includes(response.status)) return;
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
                      notify(label);
                    }
                  }
                  if (buffer.length > 4096)
                    throw new Error("invalid tree notice");
                }
              } catch {
              } finally {
                await reader?.cancel().catch(() => {});
              }
              await retry(signal, delay);
              delay = Math.min(delay * 2, 60_000);
            }
          };
          const stopWatchingBackends = backends.subscribe(() => {
            const awake = new Set(backends.awakeLabels());
            for (const [label, controller] of following)
              if (!awake.has(label)) {
                controller.abort();
                following.delete(label);
              }
            for (const label of labels)
              if (awake.has(label) && !following.has(label)) {
                const controller = new AbortController();
                following.set(label, controller);
                void follow(label, controller.signal);
              }
          });
          return () => {
            unsubscribe();
            stopWatchingBackends();
            for (const controller of following.values()) controller.abort();
            following.clear();
          };
        },
        ex.request.signal,
        0,
      );
    },
    { longRunning: true },
  );
}
