/** Sanitized entries and usage recorded from Durable on 2026-10-12. */
import type { EntryRecord } from "@earendil-works/pi-durable";
import recorded from "./recorded.json";

export const entries = recorded.map((row) => ({
  id: row.id * 1000,
  conversationId: 1,
  kind: row.kind,
  ...("head" in row ? { head: row.head! * 1000 } : {}),
  model: [
    {
      role: row.kind === "pi.assistant" ? "assistant" : "user",
      content: [{ type: "text", text: row.text }],
      timestamp: row.timestamp,
      ...("usage" in row
        ? {
            usage: row.usage,
            stopReason: row.stopReason,
            provider: "faux",
            model: "faux-1",
            api: "faux",
          }
        : {}),
    },
  ],
})) as unknown as EntryRecord[];
