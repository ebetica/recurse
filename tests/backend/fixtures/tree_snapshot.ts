// Stable real-filesystem snapshot shared by the file-retention parity tests.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export function treeSnapshot(
  root: string,
  options: { normalizeRoot?: boolean } = {},
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const visit = (parent: string) => {
    for (const name of readdirSync(parent).sort()) {
      const path = join(parent, name);
      const info = lstatSync(path);
      const parts = path
        .slice(root.length + 1)
        .replaceAll("\\", "/")
        .split("/");
      if (parts[0] === "trash" && /^[0-9a-f]{32}$/u.test(parts[1] ?? ""))
        parts[1] = "a".repeat(32);
      const row: Record<string, unknown> = {
        path: parts.join("/"),
        kind: info.isSymbolicLink()
          ? "link"
          : info.isDirectory()
            ? "directory"
            : "file",
        mode: info.mode & 0o777,
        // A directory's st_size depends on the filesystem; record it only
        // for files and links.
        ...(info.isDirectory() ? {} : { size: info.size }),
      };
      if (info.isFile()) {
        const raw = readFileSync(path);
        const data = options.normalizeRoot
          ? Buffer.from(raw.toString("utf8").replaceAll(root, "<ROOT>"), "utf8")
          : raw;
        if (options.normalizeRoot) row.size = data.byteLength;
        row.sha256 = createHash("sha256")
          .update(new Uint8Array(data))
          .digest("hex");
        if (path.endsWith(".json"))
          row.json = JSON.parse(data.toString("utf8"));
      } else if (info.isSymbolicLink()) {
        row.target = readlinkSync(path);
      }
      rows.push(row);
      if (info.isDirectory()) visit(path);
    }
  };
  visit(root);
  return rows.sort((left, right) => {
    const compare = (a: unknown, b: unknown): number => {
      const first = String(a ?? "");
      const second = String(b ?? "");
      return first === second ? 0 : first < second ? -1 : 1;
    };
    return (
      compare(left.path, right.path) ||
      compare(left.kind, right.kind) ||
      compare(left.sha256, right.sha256) ||
      Number(left.size) - Number(right.size)
    );
  });
}
