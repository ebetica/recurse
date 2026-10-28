// Pure parent-report composition from trusted settlement inputs.
// Python-compatible whitespace/code-point limits preserve titles and reasons.

const DEFAULT_TRIGGER = "(turn started by a system message)";
const LEGACY_TRIGGER_MAP = new Map([
  ["after your message", "(turn started by your message)"],
  ["after an agent message", "(turn started by an agent message)"],
  ["after an operator message", "(turn started by an operator message)"],
  ["after a system message", DEFAULT_TRIGGER],
]);
const VALID_TRIGGERS = new Set([
  ...LEGACY_TRIGGER_MAP.values(),
  ...LEGACY_TRIGGER_MAP.keys(),
]);
const PYTHON_WHITESPACE =
  "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WHITESPACE_RUN = new RegExp(`[${PYTHON_WHITESPACE}]+`, "gu");
const WHITESPACE_SINGLE = new RegExp(`[${PYTHON_WHITESPACE}]`, "u");
const TITLE_MAX = 60;
const REASON_MAX = 200;

export interface TurnReport {
  /** Messages received besides the trigger, by sender. */
  readonly operator?: number;
  readonly agent?: number;
  readonly fromParent?: number;
  /** Earlier settled turns this report replaces. */
  readonly earlier?: number;
  readonly trigger?: string;
  readonly lifetimeSeconds?: number | null;
  readonly finalText?: string | null;
  readonly replyUnread?: boolean;
  readonly aborted?: boolean;
  readonly error?: string | null;
  readonly kind?: string;
}

function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.split(WHITESPACE_RUN).filter(Boolean).join(" ");
  if (!cleaned) return null;
  return Array.from(cleaned).slice(0, max).join("") || null;
}

function cleanTrigger(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TRIGGER;
  const trigger = LEGACY_TRIGGER_MAP.get(value) ?? value;
  return VALID_TRIGGERS.has(trigger) ? trigger : DEFAULT_TRIGGER;
}

// The trigger, then nonzero message counts and earlier turns, in one bracket:
// "(turn started by your message; received 2 operator, 1 agent)".
function headline(report: TurnReport): string {
  const trigger = cleanTrigger(report.trigger);
  const { operator = 0, fromParent = 0, agent = 0, earlier = 0 } = report;
  const received = [
    `${operator} operator`,
    `${fromParent} from you`,
    `${agent} agent`,
  ].filter((part) => !part.startsWith("0 "));
  const notes = [
    received.length ? `received ${received.join(", ")}` : "",
    earlier ? `${earlier} earlier turn${earlier > 1 ? "s" : ""} ended` : "",
  ].filter(Boolean);
  if (!notes.length) return trigger;
  return `${trigger.slice(0, -1)}; ${notes.join("; ")})`;
}

function outcomeNote(report: TurnReport): string | null {
  if (report.aborted) return "(turn ended: aborted)";
  const reason = cleanLine(report.error, REASON_MAX);
  if (reason !== null) return `(turn ended with error: ${reason})`;
  if (report.kind === "exit_error") return "(turn ended with error)";
  if (report.kind === "exit_clean") return "(turn ended: process exited)";
  return null;
}

// The no-final parent line: title, exact trigger, and the missing-reply notice.
export function formatTurnReport(
  report: TurnReport,
  title: unknown = null,
): string {
  const name = cleanLine(title, TITLE_MAX) ?? "agent";
  return `${name} ended ${headline(report)} with no final message.`;
}

// Exact parent delivery for one settled turn, including an abnormal-end line.
export function resolveTurnDelivery(
  report: TurnReport,
  title: unknown = null,
): string {
  const final = report.finalText;
  const hasFinal =
    typeof final === "string" &&
    Array.from(final).some((ch) => !WHITESPACE_SINGLE.test(ch));
  let base: string;
  if (typeof final === "string" && hasFinal) {
    base = `${headline(report)}\n${final}`;
  } else {
    base = formatTurnReport(report, title);
    if (report.replyUnread) base += " The child's reply could not be read.";
  }
  const note = outcomeNote(report);
  return note === null ? base : `${base}\n${note}`;
}
