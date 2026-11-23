// Bounded branch lookup and exact whitespace handling for Git ref reads.
import { stat } from "node:fs/promises";
import { gitText } from "./run";

// Python str.isspace() code points (str.strip() and unicode \s).
export const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");
export function pyStrip(text: string): string {
  return text.replace(PY_STRIP_RE, "");
}

/** The branch checked out at `wt`, or null (missing or detached). */
export async function branchAt(
  env: Parameters<typeof gitText>[0],
  wt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!(await stat(wt).catch(() => null))) return null;
  const r = await gitText(
    env,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    wt,
    256,
    10.0,
    signal,
  );
  const out = pyStrip(r.text ?? "");
  return r.code === 0 && out && out !== "HEAD" ? out : null;
}
