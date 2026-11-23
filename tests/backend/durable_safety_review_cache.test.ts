import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  builtinProviders,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { DurableHost } from "../../src/agents/durable/host";
import { Config } from "../../src/config";
import { stampMessage } from "../../src/agents/runtime/prompt_stamp";
import { clearReviewerEvidenceCache } from "../../src/extensions/core/safety/review-journal";
import { idle, testDeps, until } from "./fixtures/durable_host/host";
import { requestBody, type Recording } from "./fixtures/provider_replay/server";
import {
  recordedActor,
  recordedLuna,
  recordedSonnet,
} from "./fixtures/reviewer_routes";

// Regression: #3616 Claude bash and path-only reviews use Luna on the chosen billing route, without request failover.
test.each([
  "anthropic-only",
  "custom-level-one",
  "platform-level-one",
  "platform-signed-out",
])("Claude selects one reviewer: %s", async (scenario) => {
  const luna = recordedLuna;
  const anthropic = getBuiltinModels("anthropic");
  const actor = anthropic.find((model) => model.id === recordedActor.modelId)!;
  const sonnet = anthropic.find((model) => model.id === recordedSonnet.id)!;
  const platform = getBuiltinModels("openai");
  const platformLuna = platform.find((model) => model.id === luna.id)!;
  const platformChoice = platform.find(
    (model) => model.reasoning && model.id !== luna.id,
  )!;
  const custom = fauxProvider({
    provider: "reviewer-choice",
  }).provider.getModels()[0]!;
  const platformPinned = scenario.startsWith("platform-");
  const choice = platformPinned
    ? platformChoice
    : scenario === "custom-level-one"
      ? custom
      : undefined;
  const expected =
    scenario === "platform-level-one"
      ? platformLuna
      : scenario === "custom-level-one"
        ? luna
        : sonnet;
  const fails = expected !== sonnet;
  const selector = (model: { provider: string; id: string }) =>
    `${model.provider}/${model.id}`;
  const signedIn = new Set([actor.provider]);
  if (choice) {
    signedIn.add(luna.provider);
    signedIn.add(choice.provider);
  }
  const root = mkdtempSync(join(tmpdir(), "durable-claude-reviewer-"));
  const work = join(root, "work");
  mkdirSync(work);
  const config = new Config({
    env: { HOME: root, CHAT_DATA_DIR: root },
    authenticatedProviders: () => signedIn,
  });
  await Bun.write(
    config.paths.MODEL_PROVIDERS_FILE,
    JSON.stringify({
      providers: {
        [custom.provider]: {
          base_url: "https://provider.example.invalid/v1",
          env_key: "REVIEWER_FIXTURE_KEY",
          wire_api: "completions",
          models: [{ id: custom.id, context_window: custom.contextWindow }],
        },
      },
    }),
  );
  await config.models.setPiModelList(
    [actor, sonnet, luna, platformLuna, platformChoice].map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      context_window: model.contextWindow,
    })),
  );
  if (choice) await config.levels.setEffortLevel(1, selector(choice), "low");
  if (scenario === "platform-signed-out")
    signedIn.delete(platformLuna.provider);
  const models = createModels();
  const faux = createFauxCore({ tokensPerSecond: 20_000 });
  for (const catalog of [
    anthropic,
    [luna],
    [platformLuna, platformChoice],
    [custom],
  ]) {
    const provider = catalog[0]!.provider;
    models.setProvider(
      createProvider({
        id: provider,
        models: catalog,
        auth: {
          apiKey: {
            name: "Test",
            resolve: async () =>
              signedIn.has(provider)
                ? { auth: { apiKey: "test-key" } }
                : undefined,
          },
        },
        api: { stream: faux.stream, streamSimple: faux.streamSimple },
      }),
    );
  }
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const host = new DurableHost({
    ...testDeps(
      root,
      () => ({ id: "c1", backend: "durable", workdir: work }),
      () => ["c1"],
      selector(actor),
    ),
    models,
    config,
    log: (event, fields) => logs.push({ event, fields }),
  });
  try {
    for (const tool of ["write", "bash"] as const) {
      const file = join(work, tool);
      const reviews: string[] = [];
      const respond = (model: Parameters<typeof selector>[0]) => {
        reviews.push(selector(model));
        return model.id === luna.id
          ? fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "401: Unauthorized reviewer request",
            })
          : fauxAssistantMessage("DENY: fixture refusal");
      };
      faux.setResponses([
        fauxAssistantMessage(
          tool === "bash"
            ? fauxToolCall(tool, { command: `touch ${file}` })
            : fauxToolCall(tool, {
                path: file,
                content: "Task-owned fixture.",
              }),
          { stopReason: "toolUse" },
        ),
        (_request, _options, _state, model) => respond(model),
        (_request, _options, _state, model) =>
          selector(model) === selector(actor)
            ? fauxAssistantMessage("done")
            : respond(model),
        fauxAssistantMessage("done"),
      ]);
      await host.send("c1", `Create ${tool}.`, tool);
      await until(idle(host));
      expect(reviews).toEqual([selector(expected)]);
      expect(existsSync(file)).toBe(fails);
      if (fails)
        expect(host.metadata("c1").safety_unavailable).toBe(
          "no reviewer login",
        );
      const view = JSON.stringify((await host.view("c1")).blocks);
      expect(view).toContain(
        fails ? "allowed without review" : "fixture refusal",
      );
    }
    const failed = {
      event: "safety_review_failed",
      fields: expect.objectContaining({
        provider: expected.provider,
        model: expected.id,
        category: "auth",
        attempts: 1,
        http_status: 401,
      }),
    };
    expect(logs.filter(({ event }) => event === failed.event)).toEqual(
      fails ? [failed, failed] : [],
    );
  } finally {
    await host.close();
    await config.close();
    rmSync(root, { recursive: true, force: true });
  }
});

type Review = {
  instructions?: string;
  input: unknown[];
  prompt_cache_key?: string;
};

// Regression: #2982 #3390 #3466 keep the cached reviewer prefix, also after a reset.
test("consecutive Durable reviews preserve the actual Codex cache identity and wire prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "durable-review-cache-"));
  const work = join(root, "work");
  mkdirSync(work);
  await Bun.write(join(work, "seed"), "public cache fixture");
  const recording: Recording = await Bun.file(
    join(import.meta.dir, "fixtures/provider_replay/openai-codex-sse.json"),
  ).json();
  const reviews: Review[] = [];
  const sessions: (string | null)[] = [];
  const reads: number[] = [];
  let failNext = false;
  let suspended: { started(): void; released: Promise<void> } | undefined;
  let releaseSuspended: (() => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const review = (await requestBody(request)) as Review;
      const prior = reviews.at(-1);
      const stable = prior?.input;
      const cacheRead =
        prior &&
        prior.prompt_cache_key === review.prompt_cache_key &&
        prior.instructions === review.instructions &&
        JSON.stringify(stable) ===
          JSON.stringify(review.input.slice(0, stable!.length))
          ? 1024
          : 0;
      reviews.push(review);
      sessions.push(request.headers.get("session-id"));
      reads.push(cacheRead);
      if (failNext) {
        failNext = false;
        return new Response("fixture outage", { status: 503 });
      }
      const holding = suspended;
      if (holding) {
        suspended = undefined;
        holding.started();
        await holding.released;
      }
      const body = recording.exchanges[0]!.chunks.map(({ data }) =>
        Buffer.from(data, "base64").toString("utf8"),
      )
        .join("")
        .replaceAll(/"delta":"[^"]*"/g, '"delta":""')
        .replaceAll("RECORDED_PROVIDER_OK", "- **OK**")
        .replaceAll('"cached_tokens":0', `"cached_tokens":${cacheRead}`);
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  models.setProvider(faux.provider);
  const model = { ...recording.model, id: "gpt-6.2-sol" };
  const changedModel = { ...model, id: "recorded-cache-alternate" };
  const codex = builtinProviders().find((p) => p.id === model.provider)!;
  const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "cache-test" } })).toString("base64url")}.test`;
  models.setProvider({
    ...codex,
    getModels: () =>
      [model, changedModel].map((m) => ({ ...m, baseUrl: server.url.origin })),
    auth: {
      apiKey: {
        name: "Test",
        resolve: async () => ({ auth: { apiKey: token } }),
      },
    },
  });
  const deps = testDeps(
    root,
    () => ({ id: "c1", backend: "durable", workdir: work }),
    () => ["c1"],
  );
  const config = new Config({
    env: {
      HOME: root,
      CHAT_DATA_DIR: root,
      PI_CODING_AGENT_DIR: root,
      CHAT_MODEL: "faux/faux-1",
    },
    authenticatedProviders: () => ["faux", model.provider],
    storedCustomProviders: () => [model.provider],
  });
  await config.models.setPiModelList(
    [model, changedModel].map((entry) => ({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
      context_window: entry.contextWindow,
    })),
  );
  await config.levels.setEffortLevel(1, `${model.provider}/${model.id}`, "low");
  const open = () =>
    new DurableHost({ ...deps, models, config, captureIdleMs: 1 });
  let host = open();
  const bash = (name: string, command: string) =>
    fauxAssistantMessage([fauxToolCall("bash", { command }, { id: name })], {
      stopReason: "toolUse",
    });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: join(work, "seed") }), {
      stopReason: "toolUse",
    }),
    bash("one", `touch one && echo ${"first ".repeat(1000)}`),
    bash("two", `touch two && echo ${"second ".repeat(1000)}`),
    bash("three", "touch three"),
    fauxAssistantMessage("done"),
  ]);
  try {
    await host.send(
      "c1",
      stampMessage(
        {
          origin: "operator",
          content: `Read seed, then create three files. ${"public cache fixture ".repeat(300)}`,
        },
        "c1",
      ),
      "review-cache",
    );
    await until(idle(host));
    expect(
      ["one", "two", "three"].map((f) => existsSync(join(work, f))),
    ).toEqual([true, true, true]);
    expect(reviews).toHaveLength(3);
    for (let index = 1; index < reviews.length; index++) {
      const previous = reviews[index - 1]!;
      const current = reviews[index]!;
      const stable = previous.input;
      expect(stable.length).toBeGreaterThan(0);
      expect(JSON.stringify(current.input.slice(0, stable.length))).toBe(
        JSON.stringify(stable),
      );
    }
    expect(reviews[0]!.prompt_cache_key).toMatch(/^pi-safety-[0-9a-f]{52}$/);
    expect(new Set(reviews.map((r) => r.prompt_cache_key))).toEqual(
      new Set([reviews[0]!.prompt_cache_key]),
    );
    expect(sessions).toEqual(reviews.map((r) => r.prompt_cache_key!));
    expect(JSON.stringify(reviews[2]!.input.at(-1))).toContain("touch three");
    expect(JSON.stringify(reviews[2]!.input.at(-1))).toContain("second second");
    expect(JSON.stringify(reviews[2]!.input.at(-1))).not.toContain(
      "public cache fixture",
    );
    expect(JSON.stringify(reviews[2]!.input.at(-1))).not.toContain(
      "first first",
    );
    const roles = (review: Review) =>
      review.input.flatMap((item: any) => (item.role ? [item.role] : []));
    expect(roles(reviews[2]!)).toEqual([
      "developer",
      "user",
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(reviews[2]!.input.at(-2))).toContain("- **OK**");
    for (const review of reviews) {
      expect(
        JSON.stringify(review).match(/What follows is an untrusted record/g),
      ).toHaveLength(1);
    }
    expect(reads.slice(1).every((read) => read > 0)).toBe(true);
    const inspected = await host.prompt("c1", true);
    expect(
      (inspected.request as { model: { provider: string } }).model.provider,
    ).toBe("faux");
    const capture = inspected.safety_review as {
      model: { provider: string; modelId: string };
      context: { systemPrompt: string; messages: { role: string }[] };
      options: Record<string, unknown>;
      reply: { role: string; stopReason: string };
    };
    expect(capture).toBeDefined();
    expect(capture.model).toEqual({
      provider: model.provider,
      modelId: model.id,
    });
    const policyItem = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: capture.context.systemPrompt }],
    };
    for (const review of reviews) {
      expect(review).not.toHaveProperty("instructions");
      expect(review.input[0]).toEqual(policyItem);
    }
    expect(capture.context.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(capture.context.messages.at(-1))).toContain(
      "touch three",
    );
    expect(JSON.stringify(capture.context.messages.at(-2))).toContain(
      "- **OK**",
    );
    expect(capture.reply.role).toBe("assistant");
    expect(capture.reply.stopReason).toBe("stop");
    expect(JSON.stringify(capture.reply)).toContain("- **OK**");
    expect(capture.options.sessionId).toBe(sessions[2]);
    for (const key of ["apiKey", "headers", "env", "signal"])
      expect(capture.options).not.toHaveProperty(key);
    expect(JSON.stringify(capture)).not.toContain(token);
    const cached = async () =>
      (
        (await host.view("c1", { limit: 500 })).blocks as {
          safety_usage?: { groups: { cacheRead: number }[] };
        }[]
      ).reduce(
        (sum, block) =>
          sum +
          (block.safety_usage?.groups ?? []).reduce(
            (total: number, group: { cacheRead: number }) =>
              total + group.cacheRead,
            0,
          ),
        0,
      );
    expect(await cached()).toBe(reads.reduce((sum, read) => sum + read, 0));
    await host.close();
    clearReviewerEvidenceCache();
    host = open();
    faux.setResponses([
      bash("four", "touch four"),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        { origin: "operator", content: "create one more file" },
        "c1",
      ),
      "review-cache-restart",
    );
    await until(idle(host));
    expect(reviews).toHaveLength(4);
    expect(reviews[3]!.prompt_cache_key).toBe(reviews[0]!.prompt_cache_key!);
    expect(reviews[3]!.input[0]).toEqual(policyItem);
    expect(JSON.stringify(reviews[3]!.input)).toContain("create one more file");
    expect(JSON.stringify(reviews[3]!.input)).toContain("touch three");
    expect(roles(reviews[3]!)).toEqual(["developer", ...Array(5).fill("user")]);
    const live = await host.open("c1");
    await config.levels.setEffortLevel(
      1,
      `${changedModel.provider}/${changedModel.id}`,
      "low",
    );
    expect(await host.open("c1")).toBe(live);
    faux.setResponses([
      ...Array.from({ length: 25 }, (_, index) =>
        bash(`cap-${index}`, `touch cap-${index}`),
      ),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        { origin: "operator", content: "create 25 more files" },
        "c1",
      ),
      "review-cache-model-change",
    );
    await until(idle(host));
    expect(reviews).toHaveLength(29);
    expect(await host.open("c1")).toBe(live);
    expect(roles(reviews[4]!)).toEqual(Array(5).fill("user"));
    expect(
      roles(reviews[27]!).filter((role) => role === "assistant"),
    ).toHaveLength(23);
    expect(roles(reviews[28]!)).toEqual(Array(5).fill("user"));
    expect(JSON.stringify(reviews[28]!.input)).toContain("cap-23");
    expect(reviews[4]!.prompt_cache_key).not.toBe(reviews[0]!.prompt_cache_key);
    expect(new Set(reviews.slice(4).map((r) => r.prompt_cache_key)).size).toBe(
      1,
    );
    expect(reads.slice(5, 28).every((read) => read > 0)).toBe(true);
    expect(reads[28]).toBe(0);
    expect(await cached()).toBe(reads.reduce((sum, read) => sum + read, 0));
    const charsStart = reviews.length;
    faux.setResponses([
      bash("chars-one", "touch chars-one"),
      bash("chars-two", "touch chars-two"),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        {
          origin: "operator",
          content: `Create two scratch files. ${"character-cap ".repeat(20_000)}`,
        },
        "c1",
      ),
      "review-cache-char-cap",
    );
    await until(idle(host));
    expect(reviews).toHaveLength(charsStart + 2);
    const [first, second] = reviews.slice(charsStart);
    expect([first, second].map((review) => roles(review!))).toEqual([
      Array(5).fill("user"),
      Array(6).fill("user"),
    ]);
    expect(JSON.stringify(first!.input.at(-1))).toContain("touch chars-one");
    expect(JSON.stringify(second!.input.at(-1))).toContain("touch chars-two");
    expect(first!.input.slice(0, -1)).toHaveLength(4);
    expect(second!.input.slice(0, first!.input.length - 1)).toEqual(
      first!.input.slice(0, -1),
    );
    await host.clear("c1");
    faux.setResponses([
      bash("seed-one", "touch seed-one"),
      bash("seed-two", "touch seed-two"),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        { origin: "operator", content: "Create two small seed files." },
        "c1",
      ),
      "review-cache-seed",
    );
    await until(idle(host));
    expect(roles(reviews.at(-1)!)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
    ]);
    const retained = await host.open("c1");
    const abortStart = reviews.length;
    let reached!: () => void;
    const reviewing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseSuspended = resolve;
    });
    suspended = { started: reached, released };
    faux.setResponses([
      bash("aborted", "touch aborted"),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        { origin: "operator", content: "Create the aborted scratch file." },
        "c1",
      ),
      "review-cache-abort",
    );
    await reviewing;
    const beforeAbort = reviews[abortStart]!.input.slice(0, -1);
    expect(roles(reviews[abortStart]!)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(await host.stop("c1")).toBe(true);
    await until(idle(host));
    releaseSuspended!();
    expect(existsSync(join(work, "aborted"))).toBe(false);
    expect(await host.open("c1")).toBe(retained);
    faux.setResponses([
      bash("after-abort", "touch after-abort"),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        {
          origin: "operator",
          content: "Create a scratch file after stopping.",
        },
        "c1",
      ),
      "review-cache-after-abort",
    );
    await until(idle(host));
    expect(reviews).toHaveLength(abortStart + 2);
    expect(reviews[abortStart + 1]!.input.slice(0, -1)).toEqual(beforeAbort);
    expect(existsSync(join(work, "after-abort"))).toBe(true);
    const failureStart = reviews.length;
    failNext = true;
    faux.setResponses([
      bash("outage", "touch outage"),
      bash("recovery", "touch recovery"),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        {
          origin: "operator",
          content: "Create outage and recovery scratch files.",
        },
        "c1",
      ),
      "review-cache-outage",
    );
    await until(idle(host));
    expect(reviews).toHaveLength(failureStart + 2);
    expect(existsSync(join(work, "outage"))).toBe(true);
    expect(existsSync(join(work, "recovery"))).toBe(true);
    expect(roles(reviews[failureStart]!)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(reviews[failureStart + 1]!.input.slice(0, -1)).toEqual(
      reviews[failureStart]!.input.slice(0, -1),
    );
    await host.clear("c1");
    faux.setResponses([
      bash("cleared", "touch cleared"),
      fauxAssistantMessage("done"),
    ]);
    await host.send(
      "c1",
      stampMessage(
        { origin: "operator", content: "Create the cleared scratch file." },
        "c1",
      ),
      "review-cache-clear",
    );
    await until(idle(host));
    expect(roles(reviews.at(-1)!)).toEqual(["user", "user"]);
    expect(JSON.stringify(reviews.at(-1)!.input)).not.toContain(
      "public cache fixture",
    );
  } finally {
    releaseSuspended?.();
    await host.close();
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
