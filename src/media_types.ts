// Python built-in MIME tables handle strict/common, compressed and data URLs.
// Generated tables exclude host-specific MIME files for deterministic results.

import mimeTables from "./media/data.json";

interface MimeDatabase {
  readonly strict: Readonly<Record<string, string>>;
  readonly common: Readonly<Record<string, string>>;
  readonly suffixes: Readonly<Record<string, string>>;
  readonly encodings: Readonly<Record<string, string>>;
}

const database = mimeTables as MimeDatabase;
const PARAMETER_SCHEMES = new Set([
  "ftp",
  "hdl",
  "prospero",
  "http",
  "imap",
  "https",
  "shttp",
  "rtsp",
  "rtsps",
  "rtspu",
  "sip",
  "sips",
  "mms",
  "sftp",
  "tel",
]);

function urlPath(url: string): { scheme: string | null; path: string } {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(url);
  if (!match || match[1]!.length <= 1) return { scheme: null, path: url };

  let path = url.slice(match[0].length);
  const query = path.indexOf("?");
  const fragment = path.indexOf("#");
  const end = [query, fragment].filter((index) => index >= 0);
  if (end.length) path = path.slice(0, Math.min(...end));
  if (path.startsWith("//")) {
    const slash = path.indexOf("/", 2);
    path = slash < 0 ? "" : path.slice(slash);
  }
  const scheme = match[1]!.toLowerCase();
  if (PARAMETER_SCHEMES.has(scheme)) {
    const lastSlash = path.lastIndexOf("/");
    const semicolon = path.indexOf(";", lastSlash + 1);
    if (semicolon >= 0) path = path.slice(0, semicolon);
  }
  return { scheme, path };
}

function splitExtension(path: string): [base: string, extension: string] {
  const firstNameCharacter = path.lastIndexOf("/") + 1;
  let firstNonDot = firstNameCharacter;
  while (path[firstNonDot] === ".") firstNonDot += 1;
  const dot = path.lastIndexOf(".");
  if (dot < firstNonDot) return [path, ""];
  return [path.slice(0, dot), path.slice(dot)];
}

function dataUrlType(path: string): [string | null, null] {
  const comma = path.indexOf(",");
  if (comma < 0) return [null, null];
  const semicolon = path.indexOf(";");
  let type =
    semicolon >= 0 && semicolon < comma
      ? path.slice(0, semicolon)
      : path.slice(0, comma);
  if (type.includes("=") || !type.includes("/")) type = "text/plain";
  return [type, null];
}

/** Guess [MIME type, content encoding] using Python's strict/common tables. */
export function guessType(
  name: string,
  strict = true,
): [string | null, string | null] {
  const parsed = urlPath(name);
  if (parsed.scheme === "data") return dataUrlType(parsed.path);

  let [base, extension] = splitExtension(parsed.path);
  let replacement = database.suffixes[extension.toLowerCase()];
  while (replacement !== undefined) {
    [base, extension] = splitExtension(base + replacement);
    replacement = database.suffixes[extension.toLowerCase()];
  }

  let encoding: string | null = null;
  if (Object.hasOwn(database.encodings, extension)) {
    encoding = database.encodings[extension]!;
    [base, extension] = splitExtension(base);
  }

  const lowerExtension = extension.toLowerCase();
  const type =
    database.strict[lowerExtension] ??
    (strict ? undefined : database.common[lowerExtension]);
  return [type ?? null, encoding];
}
