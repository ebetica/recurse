import { describe, expect, test } from "bun:test";
import { ComposerViewStateController } from "../../web/composer/view-state-model.js";
import { ConversationUiStateStore } from "../../web/conversation-ui-state/store.js";
import type { StorageLike } from "../../web/conversation-ui-state/schema.js";

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class Field {
  value = "";
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

describe("composer view state controller", () => {
  // Regression: #2248 preserve composer input typed during startup
  test("keeps a saved draft and text typed while the first selection is pending", () => {
    const store = new ConversationUiStateStore(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    store.setComposer("agent-a", {
      text: "Saved draft",
      selectionStart: 0,
      selectionEnd: 0,
    });
    const field = new Field();
    const controller = new ComposerViewStateController(store, field, "");
    field.value = "Composer draft survives refresh";
    field.setSelectionRange(9, 14);
    controller.noteInput("");
    controller.switchTo("agent-a");
    expect(field.value).toBe("Saved draft\nComposer draft survives refresh");
    expect([field.selectionStart, field.selectionEnd]).toEqual([21, 26]);
    expect(store.composer("agent-a").text).toBe(field.value);
  });

  // Regression: #2248 preserve composer input typed during startup
  test("browser-restored text matching the saved draft is not duplicated", () => {
    const store = new ConversationUiStateStore(
      new MemoryStorage(),
      new MemoryStorage(),
    );
    const text = "Composer draft survives refresh";
    store.setComposer("agent-a", {
      text,
      selectionStart: 0,
      selectionEnd: 0,
    });
    const field = new Field();
    field.value = text;
    field.setSelectionRange(9, 14);
    const controller = new ComposerViewStateController(store, field, "");
    controller.switchTo("agent-a");
    expect(field.value).toBe(text);
    expect(store.composer("agent-a").text).toBe(text);
    expect([field.selectionStart, field.selectionEnd]).toEqual([9, 14]);
  });
});
