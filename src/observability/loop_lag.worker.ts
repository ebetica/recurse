// Independent timer; shared slots are window start, version, observed window,
// next deadline and maximum lateness (monotonic epoch milliseconds).
// Odd versions mark a write; readers never wait for the writer.
// Skip the startup window: it began before this timer existed.
import { workerData } from "node:worker_threads";

const { buffer, intervalMs } = workerData as {
  buffer: SharedArrayBuffer;
  intervalMs: number;
};
const state = new BigInt64Array(buffer);
const clock = () =>
  BigInt(Math.floor(performance.timeOrigin + performance.now()));
let expected = clock() + BigInt(intervalMs);
let window = Atomics.load(state, 0);
let maximum = 0n;
let ready = false;

function publish(): void {
  if (!ready) return;
  Atomics.add(state, 1, 1n);
  Atomics.store(state, 2, window);
  Atomics.store(state, 3, expected);
  Atomics.store(state, 4, maximum);
  Atomics.add(state, 1, 1n);
}

function sample(): void {
  const now = clock();
  const start = Atomics.load(state, 0);
  if (start !== window) {
    window = start;
    maximum = 0n;
    ready = true;
  }
  const late = now - (expected > start ? expected : start);
  if (late > maximum) maximum = late;
  expected = now + BigInt(intervalMs);
  publish();
}

setInterval(sample, intervalMs);
