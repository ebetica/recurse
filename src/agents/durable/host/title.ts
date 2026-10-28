// Name a new conversation from its first operator message in the background.
// Close and deletion abort the naming task and wait for it to settle.
import { AbortScope } from "../../../utils/tasks";
import { WARNING } from "../../../observability/runtime_logging";
import type { DurableHost } from "../host.ts";
import type { Opened } from "./open.ts";

/** Start naming `cid` unless titles are off or naming already runs. */
export function startTitle(
  host: DurableHost,
  cid: string,
  opened: Opened,
  message: string,
): void {
  const { deps } = host;
  if (!deps.titleSettings || !deps.applyTitle || host.titleTasks.has(cid))
    return;
  const scope = new AbortScope(AbortSignal.timeout(15000));
  const done = (async () => {
    const { nameConversation } = await import("../conversation_title");
    await nameConversation({
      cid,
      conversation: opened.conversation,
      models: await host.models(),
      message,
      settings: () => deps.titleSettings!(),
      signal: scope.signal,
      log: (event, fields) => deps.log(event, { cid, ...fields }),
      apply: (title) => {
        if (!host.closing && !host.deleting(cid)) deps.applyTitle!(cid, title);
      },
    });
  })()
    .catch((error: unknown) => {
      deps.log(
        "conversation_title_failed",
        {
          cid,
          cause: scope.signal.aborted
            ? "cancelled_or_timed_out"
            : "naming_request_failed",
          error: String(error),
        },
        WARNING,
      );
    })
    .finally(() => {
      scope.dispose();
      host.titleTasks.delete(cid);
    });
  host.titleTasks.set(cid, { scope, done });
}
