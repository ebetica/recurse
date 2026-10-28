// Durable search shares one host Worker with per-conversation native
// connections. Init/index/search/format stay off the server thread. Close
// bundles after Harness.close and the shared service at host shutdown;
// registration alone does not wire server tools.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { trimSearchResult } from "../../core/context/search-results.ts";
import type { FffFlags } from "./fff_tools.ts";
import type { FffWorker } from "./fff_worker.ts";
import { adaptPiTool } from "./pi_tool_adapter.ts";

export interface FffOptions {
  worker: FffWorker;
  cwd: string;
  flags: FffFlags;
}

export async function createFff(options: FffOptions) {
  const bundle = await createFffExtension(
    options.worker,
    options.cwd,
    options.flags,
  );
  return { ...bundle, extensions: [bundle.extension] };
}

export async function createFffExtension(
  worker: FffWorker,
  cwd: string,
  flags: FffFlags = {},
) {
  const bundle = await worker.open(cwd, flags);
  return {
    ...bundle,
    extension: defineExtension({
      name: "recurse-search",
      tools: bundle.definitions.map(adaptPiTool),
      hooks: [
        hook(ToolTask, {
          afterTool(call, result) {
            // Invariant: Apply the non-idempotent search line cap exactly once.
            const patch = trimSearchResult({
              type: "tool_result",
              toolName: call.name,
              content: result.output ?? [],
              details: result.details,
              isError: result.isError ?? false,
              toolCallId: call.id,
              input: call.arguments,
            });
            return patch?.content
              ? { ...result, output: patch.content }
              : undefined;
          },
        }),
      ],
    }),
  };
}
