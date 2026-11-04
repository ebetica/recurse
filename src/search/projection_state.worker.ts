// Durable projection freshness metadata, shared without importing SQLite.
// Matching cookies establish readiness; they never supply an append cursor.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

export const SEARCH_FILE = "transcript.txt";
export const STATE_FILE = "message-search-state.json";
export interface ProjectionState {
  version: number;
  file: string;
  database: string;
  prefix: string;
}

export function searchFile(path: string): string {
  return join(dirname(path), SEARCH_FILE);
}

/** Volume timestamps survive remounts; device and inode aliases do not. */
export function identity(stat: Stats | undefined): string {
  return stat
    ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`
    : "";
}

/** Empty WALs created by read-only opens contain no source changes. */
export function databaseIdentity(path: string, source: Stats): string {
  const wal = statSync(`${path}-wal`, { throwIfNoEntry: false });
  return `${identity(source)}/${identity(wal?.size ? wal : undefined)}`;
}

function savedIdentity(value: string): string {
  return value
    .split("/")
    .map((part, index) => {
      const fields = part.split(":").slice(-4);
      return index === 1 && fields[0] === "0" ? "" : fields.join(":");
    })
    .join("/");
}

export function readProjectionState(path: string): ProjectionState | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      join(dirname(path), STATE_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > 8192) return;
    const saved = JSON.parse(readFileSync(fd, "utf8"));
    if (
      saved.version === 2 &&
      typeof saved.file === "string" &&
      typeof saved.database === "string" &&
      typeof saved.prefix === "string"
    )
      return {
        version: 2,
        file: savedIdentity(saved.file),
        database: savedIdentity(saved.database),
        prefix: saved.prefix,
      };
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** Check only cookies, not source rows or transcript payloads. */
export function projectionCurrent(path: string): boolean {
  try {
    const source = statSync(path);
    const file = statSync(searchFile(path));
    const saved = readProjectionState(path);
    return (
      !!saved &&
      source.isFile() &&
      file.isFile() &&
      (file.mode & 0o7777) === 0o600 &&
      saved.file === identity(file) &&
      saved.database === databaseIdentity(path, source)
    );
  } catch {
    return false;
  }
}
