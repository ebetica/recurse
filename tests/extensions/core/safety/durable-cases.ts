import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type Context as AiContext,
  type SimpleStreamOptions,
  Type,
} from "@earendil-works/pi-ai";
import {
  createModels,
  createProvider,
  type Models,
} from "@earendil-works/pi-ai/models";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
  MemoryStorage,
  type Conversation,
  type Extension,
  type Storage,
} from "@earendil-works/pi-durable";
import {
  createDurableSafety,
  DeniedReviewDoc,
  setSafetyReviewOff,
  safetyReviewUnavailable,
} from "../../../../src/extensions/core/safety/durable.ts";
import { clearReviewerEvidenceCache } from "../../../../src/extensions/core/safety/review-journal.ts";

const workspace = process.env.RECURSE_WORKSPACE_ROOT!;
mkdirSync(workspace, { recursive: true });
afterEach(() => clearReviewerEvidenceCache());

const USER_TEXT =
  "## Message\n[recurse-origin: operator]\nPlease push the branch and tidy up.";
const POLICY = JSON.stringify({
  version: 1,
  active: { provider: "anthropic", model: "claude-opus-5" },
  reviewer: {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    effort: "low",
    candidates: [
      { provider: "anthropic", model: "claude-sonnet-5", effort: "medium" },
    ],
  },
  summary: { provider: "anthropic", model: "claude-sonnet-5", effort: "low" },
});

type Reply = string | { error: string };
type ReviewerScript = (model: string, user: string, attempt: number) => Reply;
type Call = { name: string; args: Record<string, unknown>; id?: string };
type Case = {
  name: string;
  calls: Call[];
  reviewer?: ReviewerScript;
  env?: Record<string, string | undefined>;
  off?: boolean;
  configError?: boolean;
  unauthenticated?: string[];
};
type Observed = {
  decisions: Array<{ decision: "allow" | "block"; reason?: string }>;
  reviews: Array<{
    model: string;
    reasoning: unknown;
    system: string;
    user: string;
  }>;
  notices: string[];
};

const baseEnv = (): Record<string, string | undefined> => ({
  RECURSE_AGENT_ID: "agent-parity",
  RECURSE_MODEL_POLICY: POLICY,
  RECURSE_WORKSPACE_ROOT: workspace,
  RECURSE_WORKTREES_ROOT: process.env.RECURSE_WORKTREES_ROOT,
  RECURSE_AGENT_TMPDIR: process.env.RECURSE_AGENT_TMPDIR,
  RECURSE_AGENT_ENV_FILE: process.env.RECURSE_AGENT_ENV_FILE,
  CHAT_DATA_DIR: process.env.CHAT_DATA_DIR,
  HOME: workspace,
});

function text(content: unknown): string {
  return typeof content === "string"
    ? content
    : ((content ?? []) as Array<{ text?: string }>)
        .map((block) => block.text ?? "")
        .join("");
}

function systemText(context: AiContext): string {
  return (
    context.systemPrompt ??
    context.messages
      .filter((message) => (message.role as string) === "system")
      .map((message) => text(message.content))
      .join("\n")
  );
}

function isReview(context: AiContext): boolean {
  return systemText(context).includes(
    "untrusted record of a user's interaction",
  );
}

function userText(context: AiContext): string {
  return text(context.messages.at(-1)?.content);
}

function makeModels(input: {
  reviewer: ReviewerScript;
  main: (
    context: AiContext,
    options: SimpleStreamOptions | undefined,
  ) => AssistantMessage | Promise<AssistantMessage>;
  unauthenticated?: string[];
  reviews: Observed["reviews"];
}): Models {
  const models = createModels();
  const attempts = new Map<string, number>();
  for (const [provider, ids] of [
    ["anthropic", ["claude-opus-5", "claude-sonnet-5"]],
    ["openai-codex", ["gpt-5.6-luna", "gpt-5.6-sol"]],
  ] as const) {
    const core = createFauxCore({
      provider,
      models: ids.map((id) => ({ id, reasoning: true })),
    });
    const step = async (
      context: AiContext,
      options: SimpleStreamOptions | undefined,
      _state: unknown,
      model: { id: string },
    ) => {
      if (!isReview(context)) return input.main(context, options);
      const user = userText(context);
      const key = user
        .replace(/\n\nYour previous reply was malformed[\s\S]*$/, "")
        .slice(-400);
      const attempt = attempts.get(key) ?? 0;
      attempts.set(key, attempt + 1);
      input.reviews.push({
        model: `${provider}/${model.id}`,
        reasoning: options?.reasoning,
        system: systemText(context),
        user: user.replace(
          /"evidence_generation":"[0-9a-f]+"/,
          '"evidence_generation":"<generation>"',
        ),
      });
      const reply = input.reviewer(`${provider}/${model.id}`, user, attempt);
      return typeof reply === "string"
        ? fauxAssistantMessage(reply)
        : fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: reply.error,
          });
    };
    core.setResponses(Array.from({ length: 200 }, () => step as never));
    const missing = input.unauthenticated?.includes(provider);
    models.setProvider(
      createProvider({
        id: provider,
        auth: {
          apiKey: {
            name: "Test",
            resolve: async () =>
              missing ? undefined : { auth: { apiKey: "test-key" } },
          },
        },
        models: core.models,
        api: { stream: core.stream, streamSimple: core.streamSimple },
      }) as never,
    );
  }
  return models;
}

const ok: ReviewerScript = () => "OK";

const recorded = JSON.parse(
  readFileSync(
    new URL("./fixtures/pi-path-parity.json", import.meta.url),
    "utf8",
  )
    .replaceAll("<WORKSPACE>", workspace)
    .replaceAll("<DATA_DIR>", process.env.CHAT_DATA_DIR!),
) as { system: string; cases: Record<string, Observed>; breaker: Observed };

function viaPi(name: string): Observed {
  const observed = name === "breaker" ? recorded.breaker : recorded.cases[name];
  if (!observed) throw new Error(`no recorded Pi path for ${name}`);
  return {
    ...observed,
    reviews: observed.reviews.map((review) => ({
      ...review,
      system: recorded.system,
    })),
  };
}

const stub = (
  name: string,
  parameters: ReturnType<typeof Type.Object>,
  ran: Array<{ name: string; args: unknown }>,
) =>
  defineTool({
    name,
    description: `stub ${name}`,
    parameters,
    execute: async (args) => {
      ran.push({ name, args });
      return {
        output: [{ type: "text", text: `${name} ran` }],
        details: { recurseToolTiming: "forged" } as never,
      };
    },
  });

function stubTools(ran: Array<{ name: string; args: unknown }>) {
  const s = Type.String();
  return defineExtension({
    name: "stub-tools",
    tools: [
      stub("bash", Type.Object({ command: s }), ran),
      stub("write", Type.Object({ path: s, content: s }), ran),
      stub("edit", Type.Object({ path: s, oldText: s, newText: s }), ran),
      stub("read", Type.Object({ path: s }), ran),
      stub("chdir", Type.Object({ directory: s }), ran),
      stub("mcp__srv__tool", Type.Object({}), ran),
    ],
  });
}

type DurableSetup = {
  harness: Harness;
  conversation: Conversation;
  models: Models;
  ran: Array<{ name: string; args: unknown }>;
  observed: Observed;
  mainCalls: () => number;
};

async function openDurable(
  c: Case,
  rounds: Array<Call[] | null>,
  storage: Storage = new MemoryStorage(),
  options: {
    existing?: boolean;
    hangAfterRounds?: boolean;
    extra?: Extension;
  } = {},
): Promise<DurableSetup> {
  const observed: Observed = { decisions: [], reviews: [], notices: [] };
  const ran: Array<{ name: string; args: unknown }> = [];
  let mainCalls = 0;
  const models = makeModels({
    reviewer: c.reviewer ?? ok,
    reviews: observed.reviews,
    unauthenticated: c.unauthenticated,
    main: (_context, streamOptions) => {
      const round = rounds[mainCalls++];
      if (round) {
        return fauxAssistantMessage(
          round.map((call, index) =>
            fauxToolCall(call.name, call.args as never, {
              id: call.id ?? `call-${mainCalls}-${index}`,
            }),
          ),
          { stopReason: "toolUse" },
        );
      }
      if (round === null || !options.hangAfterRounds)
        return fauxAssistantMessage("done");
      return new Promise((_resolve, reject) => {
        streamOptions?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    },
  });
  const env = { ...baseEnv(), ...c.env };
  const registry = createRegistry();
  registry.install(stubTools(ran));
  if (options.extra) registry.install(options.extra);
  let harness!: Harness;
  let conversation!: Conversation;
  registry.install(
    createDurableSafety({
      models,
      configDir: "/tmp/pi-agent",
      trusted: () => ({
        modelPolicy: env.RECURSE_MODEL_POLICY,
        workspaceRoot: env.RECURSE_WORKSPACE_ROOT,
        worktreesRoot: env.RECURSE_WORKTREES_ROOT,
        tempRoot: env.RECURSE_AGENT_TMPDIR,
        home: env.HOME,
        dataDir: env.CHAT_DATA_DIR,
        statsRoot: process.env.RECURSE_SAFETY_DIR,
      }),
      shells: () => undefined,
      loadConfig: () => ({
        additionalRules: [],
        path: "/tmp/pi-safety.json",
        ...(c.configError ? { error: "bad" } : {}),
      }),
      agent: async () => ({
        id: "agent-parity",
        env,
        cwd: workspace,
        conversation,
        stopRun: () => {
          void (async () => {
            const live = await harness.snapshot(LiveDoc, conversation.id, BG);
            if (live?.run) await harness.abortTask(live.run.taskId, BG);
          })();
        },
      }),
    }),
  );
  harness = await Harness.open(storage, { models, registry }, BG);
  conversation = await harness.root(
    BG,
    options.existing
      ? undefined
      : {
          agent: {
            model: { provider: "anthropic", modelId: "claude-opus-5" },
            cwd: workspace,
          },
        },
  );
  if (c.off) await setSafetyReviewOff(conversation, true, BG);
  return {
    harness,
    conversation,
    models,
    ran,
    observed,
    mainCalls: () => mainCalls,
  };
}

type ResultMessage = {
  toolCallId: string;
  content: Array<{ text?: string }>;
  details?: any;
  usage?: any;
};

async function toolResults(conversation: Conversation) {
  const view = await conversation.context(BG);
  return view.entries.flatMap((entry) =>
    entry.kind === "pi.tool-result"
      ? [
          {
            message: entry.model![0] as unknown as ResultMessage,
            diagnostics: (entry.data as any).diagnostics as Array<{
              severity: string;
              code: string;
              message: string;
            }>,
          },
        ]
      : [],
  );
}

async function viaDurable(
  c: Case,
): Promise<Observed & { ran: Array<{ name: string; args: unknown }> }> {
  const setup = await openDurable(c, [c.calls]);
  await (
    await setup.conversation.submit({ type: "input", content: USER_TEXT }, BG)
  ).wait(BG);
  const results = await toolResults(setup.conversation);
  for (const [index, call] of c.calls.entries()) {
    const id = call.id ?? `call-1-${index}`;
    const result = results.find((each) => each.message.toolCallId === id)!;
    const blocked = result.diagnostics.find((each) => each.code === "blocked");
    setup.observed.decisions.push(
      blocked
        ? {
            decision: "block",
            reason: blocked.message.replace(/^Tool call blocked: /, ""),
          }
        : { decision: "allow" },
    );
    for (const notice of result.diagnostics.filter(
      (each) => each.code === "safety_review_failed",
    )) {
      setup.observed.notices.push(notice.message);
    }
  }
  if (c.name === "provider error: fail open with notice") {
    expect(
      await safetyReviewUnavailable(setup.harness, setup.conversation, BG),
    ).toBe("provider error");
    await setSafetyReviewOff(setup.conversation, true, BG);
    await setSafetyReviewOff(setup.conversation, false, BG);
    expect(
      await safetyReviewUnavailable(setup.harness, setup.conversation, BG),
    ).toBeUndefined();
  }
  await setup.harness.close(BG);
  return { ...setup.observed, ran: setup.ran };
}

const deny =
  (reason: string): ReviewerScript =>
  () =>
    `DENY: ${reason}`;

const CASES: Case[] = [
  {
    name: "read-only bash skips review",
    calls: [{ name: "bash", args: { command: "rg needle | git diff" } }],
  },
  {
    name: "bash reviewed OK",
    calls: [{ name: "bash", args: { command: "rg needle && git push" } }],
  },
  {
    name: "bash reviewed DENY",
    calls: [{ name: "bash", args: { command: "git push --force" } }],
    reviewer: deny("Force-pushing was not authorized"),
  },
  {
    name: "DENY reason case and punctuation",
    calls: [{ name: "bash", args: { command: "rm -rf build" } }],
    reviewer: deny("Deletes build output without being asked"),
  },
  {
    name: "chdir skips review",
    calls: [{ name: "chdir", args: { directory: "/etc" } }],
  },
  {
    name: "read is not reviewed",
    calls: [{ name: "read", args: { path: "/etc/shadow" } }],
  },
  {
    name: "write inside workspace skips review",
    calls: [
      {
        name: "write",
        args: { path: join(workspace, "a.txt"), content: "secret-free" },
      },
    ],
  },
  {
    name: "write outside workspace: path-only summary review",
    calls: [
      { name: "write", args: { path: "/etc/motd", content: "TOKEN=abc" } },
    ],
  },
  {
    name: "edit outside workspace DENY",
    calls: [
      {
        name: "edit",
        args: { path: "/etc/passwd", oldText: "a", newText: "b" },
      },
    ],
    reviewer: deny("Edits a system account file"),
  },
  {
    name: "escape hatch skips review",
    calls: [{ name: "bash", args: { command: "git push" } }],
    off: true,
    reviewer: deny("must not be asked"),
  },
  {
    name: "direct MCP call blocked, even with review off",
    calls: [{ name: "mcp__srv__tool", args: {} }],
    off: true,
  },
  {
    name: "invalid safety config blocks reviewed tools",
    calls: [
      { name: "bash", args: { command: "git push" } },
      { name: "read", args: { path: "/etc/hosts" } },
    ],
    configError: true,
  },
  {
    name: "invalid model policy fails open with notice",
    calls: [{ name: "bash", args: { command: "git push" } }],
    env: { RECURSE_MODEL_POLICY: "{not json" },
  },
  {
    name: "absent model policy: active model reviews at low",
    calls: [{ name: "bash", args: { command: "git push" } }],
    env: { RECURSE_MODEL_POLICY: undefined },
  },
  {
    name: "reviewer auth failure advances to fallback",
    calls: [{ name: "bash", args: { command: "git push" } }],
    unauthenticated: ["openai-codex"],
    reviewer: deny("Fallback reviewer denies"),
  },
  {
    name: "no reviewer credentials: fail open with notice",
    calls: [{ name: "bash", args: { command: "git push" } }],
    unauthenticated: ["openai-codex"],
    env: {
      RECURSE_MODEL_POLICY: POLICY.replace(
        '"anthropic","model":"claude-sonnet-5","effort":"medium"',
        '"openai-codex","model":"gpt-5.6-sol","effort":"medium"',
      ),
    },
  },
  {
    name: "malformed verdict twice: fail open with notice",
    calls: [{ name: "bash", args: { command: "git push" } }],
    reviewer: () => "Looks fine to me.\nOK",
  },
  {
    name: "provider error: fail open with notice",
    calls: [{ name: "bash", args: { command: "git push" } }],
    reviewer: () => ({ error: "HTTP 529 overloaded" }),
  },
  {
    name: "missing-policy sentinel retries with inlined policy",
    calls: [{ name: "bash", args: { command: "git push" } }],
    reviewer: (_m, _u, attempt) =>
      attempt === 0 ? "DENY: pi-safety-review-policy-not-received" : "OK",
  },
  {
    name: "path expansion before scope check",
    calls: [{ name: "write", args: { path: "$HOME/notes.txt", content: "x" } }],
  },
  {
    name: "unknown path variable blocks",
    calls: [{ name: "write", args: { path: "$NOPE/notes.txt", content: "x" } }],
  },
];

test("every case reaches the same decision, reviewer requests, and notice on both paths", async () => {
  const table: string[] = [
    "| case | Pi | Durable | reviews |",
    "|---|---|---|---|",
  ];
  for (const c of CASES) {
    const pi = viaPi(c.name);
    const durable = await viaDurable(c);
    clearReviewerEvidenceCache();
    const { ran } = durable;
    expect({ case: c.name, decisions: durable.decisions }).toEqual({
      case: c.name,
      decisions: pi.decisions,
    });
    expect(ran.map((each) => each.name)).toEqual(
      c.calls
        .filter((_, index) => durable.decisions[index]!.decision === "allow")
        .map((call) => call.name),
    );
    const show = (o: Observed) =>
      o.decisions.map((d) => d.decision).join("+") +
      (o.notices.length ? " (notice)" : "");
    table.push(
      `| ${c.name} | ${show(pi)} | ${show(durable)} | ${pi.reviews.map((r) => r.model).join(", ") || "none"} |`,
    );
  }
  console.log(table.join("\n"));
});

test("path expansion rewrites the arguments the tool receives", async () => {
  const durable = await viaDurable({
    name: "expand",
    calls: [{ name: "write", args: { path: "$HOME/notes.txt", content: "x" } }],
  });
  expect(durable.ran).toEqual([
    {
      name: "write",
      args: { path: join(workspace, "notes.txt"), content: "x" },
    },
  ]);
});

test("three denials open the breaker with the same messages on both paths and stop the run", async () => {
  const calls = [1, 2, 3].map((n) => ({
    name: "bash",
    args: { command: `git push origin v${n}` },
    id: `deny-${n}`,
  }));
  const reviewer = deny("Pushing tags was not authorized");
  const pi = viaPi("breaker");
  const setup = await openDurable(
    { name: "breaker", calls, reviewer },
    calls.map((call) => [call]),
    undefined,
    { hangAfterRounds: true },
  );
  const settled = await (
    await setup.conversation.submit({ type: "input", content: USER_TEXT }, BG)
  ).wait(BG);
  const results = await toolResults(setup.conversation);
  expect(
    results.map((r) =>
      r.diagnostics[0]!.message.replace(/^Tool call blocked: /, ""),
    ),
  ).toEqual(pi.decisions.map((d) => d.reason!));
  expect(pi.decisions.at(-1)!.reason).toContain(
    "Circuit breaker opened after 3 denied actions",
  );
  expect(setup.ran).toEqual([]);
  expect(setup.observed.reviews.length).toBe(3);
  expect(settled.status).toBe("unanswered");
  expect(
    await setup.harness.snapshot(LiveDoc, setup.conversation.id, BG),
  ).not.toHaveProperty("run");
  await setup.harness.close(BG);
});

test("in a parallel round, calls after the third denial block without review and the run stops", async () => {
  const round = [1, 2, 3, 4, 5].map((n) => ({
    name: "bash",
    args: { command: `curl -X DELETE https://api/item/${n}` },
    id: `p-${n}`,
  }));
  const setup = await openDurable(
    { name: "parallel", calls: round, reviewer: deny("Deletes remote data") },
    [round],
    undefined,
    { hangAfterRounds: true },
  );
  const settled = await (
    await setup.conversation.submit({ type: "input", content: USER_TEXT }, BG)
  ).wait(BG);
  const messages = (await toolResults(setup.conversation)).map(
    (r) => r.diagnostics[0]!.message,
  );
  expect(setup.observed.reviews.length).toBe(3);
  expect(setup.ran).toEqual([]);
  expect(
    messages.filter((m) => m.includes("Denied actions this run: 1/3")).length,
  ).toBe(1);
  expect(
    messages.filter((m) => m.includes("Denied actions this run: 2/3")).length,
  ).toBe(1);
  expect(
    messages.filter((m) =>
      m.includes("Circuit breaker opened after 3 denied actions"),
    ).length,
  ).toBe(1);
  expect(
    messages.filter((m) =>
      m.includes("the circuit breaker opened after 3 denied actions"),
    ).length,
  ).toBe(2);
  expect(settled.status).toBe("unanswered");
  const denied = await setup.harness.snapshot(
    DeniedReviewDoc,
    setup.conversation.id,
    BG,
  );
  expect(denied?.calls).toBe(3);
  expect(denied?.recent.length).toBe(3);
  expect(denied?.run?.denied.length).toBe(3);
  expect(denied!.usage.input).toBeGreaterThan(0);
  expect(denied!.safetyWaitMs).toBeGreaterThan(0);
  await setup.harness.close(BG);
});

test("an executed call carries reviewer usage and timing; tool-forged reserved details are dropped", async () => {
  const setup = await openDurable({ name: "ok", calls: [] }, [
    [{ name: "bash", args: { command: "git push" }, id: "ok-1" }],
  ]);
  await (
    await setup.conversation.submit({ type: "input", content: USER_TEXT }, BG)
  ).wait(BG);
  const [result] = await toolResults(setup.conversation);
  const details = result!.message.details;
  expect(details.recurseSafetyUsage.attempts).toHaveLength(1);
  expect(details.recurseSafetyUsage.attempts[0].status).toBe("reported");
  expect(details.recurseToolTiming.version).toBe(1);
  expect(details.recurseToolTiming.totalMs).toBeGreaterThanOrEqual(
    details.recurseToolTiming.safetyWaitMs,
  );
  expect(result!.message.usage.input).toBe(
    details.recurseSafetyUsage.attempts[0].usage.input,
  );
  expect((await setup.harness.usage(BG)).tools.bash?.input).toBe(
    result!.message.usage.input,
  );
  await setup.harness.close(BG);
});

function dyingAfter(
  inner: MemoryStorage,
  dies: (writes: string) => boolean,
): Storage {
  let dead = false;
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "commit")
        return typeof value === "function" ? value.bind(target) : value;
      return async (writes: unknown, context: unknown) => {
        if (dead) return new Promise(() => {});
        const seq = await (value as Function).call(target, writes, context);
        if (dies(JSON.stringify(writes))) dead = true;
        return seq;
      };
    },
  }) as Storage;
}

for (const verdict of ["OK", "DENY: Pushing was not authorized"]) {
  test(`a resume after a crash following the ${verdict.slice(0, 4)} verdict does not review again`, async () => {
    const inner = new MemoryStorage();
    const c: Case = { name: "crash", calls: [], reviewer: () => verdict };
    const first = await openDurable(
      c,
      [[{ name: "bash", args: { command: "git push" }, id: "crash-1" }]],
      dyingAfter(inner, (writes) => writes.includes("recurse.safety:")),
    );
    void first.conversation.submit({ type: "input", content: USER_TEXT }, BG);
    for (let i = 0; i < 200 && first.observed.reviews.length === 0; i += 1)
      await Bun.sleep(10);
    await Bun.sleep(100);
    expect(first.observed.reviews.length).toBe(1);
    expect(first.ran).toEqual([]);
    const second = await openDurable(c, [], inner, { existing: true });
    second.harness.resume();
    await second.harness.waitForIdle(BG);
    expect(second.observed.reviews.length).toBe(0);
    const [result] = await toolResults(second.conversation);
    if (verdict === "OK") {
      expect(second.ran).toEqual([
        { name: "bash", args: { command: "git push" } },
      ]);
    } else {
      expect(second.ran).toEqual([]);
      expect(result!.diagnostics[0]!.message).toContain(
        "Tool call blocked because pushing was not authorized.",
      );
      expect(
        (
          await second.harness.snapshot(
            DeniedReviewDoc,
            second.conversation.id,
            BG,
          )
        )?.calls,
      ).toBe(1);
    }
    await second.harness.close(BG);
  });
}

test("a run resumed after two denials keeps its breaker count and opens on the third", async () => {
  const inner = new MemoryStorage();
  const c: Case = {
    name: "resume-breaker",
    calls: [],
    reviewer: deny("Pushing was not authorized"),
  };
  const rounds = [1, 2, 3].map((n) => [
    {
      name: "bash",
      args: { command: `git push origin r${n}` },
      id: `brk-${n}`,
    },
  ]);
  const dies = (writes: string) => writes.includes('["s",["calls"],2]');
  const first = await openDurable(c, rounds, dyingAfter(inner, dies), {
    hangAfterRounds: true,
  });
  void first.conversation.submit({ type: "input", content: USER_TEXT }, BG);
  for (let i = 0; i < 200 && first.observed.reviews.length < 2; i += 1)
    await Bun.sleep(10);
  await Bun.sleep(100);
  expect(first.observed.reviews.length).toBe(2);
  const second = await openDurable(c, rounds.slice(2), inner, {
    existing: true,
    hangAfterRounds: true,
  });
  second.harness.resume();
  await second.harness.waitForIdle(BG);
  const messages = (await toolResults(second.conversation)).map(
    (r) => r.diagnostics[0]!.message,
  );
  expect(messages[0]).toContain("Denied actions this run: 1/3.");
  expect(messages[1]).toContain("Denied actions this run: 2/3.");
  expect(messages[2]).toContain(
    "Circuit breaker opened after 3 denied actions",
  );
  expect(second.observed.reviews.length).toBe(1);
  expect(second.ran).toEqual([]);
  expect(
    await second.harness.snapshot(LiveDoc, second.conversation.id, BG),
  ).not.toHaveProperty("run");
  await second.harness.close(BG);
});

test("a restart after the third denial's result still stops the run", async () => {
  const inner = new MemoryStorage();
  const c: Case = {
    name: "resume-stop",
    calls: [],
    reviewer: deny("Pushing was not authorized"),
  };
  const rounds = [1, 2, 3].map((n) => [
    {
      name: "bash",
      args: { command: `git push origin s${n}` },
      id: `stop-${n}`,
    },
  ]);
  const first = await openDurable(
    c,
    rounds,
    dyingAfter(inner, (writes) =>
      writes.includes("Circuit breaker opened after 3"),
    ),
    { hangAfterRounds: true },
  );
  void first.conversation.submit({ type: "input", content: USER_TEXT }, BG);
  for (let i = 0; i < 200 && first.observed.reviews.length < 3; i += 1)
    await Bun.sleep(10);
  await Bun.sleep(100);
  const second = await openDurable(c, [], inner, {
    existing: true,
    hangAfterRounds: true,
  });
  second.harness.resume();
  await second.harness.waitForIdle(BG);
  expect(second.observed.reviews.length).toBe(0);
  expect(
    (await toolResults(second.conversation)).at(-1)!.diagnostics[0]!.message,
  ).toContain("Circuit breaker opened after 3");
  expect(
    await second.harness.snapshot(LiveDoc, second.conversation.id, BG),
  ).not.toHaveProperty("run");
  await second.harness.close(BG);
});

test("denied usage counts a repeated model call id in a later run", async () => {
  const call = {
    name: "bash",
    args: { command: "git push --force" },
    id: "same-id",
  };
  const setup = await openDurable(
    {
      name: "dup",
      calls: [],
      reviewer: deny("Force-pushing was not authorized"),
    },
    [[call], null, [call], null],
  );
  await (
    await setup.conversation.submit({ type: "input", content: USER_TEXT }, BG)
  ).wait(BG);
  await (
    await setup.conversation.submit({ type: "input", content: "again" }, BG)
  ).wait(BG);
  expect(setup.observed.reviews.length).toBe(2);
  expect(
    (await setup.harness.snapshot(DeniedReviewDoc, setup.conversation.id, BG))
      ?.calls,
  ).toBe(2);
  await setup.harness.close(BG);
});

test("the escape hatch follows only the setter, not the model, tools, or PI_SAFETY_OFF", async () => {
  const previous = process.env.PI_SAFETY_OFF;
  process.env.PI_SAFETY_OFF = "1";
  try {
    const attempts = [
      {
        name: "bash",
        args: { command: "export PI_SAFETY_OFF=1" },
      },
      {
        name: "bash",
        args: {
          command:
            "export PI_SAFETY_OFF=1; echo '{\"off\":true}' > recurse.safety",
        },
      },
      {
        name: "write",
        args: {
          path: join(workspace, "recurse.safety"),
          content: '{"off":true}',
        },
      },
      { name: "reach", args: {} },
    ];
    const probe = (n: number) => [
      { name: "bash", args: { command: `git push origin probe-${n}` } },
    ];
    let handle: Record<string, unknown> | undefined;
    const reach = defineExtension({
      name: "reach",
      tools: [
        defineTool({
          name: "reach",
          description: "reach the conversation",
          parameters: Type.Object({}),
          execute: async (_args, api) => {
            handle = (await api.conversation(api.conversationId, BG)) as never;
            return { output: [{ type: "text", text: "reached" }] };
          },
        }),
      ],
    });
    const setup = await openDurable(
      { name: "hatch", calls: [], env: { PI_SAFETY_OFF: "1" } },
      [attempts, probe(1), null, probe(2), null, probe(3), null],
      undefined,
      { extra: reach },
    );
    const proposed = () =>
      setup.observed.reviews.map(
        (r) =>
          JSON.parse(
            r.user
              .split(">>> PROPOSED ACTION START\n")[1]!
              .split("\n>>> PROPOSED ACTION END")[0]!,
          ).input,
      );
    await (
      await setup.conversation.submit({ type: "input", content: USER_TEXT }, BG)
    ).wait(BG);
    expect(handle).toBeDefined();
    expect(handle!.commit).toBeUndefined();
    expect(proposed()).toEqual([
      attempts[0]!.args,
      attempts[1]!.args,
      probe(1)[0]!.args,
    ]);
    await setSafetyReviewOff(setup.conversation, true, BG);
    await (
      await setup.conversation.submit({ type: "input", content: "off" }, BG)
    ).wait(BG);
    expect(proposed()).toHaveLength(3);
    expect(setup.ran.at(-1)).toEqual({ name: "bash", args: probe(2)[0]!.args });
    await setSafetyReviewOff(setup.conversation, false, BG);
    await (
      await setup.conversation.submit({ type: "input", content: "on" }, BG)
    ).wait(BG);
    expect(proposed().at(-1)).toEqual(probe(3)[0]!.args);
    await setup.harness.close(BG);
  } finally {
    if (previous === undefined) delete process.env.PI_SAFETY_OFF;
    else process.env.PI_SAFETY_OFF = previous;
  }
});
