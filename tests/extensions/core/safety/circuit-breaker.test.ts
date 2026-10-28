import { expect, test } from "bun:test";
import {
  DENIAL_LIMIT,
  DenialCircuitBreaker,
} from "../../../../src/extensions/core/safety/circuit-breaker.ts";

test("opens after repeated policy denials", () => {
  const breaker = new DenialCircuitBreaker();
  for (let count = 1; count < DENIAL_LIMIT; count += 1) {
    expect(breaker.recordDenial()).toEqual({ count, open: false });
  }
  expect(breaker.recordDenial()).toEqual({ count: DENIAL_LIMIT, open: true });
  expect(breaker.recordDenial().open).toBe(true);
});
