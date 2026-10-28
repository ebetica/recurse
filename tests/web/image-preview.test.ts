import { describe, expect, test } from "bun:test";
import {
  isServedAttachmentUrl,
  previewTargetFor,
} from "../../web/image-preview.js";

describe("previewTargetFor", () => {
  // prettier-ignore
  // Regression: #1729 staged composer image preview used raw forced-download URL
  test("a staged owner-scoped upload previews through its raster capability", () => { // test-check-allow: T9 Safe same-origin staged raster capabilities only.
    expect(
      previewTargetFor({
        isImage: true,
        url: "/api/conversations/agent-a/attachments/0123456789abcdef0123456789abcdef.png",
        filename: "cat.png",
      }),
    ).toEqual({
      url: "/api/conversations/agent-a/attachments/0123456789abcdef0123456789abcdef.png/preview",
      alt: "cat.png",
    });
  });

  // prettier-ignore
  // Regression: #1729 staged composer image preview used raw forced-download URL
  test("an unserved address fails closed instead of a dead button", () => { // test-check-allow: T9 Safe same-origin staged raster capabilities only.
    for (const url of [
      "https://evil.example/x.png",
      "data:image/png;base64,AAAA",
      "blob:00000000",
      "/api/conversations/agent-a/attachments/abc123?download=1",
      "/api/attachment-drafts/tok/aid/extra",
    ])
      expect(
        previewTargetFor({ isImage: true, url, filename: "x.png" }),
      ).toBeNull();
  });
});

describe("served preview URL policy", () => {
  // test-check-allow: T9 Safe same-origin staged raster capabilities only.
  test("accepts only the same-origin served attachment path", () => {
    expect(isServedAttachmentUrl("/api/attachments/abc123.png")).toBe(true);
    expect(
      isServedAttachmentUrl(
        "/api/conversations/agent%20one/attachments/opaque-id/preview",
      ),
    ).toBe(true);
    expect(isServedAttachmentUrl("https://evil.example/x.png")).toBe(false);
    expect(isServedAttachmentUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isServedAttachmentUrl("blob:00000000")).toBe(false);
    expect(isServedAttachmentUrl("/api/attachments/../../etc/passwd")).toBe(
      false,
    );
  });

  // prettier-ignore
  // Regression: #1729 staged composer image preview used raw forced-download URL
  test("admits staged composer upload addresses, never the raw download", () => { // test-check-allow: T9 Safe same-origin staged raster capabilities only.
    const draft =
      "/api/attachment-drafts/0123456789abcdef0123456789abcdef/fedcba9876543210fedcba9876543210";
    expect(isServedAttachmentUrl(draft)).toBe(true);
    expect(isServedAttachmentUrl("/api/conversations/a/attachments/b")).toBe(
      false,
    );
    expect(
      isServedAttachmentUrl("/api/conversations/a/attachments/b/preview"),
    ).toBe(true);
    expect(isServedAttachmentUrl("/api/attachment-drafts/tok")).toBe(false);
    expect(isServedAttachmentUrl("/api/attachment-drafts/tok/aid/x")).toBe(
      false,
    );
  });
});
