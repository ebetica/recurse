// Cache unresolved config and latest safe Settings results by content hash.
// No resolved values, raw diagnostics or historical configuration are retained.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateMcpServerConfig } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";
import type { McpServerEntry } from "../../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";

export type McpStatus = {
  name: string;
  state: "connected" | "failed" | "needs-sign-in" | "disabled" | "not-used";
  checkedAt: number | null;
  toolCount?: number;
  reason?: string;
};
const files = new Map<
  string,
  { hash: string; entries: McpServerEntry[]; servers: McpStatus[] }
>();
export const mcpStatusVersion = (path: string) => files.get(path)?.hash;
/** Pi's validation; `"auth": "oauth"` (Slack's spelling) is Pi's default. */
export const mcpServerConfig = (name: string, value: unknown) =>
  validateMcpServerConfig(
    name,
    typeof value === "object" &&
      value !== null &&
      (value as { auth?: unknown }).auth === "oauth"
      ? { ...value, auth: undefined }
      : value,
  );
export async function mcpConfig(path: string) {
  await mcpStatuses(path);
  return files.get(path)!.entries;
}
export async function mcpStatuses(path: string): Promise<McpStatus[]> {
  const text = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw new Error("MCP configuration unavailable");
    },
  );
  const hash = createHash("sha256").update(text).digest("hex");
  let file = files.get(path);
  if (file?.hash !== hash) {
    let configured: Record<string, unknown>;
    try {
      configured = JSON.parse(text).mcpServers ?? {};
    } catch {
      throw new Error("MCP configuration unavailable");
    }
    const entries = Object.entries(configured).flatMap(([name, value]) => {
      const config = mcpServerConfig(name, value);
      return typeof config === "string" ? [] : [{ name, config, source: path }];
    });
    file = {
      hash,
      entries,
      servers: entries.map(({ name, config }) => ({
        name,
        state: config.enabled === false ? "disabled" : "not-used",
        checkedAt: null,
      })),
    };
    files.set(path, file);
  }
  return file.servers.map((status) => ({ ...status }));
}
export async function recordMcpStatus(
  path: string,
  name: string,
  result: { toolCount: number } | { reason: string } | { needsSignIn: true },
  report: (server: string, state: string, reason?: string) => void,
  hash: string | undefined,
) {
  await mcpStatuses(path);
  const file = files.get(path)!;
  const index = file.servers.findIndex((server) => server.name === name);
  if (index < 0 || file.hash !== hash) return;
  const previous = file.servers[index]!;
  const status: McpStatus =
    "needsSignIn" in result
      ? { name, checkedAt: Date.now(), state: "needs-sign-in" }
      : {
          name,
          checkedAt: Date.now(),
          state: "reason" in result ? "failed" : "connected",
          ...result,
        };
  file.servers[index] = status;
  if (previous.state !== status.state || previous.reason !== status.reason)
    report(name, status.state, status.reason);
}
