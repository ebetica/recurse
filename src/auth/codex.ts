// Settings stores ChatGPT OAuth as openai-codex, API keys as openai.
// The credentials are independent; neither route authenticates the other.
// Codex CLI import runs only once, before any explicit OpenAI choice.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const defaultRandom = (size: number): Uint8Array =>
  new Uint8Array(randomBytes(size));
import { parsePythonJson } from "../utils/python-json";
import { OPENAI_CHOICE_MARKER } from "./provider_store";
import {
  AuthInputError,
  OAuthStore,
  b64url,
  parseCode,
  parseTokenJson,
  postForm,
  pyStrip,
  pyUrlencode,
  sha256,
  truthy,
} from "./oauth";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPES = "openid profile email offline_access";
const ORIGINATOR = "pi";
const PROVIDER = "openai-codex";
const API_PROVIDER = "openai";
const PENDING_FILE_NAME = "codex_oauth_pending.json";
const RESTART_HINT = "“Sign in with ChatGPT”";
const NO_LOGIN =
  "No login in progress. Start over with “Sign in with ChatGPT”.";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type Json = Record<string, unknown>;

interface OpenAIAuthStatus {
  subscription: "signed_in" | "imported" | "detected" | null;
  api_key: "saved" | "environment" | null;
}

interface CodexOptions {
  store: OAuthStore;
  ambient: Readonly<Record<string, string | undefined>>;
  home?: string;
  nowMs?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  tokenUrl?: string;
  postForm?: (url: string, body: Record<string, string>) => Promise<Json>;
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

export class CodexAuth {
  private readonly store: OAuthStore;
  constructor(readonly options: CodexOptions) {
    this.store = options.store;
  }

  private get tokenUrl(): string {
    return this.options.tokenUrl ?? TOKEN_URL;
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = pyStrip(key ?? "");
    if (!trimmed) throw new AuthInputError("empty API key");
    await this.store.replaceCredentials(API_PROVIDER, {
      type: "api_key",
      key: trimmed,
    });
  }

  private async storedSignIns() {
    const data = await this.store.readAuth();
    const subscription = data[PROVIDER];
    const apiKey = data[API_PROVIDER];
    return {
      subscription:
        isRecord(subscription) && subscription.type === "oauth"
          ? subscription
          : null,
      apiKey: isRecord(apiKey) && apiKey.type === "api_key",
      cliImportBlocked: Object.hasOwn(data, OPENAI_CHOICE_MARKER),
    };
  }

  /** Codex CLI's auth.json tokens mapped to Pi's openai-codex shape. */
  async codexCliCredential(): Promise<Json | null> {
    const codexHome =
      this.options.ambient.CODEX_HOME ||
      join(this.options.home ?? homedir(), ".codex");
    let data: unknown;
    try {
      data = parsePythonJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          new Uint8Array(await readFile(join(codexHome, "auth.json"))),
        ),
      );
    } catch {
      return null;
    }
    const tokens = isRecord(data) ? data.tokens : undefined;
    if (!isRecord(tokens)) return null;
    const access = tokens.access_token;
    const refresh = tokens.refresh_token;
    if (typeof access !== "string" || !access) return null;
    if (typeof refresh !== "string" || !refresh) return null;
    let account: unknown = tokens.account_id;
    if (typeof account !== "string" || !pyStrip(account))
      account = accountId(tokens.id_token);
    if (typeof account !== "string" || !pyStrip(account)) return null;
    return {
      type: "oauth",
      access,
      refresh,
      // Invariant: Codex CLI does not persist expires_in; 0 forces an immediate
      // refresh.
      expires: jwtExpiry(access) || jwtExpiry(tokens.id_token),
      accountId: account,
    };
  }

  /** Import Codex CLI OAuth once, only with no saved OpenAI choice. */
  async importCodexCliLogin(): Promise<boolean> {
    const { subscription, apiKey, cliImportBlocked } =
      await this.storedSignIns();
    if (cliImportBlocked || subscription || apiKey) return false;
    const credential = await this.codexCliCredential();
    if (credential === null) return false;
    return this.store.replaceCredentials(PROVIDER, credential, {
      onlyIfMissing: true,
    });
  }

  /** Pi providers enabled by saved or ambient credentials. */
  async modelProviders(): Promise<Set<string>> {
    const { subscription, api_key } = await this.authStatus();
    const providers = new Set<string>();
    if (subscription) providers.add(PROVIDER);
    if (api_key) providers.add(API_PROVIDER);
    return providers;
  }

  async authStatus(): Promise<OpenAIAuthStatus> {
    const { subscription, apiKey, cliImportBlocked } =
      await this.storedSignIns();
    if (subscription || apiKey) {
      const imported = subscription ? await this.codexCliCredential() : null;
      return {
        subscription: subscription
          ? imported && subscription.refresh === imported.refresh
            ? "imported"
            : "signed_in"
          : null,
        api_key: apiKey ? "saved" : null,
      };
    }
    if (this.options.ambient.OPENAI_API_KEY)
      return { subscription: null, api_key: "environment" };
    return {
      subscription:
        !cliImportBlocked && (await this.codexCliCredential())
          ? "detected"
          : null,
      api_key: null,
    };
  }

  async logout(): Promise<void> {
    await this.store.removeCredentials([PROVIDER]);
  }

  async removeApiKey(): Promise<void> {
    await this.store.removeCredentials([API_PROVIDER]);
  }

  /** Persist PKCE state; return the authorize URL and the redirect address
   * whose unreachable page the user pastes back. */
  async startLogin(): Promise<{ url: string; redirectUrl: string }> {
    const random = this.options.randomBytes ?? defaultRandom;
    const verifier = b64url(random(32));
    const challenge = b64url(sha256(verifier));
    const state = Buffer.from(random(16)).toString("hex");
    await this.store.writePending(PENDING_FILE_NAME, { verifier, state });
    const query = pyUrlencode({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: ORIGINATOR,
    });
    return { url: `${AUTHORIZE_URL}?${query}`, redirectUrl: REDIRECT_URI };
  }

  private async pending(): Promise<[string, string | null]> {
    const pending = await this.store.readPending(PENDING_FILE_NAME);
    const verifier = pending?.verifier;
    if (typeof verifier !== "string" || !verifier)
      throw new AuthInputError(NO_LOGIN);
    const state = pending?.state;
    return [verifier, typeof state === "string" ? state : null];
  }

  private async verifierAndCode(pasted: string): Promise<[string, string]> {
    const [verifier, expected] = await this.pending();
    const [code, state] = parseCode(pasted);
    if (state && expected && state !== expected)
      throw new AuthInputError(
        "Authorization state mismatch. Please start over.",
      );
    return [verifier, code];
  }

  private fields(code: string, verifier: string): Record<string, string> {
    return {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    };
  }

  async completeLogin(pasted: string): Promise<OpenAIAuthStatus> {
    const [verifier, code] = await this.verifierAndCode(pasted);
    const token = await (this.options.postForm ?? postForm)(
      this.tokenUrl,
      this.fields(code, verifier),
    );
    return this.storeFromToken(token);
  }

  private async storeFromToken(token: Json): Promise<OpenAIAuthStatus> {
    const access = token.access_token;
    const expiresIn = token.expires_in;
    if (
      !truthy(access) ||
      !truthy(token.refresh_token) ||
      (typeof expiresIn !== "number" && typeof expiresIn !== "boolean")
    )
      throw new AuthInputError(
        "Codex login response was missing tokens. Try again.",
      );
    const account = accountId(access);
    if (!account)
      throw new AuthInputError(
        "Signed in, but this account has no Codex (ChatGPT Plus/Pro) plan. " +
          "Codex needs a paid ChatGPT subscription.",
      );
    // Invariant: Pi stores an absolute expiry in ms with no safety margin.
    const expires = Math.trunc(
      (this.options.nowMs ?? Date.now)() + Number(expiresIn) * 1000,
    );
    await this.store.replaceCredentials(PROVIDER, {
      type: "oauth",
      refresh: token.refresh_token,
      access,
      expires,
      accountId: account,
    });
    await this.store.clearPending(PENDING_FILE_NAME);
    return this.authStatus();
  }

  localExchangeCommands(code: string, verifier: string): { command: string } {
    const fields = this.fields(code, verifier);
    const curl =
      `curl -s ${this.tokenUrl} ` +
      Object.entries(fields)
        .map(([k, v]) => `--data-urlencode ${k}=${v}`)
        .join(" ");
    return { command: curl };
  }

  async localExchangeCommand(pasted: string): Promise<{ command: string }> {
    const [verifier, code] = await this.verifierAndCode(pasted);
    return this.localExchangeCommands(code, verifier);
  }

  async completeLoginWithToken(tokenText: string): Promise<OpenAIAuthStatus> {
    await this.pending();
    return this.storeFromToken(parseTokenJson(tokenText, RESTART_HINT));
  }
}
