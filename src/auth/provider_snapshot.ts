// Cached auth-provider snapshots keep Config reads synchronous.
// Model listings recheck only OpenAI, whose Codex CLI sign-in can change
// outside Settings. A Settings write always schedules a post-write refresh.
import { GEMINI_CREDENTIAL } from "./provider_store";

interface ProviderSnapshotSources {
  readonly anthropic: { claudeConfigured(): Promise<boolean> };
  readonly codex: {
    modelProviders(): Promise<Set<string>>;
    liveModelProviders(): Promise<Set<string> | undefined>;
  };
  readonly muse: { modelProviders(): Promise<Set<string>> };
  readonly openrouter: { authStatus(): Promise<Record<string, unknown>> };
  /** Configured custom endpoint names (config.custom_model_providers). */
  customProviderNames(): readonly string[];
  /** oauth.stored_api_key. */
  storedApiKey(provider: string): Promise<[boolean, string | null]>;
}

async function quiet<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

export class ProviderSnapshot {
  private builtIn: ReadonlySet<string> = new Set();
  private openAI: ReadonlySet<string> = new Set();
  private custom: ReadonlySet<string> = new Set();
  private running: Promise<void> | null = null;
  private readingOpenAI: Promise<boolean> | null = null;
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

  /** Recompute both sets, including any changes made during an earlier run. */
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

  /** Spot external Codex CLI changes without waiting for other providers. */
  refreshOpenAI(): Promise<boolean> {
    return (this.readingOpenAI ??= this.pollOpenAI().finally(() => {
      this.readingOpenAI = null;
    }));
  }

  private async pollOpenAI(): Promise<boolean> {
    const openAI = await quiet(
      () => this.sources.codex.liveModelProviders(),
      new Set<string>(),
    );
    if (!openAI) return false;
    const authed = new Set(this.builtIn);
    for (const id of this.openAI) authed.delete(id);
    for (const id of openAI) authed.add(id);
    this.openAI = openAI;
    this.builtIn = authed;
    return true;
  }

  private async compute(): Promise<void> {
    const { sources } = this;
    const authed = new Set<string>();
    if (await quiet(() => sources.anthropic.claudeConfigured(), false))
      authed.add("anthropic");
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
    const [, geminiKey] = await quiet(
      () => sources.storedApiKey(GEMINI_CREDENTIAL),
      [false, null],
    );
    if (geminiKey) authed.add(GEMINI_CREDENTIAL);
    for (const name of names) {
      const [, key] = await quiet(() => sources.storedApiKey(name), [
        false,
        null,
      ] as [boolean, string | null]);
      if (key) custom.add(name);
    }
    // Finish any pre-write poll before asking for the post-write state.
    await this.readingOpenAI;
    if (!(await this.refreshOpenAI()))
      this.openAI = await quiet(
        () => sources.codex.modelProviders(),
        new Set<string>(),
      );
    for (const id of this.openAI) authed.add(id);
    this.builtIn = authed;
    this.custom = custom;
  }
}
