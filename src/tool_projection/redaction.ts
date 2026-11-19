// Tool-display boundary: allowlisted details only, without credential tokens,
// encoded or shell-significant syntax. Unknown input becomes argument-free.
// Python whitespace semantics preserve redaction parity.

export type JsonObject = Record<string, unknown>;

const TOOL_INPUT_MAX = 240;
export const TOOL_COMMAND_MAX = 2000;
export const LIVE_TOOL_OUTPUT_MAX = 16_000;

// Class-zero NFD-decomposing marks remain truncation boundaries.
const ZERO_CLASS_DECOMPOSING_MARKS = new Set([
  0x09cb, 0x09cc, 0x0b48, 0x0b4b, 0x0b4c, 0x0bca, 0x0bcb, 0x0bcc, 0x0c48,
  0x0cc0, 0x0cc7, 0x0cc8, 0x0cca, 0x0ccb, 0x0d4a, 0x0d4b, 0x0d4c, 0x0dda,
  0x0ddc, 0x0ddd, 0x0dde, 0x0f73, 0x0f75, 0x0f76, 0x0f78, 0x0f81, 0x0f93,
  0x0f9d, 0x0fa2, 0x0fa7, 0x0fac, 0x0fb9, 0x1b3b, 0x1b3d, 0x1b40, 0x1b41,
  0x1b43, 0x1112e, 0x1112f, 0x1134b, 0x1134c, 0x114bb, 0x114bc, 0x114be,
  0x115ba, 0x115bb, 0x11938,
]);

const PY_SPACE =
  /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const PY_SPACE_GLOBAL =
  /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const PY_SPACE_CHAR =
  /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const ANSI_ESCAPE_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/gu;
const WORD = String.raw`\p{L}\p{N}_`;
const LABEL_COMPONENT = String.raw`\p{L}\p{N}`;
const SECRET_LABEL = String.raw`api[_-]?key|access[_-]?token|token|auth(?:orization)?|bearer|password|passwd|secret|private[_-]?key|client[_-]?secret|oauth`;
const SECRET_TOKEN = String.raw`(?<![${WORD}])(?:sk|gh[pousr])[-_][a-z0-9_-]{8,}|(?<![${WORD}])github_pat_[a-z0-9_]{8,}|(?<![${WORD}])(?:akia|asia)[0-9a-z]{12,}|(?<![${WORD}])eyj[a-z0-9_-]{12,}\.[a-z0-9_-]{8,}`;
const SECRET_RE = new RegExp(
  String.raw`(?<![${LABEL_COMPONENT}])(?:${SECRET_LABEL})(?:[_-][${LABEL_COMPONENT}]+)*(?![${WORD}])${String.raw`[${PY_SPACE.source.slice(1, -1)}]*`}(?:=|:|${String.raw`[${PY_SPACE.source.slice(1, -1)}]`})[${String.raw`${PY_SPACE.source.slice(1, -1)}`}]*[${String.raw`^${PY_SPACE.source.slice(1, -1)}`}]+|${SECRET_TOKEN}`,
  "u",
);
const SAFE_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/u;
const SAFE_COMMAND_RE = /^[A-Za-z0-9_.+-]{1,64}$/u;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const URI_AUTHORITY_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[\\/]{2}/u;
export const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/u;
const BACKSLASH_ESCAPE_RE =
  /\\(?:[:/?=#&%]|[0-7]{1,3}|x[0-9A-Fa-f]{2}|x\{[0-9A-Fa-f]+\}|o\{[0-7]+\}|u[0-9A-Fa-f]{4}|u\{[0-9A-Fa-f]+\}|U[0-9A-Fa-f]{8}|N\{[^}]+\})/u;

export const SAFE_FILE_TOOLS = new Set(["read", "write", "edit"]);
const SAFE_BARE_TARGETS = new Set([
  "Brewfile",
  "Dockerfile",
  "Gemfile",
  "Justfile",
  "LICENSE",
  "Makefile",
  "Procfile",
  "README",
  "Rakefile",
  "Vagrantfile",
  "justfile",
]);
const BASH_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  bun: new Set(["test", "run", "build", "install"]),
  git: new Set([
    "status",
    "diff",
    "log",
    "show",
    "fetch",
    "pull",
    "add",
    "commit",
    "push",
    "merge",
    "rebase",
    "worktree",
    "branch",
  ]),
  gh: new Set(["pr", "run", "repo", "issue", "api"]),
  npm: new Set(["test", "run", "install", "build"]),
  pnpm: new Set(["test", "run", "install", "build"]),
  uv: new Set(["run", "sync", "lock", "export"]),
};

function pythonWhitespace(value: string): boolean {
  return PY_SPACE_CHAR.test(value);
}

function lowerForPythonIgnoreCase(value: string): string {
  // Invariant: Python re.IGNORECASE also folds long-s, Kelvin sign, dotted I,
  // and dotless i to ASCII letters. Normalize those four equivalences before
  // matching.
  return value
    .replace(/[ſKıİ]/gu, (char) =>
      char === "ſ" ? "s" : char === "K" ? "k" : "i",
    )
    .toLowerCase();
}

function withoutFormatting(value: string): string {
  return value
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\p{C}/gu, (ch) => (pythonWhitespace(ch) ? ch : ""));
}

/** Strip terminal/control sequences and collapse untrusted text to one line. */
export function oneLine(value: string): string {
  return withoutFormatting(value.normalize("NFC"))
    .replace(PY_SPACE_GLOBAL, " ")
    .replace(/^ | $/gu, "");
}

// Bound display text without emitting broken ANSI or splitting a grapheme tail.
export function truncateToolDetail(
  value: string,
  limit = TOOL_INPUT_MAX,
): string {
  // Invariant: At most `value.length` code points, so a string this short
  // always fits.
  if (value.length <= limit) return value;
  // Invariant: Only the first max(limit, 2) + 1 code points are read below;
  // they lie within twice that many UTF-16 units, so a longer value is cut
  // first.
  const keep = 2 * (Math.max(limit, 2) + 1);
  const head = value.length > keep ? value.slice(0, keep) : value;
  const chars = Array.from(head);
  if (head === value && chars.length <= limit) return value;
  let cut = Math.max(1, limit - 1);
  const isCombining = (char: string | undefined) => {
    if (char === undefined || !/\p{M}/u.test(char)) return false;
    if (ZERO_CLASS_DECOMPOSING_MARKS.has(char.codePointAt(0)!)) return false;
    // Invariant: Canonical ordering moves a nonzero-class mark around one of
    // these differently-classed references. A class-zero mark starts a new run.
    const first = `\u0334${char}\u0301\u0345`;
    const second = `\u0301${char}\u0334`;
    return (
      first.normalize("NFD") !== first || second.normalize("NFD") !== second
    );
  };
  const isSkinTone = (char: string | undefined) =>
    char !== undefined && /^[\u{1f3fb}-\u{1f3ff}]$/u.test(char);
  while (
    cut > 1 &&
    (isCombining(chars[cut]) ||
      isCombining(chars[cut - 1]) ||
      chars[cut - 1] === "\u200d" ||
      isSkinTone(chars[cut]) ||
      isSkinTone(chars[cut - 1]))
  )
    cut -= 1;
  return (
    chars
      .slice(0, cut)
      .join("")
      .replace(
        /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,
        "",
      ) + "…"
  );
}

export function containsSecret(value: string): boolean {
  return SECRET_RE.test(lowerForPythonIgnoreCase(value));
}

const CREDENTIAL_FIELD = String.raw`(?:(?:x[-_])?(?:${SECRET_LABEL}|subscription[-_]key|(?:auth|refresh|id|session)[-_]?token)|proxy-authorization|ocp-apim-subscription-key)`;
const FIELD_START = String.raw`(?<![${WORD}.-])`;
/** Identify a secret component once, then consume the whole joined label. */
const JOINED_SECRET_FIELD = String.raw`(?=(?:[${LABEL_COMPONENT}]+[_-])*?(?:${SECRET_LABEL})(?![${LABEL_COMPONENT}]))[${LABEL_COMPONENT}]+(?:[_-][${LABEL_COMPONENT}]+)+`;
/** Probe each scheme at its :// only; the userinfo scan cannot cross another slash. */
const URL_USERINFO = String.raw`(?<=(?:^|[\s\x85"'()<>{}\[\]])(?:[a-z][a-z0-9+.-]*:)?//)[^/\\?#\s"<>@]+@`;
/** Match opaque runs before probing for JWT dots, avoiding overlapping scans. */
const SECRET_ANYCASE_RE = new RegExp(
  [
    URL_USERINFO,
    String.raw`(?<=[?&])(?:key|sig(?:nature)?)[ \t]*=`,
    String.raw`["'](?:${CREDENTIAL_FIELD}|key)["']\s*:`,
    String.raw`${FIELD_START}(?:${CREDENTIAL_FIELD}|${JOINED_SECRET_FIELD})[ \t]*(?::[ \t]*(?:\r?\n[ \t]+)?|=[ \t]*)[^\s\x85]`,
    String.raw`(?<![${WORD}])bearer[ \t]+[^\s\x85]`,
    String.raw`${FIELD_START}${JOINED_SECRET_FIELD}[ \t]+[^\s\x85:=]`,
    String.raw`[a-f0-9]{32,}|[a-z0-9+/_-]{48,}={0,2}`,
    SECRET_TOKEN,
  ].join("|"),
  "iu",
);

/** Replace the first credential-shaped token and everything after it. */
export function redactSecrets(
  text: string,
  credentials: readonly (string | undefined)[] = [],
): string {
  const value = withoutFormatting(text);
  let end = SECRET_ANYCASE_RE.exec(value)?.index ?? value.length;
  for (const credential of credentials) {
    if (!credential) continue;
    for (const form of [
      withoutFormatting(credential),
      JSON.stringify(credential).slice(1, -1),
      encodeURIComponent(credential.toWellFormed()),
    ]) {
      if (!form) continue;
      const index = value.indexOf(form);
      if (index !== -1) end = Math.min(end, index);
    }
  }
  return end === value.length ? value : `${value.slice(0, end)}REDACTED`;
}

/** Bound a raw error to the runtime logger's scalar alphabet after redaction. */
export function logText(text: string): string {
  return formatRedactedLogText(redactSecrets(text));
}

/** Serialize error text that was already scrubbed before its lines were folded. */
export function formatRedactedLogText(text: string): string {
  return (
    oneLine(text)
      .replace(/[^A-Za-z0-9_.:@/+,-]/gu, "_")
      .slice(0, 200) || "-"
  );
}

function hasEncodedSyntax(value: string): boolean {
  return BACKSLASH_ESCAPE_RE.test(value);
}

/** Return a bounded, recognizably file-like target or fail closed. */
export function safeTarget(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const target = oneLine(value);
  const inspected = target.normalize("NFKC");
  const fileLike =
    SAFE_BARE_TARGETS.has(target) ||
    /^[.~\/\\]/u.test(target) ||
    target.includes("/") ||
    target.includes("\\") ||
    (target.includes(".") && !target.endsWith("."));
  const encodedDelimiter =
    inspected.includes("%") ||
    inspected.includes("&") ||
    hasEncodedSyntax(inspected);
  const uriScheme = URI_SCHEME_RE.test(inspected);
  if (
    !target ||
    Array.from(inspected).some(pythonWhitespace) ||
    /[?#=]/u.test(inspected) ||
    encodedDelimiter ||
    !fileLike ||
    containsSecret(inspected) ||
    (uriScheme &&
      (URI_AUTHORITY_RE.test(inspected) || !WINDOWS_DRIVE_RE.test(inspected)))
  )
    return null;
  return truncateToolDetail(target);
}

// Keep a tool name only when it is a closed ASCII label with no credential
// marker.
export function safeToolName(value: unknown): string {
  const name = typeof value === "string" ? oneLine(value) : "";
  return SAFE_TOOL_NAME_RE.test(name) && !containsSecret(name) ? name : "tool";
}

/** POSIX shell tokenization for the allow-listed summaries. */
export function shellSplit(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let active = false;
  let quote: "'" | '"' | null = null;
  const chars = Array.from(command);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      active = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (
        ch === "\\" &&
        i + 1 < chars.length &&
        ['"', "\\", "$"].includes(chars[i + 1]!)
      ) {
        current += chars[++i]!;
      } else current += ch;
      active = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      active = true;
    } else if (ch === "\\") {
      if (i + 1 >= chars.length) return null;
      current += chars[++i]!;
      active = true;
    } else if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      if (active) tokens.push(current);
      current = "";
      active = false;
    } else {
      current += ch;
      active = true;
    }
  }
  if (quote !== null) return null;
  if (active) tokens.push(current);
  return tokens;
}

function popEnvAssignments(tokens: string[]): boolean {
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(tokens[0]!)) {
    const key = tokens.shift()!.split("=", 1)[0]!;
    if (/(?:token|key|secret|password|auth)/iu.test(key)) return false;
  }
  return true;
}

/** The executable and one conventional subcommand, never the arguments. */
export function bashDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = oneLine(value);
  if (!command || containsSecret(command)) return null;
  const tokens = shellSplit(command);
  if (tokens === null || !popEnvAssignments(tokens) || !tokens.length)
    return null;
  const program = tokens[0]!.replace(/\\/gu, "/").split("/").at(-1)!;
  if (!SAFE_COMMAND_RE.test(program)) return null;
  const parts = ["Run", program];
  if (tokens.length > 1 && BASH_SUBCOMMANDS[program]?.has(tokens[1]!))
    parts.push(tokens[1]!);
  else if (
    ["python", "python3"].includes(program) &&
    tokens.length > 2 &&
    tokens[1] === "-m" &&
    ["compileall", "pytest", "unittest"].includes(tokens[2]!)
  ) {
    parts.push("-m", tokens[2]!);
  }
  return parts.join(" ");
}

/** Whole shell command for the authenticated owner-scoped tool row only. */
export function bashCommandDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = oneLine(value);
  return command ? truncateToolDetail(command, TOOL_COMMAND_MAX) : null;
}

/** Python whitespace predicate needed by sibling modules. */
export function isPythonWhitespace(value: string): boolean {
  return pythonWhitespace(value);
}
