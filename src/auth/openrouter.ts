// OpenRouter's distinct key lives under openrouter and exports only its env
// key.
// Never authenticate/fall back to OpenAI. Models come from Pi's shared catalog.
import {
  pyError,
  pyStrip,
  type ProviderCredentialStore,
} from "./provider_store";

export const PROVIDER = "openrouter";
export const ENV_VAR = "OPENROUTER_API_KEY";

type Dict = Record<string, unknown>;

export interface OpenRouterOptions {
  store: ProviderCredentialStore;
  env: Readonly<Record<string, string | undefined>>;
}

export class OpenRouterAuth {
  constructor(private readonly options: OpenRouterOptions) {}

  async authStatus(): Promise<Dict> {
    const [selected, key] = await this.options.store.storedApiKey(PROVIDER);
    if (key)
      return { configured: true, type: "api_key", label: "OpenRouter API key" };
    if (!selected && this.options.env[ENV_VAR])
      return {
        configured: true,
        type: "api_key",
        label: "OpenRouter API key (environment)",
      };
    return { configured: false };
  }

  /** null means "no stored selection"; a selection without a key is {}. */
  async authEnv(): Promise<Record<string, string> | null> {
    const [selected, key] = await this.options.store.storedApiKey(PROVIDER);
    return selected ? (key ? { [ENV_VAR]: key } : {}) : null;
  }

  async setApiKey(key: string | null | undefined): Promise<void> {
    const value = pyStrip(key || "");
    if (!value) throw pyError("ValueError", "empty API key");
    await this.options.store.replaceCredentials(PROVIDER, {
      type: "api_key",
      key: value,
    });
  }

  async logout(): Promise<void> {
    await this.options.store.removeCredentials([PROVIDER]);
  }
}
