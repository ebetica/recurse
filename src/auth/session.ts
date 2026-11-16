// Atomic 0600 auth.json holds password hashes and optional two_factor state.
// Off-loop PBKDF2; flock serializes code use; malformed factors fail closed.
// Factor changes revoke cookies, not backend keys. Recovery: stop, remove
// DATA_DIR/auth.json, restart. Restores env password (else open); clears 2FA.

import {
  createHash,
  createHmac,
  pbkdf2 as pbkdf2Callback,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { FONT_SANS } from "../themes/fonts";
import { brandingFile, brandResponse, readBrand } from "../branding";
import { readTheme } from "../themes";
import { parsePythonJson } from "../utils/py_compact_json";

import { flockExclusive } from "../utils/flock";
import {
  acceptedStep,
  equalDigest,
  newTotpSecret,
  recoveryCodes,
  recoveryHash,
} from "./totp";

const pbkdf2 = promisify(pbkdf2Callback);

export const COOKIE_NAME = "chat_auth";
export const COOKIE_DAYS = 30;
export const PBKDF2_ITERS = 600_000;

export type Creds = readonly [salt: string, hash: string];

interface CredentialRecord {
  salt: string;
  hash: string;
  session_key?: string;
  two_factor?: {
    secret: string;
    last_step: number;
    recovery_hashes: string[];
  };
}

interface PendingSetup {
  secret: string;
  binding: string;
  version: string;
  expires: number;
}

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
  readonly defaultIconUrl?: () => Promise<string>;
  /** Epoch seconds. */
  readonly now?: () => number;
}

export class OperatorAuth {
  readonly authFile: string;
  private readonly env: OperatorAuthOptions["env"];
  private readonly displayName: string;
  private readonly themesFile: string | undefined;
  private readonly defaultIconUrl: OperatorAuthOptions["defaultIconUrl"];
  private readonly now: () => number;
  private pending: PendingSetup | null = null;
  private passwords: Promise<unknown> = Promise.resolve();

  /** Serialize password/code attempts and session-changing handlers. */
  withPasswordLock<T>(work: () => Promise<T>): Promise<T> {
    const task = this.passwords.then(work);
    this.passwords = task.catch(() => {});
    return task;
  }

  constructor(options: OperatorAuthOptions) {
    this.authFile = options.authFile;
    this.env = options.env;
    this.displayName = options.displayName;
    this.themesFile = options.themesFile;
    this.defaultIconUrl = options.defaultIconUrl;
    this.now = options.now ?? (() => Date.now() / 1000);
  }

  private async fileRecord(): Promise<CredentialRecord | null> {
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
    if (
      (record.session_key !== undefined &&
        (typeof record.session_key !== "string" ||
          !/^[a-f0-9]{64}$/.test(record.session_key))) ||
      (record.two_factor !== undefined && !validFactor(record.two_factor))
    )
      throw new Error(
        "invalid sign-in configuration; reset sign-in on the server",
      );
    return record as unknown as CredentialRecord;
  }

  async fileCreds(): Promise<Creds | null> {
    const record = await this.fileRecord();
    return record ? [record.salt, record.hash] : null;
  }

  private async currentRecord(): Promise<CredentialRecord | null> {
    const record = await this.fileRecord();
    if (record) return record;
    const creds = this.envCreds();
    return creds ? { salt: creds[0], hash: creds[1] } : null;
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
    const record = await this.currentRecord();
    return record !== null && this.passwordMatches(password, record);
  }

  private async passwordMatches(
    password: string,
    record: CredentialRecord,
  ): Promise<boolean> {
    const { salt, hash: want } = record;
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
    await this.withLock(async () => {
      const previous = await this.currentRecord();
      await this.persist({
        ...previous,
        salt: Buffer.from(salt).toString("hex"),
        hash: digest.toString("hex"),
      });
      this.pending = null;
    });
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.authFile), { recursive: true });
    const path = `${this.authFile}.lock`;
    const handle = await open(path, "a", 0o600);
    try {
      const unlock = await flockExclusive(handle.fd, path);
      try {
        return await action();
      } finally {
        unlock();
      }
    } finally {
      await handle.close();
    }
  }

  private async persist(record: CredentialRecord): Promise<void> {
    const tmp = `${this.authFile}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.close();
      await rename(tmp, this.authFile);
    } finally {
      await handle.close();
      await unlink(tmp).catch(() => {});
    }
  }

  async twoFactorEnabled(): Promise<boolean> {
    return !!(await this.currentRecord())?.two_factor;
  }

  async verifySignIn(password: string, code = ""): Promise<boolean> {
    return this.withLock(() => this.acceptSignIn(password, code));
  }

  async signIn(password: string, code = ""): Promise<string | null> {
    return this.withLock(async () =>
      (await this.acceptSignIn(password, code)) ? this.makeToken() : null,
    );
  }

  private async acceptSignIn(password: string, code: string): Promise<boolean> {
    const record = await this.currentRecord();
    if (!record || !(await this.passwordMatches(password, record)))
      return false;
    if (!record.two_factor) return true;
    if (!this.consumeCode(record, code)) return false;
    await this.persist(record);
    return true;
  }

  private consumeCode(record: CredentialRecord, code: string): boolean {
    const factor = record.two_factor!;
    const step = acceptedStep(
      factor.secret,
      code,
      this.now(),
      factor.last_step,
    );
    const hash = recoveryHash(code);
    let index = -1;
    factor.recovery_hashes.forEach((stored, candidate) => {
      if (equalDigest(stored, hash)) index = candidate;
    });
    if (step !== null) factor.last_step = step;
    else if (index !== -1) factor.recovery_hashes.splice(index, 1);
    else return false;
    return true;
  }

  async beginTwoFactor(
    password: string,
    binding: string,
  ): Promise<{ secret: string; url: string } | null> {
    return this.withLock(async () => {
      const record = await this.currentRecord();
      if (
        !record ||
        record.two_factor ||
        !(await this.passwordMatches(password, record))
      )
        return null;
      const secret = newTotpSecret();
      this.pending = {
        secret,
        binding,
        version: recoveryHash(JSON.stringify(record)),
        expires: this.now() + 600,
      };
      return {
        secret: secret.match(/.{4}/g)!.join(" "),
        url: `otpauth://totp/${encodeURIComponent(this.displayName)}?secret=${secret}&issuer=${encodeURIComponent(this.displayName)}&algorithm=SHA1&digits=6&period=30`,
      };
    });
  }

  async enableTwoFactor(
    password: string,
    code: string,
    binding: string,
  ): Promise<string[] | null> {
    return this.withLock(async () => {
      const record = await this.currentRecord();
      const pending = this.pending;
      if (
        !record ||
        record.two_factor ||
        !pending ||
        pending.expires < this.now() ||
        !equalDigest(pending.binding, binding) ||
        !equalDigest(pending.version, recoveryHash(JSON.stringify(record))) ||
        !(await this.passwordMatches(password, record))
      )
        return null;
      const step = acceptedStep(pending.secret, code, this.now(), -1);
      if (step === null) return null;
      const codes = recoveryCodes();
      record.two_factor = {
        secret: pending.secret,
        last_step: step,
        recovery_hashes: codes.map(recoveryHash),
      };
      record.session_key = randomBytes(32).toString("hex");
      await this.persist(record);
      this.pending = null;
      return codes;
    });
  }

  async disableTwoFactor(password: string, code: string): Promise<boolean> {
    return this.withLock(async () => {
      const record = await this.currentRecord();
      if (
        !record?.two_factor ||
        !(await this.passwordMatches(password, record)) ||
        !this.consumeCode(record, code)
      )
        return false;
      delete record.two_factor;
      record.session_key = randomBytes(32).toString("hex");
      await this.persist(record);
      this.pending = null;
      return true;
    });
  }

  private async signingKey(): Promise<Uint8Array> {
    const record = await this.currentRecord();
    if (!record) throw new Error("no auth credential configured");
    const hash = createHash("sha256")
      .update(pyFromHex(record.hash))
      .update(":cookie-signing");
    if (record.session_key) hash.update(record.session_key);
    return new Uint8Array(hash.digest());
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
    twoFactor = false,
  ): string {
    const tokens: Record<string, string> = {
      __APP__: htmlEscape(name),
      __ERROR__: htmlEscape(error),
      __VALUE__: htmlEscape(value),
      __THEME__: themeCss,
      __CODE__: twoFactor
        ? '<label>Authenticator or recovery code<input name="code" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" required maxlength="64"></label>'
        : "",
    };
    return LOGIN_HTML.replace(
      /__APP__|__ERROR__|__VALUE__|__THEME__|__CODE__/gu,
      (token) => tokens[token]!,
    );
  }

  /** The sign-in page in the selected colour theme, if a themes file is set. */
  async loginPage(error = "", value = ""): Promise<string> {
    const css = this.themesFile ? (await readTheme(this.themesFile)).css : "";
    const brand = this.themesFile
      ? await readBrand(brandingFile(dirname(this.themesFile)))
      : null;
    const html = this.loginHtml(
      error,
      value,
      css,
      brand?.name ?? this.displayName,
      await this.twoFactorEnabled(),
    );
    const icon =
      (brand && brandResponse(brand, this.displayName).icon) ??
      (await this.defaultIconUrl?.());
    return icon
      ? html.replace(
          "</head>",
          `<link rel="icon" href="${htmlEscape(icon)}"></head>`,
        )
      : html;
  }
}

function validFactor(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const factor = value as Record<string, unknown>;
  return (
    typeof factor.secret === "string" &&
    /^[A-Z2-7]{32}$/.test(factor.secret) &&
    Number.isSafeInteger(factor.last_step) &&
    Number(factor.last_step) >= -1 &&
    Array.isArray(factor.recovery_hashes) &&
    factor.recovery_hashes.length <= 10 &&
    factor.recovery_hashes.every(
      (hash: unknown) =>
        typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    )
  );
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
    box-sizing:border-box; padding:24px; width:min(392px, calc(100vw - 32px)); display:flex; flex-direction:column; gap:14px; }
  .dot { width:36px; height:36px; border-radius:10px; margin:0 auto 2px;
    background:linear-gradient(135deg, var(--accent, AccentColor), var(--accent-deep, AccentColor));
    box-shadow:0 0 30px color-mix(in srgb, var(--accent, AccentColor) 30%, transparent); }
  h1 { font-size:16px; font-weight:600; text-align:center; margin:0 0 6px; }
  label { display:flex; flex-direction:column; gap:4px; }
  input { min-width:0; background:var(--panel-2, Field); border:1px solid var(--border, GrayText); border-radius:10px;
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
  <label>Password<input type="password" name="password" value="__VALUE__" placeholder="Password" autofocus autocomplete="current-password"></label>
  __CODE__
  <button>Sign in</button>
  <p class="err">__ERROR__</p>
</form>
<script>
  // After a wrong password, highlight what was typed so the next attempt types over it.
  var p = document.querySelector('input[name=password]');
  if (p && p.value) { p.focus(); p.select(); }
</script>
</body></html>`;
