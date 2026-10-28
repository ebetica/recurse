// Read-only normalization of legacy conversation bindings for history views.
import { pyPath } from "../../../coding_backend/session_index";

export interface SessionBinding {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
}

export function piBinding(
  sessionId: string,
  sessionFile: string,
  cwd: string,
): SessionBinding {
  return { sessionId, sessionFile: pyPath(sessionFile), cwd: pyPath(cwd) };
}
