// Subscription usage limits from model responses Recurse already receives:
// Claude's anthropic-ratelimit-unified-* headers, ChatGPT's x-codex-* headers
// or codex.rate_limits events. It sends no requests and fails none; the latest
// values per login sit beside Pi's auth.json, with no credentials.
import { rename, readFile, rm, writeFile } from "node:fs/promises";
import type { Models } from "@earendil-works/pi-ai";

export type UsageProvider = "anthropic" | "openai-codex";
const PROVIDERS: readonly UsageProvider[] = ["anthropic", "openai-codex"];

export interface UsageWindow {
  /** The window's length: 300 for five hours, 10080 for a week. */
  minutes: number;
  used_percent: number;
  /** When the window resets, in epoch milliseconds. */
  resets_at: number | null;
}

export interface UsageSnapshot {
  /** When the response carrying these limits arrived, in epoch milliseconds. */
  checked_at: number;
  windows: UsageWindow[];
}

type Headers = Record<string, string | undefined>;

const number = (value: unknown): number =>
  typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;

function usageWindow(
  minutes: unknown,
  usedPercent: number,
  resetSeconds: number,
): UsageWindow[] {
  const length = number(minutes);
  if (!(length > 0) || !Number.isFinite(usedPercent)) return [];
  return [
    {
      minutes: length,
      used_percent: usedPercent,
      resets_at: Number.isFinite(resetSeconds) ? resetSeconds * 1000 : null,
    },
  ];
}

/** Claude's 5-hour and weekly windows; utilization is a fraction, resets are
 * epoch seconds. Responses the limiter did not rate carry no status. */
export function claudeWindows(headers: Headers): UsageWindow[] {
  const field = (name: string) =>
    headers[`anthropic-ratelimit-unified-${name}`];
  if (!field("status")) return [];
  return (
    [
      ["5h", 300],
      ["7d", 10080],
    ] as const
  ).flatMap(([claim, minutes]) =>
    usageWindow(
      minutes,
      number(field(`${claim}-utilization`)) * 100,
      number(field(`${claim}-reset`)),
    ),
  );
}

/** ChatGPT's primary and secondary windows: used percent, window length in
 * minutes, and reset as epoch seconds or seconds after the response. */
export function chatGptWindows(headers: Headers, now: number): UsageWindow[] {
  return ["primary", "secondary"].flatMap((slot) => {
    const field = (name: string) => number(headers[`x-codex-${slot}-${name}`]);
    const after = field("reset-after-seconds");
    return usageWindow(
      field("window-minutes"),
      field("used-percent"),
      Number.isFinite(field("reset-at"))
        ? field("reset-at")
        : now / 1000 + after,
    );
  });
}

/** The default `codex` limit of a ChatGPT `codex.rate_limits` stream event. */
export function chatGptEventWindows(event: unknown): UsageWindow[] {
  const data = event as {
    type?: unknown;
    metered_limit_name?: unknown;
    limit_name?: unknown;
    rate_limits?: Record<string, Record<string, unknown> | null | undefined>;
  } | null;
  if (data?.type !== "codex.rate_limits") return [];
  const limit = data.metered_limit_name ?? data.limit_name;
  if (limit !== undefined && limit !== null && limit !== "codex") return [];
  return ["primary", "secondary"].flatMap((slot) => {
    const window = data.rate_limits?.[slot];
    return window
      ? usageWindow(
          window.window_minutes,
          number(window.used_percent),
          number(window.reset_at),
        )
      : [];
  });
}

/** The latest usage limits per subscription login, kept in `file`. */
export class UsageLimits {
  /** Each login's latest snapshot; null once its login changed. */
  private readonly latest = new Map<UsageProvider, UsageSnapshot | null>();
  /** Each provider's login changes since startup. */
  private readonly logins = new Map<UsageProvider, number>();
  /** Credential changes running per provider; none records meanwhile. */
  private readonly changing = new Map<UsageProvider, number>();
  private loaded: Promise<void> | undefined;
  private saving: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The provider's current login, to pass back to record(). */
  login(provider: UsageProvider): number {
    return this.logins.get(provider) ?? 0;
  }

  /** Record what a response reports; a request sent under an earlier
   * `login` reports nothing. */
  record(provider: UsageProvider, windows: UsageWindow[], login: number): void {
    if (
      windows.length === 0 ||
      login !== this.login(provider) ||
      this.changing.has(provider)
    )
      return;
    this.latest.set(provider, { checked_at: this.now(), windows });
    this.save().catch(() => undefined);
  }

  /** Run a sign-in, sign-out or credential change, dropping the login's
   * snapshot from memory and the file before it starts and again once it
   * ends, and ignoring responses that arrive meanwhile. A file that cannot be
   * rewritten is removed; failing that, `change` does not run. */
  async changeLogin<T>(
    provider: UsageProvider,
    change: () => Promise<T>,
  ): Promise<T> {
    this.changing.set(provider, (this.changing.get(provider) ?? 0) + 1);
    try {
      this.drop(provider);
      await this.persist();
      return await change();
    } finally {
      this.drop(provider);
      const left = this.changing.get(provider)! - 1;
      if (left > 0) this.changing.set(provider, left);
      else this.changing.delete(provider);
      await this.persist();
    }
  }

  /** Forget the snapshot and every call started under the current login. */
  private drop(provider: UsageProvider): void {
    this.logins.set(provider, this.login(provider) + 1);
    this.latest.set(provider, null);
  }

  private async persist(): Promise<void> {
    await this.save().catch(() => rm(this.file, { force: true }));
  }

  async read(provider: UsageProvider): Promise<UsageSnapshot | undefined> {
    await this.load();
    return this.latest.get(provider) ?? undefined;
  }

  private load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8")
      .then((text) => {
        const stored = JSON.parse(text) as Record<string, UsageSnapshot>;
        for (const provider of PROVIDERS) {
          const snapshot = stored?.[provider];
          if (
            !this.latest.has(provider) &&
            typeof snapshot?.checked_at === "number" &&
            Array.isArray(snapshot.windows)
          )
            this.latest.set(provider, snapshot);
        }
      })
      .catch(() => undefined);
    return this.loaded;
  }

  /** One write at a time; a change during a write writes once more. Rejects
   * when the file could not be written. */
  private save(): Promise<void> {
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    const saving = (async () => {
      try {
        await this.load();
        do {
          this.again = false;
          const tmp = `${this.file}.tmp`;
          await writeFile(
            tmp,
            JSON.stringify(Object.fromEntries(this.latest)) + "\n",
            { mode: 0o600 },
          );
          await rename(tmp, this.file);
        } while (this.again);
      } finally {
        this.saving = undefined;
      }
    })();
    this.saving = saving;
    return saving;
  }
}

/** `models` whose Claude and ChatGPT calls record the limits their
 * responses report into `limits`. */
export function observeUsageLimits<T extends Models>(
  models: T,
  limits: Pick<UsageLimits, "login" | "record">,
  now: () => number = Date.now,
): T {
  const observe = (
    provider: UsageProvider,
    login: number,
    windows: () => UsageWindow[],
  ) => {
    try {
      limits.record(provider, windows(), login);
    } catch {
      // Invariant: An unreadable limit never fails the model call.
    }
  };
  const methods = new Set([
    "stream",
    "streamSimple",
    "complete",
    "completeSimple",
  ]);
  return new Proxy(models, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (!methods.has(String(key))) return value.bind(target);
      return (
        model: { provider?: string },
        context: unknown,
        options?: Record<string, unknown>,
      ) => {
        const provider = model.provider;
        if (provider !== "anthropic" && provider !== "openai-codex")
          return value.call(target, model, context, options);
        const login = limits.login(provider);
        type Callback = (...args: unknown[]) => unknown;
        const onResponse = options?.onResponse as Callback | undefined;
        const onEvent = options?.onProviderStreamEvent as Callback | undefined;
        return value.call(target, model, context, {
          ...options,
          onResponse: (
            response: { status: number; headers: Headers },
            actual: unknown,
          ) => {
            if (response.status < 400)
              observe(provider, login, () =>
                provider === "anthropic"
                  ? claudeWindows(response.headers)
                  : chatGptWindows(response.headers, now()),
              );
            return onResponse?.(response, actual);
          },
          ...(provider === "openai-codex" && {
            onProviderStreamEvent: (event: unknown, actual: unknown) => {
              observe(provider, login, () => chatGptEventWindows(event));
              return onEvent?.(event, actual);
            },
          }),
        });
      };
    },
  });
}
