import { describe, expect, test } from "bun:test";
import { nextArtifactFrameDescriptionId } from "../../web/artifacts/embed.js";

describe("artifact embed identifiers", () => {
  test("stay unique and valid without secure-context UUID support", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis.crypto,
      "randomUUID",
    );
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    try {
      const first = nextArtifactFrameDescriptionId();
      const second = nextArtifactFrameDescriptionId();
      expect(first).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      expect(second).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      expect(second).not.toBe(first);
    } finally {
      if (descriptor)
        Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
      else Reflect.deleteProperty(globalThis.crypto, "randomUUID");
    }
  });
});
