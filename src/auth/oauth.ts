// Settings provider auth uses Pi's auth.json lock/merge via pi_auth_worker.mjs.
// This module reads launch selections and persists pending login PKCE state.
// Credentials cross pipes/target env only, never argv/logs/extra files/errors.
// Private writes start at 0600; token POST refuses redirects.
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PI_PACKAGE_ROOT } from "../build_dir";
import type { ProcessHandle, ProcessLifecycle } from "../process_lifecycle";
import { parsePythonJson, pyCompactJson } from "../utils/py_compact_json";
import type { ProviderCredentialStore } from "./provider_store";

export const AUTH_FILE_NAME = "auth.json";
export const HTTP_TIMEOUT_MS = 30_000;
// Browser User-Agent avoids token endpoints' Cloudflare bot refusal.
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const WORKER_PATH = join(import.meta.dir, "..", "pi_auth_worker.mjs");
const AUTH_REFRESH_SKEW_MS = 5 * 60 * 1000;
const AUTH_RESOLVE_TIMEOUT_MS = 75_000;
const WORKER_ENV_STRIP = [
  "PI_AUTH_JSON",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
];

type Json = Record<string, unknown>;
type Environment = Readonly<Record<string, string | undefined>>;

/** A message safe to show the operator (Python's ValueError). */
export class AuthInputError extends Error {
  override name = "AuthInputError";
}
/** Python's KeyError from an unguarded lookup. */
export class AuthKeyError extends Error {
  override name = "AuthKeyError";
}
/** A non-2xx token-endpoint status passed through unchanged (only 429). */
export class HttpStatusError extends Error {
  override name = "HttpStatusError";
  constructor(readonly status: number) {
    super(`HTTP Error ${status}`);
  }
}

export interface OAuthStoreOptions {
  /** coding_backend pi_agent_dir(): prepared, not necessarily created. */
  piAgentDir: () => Promise<string>;
  /** The server's ambient environment. */
  ambient: Environment;
  /** config.custom_model_providers() keys; failures mean none. */
  customProviderIds?: () => string[];
  lifecycle: ProcessLifecycle;
  workerPath?: string;
  /** The installed Pi package (default build_dir.PI_PACKAGE_ROOT). */
  piPackageRoot?: string;
  nowMs?: () => number;
  pid?: number;
}

export interface NativeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Largest accepted response line; the default suits credential replies. */
  maxOutputBytes?: number;
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPyNumber(value: unknown): value is number {
  return typeof value === "number";
}

const DECODE = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function readJsonText(path: string): Promise<unknown> {
  return parsePythonJson(DECODE.decode(new Uint8Array(await readFile(path))));
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

export function b64url(raw: Uint8Array): string {
  return Buffer.from(raw).toString("base64url");
}

export function sha256(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest());
}

/** Python truthiness for JSON values. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

export class OAuthStore implements ProviderCredentialStore {
  private readonly nowMs: () => number;
  constructor(readonly options: OAuthStoreOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Created Pi agent dir. */
  async agentDir(): Promise<string> {
    const dir = await this.options.piAgentDir();
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private customProviderIds(): string[] {
    try {
      const ids = this.options.customProviderIds?.() ?? [];
      return ids.filter((name) => typeof name === "string");
    } catch {
      return [];
    }
  }

  /** Whether an api_key selection exists for `provider`, and its key. */
  async storedApiKey(provider: string): Promise<[boolean, string | null]> {
    let data: unknown;
    try {
      data = await readJsonText(join(await this.agentDir(), AUTH_FILE_NAME));
    } catch (error) {
      if (errno(error) === "ENOENT") return [false, null];
      return [true, null];
    }
    if (!isRecord(data)) return [true, null];
    if (!(provider in data)) return [false, null];
    const credential = data[provider];
    if (
      isRecord(credential) &&
      credential.type === "api_key" &&
      typeof credential.key === "string" &&
      credential.key
    )
      return [true, credential.key];
    return [true, null];
  }

  packageRoot(): string {
    const override = this.options.ambient.RECURSE_PI_PACKAGE_ROOT;
    if (override) return override;
    return this.options.piPackageRoot ?? PI_PACKAGE_ROOT;
  }

  async workerEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.options.ambient))
      if (value !== undefined) env[name] = value;
    for (const name of WORKER_ENV_STRIP) delete env[name];
    env.RECURSE_PI_PACKAGE_ROOT = this.packageRoot();
    env.RECURSE_PI_AUTH_PATH = join(
      await this.options.piAgentDir(),
      AUTH_FILE_NAME,
    );
    return env;
  }

  private async stopNative(proc: WorkerProc): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);
    if (exited) return;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
    await proc.exited;
  }

  /** One JSONL request/response with the Pi auth worker. */
  async nativeRequest(
    request: Json,
    opts: NativeRequestOptions = {},
  ): Promise<Json> {
    const lifecycle = this.options.lifecycle;
    const timeoutMs = opts.timeoutMs ?? 75_000;
    let proc: WorkerProc | null = null;
    let handle: ProcessHandle | null = null;
    let handedOff = false;
    try {
      [proc, handle] = await lifecycle.spawnTracked<WorkerProc>(
        [process.execPath, this.options.workerPath ?? WORKER_PATH],
        "pi-auth",
        {
          cid: null,
          env: await this.workerEnv(),
          spawn: { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
        },
      );
      const child = proc;
      const payload = pyCompactJson(request) + "\n";
      const communicate = (async () => {
        try {
          child.stdin.write(payload);
          await child.stdin.end();
        } catch {}
        const out = new Uint8Array(
          await new Response(child.stdout).arrayBuffer(),
        );
        await child.exited;
        return out;
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const stdout = await Promise.race([
        communicate,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new NativeTimeout()), timeoutMs);
          if (opts.signal) {
            onAbort = () => reject(opts.signal!.reason ?? new Error("aborted"));
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]).finally(() => {
        clearTimeout(timer);
        if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      });
      if (
        stdout.length > (opts.maxOutputBytes ?? 64 * 1024) ||
        splitlinesCount(stdout) !== 1
      )
        throw new Error("Pi authentication worker protocol failed");
      let result: unknown;
      try {
        result = parsePythonJson(DECODE.decode(stdout));
      } catch {
        throw new Error("Pi authentication worker protocol failed");
      }
      if (!isRecord(result))
        throw new Error("Pi authentication worker protocol failed");
      if (child.exitCode !== 0 || result.kind === "error")
        throw new Error("Pi authentication operation failed");
      return result;
    } catch (error) {
      if (error instanceof NativeTimeout) {
        if (proc) await this.stopNative(proc);
        throw new Error("Pi authentication operation timed out");
      }
      if (opts.signal?.aborted && proc) {
        handedOff = true;
        if (!lifecycle.scheduleReap(proc)) {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }
      }
      throw error;
    } finally {
      if (handle && proc && !handedOff)
        await lifecycle.unregisterIfDead(handle, proc);
    }
  }

  /** Launch-time Anthropic selection read. */
  async storedAnthropic(): Promise<Record<string, string> | null> {
    let data: unknown;
    try {
      data = await readJsonText(
        join(await this.options.piAgentDir(), AUTH_FILE_NAME),
      );
    } catch (error) {
      return errno(error) === "ENOENT" ? null : {};
    }
    const credential = isRecord(data) ? data.anthropic : undefined;
    if (credential === undefined || credential === null) return null;
    if (!isRecord(credential)) return {};
    if (credential.type === "api_key") {
      const value = credential.key;
      return typeof value === "string" && value
        ? { ANTHROPIC_API_KEY: value }
        : {};
    }
    if (credential.type !== "oauth") return {};
    const value = credential.access;
    const expires = credential.expires;
    if (
      typeof value === "string" &&
      value &&
      isPyNumber(expires) &&
      expires > this.nowMs() + AUTH_REFRESH_SKEW_MS
    )
      return { ANTHROPIC_OAUTH_TOKEN: value };
    return {};
  }

  // The Settings-selected Claude env, resolved by Pi when not fresh on disk.
  async resolveAnthropic(): Promise<Record<string, string> | null> {
    const stored = await this.storedAnthropic();
    if (stored === null || Object.keys(stored).length) return stored;
    const result = await this.nativeRequest(
      { action: "resolve_anthropic" },
      { timeoutMs: AUTH_RESOLVE_TIMEOUT_MS },
    );
    if (result.kind !== "credential" || typeof result.changed !== "boolean")
      throw new Error("Pi could not resolve Claude authentication");
    if (result.selected === false) return null;
    const kind = result.credential_type;
    const value = result.value;
    if (
      result.selected !== true ||
      (kind !== "oauth" && kind !== "api_key") ||
      typeof value !== "string" ||
      !value
    )
      throw new Error("Pi could not resolve Claude authentication");
    return kind === "oauth"
      ? { ANTHROPIC_OAUTH_TOKEN: value }
      : { ANTHROPIC_API_KEY: value };
  }

  async replaceCredentials(
    provider: string,
    credential: Json,
    opts: { remove?: string[]; onlyIfMissing?: boolean } = {},
  ): Promise<boolean> {
    const result = await this.nativeRequest({
      action: "replace",
      provider,
      credential,
      remove: [...(opts.remove ?? [])],
      only_if_missing: opts.onlyIfMissing ?? false,
      custom_providers: this.customProviderIds(),
    });
    if (result.kind !== "complete")
      throw new Error("Pi could not save authentication");
    return result.changed !== false;
  }

  async removeCredentials(providers: string[]): Promise<void> {
    const result = await this.nativeRequest({
      action: "remove",
      providers: [...providers],
      custom_providers: this.customProviderIds(),
    });
    if (result.kind !== "complete")
      throw new Error("Pi could not remove authentication");
  }

  /** Replace `path` atomically with `payload` as mode-0600 indented JSON. */
  async writePrivate(path: string, payload: Json): Promise<void> {
    const tmp = `${path}.${this.options.pid ?? process.pid}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(pyCompactJson(payload, { indent: 2 }));
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  }

  async readAuth(): Promise<Json> {
    try {
      const data = await readJsonText(
        join(await this.agentDir(), AUTH_FILE_NAME),
      );
      return isRecord(data) ? data : {};
    } catch {
      return {};
    }
  }

  async writePending(name: string, payload: Json): Promise<void> {
    await this.writePrivate(join(await this.agentDir(), name), {
      ...payload,
      created: this.nowMs() / 1000,
    });
  }

  async readPending(name: string): Promise<Json | null> {
    try {
      const data = await readJsonText(join(await this.agentDir(), name));
      return isRecord(data) ? data : null;
    } catch {
      return null;
    }
  }

  async clearPending(name: string): Promise<void> {
    try {
      await unlink(join(await this.agentDir(), name));
    } catch {
      return;
    }
  }
}

type WorkerProc = {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  exited: Promise<number>;
  stdin: { write(data: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  kill(signal?: string | number): void;
};

class NativeTimeout extends Error {}

function splitlinesCount(data: Uint8Array): number {
  // Invariant: bytes.splitlines(): \n, \r and \r\n end lines; a final ending
  // adds none.
  let count = 0;
  let index = 0;
  let open = false;
  while (index < data.length) {
    const byte = data[index]!;
    if (byte === 0x0a || byte === 0x0d) {
      count += 1;
      open = false;
      if (byte === 0x0d && data[index + 1] === 0x0a) index += 1;
    } else open = true;
    index += 1;
  }
  return count + (open ? 1 : 0);
}

// Post OAuth form fields and parse JSON. 429 carries HttpStatusError for the
// local-exchange fallback; other HTTP errors retain status/body.
export async function postForm(
  url: string,
  body: Record<string, string>,
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Promise<Json> {
  const response = await fetch(url, {
    method: "POST",
    body: pyUrlencode(body),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  const raw = new Uint8Array(await response.arrayBuffer());
  if (response.status < 200 || response.status >= 300) {
    if (response.status === 429) throw new HttpStatusError(429);
    let detail = "";
    try {
      detail = [...DECODE.decode(raw)].slice(0, 300).join("");
    } catch {
      detail = "";
    }
    throw new Error(`token exchange failed (${response.status}): ${detail}`);
  }
  return parsePythonJson(DECODE.decode(raw)) as Json;
}

/**
 * Validate raw token-endpoint JSON the operator obtained locally. The text is
 * never echoed, not even in these errors.
 */
export function parseTokenJson(tokenText: string, restartHint: string): Json {
  const text = pyStrip(tokenText ?? "");
  if (!text) throw new AuthInputError("Paste the JSON the command printed.");
  let token: unknown;
  try {
    token = parsePythonJson(text);
  } catch {
    throw new AuthInputError(
      "That isn't valid JSON. Paste the whole { … } object the command printed.",
    );
  }
  if (!isRecord(token))
    throw new AuthInputError(
      "Unexpected format. Paste the whole { … } object.",
    );
  if (truthy(token.error))
    throw new AuthInputError(
      `The exchange returned an error (${pyStr(token.error)}). The code may ` +
        `have expired — start over with ${restartHint}.`,
    );
  return token;
}

/** Extract (code, state) from a raw code, `code#state`, or redirect URL. */
export function parseCode(pasted: string): [string, string | null] {
  const value = pyStrip(pasted ?? "");
  if (!value) throw new AuthInputError("empty authorization code");
  const split = pyUrlsplit(value);
  if (split && split.scheme && split.query) {
    const q = pyParseQs(split.query);
    if (q.code) return [q.code[0]!, q.state?.[0] ?? null];
  }
  const hash = value.indexOf("#");
  if (hash >= 0) return [value.slice(0, hash), value.slice(hash + 1)];
  if (value.includes("code=")) {
    const q = pyParseQs(value);
    if (!q.code) throw new AuthKeyError("code");
    return [q.code[0]!, q.state?.[0] ?? null];
  }
  return [value, null];
}

const PY_WHITESPACE =
  "\\t\\n\\x0b\\x0c\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, "g");

/** str.strip() with no argument. */
export function pyStrip(value: string): string {
  return value.replace(STRIP_RE, "");
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

/** urllib.parse.urlsplit's scheme and query; null where Python raises. */
function pyUrlsplit(input: string): { scheme: string; query: string } | null {
  // Invariant: WHATWG C0/space lstrip, then remove tab/CR/LF, as urlsplit does.
  let url = input.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const colon = url.indexOf(":");
  if (
    colon > 0 &&
    /^[A-Za-z]/.test(url) &&
    SCHEME_CHARS.test(url.slice(0, colon))
  ) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    let end = url.length;
    for (const ch of "/?#") {
      const at = url.indexOf(ch, 2);
      if (at >= 0) end = Math.min(end, at);
    }
    const netloc = url.slice(2, end);
    if (netloc.includes("[") !== netloc.includes("]")) return null;
    url = url.slice(end);
  }
  const hash = url.indexOf("#");
  if (hash >= 0) url = url.slice(0, hash);
  const question = url.indexOf("?");
  return { scheme, query: question >= 0 ? url.slice(question + 1) : "" };
}

/** urllib.parse.parse_qs with default arguments. */
function pyParseQs(qs: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const field of qs.split("&")) {
    if (!field) continue;
    const eq = field.indexOf("=");
    if (eq < 0) continue;
    const value = field.slice(eq + 1);
    if (!value.length) continue;
    const name = pyUnquotePlus(field.slice(0, eq));
    (out[name] ??= []).push(pyUnquotePlus(value));
  }
  return out;
}

function pyUnquotePlus(value: string): string {
  const text = value.replaceAll("+", " ");
  if (!text.includes("%")) return text;
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    new TextDecoder("utf-8").decode(
      Uint8Array.from(run.slice(1).split("%"), (hex) => parseInt(hex, 16)),
    ),
  );
}

/** urllib.parse.urlencode of a str→str mapping (quote_plus, safe ""). */
export function pyUrlencode(fields: Record<string, string>): string {
  const quote = (text: string) =>
    [...new TextEncoder().encode(text)]
      .map((byte) => {
        const ch = String.fromCharCode(byte);
        if (/[A-Za-z0-9_.\-~]/.test(ch)) return ch;
        if (byte === 0x20) return "+";
        return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      })
      .join("");
  return Object.entries(fields)
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join("&");
}

const NON_PRINTABLE = /[\p{C}\p{Z}]/u;

/** repr() of a Python str. */
export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${hex(code, 2)}`;
    else if (code < 0x7f || ch === " ") out += ch;
    else if (!NON_PRINTABLE.test(ch)) out += ch;
    else if (code < 0x100) out += `\\x${hex(code, 2)}`;
    else if (code < 0x10000) out += `\\u${hex(code, 4)}`;
    else out += `\\U${hex(code, 8)}`;
  }
  return out + quote;
}

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, "0");
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") return pyStrRepr(value);
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return pyNumber(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isRecord(value))
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`)
      .join(", ")}}`;
  return String(value);
}

function pyNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  return String(value);
}

/** str() of a JSON value (strings unquoted, containers as repr). */
export function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}
