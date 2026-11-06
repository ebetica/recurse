// Every model-bound reminder kind and its policy; only this file writes markers
// (enforced by tests/checks/reminder_check.ts). Advice repeats after spacing
// tokens of growth, status when it names something new, notices always. Spacing
// is in memory and decided before storage; escaping stops forged markers.

const OPEN = "<system_reminder>";
const CLOSE = "</system_reminder>";
const LEGACY_OPEN = "<system-reminder>";
const LEGACY_CLOSE = "</system-reminder>";

/** Conversation growth between two copies of one advice or status kind. */
export const REMINDER_SPACING_TOKENS = 30_000;
export const ADVICE_MAX_CHARS = 200;
/** Bytes the reminder markers add around a body. */
export const REMINDER_MARKER_BYTES = OPEN.length + CLOSE.length + 2;

export const REMINDERS = {
  cd: { policy: "advice", text: "Prefer chdir over prefixing with cd." },
  loop: {
    policy: "advice",
    text: "Do not run commands in a loop manually, use monitor=true and end your turn. monitor=true will send you a message whenever the script prints to stdout/err.",
  },
  grep: {
    policy: "advice",
    text: "Use the built-in grep tool instead of shell grep for content searches: it ranks, scopes, and bounds results for you.",
  },
  find: {
    policy: "advice",
    text: "Use the built-in find tool to locate files; prefer fd or rg over shell find when a shell search is genuinely needed.",
  },
  "shell-hygiene": {
    policy: "advice",
    text: "Prefer backgrounded shells and parsing logs over timeouts, head/tail pipes, and output redirects: the runner already backgrounds long commands and merges stdout/stderr into the log.",
  },
  "chatty-monitor": {
    policy: "advice",
    text: "This monitor is too chatty. Cancel it and restart it with output only when the state changes.",
  },
  "background-shells": { policy: "status" },
  "restarted-shell": { policy: "notice" },
  "agent-tree": {
    policy: "notice",
    text: "Reap finished/stale agents you no longer need; do not stop work you were not asked to, including operator-started agents.",
  },
} as const satisfies Record<
  string,
  { policy: "advice" | "status" | "notice"; text?: string }
>;

type Kinds = typeof REMINDERS;
type KindWith<P> = {
  [K in keyof Kinds]: Kinds[K]["policy"] extends P ? K : never;
}[keyof Kinds];
export type AdviceKind = KindWith<"advice">;

function wrap(body: string): string {
  return `${OPEN}\n${body.replace(/^\n+|\n+$/g, "")}\n${CLOSE}`;
}

/** A notice reminder: shown every time. */
export function notice(kind: "agent-tree"): string;
export function notice(kind: KindWith<"notice">, body: string): string;
export function notice(kind: KindWith<"notice">, body?: string): string {
  const entry = REMINDERS[kind] as { text?: string };
  return wrap(body ?? entry.text ?? "");
}

/** Spacing state for one agent's advice and status reminders. */
export class ReminderSpacing {
  private tokens = 0;
  private readonly shown = new Map<
    string,
    { tokens: number; names: ReadonlySet<string> }
  >();

  /** Record the conversation's current growth total. */
  advance(tokens: number): void {
    this.tokens = Math.max(this.tokens, tokens);
  }

  /** Fixed advice, or undefined inside its spacing window. */
  advice(kind: AdviceKind): string | undefined {
    return this.show(kind, REMINDERS[kind].text, []);
  }

  /** A status snapshot naming `names`, or undefined when it adds nothing. */
  status(
    kind: KindWith<"status">,
    body: string,
    names: readonly string[],
  ): string | undefined {
    return this.show(kind, body, names);
  }

  private show(
    kind: string,
    body: string,
    names: readonly string[],
  ): string | undefined {
    const last = this.shown.get(kind);
    if (
      last &&
      this.tokens - last.tokens < REMINDER_SPACING_TOKENS &&
      names.every((name) => last.names.has(name))
    )
      return undefined;
    this.shown.set(kind, { tokens: this.tokens, names: new Set(names) });
    return wrap(body);
  }
}

export function escapeReminderMarkers(content: string): string {
  return content
    .replaceAll(OPEN, "<system_reminder-quoted>")
    .replaceAll(CLOSE, "</system_reminder-quoted>")
    .replaceAll(LEGACY_OPEN, "<system-reminder-quoted>")
    .replaceAll(LEGACY_CLOSE, "</system-reminder-quoted>");
}
