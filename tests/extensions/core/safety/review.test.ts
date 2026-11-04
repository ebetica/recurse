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
test("owned process context is explicit and bounded when unavailable", async () => {
  const context = await ownedProcessSnapshot(undefined);
  expect(context).toContain("Process snapshot: unavailable");
  expect(context.length).toBeLessThanOrEqual(32 * 1024);
});

test("owned process context fails closed on oversized registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-safety-snapshot-"));
  try {
    const context = await ownedProcessSnapshot(
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
      const context = await ownedProcessSnapshot([
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
    const context = await ownedProcessSnapshot([
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
    const context = await ownedProcessSnapshot([
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

// Regression: #3063 owned-process review context performs no blocking I/O.
test("owned process context reports an actual detached group without blocking I/O", async () => {
  if (process.platform !== "linux") return;
  const root = mkdtempSync(join(tmpdir(), "pi-safety-live-snapshot-"));
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(process.cwd(), "tests/dev/blocking_trace_preload.ts"),
      join(import.meta.dir, "fixtures/owned-process-snapshot.ts"),
    ],
    {
      env: { ...process.env, RECURSE_BLOCKING_TRACE: join(root, "trace.json") },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.blocking).toEqual([]);
    expect(result.snapshot).toContain(`pid=${result.pid}`);
    expect(result.snapshot).toContain(`pgid=${result.pid}`);
    expect(result.snapshot).toContain(`sid=${result.pid}`);
  } finally {
    child.kill();
    await child.exited;
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
      const evidence = "stable-record";
      const complete = async (_model: any, context: any) =>
        reply(allowJson, context);
      await reviewAction(
        sessionCtx,
        model,
        "low",
        [],
        evidence,
        "bash: secret-action",
        complete as any,
        "generation-stats",
        "stats-conversation",
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
        evidenceBytes: evidence.length,
        gapSeconds: null,
      });
      expect(JSON.stringify(record)).not.toContain("stable-record");
      expect(JSON.stringify(record)).not.toContain("secret-action");

      await reviewAction(
        sessionCtx,
        model,
        "low",
        [],
        evidence,
        "bash: no-cid",
        complete as any,
        "generation-stats",
        undefined,
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
    const first = "canonical-header\nrecord-1";
    const second = `${first}\nrecord-2`;
    await reviewAction(
      sessionCtx,
      model,
      "low",
      [],
      first,
      "bash: first",
      complete as any,
      "generation-a",
      "conversation-a",
    );
    await reviewAction(
      sessionCtx,
      model,
      "low",
      [],
      second,
      "bash: second",
      complete as any,
      "generation-a",
      "conversation-a",
    );
    await reviewAction(
      sessionCtx,
      model,
      "low",
      [],
      second,
      "bash: third",
      complete as any,
      "generation-a",
      "conversation-a",
    );

    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((item) => item.options.sessionId)).size).toBe(1);
    const expectedActions = ["bash: first", "bash: second", "bash: third"];
    for (const [index, { context, options }] of seen.entries()) {
      expect(options.metadata).toBeUndefined();
      const request = contextText(context);
      expect(request.match(/canonical-header/g)).toHaveLength(1);
      expect(context.messages.at(-1).content[0].text).toContain(
        expectedActions[index]!,
      );
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

  // Regression: #2982 Anthropic reviews cache only through a breakpoint on the last evidence message.
  test("Anthropic reviews mark the last evidence message and resend it as a stable cached prefix", async () => {
    const bodies: any[] = [];
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "OK" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        bodies.push(await request.json());
        return new Response(
          events
            .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const model = {
        id: "claude-haiku-5-5",
        name: "Claude Haiku",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: server.url.origin,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_000,
      } as any;
      const record = (n: number) =>
        `\n${JSON.stringify({ record: n, text: "r".repeat(5_000) })}`;
      let evidence = "header";
      for (const n of [1, 2, 3]) {
        evidence += record(n);
        const verdict = await reviewAction(
          ctx,
          model,
          "low",
          [],
          evidence,
          `bash: action-${n}`,
          undefined,
          "generation-a",
          "conversation-anthropic",
        );
        expect(verdict.decision).toBe("allow");
      }
      expect(bodies).toHaveLength(3);
      const marked = (body: any) =>
        body.messages.findIndex((message: any) =>
          message.content.some((block: any) => block.cache_control),
        );
      for (const [n, body] of bodies.entries()) {
        expect(marked(body)).toBe(body.messages.length - 2);
        expect(JSON.stringify(body.messages.at(-2))).toContain(
          `\\"record\\":${n + 1}`,
        );
        expect(JSON.stringify(body.messages.at(-1))).toContain(
          `action-${n + 1}`,
        );
      }
      const prefix = (body: any, end: number) =>
        JSON.stringify(
          [body.system, body.messages.slice(0, end + 1)],
          (k, v) => (k === "cache_control" ? undefined : v),
        );
      const [, second, third] = bodies;
      expect(prefix(third, marked(second))).toBe(
        prefix(second, marked(second)),
      );
    } finally {
      server.stop(true);
    }
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
