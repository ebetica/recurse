// Canonical platform-reminder wrappers distinguish guidance from user text.
// Read legacy marker spelling and escape untrusted markers. Python whitespace
// semantics apply; newline-only stripping removes LF only.

export const SYSTEM_REMINDER_OPEN = "<system_reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system_reminder>";
const LEGACY_OPEN = "<system-reminder>";
const LEGACY_CLOSE = "</system-reminder>";

const PYTHON_WHITESPACE = String.raw`\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const PYTHON_EDGE_WHITESPACE = new RegExp(
  `^[${PYTHON_WHITESPACE}]+|[${PYTHON_WHITESPACE}]+$`,
  "gu",
);
const REMINDER_BLOCK = /<system[_-]reminder>([\s\S]*?)<\/system[_-]reminder>/g;
const EDGE_NEWLINES = /^\n+|\n+$/g;

function stripPythonWhitespace(text: string): string {
  return text.replace(PYTHON_EDGE_WHITESPACE, "");
}

function stripNewlines(text: string): string {
  return text.replace(EDGE_NEWLINES, "");
}

export function wrapSystemReminder(note: string): string {
  const text = stripNewlines(note);
  if (isSystemReminder(text)) return text;
  return `${SYSTEM_REMINDER_OPEN}\n${text}\n${SYSTEM_REMINDER_CLOSE}`;
}

export function isSystemReminder(text: string): boolean {
  const stripped = stripPythonWhitespace(text);
  return (
    (stripped.startsWith(SYSTEM_REMINDER_OPEN) &&
      stripped.endsWith(SYSTEM_REMINDER_CLOSE)) ||
    (stripped.startsWith(LEGACY_OPEN) && stripped.endsWith(LEGACY_CLOSE))
  );
}

export function unwrapSystemReminder(text: string): string {
  return text.replace(REMINDER_BLOCK, (_block, body: string) =>
    stripNewlines(body),
  );
}

export function escapeReminderMarkers(content: string): string {
  return content
    .replaceAll(SYSTEM_REMINDER_OPEN, "<system_reminder-quoted>")
    .replaceAll(SYSTEM_REMINDER_CLOSE, "</system_reminder-quoted>")
    .replaceAll(LEGACY_OPEN, "<system-reminder-quoted>")
    .replaceAll(LEGACY_CLOSE, "</system-reminder-quoted>");
}
