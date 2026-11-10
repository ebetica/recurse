// Server-only API v1 context projection; the web sidebar bundles agent.ts.
import type { AgentStatus } from "./schema";
import { contextOccupancy } from "../../agents/runtime/context_usage";
import type { Config } from "../../config";

/** Committed live usage for a row, or null when cold or unmeasured. */
export function agentContext(
  row: Readonly<Record<string, unknown>>,
  sample: Record<string, unknown> | null,
  config: Pick<Config, "chatSettings" | "contextBarWindow">,
): AgentStatus["context"] {
  if (sample === null) return null;
  const model = typeof row.model === "string" ? row.model : null;
  const usage = contextOccupancy(sample, config.chatSettings(model)[0], config);
  return usage.tokens === null
    ? null
    : {
        tokens: usage.tokens,
        window: usage.window,
        ...(typeof sample.session === "string"
          ? { session: sample.session }
          : {}),
      };
}
