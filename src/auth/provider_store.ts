// Settings-owned credential-store interface shared by provider login flows.
// OAuthStore implements it; providers receive the store as an explicit input.

/** Reserved auth.json marker, not a provider ID. */
export const OPENAI_CHOICE_MARKER = "$recurse.openai-choice";

export function validCredential(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { type, access, refresh, expires, key, env } = value as Record<
    string,
    unknown
  >;
  if (type === "oauth")
    return (
      typeof access === "string" &&
      access.length > 0 &&
      typeof refresh === "string" &&
      refresh.length > 0 &&
      typeof expires === "number" &&
      Number.isFinite(expires)
    );
  return (
    type === "api_key" &&
    ((typeof key === "string" && key.length > 0) ||
      (env !== null && typeof env === "object" && Object.keys(env).length > 0))
  );
}

/** Validate the whole Pi auth file for Settings writes and live fallback reads. */
export function validCredentials(
  data: unknown,
): data is Record<string, unknown> {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.values(data).every(validCredential)
  );
}

export interface ProviderCredentialStore {
  /** oauth.stored_api_key: [whether a selection exists, its usable key]. */
  storedApiKey(provider: string): Promise<[boolean, string | null]>;

  readAuth(): Promise<Record<string, unknown>>;
  /** oauth.replace_credentials, through Pi's auth-file lock. */
  replaceCredentials(
    provider: string,
    credential: Record<string, unknown>,
    opts?: { onlyIfMissing?: boolean },
  ): Promise<boolean>;
  /** oauth.remove_credentials. */
  removeCredentials(providers: string[]): Promise<void>;
  /** oauth.write_pending: adds a "created" timestamp, mode 0600. */
  writePending(name: string, payload: Record<string, unknown>): Promise<void>;
  /** oauth.read_pending: null when missing, unreadable or not an object. */
  readPending(name: string): Promise<Record<string, unknown> | null>;
  /** oauth.clear_pending. */
  clearPending(name: string): Promise<void>;
  /** oauth._write_private: atomic mode-0600 JSON with indent=2. */
  writePrivate(path: string, payload: Record<string, unknown>): Promise<void>;
  /** oauth._native_request: one request to the Pi auth worker. */
  nativeRequest(
    request: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
  /** oauth.agent_dir. */
  agentDir(): Promise<string>;
}

/** An Error whose name is the Python exception class it stands for. */
export function pyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

export { pyStrip } from "../utils/python-whitespace";
