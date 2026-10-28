#!/usr/bin/env bun
/**
 * Subagent commands:
 *
 *   create --title "Short name" [--effort <1-5>] [--remote <label> | --sibling] [--taken-over] [--worktree <name> [--worktree-source <path>] [--commit <ref>]] "<task prompt>"
 *       Create a child in your cwd, or --sibling under your parent (top-level
 *       outside a tree); give it a complete task because it cannot see your
 *       conversation, and do not repeat a pending create.
 *       --worktree creates a managed child worktree from cwd or --worktree-source
 *       (a real, non-symlink, non-bare checkout root); --commit defaults to HEAD,
 *       fetches remote-tracking refs and stops creation on fetch/resolve failure.
 *       Worktree creation launches cleanup detached and never waits for it.
 *       --taken-over creates an agent already taken over: the operator controls
 *       it; its replies are not reported to you. Cannot combine with --remote.
 *       --remote <label> creates a top-level agent on a connected backend and
 *       returns cid@label. The remote applies its own defaults; no automatic
 *       parent report is sent. Cannot combine with sibling or worktree options.
 *       Offline remotes fail immediately with last-seen information; nothing queues.
 *       Keyless/open-mode connections refuse agent control; reconnect with a key.
 *
 *   send <cid|id@label> [--interrupt] "<message>"
 *       id@label reaches connected backends, or the home's agents and other
 *       remotes through a home polling this backend, then waits for
 *       delivered, failed or not confirmed. Bare ids remain local; reply to remote
 *       senders using the full id@label in their message header.
 *       Polling homes support only send; other remote commands need a direct connection.
 *       --interrupt stops the current turn before delivery; idle targets start
 *       a turn, and queued messages retain their order.
 *   interrupt <cid|cid@label>
 *       Stop its turn and background jobs.
 *   messages <target> [--limit N] [--before <cursor>] [--after <cursor>] [--full]
 *       Read live or archived JSONL pages without waking or reviving agents;
 *       stderr gives prev/next cursors. --full prints untruncated text/tool args.
 *       Local targets accept ids, titles or unique suffixes.
 *       id@label reads only backends this one connects to, not polling homes.
 *   backends add <label> <url>
 *       Request a backend connection; the operator signs it in in Settings.
 *   backends list
 *       List labels, URLs, states, reasons and last contact, never keys.
 *   tail <cid|cid@label>
 *   wait <cid|cid@label> [<cid|cid@label> ...] [--timeout S]
 *   move <cid> --to <new-parent-cid>
 *   rm <cid|cid@label> [<cid|cid@label> ...]
 *       Queue removal and detached worktree cleanup; neither waits for deletion.
 *   revive <id-or-query> [--top-level | --parent <cid>]
 *   revive --from PATH [--top-level | --parent <cid>]
 *       Restore archived history idle under you, keeping its id (cleared copies
 *       get a new id); revive descendants separately, and use --top-level or
 *       --parent to place it elsewhere.
 *       --from imports an archive directory, session.sqlite or Pi v3 JSONL
 *       (256 MiB max), leaving the source untouched and assigning a new id with
 *       safety on; unavailable model/cwd falls back with a note.
 */
// Agent-tree HTTP commands; the leading JSDoc is the canonical help source.

import { lstatSync } from "node:fs";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ensureNamedWorktree,
  requestReapSweep,
  rootFromEnv,
} from "./worktree.ts";
import { cleanTitle } from "../src/title_text";
import { toolHelp } from "./_help.ts";

type JsonObject = Record<string, unknown>;
type Output = { code: number; stdout: string; stderr: string };

const SUBCOMMAND_HELP: Record<string, string> = {
  backends: `usage: subagent backends add <label> <url> | backends list

Request a connection for the operator to sign in in Settings, or list
labels, URLs, states, reasons and last contact. Never supplies or prints keys.
`,
  create: `usage: subagent.py create [-h] --title TITLE [--effort 1-5] [--sibling] [--taken-over]
                          [--worktree name [--worktree-source path] [--commit ref]]
                          prompt

Spawn a child or sibling in your current directory, or a remote top-level agent.

positional arguments:
  prompt           task for the new subagent

options:
  -h, --help       show this help message and exit
  --title TITLE    short sidebar label (a few words, e.g. dataset-impl-
                   coding); detail goes in the task prompt
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
  interrupt: `usage: subagent.py interrupt [-h] cid

positional arguments:
  cid         the local id or cid@label on a connected backend

options:
  -h, --help  show this help message and exit
`,
  messages: `usage: subagent.py messages [-h] [--limit LIMIT] [--before cursor]
                            [--after cursor] [--full]
                            target

positional arguments:
  target           local id, name, unique suffix, or id@label (direct connections only)

options:
  -h, --help       show this help message and exit
  --limit LIMIT    entries (1-50), live or archived
  --full           untruncated text and tool arguments
  --before cursor  older page ending before this entry id (from a prev:
                   cursor)
  --after cursor   newer page starting at this entry id (from a next: cursor)
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
  move: `usage: subagent.py move [-h] --to new-parent-cid cid

positional arguments:
  cid                  the subagent to move

options:
  -h, --help           show this help message and exit
  --to new-parent-cid  the new parent agent's id
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
  root: "usage: subagent.py [-h] {create,send,interrupt,messages,tail,wait,move,rm,revive} ...",
  create:
    "usage: subagent.py create [-h] --title TITLE [--effort 1-5] [--sibling] [--taken-over]\n                          [--worktree name [--worktree-source path] [--commit ref]]\n                          prompt",
  send: "usage: subagent.py send [-h] [--interrupt] cid message",
  interrupt: "usage: subagent.py interrupt [-h] cid",
  messages:
    "usage: subagent.py messages [-h] [--limit LIMIT] [--before cursor]\n                            [--after cursor] [--full]\n                            target",
  tail: "usage: subagent.py tail [-h] cid",
  wait: "usage: subagent.py wait [-h] [--timeout S] cid [cid ...]",
  move: "usage: subagent.py move [-h] --to new-parent-cid cid",
  rm: "usage: subagent.py rm [-h] cid [cid ...]",
  revive:
    "usage: subagent.py revive [-h] [--top-level] [--parent cid] [--from PATH | target]",
};

const MODULE_HELP = toolHelp(import.meta.url);
const DATA = process.env.CHAT_DATA_DIR
  ? resolve(process.env.CHAT_DATA_DIR)
  : resolve(process.cwd(), ".recurse-data");
const SPAWN_WAIT_SECONDS = 5;
const MSG_TEXT_CHARS = 1000;
const MSG_LINE_CHARS = 500;
const MSG_ARGS_CHARS = 200;
/** Pages of 50 rows tail reads back to find the newest user message. */
const MSG_TAIL_PAGES = 40;
const MSG_TAIL_FALLBACK_ENTRIES = 10;
const WAIT_POLL_SECONDS = 2;
const WAIT_TIMEOUT_MIN = 1;
const WAIT_TIMEOUT_MAX = 86_400;

class CliFailure extends Error {
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

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pyTruthy(value: unknown): boolean {
  if (
    value === null ||
    value === undefined ||
    value === false ||
    value === 0 ||
    value === ""
  )
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

const JSON_NUMBER_LEXEMES = new WeakMap<object, Map<string, string>>();

function numberLexeme(
  parent: object | undefined,
  key: string | undefined,
): string | undefined {
  if (!parent || key === undefined) return undefined;
  return JSON_NUMBER_LEXEMES.get(parent)?.get(key);
}

function pythonFloatText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16)) {
    const [mantissa, exponentText] = value.toExponential().split("e");
    const exponent = Number(exponentText);
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  const rendered = String(value);
  return rendered.includes(".") ? rendered : `${rendered}.0`;
}

function pythonNumberText(
  value: number,
  parent?: object,
  key?: string,
): string {
  const source = numberLexeme(parent, key);
  if (source !== undefined && !/[.eE]/.test(source))
    return source === "-0" ? "0" : source;
  if (
    source !== undefined ||
    !Number.isInteger(value) ||
    Object.is(value, -0)
  ) {
    return pythonFloatText(value);
  }
  return String(value);
}

function pythonStringRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let rendered = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0)!;
    if (char === "\\") rendered += "\\\\";
    else if (char === quote) rendered += `\\${char}`;
    else if (char === "\n") rendered += "\\n";
    else if (char === "\r") rendered += "\\r";
    else if (char === "\t") rendered += "\\t";
    else if (codePoint < 0x20 || codePoint === 0x7f)
      rendered += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    else rendered += char;
  }
  return `${quote}${rendered}${quote}`;
}

function pythonStr(value: unknown, parent?: object, key?: string): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pythonNumberText(value, parent, key);
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return `[${value.map((item, index) => pythonRepr(item, value, String(index))).join(", ")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .map(
        (name) =>
          `${pythonStringRepr(name)}: ${pythonRepr(value[name], value, name)}`,
      )
      .join(", ")}}`;
  }
  return String(value);
}

function pythonRepr(value: unknown, parent?: object, key?: string): string {
  if (typeof value === "string") return pythonStringRepr(value);
  return pythonStr(value, parent, key);
}

const PYTHON_SPACE =
  /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
function pythonStrip(value: string): string {
  const points = Array.from(value);
  let first = 0;
  let last = points.length;
  while (first < last && PYTHON_SPACE.test(points[first]!)) first++;
  while (last > first && PYTHON_SPACE.test(points[last - 1]!)) last--;
  return points.slice(first, last).join("");
}

function codePointSlice(value: string, length: number): string {
  return Array.from(value).slice(0, length).join("");
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function jsonParse(text: string): unknown {
  return JSON.parse(
    text,
    function (
      this: object,
      key: string,
      value: unknown,
      context?: { source?: string },
    ): unknown {
      if (typeof value === "number" && context?.source !== undefined) {
        let fields = JSON_NUMBER_LEXEMES.get(this);
        if (!fields) {
          fields = new Map();
          JSON_NUMBER_LEXEMES.set(this, fields);
        }
        fields.set(key, context.source);
      }
      return value;
    },
  );
}

function normalizedParserMessage(message: string): string {
  return message.includes("--title") && message.includes("required")
    ? "--title is required; use a concise name like 'Review auth flow'"
    : message;
}

function parserFailure(message: string): never;
function parserFailure(command: string | null, message: string): never;
function parserFailure(
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

function systemFailure(message: string, stdout = ""): never {
  throw new CliFailure(message, 1, stdout, `${message}\n`);
}

function parseFloatPython(raw: string): number {
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

type Parsed = {
  command: string;
  positional: string[];
  options: Map<string, string | true>;
};

function parseArguments(args: string[]): Parsed {
  if (args.length > 0 && (args[0] === "-h" || args[0] === "--help"))
    throw new CliFailure(`${MODULE_HELP}\n`, 0);
  if (args.length === 0)
    parserFailure(null, "the following arguments are required: cmd");
  const command = args[0]!;
  const valid = [
    "create",
    "send",
    "interrupt",
    "messages",
    "tail",
    "wait",
    "move",
    "rm",
    "revive",
    "backends",
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
    case "messages":
      switches.add("--full");
      takesValue.add("--limit");
      takesValue.add("--before");
      takesValue.add("--after");
      break;
    case "wait":
      takesValue.add("--timeout");
      break;
    case "move":
      takesValue.add("--to");
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
      options.set(flag, value!);
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
    backends: { min: 1, max: 3 },
    create: { min: 1, max: 1, required: ["--title"] },
    send: { min: 2, max: 2 },
    interrupt: { min: 1, max: 1 },
    messages: { min: 1, max: 1 },
    tail: { min: 1, max: 1 },
    wait: { min: 1, max: Infinity },
    move: { min: 1, max: 1, required: ["--to"] },
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
      command === "create"
        ? "prompt"
        : command === "send"
          ? "cid, message"
          : command === "messages"
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
  if (command === "messages") {
    for (const flag of ["--limit", "--before", "--after"]) {
      const raw = req(flag);
      if (raw !== undefined) integerArg(raw, flag, command);
    }
  }
  if (command === "wait") {
    const raw = req("--timeout");
    if (raw !== undefined) floatArg(raw, "--timeout", command);
  }
  return { command, positional, options };
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "x-loopback-token": "",
    "Content-Type": "application/json",
  };
  const agentId = process.env.RECURSE_AGENT_ID;
  if (agentId) headers["x-recurse-agent"] = agentId;
  return headers;
}

async function api<T = JsonObject>(
  method: string,
  path: string,
  body?: JsonObject,

  answered: readonly number[] = [],
): Promise<T> {
  let published: unknown;
  try {
    published = jsonParse(readFileSync(join(DATA, "server.json"), "utf8"));
  } catch {
    systemFailure(
      "No running instance found (server.json is missing). Start one with ./recurse <target> first.",
    );
  }
  if (!isObject(published))
    systemFailure(
      "No running instance found (server.json is missing). Start one with ./recurse <target> first.",
    );
  const port = published.port;
  const token = published.token;
  if (!port || !token)
    systemFailure(
      "No running instance found (server.json is missing). Start one with ./recurse <target> first.",
    );
  const headers = apiHeaders();
  headers["x-loopback-token"] = String(token);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "timed out"
        : error instanceof Error
          ? error.message
          : String(error);
    systemFailure(`Cannot reach the instance: ${reason}`);
  }
  const text = await response.text();
  if (!response.ok && !answered.includes(response.status)) {
    systemFailure(
      `Request failed (${response.status}): ${codePointSlice(text, 300)}`,
    );
  }
  if (!text) return {} as T;
  let loaded: unknown;
  try {
    loaded = JSON.parse(text);
  } catch {
    systemFailure(`Request failed: invalid response for ${path}`);
  }
  if (!isObject(loaded) && !Array.isArray(loaded))
    systemFailure(`Request failed: invalid response for ${path}`);
  return loaded as T;
}

function convPath(cid: string): string {
  return join(DATA, "conversations", `${cid}.json`);
}

function backendFor(target: string) {
  const match =
    /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})@([A-Za-z0-9._-]{1,32})$/.exec(target);
  if (target.includes("@") && !match) systemFailure("invalid remote target");
  const id = match ? match[1]! : target;
  const base = match ? `/api/backends/${encodeURIComponent(match[2]!)}` : "";
  return {
    id,
    remote: !!match,
    path: (path: string) => (match ? base + path.slice(4) : path),
  };
}

async function loadConv(cid: string): Promise<JsonObject> {
  const backend = backendFor(cid);
  if (backend.remote)
    return api("GET", backend.path(`/api/conversations/${backend.id}`));
  const path = convPath(cid);
  if (existsSync(path)) {
    let loaded: unknown;
    try {
      loaded = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw error;
    }
    if (!isObject(loaded))
      systemFailure(
        `Agent row file for '${cid}' is corrupt (expected an object).`,
      );
    return loaded;
  }
  try {
    return await api("GET", `/api/conversations/${cid}`);
  } catch (error) {
    if (error instanceof CliFailure) {
      throw new CliFailure(
        error.message,
        error.code,
        ``,
        `No such agent '${cid}': no row file and no live conversation.\n${error.stderr}`,
      );
    }
    throw error;
  }
}

function activeRunId(conv: JsonObject | null): string | null {
  if (!conv) return null;
  const value = conv.active_run;
  if (
    (typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))) &&
    typeof value !== "boolean" &&
    value !== ""
  )
    return String(value);
  let active: unknown = conv.active_turn;
  if (!pyTruthy(active)) active = {};
  if (!isObject(active)) active = {};
  const turn = active as JsonObject;
  const runId = turn.run_id;
  if (
    (typeof runId === "string" ||
      (typeof runId === "number" && Number.isFinite(runId))) &&
    typeof runId !== "boolean" &&
    runId !== ""
  )
    return String(runId);
  const startedAt = turn.started_at;
  if (
    (typeof startedAt === "string" ||
      (typeof startedAt === "number" && Number.isFinite(startedAt))) &&
    typeof startedAt !== "boolean" &&
    startedAt !== ""
  )
    return `legacy:${startedAt}`;
  return pyTruthy(active) || conv.status === "running"
    ? "legacy:running"
    : null;
}

async function runGit(args: string[], cwd: string): Promise<[number, string]> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return [result.exitCode, result.stdout.toString().trim()];
  } catch {
    return [1, ""];
  }
}

async function lastCommitText(workdir: unknown): Promise<string> {
  if (typeof workdir !== "string" || !workdir) return "(unknown directory)";
  if (!existsSync(workdir)) return "(directory unavailable)";
  try {
    if (!statSync(workdir).isDirectory()) return "(directory unavailable)";
  } catch {
    return "(directory unavailable)";
  }
  try {
    const [code] = await runGit(["rev-parse", "--show-toplevel"], workdir);
    if (code !== 0) return "(not a git repository)";
  } catch {
    return "(git unavailable)";
  }
  try {
    const [code, out] = await runGit(
      ["log", "-1", "--oneline", "--no-decorate"],
      workdir,
    );
    if (code !== 0 || !out) return "(no commits yet)";
    return out;
  } catch {
    return "(git unavailable)";
  }
}

async function worktreeSource(cwd: string): Promise<string | null> {
  try {
    const real = realpathSync(cwd);
    if (real !== cwd || lstatSync(cwd).isSymbolicLink()) return null;
    const [code, top] = await runGit(["rev-parse", "--show-toplevel"], cwd);
    if (code !== 0 || resolve(top) !== real) return null;
    const [bareCode, bare] = await runGit(
      ["rev-parse", "--is-bare-repository"],
      cwd,
    );
    if (bareCode !== 0 || bare === "true") return null;
    return real;
  } catch {
    return null;
  }
}

async function enterChildWorktree(
  name: string,
  cid: string,
  sourcePath?: string,
  commit?: string,
): Promise<string> {
  if (!name) parserFailure("create --worktree needs a name");
  const cwd = process.cwd();
  const source = await worktreeSource(
    sourcePath === undefined ? cwd : resolve(sourcePath),
  );
  if (!source) {
    throw new CliFailure(
      sourcePath === undefined
        ? "create --worktree requires your cwd to be inside a git repository: it forks the child's worktree from this checkout.\n"
        : "create --worktree-source must be a real, non-symlink, non-bare Git checkout top level; choose the repository root, not a subdirectory.\n",
    );
  }
  const root = rootFromEnv(process.env.WORKTREE_ROOT || DATA);
  let path;
  try {
    path = await ensureNamedWorktree(root, cid, name, cwd, {
      source,
      commit,
      creating: true,
    });
  } catch (error) {
    throw new CliFailure(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  if (path === null)
    throw new CliFailure(
      `Could not create worktree '${name}'; try another name.\n`,
    );
  return path;
}

async function waitForSpawn(
  cid: string,
  timeout: number,
): Promise<JsonObject | null> {
  const deadline = performance.now() / 1000 + Math.max(0, timeout);
  while (true) {
    const backend = backendFor(cid);
    const outcome = await api(
      "GET",
      backend.path(`/api/conversations/${backend.id}/spawn-outcome`),
    );
    if (outcome.status === "accepted" || outcome.status === "rejected") {
      await api(
        "POST",
        backend.path(`/api/conversations/${backend.id}/spawn-outcome/observe`),
      );
      return outcome;
    }
    if (performance.now() / 1000 >= deadline) return null;
    await Bun.sleep(50);
  }
}

async function cmdCreate(parsed: Parsed, stdout: string): Promise<string> {
  const titleRaw = parsed.options.get("--title");
  const title = cleanTitle(titleRaw);
  if (title === null)
    parserFailure(
      "--title is required; use a concise name like 'Review auth flow'",
    );
  const remote = parsed.options.get("--remote");
  if (typeof remote === "string") {
    if (parsed.options.has("--taken-over"))
      parserFailure("create", "--remote cannot be combined with --taken-over");
    if (
      ["--sibling", "--worktree", "--worktree-source", "--commit"].some(
        (flag) => parsed.options.has(flag),
      )
    )
      parserFailure(
        "--remote cannot be combined with sibling or worktree options",
      );
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const target = `${id}@${remote}`;
    const backend = backendFor(target);
    const req: JsonObject = { id, title, prompt: parsed.positional[0]! };
    const effort = parsed.options.get("--effort");
    if (typeof effort === "string") req.effort = Number(effort);
    await api("POST", backend.path("/api/conversations/spawn"), req);
    const outcome = await waitForSpawn(target, SPAWN_WAIT_SECONDS);
    if (outcome?.status === "rejected")
      throw new CliFailure(
        `Could not create ${target}: ${String(outcome.message)}\n`,
      );
    return `${stdout}Spawn ${outcome ? "accepted" : "queued"}: remote agent ${target}. No automatic parent report is sent.\n`;
  }
  const caller = process.env.RECURSE_AGENT_ID || null;
  const sibling = parsed.options.has("--sibling");
  let parent: unknown = caller;
  if (sibling && caller !== null) {
    const callerConv = await loadConv(caller);
    parent = callerConv.parent;
    if (parent !== null && typeof parent !== "string")
      parserFailure("the calling agent has an invalid parent");
  }
  const cid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  let workdir: string | null = null;
  const worktreeValue = parsed.options.get("--worktree");
  if (typeof worktreeValue === "string")
    workdir = await enterChildWorktree(
      worktreeValue,
      cid,
      parsed.options.get("--worktree-source") as string | undefined,
      parsed.options.get("--commit") as string | undefined,
    );
  const req: JsonObject = {
    id: cid,
    parent,
    title,
    prompt: parsed.positional[0]!,
  };
  const takenOver = parsed.options.has("--taken-over");
  if (takenOver) req.taken_over = true;
  if (workdir !== null) req.workdir = workdir;
  if (sibling) {
    req.sibling = true;
    req.creator = caller;
  }
  const effortRaw = parsed.options.get("--effort");
  const effort = typeof effortRaw === "string" ? Number(effortRaw) : undefined;
  if (effort !== undefined) req.effort = effort;
  try {
    await api("POST", "/api/conversations/spawn", req);
  } catch (error) {
    if (
      !(
        error instanceof CliFailure &&
        /timed out|TimeoutError/.test(error.message)
      )
    )
      throw error;
  }
  let timeout = Number(
    process.env.RECURSE_SPAWN_WAIT_SECONDS ?? SPAWN_WAIT_SECONDS,
  );
  if (Number.isNaN(timeout)) timeout = SPAWN_WAIT_SECONDS;
  timeout = Math.min(Math.max(timeout, 0), 15);
  const outcome = await waitForSpawn(cid, timeout);
  const picked = effort ? ` at effort level ${effort}` : "";
  const wtnote = workdir !== null ? ` in ${workdir}` : "";
  if (takenOver && outcome?.status !== "rejected")
    return `${stdout}Spawn ${outcome ? "accepted" : "queued"}: taken-over agent ${cid}${picked}${wtnote}; the operator controls it; its replies are not reported to you.\n`;
  if (outcome === null)
    return `${stdout}Spawn queued: subagent ${cid}${wtnote}. Please wait for the agent to spawn.\n`;
  if (outcome.status === "rejected") {
    const msg =
      typeof outcome.message === "string" && outcome.message
        ? outcome.message
        : "The spawn request was rejected. Retry after checking the parent.";
    throw new CliFailure(`Could not create subagent ${cid}: ${msg}\n`);
  }
  if (parent === null || parent === undefined) {
    const kind = sibling && caller ? "top-level sibling" : "top-level agent";
    return `${stdout}Spawn accepted: ${kind} ${cid}${picked}${wtnote}.\n`;
  }
  const kind = sibling ? "sibling" : "subagent";
  const destination = sibling ? `to parent ${parent}` : "back to you";
  return `${stdout}Spawn accepted: ${kind} ${cid} (parent ${parent})${picked}${wtnote}. Its final message will be delivered ${destination} when it finishes.\n`;
}

async function cmdSend(parsed: Parsed, stdout: string): Promise<string> {
  const [cid, message] = parsed.positional;
  if (cid!.includes("@")) {
    const [agent, label] = cid!.split("@");
    const unconfirmed = `Not confirmed: the connection to ${label} dropped during delivery; the message may have arrived. Check \`subagent messages ${agent}@${label}\` before resending.\n`;
    let result: JsonObject;
    try {
      result = await api(
        "POST",
        "/api/relay/messages",
        {
          target: cid,
          content: message,
          interrupt: parsed.options.has("--interrupt"),
        },
        Array.from({ length: 200 }, (_, i) => 400 + i),
      );
    } catch {
      return unconfirmed;
    }
    if (typeof result.id !== "string")
      return `Failed: ${String(result.detail ?? "delivery refused").replace(/\.$/, "")}.\n`;
    const deadline = performance.now() + 35_000;
    while (performance.now() < deadline) {
      let outcome: JsonObject;
      try {
        outcome = await api("GET", `/api/relay/messages/${result.id}`);
      } catch {
        return unconfirmed;
      }
      if (outcome.state === "delivered") return `Delivered to ${cid}.\n`;
      if (outcome.state === "failed")
        return `Failed: ${String(outcome.reason).replace(/\.$/, "")}.\n`;
      if (outcome.state === "unconfirmed") return unconfirmed;
      await Bun.sleep(250);
    }
    return unconfirmed;
  }
  try {
    await loadConv(cid!);
  } catch (error) {
    if (
      error instanceof CliFailure &&
      error.stderr.includes("Request failed (404)")
    ) {
      const address = await recentRemoteSender(cid!);
      if (address) {
        const label = address.split("@")[1]!;
        throw new CliFailure(
          `No local agent ${cid}; it messaged you from ${label}, so run: bun $RECURSE_SRC/tools/subagent.ts send ${address} "<message>"\n`,
        );
      }
    }
    throw error;
  }
  const interrupt = parsed.options.has("--interrupt");
  const delivered = await api("POST", `/api/conversations/${cid}/deliver`, {
    content: message,
    interrupt,
  });
  if (interrupt) {
    const action =
      delivered.interrupted === true
        ? "Stopped the running turn; the message will run next."
        : "There was no running turn to stop; the message will start fresh.";
    return `${stdout}Message delivered to agent ${cid}. ${action} The turn's reply will be delivered to its parent when it finishes; use \`messages <id>\` for the full transcript meanwhile.\n`;
  }
  return `${stdout}Message delivered to agent ${cid}; it will pick it up within a moment. The turn's reply will be delivered to its parent when it finishes; use \`messages <id>\` for the full transcript meanwhile.\n`;
}

async function cmdInterrupt(parsed: Parsed, stdout: string): Promise<string> {
  const cid = parsed.positional[0]!;
  const conv = await loadConv(cid);
  const target = activeRunId(conv);
  if (conv.status !== "running" || !target) {
    return `${stdout}Agent ${cid} has no running turn to interrupt (status: ${conv.status ?? "unknown"}).\n`;
  }
  const backend = backendFor(cid);
  await api("POST", backend.path(`/api/conversations/${backend.id}/deliver`), {
    run_id: target,
    stop_id: crypto.randomUUID().replaceAll("-", ""),
  });
  return `${stdout}Interrupt accepted for agent ${cid}, run ${codePointSlice(String(target), 8)}; status: stopping. Background cleanup completion/failure will appear as a platform record in the target thread; no replacement turn starts.\n`;
}

async function loadAllConvs(): Promise<Map<string, JsonObject>> {
  const payload = await api("GET", "/api/subagent-tool/conversations");
  if (!Array.isArray(payload.conversations))
    systemFailure("The running instance returned an invalid agent index.");
  const out = new Map<string, JsonObject>();
  for (const row of payload.conversations) {
    if (!isObject(row) || typeof row.id !== "string")
      systemFailure("The running instance returned an invalid agent index.");
    out.set(row.id, row);
  }
  return out;
}

function descendantIds(
  convs: Map<string, JsonObject>,
  cid: string,
): Set<string> {
  const kids = new Map<string, string[]>();
  for (const conv of convs.values()) {
    const parent = conv.parent;
    if (!pyTruthy(parent)) continue;
    if (typeof parent !== "string" || typeof conv.id !== "string")
      systemFailure("The running instance returned an invalid agent index.");
    const rows = kids.get(parent) ?? [];
    rows.push(conv.id);
    kids.set(parent, rows);
  }
  const seen = new Set([cid]);
  const stack = [...(kids.get(cid) ?? [])];
  const out = new Set<string>();
  while (stack.length) {
    const child = stack.pop()!;
    if (seen.has(child)) continue;
    seen.add(child);
    out.add(child);
    stack.push(...(kids.get(child) ?? []));
  }
  return out;
}

async function cmdMove(parsed: Parsed, stdout: string): Promise<string> {
  const cid = parsed.positional[0]!;
  const newParent = parsed.options.get("--to") as string;
  if (newParent === cid)
    throw new CliFailure("Cannot move an agent under itself.\n");
  const convs = await loadAllConvs();
  if (!convs.has(cid)) throw new CliFailure(`No such agent '${cid}'.\n`);
  if (!convs.has(newParent))
    throw new CliFailure(`No such target agent '${newParent}'.\n`);
  if (descendantIds(convs, cid).has(newParent)) {
    throw new CliFailure(
      `Cannot move '${cid}' under its own descendant '${newParent}' (would create a cycle).\n`,
    );
  }
  if (convs.get(cid)!.parent === newParent)
    return `${stdout}Agent ${cid} is already a child of ${newParent}; nothing to do.\n`;
  await api("POST", `/api/conversations/${cid}/reparent`, {
    parent: newParent,
  });
  return `${stdout}Move requested: agent ${cid} (and its subtree) will be re-parented under ${newParent}; its worktree is unchanged.\n`;
}

function targetLabel(conv: JsonObject): string {
  const title = conv.title;
  return typeof title === "string" && pythonStrip(title)
    ? `${String(conv.id)} (${codePointSlice(pythonStrip(title), 256)})`
    : String(conv.id);
}

async function resolveTarget(
  target: string,
  optional = false,
): Promise<JsonObject | null> {
  const convs = await loadAllConvs();
  const unique = (matches: JsonObject[], kind: string): JsonObject | null => {
    if (!matches.length) return null;
    if (matches.length > 1) {
      const names = matches.map(targetLabel).sort().join(", ");
      parserFailure(`ambiguous ${kind} '${target}': ${names}`);
    }
    return matches[0]!;
  };
  const exact = convs.get(target);
  if (exact) return exact;
  const active = unique(
    [...convs.values()].filter((conv) => conv.session_id === target),
    "active session id",
  );
  if (active) return active;
  const named = unique(
    [...convs.values()].filter(
      (conv) =>
        typeof conv.title === "string" && pythonStrip(conv.title) === target,
    ),
    "session name",
  );
  if (named) return named;
  const suffix = unique(
    [...convs.values()].filter(
      (conv) => typeof conv.id === "string" && conv.id.endsWith(target),
    ),
    "id suffix",
  );
  if (suffix) return suffix;
  if (optional) return null;
  parserFailure(`no agent or active Pi session matches '${target}'`);
}

function clip(text: string, limit: number): [string, boolean] {
  const points = Array.from(text);
  return points.length <= limit
    ? [text, false]
    : [points.slice(0, limit).join(""), true];
}

function oneLine(value: string, limit: number): string {
  return codePointSlice(pythonStrip(value.split("\n", 1)[0]!), limit);
}

function textBlocks(content: unknown): string[] | null {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) return null;
    if (block.type === "text") {
      const text = block.text ?? "";
      if (typeof text !== "string") return null;
      parts.push(text);
    }
  }
  return parts;
}

function toolCalls(content: unknown): JsonObject[] | null {
  if (content === null || content === undefined || !Array.isArray(content))
    return [];
  const calls: JsonObject[] = [];
  for (const block of content) {
    if (!isObject(block)) return null;
    if (block.type === "toolCall") calls.push(block);
  }
  return calls;
}

function comparePythonStrings(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function pythonJsonDumps(
  value: unknown,
  parent?: object,
  key?: string,
): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return pythonNumberText(value, parent, key);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => pythonJsonDumps(item, value, String(index)))
      .join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort(comparePythonStrings)
      .map(
        (name) =>
          `${JSON.stringify(name)}:${pythonJsonDumps(value[name], value, name)}`,
      )
      .join(",")}}`;
  }
  throw new TypeError("value is not JSON serializable");
}

function shortValue(
  value: unknown,
  limit = 60,
  parent?: object,
  key?: string,
): string {
  if (typeof value === "string") return oneLine(value, limit);
  let rendered: string;
  try {
    rendered = pythonJsonDumps(value, parent, key);
  } catch {
    rendered = pythonStr(value, parent, key);
  }
  return oneLine(rendered, limit);
}

function summarizeArgs(
  argumentsValue: unknown,
  parent?: object,
  key?: string,
): string {
  if (argumentsValue === null || argumentsValue === undefined) return "";
  if (typeof argumentsValue === "string") {
    const stripped = pythonStrip(argumentsValue);
    if (stripped.startsWith("{")) {
      try {
        const parsed: unknown = jsonParse(stripped);
        if (isObject(parsed)) return summarizeArgs(parsed);
      } catch {}
    }
    return oneLine(stripped, MSG_ARGS_CHARS);
  }
  if (isObject(argumentsValue)) {
    const command = argumentsValue.command;
    if (typeof command === "string" && pythonStrip(command))
      return oneLine(command, MSG_ARGS_CHARS);
    const pairs = Object.keys(argumentsValue)
      .slice(0, 6)
      .map(
        (name) =>
          `${name}=${shortValue(argumentsValue[name], 60, argumentsValue, name)}`,
      );
    return oneLine(pairs.join(", "), MSG_ARGS_CHARS);
  }
  return oneLine(pythonStr(argumentsValue, parent, key), MSG_ARGS_CHARS);
}

function entryTimestamp(entry: JsonObject): unknown {
  const ts = entry.timestamp;
  if (typeof ts === "string") return Array.from(ts).length <= 128 ? ts : null;
  if (typeof ts === "boolean" || typeof ts !== "number" || !Number.isFinite(ts))
    return null;
  return Math.abs(ts) <= 10 ** 15 ? ts : null;
}

function assistantCallBlocks(entry: JsonObject): JsonObject[] {
  if (
    entry.type !== "message" ||
    !isObject(entry.message) ||
    entry.message.role !== "assistant"
  )
    return [];
  const calls = toolCalls(entry.message.content);
  return calls ?? [];
}

type Row = [number, JsonObject];
function resultName(
  message: JsonObject,
  callNames: Map<string, string>,
  callOrder: Array<[number, string]>,
  idx: number,
): string {
  const callId = message.toolCallId;
  if (typeof callId === "string" && callNames.has(callId))
    return callNames.get(callId)!;
  let name = "unknown";
  for (const [callIdx, callName] of callOrder) {
    if (callIdx < idx) name = callName;
    else break;
  }
  return name;
}

function renderUser(
  message: JsonObject,
  off: number,
  ts: unknown,
  full = false,
): JsonObject[] {
  const texts = textBlocks(message.content);
  if (texts === null) return [];
  const [text, cut] = clip(texts.join(""), full ? Infinity : MSG_TEXT_CHARS);
  const line: JsonObject = { off, ts, role: "user", text };
  if (cut) line.truncated = true;
  return [line];
}

function renderAssistant(
  message: JsonObject,
  off: number,
  ts: unknown,
  full = false,
): JsonObject[] {
  const texts = textBlocks(message.content);
  const calls = toolCalls(message.content);
  if (texts === null || calls === null) return [];
  const out: JsonObject[] = [];
  const [text, cut] = clip(texts.join(""), full ? Infinity : MSG_TEXT_CHARS);
  if (text) {
    const line: JsonObject = { off, ts, role: "assistant", text };
    if (cut) line.truncated = true;
    out.push(line);
  }
  for (const call of calls) {
    const name = call.name;
    out.push({
      off,
      ts,
      role: "tool",
      tool: typeof name === "string" && name ? name : "unknown",
      args: full
        ? pythonJsonDumps(call.arguments ?? null, call, "arguments")
        : summarizeArgs(call.arguments, call, "arguments"),
    });
  }
  return out;
}

function renderResult(
  message: JsonObject,
  off: number,
  ts: unknown,
  idx: number,
  callNames: Map<string, string>,
  callOrder: Array<[number, string]>,
  full = false,
): JsonObject[] {
  const texts = textBlocks(message.content);
  if (texts === null) return [];
  return [
    {
      off,
      ts,
      role: "tool",
      tool: resultName(message, callNames, callOrder, idx),
      text: full ? texts.join("") : oneLine(texts.join(""), MSG_LINE_CHARS),
    },
  ];
}

function renderEntry(
  entry: JsonObject,
  off: number,
  idx: number,
  callNames: Map<string, string>,
  callOrder: Array<[number, string]>,
  results: boolean,
  full = false,
): JsonObject[] {
  const ts = entryTimestamp(entry);
  if (!isObject(entry.message)) return [];
  const message = entry.message;
  if (message.role === "user") return renderUser(message, off, ts, full);
  if (message.role === "assistant")
    return renderAssistant(message, off, ts, full);
  if (message.role === "toolResult" && results)
    return renderResult(message, off, ts, idx, callNames, callOrder, full);
  return [];
}

function renderWindow(rows: Row[], results = true, full = false): JsonObject[] {
  const callNames = new Map<string, string>();
  const callOrder: Array<[number, string]> = [];
  rows.forEach(([, entry], idx) => {
    for (const call of assistantCallBlocks(entry)) {
      if (typeof call.name !== "string" || !call.name) continue;
      callOrder.push([idx, call.name]);
      if (typeof call.id === "string" && call.id && !callNames.has(call.id))
        callNames.set(call.id, call.name);
    }
  });
  const out: JsonObject[] = [];
  rows.forEach(([off, entry], idx) =>
    out.push(
      ...renderEntry(entry, off, idx, callNames, callOrder, results, full),
    ),
  );
  return out;
}

function fmtElapsed(value: unknown): string {
  if (
    typeof value === "boolean" ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  )
    return "?";
  const total = Math.trunc(value);
  if (total < 60) return `${total}s`;
  let minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m${secs}s`;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return `${hours}h${minutes}m`;
}

/** The background-shell lines of tail, from the instance's index row. */
function shellMetaLines(shells: unknown): JsonObject[] {
  const base: JsonObject = { off: 0, ts: null, role: "meta", tool: "shell" };
  if (!Array.isArray(shells))
    return [{ ...base, text: "(background shells unavailable)" }];
  const rows = shells.filter(isObject).slice(0, 20);
  if (!rows.length) return [{ ...base, text: "(none)" }];
  return rows.map((item) => ({
    ...base,
    text: `${typeof item.id === "string" ? item.id : "?"} (${typeof item.mode === "string" ? item.mode : "?"}, ${fmtElapsed(item.elapsed_seconds)}) ${typeof item.command === "string" ? oneLine(item.command, 200) : ""}`.trim(),
  }));
}

function selectExchange(rows: Row[]): Row[] {
  for (let idx = rows.length - 1; idx >= 0; idx--) {
    const entry = rows[idx]![1];
    if (
      entry.type === "message" &&
      isObject(entry.message) &&
      entry.message.role === "user"
    )
      return rows.slice(idx);
  }
  return rows.length ? rows.slice(-MSG_TAIL_FALLBACK_ENTRIES) : [];
}

type Window = { rows: Row[]; prev: number; next: number };

/** One transcript window of `cid` from the running instance. */
async function transcript(
  cid: string,
  query: Record<string, number | undefined>,
): Promise<Window> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query))
    if (value !== undefined) params.set(name, String(value));
  const backend = backendFor(cid);
  const path = backend.path(
    `/api/subagent-tool/conversations/${encodeURIComponent(backend.id)}/transcript?${params}`,
  );
  return (await api("GET", path)) as unknown as Window;
}

/** Find trusted sender headers in one bounded recent transcript page. */
async function recentRemoteSender(cid: string): Promise<string | null> {
  const caller = process.env.RECURSE_AGENT_ID;
  if (!caller) return null;
  try {
    const page = await transcript(caller, { limit: 50 });
    for (const [, entry] of page.rows.reverse()) {
      if (!isObject(entry.message) || entry.message.role !== "user") continue;
      const text = textBlocks(entry.message.content)?.join("\n") ?? "";
      for (const match of text.matchAll(
        /^\[recurse-from: ([A-Za-z0-9][A-Za-z0-9_-]{0,127})@([A-Za-z0-9._-]{1,32})\]$/gm,
      )) {
        if (match[1] === cid) return `${cid}@${match[2]}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

const userRow = ([, entry]: Row) =>
  isObject(entry.message) && entry.message.role === "user";

async function emitTail(
  conv: JsonObject,
  target = String(conv.id),
): Promise<{ stdout: string; stderr: string }> {
  const workdir = String(conv.workdir || "(unknown)");
  let stdout = jsonLine({
    off: 0,
    ts: null,
    role: "meta",
    tool: "cwd",
    text: workdir,
  });
  for (const line of shellMetaLines(conv.shells)) stdout += jsonLine(line);
  stdout += jsonLine({
    off: 0,
    ts: null,
    role: "meta",
    tool: "commit",
    text: backendFor(target).remote
      ? "(remote)"
      : await lastCommitText(workdir),
  });
  let rows: Row[] = [];
  try {
    let before: number | undefined;
    for (let page = 0; page < MSG_TAIL_PAGES; page++) {
      const got = await transcript(target, { limit: 50, before });
      rows = [...got.rows, ...rows];
      if (got.rows.some(userRow) || got.prev <= 0 || got.prev === before) break;
      before = got.prev;
    }
  } catch (error) {
    if (!(error instanceof CliFailure)) throw error;
    const reason = pythonStrip(error.stderr.split("\n", 1)[0]!);
    return { stdout, stderr: `(tail: ${reason} — showing context only)\n` };
  }
  for (const line of renderWindow(selectExchange(rows), false))
    stdout += jsonLine(line);
  return { stdout, stderr: "" };
}

async function cmdMessages(parsed: Parsed, stdout: string): Promise<Output> {
  const limitRaw = parsed.options.get("--limit");
  const limit = typeof limitRaw === "string" ? Number(limitRaw) : 20;
  if (limit < 1 || limit > 50)
    parserFailure("messages --limit must be between 1 and 50");
  const beforeRaw = parsed.options.get("--before");
  const afterRaw = parsed.options.get("--after");
  if (beforeRaw !== undefined && afterRaw !== undefined)
    parserFailure("messages --before and --after are exclusive");
  const before = typeof beforeRaw === "string" ? Number(beforeRaw) : undefined;
  const after = typeof afterRaw === "string" ? Number(afterRaw) : undefined;
  if (before !== undefined && before < 0)
    parserFailure("messages --before must be a cursor (0 or more)");
  if (after !== undefined && after < 0)
    parserFailure("messages --after must be a cursor (0 or more)");
  const target = parsed.positional[0]!;
  let result: Window;
  if (target.includes("@")) {
    const match =
      /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})@([A-Za-z0-9._-]{1,32})$/.exec(target);
    if (!match) systemFailure("invalid remote target");
    const query = new URLSearchParams({ limit: String(limit) });
    if (before !== undefined) query.set("before", String(before));
    if (after !== undefined) query.set("after", String(after));
    result = await api<Window>(
      "GET",
      `/api/relay/transcript/${match[2]}/${match[1]}?${query}`,
    );
  } else {
    const conv = await resolveTarget(target, true);
    if (conv)
      result = await transcript(String(conv.id), { limit, before, after });
    else {
      const { archiveMessages } = await import("./_archive_messages");
      try {
        result = await archiveMessages(DATA, target, { limit, before, after });
      } catch (error) {
        parserFailure(error instanceof Error ? error.message : String(error));
      }
    }
  }
  for (const line of renderWindow(
    result.rows,
    true,
    parsed.options.has("--full"),
  ))
    stdout += jsonLine(line);
  const stderr = `prev: ${result.prev}\nnext: ${result.next}\n`;
  return { code: 0, stdout, stderr };
}

async function cmdTail(parsed: Parsed, stdout: string): Promise<Output> {
  const target = parsed.positional[0]!;
  const conv = backendFor(target).remote
    ? await loadConv(target)
    : (await resolveTarget(target))!;
  const result = await emitTail(
    conv,
    backendFor(target).remote ? target : String(conv.id),
  );
  return { code: 0, stdout: stdout + result.stdout, stderr: result.stderr };
}

function resolveWaitCids(
  convs: Map<string, JsonObject>,
  cids: string[],
): string[] {
  const resolved: string[] = [];
  for (const cid of cids) {
    if (convs.has(cid)) {
      resolved.push(cid);
      continue;
    }
    const matches = [...convs.keys()]
      .filter((candidate) => candidate.endsWith(cid))
      .sort();
    if (matches.length === 1) resolved.push(matches[0]!);
    else if (!matches.length) parserFailure(`no agent matches '${cid}'`);
    else parserFailure(`ambiguous id suffix '${cid}': ${matches.join(", ")}`);
  }
  return resolved;
}

async function cmdWait(parsed: Parsed, stdout: string): Promise<Output> {
  const timeoutRaw = parsed.options.get("--timeout");
  const timeout =
    typeof timeoutRaw === "string" ? parseFloatPython(timeoutRaw) : 300;
  if (!(WAIT_TIMEOUT_MIN <= timeout && timeout <= WAIT_TIMEOUT_MAX))
    parserFailure("wait --timeout must be between 1 and 86400 seconds");
  const locals = parsed.positional.filter((cid) => !backendFor(cid).remote);
  const localResolved = locals.length
    ? resolveWaitCids(await loadAllConvs(), locals)
    : [];
  let localIndex = 0;
  const resolved = parsed.positional.map((cid) =>
    backendFor(cid).remote ? cid : localResolved[localIndex++]!,
  );
  const snapshots = async () => {
    const index = locals.length
      ? await loadAllConvs()
      : new Map<string, JsonObject>();
    for (const cid of resolved.filter((target) => backendFor(target).remote)) {
      const backend = backendFor(cid);
      const row = await api(
        "GET",
        backend.path(`/api/conversations/${backend.id}`),
        undefined,
        [404],
      );
      if (row.id) index.set(cid, row);
    }
    return index;
  };
  const deadline = performance.now() / 1000 + Math.max(0, timeout);
  let finished: string | null = null;
  while (true) {
    const index = await snapshots();
    for (const cid of resolved) {
      if (index.get(cid)?.status !== "running") {
        finished = cid;
        break;
      }
    }
    if (finished !== null) break;
    const now = performance.now() / 1000;
    if (now >= deadline) break;
    await Bun.sleep(
      Math.min(WAIT_POLL_SECONDS, Math.max(0, deadline - now)) * 1000,
    );
  }
  if (finished === null)
    throw new CliFailure(
      `Timed out after ${timeout.toLocaleString("en-US", { useGrouping: false })}s waiting for ${resolved.join(", ")} to finish.\n`,
    );
  const live = (await snapshots()).get(finished);
  if (!live)
    return {
      code: 0,
      stdout:
        stdout +
        jsonLine({
          off: 0,
          ts: null,
          role: "meta",
          tool: "status",
          text: `agent ${finished} is gone`,
        }),
      stderr: "",
    };
  const tail = await emitTail(live, finished);
  return { code: 0, stdout: stdout + tail.stdout, stderr: tail.stderr };
}

async function cmdRm(parsed: Parsed, stdout: string): Promise<string> {
  const convs = parsed.positional.some((cid) => !backendFor(cid).remote)
    ? await loadAllConvs()
    : new Map<string, JsonObject>();
  for (const cid of parsed.positional) {
    for (const candidate of [cid, ...[...descendantIds(convs, cid)].sort()]) {
      const conv = convs.get(candidate);
      if (!conv || conv.pinned !== true) continue;
      const title = conv.title;
      const label =
        typeof title === "string" && title
          ? `${candidate} ("${title}")`
          : candidate;
      throw new CliFailure(
        `Agent ${label} is taken over by the operator; only the operator can delete it.\n`,
      );
    }
  }
  for (const cid of parsed.positional) {
    const backend = backendFor(cid);
    try {
      await api("DELETE", backend.path(`/api/conversations/${backend.id}`));
    } catch (error) {
      if (error instanceof CliFailure && error.message.includes("(404)")) {
        if (!backend.remote)
          requestReapSweep(rootFromEnv(process.env.WORKTREE_ROOT || DATA), [
            cid,
          ]);
        stdout += `Agent ${cid} is already gone.\n`;
        continue;
      }
      if (error instanceof CliFailure) {
        throw new CliFailure(error.message, error.code, stdout, error.stderr);
      }
      throw error;
    }
    if (!backend.remote)
      requestReapSweep(rootFromEnv(process.env.WORKTREE_ROOT || DATA), [
        cid,
        ...descendantIds(convs, cid),
      ]);
    const revive =
      convs.get(cid)?.backend === "durable"
        ? ` Revive the agent via subagent revive ${cid}.`
        : "";
    stdout += `Reap requested: agent ${cid} (and its subtree) will be deleted.${revive}\n`;
  }
  return stdout;
}

async function cmdRevive(parsed: Parsed, stdout: string): Promise<string> {
  const from = parsed.options.get("--from");
  const target = parsed.positional[0]!;
  const parentOption = parsed.options.get("--parent");
  const parent = parsed.options.has("--top-level")
    ? null
    : typeof parentOption === "string"
      ? parentOption
      : process.env.RECURSE_AGENT_ID || null;
  const result = await api(
    "POST",
    "/api/agent-archive/revive",
    {
      ...(from === undefined ? { target } : { from: resolve(String(from)) }),
      parent,
    },
    [404, 409, 410, 422],
  );
  const refusal = result.detail;
  if (refusal !== undefined) {
    const detail = isObject(refusal)
      ? refusal
      : { message: `Could not revive '${target}': ${String(refusal)}` };
    const rows = Array.isArray(detail.candidates) ? detail.candidates : [];
    const lines = rows
      .filter(isObject)
      .map(
        (row) =>
          `  ${String(row.archive_id)}  ${String(row.title ?? row.cid)} (${row.top_level ? "top-level" : `subagent of ${String(row.parent_title ?? row.parent)}`}, ${String(row.reason)})`,
      );
    throw new CliFailure([String(detail.message), ...lines, ""].join("\n"));
  }
  const where = result.parent ? `under ${String(result.parent)}` : "top level";
  const notes = Array.isArray(result.notes) ? result.notes.map(String) : [];
  return `${stdout}Revived: agent ${String(result.id)} (${String(result.title ?? "")}) ${where} in ${String(result.workdir)}, with its history; it starts no turn until messaged.\n${notes.map((note) => `${note}\n`).join("")}`;
}

async function execute(args: string[]): Promise<Output> {
  let parsed: Parsed;
  try {
    parsed = parseArguments(args);
  } catch (error) {
    if (error instanceof CliFailure && error.code === 0)
      return { code: 0, stdout: error.message, stderr: "" };
    throw error;
  }
  let stdout = "";
  if (["move", "revive"].includes(parsed.command)) {
    const targets = parsed.command === "create" ? [] : parsed.positional;
    if (
      targets.some((value) => value.includes("@")) ||
      String(parsed.options.get("--to") ?? "").includes("@") ||
      String(parsed.options.get("--parent") ?? "").includes("@")
    )
      systemFailure(`${parsed.command} does not support remote targets`);
  }
  switch (parsed.command) {
    case "backends": {
      const [action, label, url] = parsed.positional;
      if (action === "add" && label && url && parsed.positional.length === 3) {
        await api("POST", "/api/backends", { label, url });
        stdout = `Backend ${label} (${url}) needs sign-in: ask the operator to enter its password in Settings → Remotes.\n`;
      } else if (action === "list" && parsed.positional.length === 1) {
        const rows = await api<JsonObject[]>("GET", "/api/backends");
        stdout = rows
          .map(
            (r) =>
              `${r.label} ${r.url} ${r.state} · ${r.reason ?? "—"} · Last contact ${r.last_contact ?? "never"}\n`,
          )
          .join("");
      } else parserFailure("backends", "expected add <label> <url> or list");
      return { code: 0, stdout, stderr: "" };
    }
    case "create":
      stdout = await cmdCreate(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "send":
      stdout = await cmdSend(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "interrupt":
      stdout = await cmdInterrupt(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "move":
      stdout = await cmdMove(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "rm":
      stdout = await cmdRm(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "revive":
      stdout = await cmdRevive(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "messages":
      return await cmdMessages(parsed, stdout);
    case "tail":
      return await cmdTail(parsed, stdout);
    case "wait":
      return await cmdWait(parsed, stdout);
    default:
      throw new Error(`unknown command ${parsed.command}`);
  }
}

async function main(): Promise<void> {
  let output: Output;
  try {
    output = await execute(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliFailure)
      output = { code: error.code, stdout: error.stdout, stderr: error.stderr };
    else
      output = {
        code: 1,
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
  }
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  process.exitCode = output.code;
}

if (import.meta.main) await main();

export { renderWindow, summarizeArgs, fmtElapsed, selectExchange };
