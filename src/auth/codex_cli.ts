// Read Codex CLI OAuth access only, without sharing refresh credentials or state.
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { parsePythonJson } from "../utils/python-json";
import { OPENAI_CHOICE_MARKER, validCredentials } from "./provider_store";
import { readRegular } from "./service";

const MAX_CODEX_AUTH_BYTES = 64 * 1024;
const MAX_SETTINGS_AUTH_BYTES = 1024 * 1024;
export const CODEX_PROVIDER = "openai-codex";
export const OPENAI_PROVIDER = "openai";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type Json = Record<string, unknown>;

export interface CodexCliOptions {
  ambient: Readonly<Record<string, string | undefined>>;
  nowMs?: () => number;
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** base64.urlsafe_b64decode (non-strict binascii); null where it raises. */
function pyUrlsafeB64decode(text: string): Uint8Array | null {
  const input = text.replaceAll("-", "+").replaceAll("_", "/");
  const out: number[] = [];
  let quad = 0;
  let pads = 0;
  let acc = 0;
  for (const ch of input) {
    // Invariant: String input must be ASCII.
    if (ch.codePointAt(0)! > 0x7f) return null;
    if (ch === "=") {
      if (quad >= 2 && quad + ++pads >= 4) return Uint8Array.from(out);
      continue;
    }
    const value = B64.indexOf(ch);
    if (value < 0) continue;
    pads = 0;
    acc = (acc << 6) | value;
    quad += 1;
    if (quad === 2) out.push((acc >> 4) & 0xff);
    else if (quad === 3) out.push((acc >> 2) & 0xff);
    else if (quad === 4) {
      out.push(acc & 0xff);
      quad = 0;
      acc = 0;
    }
  }
  return quad === 0 ? Uint8Array.from(out) : null;
}

/** Unverified JWT claims; the token never reaches a log or error. */
function jwtClaims(token: unknown): Json | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1]! + "=".repeat((4 - (parts[1]!.length % 4)) % 4);
  const raw = pyUrlsafeB64decode(payload);
  if (raw === null) return null;
  try {
    const claims = parsePythonJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw),
    );
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** A JWT `exp` claim as Pi's absolute millisecond expiry, else 0. */
function jwtExpiry(token: unknown): number {
  const expires = jwtClaims(token)?.exp;
  if (typeof expires === "number") {
    const ms = expires * 1000;
    if (Number.isFinite(ms)) return Math.trunc(ms);
  }
  return 0;
}

/** The ChatGPT account id Pi sends as the chatgpt-account-id header. */
export function accountId(accessToken: unknown): string | null {
  const auth = jwtClaims(accessToken)?.[JWT_CLAIM_PATH];
  const account = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return typeof account === "string" && account ? account : null;
}

export function allowsCodexCli(data: Json | null): boolean {
  return (
    data !== null &&
    ![CODEX_PROVIDER, OPENAI_PROVIDER, OPENAI_CHOICE_MARKER].some((id) =>
      Object.hasOwn(data, id),
    ) &&
    validCredentials(data)
  );
}

/** Invalid or unreadable JSON is null. A missing file is an empty record. */
export async function readBoundedSettingsAuth(
  path: string,
): Promise<Json | null> {
  try {
    const bytes = await readRegular(path, MAX_SETTINGS_AUTH_BYTES);
    if (bytes === null) {
      await lstat(path);
      return null;
    }
    const data: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    return isRecord(data) ? data : null;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? {}
      : null;
  }
}

async function readCliFile(path: string): Promise<Uint8Array | null> {
  let handle;
  try {
    const before = await stat(path);
    if (!before.isFile() || before.size > MAX_CODEX_AUTH_BYTES) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > MAX_CODEX_AUTH_BYTES ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      return null;
    const buffer = new Uint8Array(MAX_CODEX_AUTH_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    return bytesRead <= MAX_CODEX_AUTH_BYTES
      ? buffer.subarray(0, bytesRead)
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readCodexCliAccess({
  ambient,
  nowMs = Date.now,
}: CodexCliOptions): Promise<OAuthCredential | undefined> {
  const codexHome =
    ambient.CODEX_HOME || join(ambient.HOME || homedir(), ".codex");
  const bytes = await readCliFile(join(codexHome, "auth.json"));
  if (bytes === null) return undefined;
  let data: unknown;
  try {
    data = parsePythonJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
  const tokens = isRecord(data) ? data.tokens : undefined;
  if (!isRecord(tokens)) return undefined;
  const access = tokens.access_token;
  if (typeof access !== "string" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(access))
    return undefined;
  const expires = jwtExpiry(access);
  // Pi normally refreshes within five minutes of expiry; only Codex CLI can do that here.
  if (expires <= nowMs() + 5 * 60 * 1000) return undefined;
  const account = accountId(access);
  if (!account || !/^[\w-]+$/.test(account)) return undefined;
  return { type: "oauth", access, expires, accountId: account, refresh: "" };
}

/** Only reads see the CLI credential; Pi's refresh callback only sees Settings credentials. */
export function withCodexCliAccess(
  stored: CredentialStore,
  authPath: string,
  ambient: CodexCliOptions["ambient"],
): CredentialStore {
  return {
    async read(id, options) {
      if (id !== CODEX_PROVIDER) return stored.read(id, options);
      options?.signal?.throwIfAborted();
      let data = await readBoundedSettingsAuth(authPath);
      let access: OAuthCredential | undefined;
      if (allowsCodexCli(data)) {
        access = await readCodexCliAccess({ ambient });
        if (access) data = await readBoundedSettingsAuth(authPath);
      }
      options?.signal?.throwIfAborted();
      if (data && Object.hasOwn(data, id)) return stored.read(id, options);
      return access && allowsCodexCli(data) ? access : undefined;
    },
    list: stored.list.bind(stored),
    modify: stored.modify.bind(stored),
    delete: stored.delete.bind(stored),
  };
}
