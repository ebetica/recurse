// Compare server run-state snapshots without synchronizing client clocks.
import { randomUUID } from "node:crypto";

const epoch = randomUUID();
export function runStateClock(): [string, number] {
  return [epoch, performance.now()];
}
