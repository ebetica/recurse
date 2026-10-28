import { describe, expect, test } from "bun:test";
import { newClientMessageId } from "../../web/composer/send.js";

describe("composer send idempotency id", () => {
  test("ids are wire-safe and distinct per send", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const id = newClientMessageId();
      expect(id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(25);
  });
});
