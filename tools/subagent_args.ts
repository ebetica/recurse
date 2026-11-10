// Argument parsing and per-command help for the subagent CLI.
const SUBCOMMAND_HELP: Record<string, string> = {
  create: `usage: subagent.py create [-h] --title TITLE [--effort 1-5] [--sibling] [--taken-over]
                          [--worktree name [--worktree-source path] [--commit ref]]
                          prompt

Spawn a child or sibling in your current directory, or a remote top-level agent.

positional arguments:
  prompt           task for the new subagent

options:
  -h, --help       show this help message and exit
  --title TITLE    short kebab-case sidebar label (e.g. sidebar-design);
                   detail goes in the task prompt
  --effort 1-5     effort level 1-5 (local defaults to yours; remote uses its own)
  --remote LABEL   create on a connected backend using its defaults; returns
                   cid@label, without a parent report; offline calls queue nothing.
                   Requires a backend key; reconnect open-mode remotes with authentication
  --sibling        create a child of your parent; a top-level caller creates
                   another top-level agent
  --taken-over     create already taken over: the operator controls it; its replies
                   are not reported to you. Cannot combine with --remote
  --worktree name  give the child a fresh managed worktree (held by the child)
                   instead of sharing your directory; source defaults to your cwd
  --worktree-source path
                   fork from this checkout instead (requires --worktree); path
                   is resolved and must be a real, non-symlink, non-bare Git
                   checkout top level, not a subdirectory
  --commit ref     starting commit (default HEAD; requires --worktree); remote-
                   tracking branches are fetched first, and fetch or resolution
                   failures abort creation without falling back to HEAD
`,
  send: `usage: subagent.py send [-h] [--interrupt] cid message

positional arguments:
  cid          the subagent's local id, or id@label via a connected or polling home;
               reply to remote senders with the full address in their header
  message      the message to deliver

options:
  -h, --help   show this help message and exit
  --interrupt  stop the running turn, if any, and report whether it stopped;
               deliver the message either way, preserving queued message order
               (default: queue until the current turn finishes)
`,
  compact: `compact <cid|id@label>\n`,
  interrupt: `usage: subagent.py interrupt [-h] cid

positional arguments:
  cid         the local id or cid@label on a connected backend

options:
  -h, --help  show this help message and exit
`,
  read: `usage: subagent read <id@label> [--offset N] [--limit N]

Read a connected remote's live or archived plain-text transcript without waking it.
--offset is a 1-based line number (default 1); --limit is 1-2000 (default 200).
Requires a backend key. For local history, use the native read tool on transcript.txt.
`,
  search: `usage: subagent search <query> [target] [--tree | --all] [--deleted]
                       [--role user|assistant|agent|tool|tool-result] [--limit N]

Find literal, case-insensitive text in full transcripts, including tool arguments
and results. Without a target, search your own conversation.
Targets accept local ids, names, unique suffixes, archive ids and id@label.
--tree includes descendants; --all searches all live agents; --deleted also
includes retained deleted agents. --role filters entries; --limit is 1-100
(default 20). Hits print path:line: snippet with agent/time/role.
Read local matches with the native read tool; use read id@label for remotes.
`,
  status: `usage: subagent.py status [-h] [--subtree] [--json] [cid ...]

Show local or connected remote agent status (cid@label). Without ids, list local
agents. --subtree requires ids and includes each id's descendants. --json prints
one v1 response per line. Remote reads require a key and API v1 revision 3 or newer.
`,
  idle: `usage: subagent.py idle [-h] [--wait S] [cid]

Check this local or connected remote agent (cid@label) and its descendants
(default: the calling agent). Exit 0 if idle; otherwise print each busy id and reason and exit 1.
--wait polls until idle or S seconds have elapsed (1-86400). Remote reads
require a key and API v1 revision 3 or newer.
`,
  tail: `usage: subagent.py tail [-h] cid

positional arguments:
  cid         the local id or cid@label on a connected backend

options:
  -h, --help  show this help message and exit
`,
  wait: `usage: subagent.py wait [-h] [--timeout S] cid [cid ...]

positional arguments:
  cid          local id(s) or cid@label on connected backends

options:
  -h, --help   show this help message and exit
  --timeout S  give up after S seconds (1-86400)
`,
  move: `usage: subagent.py move [-h] (--to new-parent-cid | --top-level) cid

positional arguments:
  cid                  the subagent to move

options:
  -h, --help           show this help message and exit
  --to new-parent-cid  the new parent agent's id
  --top-level          make the agent top-level, with no parent
`,
  tag: `usage: subagent.py tag [-h] [--add tags] [--remove tags] cid

Add or remove sidebar tags on a local conversation.

positional arguments:
  cid            the conversation's local id

options:
  -h, --help     show this help message and exit
  --add tags     comma-separated tags to add (1-24 lowercase letters, digits
                 or '-'); repeatable
  --remove tags  comma-separated tags to remove; repeatable

The operator's tags (archived, snoozed, pinned) are refused.
`,
  rm: `usage: subagent.py rm [-h] cid [cid ...]

positional arguments:
  cid         local id(s) or cid@label on connected backends

options:
  -h, --help  show this help message and exit
`,
  revive: `usage: subagent.py revive [-h] [--top-level] [--parent cid] [--from PATH | target]

Restore an archived (reaped or cleared) agent with its full history. It
starts no turn until it gets a message.

positional arguments:
  target        agent id, archive id, or a fuzzy query naming one archived
                agent (several matches list candidates)

options:
  -h, --help    show this help message and exit
  --top-level   revive it as a top-level agent (overrides --parent)
  --parent cid  revive it under this agent (default: under you)
--from PATH   copy an archive directory, session.sqlite, or Pi v3 .jsonl;
              always a new id, safety review on, source untouched (256 MiB max)
`,
};

const USAGE: Record<string, string> = {
  root: "usage: subagent.py [-h] {create,send,compact,interrupt,read,search,status,idle,tail,wait,move,tag,rm,revive} ...",
  status: "usage: subagent.py status [-h] [--subtree] [--json] [cid ...]",
  idle: "usage: subagent.py idle [-h] [--wait S] [cid]",
  create:
    "usage: subagent.py create [-h] --title TITLE [--effort 1-5] [--sibling] [--taken-over]\n                          [--worktree name [--worktree-source path] [--commit ref]]\n                          prompt",
  send: "usage: subagent.py send [-h] [--interrupt] cid message",
  compact: "usage: subagent compact <cid|id@label>",
  interrupt: "usage: subagent.py interrupt [-h] cid",
  read: "usage: subagent read <id@label> [--offset N] [--limit N]",
  search:
    "usage: subagent search <query> [target] [--tree | --all] [--deleted] [--role user|assistant|agent|tool|tool-result] [--limit N]",
  tail: "usage: subagent.py tail [-h] cid",
  wait: "usage: subagent.py wait [-h] [--timeout S] cid [cid ...]",
  move: "usage: subagent.py move [-h] (--to new-parent-cid | --top-level) cid",
  tag: "usage: subagent.py tag [-h] [--add tags] [--remove tags] cid",
  rm: "usage: subagent.py rm [-h] cid [cid ...]",
  revive:
    "usage: subagent.py revive [-h] [--top-level] [--parent cid] [--from PATH | target]",
};

export class CliFailure extends Error {
  code: number;
  stdout: string;
  stderr: string;

  constructor(message: string, code = 1, stdout = "", stderr?: string) {
    super(message);
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr ?? message;
  }
}

function normalizedParserMessage(message: string): string {
  return message.includes("--title") && message.includes("required")
    ? "--title is required; use a short kebab-case name like 'sidebar-design'"
    : message;
}

export function parserFailure(message: string): never;
export function parserFailure(command: string | null, message: string): never;
export function parserFailure(
  commandOrMessage: string | null,
  maybeMessage?: string,
): never {
  if (maybeMessage === undefined) {
    const message = normalizedParserMessage(String(commandOrMessage));
    throw new CliFailure(`${USAGE.root}\nsubagent.py: error: ${message}\n`, 2);
  }
  const command = commandOrMessage;
  const message = normalizedParserMessage(maybeMessage);
  const usage = USAGE[command ?? "root"] ?? USAGE.root!;
  throw new CliFailure(
    `${usage}\nsubagent.py${command ? ` ${command}` : ""}: error: ${message}\n`,
    2,
  );
}

export function systemFailure(message: string, stdout = ""): never {
  throw new CliFailure(message, 1, stdout, `${message}\n`);
}

export function parseFloatPython(raw: string): number {
  const cleaned = raw.trim();
  if (!cleaned) return Number.NaN;
  if (/^[+-]?inf(?:inity)?$/i.test(cleaned))
    return cleaned.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(cleaned)) return NaN;
  return Number(cleaned);
}

function integerArg(raw: string, option: string, command: string): number {
  if (!/^[+-]?\d+$/.test(raw)) {
    parserFailure(command, `argument ${option}: invalid int value: '${raw}'`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    parserFailure(command, `argument ${option}: invalid int value: '${raw}'`);
  return value;
}

function floatArg(raw: string, option: string, command: string): number {
  const value = parseFloatPython(raw);
  if (Number.isNaN(value) && !/^[-+]?nan$/i.test(raw.trim())) {
    parserFailure(command, `argument ${option}: invalid float value: '${raw}'`);
  }
  return value;
}

export type Parsed = {
  command: string;
  positional: string[];
  options: Map<string, string | true>;
};

export function parseArguments(args: string[], moduleHelp: string): Parsed {
  if (args.length > 0 && (args[0] === "-h" || args[0] === "--help"))
    throw new CliFailure(`${moduleHelp}\n`, 0);
  if (args.length === 0)
    parserFailure(null, "the following arguments are required: cmd");
  const command = args[0]!;
  const valid = [
    "create",
    "send",
    "compact",
    "interrupt",
    "read",
    "search",
    "status",
    "idle",
    "tail",
    "wait",
    "move",
    "tag",
    "rm",
    "revive",
  ];
  if (!valid.includes(command)) {
    parserFailure(
      null,
      `invalid choice: '${command}' (choose from ${valid.map((x) => `'${x}'`).join(", ")})`,
    );
  }
  const takesValue = new Set<string>();
  const switches = new Set<string>();
  switch (command) {
    case "create":
      takesValue.add("--title");
      takesValue.add("--effort");
      takesValue.add("--remote");
      takesValue.add("--worktree");
      takesValue.add("--worktree-source");
      takesValue.add("--commit");
      switches.add("--sibling");
      switches.add("--taken-over");
      break;
    case "send":
      switches.add("--interrupt");
      break;
    case "read":
      takesValue.add("--limit");
      takesValue.add("--offset");
      break;
    case "search":
      switches.add("--tree");
      switches.add("--all");
      switches.add("--deleted");
      takesValue.add("--role");
      takesValue.add("--limit");
      break;
    case "status":
      switches.add("--subtree");
      switches.add("--json");
      break;
    case "idle":
      takesValue.add("--wait");
      break;
    case "wait":
      takesValue.add("--timeout");
      break;
    case "move":
      takesValue.add("--to");
      switches.add("--top-level");
      break;
    case "tag":
      takesValue.add("--add");
      takesValue.add("--remove");
      break;
    case "revive":
      takesValue.add("--from");
      takesValue.add("--parent");
      switches.add("--top-level");
      break;
  }
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  let terminated = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (terminated) {
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      terminated = true;
      continue;
    }
    if (arg === "-h" || arg === "--help")
      throw new CliFailure(SUBCOMMAND_HELP[command]!, 0);
    const equals = arg.indexOf("=");
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const inline = equals > 0 ? arg.slice(equals + 1) : undefined;
    if (switches.has(flag)) {
      if (inline !== undefined)
        parserFailure(command, `option ${flag} does not take a value`);
      options.set(flag, true);
      continue;
    }
    if (takesValue.has(flag)) {
      const value = inline ?? args[++i];
      const looksLikeOption =
        value !== undefined &&
        value !== "-" &&
        value.startsWith("-") &&
        !/^(?:-\\d+|-\\d*\\.\\d+)$/.test(value);
      if (value === undefined || (inline === undefined && looksLikeOption)) {
        parserFailure(command, `argument ${flag}: expected one argument`);
      }
      const earlier = options.get(flag);
      options.set(
        flag,
        command === "tag" && typeof earlier === "string"
          ? `${earlier},${value}`
          : value!,
      );
      continue;
    }
    if (
      arg.startsWith("-") &&
      arg !== "-" &&
      !/^(?:-\\d+|-\\d*\\.\\d+)$/.test(arg)
    ) {
      parserFailure(command, `unrecognized arguments: ${arg}`);
    }
    positional.push(arg);
  }

  const req = (flag: string): string | undefined => {
    const value = options.get(flag);
    return typeof value === "string" ? value : undefined;
  };
  const arity: Record<
    string,
    { min: number; max: number; required?: string[] }
  > = {
    create: { min: 1, max: 1, required: ["--title"] },
    send: { min: 2, max: 2 },
    compact: { min: 1, max: 1 },
    interrupt: { min: 1, max: 1 },
    read: { min: 1, max: 1 },
    search: { min: 1, max: 2 },
    status: { min: 0, max: Infinity },
    idle: { min: 0, max: 1 },
    tail: { min: 1, max: 1 },
    wait: { min: 1, max: Infinity },
    move: { min: 1, max: 1 },
    tag: { min: 1, max: 1 },
    rm: { min: 1, max: Infinity },
    revive: {
      min: options.has("--from") ? 0 : 1,
      max: options.has("--from") ? 0 : 1,
    },
  };
  const rule = arity[command]!;
  const missing = rule.required?.filter((item) => !options.has(item)) ?? [];
  if (missing.length) {
    if (command === "create" && !positional.length && options.has("--title")) {
      parserFailure(command, "the following arguments are required: prompt");
    }
    parserFailure(
      command,
      `the following arguments are required: ${missing.join(", ")}`,
    );
  }
  if (positional.length < rule.min) {
    const expected =
      command === "search"
        ? "query"
        : command === "create"
          ? "prompt"
          : command === "send"
            ? "cid, message"
            : command === "read"
              ? "target"
              : command === "move"
                ? "cid"
                : command === "wait"
                  ? "cid"
                  : command === "revive"
                    ? "target"
                    : "cid";
    parserFailure(command, `the following arguments are required: ${expected}`);
  }
  if (positional.length > rule.max) {
    parserFailure(
      command,
      `unrecognized arguments: ${positional.slice(rule.max).join(" ")}`,
    );
  }
  if (command === "move" && options.has("--to") === options.has("--top-level"))
    parserFailure(command, "choose exactly one of --to or --top-level");
  if (command === "create") {
    for (const flag of ["--worktree-source", "--commit"]) {
      if (options.has(flag) && !options.has("--worktree"))
        parserFailure(
          command,
          `${flag} requires --worktree; add --worktree <name>`,
        );
    }
    const effort = req("--effort");
    if (effort !== undefined && !/^[+-]?\d+$/.test(effort))
      parserFailure(
        command,
        `argument --effort: invalid int value: '${effort}'`,
      );
    if (effort !== undefined && ![1, 2, 3, 4, 5].includes(Number(effort))) {
      parserFailure(
        command,
        `argument --effort: invalid choice: '${effort}' (choose from 1, 2, 3, 4, 5)`,
      );
    }
  }
  if (command === "read") {
    for (const flag of ["--limit", "--offset"]) {
      const raw = req(flag);
      if (
        raw !== undefined &&
        (integerArg(raw, flag, command) < 1 ||
          (flag === "--limit" && Number(raw) > 2000))
      )
        parserFailure(
          command,
          flag === "--limit"
            ? "--limit must be 1-2000"
            : "--offset must be a positive line number",
        );
    }
  }
  if (command === "search") {
    if (
      options.has("--all") &&
      (options.has("--tree") || positional.length > 1)
    )
      parserFailure(
        command,
        "--all cannot be combined with a target or --tree",
      );
    const role = req("--role");
    if (
      role !== undefined &&
      !["user", "assistant", "agent", "tool", "tool-result"].includes(role)
    )
      parserFailure(
        command,
        "--role must be user, assistant, agent, tool or tool-result",
      );
    const limit = req("--limit");
    if (
      limit !== undefined &&
      (integerArg(limit, "--limit", command) < 1 || Number(limit) > 100)
    )
      parserFailure(command, "--limit must be 1-100");
  }
  if (command === "wait" || command === "idle") {
    const flag = command === "wait" ? "--timeout" : "--wait";
    const raw = req(flag);
    if (raw !== undefined) floatArg(raw, flag, command);
  }
  if (command === "status" && options.has("--subtree") && !positional.length)
    parserFailure(command, "--subtree requires an agent id");
  return { command, positional, options };
}
