import { describe, expect, test } from "bun:test";
import { stripInternalNoticeLines } from "../../web/thread-render/turn-view";

const DIGEST_BUBBLE = [
  "## Runtime context",
  "- Working directory: /repo",
  "",
  "## Digest: agent tree",
  "abc123 [idle] - Review auth (you)",
  "<system_reminder>",
  "Reminder: reap agents you no longer need.",
  "</system_reminder>",
  "",
  "## Message",
  "please review the plan",
].join("\n");

const ATTACHMENT_BUBBLE = [
  "## Runtime context",
  "- Working directory: /repo",
  "",
  "[Attached image(s) are on disk — open them with your Read tool to view:",
  "- /tmp/img-1.png]",
  "",
  "## Message",
  "what does this screenshot show",
].join("\n");

const FRAME_ONLY = [
  "## Runtime context",
  "- Working directory: /repo",
  "",
  "## Digest: agent tree",
  "abc123 [idle] - Review auth (you)",
  "",
  "## Message",
  "",
].join("\n");

describe("hidden frame", () => {
  // test-check-allow: T9 Recorded screenshot/legacy hidden prompt frames.
  test("digest bubble shows only the delivered message", () => {
    expect(stripInternalNoticeLines(DIGEST_BUBBLE)).toBe(
      "please review the plan",
    );
  });

  // test-check-allow: T9 Recorded screenshot/legacy hidden prompt frames.
  test("attachment and tool-call lines never reach the bubble", () => {
    expect(stripInternalNoticeLines(ATTACHMENT_BUBBLE)).toBe(
      "what does this screenshot show",
    );
  });

  // test-check-allow: T9 Recorded screenshot/legacy hidden prompt frames.
  test("a frame with no message folds as activity, never an empty bubble", () => {
    expect(stripInternalNoticeLines(FRAME_ONLY)).toBe("");
  });
});
