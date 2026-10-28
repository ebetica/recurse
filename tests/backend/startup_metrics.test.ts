import { expect, test } from "bun:test";
import { count, measure } from "../../src/observability/startup_metrics";

test("counts survive asynchronous work and emit when it settles", async () => {
  const output: string[] = [];
  const times = [4, 4.125];
  await measure(
    "async_step",
    async () => {
      await Promise.resolve();
      count("entries", 2);
    },
    { now: () => times.shift()!, write: (line) => output.push(line) },
  );
  expect(output).toEqual([
    "[startup] step=async_step duration_seconds=0.125000 entries=2",
  ]);
});

test("measurement emits its line when the operation throws", () => {
  const output: string[] = [];
  const times = [1, 1.5];
  expect(() =>
    measure(
      "failed_step",
      () => {
        throw new Error("synthetic failure");
      },
      { now: () => times.shift()!, write: (line) => output.push(line) },
    ),
  ).toThrow("synthetic failure");
  expect(output).toEqual([
    "[startup] step=failed_step duration_seconds=0.500000",
  ]);
});
