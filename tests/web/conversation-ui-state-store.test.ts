import { describe, expect, test } from "bun:test";
import {
  MemoryStorage,
  store,
  storedFor,
} from "./conversation-ui-state-harness.js";
import { ConversationUiStateStore } from "../../web/conversation-ui-state/store.js";
import { LOCAL_UI_STATE_PREFIX } from "../../web/conversation-ui-state/schema.js";

describe("conversation UI state store", () => {
  test("migrates legacy open and closed values without auto-opening closed", () => {
    const local = new MemoryStorage(),
      session = new MemoryStorage();
    local.values.set("recurse.panePreference.agent-a", "closed");
    local.values.set("recurse.panePreference.agent-b", "open:diff");
    const state = new ConversationUiStateStore(local, session, 60_000);
    expect(state.pane("agent-a")).toEqual({ kind: "closed" });
    expect(state.pane("agent-b")).toEqual({
      kind: "open",
      id: "diff",
      lastId: "diff",
    });
    state.flush();
    expect(storedFor(local, LOCAL_UI_STATE_PREFIX, "agent-a")).toBeDefined();
    expect(storedFor(local, LOCAL_UI_STATE_PREFIX, "agent-b")).toBeDefined();
    expect(local.values.get("recurse.panePreference.agent-a")).toBe("closed");
    local.values.set("recurse.panePreference.agent-a", "open:diff");
    expect(
      new ConversationUiStateStore(local, session).pane("agent-a"),
    ).toEqual({ kind: "closed" });

    const clear = new ConversationUiStateStore(local, session, 60_000);
    clear.setPane("agent-a", { kind: "default" });
    clear.flush();
    expect(local.values.get("recurse.panePreference.agent-a")).toBe(
      "open:diff",
    );
    expect(
      new ConversationUiStateStore(local, session).pane("agent-a"),
    ).toEqual({ kind: "default" });
  });

  test("plugin state declares its own retention and version without reference aliasing", () => {
    const { state } = store();
    expect(
      state.setPaneState("agent", "__proto__", 1, "local", { polluted: true }),
    ).toBe(false);
  });
});
