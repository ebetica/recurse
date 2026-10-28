// Settings-owned credential-store interface shared by provider login flows.
// OAuthStore implements it; providers receive the store as an explicit input.

export interface ProviderCredentialStore {
  /** oauth.stored_api_key: [whether a selection exists, its usable key]. */
  storedApiKey(provider: string): Promise<[boolean, string | null]>;

  readAuth(): Promise<Record<string, unknown>>;
  /** oauth.replace_credentials, through Pi's auth-file lock. */
  replaceCredentials(
    provider: string,
    credential: Record<string, unknown>,
    opts?: { remove?: string[]; onlyIfMissing?: boolean },
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

const PY_WHITESPACE =
  /^[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t-\r\x1c-\x20\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;
/** Python str.strip() with no argument. */
export function pyStrip(value: string): string {
  return value.replace(PY_WHITESPACE, "");
}
