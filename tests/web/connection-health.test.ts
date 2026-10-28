import { describe, expect, test } from "bun:test";
import { responseOutcome } from "../../web/api.js";
import { ConnectionHealth } from "../../web/connection/health.js";

class FakeClock {
  value = 0;
  now = () => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}

describe("connection health state machine", () => {
  test("401 is auth-expired, 403 is neutral, and 5xx is unavailable", () => {
    expect(responseOutcome(401)).toBe("auth-expired");
    expect(responseOutcome(403)).toBe("neutral");
    expect(responseOutcome(500)).toBe("unavailable");
    expect(responseOutcome(503)).toBe("unavailable");
    expect(responseOutcome(422)).toBe("neutral");
    const clock = new FakeClock();
    const health = new ConnectionHealth(clock.now);
    const request = health.begin("core");
    health.settle(request, responseOutcome(401));
    expect(health.snapshot().phase).toBe("auth-expired");
  });
});
