// File-backed environment override state (a Pi conversation's env.sh) for the
// safety path expander and the Durable import of that conversation, plus the
// name and size rules Durable's overrides keep (src/agents/durable/
// managed_tools.ts).
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const MAX_NAME = 128;
export const MAX_FILE = 65_536;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE = /^export ([A-Za-z_][A-Za-z0-9_]*)=('(?:[^'\r\n]|'"'"')*')$/;
export type EnvironmentOverride = { name: string; value: string; line: string };

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined)
    throw new Error("Environment overrides require owner checks.");
  return value;
}

export function validName(value: string): boolean {
  return value.length <= MAX_NAME && NAME.test(value);
}

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function parseEnvironmentOverrides(
  contents: string,
): Map<string, EnvironmentOverride> {
  if (Buffer.byteLength(contents) > MAX_FILE)
    throw new Error("Environment override state is too large.");
  const overrides = new Map<string, EnvironmentOverride>();
  for (const line of contents.split("\n")) {
    const match = LINE.exec(line);
    if (match && validName(match[1]!)) {
      const quoted = match[2]!;
      overrides.set(match[1]!, {
        name: match[1]!,
        value: quoted.slice(1, -1).replaceAll(`'"'"'`, "'"),
        line,
      });
    }
  }
  return overrides;
}

export function fixedPath(env: NodeJS.ProcessEnv): string | undefined {
  const path = env.RECURSE_AGENT_ENV_FILE;
  const scratch = env.RECURSE_AGENT_TMPDIR;
  if (!path || !scratch || !isAbsolute(path) || !isAbsolute(scratch))
    return undefined;
  return resolve(path) === path &&
    resolve(scratch) === scratch &&
    basename(path) === "env.sh" &&
    dirname(path) === scratch
    ? path
    : undefined;
}

async function validateDirectory(path: string): Promise<void> {
  const info = await lstat(dirname(path));
  if (
    !info.isDirectory() ||
    info.uid !== uid() ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new Error("Environment override directory is not private.");
  }
}

export async function readOverrides(
  path: string,
): Promise<Map<string, EnvironmentOverride>> {
  await validateDirectory(path);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== uid() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > MAX_FILE
  ) {
    throw new Error("Environment override state is unsafe.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return parseEnvironmentOverrides(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export async function readEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
): Promise<Map<string, EnvironmentOverride>> {
  const path = fixedPath(env);
  return path ? readOverrides(path) : new Map();
}
