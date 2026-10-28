import { expect, test } from "bun:test";
import { timeoutScheduler } from "../../src/agents/runtime/stall_timer";

test("the real scheduler fires once and drop cancels", async () => {
  let fired = 0;
  const done = Promise.withResolvers<void>();
  const handle = timeoutScheduler.callLater(0.001, () => {
    fired += 1;
    done.resolve();
  });
  const dropped = timeoutScheduler.callLater(0.001, () => (fired += 10));
  dropped.cancel();
  await done.promise;
  handle.cancel();
  expect(fired).toBe(1);
});
