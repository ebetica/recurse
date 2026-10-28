import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  MISSING_POLICY_SENTINEL,
  drainReviewStats,
  parseSafetyVerdict,
  reviewAction,
  safetyReviewSessionId,
} from "../../../../src/extensions/core/safety/review.ts";
import { ownedProcessSnapshot } from "../../../../src/extensions/core/safety/process-snapshot.ts";

const verdictText = (v: { decision: "allow" | "deny"; reason: string }) =>
  v.decision === "deny" ? `DENY: ${v.reason}` : "OK";

function contextText(context: { messages: UserMessage[] }): string {
  return context.messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.map((block) =>
            block.type === "text" ? block.text : "",
          ),
    )
    .join("");
}

// test-check-allow: T9 Fail-closed verdicts and bounded owned-process evidence.
test("owned process context is explicit and bounded when unavailable", () => {
  const context = ownedProcessSnapshot(undefined);
  expect(context).toContain("Process snapshot: unavailable");
  expect(context.length).toBeLessThanOrEqual(32 * 1024);
});

test("owned process context fails closed on oversized registry", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-safety-snapshot-"));
  try {
    const context = ownedProcessSnapshot(
      Array.from({ length: 101 }, () => ({
        pid: 999_999,
        pgid: 999_999,
        identity: "missing",
      })),
    );
    expect(context).toContain("shell registry could not be read safely");
    expect(context).not.toContain("pid=");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaderless records carry caution without including unrelated processes", async () => {
  if (process.platform !== "linux") return;
  const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    unrelated.once("spawn", () => resolve());
    unrelated.once("error", reject);
  });
  const root = mkdtempSync(join(tmpdir(), "pi-safety-leaderless-"));
  try {
    {
      const context = ownedProcessSnapshot([
        { pid: 2_000_000, pgid: 2_000_000, identity: "gone" },
      ]);
      expect(context).toContain(
        "group=2000000 leader exited; PGID reuse cannot be excluded",
      );
      expect(context).not.toContain(`pid=${unrelated.pid}`);
    }
  } finally {
    try {
      process.kill(-unrelated.pid!, "SIGKILL");
    } catch {}
    await new Promise<void>((resolve) =>
      unrelated.once("exit", () => resolve()),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reused leader PGID is excluded from owned context", async () => {
  if (process.platform !== "linux") return;
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  const root = mkdtempSync(join(tmpdir(), "pi-safety-reused-pgid-"));
  try {
    const context = ownedProcessSnapshot([
      {
        pid: child.pid!,
        pgid: child.pid!,
        identity: "not-the-current-start-token",
      },
    ]);
    expect(context).toContain(`group=${child.pid} PGID reused; not owned`);
    expect(context).not.toContain(`pid=${child.pid}`);
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("reused-only records stop before the bounded member scan", async () => {
  if (process.platform !== "linux") return;
  const children = [
    spawn("sleep", ["30"], { detached: true, stdio: "ignore" }),
    spawn("sleep", ["30"], { detached: true, stdio: "ignore" }),
  ];
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once("spawn", () => resolve());
          child.once("error", reject);
        }),
    ),
  );
  const root = mkdtempSync(join(tmpdir(), "pi-safety-reused-only-"));
  try {
    const context = ownedProcessSnapshot([
      ...children.map((child) => ({
        pid: child.pid!,
        pgid: child.pid!,
        identity: "not-the-current-start-token",
      })),
      ...Array.from({ length: 98 }, () => ({
        pid: 0,
        pgid: 0,
        identity: "x".repeat(900),
      })),
    ]);
    for (const child of children) {
      expect(context).toContain(`group=${child.pid} PGID reused; not owned`);
      expect(context).not.toContain(`pid=${child.pid}`);
    }
    expect(context).toContain("registry records truncated");
    expect(context.split("\n")).toHaveLength(4);
    expect(context.length).toBeLessThanOrEqual(32 * 1024);
  } finally {
    for (const child of children) {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => child.once("exit", () => resolve())),
      ),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned process context reports an actual detached group", async () => {
  if (process.platform !== "linux") return;
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  const root = mkdtempSync(join(tmpdir(), "pi-safety-live-snapshot-"));
  try {
    const raw = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const identity = raw
      .slice(raw.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[19];
    const context = ownedProcessSnapshot([
      { pid: child.pid!, pgid: child.pid!, identity: identity! },
    ]);
    expect(context).toContain(`pid=${child.pid}`);
    expect(context).toContain(`pgid=${child.pid}`);
    expect(context).toContain(`sid=${child.pid}`);
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

describe("parseSafetyVerdict", () => {
  // test-check-allow: T9 Fail-closed verdicts and bounded owned-process evidence.
  test("tolerates bullets and emphasis", () => {
    expect(parseSafetyVerdict("- **OK**")?.decision).toBe("allow");
    expect(parseSafetyVerdict("* **DENY**: Concrete harm.")).toEqual({
      decision: "deny",
      reason: "Concrete harm.",
    });
  });

  // test-check-allow: T9 Fail-closed verdicts and bounded owned-process evidence.
  test("rejects either verdict when another nonempty line is present", () => {
    expect(
      parseSafetyVerdict("OK\nDENY: Concrete serious harm."),
    ).toBeUndefined();
    expect(
      parseSafetyVerdict("DENY: Concrete serious harm.\nOK"),
    ).toBeUndefined();
    expect(
      parseSafetyVerdict("DENY: Concrete serious harm.\nextra prose"),
    ).toBeUndefined();
  });

  // test-check-allow: T9 Fail-closed verdicts and bounded owned-process evidence.
  test("rejects prose and malformed or empty denials", () => {
    expect(parseSafetyVerdict("I approve this action.")).toBeUndefined();
    expect(parseSafetyVerdict("OK\nextra prose")).toBeUndefined();
    expect(parseSafetyVerdict("decision: OK")).toBeUndefined();
    expect(parseSafetyVerdict("DENY:")).toBeUndefined();
  });
});

describe("reviewAction request parameters", () => {
  const ctx = {
    cwd: "/workspace",
    signal: undefined,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "key",
        headers: {},
      }),
    },
  } as unknown as ExtensionContext;
  const allowJson = verdictText({ decision: "allow", reason: "Fine." });
  const reply = (text: string, _context?: any) =>
    ({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        totalTokens: 16,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.03,
          cacheWrite: 0.01,
          total: 0.34,
        },
      },
    }) as any;

  test("gives Pi an isolated stable cache identity", async () => {
    const sessionCtx = {
      ...ctx,
      sessionManager: { getSessionId: () => "provider-session-123" },
    } as unknown as ExtensionContext;
    let codexOptions: any;
    const complete = async (_model: any, context: any, options: any) => {
      codexOptions = options;
      return reply(allowJson, context);
    };
    const model = {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      reasoning: true,
    } as any;
    await reviewAction(
      sessionCtx,
      model,
      "low",
      [],
      "",
      "bash: ls",
      complete as any,
      "generation-a",
      "conversation-123",
    );

    expect(codexOptions.transport).toBe("sse");
    expect(codexOptions.sessionId).toMatch(/^pi-safety-[0-9a-f]{52}$/);
    expect(codexOptions.sessionId).not.toContain("provider-session-123");
    expect(codexOptions.cacheRetention).toBe("short");
    expect(codexOptions.onPayload).toBeUndefined();

    let nativeOptions: any;
    const nativeComplete = async (_model: any, context: any, options: any) => {
      nativeOptions = options;
      return reply(allowJson, context);
    };
    const nativeModel = {
      provider: "anthropic",
      id: "claude-sonnet-5",
      reasoning: false,
    } as any;
    await reviewAction(
      sessionCtx,
      nativeModel,
      "low",
      [],
      "",
      "bash: ls",
      nativeComplete as any,
    );
    expect(nativeOptions.transport).toBe("websocket");
    expect(nativeOptions.sessionId).toMatch(/^pi-safety-[0-9a-f]{52}$/);
    expect(nativeOptions.onPayload).toBeUndefined();

    let routedModel: any;
    const openrouter = {
      provider: "openrouter",
      id: "z-ai/glm-5.3-flash",
      reasoning: true,
      compat: { supportsStore: false },
    } as any;
    await reviewAction(
      sessionCtx,
      openrouter,
      "low",
      [],
      "",
      "bash: ls",
      (async (seen: any, context: any) => {
        routedModel = seen;
        return reply(allowJson, context);
      }) as any,
      "generation-a",
      "conversation-123",
    );
    expect(routedModel).not.toBe(openrouter);
    expect(routedModel.compat).toMatchObject({
      supportsStore: false,
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });
    expect(openrouter.compat).toEqual({ supportsStore: false });
  });

  test("persists bounded counts-only reviewer usage beside the journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-safety-review-stats-"));
    try {
      const sessionCtx = {
        ...ctx,
        sessionManager: { getSessionId: () => "stats-provider-session" },
      } as unknown as ExtensionContext;
      const model = {
        provider: "anthropic",
        id: "claude-sonnet-5",
        reasoning: false,
      } as any;
      const blocks = ["stable-record"];
      const complete = async (_model: any, context: any) =>
        reply(allowJson, context);
      await reviewAction(
        sessionCtx,
        model,
        "low",
        [],
        blocks.join(""),
        "bash: secret-action",
        complete as any,
        "generation-stats",
        "stats-conversation",
        blocks,
        { statsRoot: root, processSnapshot: "fixture process snapshot" },
      );
      const cidDigest = createHash("sha256")
        .update("stats-conversation", "utf8")
        .digest("hex");
      const path = join(root, "reviewer-journals", cidDigest, "usage.jsonl");
      await drainReviewStats("stats-conversation", root);
      const [statsLine] = readFileSync(path, "utf8").trim().split("\n");
      const record = JSON.parse(statsLine!) as Record<string, unknown>;
      expect(record).toMatchObject({
        conversationId: "stats-conversation",
        provider: "anthropic",
        model: "claude-sonnet-5",
        input: 10,
        cacheRead: 3,
        cacheWrite: 1,
        output: 2,
        evidenceBytes: blocks[0]!.length,
        gapSeconds: null,
      });
      expect(JSON.stringify(record)).not.toContain("stable-record");
      expect(JSON.stringify(record)).not.toContain("secret-action");

      await reviewAction(
        sessionCtx,
        model,
        "low",
        [],
        blocks.join(""),
        "bash: no-cid",
        complete as any,
        "generation-stats",
        undefined,
        blocks,
        { statsRoot: root, processSnapshot: "fixture process snapshot" },
      );
      expect(readdirSync(join(root, "reviewer-journals"))).toEqual([cidDigest]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent stats and drops oversized legacy lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-safety-review-stats-race-"));
    try {
      const cid = "race-conversation";
      const digest = createHash("sha256").update(cid, "utf8").digest("hex");
      const path = join(root, "reviewer-journals", digest, "usage.jsonl");
      mkdirSync(join(root, "reviewer-journals", digest), { recursive: true });
      writeFileSync(
        path,
        `${"x".repeat(20_000)}\n${JSON.stringify({ timestamp: 1 })}\n`,
      );
      const sessionCtx = {
        ...ctx,
        sessionManager: { getSessionId: () => "race-provider-session" },
      } as unknown as ExtensionContext;
      const model = {
        provider: "anthropic",
        id: "claude-sonnet-5",
        reasoning: false,
      } as any;
      const complete = async (_model: any, context: any) =>
        reply(allowJson, context);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          reviewAction(
            sessionCtx,
            model,
            "low",
            [],
            "stable-record",
            "bash: race",
            complete as any,
            "generation-race",
            cid,
            ["stable-record"],
            { statsRoot: root, processSnapshot: "fixture process snapshot" },
          ),
        ),
      );
      await drainReviewStats(cid, root);
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(5);
      expect(lines.every((line) => line.length <= 16_384)).toBe(true);
      expect(
        existsSync(join(root, "reviewer-journals", "race-provider-session")),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps native Claude reviews in one stable isolated session", async () => {
    const sessionCtx = {
      ...ctx,
      sessionManager: { getSessionId: () => "pi-session-a" },
    } as unknown as ExtensionContext;
    const model = {
      provider: "anthropic",
      id: "claude-sonnet-5",
      reasoning: false,
    } as any;
    const seen: Array<{ context: any; options: any }> = [];
    const complete = async (_model: any, context: any, options: any) => {
      seen.push({ context, options });
      return reply(allowJson, context);
    };
    const firstBlocks = ["canonical-header\nrecord-1"];
    const secondBlocks = [...firstBlocks, "\nrecord-2"];
    await reviewAction(
      sessionCtx,
      model,
      "low",
      [],
      firstBlocks.join(""),
      "bash: first",
      complete as any,
      "generation-a",
      "conversation-a",
      firstBlocks,
    );
    await reviewAction(
      sessionCtx,
      model,
      "low",
      [],
      secondBlocks.join(""),
      "bash: second",
      complete as any,
      "generation-a",
      "conversation-a",
      secondBlocks,
    );
    await reviewAction(
      sessionCtx,
      model,
      "low",
      [],
      secondBlocks.join(""),
      "bash: third",
      complete as any,
      "generation-a",
      "conversation-a",
      secondBlocks,
    );

    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((item) => item.options.sessionId)).size).toBe(1);
    const expectedActions = ["bash: first", "bash: second", "bash: third"];
    for (const [index, { context, options }] of seen.entries()) {
      expect(options.metadata).toBeUndefined();
      expect(context.messages).toHaveLength(1);
      const request = context.messages[0].content[0].text;
      expect(request.match(/canonical-header/g)).toHaveLength(1);
      expect(request).toContain(expectedActions[index]!);
    }

    expect(
      safetyReviewSessionId("conversation-b", model, "generation-a"),
    ).not.toBe(safetyReviewSessionId("conversation-a", model, "generation-a"));
    expect(
      safetyReviewSessionId(
        "conversation-a",
        { ...model, id: "claude-opus-5" },
        "generation-a",
      ),
    ).not.toBe(safetyReviewSessionId("conversation-a", model, "generation-a"));
    expect(
      safetyReviewSessionId(
        "conversation-a",
        { ...model, provider: "other-provider" },
        "generation-a",
      ),
    ).not.toBe(safetyReviewSessionId("conversation-a", model, "generation-a"));
    expect(
      safetyReviewSessionId("conversation-a", model, "generation-b"),
    ).not.toBe(safetyReviewSessionId("conversation-a", model, "generation-a"));
    expect(
      safetyReviewSessionId(
        "conversation-a",
        model,
        "generation-a",
        "policy-b",
      ),
    ).not.toBe(
      safetyReviewSessionId(
        "conversation-a",
        model,
        "generation-a",
        "policy-a",
      ),
    );
  });

  test("re-asks with the policy inlined when the reviewer reports it never arrived", async () => {
    const prompts: string[] = [];
    const complete = async (_model: any, context: any) => {
      prompts.push(contextText(context));
      return prompts.length === 1
        ? reply(
            verdictText({ decision: "deny", reason: MISSING_POLICY_SENTINEL }),
          )
        : reply(allowJson, context);
    };
    const verdict = await reviewAction(
      ctx,
      { provider: "anthropic", reasoning: false } as any,
      "low",
      [],
      "",
      "bash: ls",
      complete as any,
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("You are pi-safety");
    expect(prompts[1]).toContain("You are pi-safety");
    expect(prompts[1]).not.toContain("previous reply was malformed");
    expect(verdict).toMatchObject({ decision: "allow" });
    expect(verdict.procedural).toBeUndefined();
  });

  test("fails procedurally when even the inlined policy is reported missing", async () => {
    let calls = 0;
    const complete = async () => {
      calls += 1;
      return reply(
        verdictText({
          decision: "deny",
          reason: `something about ${MISSING_POLICY_SENTINEL} again`,
        }),
      );
    };
    const verdict = await reviewAction(
      ctx,
      { provider: "anthropic", reasoning: false } as any,
      "low",
      [],
      "",
      "bash: ls",
      complete as any,
    );
    expect(calls).toBe(2);
    expect(verdict.procedural).toBe(true);
    expect(verdict.reason).toContain("did not receive the review policy");
  });

  test("marks a provider-side aborted response as a procedural reviewer failure", async () => {
    const complete = async () =>
      ({
        stopReason: "aborted",
        errorMessage: "Operation aborted",
        content: [],
      }) as any;
    const verdict = await reviewAction(
      ctx,
      { provider: "anthropic", reasoning: false } as any,
      "low",
      [],
      "",
      "bash: git status",
      complete as any,
    );
    expect(verdict).toMatchObject({ decision: "deny", procedural: true });
    expect(verdict.reason).toContain("aborted");
    expect(verdict.reason).toContain("Operation aborted");
    expect(verdict.reviewAttempts).toEqual([{ status: "unreported" }]);
  });

  test("returns a model denial directly", async () => {
    const complete = async () =>
      reply(
        verdictText({
          decision: "deny",
          reason: "Concrete concern.",
        }),
      );
    const verdict = await reviewAction(
      ctx,
      { provider: "openai-codex", reasoning: true } as any,
      "low",
      [],
      "",
      "bash: task script",
      complete as any,
    );
    expect(verdict).toMatchObject({
      decision: "deny",
      reason: "Concrete concern.",
    });
    expect(verdict.procedural).toBeUndefined();
  });

  test("includes the provider errorMessage in a failed-review reason", async () => {
    const complete = async () =>
      ({
        stopReason: "error",
        errorMessage: "Upstream provider error: model overloaded",
        content: [],
      }) as any;
    const model = { provider: "openai-codex", reasoning: true } as any;
    const verdict = await reviewAction(
      ctx,
      model,
      "low",
      [],
      "",
      "bash: ls",
      complete as any,
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.procedural).toBe(true);
    expect(verdict.reason).toContain("model overloaded");
    expect(verdict.reason).toContain("error");
  });
});

describe("reviewAction malformed-reply handling", () => {
  const ctx = {
    cwd: "/workspace",
    signal: undefined,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "key",
        headers: {},
      }),
    },
  } as unknown as ExtensionContext;
  const model = { reasoning: false } as any;
  const reply = (text: string, _context?: any) =>
    ({ stopReason: "stop", content: [{ type: "text", text }] }) as any;
  const allowJson = verdictText({
    decision: "allow",
    reason: "Read-only grep and sed.",
  });

  test("retries once on a malformed reply and uses the second reply", async () => {
    const prompts: string[] = [];
    const complete = async (_model: any, context: any) => {
      prompts.push(contextText(context));
      return prompts.length === 1
        ? reply("Sure, that batched command looks fine to me!")
        : reply(allowJson, context);
    };
    const verdict = await reviewAction(
      ctx,
      model,
      "low",
      [],
      "",
      "bash: grep -rn foo src ; sed -n 1,5p README.md",
      complete as any,
    );
    expect(verdict.decision).toBe("allow");
    expect(verdict.procedural).toBeUndefined();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("previous reply was malformed");
  });

  test("marks two invalid replies as a procedural reviewer failure", async () => {
    let calls = 0;
    const complete = async () => {
      calls += 1;
      return reply("no verdict here");
    };
    const verdict = await reviewAction(
      ctx,
      model,
      "low",
      [],
      "",
      "bash: grep foo",
      complete as any,
    );
    expect(calls).toBe(2);
    expect(verdict.decision).toBe("deny");
    expect(verdict.procedural).toBe(true);
    expect(verdict.reason).toContain("invalid verdict");
  });

  test("marks auth failures as procedural", async () => {
    const badCtx = {
      ...ctx,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: false,
          error: "no credential",
        }),
      },
    } as unknown as ExtensionContext;
    const verdict = await reviewAction(
      badCtx,
      model,
      "low",
      [],
      "",
      "bash: ls",
      (async () => reply(allowJson)) as any,
    );
    expect(verdict.decision).toBe("deny");
    expect(verdict.procedural).toBe(true);
  });
});
