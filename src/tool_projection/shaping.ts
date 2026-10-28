// Shape only allowlisted read-only shell commands, resolving relative cd paths.
// Unknown commands return null; even recognized filenames remain untrusted
// and must pass redaction before display.

import {
  containsSecret,
  isPythonWhitespace,
  shellSplit,
  WINDOWS_DRIVE_RE,
} from "./redaction";

const READ_PIPE_HELPERS = new Set(["head", "tail", "wc", "cut", "tr"]);
const READ_CAT_PROGRAMS = new Set([
  "cat",
  "bat",
  "batcat",
  "less",
  "more",
  "nl",
]);
const SED_RANGE_RE = /^\p{Nd}+(?:,\p{Nd}+)?p$/u;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*$/u;
const SECRET_KEY_RE = /(?:token|key|secret|password|auth)/iu;
const AWK_PRINT_RE =
  /^[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*(?:\{[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*)?print(?:[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|;|\}|$)/u;
const GC_FLAGS = new Set(["-raw", "-path", "-literalpath"]);
const UNIX_REJECT = new Set([
  "$",
  "`",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  "(",
  ")",
  "<",
  ">",
  "|",
  "&",
  ";",
  "!",
  "'",
  '"',
  "#",
]);
const GC_PATH_REJECT = new Set([
  "[",
  "]",
  "(",
  ")",
  "`",
  ";",
  "|",
  "&",
  ">",
  "<",
  "{",
  "}",
]);

function programBasename(token: string): string {
  return token.replace(/\\/gu, "/").split("/").at(-1)!;
}

/** Split on unquoted shell operators while leaving quoted text intact. */
function splitUnquoted(text: string, pipes: boolean): string[] {
  const chunks: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < chars.length)
        current += chars[++i]!;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "\\" && i + 1 < chars.length) {
      current += ch + chars[++i]!;
    } else if (!pipes && (ch === "&" || ch === "|") && chars[i + 1] === ch) {
      chunks.push(current);
      current = "";
      i += 1;
    } else if (
      (!pipes && (ch === "\n" || ch === ";" || ch === "&")) ||
      (pipes && ch === "|")
    ) {
      chunks.push(current);
      current = "";
    } else current += ch;
  }
  chunks.push(current);
  return chunks;
}

function stripEnvAssignments(tokens: string[]): string[] | null {
  let start = 0;
  while (start < tokens.length && ENV_ASSIGN_RE.test(tokens[start]!)) {
    if (SECRET_KEY_RE.test(tokens[start]!.split("=", 1)[0]!)) return null;
    start += 1;
  }
  return tokens.slice(start);
}

function plainPath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.startsWith("-")) return null;
  if (
    Array.from(value).some(
      (char) => isPythonWhitespace(char) || UNIX_REJECT.has(char),
    )
  )
    return null;
  return value;
}

function singleFileTarget(args: string[]): string | null {
  const operands = args.filter((arg) => arg !== "--");
  return operands.length === 1 ? plainPath(operands[0]) : null;
}

function headTailTarget(program: string, args: string[]): string | null {
  const valueRe = program === "tail" ? /^\+?\p{Nd}+$/u : /^\p{Nd}+$/u;
  const operands: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-n") {
      i += 1;
      if (i >= args.length || !valueRe.test(args[i]!)) return null;
    } else if (arg.startsWith("-n") && arg.length > 2) {
      if (!valueRe.test(arg.slice(2))) return null;
    } else if (
      /^[+-]\p{Nd}+$/u.test(arg) &&
      (program === "tail" || arg.startsWith("-"))
    ) {
      // Invariant: Legacy -N / +N line-count forms.
    } else {
      operands.push(arg, ...args.slice(i + 1));
      break;
    }
    i += 1;
  }
  return operands.length === 1 ? plainPath(operands[0]) : null;
}

function awkTarget(args: string[]): string | null {
  const operands: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "-F") {
      i += 1;
      if (i >= args.length) return null;
    } else if (arg.startsWith("-F") && arg.length > 2) {
      // Invariant: Field separator is part of the allow-list.
    } else if (arg.startsWith("-")) return null;
    else operands.push(arg);
    i += 1;
  }
  if (operands.length !== 2) return null;
  const program = operands[0]!;
  if (
    /[><|`]|\b(?:system|getline)\b/u.test(program) ||
    !AWK_PRINT_RE.test(program)
  )
    return null;
  return plainPath(operands[1]);
}

function sedTarget(args: string[]): string | null {
  let seenN = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === "-n") seenN = true;
    else if (arg.startsWith("-")) return null;
    else operands.push(arg);
  }
  if (!seenN || operands.length !== 2 || !SED_RANGE_RE.test(operands[0]!))
    return null;
  return plainPath(operands[1]);
}

function getContentTarget(args: string[]): string | null {
  const positionals: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!GC_FLAGS.has(arg.toLowerCase())) return null;
    } else positionals.push(arg);
  }
  if (positionals.length !== 1) return null;
  const target = positionals[0]!;
  if (
    !target ||
    Array.from(target).some(
      (ch) => isPythonWhitespace(ch) || GC_PATH_REJECT.has(ch),
    )
  )
    return null;
  return target;
}

function readStageTarget(tokens: string[]): string | null {
  const rest = stripEnvAssignments([...tokens]);
  if (rest === null || !rest.length) return null;
  const program = programBasename(rest[0]!);
  const args = rest.slice(1);
  if (["get-content", "gc"].includes(program.toLowerCase()))
    return getContentTarget(args);
  if (READ_CAT_PROGRAMS.has(program)) return singleFileTarget(args);
  if (["head", "tail"].includes(program)) return headTailTarget(program, args);
  if (program === "awk") return awkTarget(args);
  if (program === "sed") return sedTarget(args);
  return null;
}

function posixNormpath(path: string): string {
  if (!path) return ".";
  let initialSlashes = path.startsWith("/") ? 1 : 0;
  if (initialSlashes && path.startsWith("//") && !path.startsWith("///"))
    initialSlashes = 2;
  const components: string[] = [];
  for (const component of path.split("/")) {
    if (!component || component === ".") continue;
    if (component === ".." && components.length && components.at(-1) !== "..")
      components.pop();
    else if (component !== ".." || initialSlashes === 0)
      components.push(component);
  }
  let normalized =
    (initialSlashes === 2 ? "//" : initialSlashes ? "/" : "") +
    components.join("/");
  if (!normalized) normalized = initialSlashes ? "/" : ".";
  return normalized;
}

function resolveCd(
  rest: string[],
  loneStage: boolean,
  cwd: string,
): ["cd" | "other", null, string] | null {
  if (programBasename(rest[0]!) !== "cd" || !loneStage) return null;
  if (rest.length > 2) return ["other", null, cwd];
  if (rest.length === 1) return ["cd", null, cwd];
  const dest = rest[1]!;
  if (
    !dest ||
    dest.startsWith("-") ||
    Array.from(dest).some(
      (char) => isPythonWhitespace(char) || UNIX_REJECT.has(char),
    )
  )
    return ["other", null, cwd];
  if (dest.startsWith("/") || dest.startsWith("~"))
    return ["cd", null, posixNormpath(dest)];
  return ["cd", null, posixNormpath(cwd ? `${cwd}/${dest}` : dest)];
}

function resolveSingleStage(
  remaining: string[][],
  loneStage: boolean,
  cwd: string,
): ["cd" | "read" | "other", string | null, string] {
  const tokens = remaining[0]!;
  const rest = stripEnvAssignments([...tokens]);
  if (rest === null || !rest.length) return ["other", null, cwd];
  const resolvedCd = resolveCd(rest, loneStage, cwd);
  if (resolvedCd !== null) return resolvedCd;
  const target = readStageTarget(tokens);
  if (target === null) return ["other", null, cwd];
  if (target.startsWith("/") || target.startsWith("~"))
    return ["read", posixNormpath(target), cwd];
  if (target.startsWith("\\") || WINDOWS_DRIVE_RE.test(target))
    return ["read", target, cwd];
  return ["read", posixNormpath(cwd ? `${cwd}/${target}` : target), cwd];
}

function classifySegment(
  segment: string,
  cwd: string,
): ["cd" | "read" | "other", string | null, string] {
  const tokenLists: string[][] = [];
  for (const stage of splitUnquoted(segment, true)) {
    const tokens = shellSplit(stage);
    if (tokens === null || !tokens.length) return ["other", null, cwd];
    tokenLists.push(tokens);
  }
  const remaining: string[][] = [];
  const helper = tokenLists.length > 1;
  for (const tokens of tokenLists) {
    const rest = stripEnvAssignments([...tokens]);
    if (rest === null || !rest.length) return ["other", null, cwd];
    const name = programBasename(rest[0]!);
    if (name === "sudo") return ["other", null, cwd];
    if (helper && READ_PIPE_HELPERS.has(name)) continue;
    remaining.push(tokens);
  }
  if (remaining.length !== 1) return ["other", null, cwd];
  return resolveSingleStage(remaining, tokenLists.length === 1, cwd);
}

/** The one file a shell command only reads, or null when it does more. */
export function bashReadTarget(command: unknown): string | null {
  if (
    typeof command !== "string" ||
    !Array.from(command).some((ch) => !isPythonWhitespace(ch)) ||
    containsSecret(command)
  )
    return null;
  let cwd = "";
  let found: string | null = null;
  for (const segment of splitUnquoted(command, false)) {
    if (!segment.trim()) continue;
    const [kind, value, nextCwd] = classifySegment(segment, cwd);
    cwd = nextCwd;
    if (kind === "cd") continue;
    if (kind !== "read" || found !== null) return null;
    found = value;
  }
  return found;
}
