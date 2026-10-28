// Settings' updates for a supervised, self-deploying server: install.sh --check
// at most daily per installed release, cached in the data directory; "Update
// now" goes over the supervisor's IPC channel, never inherited by children.
// Hosted, isolated test, unsupervised and channel-less installs are skipped.
import { readFile, rename, writeFile } from "node:fs/promises";
import { selfDeployEnabledByEnv } from "./launcher/git";
import {
  NO_CHANNEL_EXIT,
  runInstallScript,
  scriptOutput,
  type UpdateReport,
  type UpdateRequest,
} from "./launcher/update";
import type { Release } from "./release";

export const CHECK_INTERVAL_SECONDS = 24 * 3600;
export const CHECK_TIMEOUT_SECONDS = 60;

export interface UpdateCheck {
  /** The installed release and commit this check is cached for. */
  readonly key: string;
  readonly checked_at: number;
  /** install.sh's channel: "release", "version X.Y.Z" or "branch NAME". */
  readonly channel: string | null;
  readonly installed: string | null;
  /** What an update would install; equal to `installed` when current. */
  readonly available: string | null;
  /** Why this checkout follows no channel, or null. */
  readonly skipped: string | null;
  readonly error: string | null;
}

export interface RecurseUpdateStatus {
  readonly release: Release;
  /** Why this Recurse is not checked or updated from Settings, or null. */
  readonly skipped: string | null;
  readonly checking: boolean;
  readonly channel: string | null;
  readonly installed: string | null;
  readonly available: string | null;
  readonly checked_at: number | null;
  readonly error: string | null;
  /** The supervisor's latest progress on an update, or null. */
  readonly update: Pick<UpdateReport, "state" | "detail"> | null;
}

export interface RecurseUpdatesDeps {
  readonly sourceRoot: string;
  /** The JSON file the last check is cached in. */
  readonly cacheFile: string;
  readonly release: Release;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The supervisor's IPC channel, or null when no supervisor started us. */
  readonly send: ((message: UpdateRequest) => void) | null;
  /** Run detached work whose signal aborts at shutdown (instance.tasks). */
  spawn(
    name: string,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
  readonly now?: () => number;
}

const IN_PROGRESS = new Set(["updating", "building", "waiting", "restarting"]);

function parseCheck(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return fields;
}

export class RecurseUpdates {
  private cached: UpdateCheck | null = null;
  private loaded: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private update: UpdateReport | null = null;

  constructor(private readonly deps: RecurseUpdatesDeps) {}

  private now(): number {
    return (this.deps.now ?? (() => Date.now() / 1000))();
  }

  private get key(): string {
    const { version, commit } = this.deps.release;
    return `${version} ${commit ?? ""}`.trim();
  }

  /** Why Settings neither checks nor updates this Recurse, or null. */
  private refusal(): string | null {
    if (this.deps.env.RECURSE_ISOLATED_ROOT)
      return "Updates are off for isolated test installs (RECURSE_ISOLATED_ROOT).";
    if (!selfDeployEnabledByEnv(this.deps.env))
      return "This is a hosted deployment (RECURSE_SELF_DEPLOY is off): it is updated by redeploying it, not from Settings.";
    if (!this.deps.send)
      return "Recurse was started with --once or --prebuilt, so it neither checks for updates nor restarts itself. Run `recurse update` in a terminal, then restart Recurse.";
    if (this.cached?.key === this.key && this.cached.skipped)
      return this.cached.skipped;
    return null;
  }

  /** Record the supervisor's progress report. */
  receive(message: unknown): void {
    const report = message as Partial<UpdateReport> | null;
    if (report?.type !== "update-status" || typeof report.state !== "string")
      return;
    this.update = {
      type: "update-status",
      state: report.state,
      detail: typeof report.detail === "string" ? report.detail : null,
    };
  }

  /** The cached check and update progress; starts a check when it is due. */
  async status(): Promise<RecurseUpdateStatus> {
    if (
      !this.deps.env.RECURSE_ISOLATED_ROOT &&
      selfDeployEnabledByEnv(this.deps.env) &&
      this.deps.send
    ) {
      await this.load();
      const last = this.cached;
      const due =
        last?.key !== this.key ||
        this.now() - last.checked_at >= CHECK_INTERVAL_SECONDS;
      if (due) this.startCheck();
    }
    const skipped = this.refusal();
    const check = skipped || this.cached?.key !== this.key ? null : this.cached;
    return {
      release: this.deps.release,
      skipped,
      checking: this.checking !== null,
      channel: check?.channel ?? null,
      installed: check?.installed ?? null,
      available: check?.available ?? null,
      checked_at: check?.checked_at ?? null,
      error: check?.error ?? null,
      update: this.update
        ? { state: this.update.state, detail: this.update.detail }
        : null,
    };
  }

  /** Ask the supervisor to update; a refusal reason when it cannot. */
  apply(): string | null {
    const refused = this.refusal();
    if (refused) return refused;
    if (this.update && IN_PROGRESS.has(this.update.state)) return null;
    this.update = { type: "update-status", state: "updating", detail: null };
    this.deps.send!({ type: "update" });
    return null;
  }

  private load(): Promise<void> {
    this.loaded ??= readFile(this.deps.cacheFile, "utf8")
      .then((text) => {
        const saved = JSON.parse(text);
        if (
          typeof saved?.key === "string" &&
          typeof saved.checked_at === "number"
        )
          this.cached = saved as UpdateCheck;
      })
      .catch(() => {});
    return this.loaded;
  }

  private startCheck(): void {
    if (this.checking) return;
    const run = this.deps
      .spawn("recurse-update-check", (signal) => this.check(signal))
      .catch(() => {})
      .finally(() => {
        if (this.checking === run) this.checking = null;
      });
    this.checking = run;
  }

  private async check(signal: AbortSignal): Promise<void> {
    const key = this.key;
    let result: UpdateCheck;
    try {
      const run = await runInstallScript(
        this.deps.sourceRoot,
        "--check",
        CHECK_TIMEOUT_SECONDS,
        signal,
      );
      const fields = parseCheck(run.stdout);
      const output = scriptOutput(run);
      result = {
        key,
        checked_at: this.now(),
        channel: run.returncode === 0 ? (fields.channel ?? null) : null,
        installed: run.returncode === 0 ? (fields.installed ?? null) : null,
        available: run.returncode === 0 ? (fields.available ?? null) : null,
        skipped:
          run.returncode === NO_CHANNEL_EXIT
            ? output.replace(/^error: /, "")
            : null,
        error:
          run.returncode === 0 || run.returncode === NO_CHANNEL_EXIT
            ? null
            : output || `install.sh --check exited ${run.returncode}`,
      };
    } catch (error) {
      result = {
        key,
        checked_at: this.now(),
        channel: null,
        installed: null,
        available: null,
        skipped: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (signal.aborted) return;
    this.cached = result;
    const temp = `${this.deps.cacheFile}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(result), { mode: 0o600 });
    await rename(temp, this.deps.cacheFile);
  }
}
