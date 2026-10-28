import { expect, test } from "bun:test";
import { ContextFallbackGate } from "../../web/context/fallback.js";

// Regression: #1990 coalesce context fallback requests per selected view
test("context fallback is requested once per selected conversation view", () => {
  const gate = new ContextFallbackGate();
  expect(gate.request("agent")).toBe(true);
  expect(gate.request("agent")).toBe(false);
  expect(gate.request("agent")).toBe(false);
  expect(gate.request("other-agent")).toBe(true);
  gate.settled("agent");
  gate.reset();
  expect(gate.request("agent")).toBe(true);
});
