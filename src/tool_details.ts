// Retirement of legacy tool-detail directories. Nothing writes these any more:
// Durable records tool details itself (src/agents/durable/tool_details.ts),
// and the Pi tool-capture channel left with the Pi process runtime.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { retireAll, retireDirectory } from "./utils/trash_sweep";

// Retire legacy owner directories off-thread; no new owner dirs are written.
// The Worker's check and rename stay await-free.
export async function retireConversationDetails(
  cid: string,
  toolDetailsDir: string,
  trashDir: string,
): Promise<void> {
  if (typeof cid !== "string" || !cid || Buffer.byteLength(cid, "utf8") > 512)
    return;
  const path = join(
    toolDetailsDir,
    createHash("sha256").update(cid, "utf8").digest("hex"),
  );
  try {
    await retireDirectory(path, trashDir);
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
  return (
    (await retireAll(
      names.map((name) => join(toolDetailsDir, name)),
      trashDir,
    )) > 0
  );
}

/** Python's OSError: a Node system error carrying an errno code. */
function isOsError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code === "string";
}
