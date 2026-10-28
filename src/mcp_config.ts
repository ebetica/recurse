// Codemode only (no toolExposure/auto-disable); entries pass Pi's validation.
// Mask literal secrets; replay masks only for identical server transport/key.
// Pi references/commands stay intact; errors hide values, writes are 0600.
// Saved servers apply next turn; loadToolsOnDemand hides inline schemas.

import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mcpServerConfig } from "./extensions/extra/mcp/status";

export const MCP_FILE_NAME = "mcp.json";
export const SECRET_MASK = "********";
const SECRET_FIELDS = ["env", "headers", "oauth"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NAME_START = /^[A-Za-z_]/;

type Rec = Record<string, unknown>;

/** A refused save or an unreadable file; the message is safe to show. */
export class McpConfigError extends Error {
  override name = "McpConfigError";
}

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Recurse's rules for one server entry, then Pi's; null when valid. */
export function mcpServerError(name: string, value: unknown): string | null {
  const at = `server "${name}":`;
  if (isRecord(value)) {
    if (value.exposure !== undefined && value.exposure !== "codemode")
      return `${at} exposure must be "codemode"; MCP tools are reachable only from code-mode scripts`;
    if (value.toolExposure !== undefined)
      return `${at} toolExposure is not supported; every tool uses code mode`;
    const { auth, headers } = value;
    if (auth !== undefined && auth !== "oauth" && !isRecord(auth))
      return `${at} auth must be "oauth" or { "provider": "<provider>" }`;
    if (
      auth === "oauth" &&
      (typeof value.url !== "string" ||
        Object.keys(isRecord(headers) ? headers : {}).some(
          (header) => header.toLowerCase() === "authorization",
        ))
    )
      return `${at} "auth": "oauth" needs an HTTP server without an Authorization header`;
    if (
      value.loadToolsOnDemand !== undefined &&
      typeof value.loadToolsOnDemand !== "boolean"
    )
      return `${at} loadToolsOnDemand must be a boolean`;
  }
  const config = mcpServerConfig(name, value);
  return typeof config === "string" ? config : null;
}

// Pi resolves leading ! commands and $NAME/${NAME}; $$/$! escape literals.
// Invalid template names remain literal until their closing brace.
export function isPiReference(value: string): boolean {
  if (value.startsWith("!")) return true;
  let index = 0;
  while (index < value.length) {
    const dollar = value.indexOf("$", index);
    if (dollar < 0) return false;
    const next = value[dollar + 1];
    if (next === "$" || next === "!") {
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", dollar + 2);
      if (end < 0) {
        index = dollar + 1;
        continue;
      }
      if (ENV_NAME.test(value.slice(dollar + 2, end))) return true;
      index = end + 1;
      continue;
    }
    if (ENV_NAME_START.test(value.slice(dollar + 1))) return true;
    index = dollar + 1;
  }
  return false;
}

/** The whole file's rules; null when valid. */
function mcpFileError(value: unknown): string | null {
  if (
    !isRecord(value) ||
    (value.mcpServers !== undefined && !isRecord(value.mcpServers))
  )
    return 'expected an object with an "mcpServers" object';
  if (
    value.autoEnableCodemode !== undefined &&
    value.autoEnableCodemode !== true
  )
    return "autoEnableCodemode must be true or absent";
  for (const [name, server] of Object.entries(value.mcpServers ?? {})) {
    const error = mcpServerError(name, server);
    if (error) return error;
  }
  return null;
}

/** `value` with every literal env and header value of every server masked. */
export function maskMcpConfig(value: Rec): Rec {
  const copy = structuredClone(value);
  if (!isRecord(copy.mcpServers)) return copy;
  for (const server of Object.values(copy.mcpServers))
    for (const field of SECRET_FIELDS)
      if (isRecord(server) && isRecord(server[field]))
        for (const [key, text] of Object.entries(server[field]))
          if (
            (field !== "oauth" || key === "clientSecret") &&
            (typeof text !== "string" || !isPiReference(text))
          )
            (server[field] as Rec)[key] = SECRET_MASK;
  return copy;
}

/** Whether a kept secret may go to `server`: headers only to the same url,
 * client secrets only to the same url, client and authorization server, env
 * only to the same command, args and cwd. */
function sameDestination(field: string, server: Rec, old: Rec): boolean {
  if (
    field === "oauth" &&
    ["clientId", "authServerMetadataUrl"].some(
      (key) => (server.oauth as Rec)?.[key] !== (old.oauth as Rec)?.[key],
    )
  )
    return false;
  const keys =
    field === "headers" || field === "oauth"
      ? ["url"]
      : ["command", "args", "cwd"];
  return keys.every(
    (key) => JSON.stringify(server[key]) === JSON.stringify(old[key]),
  );
}

/** Replace masked values in `next` with the stored ones; throws when absent
 * or when the server's destination changed. */
function restoreSecrets(next: Rec, stored: Rec): void {
  const storedServers = isRecord(stored.mcpServers) ? stored.mcpServers : {};
  if (!isRecord(next.mcpServers)) return;
  for (const [name, server] of Object.entries(next.mcpServers))
    for (const field of SECRET_FIELDS) {
      if (!isRecord(server) || !isRecord(server[field])) continue;
      const values = server[field] as Rec;
      const old = storedServers[name];
      const oldValues = isRecord(old) && isRecord(old[field]) ? old[field] : {};
      const moved = isRecord(old) && !sameDestination(field, server, old);
      for (const [key, value] of Object.entries(values)) {
        if (
          value !== SECRET_MASK ||
          (field === "oauth" && key !== "clientSecret")
        )
          continue;
        if (moved)
          throw new McpConfigError(
            `server "${name}": ${field} "${key}" is hidden but the server's ${field === "oauth" ? "url, client ID or authServerMetadataUrl" : field === "headers" ? "url" : "command, args or cwd"} changed; enter the value again`,
          );
        const kept = (oldValues as Rec)[key];
        if (typeof kept !== "string")
          throw new McpConfigError(
            `server "${name}": ${field} "${key}" is hidden but has no saved value; enter the value`,
          );
        values[key] = kept;
      }
    }
}

async function readStored(agentDir: string): Promise<Rec> {
  let text: string;
  try {
    text = await readFile(join(agentDir, MCP_FILE_NAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { mcpServers: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpConfigError(`${MCP_FILE_NAME} is not valid JSON`);
  }
  if (!isRecord(parsed))
    throw new McpConfigError(`${MCP_FILE_NAME} is not a JSON object`);
  return parsed;
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The stored file as masked JSON text; a missing file reads as no servers. */
export async function readMaskedMcpConfig(agentDir: string): Promise<string> {
  return pretty(maskMcpConfig(await readStored(agentDir)));
}

// Validate `text`, keep masked secrets, write the file; returns the masked
// text.
export async function saveMcpConfig(
  agentDir: string,
  text: string,
): Promise<string> {
  let next: unknown;
  try {
    next = JSON.parse(text);
  } catch {
    // Invariant: The parser's message may quote the input, so it is not shown.
    throw new McpConfigError("not valid JSON");
  }
  const shapeError = mcpFileError(next);
  if (shapeError) throw new McpConfigError(shapeError);
  // Invariant: Only masks need the stored file, so a corrupt file can be
  // replaced.
  if (text.includes(SECRET_MASK))
    restoreSecrets(next as Rec, await readStored(agentDir));
  const target = join(agentDir, MCP_FILE_NAME);
  const temp = join(agentDir, `.mcp.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(pretty(next));
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (failure) {
    await unlink(temp).catch(() => undefined);
    throw failure;
  }
  return pretty(maskMcpConfig(next as Rec));
}

/** Changes whenever the stored file is written, replaced or removed. */
export async function mcpFileStamp(agentDir: string): Promise<string> {
  try {
    const info = await stat(join(agentDir, MCP_FILE_NAME), { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "absent" : `unreadable:${code}`;
  }
}
