import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WARNING } from "../../../../src/observability/runtime_logging";
import { join } from "node:path";
import {
  createModels,
  createFauxCore,
  createProvider,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DurableHost } from "../../../../src/agents/durable/host";
import { EnvironmentDoc } from "../../../../src/extensions/core/environment/managed_tools";
import { testDeps } from "../../../backend/fixtures/durable_host/host";
const safety = await import(
  new URL("../../../../src/extensions/core/safety/durable.ts", import.meta.url)
    .href
);
const { loadTrustedPathScope, allowedByPathScope } = await import(
  new URL(
    "../../../../src/extensions/core/safety/path-scope.ts",
    import.meta.url,
  ).href
);
const { loadTrustedModelPolicy } = await import(
  new URL(
    "../../../../src/extensions/core/safety/model-policy.ts",
    import.meta.url,
  ).href
);
const { effectiveEnv } = await import(
  new URL(
    "../../../../src/extensions/core/safety/path-expansion.ts",
    import.meta.url,
  ).href
);

const poison = {
  RECURSE_AGENT_ID: "other-agent",
  RECURSE_MODEL_POLICY: "attacker-policy",
  RECURSE_WORKSPACE_ROOT: "/",
  RECURSE_WORKTREES_ROOT: "/",
  PI_CODING_AGENT_DIR: "/attacker",
  CHAT_DATA_DIR: "/attacker",
  RECURSE_WORKDIR: "/attacker",
};

test("host imports legacy env.sh with logged protected-name drops", async () => {
  const root = await mkdtemp(join(tmpdir(), "env-import-trust-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const session = join(root, "legacy.jsonl");
  await writeFile(
    session,
    JSON.stringify({
      type: "session",
      version: 3,
      id: "legacy",
      cwd: root,
      timestamp: "",
    }) + "\n",
  );
  const conv = {
    id: "c1",
    session_id: "legacy",
    session_file: session,
    workdir: root,
    backend: "durable",
  };
  const deps = testDeps(
    root,
    () => conv,
    () => ["c1"],
  );
  const logs: {
    event: string;
    fields: Record<string, unknown>;
    level?: number;
  }[] = [];
  const host = new DurableHost({
    ...deps,
    models,
    log: (event, fields, level) => {
      logs.push({ event, fields, level });
    },
  });
  try {
    const env = await deps.agentEnv();
    await writeFile(
      env.RECURSE_AGENT_ENV_FILE,
      Object.entries({ ...poison, NORMAL: "kept" })
        .map(([name, value]) => `export ${name}='${value}'\n`)
        .join(""),
      { mode: 0o600 },
    );
    const scope = loadTrustedPathScope({
      ...env,
      RECURSE_WORKSPACE_ROOT: root,
    });
    expect(
      allowedByPathScope(
        "write",
        { path: env.RECURSE_AGENT_ENV_FILE },
        root,
        scope,
      ),
    ).toBe(true);
    expect(
      (
        await host.importPi(
          conv,
          { state: () => ({ running: false, queued: 0 }) },
          new AbortController().signal,
        )
      ).status,
    ).toBe("imported");
    const opened = await host.open("c1");
    expect(
      (
        await opened.harness.snapshot(
          EnvironmentDoc,
          opened.conversation.id,
          context,
        )
      )?.overrides,
    ).toEqual({ NORMAL: "kept" });
    const dropped = logs.find(
      (item) => item.event === "pi_import_environment_dropped",
    );
    expect(dropped?.fields.names).toEqual(Object.keys(poison));
    expect(dropped?.level).toBe(WARNING);
    expect(JSON.stringify(dropped)).not.toContain("attacker-policy");
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real host tools and safety retain trusted scope even with a poisoned stored document", async () => {
  const root = await mkdtemp(join(tmpdir(), "env-scope-trust-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await mkdir(join(root, "state"));
  await mkdir(join(root, "attacker-state"));
  const faux = createFauxCore({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(
    createProvider({
      id: faux.provider,
      auth: {
        apiKey: {
          name: "Test",
          resolve: async () => ({ auth: { apiKey: "fixture" } }),
        },
      },
      models: faux.models,
      api: { stream: faux.stream, streamSimple: faux.streamSimple },
    }),
  );
  const conv = { id: "c1", backend: "durable", workdir: workspace };
  const deps = testDeps(
    root,
    () => conv,
    () => ["c1"],
  );
  const trusted = {
    ...(await deps.agentEnv()),
    RECURSE_WORKSPACE_ROOT: workspace,
    RECURSE_MODEL_POLICY: JSON.stringify({
      version: 1,
      active: { provider: "faux", model: "faux-1" },
      reviewer: { provider: "faux", model: "faux-1", effort: "high" },
      summary: { provider: "faux", model: "faux-1", effort: "high" },
    }),
    PI_CODING_AGENT_DIR: root,
    RECURSE_WORKTREES_ROOT: workspace,
    RECURSE_SAFETY_DIR: join(root, "stats"),
    HOME: root,
    CHAT_DATA_DIR: join(root, "state"),
  };
  let seen: NodeJS.ProcessEnv | undefined;
  let shellOutput = "";
  let baselineDenied = false;
  let safetyOptions: any;
  const original = safety.createDurableSafety;
  // test-check-allow: T3 Real safety factory; observes the real agent's env.
  const observer = spyOn(safety, "createDurableSafety").mockImplementation(
    (options: any) => {
      safetyOptions = options;
      return original({
        ...options,
        agent: async (...args: any[]) => {
          const agent = await options.agent(...args);
          seen = agent.env;
          return agent;
        },
      });
    },
  );
  const host = new DurableHost({
    ...deps,
    models,
    dataDir: trusted.CHAT_DATA_DIR,
    agentEnv: async () => trusted,
  });
  try {
    const opened = await host.open("c1");
    const before = { ...safetyOptions.trusted() };
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "write",
            {
              path: join(root, "state", "denied.txt"),
              content: "must not run",
            },
            { id: "baseline-write" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("DENY: fixture protected target"),
      (request) => {
        baselineDenied = request.messages.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "baseline-write" &&
            JSON.stringify(message.content).includes("Tool call blocked"),
        );
        return fauxAssistantMessage("done");
      },
    ]);
    await host.send("c1", "exercise baseline", "baseline");
    await opened.conversation.waitForIdle(context);
    expect(baselineDenied).toBe(true);
    await opened.conversation.configure(
      {
        modelTools: {
          add: [
            (await opened.conversation.agent(context)).callable.find(
              (tool) => tool.name === "recurse_settings",
            )!,
          ],
        },
      },
      context,
    );
    await writeFile(join(workspace, "report.txt"), "private report");
    const nativeCalls = [
      { name: "publish", args: { paths: ["report.txt"] } },
      {
        name: "env",
        args: { action: "set", name: "DENIED_NATIVE", value: "secret" },
      },
      {
        name: "recurse_settings",
        args: { action: "select_theme", name: "Nord" },
      },
    ];
    const deniedNative: any[] = [];
    let themesView: any;
    for (const [index, call] of nativeCalls.entries()) {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall(call.name, call.args as never, {
            id: `native-${index}`,
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          "DENY: fixture operator did not request this change",
        ),
        (request) => {
          deniedNative.push(
            request.messages.find(
              (message) =>
                message.role === "toolResult" &&
                message.toolCallId === `native-${index}`,
            ),
          );
          return fauxAssistantMessage(
            fauxToolCall(
              "recurse_settings",
              { action: "themes" },
              { id: "settings-view" },
            ),
            { stopReason: "toolUse" },
          );
        },
        (request) => {
          themesView = request.messages.at(-1);
          return fauxAssistantMessage("done");
        },
      ]);
      await host.send(
        "c1",
        "view themes, without changing anything",
        `native-safety-${index}`,
      );
      await opened.conversation.waitForIdle(context);
    }
    expect(deniedNative).toHaveLength(3);
    expect(
      deniedNative.every((result) =>
        JSON.stringify(result.content).includes("Tool call blocked"),
      ),
    ).toBe(true);
    expect(themesView.toolCallId).toBe("settings-view");
    expect(themesView.isError).not.toBe(true);
    expect(JSON.parse(themesView.content[0].text).theme).toBe("Material Dark");
    expect(await host.changeEnvironment("c1", { set: {}, unset: [] })).toEqual({
      names: [],
      absent: [],
    });
    const deniedRows = ((await host.view("c1")).blocks as any[]).filter(
      (row) => row.name === "publish",
    );
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0].files ?? []).toEqual([]);
    await opened.conversation.commit(async (tx) => {
      (await tx.doc(EnvironmentDoc, opened.conversation.id)).overrides = {
        ...poison,
        CHAT_DATA_DIR: join(root, "attacker-state"),
        RECURSE_AGENT_TMPDIR: "/",
        RECURSE_SAFETY_DIR: "/attacker",
        HOME: "/attacker",
        NORMAL: "stored",
      };
    }, context);
    await writeFile(
      trusted.RECURSE_AGENT_ENV_FILE,
      "export NORMAL='legacy-runtime'\nexport RECURSE_WORKSPACE_ROOT='/'\n",
      { mode: 0o600 },
    );
    expect((await effectiveEnv(trusted)).NORMAL).toBe("legacy-runtime");
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("write", {
            path: join(workspace, "result.txt"),
            content: "safe",
          }),
          fauxToolCall(
            "write",
            {
              path: join(root, "state", "denied.txt"),
              content: "must not run",
            },
            { id: "denied-write" },
          ),
          fauxToolCall(
            "bash",
            {
              command:
                'printf "%s:%s:%s" "$RECURSE_AGENT_ID" "$RECURSE_WORKDIR" "$NORMAL"',
            },
            { id: "scope-shell" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      ...Array.from(
        { length: 2 },
        () => (request: any) =>
          fauxAssistantMessage(
            JSON.stringify(request.messages.at(-1))
              .split(">>> PROPOSED ACTION START")[1]
              ?.includes("denied.txt")
              ? "DENY: fixture protected target"
              : "OK",
          ),
      ),
      (request) => {
        expect(
          request.messages.some(
            (message) =>
              message.role === "toolResult" &&
              message.toolCallId === "denied-write" &&
              JSON.stringify(message.content).includes("Tool call blocked"),
          ),
        ).toBe(true);
        const result = request.messages.find(
          (message) =>
            message.role === "toolResult" &&
            message.toolCallId === "scope-shell",
        );
        if (result?.role === "toolResult")
          shellOutput = result.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("");
        return fauxAssistantMessage([fauxText("done")]);
      },
    ]);
    await host.send("c1", "exercise scope", "scope");
    await opened.conversation.waitForIdle(context);
    expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("safe");
    expect(shellOutput).toContain(`c1:${workspace}:legacy-runtime`);
    expect(seen?.NORMAL).toBe("stored");
    expect(seen?.HOME).toBe("/attacker");
    expect(safetyOptions.trusted()).toEqual(before);
    expect(before).toEqual({
      modelPolicy: trusted.RECURSE_MODEL_POLICY,
      workspaceRoot: workspace,
      worktreesRoot: workspace,
      tempRoot: trusted.RECURSE_AGENT_TMPDIR,
      home: root,
      dataDir: trusted.CHAT_DATA_DIR,
      statsRoot: trusted.RECURSE_SAFETY_DIR,
    });
    expect(await Bun.file(join(root, "state", "denied.txt")).exists()).toBe(
      false,
    );
    const scope = loadTrustedPathScope(seen);
    expect(
      allowedByPathScope(
        "write",
        { path: "/etc/recurse-environment-trust-target" },
        workspace,
        scope,
      ),
    ).toBe(false);
    expect((await safetyOptions.agent()).id).toBe("c1");
    expect(seen?.RECURSE_MODEL_POLICY).toBe(trusted.RECURSE_MODEL_POLICY);
    expect(loadTrustedModelPolicy(seen)).toEqual({
      status: "valid",
      policy: JSON.parse(trusted.RECURSE_MODEL_POLICY),
    });
    expect(seen?.RECURSE_WORKDIR).toBe(workspace);
    expect(seen?.PI_CODING_AGENT_DIR).toBe(root);
    expect(seen?.CHAT_DATA_DIR).toBe(join(root, "state"));
    expect(scope?.workspace).toBe(workspace);
    expect(scope?.worktrees).toBe(workspace);
    expect(
      allowedByPathScope(
        "write",
        { path: trusted.RECURSE_AGENT_ENV_FILE },
        workspace,
        scope,
      ),
    ).toBe(true);
  } finally {
    observer.mockRestore();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
