import { describe, expect, test } from "bun:test";
import {
  parseAuthRecovery,
  resolveAuthRecoveryOwner,
  serializeAuthRecovery,
  type AuthRecovery,
} from "../../web/connection/send-recovery.js";

const sample: AuthRecovery = {
  version: 1,
  owner: null,
  input: "typed but not sent",
  selectionStart: 5,
  selectionEnd: 9,
  attachments: [
    {
      url: "/api/attachments/image-1.png",
      isImage: true,
      filename: "image.png",
      owner: { kind: "draft", id: "a".repeat(32) },
    },
  ],
  draft: {
    parent: "main",
    creatorIndex: 0,
    model: "model/id",
    attachmentDraft: "a".repeat(32),
    muted: true,
  },
  jobs: [
    {
      draft: true,
      convId: null,
      content: "create this agent",
      attachmentIds: [`${"b".repeat(32)}.png`],
      parent: "main",
      attachmentDraft: "a".repeat(32),
      muted: true,
      waitForIndex: -1,
    },
    {
      draft: false,
      convId: null,
      content: "then send this follow-up",
      waitForIndex: 0,
    },
  ],
};

describe("auth reload send recovery", () => {
  // test-check-allow: T9 Bound untrusted recovery and preserve legacy ids.
  test("round-trips bounded per-composer attachment owners", () => {
    const saved: AuthRecovery = {
      ...sample,
      owner: "agent-a",
      draft: null,
      attachments: [
        {
          ...sample.attachments[0],
          owner: { kind: "owner", id: "agent-a" },
          uiOwnerId: "agent-a",
        },
        {
          ...sample.attachments[0],
          url: "/api/attachments/image-2.png",
          owner: { kind: "owner", id: "agent-b" },
          uiOwnerId: "agent-b",
        },
      ],
    };
    expect(
      parseAuthRecovery(serializeAuthRecovery(saved))?.attachments,
    ).toEqual(saved.attachments);
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...saved,
          attachments: [
            { ...saved.attachments[0], uiOwnerId: "draft:../other" },
          ],
        }),
      ),
    ).toBeNull();
  });

  test("defaults legacy missing caret fields to the end", () => {
    const { selectionStart: _start, selectionEnd: _end, ...legacy } = sample;
    const parsed = parseAuthRecovery(JSON.stringify(legacy));
    expect(parsed?.selectionStart).toBe(sample.input.length);
    expect(parsed?.selectionEnd).toBe(sample.input.length);
  });

  test("binds a saved composer to its exact validated owner", () => {
    const saved: AuthRecovery = { ...sample, owner: "agent-a", draft: null };
    expect(parseAuthRecovery(serializeAuthRecovery(saved))?.owner).toBe(
      "agent-a",
    );
    expect(
      parseAuthRecovery(JSON.stringify({ ...saved, owner: "../other" })),
    ).toBeNull();
    const { owner: _owner, ...legacy } = saved;
    expect(parseAuthRecovery(JSON.stringify(legacy))?.owner).toBeNull();
  });

  // test-check-allow: T9 Bound untrusted recovery and preserve legacy ids.
  test("validates exact and legacy-hinted owners against the authoritative tree", () => {
    const ids = new Set(["main", "agent-a"]);
    expect(resolveAuthRecoveryOwner("agent-a", ids, "main")).toBe("agent-a");
    expect(resolveAuthRecoveryOwner("stale", ids, "stale")).toBe("main");
  });

  // test-check-allow: T9 Bound untrusted recovery and preserve legacy ids.
  test("keeps the current draft bound to its exact creator among multiple drafts", () => {
    const value: AuthRecovery = {
      ...sample,
      draft: { ...sample.draft!, creatorIndex: 1 },
      jobs: [
        sample.jobs[0],
        { ...sample.jobs[0], content: "current draft" },
        { ...sample.jobs[1], waitForIndex: 1 },
      ],
    };
    expect(parseAuthRecovery(serializeAuthRecovery(value))).toEqual(value);
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...value,
          draft: { ...value.draft, creatorIndex: 9 },
        }),
      ),
    ).toBeNull();
  });

  // test-check-allow: T9 Bound untrusted recovery and preserve legacy ids.
  test("requires a restored follow-up to retain a creator dependency or resolved id", () => {
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          draft: null,
          jobs: [{ ...sample.jobs[1], convId: null, waitForIndex: -1 }],
        }),
      ),
    ).toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          draft: null,
          jobs: [
            { ...sample.jobs[1], convId: "created-agent", waitForIndex: -1 },
          ],
        }),
      )?.jobs[0].convId,
    ).toBe("created-agent");
  });

  test("accepts the 50,000-reference recovery boundary", () => {
    const id = sample.jobs[0].attachmentIds![0];
    const atBoundary = {
      ...sample,
      jobs: [{ ...sample.jobs[0], attachmentIds: Array(50_000).fill(id) }],
      draft: null,
    };
    expect(parseAuthRecovery(JSON.stringify(atBoundary))).not.toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...atBoundary,
          jobs: [
            { ...atBoundary.jobs[0], attachmentIds: Array(50_001).fill(id) },
          ],
        }),
      ),
    ).toBeNull();
  });

  // test-check-allow: T9 Bound untrusted recovery and preserve legacy ids.
  test("rejects corrupt, oversized, external-attachment, and excessive queues", () => {
    expect(parseAuthRecovery("not json")).toBeNull();
    expect(
      parseAuthRecovery(JSON.stringify({ ...sample, version: 2 })),
    ).toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          attachments: [
            {
              url: "https://example.com/file",
              isImage: true,
              filename: "x",
              owner: { kind: "draft", id: "a".repeat(32) },
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          attachments: [
            {
              ...sample.attachments[0],
              owner: { kind: "other", id: "a".repeat(32) },
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          jobs: Array.from({ length: 101 }, () => sample.jobs[0]),
        }),
      ),
    ).toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          draft: { ...sample.draft, muted: "yes" },
        }),
      ),
    ).toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          jobs: [{ ...sample.jobs[0], muted: 1 }],
          draft: null,
        }),
      ),
    ).toBeNull();
    expect(parseAuthRecovery("x".repeat(8_000_001))).toBeNull();
  });

  // test-check-allow: T9 Bound untrusted recovery and preserve legacy ids.
  test("does not serialize a payload the reader would reject", () => {
    expect(
      serializeAuthRecovery({ ...sample, input: "x".repeat(8_000_001) }),
    ).toBeNull();
    expect(
      serializeAuthRecovery({
        ...sample,
        jobs: Array.from({ length: 101 }, () => sample.jobs[0]),
      }),
    ).toBeNull();
  });

  // test-check-allow: T9 Bound untrusted recovery and preserve legacy ids.
  test("round-trips the send idempotency id and rejects malformed ones", () => {
    const keyed: AuthRecovery = {
      ...sample,
      jobs: sample.jobs.map((job, index) => ({
        ...job,
        clientId: `c-key-${index}`,
      })),
    };
    expect(parseAuthRecovery(serializeAuthRecovery(keyed)!)?.jobs).toEqual(
      keyed.jobs,
    );
    expect(parseAuthRecovery(serializeAuthRecovery(sample))?.jobs).toEqual(
      sample.jobs,
    );
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          jobs: [{ ...sample.jobs[0], clientId: "../escape" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseAuthRecovery(
        JSON.stringify({
          ...sample,
          jobs: [{ ...sample.jobs[0], clientId: "x".repeat(65) }],
        }),
      ),
    ).toBeNull();
  });
});
