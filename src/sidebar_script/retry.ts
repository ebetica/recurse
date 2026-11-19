// Every sidebar script run goes through runRetryingTimeout: the sandbox's
// budget is wall-clock time, so a busy device or server can time out a quick
// script. The browser's script worker and the server's dry run both use it.
import type { ScriptResult } from "./engine/index.js";

const RETRY_MS = 500;

/** Run; if it timed out and is still wanted, run once more after `pause`. */
export async function runRetryingTimeout(
  run: () => Promise<ScriptResult>,
  wanted: () => boolean = () => true,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, RETRY_MS)),
): Promise<ScriptResult> {
  const result = await run();
  if (!("timeout" in result) || !wanted()) return result;
  await pause();
  return wanted() ? run() : result;
}

/** Runs the newest input only and reports results no newer input replaced. */
export class LatestRun<Input> {
  finished: Promise<void> = Promise.resolve();
  #next: Input | null = null;
  #running = false;
  #endPause = () => {};
  readonly #run: (input: Input) => Promise<ScriptResult>;
  readonly #done: (input: Input, result: ScriptResult) => void;

  constructor(
    run: (input: Input) => Promise<ScriptResult>,
    done: (input: Input, result: ScriptResult) => void,
  ) {
    [this.#run, this.#done] = [run, done];
  }

  push(input: Input): void {
    this.#next = input;
    this.#endPause();
    if (!this.#running) this.finished = this.#drain();
  }

  async #drain(): Promise<void> {
    this.#running = true;
    while (this.#next !== null) {
      const input: Input = this.#next;
      this.#next = null;
      // Invariant: newer input ends a timed-out run's retry pause at once, so
      // an update never waits out the pause of a retry it replaces.
      const result = await runRetryingTimeout(
        () => this.#run(input),
        () => this.#next === null,
        () =>
          new Promise((resolve) => {
            const end = () => {
              clearTimeout(timer);
              this.#endPause = () => {};
              resolve();
            };
            const timer = setTimeout(end, RETRY_MS);
            this.#endPause = end;
          }),
      );
      if (this.#next === null) this.#done(input, result);
    }
    this.#running = false;
  }
}
