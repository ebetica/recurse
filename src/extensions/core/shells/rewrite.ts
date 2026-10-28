// Conservative shell hygiene removes timeout, atomic trailing head/tail and
// stream merges. Unknown/unbalanced/compound syntax stays untouched and silent;
// teaching fires only for actual removals. Quoted spans, substitutions and
// trailing comments stay intact.

export const SYSTEM_REMINDER_OPEN = "<system_reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system_reminder>";

/** Wrap guidance so it renders distinctly from command output or content. */
export function wrapSystemReminder(note: string): string {
  const text = note.replace(/^\n+|\n+$/g, "");
  if (
    /^<system[_-]reminder>/.test(text.trim()) &&
    /<\/system[_-]reminder>$/.test(text.trim())
  )
    return text;
  return `${SYSTEM_REMINDER_OPEN}\n${text}\n${SYSTEM_REMINDER_CLOSE}`;
}

/** Short teaching injected after a rewrite. */
export const HYGIENE_TEACHING =
  "Prefer backgrounded shells and parsing logs over timeouts, head/tail pipes, and output redirects: " +
  "the runner already backgrounds long commands and merges stdout/stderr into the log.";

export interface RewriteResult {
  command: string;
  rewritten: boolean;
  /** Whether the rewrite removed anything before spawn. */
  dropped: boolean;
}

type Token =
  | { kind: "word"; value: string; start: number; end: number }
  | { kind: "op"; value: string; start: number; end: number };

const DURATION_RE = /^[0-9]+(\.[0-9]+)?(s|m|h|d)?$/;
const COUNT_RE = /^[0-9]+$/;

/** Skip a balanced `open…close` span honoring quotes, escapes, and nesting. */
function skipBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = source.indexOf("'", index + 1);
      if (end < 0) return -1;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let closed = false;
      while (index < source.length) {
        const quoted = source[index]!;
        if (quoted === "\\") {
          index += 2;
          continue;
        }
        if (quoted === '"') {
          closed = true;
          index += 1;
          break;
        }
        index += 1;
      }
      if (!closed) return -1;
      continue;
    }
    if (char === "`") {
      const end = skipBacktick(source, index);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

/** Skip a backtick span, honoring escapes and nested `$(…)` substitutions. */
function skipBacktick(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") return index + 1;
    if (char === "$" && source[index + 1] === "(") {
      const end = skipBalanced(source, index + 1, "(", ")");
      if (end < 0) return -1;
      index = end;
      continue;
    }
    index += 1;
  }
  return -1;
}

// Tokenize exact offsets, preserving trailing comments. Unbalanced
// quotes/substitutions return undefined so the command stays unchanged.
function tokenize(
  source: string,
): { tokens: Token[]; commentStart: number } | undefined {
  const tokens: Token[] = [];
  let index = 0;
  const push = (
    kind: Token["kind"],
    value: string,
    start: number,
    end: number,
  ): void => {
    tokens.push({ kind, value, start, end } as Token);
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }
    if (char === "\n") {
      push("op", "\n", index, index + 1);
      index += 1;
      continue;
    }
    if (char === "#") {
      // Spec: Between tokens # begins a verbatim trailing comment; foo#bar
      // stays a word.
      return { tokens, commentStart: index };
    }
    if ((char === "<" || char === ">") && source[index + 1] === "(") {
      // Invariant: Process substitutions are opaque; never rewrite operators
      // inside them.
      const end = skipBalanced(source, index + 1, "(", ")");
      if (end < 0) return undefined;
      push("word", source.slice(index, end), index, end);
      index = end;
      continue;
    }
    const two = source.slice(index, index + 2);
    const three = source.slice(index, index + 3);
    // Spec: >&1 duplicates an fd, not a file redirect; numeric targets use the
    // handler below.
    const digitDup = two === ">&" && /[0-9]/.test(source[index + 2] ?? "");
    if (
      !digitDup &&
      (two === "&&" ||
        two === "||" ||
        two === "|&" ||
        two === "&>" ||
        two === ">&" ||
        two === ">>" ||
        two === "<<" ||
        two === "<>")
    ) {
      if ((two === "&>" || two === ">>") && source[index + 2] === ">") {
        push("op", three === "&>>" ? "&>>" : ">>", index, index + 3);
        index += 3;
      } else {
        push("op", two, index, index + 2);
        index += 2;
      }
      continue;
    }
    const fdRedirect = /^\d+(>>|>|<)/.exec(source.slice(index));
    if (
      fdRedirect &&
      !/^[0-9]/.test(source[index + fdRedirect[0].length] ?? " ")
    ) {
      // Spec: Fd-prefixed redirects form one operator; duplications are handled
      // separately.
      if (!three.startsWith("2>&") && !three.startsWith("1>&")) {
        push("op", fdRedirect[0], index, index + fdRedirect[0].length);
        index += fdRedirect[0].length;
        continue;
      }
    }
    if (three === "2>&" || three === "1>&") {
      // Spec: Only numeric duplication targets form one token.
      let end = index + 3;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      if (end === index + 3) {
        push("op", source[index] === "2" ? "2>" : "1>", index, index + 2);
        index += 2;
      } else {
        push("op", source.slice(index, end), index, end);
        index = end;
      }
      continue;
    }
    if (two === ">&" && /[0-9]/.test(source[index + 2] ?? "")) {
      let end = index + 2;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      push("op", source.slice(index, end), index, end);
      index = end;
      continue;
    }
    if ("|&;()<>".includes(char)) {
      push("op", char, index, index + 1);
      index += 1;
      continue;
    }

    const start = index;
    let value = "";
    while (index < source.length) {
      const current = source[index]!;
      if (
        current === " " ||
        current === "\t" ||
        current === "\n" ||
        "|&;()<>".includes(current)
      )
        break;
      if (current === "\\") {
        if (index + 1 >= source.length) return undefined;
        value += source.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (current === "'") {
        const end = source.indexOf("'", index + 1);
        if (end < 0) return undefined;
        value += source.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      if (current === '"') {
        let end = index + 1;
        let closed = false;
        while (end < source.length) {
          const quoted = source[end]!;
          if (quoted === "\\") {
            end += 2;
            continue;
          }
          if (quoted === '"') {
            closed = true;
            break;
          }
          end += 1;
        }
        if (!closed) return undefined;
        value += source.slice(index, end + 1);
        index = end + 1;
        continue;
      }
      if (current === "`") {
        const end = skipBacktick(source, index);
        if (end < 0) return undefined;
        value += source.slice(index, end);
        index = end;
        continue;
      }
      if (
        current === "$" &&
        (source[index + 1] === "(" || source[index + 1] === "{")
      ) {
        const closer = source[index + 1] === "(" ? ")" : "}";
        const end = skipBalanced(source, index + 1, source[index + 1]!, closer);
        if (end < 0) return undefined;
        value += source.slice(index, end);
        index = end;
        continue;
      }
      if ((current === "<" || current === ">") && source[index + 1] === "(") {
        const end = skipBalanced(source, index + 1, "(", ")");
        if (end < 0) return undefined;
        value += source.slice(index, end);
        index = end;
        continue;
      }
      // Spec: Digits directly before > start a redirect operator, not a word.
      if (/[0-9]/.test(current)) {
        let end = index;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
        if (source[end] === ">" || source[end] === "<") break;
        value += source.slice(index, end);
        index = end;
        continue;
      }
      value += current;
      index += 1;
    }
    if (index === start) return undefined;
    push("word", value, start, index);
  }
  return { tokens, commentStart: source.length };
}

/** `timeout [flags] DURATION [--] cmd` → span to remove, or undefined. */
function timeoutSpan(
  tokens: Token[],
): { start: number; end: number } | undefined {
  if (tokens[0]?.kind !== "word" || tokens[0].value !== "timeout")
    return undefined;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind !== "word") return undefined;
    const flag = token.value;
    if (flag === "--") {
      index += 1;
      break;
    }
    if (flag === "--preserve-status" || flag === "--foreground") {
      index += 1;
      continue;
    }
    if (
      flag === "-s" ||
      flag === "--signal" ||
      flag === "-k" ||
      flag === "--kill-after"
    ) {
      index += 2;
      continue;
    }
    if (/^--signal=/.test(flag) || /^--kill-after=/.test(flag)) {
      index += 1;
      continue;
    }
    break;
  }
  const duration = tokens[index];
  const rest = tokens[index + 1];
  if (duration?.kind !== "word" || !DURATION_RE.test(duration.value))
    return undefined;
  if (rest === undefined) return undefined;
  const first =
    rest.kind === "word" && rest.value === "--" ? tokens[index + 2] : rest;
  if (first === undefined) return undefined;
  return { start: tokens[0].start, end: first.start };
}

// Find only an atomic, single trailing head/tail pipe span, including |&. Leave
// compounds, redirects and subshells untouched; callers must not also normalize
// |& inside the removed span.
function headTailSpan(
  tokens: Token[],
): { start: number; end: number } | undefined {
  let pipe: Token | undefined;
  let pipes = 0;
  for (const token of tokens) {
    if (token.kind !== "op") continue;
    if (token.value === "|" || token.value === "|&") {
      pipe = token;
      pipes += 1;
    } else {
      // Invariant: Other operators compound the expression and prevent
      // rewriting.
      return undefined;
    }
  }
  if (!pipe || pipes !== 1) return undefined;
  // Invariant: Nonoverlapping token offsets allow a stage glued to its pipe
  // (|head).
  const after = tokens.filter((token) => token.start >= pipe!.end);
  if (after.some((token) => token.kind === "op")) return undefined;
  const [name, ...args] = after;
  if (
    name?.kind !== "word" ||
    (name.value !== "head" && name.value !== "tail")
  ) {
    return undefined;
  }
  const valid =
    args.length === 0 ||
    (args.length === 1 && /^-[0-9]+$/.test(args[0]!.value)) ||
    (args.length === 1 && /^-n[0-9]+$/.test(args[0]!.value)) ||
    (args.length === 2 &&
      args[0]!.value === "-n" &&
      COUNT_RE.test(args[1]!.value));
  if (!valid) return undefined;
  const end = after[after.length - 1]!.end;
  return { start: pipe.start, end };
}

/**
 * Rewrite one command, returning the command to run plus what was removed.
 * Never throws; anything unrecognized returns the source untouched.
 */
export function rewriteCommand(source: string): RewriteResult {
  try {
    return rewriteInner(source);
  } catch {
    return { command: source, rewritten: false, dropped: false };
  }
}

function rewriteInner(source: string): RewriteResult {
  const parsed = tokenize(source);
  if (!parsed) return { command: source, rewritten: false, dropped: false };
  const { tokens, commentStart } = parsed;
  if (tokens.length === 0)
    return { command: source, rewritten: false, dropped: false };
  interface Edit {
    start: number;
    end: number;
    text: string;
  }
  const edits: Edit[] = [];

  const timeout = timeoutSpan(tokens);
  const tail = headTailSpan(tokens);
  // Invariant: Never normalize |& inside a removed span; edits must not
  // overlap.
  const covered = (start: number): boolean =>
    tail !== undefined && start >= tail.start && start < tail.end;

  for (const token of tokens) {
    if (token.kind !== "op" || covered(token.start)) continue;
    if (token.value === "|&")
      edits.push({ start: token.start, end: token.end, text: "|" });
    else if (token.value === "&>" || token.value === ">&") {
      edits.push({ start: token.start, end: token.end, text: ">" });
    } else if (token.value === "&>>" || token.value === ">>&") {
      edits.push({ start: token.start, end: token.end, text: ">>" });
    }
  }

  // Spec: Keep stream duplication when output is discarded anyway.
  const discardsOutput = tokens.some(
    (token) => token.kind === "word" && token.value.includes("/dev/null"),
  );
  if (!discardsOutput) {
    for (const token of tokens) {
      if (token.kind !== "op") continue;
      if (
        token.value === "2>&1" ||
        token.value === "1>&2" ||
        token.value === ">&1" ||
        token.value === ">&2"
      ) {
        edits.push({ start: token.start, end: token.end, text: "" });
      }
    }
  }

  if (tail) {
    let end = tail.end;
    while (end < commentStart && (source[end] === " " || source[end] === "\t"))
      end += 1;
    edits.push({ start: tail.start, end, text: "" });
  }
  if (timeout) {
    edits.push({ start: timeout.start, end: timeout.end, text: "" });
  }

  // Invariant: Abandon removals that leave nothing runnable, without reporting
  // a rewrite.
  if (edits.length === 0) {
    return { command: source, rewritten: false, dropped: false };
  }
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let command = source;
  for (const edit of ordered) {
    command =
      command.slice(0, edit.start) + edit.text + command.slice(edit.end);
  }
  // Invariant: Keep a separator before preserved comments so removal cannot
  // fuse cmd# text.
  const comment = source.slice(commentStart);
  const body = command
    .slice(0, command.length - comment.length)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^[ \t]+/, "")
    .trimEnd();
  command = body + (comment ? (body ? " " : "") + comment : "");
  // Invariant: A comment alone is not runnable.
  if (!body.trim())
    return { command: source, rewritten: false, dropped: false };
  return { command, rewritten: true, dropped: true };
}
