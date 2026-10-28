// Persist salt/PBKDF2 hash only, never plaintext. PBKDF2 runs off-loop.
// Valid auth.json wins over env salt/hash; only neither enables open mode.
// Read credentials per call; HMAC cookies use the current hash, so password
// rotation revokes earlier cookies.

import {
  createHash,
  createHmac,
  pbkdf2 as pbkdf2Callback,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { FONT_SANS } from "../themes/fonts";
import { brandingFile, readBrand } from "../branding";
import { readTheme } from "../themes";
import { parsePythonJson } from "../utils/py_compact_json";

const pbkdf2 = promisify(pbkdf2Callback);

export const COOKIE_NAME = "chat_auth";
export const COOKIE_DAYS = 30;
export const PBKDF2_ITERS = 600_000;

export type Creds = readonly [salt: string, hash: string];

const pyError = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

const PY_ASCII_SPACE = new Set([" ", "\t", "\n", "\r", "\x0b", "\x0c"]);

/** Python bytes.fromhex: hex pairs, ASCII whitespace allowed between pairs. */
export function pyFromHex(text: string): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (PY_ASCII_SPACE.has(text[i]!)) {
      i += 1;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair))
      throw pyError("ValueError", "non-hexadecimal number found in fromhex()");
    out.push(parseInt(pair, 16));
    i += 2;
  }
  return new Uint8Array(out);
}

/** hmac.compare_digest over two str values (ASCII only, as in Python). */
function compareStr(a: string, b: string): boolean {
  if (/[^\x00-\x7f]/.test(a) || /[^\x00-\x7f]/.test(b))
    throw pyError(
      "TypeError",
      "comparing strings with non-ASCII characters is not supported",
    );
  const left = new Uint8Array(Buffer.from(a, "latin1"));
  const right = new Uint8Array(Buffer.from(b, "latin1"));
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** str.encode() in Python: refuses lone surrogates. */
function utf8(text: string): Uint8Array {
  if (!text.isWellFormed())
    throw pyError("UnicodeEncodeError", "surrogates not allowed");
  return new Uint8Array(Buffer.from(text, "utf8"));
}

/** html.escape(text, quote=True). */
export function htmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

export interface OperatorAuthOptions {
  /** `DATA_DIR/auth.json`. */
  readonly authFile: string;
  /** Read on every call (CHAT_AUTH_SALT, CHAT_AUTH_HASH). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** config DISPLAY_NAME, shown on the login page. */
  readonly displayName: string;
  /** config THEMES_FILE; the login page takes the selected theme's colours. */
  readonly themesFile?: string;
  /** Epoch seconds. */
  readonly now?: () => number;
}

export class OperatorAuth {
  readonly authFile: string;
  private readonly env: OperatorAuthOptions["env"];
  private readonly displayName: string;
  private readonly themesFile: string | undefined;
  private readonly now: () => number;

  constructor(options: OperatorAuthOptions) {
    this.authFile = options.authFile;
    this.env = options.env;
    this.displayName = options.displayName;
    this.themesFile = options.themesFile;
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  // (salt, hash) from the file, or null when missing, unreadable or malformed.
  async fileCreds(): Promise<Creds | null> {
    let data: unknown;
    try {
      const raw = await readFile(this.authFile);
      data = parsePythonJson(
        new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(raw)),
      );
    } catch {
      return null;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data))
      return null;
    const record = data as Record<string, unknown>;
    if (!("salt" in record) || !("hash" in record)) return null;
    const { salt, hash } = record;
    if (typeof salt !== "string" || typeof hash !== "string" || !salt || !hash)
      return null;
    try {
      pyFromHex(salt);
      pyFromHex(hash);
    } catch {
      return null;
    }
    return [salt, hash];
  }

  envCreds(): Creds | null {
    const salt = this.env.CHAT_AUTH_SALT;
    const hash = this.env.CHAT_AUTH_HASH;
    return salt && hash ? [salt, hash] : null;
  }

  // The credential in effect: the file if valid, else env; null = open mode.
  async currentCreds(): Promise<Creds | null> {
    return (await this.fileCreds()) ?? this.envCreds();
  }

  async enabled(): Promise<boolean> {
    return (await this.currentCreds()) !== null;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const creds = await this.currentCreds();
    // Invariant: No hash means validation fails closed.
    if (!creds) return false;
    const [salt, want] = creds;
    const digest = await pbkdf2(
      utf8(password),
      pyFromHex(salt),
      PBKDF2_ITERS,
      32,
      "sha256",
    );
    return compareStr(digest.toString("hex"), want);
  }

  // Persist a fresh salt and PBKDF2 hash (tmp + rename, no fsync, as Python).
  async setPassword(password: string): Promise<void> {
    const salt = new Uint8Array(randomBytes(16));
    const digest = await pbkdf2(
      utf8(password),
      salt,
      PBKDF2_ITERS,
      32,
      "sha256",
    );
    await mkdir(dirname(this.authFile), { recursive: true });
    const tmp = `${this.authFile}.tmp`;
    await writeFile(
      tmp,
      `{"salt": "${Buffer.from(salt).toString("hex")}", "hash": "${digest.toString("hex")}"}`,
    );
    await rename(tmp, this.authFile);
  }

  private async signingKey(): Promise<Uint8Array> {
    const creds = await this.currentCreds();
    if (!creds) throw new Error("no auth credential configured");
    return new Uint8Array(
      createHash("sha256")
        .update(pyFromHex(creds[1]))
        .update(":cookie-signing")
        .digest(),
    );
  }

  /** A cookie value `<exp>.<hmac>` valid for COOKIE_DAYS. */
  async makeToken(): Promise<string> {
    const exp = String(Math.floor(this.now()) + COOKIE_DAYS * 86400);
    const sig = createHmac("sha256", await this.signingKey())
      .update(exp)
      .digest("hex");
    return `${exp}.${sig}`;
  }

  async checkToken(token: string | null | undefined): Promise<boolean> {
    if (!token || !token.includes(".")) return false;
    const at = token.indexOf(".");
    const exp = token.slice(0, at);
    const sig = token.slice(at + 1);
    // Invariant: str.isdigit(): headers are Latin-1, whose only non-ASCII
    // digits are the superscripts, which int() then rejects with ValueError.
    if (!/^[0-9\u00b2\u00b3\u00b9]+$/.test(exp)) return false;
    if (/[\u00b2\u00b3\u00b9]/.test(exp))
      throw pyError("ValueError", "invalid literal for int()");
    if (Number(exp) < this.now()) return false;
    const want = createHmac("sha256", await this.signingKey())
      .update(exp)
      .digest("hex");
    return compareStr(sig, want);
  }

  loginHtml(
    error = "",
    value = "",
    themeCss = "",
    name = this.displayName,
  ): string {
    const tokens: Record<string, string> = {
      __APP__: htmlEscape(name),
      __ERROR__: htmlEscape(error),
      __VALUE__: htmlEscape(value),
      __THEME__: themeCss,
    };
    return LOGIN_HTML.replace(
      /__APP__|__ERROR__|__VALUE__|__THEME__/gu,
      (token) => tokens[token]!,
    );
  }

  /** The sign-in page in the selected colour theme, if a themes file is set. */
  async loginPage(error = "", value = ""): Promise<string> {
    const css = this.themesFile ? (await readTheme(this.themesFile)).css : "";
    const brand = this.themesFile
      ? await readBrand(brandingFile(dirname(this.themesFile)))
      : null;
    return this.loginHtml(error, value, css, brand?.name ?? this.displayName);
  }
}

/** A fixed-size, content-free identity for a session cookie. */
export function sessionFingerprint(
  token: string | null | undefined,
): string | null {
  if (!token) return null;
  return createHash("sha256").update(utf8(token)).digest("hex");
}

export const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__APP__</title><style>
  :root { color-scheme:light dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
    background:var(--bg, Canvas); color:var(--text, CanvasText);
    font:15px/1.6 ${FONT_SANS}; }
  form { background:var(--panel, Canvas); border:1px solid var(--border, GrayText); border-radius:14px;
    padding:32px 36px; width:320px; display:flex; flex-direction:column; gap:14px; }
  .dot { width:36px; height:36px; border-radius:10px; margin:0 auto 2px;
    background:linear-gradient(135deg, var(--accent, AccentColor), var(--accent-deep, AccentColor));
    box-shadow:0 0 30px color-mix(in srgb, var(--accent, AccentColor) 30%, transparent); }
  h1 { font-size:16px; font-weight:600; text-align:center; margin:0 0 6px; }
  input { background:var(--panel-2, Field); border:1px solid var(--border, GrayText); border-radius:10px;
    padding:10px 14px; color:var(--text, FieldText); font:inherit; outline:none; }
  input:focus { border-color:var(--accent-dim, AccentColor);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--accent, AccentColor) 9%, transparent); }
  button { background:var(--accent, AccentColor); border:0; border-radius:10px; padding:10px;
    font:inherit; font-weight:600; color:var(--text-on-accent, AccentColorText); cursor:pointer; }
  button:hover { background:var(--accent-hover, AccentColor); }
  .err { color:var(--danger, CanvasText); font-size:13.5px; text-align:center; min-height:1.2em; margin:0; }
</style><style id="theme">__THEME__</style></head><body>
<form method="post" action="/login">
  <div class="dot"></div><h1>__APP__</h1>
  <input type="password" name="password" value="__VALUE__" placeholder="Password" autofocus autocomplete="current-password">
  <button>Sign in</button>
  <p class="err">__ERROR__</p>
</form>
<script>
  // After a wrong password, highlight what was typed so the next attempt types over it.
  var p = document.querySelector('input[name=password]');
  if (p && p.value) { p.focus(); p.select(); }
</script>
</body></html>`;
