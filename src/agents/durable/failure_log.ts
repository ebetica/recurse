// Log terminal generation/compaction failures and scheduler crashes once.
// Ordinary failed tools remain model-readable results, not warning logs.
// Faulted/orphaned tasks never resume; lostTasks supplies their error rows.
// Errors redact from the first credential-shaped token and cap at 200 chars.
import type { CommitPublication } from "@earendil-works/pi-durable";
import { redactSecrets } from "../../tool_projection/redaction";

const RUN_KINDS = new Set(["pi.generation", "pi.compaction"]);
const LOG_UNSAFE_RE = /[^A-Za-z0-9_.:@/+,-]/gu;
const ERROR_MAX = 200;

type Rec = Record<string, unknown>;

/** Error text folded into the log alphabet: no secrets, bounded. */
export function logText(text: string): string {
  return (
    [...redactSecrets(text).trim().replace(LOG_UNSAFE_RE, "_")]
      .slice(0, ERROR_MAX)
      .join("") || "-"
  );
}

const LOST_TEXT: Readonly<Record<string, string>> = {
  "pi.generation":
    "The reply could not be saved, so it was lost; send again to retry.",
  "pi.compaction": "The compaction could not finish; retry with /compact.",
};

/** The error-row text of each generation or compaction the commit lost. */
export function lostTasks(
  publication: CommitPublication,
): { task: string; text: string }[] {
  const lost: { task: string; text: string }[] = [];
  for (const change of publication.changes) {
    if (change.type !== "task" || change.value.state.status !== "terminal")
      continue;
    const { id, kind } = change.value;
    const outcome = change.value.state.outcome;
    const text = LOST_TEXT[kind];
    if (text === undefined) continue;
    if (outcome.status !== "faulted" && outcome.status !== "orphaned") continue;
    const cause =
      outcome.status === "orphaned" ? outcome.reason : outcome.error.message;
    const shown = [...redactSecrets(String(cause)).trim()]
      .slice(0, ERROR_MAX)
      .join("");
    lost.push({ task: String(id), text: shown ? `${text}\n\n${shown}` : text });
  }
  return lost;
}

/** One field set per task the commit ended in failure. */
export function taskFailures(
  publication: CommitPublication,
  model: () => { provider: string; model: string },
): Rec[] {
  const failures: Rec[] = [];
  for (const change of publication.changes) {
    if (change.type !== "task" || change.value.state.status !== "terminal")
      continue;
    const { id, kind } = change.value;
    const outcome = change.value.state.outcome;
    if (outcome.status === "completed" || outcome.status === "aborted")
      continue;
    const run = RUN_KINDS.has(kind);
    if (outcome.status === "failed" && !run) continue;
    const detail = outcome.status === "orphaned" ? null : outcome.error.detail;
    const reason =
      outcome.status === "orphaned"
        ? outcome.reason
        : (detail as Rec | null | undefined)?.reason;
    failures.push({
      task: Number(id),
      kind,
      status: outcome.status,
      reason: typeof reason === "string" ? reason : null,
      ...(run ? (failedModel(publication) ?? model()) : {}),
      error:
        outcome.status === "orphaned" ? null : logText(outcome.error.message),
    });
  }
  return failures;
}

/** The provider and model of a failed assistant entry in the commit. */
function failedModel(
  publication: CommitPublication,
): { provider: string; model: string } | null {
  for (const change of publication.changes) {
    if (change.type !== "entry" || change.value.kind !== "pi.assistant")
      continue;
    const message = change.value.model?.[0] as Rec | undefined;
    if (
      message?.stopReason === "error" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    )
      return { provider: message.provider, model: message.model };
  }
  return null;
}
