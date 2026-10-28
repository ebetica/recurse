// Same logical SQLite projection as sqlite_dump.py; not the physical DB header.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";

export function logicalDump(path: string): Record<string, unknown> {
  const db = new Database(path, { readonly: true });
  try {
    const schema = db
      .query("SELECT type, name, sql FROM sqlite_master ORDER BY name")
      .values();
    const tables: Record<string, unknown[][]> = {};
    for (const [kind, name] of schema) {
      if (kind === "table") {
        const quoted = String(name).replaceAll('"', '""');
        tables[String(name)] = db
          .query(`SELECT * FROM "${quoted}" ORDER BY rowid`)
          .values();
      }
    }
    return {
      schema,
      tables,
      journal_mode: db.query("PRAGMA journal_mode").values()[0]?.[0],
      user_version: db.query("PRAGMA user_version").values()[0]?.[0],
      sidecars: readdirSync(dirname(path))
        .filter((name) => name.startsWith(`${basename(path)}-`))
        .map((name) => name.slice(basename(path).length))
        .sort(),
    };
  } finally {
    db.close();
  }
}
