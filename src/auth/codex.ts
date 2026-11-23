// Settings stores ChatGPT OAuth as openai-codex, API keys as openai.
// The credentials are independent; neither route authenticates the other.
import { randomBytes } from "node:crypto";
import {
  accountId,
  OPENAI_PROVIDER,
  allowsCodexCli,
  CODEX_PROVIDER,
  readCodexCliAccess,
  type CodexCliOptions,
} from "./codex_cli";
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

export { accountId } from "./codex_cli";

const defaultRandom = (size: number): Uint8Array =>
  new Uint8Array(randomBytes(size));

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPES = "openid profile email offline_access";
const ORIGINATOR = "pi";
const PENDING_FILE_NAME = "codex_oauth_pending.json";
const RESTART_HINT = "“Sign in with ChatGPT”";
const NO_LOGIN =
  "No login in progress. Start over with “Sign in with ChatGPT”.";
type Json = Record<string, unknown>;

interface OpenAIAuthStatus {
  subscription: "signed_in" | "codex_cli" | null;
  api_key: "saved" | "environment" | null;
}

interface CodexOptions extends CodexCliOptions {
  store: OAuthStore;
  randomBytes?: (size: number) => Uint8Array;
  tokenUrl?: string;
  postForm?: (url: string, body: Record<string, string>) => Promise<Json>;
}

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    await this.store.replaceCredentials(OPENAI_PROVIDER, {
      type: "api_key",
      key: trimmed,
    });
  }

  /** Pi providers enabled by saved or ambient credentials. */
  async modelProviders(): Promise<Set<string>> {
    return this.providersFor(await this.authStatus());
  }

  /** Poll only normal installs; read-only sign-ins keep their startup snapshot. */
  async liveModelProviders(): Promise<Set<string> | undefined> {
    if (this.options.ambient.RECURSE_READ_ONLY_SIGN_INS) return undefined;
    return this.modelProviders();
  }

  private providersFor({
    subscription,
    api_key,
  }: OpenAIAuthStatus): Set<string> {
    const providers = new Set<string>();
    if (subscription) providers.add(CODEX_PROVIDER);
    if (api_key) providers.add(OPENAI_PROVIDER);
    return providers;
  }

  async authStatus(): Promise<OpenAIAuthStatus> {
    const { ambient } = this.options;
    const readOnly = ambient.RECURSE_READ_ONLY_SIGN_INS;
    let data = readOnly
      ? await this.store.readAuth()
      : await this.store.readBoundedAuth();
    let cli = false;
    if (
      !readOnly &&
      allowsCodexCli(data) &&
      (await readCodexCliAccess(this.options))
    ) {
      data = await this.store.readBoundedAuth();
      cli = allowsCodexCli(data);
    }
    if (!data) return { subscription: null, api_key: null };
    const subscription = data[CODEX_PROVIDER];
    const apiKey = data[OPENAI_PROVIDER];
    const signedIn = isRecord(subscription) && subscription.type === "oauth";
    const saved = isRecord(apiKey) && apiKey.type === "api_key";
    if (signedIn || saved) {
      return {
        subscription: signedIn ? "signed_in" : null,
        api_key: saved ? "saved" : null,
      };
    }
    return {
      subscription: cli ? "codex_cli" : null,
      api_key: ambient.OPENAI_API_KEY ? "environment" : null,
    };
  }

  async logout(): Promise<void> {
    await this.store.removeCredentials([CODEX_PROVIDER]);
  }

  async removeApiKey(): Promise<void> {
    await this.store.removeCredentials([OPENAI_PROVIDER]);
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
    await this.store.replaceCredentials(CODEX_PROVIDER, {
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
