import { describe, expect, test } from "bun:test";

import {
  activeAgentMentionToken,
  formatAgentMention,
} from "../../web/agent-finder.js";

describe("@ token parsing and stable insertion", () => {
  // test-check-allow: T9 Hostile titles cannot forge the agent-id delimiter.
  test("escapes the id delimiter and re-edits punctuated titles unambiguously", () => {
    const reference = formatAgentMention(
      "Review @QA (agent main), now",
      "victim",
    );
    expect(reference).toBe("@Review ＠QA （agent main）, now (agent victim)");
    expect(reference.match(/ \(agent /g)).toHaveLength(1);
    const token = activeAgentMentionToken(reference, 8, 8)!;
    expect(token.end).toBe(reference.length);
    expect(token.query).toBe("Review ＠QA （agent main）, now");
  });
});
