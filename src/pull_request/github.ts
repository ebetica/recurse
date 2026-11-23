// GitHub CLI calls share one backoff and run serially per conversation.
import { gitEnv, runBounded } from "../git";

type Env = Readonly<Record<string, string | undefined>>;

const GH_TIMEOUT = 4.0;
const decoder = new TextDecoder("utf-8");

export class GitHubCli {
  private readonly ghQueues = new Map<string, Promise<unknown>>();
  private ghBackoff = { seconds: 0, until: 0 };

  constructor(
    private readonly inputs: {
      env: Env;
      log?: (event: string, fields: Record<string, unknown>) => void;
    },
    private readonly now: () => number,
  ) {}

  // One logged `gh` call at a time per `queue` (a conversation); `parse`
  // rejects invalid output. Failures back all calls off, doubling from a
  // minute to 15, or until GitHub's latest exhausted rate-limit reset.
  gh<T>(
    queue: string,
    args: string[],
    cwd: string,
    reason: string,
    limit: number,
    parse: (r: { out: Uint8Array; truncated: boolean }) => T | undefined,
    timeout = GH_TIMEOUT,
  ): Promise<T | undefined> {
    const queued = this.now();
    const run = (this.ghQueues.get(queue) ?? Promise.resolve()).then(
      async () => {
        if (this.now() < this.ghBackoff.until) {
          this.inputs.log?.("gh_call_skipped", { reason, backoff: true });
          return undefined;
        }
        const r = await this.ghLogged(
          args,
          cwd,
          reason,
          limit,
          timeout,
          queued,
        );
        let value: T | undefined;
        try {
          value = r?.code === 0 ? parse(r) : undefined;
        } catch {}
        if (value !== undefined) {
          this.ghBackoff.seconds = 0;
          return value;
        }
        const seconds = Math.min(Math.max(60, this.ghBackoff.seconds * 2), 900);
        this.ghBackoff = {
          seconds,
          until: Math.max(this.ghBackoff.until, this.now() + seconds),
        };
        if (r === null) return undefined;
        const limits = await this.ghLogged(
          ["api", "rate_limit"],
          cwd,
          `${reason}_failed`,
          64 * 1024,
          GH_TIMEOUT,
          this.now(),
        );
        try {
          const resources = JSON.parse(decoder.decode(limits!.out)).resources;
          for (const { remaining, reset } of Object.values(resources) as {
            remaining?: unknown;
            reset?: unknown;
          }[])
            if (remaining === 0 && typeof reset === "number")
              this.ghBackoff.until = Math.max(
                this.ghBackoff.until,
                this.now() + reset - Date.now() / 1000,
              );
        } catch {}
        return undefined;
      },
    );
    const tail = run.catch(() => undefined);
    this.ghQueues.set(queue, tail);
    void tail.then(() => {
      if (this.ghQueues.get(queue) === tail) this.ghQueues.delete(queue);
    });
    return run;
  }

  private async ghLogged(
    args: string[],
    cwd: string,
    reason: string,
    limit: number,
    timeout: number,
    queued: number,
  ): ReturnType<typeof runBounded> {
    const env = gitEnv(this.inputs.env);
    env.GH_PAGER ??= "cat";
    env.NO_COLOR ??= "1";
    const started = this.now();
    const r = await runBounded(["gh", ...args], cwd, env, limit, timeout);
    this.inputs.log?.("gh_call", {
      reason,
      command: `gh ${args.slice(0, 2).join(" ")}`,
      exit: r?.code ?? null,
      waited_ms: Math.round((started - queued) * 1000),
      ms: Math.round((this.now() - started) * 1000),
    });
    return r;
  }
}
