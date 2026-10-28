import { describe, expect, test } from "bun:test";
import {
  attachmentIdFromUrl,
  attachmentOwnerForSelection,
} from "../../web/attachment-flow.js";

describe("attachment ownership", () => {
  test("a saved-agent upload cannot change owner after navigation", async () => {
    const selection = { selectedId: "agent-a", draft: null };
    const owner = attachmentOwnerForSelection(selection, async () => "unused");
    selection.selectedId = "agent-b";

    expect(await owner).toEqual({ kind: "owner", id: "agent-a" });
  });

  // test-check-allow: T9 Attachment release admits only local stable URLs.
  test("only stable attachment URLs yield release ids", () => {
    expect(attachmentIdFromUrl("/api/attachments/a%20b.txt")).toBe("a b.txt");
    expect(attachmentIdFromUrl("/api/conversations/cid/attachments/aid")).toBe(
      "aid",
    );
    expect(attachmentIdFromUrl("/api/attachment-drafts/d/a%20b.txt")).toBe(
      "a b.txt",
    );
    expect(
      attachmentIdFromUrl("https://example.com/api/attachments/a"),
    ).toBeNull();
    expect(attachmentIdFromUrl("/api/attachments/a?owner=x")).toBeNull();
    expect(
      attachmentIdFromUrl("/api/conversations/cid/attachments/a?x=1"),
    ).toBeNull();
  });
});
