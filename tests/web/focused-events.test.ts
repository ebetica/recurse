import { describe, expect, test } from "bun:test";
import { focusedEventsUrl } from "../../web/focused-events";

describe("focusedEventsUrl", () => {
  // test-check-allow: T9 Encoded owner id cannot inject path/query.
  test("encodes the conversation id", () => {
    expect(focusedEventsUrl("a?b&c")).toBe(
      "/api/conversations/a%3Fb%26c/events",
    );
  });
});
