// Pure bounded shell-liveness reminders and lifecycle formatting; no I/O or
// state. Equal timestamps retain live launch order or legacy snapshot order.

export type BackgroundReminderStatus = "running" | "stopping";

export interface BackgroundReminderShell {
  id: string;
  command: string;
  status: BackgroundReminderStatus;
  startedAt: number;
  launchSequence?: number;
}

export interface BackgroundReminderOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxCommandChars?: number;
}

const ANSI_ESCAPE_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const FORMAT_CONTROL_RE = /\p{Cf}/u;
const DEFAULT_BACKGROUND_REMINDER_MAX_ENTRIES = 12;
const DEFAULT_BACKGROUND_REMINDER_MAX_BYTES = 4096;
const DEFAULT_BACKGROUND_REMINDER_MAX_COMMAND_CHARS = 240;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// Middle-elide a line to maxLength including ellipsis, retaining head/tail.
// Shared by context reminders and lifecycle notices.
export function middleElide(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const cap = Math.max(3, maxLength);
  const head = Math.max(1, Math.ceil((cap - 1) / 2));
  const tail = Math.max(1, cap - 1 - head);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function escapeCommand(command: string, maxLength: number): string {
  // Invariant: Escape reminder markers in commands so hidden context cannot
  // forge blocks.
  const visible = [
    ...command
      .replace(ANSI_ESCAPE_RE, "")
      .replaceAll("<system_reminder>", "<system_reminder-quoted>")
      .replaceAll("</system_reminder>", "</system_reminder-quoted>")
      .replaceAll("<system-reminder>", "<system-reminder-quoted>")
      .replaceAll("</system-reminder>", "</system-reminder-quoted>"),
  ]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (char === "\n") return "\\n";
      if (char === "\r") return "\\r";
      if (char === "\t") return "\\t";
      if (
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029 ||
        FORMAT_CONTROL_RE.test(char)
      ) {
        return `\\u${code.toString(16).padStart(4, "0")}`;
      }
      return char;
    })
    .join("");
  return JSON.stringify(middleElide(visible, Math.max(8, maxLength))) ?? '""';
}

// Bound and escape live-shell snapshots before the model boundary. Terminal
// shell state never enters this projection.
export function formatBackgroundShellReminder(
  shells: ReadonlyArray<BackgroundReminderShell>,
  options: BackgroundReminderOptions = {},
): string | undefined {
  if (shells.length === 0) return undefined;
  const maxEntries = Math.max(
    1,
    Math.floor(options.maxEntries ?? DEFAULT_BACKGROUND_REMINDER_MAX_ENTRIES),
  );
  const maxBytes = Math.max(
    128,
    Math.floor(options.maxBytes ?? DEFAULT_BACKGROUND_REMINDER_MAX_BYTES),
  );
  const maxCommandChars = Math.max(
    8,
    Math.floor(
      options.maxCommandChars ?? DEFAULT_BACKGROUND_REMINDER_MAX_COMMAND_CHARS,
    ),
  );
  const ordered = [...shells].sort(
    (a, b) =>
      a.startedAt - b.startedAt ||
      (a.launchSequence ?? 0) - (b.launchSequence ?? 0),
  );
  const heading = `Background shells still running (${ordered.length}):`;
  const lines = ordered
    .slice(0, maxEntries)
    .map(
      (shell) =>
        `- ${shell.id} (${shell.status}, ${fmtElapsed(Date.now() - shell.startedAt)}) ${escapeCommand(shell.command, maxCommandChars)}`,
    );
  let shown = 0;
  let output = heading;
  for (const line of lines) {
    const candidate = `${output}\n${line}`;
    if (byteLength(candidate) > maxBytes) break;
    output = candidate;
    shown++;
  }
  const omitted = ordered.length - shown;
  if (omitted > 0) {
    const suffix = `… and ${omitted} more`;
    while (shown > 0 && byteLength(`${output}\n${suffix}`) > maxBytes) {
      const lastBreak = output.lastIndexOf("\n");
      output = lastBreak >= 0 ? output.slice(0, lastBreak) : heading;
      shown--;
    }
    if (byteLength(`${output}\n${suffix}`) <= maxBytes) output += `\n${suffix}`;
  }
  return output;
}

export interface StillRunningShell {
  id: string;
  command: string;
  pid: number | undefined;
  pgid: number | undefined;
  /** Ms since the shell was backgrounded (not since process start). */
  elapsedMs: number;
  logPath: string;
  /** Already-truncated last log line, or "(no output yet)". */
  lastLine: string;
}

/**
 * Format one still-running block: elapsed time, pid/pgid, log path, last log
 * line, and the whole-group stop hint. The command is middle-elided.
 */
export function formatStillRunningShell(
  shell: StillRunningShell,
  maxCommandChars = 300,
): string {
  const pgid = shell.pgid === undefined ? "?" : String(shell.pgid);
  return `Shell \`${shell.id}\` (${middleElide(shell.command, maxCommandChars)}) still running \u2014 pid ${shell.pid}, pgid ${pgid}, ${fmtElapsed(shell.elapsedMs)} elapsed.\nStop it (whole group): kill -- -${pgid}\nLog: ${shell.logPath}\nLast: ${shell.lastLine}`;
}

/** Human-friendly elapsed time: `12s`, `3m4s`, `1h2m`. */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
