import { describe, expect, test } from "bun:test";
import {
  agentMessageHeader,
  stripInternalNoticeLines,
} from "../../web/thread-render/turn-view";

import type { MessageEntry, TreeNode } from "../../web/types";

const REMINDER = [
  "Background shells still running (2):",
  "- abc123 (running, 4m12s) npm run dev",
  "- def456 (stopping, 30s) python server.py",
  "… and 1 more",
].join("\n");

const REAP_SPLIT = [
  "[recurse-origin-quoted: agent]",
  '[Subagent "review-pr666" (id abc123def456) was deleted.]',
].join("\n");

const REAP_SINGLE =
  "[recurse-origin-quoted: agent]" +
  ' [Subagent "review-pr666" (id abc123def456) was deleted.]';

describe("internal notice filter", () => {
  // test-check-allow: T9 Recorded screenshot reminder/reap envelopes.
  test("strips marker lines but keeps operator prose in mixed rows", () => {
    expect(stripInternalNoticeLines(`please continue\n${REMINDER}`)).toBe(
      "please continue",
    );
    expect(stripInternalNoticeLines(`${REAP_SPLIT}\nrun the tests next`)).toBe(
      "run the tests next",
    );
    expect(stripInternalNoticeLines(REAP_SINGLE)).toBe("");
    expect(stripInternalNoticeLines(REMINDER)).toBe("");
  });
});

// Regression: #2514 agent relationships use short, explicit family labels.
test("agent message headers retain names and identify each relationship", () => {
  const current = { id: "current", parent: "parent" };
  const nodes = Object.fromEntries(
    [
      ["child", "current"],
      ["parent", null],
      ["sibling", "parent"],
      ["other", null],
    ].map(([id, parent]) => [id, { id, parent, title: `${id} name` }]),
  ) as Record<string, TreeNode>;
  for (const [sender, relationship] of [
    ["child", "child agent"],
    ["parent", "parent agent"],
    ["sibling", "sibling agent"],
    ["other", "agent"],
    ["gone", "removed agent"],
  ]) {
    const header = agentMessageHeader(
      { from: sender, from_name: "Delivered name" } as MessageEntry,
      current,
      nodes,
    )!;
    expect(header.relationship).toBe(relationship!);
    expect(header.relationship).not.toMatch(
      /created|overseeing|supervisor|another/,
    );
    expect(header.senderName).toBe(
      sender === "gone" ? "Delivered name" : `${sender} name`,
    );
    expect(header.available).toBe(sender !== "gone");
  }
});
