// Resolve a local Markdown image relative to its document or conversation.
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export function resolveImagePath(
  cwd: string,
  path: string,
  document?: string | null,
): string | null {
  if (!path || path.includes("\0")) return null;
  if (document) {
    const source = resolveImagePath(cwd, document);
    if (source === null) return null;
    cwd = dirname(source);
  }
  return path === "~" || path.startsWith("~/")
    ? resolve(homedir(), path.slice(2))
    : resolve(cwd, path);
}
