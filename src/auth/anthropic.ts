// Settings owns Claude subscription OAuth (code/PKCE, Pi refresh) or API key.
// Stored selection wins; only with none may an existing Claude Code login
// import.
// Environment/store/clock/endpoints are explicit inputs.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const defaultRandom = (size: number): Uint8Array =>
  new Uint8Array(randomBytes(size));
import { parsePythonJson } from "../utils/py_compact_json";
import {
  AuthInputError,
  AuthKeyError,
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

export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
// The API host processes the same grant without per-IP rate limiting.
export const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const REDIRECT_URI = "http://localhost:53692/callback";
export const SCOPES =
  "org:create_api_key user:profile user:inference " +
  "user:sessions:claude_code user:mcp_servers user:file_upload";
export const PROVIDER = "anthropic";
export const PENDING_FILE_NAME = "oauth_pending.json";
const RESTART_HINT = "“Sign in with Claude”";
const NO_LOGIN = "No login in progress. Start over with “Sign in with Claude”.";

type Json = Record<string, unknown>;
export type AuthStatus =
  | { configured: false }
  | { configured: true; type: string; label: string };

export interface AnthropicOptions {
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

export class AnthropicAuth {
  private readonly store: OAuthStore;
  constructor(readonly options: AnthropicOptions) {
    this.store = options.store;
  }

  private now(): number {
    return (this.options.nowMs ?? Date.now)();
  }

  private get tokenUrl(): string {
    return this.options.tokenUrl ?? TOKEN_URL;
  }

  /** Claude Code's OAuth file mapped to Pi's credential shape, or null. */
  async claudeCodeCredential(): Promise<Json | null> {
    const configDir =
      this.options.ambient.CLAUDE_CONFIG_DIR ||
      join(this.options.home ?? homedir(), ".claude");
    let data: unknown;
    try {
      data = parsePythonJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          new Uint8Array(await readFile(join(configDir, ".credentials.json"))),
        ),
      );
    } catch {
      return null;
    }
    const source = isRecord(data) ? data.claudeAiOauth : undefined;
    if (
      !isRecord(source) ||
      typeof source.refreshToken !== "string" ||
      !source.refreshToken
    )
      return null;
    const access = source.accessToken;
    const expires = source.expiresAt;
    return {
      type: "oauth",
      access:
        typeof access === "string" && access ? access : source.refreshToken,
      refresh: source.refreshToken,
      expires: typeof expires === "number" ? expires : 0,
    };
  }

  async ambientClaudeLogin(): Promise<boolean> {
    return (await this.claudeCodeCredential()) !== null;
  }

  private ambientOauthLogin(): boolean {
    const env = this.options.ambient;
    return Boolean(
      env.ANTHROPIC_AUTH_TOKEN ||
      env.ANTHROPIC_OAUTH_TOKEN ||
      env.CLAUDE_CODE_OAUTH_TOKEN,
    );
  }

  /** Import Claude Code OAuth only when Pi has no Anthropic selection. */
  async importClaudeCodeLogin(): Promise<boolean> {
    if (PROVIDER in (await this.store.readAuth())) return false;
    const credential = await this.claudeCodeCredential();
    if (credential === null) return false;
    return this.store.replaceCredentials(PROVIDER, credential, {
      onlyIfMissing: true,
    });
  }

  /** What authenticates Pi's Anthropic provider, for the Settings UI. */
  async authStatus(): Promise<AuthStatus> {
    const cred = (await this.store.readAuth())[PROVIDER];
    if (isRecord(cred) && (cred.type === "oauth" || cred.type === "api_key")) {
      const imported = await this.claudeCodeCredential();
      const detected =
        cred.type === "oauth" &&
        imported !== null &&
        cred.refresh === imported.refresh;
      const label = detected
        ? "Claude Code login (detected)"
        : cred.type === "oauth"
          ? "Claude subscription (OAuth)"
          : "API key";
      return { configured: true, type: cred.type, label };
    }
    if (this.ambientOauthLogin())
      return {
        configured: true,
        type: "oauth",
        label: "Claude subscription (environment)",
      };
    if (this.options.ambient.ANTHROPIC_API_KEY)
      return {
        configured: true,
        type: "api_key",
        label: "API key (environment)",
      };
    if (await this.ambientClaudeLogin())
      return {
        configured: true,
        type: "ambient",
        label: "Claude Code login (detected)",
      };
    return { configured: false };
  }

  /** Model-menu presence check; never refreshes or exposes credentials. */
  async claudeConfigured(): Promise<boolean> {
    const cred = (await this.store.readAuth())[PROVIDER];
    if (isRecord(cred) && (cred.type === "oauth" || cred.type === "api_key"))
      return true;
    return (
      this.ambientOauthLogin() ||
      Boolean(this.options.ambient.ANTHROPIC_API_KEY) ||
      (await this.ambientClaudeLogin())
    );
  }

  /** ProviderAuthSources.claudeAuthEnv. */
  claudeAuthEnv(): Promise<Record<string, string> | null> {
    return this.store.resolveAnthropic();
  }

  async setApiKey(key: string): Promise<void> {
    const trimmed = pyStrip(key ?? "");
    if (!trimmed) throw new AuthInputError("empty API key");
    await this.store.replaceCredentials(PROVIDER, {
      type: "api_key",
      key: trimmed,
    });
  }

  async logout(): Promise<void> {
    await this.store.removeCredentials([PROVIDER]);
  }

  /** Persist a PKCE verifier and return the authorize URL; state = verifier. */
  async startLogin(): Promise<{ url: string }> {
    const verifier = b64url((this.options.randomBytes ?? defaultRandom)(32));
    const challenge = b64url(sha256(verifier));
    await this.store.writePending(PENDING_FILE_NAME, { verifier });
    const query = pyUrlencode({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
    });
    return { url: `${AUTHORIZE_URL}?${query}` };
  }

  private async pendingVerifier(): Promise<string> {
    const pending = await this.store.readPending(PENDING_FILE_NAME);
    const verifier = pending?.verifier;
    if (typeof verifier !== "string" || !verifier)
      throw new AuthInputError(NO_LOGIN);
    return verifier;
  }

  private async pendingVerifierAndCode(
    pasted: string,
  ): Promise<[string, string]> {
    const verifier = await this.pendingVerifier();
    const [code, state] = parseCode(pasted);
    if (state && state !== verifier)
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
      state: verifier,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    };
  }

  private async storeOauth(token: Json): Promise<void> {
    for (const key of ["expires_in", "refresh_token", "access_token"])
      if (!(key in token)) throw new AuthKeyError(key);
    const expiresIn = token.expires_in;
    if (typeof expiresIn !== "number" && typeof expiresIn !== "boolean")
      throw new TypeError("expires_in is not a number");
    // Invariant: Pi stores an absolute expiry in ms with a 5-minute safety
    // margin.
    const expires = Math.trunc(
      this.now() + Number(expiresIn) * 1000 - 5 * 60 * 1000,
    );
    await this.store.replaceCredentials(PROVIDER, {
      type: "oauth",
      refresh: token.refresh_token,
      access: token.access_token,
      expires,
    });
  }

  /** Verify state, exchange the code, and store Pi's OAuth credential. */
  async completeLogin(pasted: string): Promise<AuthStatus> {
    const [verifier, code] = await this.pendingVerifierAndCode(pasted);
    const token = await (this.options.postForm ?? postForm)(
      this.tokenUrl,
      this.fields(code, verifier),
    );
    await this.storeOauth(token);
    await this.store.clearPending(PENDING_FILE_NAME);
    return this.authStatus();
  }

  /** A curl one-liner carrying only the code and verifier. */
  localExchangeCommands(code: string, verifier: string): { command: string } {
    const fields = this.fields(code, verifier);
    const url = this.tokenUrl;
    const curl =
      `curl -s ${url} ` +
      "-H 'content-type: application/x-www-form-urlencoded' " +
      Object.entries(fields)
        .map(([k, v]) => `-d '${k}=${v}'`)
        .join(" ");
    return { command: curl };
  }

  async localExchangeCommand(pasted: string): Promise<{ command: string }> {
    const [verifier, code] = await this.pendingVerifierAndCode(pasted);
    return this.localExchangeCommands(code, verifier);
  }

  /** Finish a subscription login from locally exchanged token JSON. */
  async completeLoginWithToken(tokenText: string): Promise<AuthStatus> {
    await this.pendingVerifier();
    const token = parseTokenJson(tokenText, RESTART_HINT);
    if (
      !truthy(token.access_token) ||
      !truthy(token.refresh_token) ||
      (typeof token.expires_in !== "number" &&
        typeof token.expires_in !== "boolean")
    )
      throw new AuthInputError(
        "That JSON is missing the tokens. Re-run the command and paste its " +
          "full output.",
      );
    await this.storeOauth(token);
    await this.store.clearPending(PENDING_FILE_NAME);
    return this.authStatus();
  }
}
