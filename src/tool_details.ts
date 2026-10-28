// Retirement of legacy tool-detail directories. Nothing writes these any more:
// Durable records tool details itself (src/agents/durable/tool_details.ts),
// and the Pi tool-capture channel left with the Pi process runtime.
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { retire } from "./utils/trash";

// Retire legacy detached artifacts by rename only; no new owner dirs are
// written.
// Await-free check/rename prevents a race during synchronous retirement.
export function retireConversationDetails(
  cid: string,
  toolDetailsDir: string,
  trashDir: string,
): void {
  if (typeof cid !== "string" || !cid || Buffer.byteLength(cid, "utf8") > 512)
    return;
  const path = join(
    toolDetailsDir,
    createHash("sha256").update(cid, "utf8").digest("hex"),
  );
  try {
    if (!lstatSync(path).isDirectory()) return;
  } catch {
    return;
  }
  try {
    retire(path, trashDir);
  } catch {}
}

// Retire old .reap-* directories through shared trash; no current code mints
// them.
export async function retireDetached(
  toolDetailsDir: string,
  trashDir: string,
): Promise<boolean> {
  let names: string[];
  try {
    names = (await readdir(toolDetailsDir)).filter((n) =>
      n.startsWith(".reap-"),
    );
  } catch (error) {
    if (!isOsError(error)) throw error;
    return false;
  }
  let changed = false;
  for (const name of names) {
    try {
      changed = retire(join(toolDetailsDir, name), trashDir) || changed;
    } catch (error) {
      if (!isOsError(error)) throw error;
    }
  }
  return changed;
}

/** Python's OSError: a Node system error carrying an errno code. */
function isOsError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === "string";
}
