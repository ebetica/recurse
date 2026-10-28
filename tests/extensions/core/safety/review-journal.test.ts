import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearReviewerEvidenceCache,
  ReviewerJournalError,
  updateReviewerJournal,
} from "../../../../src/extensions/core/safety/review-journal.ts";

type Row = {
  type: string;
  id: string;
  parentId: string | null;
  message?: any;
  fromHook?: boolean;
};

function stamped(body: string): string {
  return `[recurse-origin: operator]\n${body}`;
}

class Session {
  rows: Row[] = [];
  reads = 0;
  constructor(public id = "session-a") {}
  getSessionId() {
    return this.id;
  }
  getLeafId() {
    return this.rows.at(-1)?.id ?? null;
  }
  getEntry(id: string) {
    this.reads += 1;
    return this.rows.find((row) => row.id === id);
  }
  add(row: Omit<Row, "parentId"> & { parentId?: string | null }) {
    this.rows.push({
      ...row,
      parentId: row.parentId === undefined ? this.getLeafId() : row.parentId,
    });
    return this;
  }
  operator(id: string, body: string) {
    return this.add({
      type: "message",
      id,
      message: { role: "user", content: stamped(body) },
    });
  }
  compact(id: string, fromHook = false) {
    return this.add({
      type: "compaction",
      id,
      ...(fromHook ? { fromHook } : {}),
    });
  }
}

function update(session: Session, cid = "conversation-a") {
  return updateReviewerJournal({ conversationId: cid, session });
}

function fresh(): Session {
  clearReviewerEvidenceCache();
  return new Session();
}

test("a later duplicate call id retracts previously materialized result evidence", () => {
  const session = fresh()
    .add({
      type: "message",
      id: "call",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "tool-1",
            name: "write",
            arguments: { path: "target" },
          },
        ],
      },
    })
    .add({
      type: "message",
      id: "result",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "write",
        content: [{ type: "text", text: "must-be-retracted" }],
      },
    });
  expect(update(session).journalEvidence).toContain("must-be-retracted");

  session.add({
    type: "message",
    id: "duplicate",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "tool-1",
          name: "write",
          arguments: { path: "other" },
        },
      ],
    },
  });
  const rebuilt = update(session);
  expect(rebuilt.journalEvidence).not.toContain("must-be-retracted");
  expect(rebuilt.journalEvidence).not.toContain('"evidence_role":"tool"');
  expect(rebuilt.evidenceBlocks).toHaveLength(1);
});

for (const fromHook of [false, true]) {
  test(`${fromHook ? "automatic" : "explicit"} compaction discards all predecessor evidence`, () => {
    const session = fresh().operator("old", "old authorization");
    const before = update(session);
    session.compact("c1", fromHook).operator("new", "current request");
    const after = update(session);
    expect(after.reset).toBe(true);
    expect(after.generation).not.toBe(before.generation);
    expect(after.cacheKey).not.toBe(before.cacheKey);
    expect(after.journalEvidence).not.toContain("old authorization");
    expect(after.journalEvidence).toContain("current request");
  });
}

test("cold process rebuild starts at the nearest compaction", () => {
  const session = fresh()
    .operator("old", "retired evidence")
    .compact("c1")
    .operator("new", "live evidence");
  const first = update(session);
  clearReviewerEvidenceCache();
  const reads = session.reads;
  const rebuilt = update(session);
  expect(session.reads - reads).toBe(2);
  expect(rebuilt.cacheKey).toBe(first.cacheKey);
  expect(rebuilt.generation).toBe(first.generation);
  expect(rebuilt.journalEvidence).toBe(first.journalEvidence);
  expect(rebuilt.journalEvidence).not.toContain("retired evidence");
  expect(rebuilt.journalEvidence).toContain("live evidence");
});

test("session replacement and rewritten cursor rebuild with a new cache key", () => {
  const source = fresh()
    .operator("u1", "authorization")
    .operator("u2", "request");
  const first = update(source);
  const replacement = new Session("session-b");
  replacement
    .operator("copy-u1", "authorization changed")
    .operator("copy-u2", "request");
  const rebuilt = update(replacement);
  expect(rebuilt.cacheKey).not.toBe(first.cacheKey);
  expect(rebuilt.journalEvidence).toContain("authorization changed");
});

test("same-session immutable cursor mismatch rebuilds and changes the key", () => {
  const session = fresh().operator("u1", "before");
  const first = update(session);
  session.rows[0]!.message.content = stamped("after");
  const rebuilt = update(session);
  expect(rebuilt.cacheKey).not.toBe(first.cacheKey);
  expect(rebuilt.journalEvidence).toContain("after");
});

test("rewritten cached anchor rebuilds once instead of persisting an outage", () => {
  const session = fresh().operator("u1", "before");
  const first = update(session);
  session.rows[0]!.message.content = stamped("after");
  session.operator("u2", "suffix");
  const rebuilt = update(session);
  expect(rebuilt.cacheKey).not.toBe(first.cacheKey);
  expect(rebuilt.journalEvidence).toContain("after");
  expect(rebuilt.journalEvidence).toContain("suffix");
  expect(update(session).cacheKey).toBe(rebuilt.cacheKey);
});

test("current generation capacity, cycles, and malformed rows fail procedurally", () => {
  const huge = fresh().operator("huge", "x".repeat(50 * 1024 * 1024));
  expect(() => update(huge)).toThrow(/bounded capacity/);

  const cycle = fresh();
  cycle.rows = [
    {
      type: "message",
      id: "a",
      parentId: "a",
      message: { role: "user", content: stamped("x") },
    },
  ];
  expect(() => update(cycle)).toThrow(/cycle/);

  const malformed = fresh();
  malformed.rows = [{ type: "message", id: "leaf", parentId: "missing" }];
  expect(() => update(malformed)).toThrow(ReviewerJournalError);
});

test("no reviewer journal files are created", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-safety-no-journal-"));
  try {
    const session = fresh().operator("u1", "request");
    updateReviewerJournal({
      conversationId: "no-files",
      session,
      env: { RECURSE_SAFETY_DIR: root },
    });
    expect(existsSync(join(root, "reviewer-journals"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
