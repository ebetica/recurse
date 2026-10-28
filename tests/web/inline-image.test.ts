import { describe, expect, test } from "bun:test";
import {
  isAllowedAttachmentHref,
  isAllowedInlineImageSrc,
  scopedAttachmentPreviewHref,
} from "../../web/image-preview/inline.js";

describe("inline image source allowlist", () => {
  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("allows this instance's flat operator-upload URLs only", () => {
    expect(isAllowedInlineImageSrc("/api/attachments/abc123.png")).toBe(true);
    expect(isAllowedInlineImageSrc("/api/attachments/worker1/abc123.png")).toBe(
      false,
    );
    expect(isAllowedInlineImageSrc("/api/attachments/main/x.webp")).toBe(false);
  });

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("blocks external hosts, protocol-relative, and active/data URIs", () => {
    expect(isAllowedInlineImageSrc("https://evil.example/x.png")).toBe(false);
    expect(isAllowedInlineImageSrc("http://evil.example/x.png")).toBe(false);
    expect(isAllowedInlineImageSrc("//evil.example/x.png")).toBe(false);
    expect(isAllowedInlineImageSrc("data:image/png;base64,AAAA")).toBe(false);
    expect(isAllowedInlineImageSrc("javascript:alert(1)")).toBe(false);
  });

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("blocks other app paths, traversal, and empty input", () => {
    expect(isAllowedInlineImageSrc("/api/artifacts/x/asset")).toBe(false);
    expect(isAllowedInlineImageSrc("/api/attachments/../secret")).toBe(false);
    expect(isAllowedInlineImageSrc("/api/attachments/a/b/c.png")).toBe(false);
    expect(isAllowedInlineImageSrc("/attachments/x.png")).toBe(false);
    expect(isAllowedInlineImageSrc("")).toBe(false);
    expect(isAllowedInlineImageSrc(null)).toBe(false);
    expect(isAllowedInlineImageSrc(undefined)).toBe(false);
  });

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("images keep the flat-only gate: scoped bytes stay out", () => {
    expect(
      isAllowedInlineImageSrc(
        "/api/conversations/main/attachments/" + "a".repeat(32),
      ),
    ).toBe(false);
  });
});

describe("attachment href allowlist", () => {
  const id32 = "a".repeat(32);
  const scoped = (cid: string, id: string = id32) =>
    `/api/conversations/${cid}/attachments/${id}`;

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("allows the production upload shape the composer serializes", () => {
    expect(isAllowedAttachmentHref(scoped("main"))).toBe(true);
    expect(isAllowedAttachmentHref(scoped("files-empty"))).toBe(true);
    expect(isAllowedAttachmentHref(scoped("reveal-backfill-1a2b3c4d"))).toBe(
      true,
    );
    expect(isAllowedAttachmentHref(scoped("main", `${id32}.png`))).toBe(true);
    expect(isAllowedAttachmentHref("/api/attachments/abc123.png")).toBe(true);
  });

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("rejects malformed conversation ids", () => {
    expect(isAllowedAttachmentHref(scoped(""))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("../evil"))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("a".repeat(65)))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("-leading-dash"))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("has space"))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("cid%2fslash"))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("cid%00null"))).toBe(false);
  });

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("rejects malformed file ids and suffixed paths", () => {
    expect(isAllowedAttachmentHref(scoped("main", "short"))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("main", "A".repeat(32)))).toBe(false);
    expect(isAllowedAttachmentHref(scoped("main", `${id32}.PNG`))).toBe(false);
    expect(
      isAllowedAttachmentHref(scoped("main", `${id32}.ext-too-long-12345`)),
    ).toBe(false);
    expect(isAllowedAttachmentHref(`${scoped("main")}/preview`)).toBe(false);
    expect(isAllowedAttachmentHref(`${scoped("main")}?x=1`)).toBe(false);
    expect(isAllowedAttachmentHref(`${scoped("main")}#frag`)).toBe(false);
    expect(isAllowedAttachmentHref(scoped("main", `${id32}/extra`))).toBe(
      false,
    );
    expect(isAllowedAttachmentHref(scoped("ma/in", id32))).toBe(false);
  });

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("rejects external, protocol-relative, traversal, and active URIs", () => {
    expect(
      isAllowedAttachmentHref(`https://evil.example${scoped("main")}`),
    ).toBe(false);
    expect(isAllowedAttachmentHref(`/${scoped("main")}`)).toBe(false);
    expect(
      isAllowedAttachmentHref(
        `/api/conversations/main/attachments/${"..%2f" + id32}`,
      ),
    ).toBe(false);
    expect(
      isAllowedAttachmentHref("/api/conversations/main/attachments/.."),
    ).toBe(false);
    expect(
      isAllowedAttachmentHref("/api/conversations/main\\attachments/" + id32),
    ).toBe(false);
    expect(isAllowedAttachmentHref("data:text/plain,hi")).toBe(false);
    expect(isAllowedAttachmentHref("javascript:alert(1)")).toBe(false);
    expect(isAllowedAttachmentHref("")).toBe(false);
    expect(isAllowedAttachmentHref(null)).toBe(false);
    expect(isAllowedAttachmentHref(undefined)).toBe(false);
  });
});

describe("scoped preview derivation", () => {
  const id32 = "a".repeat(32);
  const scoped = (cid: string, id: string = id32) =>
    `/api/conversations/${cid}/attachments/${id}`;

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("derives the validated preview beside a scoped upload", () => {
    expect(scopedAttachmentPreviewHref(scoped("main"))).toBe(
      `${scoped("main")}/preview`,
    );
    expect(scopedAttachmentPreviewHref(scoped("main", `${id32}.png`))).toBe(
      `${scoped("main", `${id32}.png`)}/preview`,
    );
  });

  // test-check-allow: T9 Local attachment capabilities reject unsafe URLs.
  test("fails closed for flat, suffixed, and non-upload shapes", () => {
    expect(scopedAttachmentPreviewHref("/api/attachments/abc123.png")).toBe(
      null,
    );
    expect(scopedAttachmentPreviewHref(`${scoped("main")}/preview`)).toBe(null);
    expect(scopedAttachmentPreviewHref(`${scoped("main")}?x=1`)).toBe(null);
    expect(
      scopedAttachmentPreviewHref("https://evil.example" + scoped("main")),
    ).toBe(null);
    expect(
      scopedAttachmentPreviewHref("/api/conversations/main/attachments/.."),
    ).toBe(null);
    expect(scopedAttachmentPreviewHref("")).toBe(null);
    expect(scopedAttachmentPreviewHref(null)).toBe(null);
    expect(scopedAttachmentPreviewHref(undefined)).toBe(null);
  });
});
