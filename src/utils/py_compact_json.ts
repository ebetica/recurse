// Python-compatible compact JSON with optional default separators/indentation.
// JS normalizes integral floats and small exponents; integer-like keys reorder.
// Byte-stable callers must avoid numeric keys or carry their order in arrays.
import { randomUUID } from "node:crypto";

export interface PyCompactJsonOptions {
  separators?: "compact" | "default";
  indent?: number;
}

function quoteString(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x00-\x7e]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// Serialize JSON values like Python json.dumps, with compact output by default.
export function pyCompactJson(
  value: unknown,
  options: PyCompactJsonOptions = {},
): string {
  const { indent } = options;
  if (indent !== undefined && (!Number.isInteger(indent) || indent < 0))
    throw new TypeError("indent must be a non-negative integer");
  const separators =
    options.separators ?? (indent === undefined ? "compact" : "default");
  const comma =
    indent !== undefined ? ",\n" : separators === "default" ? ", " : ",";
  const colon = separators === "default" ? ": " : ":";
  const seen = new WeakSet<object>();

  function encode(item: unknown, level: number): string {
    if (typeof item === "string") return quoteString(item);
    if (item === null) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      if (Number.isNaN(item)) return "NaN";
      if (item === Infinity) return "Infinity";
      if (item === -Infinity) return "-Infinity";
      // Invariant: Python switches to scientific notation below 1e-4 and pads
      // single-digit exponents; JS waits until 1e-6 and omits padding.
      if (item !== 0 && Math.abs(item) < 0.0001)
        return item
          .toExponential()
          .replace(
            /e([+-])(\d+)$/u,
            (_, sign: string, digits: string) =>
              `e${sign}${digits.padStart(2, "0")}`,
          );
      return String(item);
    }
    if (typeof item !== "object" || seen.has(item))
      throw new TypeError("value is not JSON serializable");
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new TypeError("value is not JSON serializable");
    seen.add(item);
    const array = Array.isArray(item);
    const entries: [string | null, unknown][] = array
      ? item.map((value): [string | null, unknown] => [null, value])
      : Object.entries(item).map(([key, value]) => [key, value]);
    if (entries.length === 0) {
      seen.delete(item);
      return array ? "[]" : "{}";
    }
    const rows = entries.map(([key, value]) => {
      const member =
        key === null
          ? encode(value, level + 1)
          : `${quoteString(key)}${colon}${encode(value, level + 1)}`;
      return indent === undefined
        ? member
        : `${" ".repeat(indent * (level + 1))}${member}`;
    });
    const open = array ? "[" : "{";
    const close = array ? "]" : "}";
    const result =
      indent === undefined
        ? `${open}${rows.join(comma)}${close}`
        : `${open}\n${rows.join(comma)}\n${" ".repeat(indent * level)}${close}`;
    seen.delete(item);
    return result;
  }

  return encode(value, 0);
}

// Parse json.load values, including Python's bare NaN and Infinity constants.
export function parsePythonJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!text.includes("NaN") && !text.includes("Infinity")) throw error;
  }
  const marker = `\u0000python-json-${randomUUID()}`;
  const keyFollows = (start: number, length: number): boolean => {
    let next = start + length;
    while (next < text.length && /[\t\n\r ]/u.test(text[next]!)) next += 1;
    return text[next] === ":";
  };
  let quoted = false;
  let escaped = false;
  let converted = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      converted += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      converted += character;
      quoted = true;
    } else if (text.startsWith("-Infinity", index) && !keyFollows(index, 9)) {
      converted += "-1e999";
      index += 8;
    } else if (text.startsWith("Infinity", index) && !keyFollows(index, 8)) {
      converted += "1e999";
      index += 7;
    } else if (text.startsWith("NaN", index) && !keyFollows(index, 3)) {
      converted += JSON.stringify(marker);
      index += 2;
    } else {
      converted += character;
    }
  }
  return JSON.parse(converted, (_key, value: unknown) =>
    value === marker ? NaN : value,
  );
}
