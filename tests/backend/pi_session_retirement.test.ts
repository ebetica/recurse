import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex } from "../../src/coding_backend/session_index";
import { PiSessionRetirement } from "../../src/pi_session_retirement";
import { logger } from "../../src/observability/runtime_logging";

test("a session a survivor names, or a binding that does not validate, stays", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-retirement-"));
  const [sessions, trash] = [join(root, "pi_sessions"), join(root, "trash")];
  for (const dir of [sessions, trash]) mkdirSync(dir);
  const file = join(sessions, "2026-08-21T00-00-00_s-kept.jsonl");
  writeFileSync(file, '{"type":"session","id":"s-kept","cwd":"/w"}\n');
  const conv = { session_id: "s-kept", session_file: file, session_cwd: "/w" };
  const retirement = new PiSessionRetirement({
    trashDir: trash,
    sessions: new SessionIndex(sessions),
    logger: logger("test", { write: () => {} }),
  });
  const [ids, files] = retirement.sessionReferences([
    { id: "fork", source_id: "s-kept" },
    { id: "other", active_turn: { session_file: file } },
  ]);
  expect([[...ids], [...files]]).toEqual([["s-kept"], [file]]);
  const none = new Set<string>();
  for (const [row, keptIds, keptFiles] of [
    [conv, ids, none],
    [conv, none, files],
    [{ ...conv, session_cwd: "/other" }, none, none],
    [{ ...conv, session_id: "s-else" }, none, none],
  ] as const)
    expect(await retirement.retireReapedSession(row, keptIds, keptFiles)).toBe(
      false,
    );
  expect(readdirSync(sessions)).toHaveLength(1);
  expect(readdirSync(trash)).toEqual([]);
  expect(await retirement.retireReapedSession(conv, none, none)).toBe(true);
  expect(readdirSync(trash)).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});
