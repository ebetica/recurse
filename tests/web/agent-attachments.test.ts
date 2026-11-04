import { describe, expect, test } from "bun:test";
import {
  agentAttachmentHref,
  agentAttachmentThumbnailHref,
} from "../../web/agent-attachments";

describe("agent attachment controls", () => {
  // test-check-allow: T9 Opaque owner/file ids remain separately encoded.
  test("builds only the owner-scoped opaque-id route", () => {
    expect(agentAttachmentHref("agent one", "opaque/id")).toBe(
      "/api/conversations/agent%20one/attachments/opaque%2Fid",
    );
    expect(agentAttachmentThumbnailHref("agent one", "opaque/id")).toBe(
      "/api/conversations/agent%20one/attachments/opaque%2Fid/thumbnail",
    );
  });
});
