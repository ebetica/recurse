// Bound titles from untrusted text: Python whitespace, no control/format chars.
// Caps count Unicode code points, not UTF-16 units.

export const TITLE_MAX_LEN = 80;

const PYTHON_WHITESPACE =
  /[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw
    .split(PYTHON_WHITESPACE)
    .filter((part) => part.length > 0)
    .join(" ")
    .replace(CONTROL_OR_FORMAT, "");
  return Array.from(title).slice(0, TITLE_MAX_LEN).join("") || null;
}
