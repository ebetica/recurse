import { describe, expect, test } from "bun:test";
import { readAgentLink, readArtifactLink } from "../../web/deep-link.js";

// test-check-allow: T9 Reject traversal, malformed ids, oversized fragments.
test.each([
  ["#agent=main&artifact=Report-123", "Report-123"],
  ["", null],
  ["#artifact=../x", null],
  ["#artifact=" + "x".repeat(161), null],
  ["#artifact=x&pad=" + "x".repeat(512), null],
])("artifact link %s", (hash, id) => expect(readArtifactLink(hash!)).toBe(id));

describe("agent link parsing", () => {
  // test-check-allow: T9 Reject traversal, malformed ids, oversized fragments.
  test("keeps a present-but-rejected id distinguishable from no link at all", () => {
    for (const hash of [
      "#agent=",
      "#agent=a/b/c",
      "#agent=%2E%2E%2Fmain",
      "#agent=-leading",
      "#agent=" + "a".repeat(65),
      "#agent=a b",
      "#agent=<script>",
      "#agent=%E0%A4%A",
    ]) {
      expect(readAgentLink(hash)).toEqual({ present: true, id: null });
    }
  });

  // test-check-allow: T9 Reject traversal, malformed ids, oversized fragments.
  test("rejects an oversized fragment before parsing it", () => {
    expect(readAgentLink("#agent=main&pad=" + "x".repeat(600))).toEqual({
      present: false,
      id: null,
    });
  });
});
