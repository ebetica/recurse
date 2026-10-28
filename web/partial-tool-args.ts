// Decodes bounded partial tool args into allowlisted primary text.
// Credential-shaped/early/unallowlisted prefixes fail closed to the tool name.
// Completed redacted summaries take over; search text stays detail-only, never
// broad summary or panel labels.

// Primary string keys in stream order; arrays use their first string.
const PRIMARY_KEYS: Record<string, string[]> = {
  bash: ["command"],
  shell: ["command"],
  read: ["path", "file_path"],
  write: ["path", "file_path"],
  edit: ["path", "file_path"],
  chdir: ["directory"],
  grep: ["pattern", "patterns", "path"],
  multi_grep: ["pattern", "patterns", "path"],
  find: ["pattern", "patterns", "path"],
};

// Only settled-summary tools may expose streaming args in summary slots.
const SUMMARY_SLOT_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "read",
  "write",
  "edit",
  "chdir",
]);

// Search patterns may reach details, never the summary slot.
const DETAIL_SLOT_TOOLS: ReadonlySet<string> = new Set([
  "grep",
  "multi_grep",
  "find",
]);

// Only complete key/quote prefixes decode; early JSON stays name-only.
const KEY_SOURCE =
  '"((?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*?)"\\s*:';

const ARGS_PREFIX = /^\s*\{\s*"/;

// Credential assignments, known token prefixes and JWT-like text fail closed.
const SECRET_RE =
  /\b(?:api[_-]?key|access[_-]?token|token|auth(?:orization)?|bearer|password|passwd|secret|private[_-]?key|client[_-]?secret|oauth)\b\s*(?:=|:|\s)\s*\S+|\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\b(?:AKIA|ASIA)[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/i;

const ANSI_RE =
  // oxlint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Collapse decoded text the way the backend one-lines summaries, so a
// streaming prefix and its settled summary are the same text.
function oneLine(value: string): string {
  return value
    .normalize("NFC")
    .replace(ANSI_RE, "")
    .replace(CONTROL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Whether raw arguments have the shape of a tool-args object prefix rather
// than an already-decoded value (the whole bash command, a bare path).
export function hasArgsPrefix(args: unknown): boolean {
  return typeof args === "string" && ARGS_PREFIX.test(args);
}

// Decode a JSON string starting at its opening quote, stopping at the closing
// quote or the truncated input end. A cut escape contributes nothing further;
// an unrecognized escape keeps its character the way display text does.
function decodeJsonString(partial: string, start: number): string {
  let out = "";
  let i = start + 1;
  while (i < partial.length) {
    const ch = partial[i];
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const esc = partial[i + 1];
    if (esc === undefined) break;
    switch (esc) {
      case '"':
        out += '"';
        i += 2;
        break;
      case "\\":
        out += "\\";
        i += 2;
        break;
      case "/":
        out += "/";
        i += 2;
        break;
      case "b":
        out += "\b";
        i += 2;
        break;
      case "f":
        out += "\f";
        i += 2;
        break;
      case "n":
        out += "\n";
        i += 2;
        break;
      case "r":
        out += "\r";
        i += 2;
        break;
      case "t":
        out += "\t";
        i += 2;
        break;
      case "u": {
        const hex = partial.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          i = partial.length;
          break;
        }
        const code = parseInt(hex, 16);
        if (code >= 0xd800 && code <= 0xdbff) {
          const rest = partial.slice(i + 6);
          const lowMatch = /^\\u([0-9a-fA-F]{4})/.exec(rest);
          if (lowMatch) {
            const low = parseInt(lowMatch[1], 16);
            if (low >= 0xdc00 && low <= 0xdfff) {
              out += String.fromCharCode(code, low);
              i += 12;
              break;
            }
          } else if (/^(\\u([0-9a-fA-F]{0,3})?)?$/.test(rest)) {
            // Invariant: Low half still arriving: hold the escape for the next
            // chunk rather than emitting a lone surrogate.
            i = partial.length;
            break;
          }
        }
        out += String.fromCharCode(code);
        i += 6;
        break;
      }
      default:
        out += esc;
        i += 2;
        break;
    }
  }
  return out;
}

function skipSpace(value: string, i: number): number {
  while (i < value.length && /\s/.test(value[i] ?? "")) i++;
  return i;
}

// The first string value under any of `wanted` (document order). A matching
// key with a definitively non-string value fails closed, and a `"key":` pair
// quoted inside an earlier string value can only shadow the real key into a
// miss — never into wrong text, since only a wanted key returns.
function firstStringValue(
  partial: string,
  wanted: ReadonlySet<string>,
): string | null {
  const keys = new RegExp(KEY_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = keys.exec(partial)) !== null) {
    let key: string;
    try {
      key = JSON.parse(`"${match[1]}"`);
    } catch {
      continue;
    }
    if (!wanted.has(key)) continue;
    let i = skipSpace(partial, match.index + match[0].length);
    if (partial[i] === "[") {
      i = skipSpace(partial, i + 1);
      if (partial[i] !== '"') return null;
    } else if (partial[i] !== '"') {
      return null;
    }
    const text = oneLine(decodeJsonString(partial, i));
    if (!text || SECRET_RE.test(text)) return null;
    return text;
  }
  return null;
}

// Returns allowlisted primary text or null for undecodable/credential prefixes.
// Bash uses command, file tools path, searches pattern; complete projection
// enforces the same redaction boundary.
export function partialPrimaryArg(
  toolName: string | null | undefined,
  partialJson: string | null | undefined,
): string | null {
  if (!hasArgsPrefix(partialJson)) return null;
  const keys = PRIMARY_KEYS[(toolName ?? "").toLowerCase()];
  if (!keys) return null;
  return firstStringValue(partialJson as string, new Set(keys));
}

function streamingText(
  allowed: ReadonlySet<string>,
  name: string | null | undefined,
  args: string | null | undefined,
  input: string | null | undefined,
): string | null {
  // Invariant: A present summary means complete arguments, which own the row
  // with the same text the prefix was growing toward.
  if (input !== null && input !== undefined && input.trim() !== "") return null;
  if (!hasArgsPrefix(args)) return null;
  if (!allowed.has((name ?? "").toLowerCase())) return null;
  return partialPrimaryArg(name, args);
}

// What a streaming row shows in the summary slot (thread row head, panel):
// the decoded primary text, or null to keep the existing rendering.
export function streamingRowText(
  name: string | null | undefined,
  args: string | null | undefined,
  input: string | null | undefined,
): string | null {
  return streamingText(SUMMARY_SLOT_TOOLS, name, args, input);
}

// What a streaming search row shows in the thread row's detail slot: the
// decoded pattern, or null. Never used for the panel, whose settled search
// rendering stays name-only until the complete detail arrives.
export function streamingDetailText(
  name: string | null | undefined,
  args: string | null | undefined,
  input: string | null | undefined,
): string | null {
  return streamingText(DETAIL_SLOT_TOOLS, name, args, input);
}
