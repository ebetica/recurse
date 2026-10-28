// Retire validated reaped legacy sessions/owner sidecars through trash.
// Surviving source/active-turn references prevent retirement; Durable/imports
// never write originals. SessionIndex and logger are supplied inputs.
import { dirname } from "node:path";
import { pyAbsolute, type SessionIndex } from "./coding_backend/session_index";
import {
  WARNING,
  logEvent,
  type RuntimeLogger,
} from "./observability/runtime_logging";
import { retire } from "./utils/trash";

type Row = Record<string, unknown>;
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !value.includes("\0");

export interface PiSessionRetirementOptions {
  trashDir: string;
  sessions: Pick<SessionIndex, "sessionDir" | "boundSessionFile">;
  logger: RuntimeLogger;
}

export class PiSessionRetirement {
  constructor(private readonly options: PiSessionRetirementOptions) {}

  /** The absolute recorded path when it is a direct session-dir leaf. */
  private recordedFile(value: unknown): string | null {
    if (!nonEmpty(value)) return null;
    const path = pyAbsolute(value);
    return dirname(path) === pyAbsolute(this.options.sessions.sessionDir)
      ? path
      : null;
  }

  /** Session ids and files the given conversations still name. */
  sessionReferences(conversations: Row[]): [Set<string>, Set<string>] {
    const ids = new Set<string>();
    const files = new Set<string>();
    for (const conv of conversations) {
      const states = [conv];
      const turn = conv.active_turn;
      if (typeof turn === "object" && turn !== null && !Array.isArray(turn))
        states.push(turn as Row);
      for (const state of states) {
        for (const key of ["session_id", "source_id"])
          if (nonEmpty(state[key])) ids.add(state[key]);
        for (const key of ["session_file", "source_file"]) {
          const file = this.recordedFile(state[key]);
          if (file) files.add(file);
        }
      }
    }
    return [ids, files];
  }

  // Retire a reaped conversation's own unreferenced session file; true if
  // retired.
  async retireReapedSession(
    conv: Row,
    protectedIds: ReadonlySet<string>,
    protectedFiles: ReadonlySet<string>,
  ): Promise<boolean> {
    const { session_id: id, session_file: file, session_cwd: cwd } = conv;
    const { sessions, trashDir, logger } = this.options;
    if (!nonEmpty(id) || !nonEmpty(cwd)) return false;
    const recorded = this.recordedFile(file);
    if (!recorded || protectedIds.has(id) || protectedFiles.has(recorded))
      return false;
    try {
      const ledger = await sessions.boundSessionFile(id, file, cwd);
      if (ledger === null) return false;
      const retired = retire(ledger, trashDir);
      retire(`${ledger}.owner.json`, trashDir);
      return retired;
    } catch (error) {
      logEvent(logger, WARNING, "pi_session_retire_failed", {
        conversation_id: typeof conv.id === "string" ? conv.id : null,
        fields: { error: String(error) },
      });
      return false;
    }
  }
}
