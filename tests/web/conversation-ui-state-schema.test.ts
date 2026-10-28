import { describe, expect, test } from "bun:test";

import { parseLocalUiState } from "../../web/conversation-ui-state/codec.js";

describe("conversation UI state schema", () => {
  test("rejects prototype keys from untrusted records", () => {
    const parsed = parseLocalUiState(
      '{"version":1,"pane":{"kind":"default"},"panes":{' +
        '"__proto__":{"version":1,"value":{"polluted":true}},' +
        '"constructor":{"version":1,"value":1},' +
        '"safe":{"version":1,"value":{"ok":true}}}}',
    );
    expect(parsed?.localPanes.safe).toEqual({
      version: 1,
      value: { ok: true },
    });
    expect(
      Object.prototype.hasOwnProperty.call(parsed?.localPanes, "__proto__"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(parsed?.localPanes, "constructor"),
    ).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
