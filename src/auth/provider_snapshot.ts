// Cached auth-provider snapshots keep Config reads synchronous.
// Refresh at startup/Settings auth changes before rewriting the model catalog.
// External edits wait for refresh. Concurrent refreshes share work; a request
// during a run schedules one more, so the last change wins.

export interface ProviderSnapshotSources {
  readonly anthropic: { claudeConfigured(): Promise<boolean> };
  readonly codex: { modelProviders(): Promise<Set<string>> };
  readonly muse: { modelProviders(): Promise<Set<string>> };
  readonly openrouter: { authStatus(): Promise<Record<string, unknown>> };
  /** Configured custom endpoint names (config.custom_model_providers). */
  customProviderNames(): readonly string[];
  /** oauth.stored_api_key. */
  storedApiKey(provider: string): Promise<[boolean, string | null]>;
}

export class ProviderSnapshot {
  private builtIn: ReadonlySet<string> = new Set();
  private custom: ReadonlySet<string> = new Set();
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly sources: ProviderSnapshotSources) {}

  /** Built-in providers logged in at the last refresh. */
  authenticatedProviders(): ReadonlySet<string> {
    return this.builtIn;
  }

  /** Custom endpoints with a stored API key at the last refresh. */
  storedCustomProviders(): ReadonlySet<string> {
    return this.custom;
  }

  /** Recompute both sets; resolves once a run started after this call ends. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async () => {
      do {
        this.again = false;
        await this.compute();
      } while (this.again);
    })();
    this.running = run.finally(() => (this.running = null));
    return this.running;
  }

  private async compute(): Promise<void> {
    const { sources } = this;
    const quiet = async <T>(work: () => Promise<T>, fallback: T) => {
      try {
        return await work();
      } catch {
        return fallback;
      }
    };
    const authed = new Set<string>();
    if (await quiet(() => sources.anthropic.claudeConfigured(), false))
      authed.add("anthropic");
    for (const provider of await quiet(
      () => sources.codex.modelProviders(),
      new Set<string>(),
    ))
      authed.add(provider);
    for (const provider of await quiet(
      () => sources.muse.modelProviders(),
      new Set<string>(),
    ))
      authed.add(provider);
    const openrouter = await quiet(() => sources.openrouter.authStatus(), {});
    if (openrouter.configured) authed.add("openrouter");
    const custom = new Set<string>();
    let names: readonly string[] = [];
    try {
      names = sources.customProviderNames();
    } catch {
      names = [];
    }
    for (const name of names) {
      const [, key] = await quiet(() => sources.storedApiKey(name), [
        false,
        null,
      ] as [boolean, string | null]);
      if (key) custom.add(name);
    }
    this.builtIn = authed;
    this.custom = custom;
  }
}
