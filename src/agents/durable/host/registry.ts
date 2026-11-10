// Harness extension order is hook order: guard, tools, hooks, side fork.
// Safety review is always installed; RTK rewrites only after approval.
// Prompts snapshot per request; wrappers shorten help, not Pi tool behavior.
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
} from "@earendil-works/chord/context";
import type { Conversation, Registry } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import type { DurableHost } from "../host.ts";
import type { RequestCaptures } from "../request_capture.ts";
import { BUILD_DIR } from "../../../build_dir.ts";
import { MCP_FILE_NAME } from "../../../mcp_config.ts";
import { WARNING } from "../../../observability/runtime_logging";
import { startSlowSpan } from "../../../observability/slow_span";
import { modelRef } from "../model_selection";
import type { Opening } from "./open.ts";
import type { Runtime } from "./load.ts";

const FILE_DESCRIPTIONS: Record<string, string> = {
  read: "Read text or jpg/png/gif/webp/bmp images (attached). Text is capped at 2,000 lines/50KB; use offset/limit and continue until complete.",
  write:
    "Write a file, overwriting existing content; creates parent directories.",
  edit: "Replace exact, unique, non-overlapping original-file text (not incrementally). Merge overlapping/nearby changes; omit large unchanged spans.",
};

const CODEMODE_DESCRIPTION =
  "Run raw JavaScript (no JSON/fences) as a restart-resumable async function body in QuickJS; await/return work. No Node, filesystem, network or timers.\n" +
  "await tools.name(args) returns a string or declared object. Thrown errors reject; object-returning tools may report failure in fields—check them. Pending calls are cancelled on script end; completed calls are not replayed after restart.\n" +
  'Optional first line: // @options: {"max_output_tokens":10000,"timeout_ms":60000}\n' +
  "Output via text(value), image(dataUrlOrImageBlock), console.log(...) or return; exit() stops. Images also report a saved temporary path.\n" +
  "store(key,value)/load(key) persist JSON across calls. Native tools use the same arguments. Discover others with ALL_TOOLS, searchTools(query,{limit?,namespace?}), describeTool(name), describeNamespace(name).";

/** Pi context retention; idle Harnesses and captures are evicted after it. */
export const CONTEXT_RETENTION_MS = 600_000;

export interface Tools {
  registry: Registry;
  context: ReturnType<Runtime["createContext"]>;
  shells: ReturnType<Runtime["createShells"]>;
  shellState: ReturnType<DurableHost["shellState"]>;
  search: Awaited<ReturnType<Runtime["createFff"]>>;
  mcp: InstanceType<Runtime["McpServers"]>;
  sandbox: InstanceType<Runtime["CodemodeSandbox"]>;
  captures: RequestCaptures;
  warmer: ReturnType<Runtime["createCacheWarm"]>;
  /** Model-bound copies of messages: the clock, then Codex replay cleanup. */
  transforms: ReturnType<Runtime["createModelClock"]>;
  /** The cwd and tool environment of the conversation's next tool call. */
  scope(): Promise<{ cwd: string; env: Record<string, string> }>;
  /** Close the shells, search, codemode workers and MCP servers. */
  release(shellStop?: Promise<void>): Promise<void>;
}

/** Log a failure as `event`, with the conversation and the error's message. */
export const failureLog =
  (host: DurableHost, cid: string) => (event: string) => (error: unknown) =>
    host.deps.log(event, {
      cid,
      error: error instanceof Error ? error.message : String(error),
    });

/** The conversation that owns Durable conversation `id`: a side's or main. */
const owner = (target: Opening, id: Conversation["id"] | undefined) =>
  (id === undefined ? undefined : target.owners.get(String(id))) ?? target.cid;

/** Install the side guard and the conversation's tools; open its search,
 * MCP servers, codemode sandbox and request captures. */
export async function installTools(
  host: DurableHost,
  rt: Runtime,
  target: Opening,
  yieldToFocus: () => Promise<void>,
  phase: (name: string) => void,
): Promise<Tools> {
  const { cid, conv, cwd, path, env: baseEnv } = target;
  const report = failureLog(host, cid);
  const scope = async () => {
    const conversation = target.conversation!;
    const agent = await conversation.agent(context);
    const overrides = (
      await target.harness!.snapshot(
        rt.EnvironmentDoc,
        conversation.id,
        context,
      )
    )?.overrides;
    const effectiveCwd = agent.cwd ?? cwd;
    return {
      cwd: effectiveCwd,
      env: {
        ...rt.scopedEnvironment(baseEnv, overrides),

        RECURSE_AGENT_ID: cid,
        RECURSE_COLLECTION_DIR: host.collection(cid, baseEnv),
        RECURSE_WORKDIR: effectiveCwd,
      },
    };
  };
  // Invariant: Each Harness owns its Registry; safety hooks resolve their
  // conversation only from the Harness where the extension is installed.
  const registry = rt.createRegistry();
  registry.install(rt.sideGuard((id) => owner(target, id) !== cid));
  const fileTools = [
    rt.createReadTool({ images: await host.imageService() }),
    rt.createWriteTool(),
    rt.createEditTool(),
  ];
  registry.install(
    rt.defineExtension({
      name: "recurse-file-tools",
      tools: fileTools,
      wraps: fileTools.map((tool) =>
        rt.wrapTool(tool, (inner) => ({
          ...inner,
          description: FILE_DESCRIPTIONS[inner.name] ?? inner.description,
        })),
      ),
    }),
  );
  const transforms = rt.createModelClock({
    after: [rt.codexReplay],
    now: host.deps.wallClock,
  });
  const settingsConfig =
    host.deps.config ??
    rt.createConfig({
      env: { ...process.env, CHAT_DATA_DIR: host.deps.dataDir },
    });
  const contextExtension = rt.createContext({
    models: target.models,
    maximumContextWindow: () => host.deps.maximumContextWindow?.() ?? Infinity,
    currentModel: () =>
      modelRef(
        host.deps.settings(
          host.deps.load(cid, ["side_of", "level", "model", "effort"]) ?? conv,
        )[0],
      ),
    conversation: (id) => {
      const found = target.followed.get(String(id));
      return host.closing || host.deleting(cid) || found === undefined
        ? null
        : { harness: target.harness!, conversation: found };
    },
    report: (event, error) => report(event)(error),
    providerCompaction: (messages, agent, api, ctx) =>
      rt.requestCodexCompaction(
        target.models,
        // Invariant: keep request order without changing clock state.
        (m) =>
          transforms.transform(rt.systemBeforeUser(m), "openai-codex", true),
        messages,
        agent,
        api,
        ctx,
        target.followed.get(String(api.conversationId)) ?? target.conversation!,
      ),
  });
  for (const extension of contextExtension.extensions)
    registry.install(extension);
  const shellState = host.shellState(cid);
  const shells = rt.createShells({
    ...shellState,
    scope: async () => ({
      key: cid,
      ...(await scope()),
      config: { logDir: join(baseEnv.TMPDIR || tmpdir(), "pi-bg-shell") },
    }),
    report: report("durable_shell_report"),
  });
  registry.install(shells.extension);
  registry.install(
    rt.managedTools(
      (cwd, signal) =>
        host.deps.claimWorkdir?.(cid, cwd, signal) ?? Promise.resolve(),
      (change) => host.changeEnvironment(cid, change),
    ),
  );
  registry.install(rt.createPublish(host.collection(cid, baseEnv), cid));
  registry.install(
    rt.createArtifact(
      {
        artifactsDir:
          host.deps.config?.paths.ARTIFACTS_DIR ??
          join(host.deps.dataDir, "artifact_repos"),
        trashDir: host.deps.trashDir,
      },
      cid,
    ),
  );
  const remotes = host.remoteSettings;
  registry.install(
    rt.createSettings(
      host.deps.config ??
        rt.createConfig({
          env: { ...process.env, CHAT_DATA_DIR: host.deps.dataDir },
        }),
      (id) => host.deps.load(id, ["id", "parent", "side_of"]),
      host.deps.sidebarScript && { script: host.deps.sidebarScript, by: cid },
      remotes && {
        request: (label, url) => remotes.request(label, url, cid),
        list: () =>
          remotes.listForAgents((id) => {
            const row = host.deps.load(id, ["id", "title"]);
            return row ? String(row.title ?? id) : undefined;
          }),
      },
    ),
  );
  await yieldToFocus();
  const search = await rt.createFff({
    worker: host.searchService(rt.FffWorker),
    cwd,
    owner: cid,
    flags: {
      "fff-frecency-db": join(path, "..", "search-frecency"),
      "fff-history-db": join(path, "..", "search-history"),
    },
  });
  phase("search");
  const mcp = new rt.McpServers({
    configPath: join(host.deps.piAgentDir, MCP_FILE_NAME),
    scope,
    own: (proc) => host.deps.ownProcess(proc, cid),
    release: (proc) => host.deps.releaseProcess(proc),
    report: report("durable_mcp_report"),
    status: (server, state, reason) =>
      host.deps.log("durable_mcp_status", { cid, server, state, reason }),
    providerToken: (provider) => host.providerToken(provider),
  });
  const workers = new Set<Promise<void>>();
  let finishWorkerStart: (() => void) | undefined;
  const sandbox = new rt.CodemodeSandbox({
    memoryLimitBytes: 256 * 1024 * 1024,
    acquireWorker: () => {
      // Invariant: Pi brackets Worker setup synchronously after loading Wasm.
      const finish = startSlowSpan("codemode_worker_create", cid);
      finishWorkerStart = finish;
      return finish;
    },
    onWorkerStarted: (exited) => {
      finishWorkerStart?.();
      finishWorkerStart = undefined;
      workers.add(exited);
      void exited.then(() => workers.delete(exited));
    },
  });
  const warmer = rt.createCacheWarm({
    models: () => target.requestModels!,
    enabled: () => settingsConfig.keepPromptCacheWarm(),
    busy: (id) => host.cacheWarmBusy(id),
    current: (id, model) => {
      const record = host.deps.load(id);
      if (host.closing || host.deleting(id) || !record) return false;
      const ref = modelRef(host.deps.settings(record)[0]);
      return ref.provider === model.provider && ref.modelId === model.id;
    },
    owner: (id) => owner(target, id),
    conversationId: (cid) => {
      for (const conversation of target.followed.values())
        if (owner(target, conversation.id) === cid) return conversation.id;
      return undefined;
    },
    conversation: async (id) =>
      target.followed.get(String(id)) ??
      (await target.harness!.conversation(id, context))!,
    clock: host.deps.warmingClock,
    changed: (id) => host.viewChanged(id),
    report: report("durable_cache_warm_failed"),
  });
  host.cacheWarmers.add(warmer);
  registry.install(warmer.extension);
  const captures = new rt.RequestCaptures(
    (sessionId) => target.sessions.get(sessionId) ?? cid,
    {
      // Invariant: A side conversation has no durable directory of its own;
      // its capture file lives in its parent's, which a clear retires.
      path: (id) =>
        join(
          path,
          "..",
          id === cid ? "last-request.json" : `last-request-${id}.json`,
        ),
      idleMs: host.deps.captureIdleMs ?? CONTEXT_RETENTION_MS,
      failed: (id, error) =>
        host.deps.log(
          "durable_capture_write_failed",
          { cid: id, error: String(error) },
          WARNING,
        ),
    },
    (id, capture, model, requestContext, requestOptions) =>
      warmer.capture(id, capture, model, requestContext, requestOptions),
    host.captureWorker,
  );
  return {
    registry,
    context: contextExtension,
    shells,
    shellState,
    search,
    mcp,
    sandbox,
    captures,
    warmer,
    transforms,
    scope,
    release: async (shellStop) => {
      warmer.close();
      host.cacheWarmers.delete(warmer);
      await (shellStop ?? shells.shutdown());
      await search.close();
      await sandbox.close();
      await Promise.all(workers);
      if (!(await mcp.close()))
        throw new Error("MCP server process groups survived");
    },
  };
}

/** Install the hooks around requests and tool calls: search, safety review,
 * codemode, RTK, prompt sections, request transforms, Codex compaction items,
 * reply times, refusals and, unselected except by side forks, the side
 * extension. */
export function installHooks(
  host: DurableHost,
  rt: Runtime,
  target: Opening,
  tools: Tools,
) {
  const { cid, conv, cwd, env: baseEnv } = target;
  const { registry, mcp, sandbox, scope } = tools;
  const trusted = Object.freeze({
    modelPolicy: baseEnv.RECURSE_MODEL_POLICY,
    workspaceRoot: baseEnv.RECURSE_WORKSPACE_ROOT,
    worktreesRoot: baseEnv.RECURSE_WORKTREES_ROOT,
    tempRoot: baseEnv.RECURSE_AGENT_TMPDIR,
    home: baseEnv.HOME,
    dataDir: host.deps.dataDir,
    statsRoot: baseEnv.RECURSE_SAFETY_DIR,
  });
  const mcpServers = new Map<string, string>();
  const review = rt.createDurableSafety({
    mcpServer: (name) => mcpServers.get(name),
    models: target.models,
    configDir: host.deps.piAgentDir,
    trusted: () => trusted,
    shells: () => host.shells(cid).items,
    agent: async (api?: { conversationId: Conversation["id"] }) => {
      const id = owner(target, api?.conversationId);
      const title = (host.deps.load(id, ["title"]) ?? conv).title;
      return {
        id,
        title: typeof title === "string" ? title : undefined,
        ...(await scope()),
        conversation:
          target.followed.get(String(api?.conversationId)) ??
          target.conversation!,
        stopRun: () => void host.stop(id),
      };
    },
  });
  const namespaces: CodemodeNamespace[] = [];
  const readyMcp = async (code?: string) => {
    const tools = await mcp.tools(code);
    mcpServers.clear();
    for (const tool of tools) mcpServers.set(tool.name, tool.server);
    registry.install(rt.defineExtension({ name: "recurse-mcp", tools }));
    namespaces.splice(
      0,
      namespaces.length,
      ...tools.flatMap((tool) =>
        tool.namespace ? [{ ...tool.namespace, prefix: tool.name }] : [],
      ),
    );
  };
  const codemode = {
    extensions: [
      rt.createCodemodeExtension({ sandbox, namespaces, models: false }),
      rt.defineExtension({
        name: "recurse-codemode",
        wraps: [
          rt.wrapSection("codemode", (inner) => ({
            ...inner,
            render: (input) => {
              // Invariant: name model-callable deferred tools (Pi's
              // agent.deferred); mcp_servers names on-demand MCP servers.
              const scripts = input.agent.callable.filter(
                (tool) =>
                  (!tool.deferred || input.agent.deferred.includes(tool)) &&
                  !input.agent.tools.some(
                    (native) => native.name === tool.name,
                  ),
              );
              return scripts.length
                ? `Other tools scripts can call: ${scripts.map((tool) => tool.name).join(", ")}. Use describeTool for arguments.`
                : undefined;
            },
          })),
          rt.wrapTool(
            rt.createCodemodeTool({ sandbox, models: false }),
            (inner) => ({
              ...inner,
              description: CODEMODE_DESCRIPTION,
              // Invariant: Pi caches the agent across beforeTool/execute.
              // Resolve hook-installed tools afresh (codemode.js:215).
              execute: async (args, api, ctx) =>
                inner.execute(
                  args,
                  {
                    ...api,
                    agent: async (readContext) =>
                      (await target.harness!.conversation(
                        api.conversationId,
                        readContext,
                      ))!.agent(readContext),
                  },
                  ctx,
                ),
            }),
          ),
        ],
        hooks: [
          rt.hook(rt.ToolTask, {
            beforeTool: async (call, _api, ctx) => {
              if (call.name === "codemode" && !call.parent)
                await awaitWithContext(
                  readyMcp(String(call.arguments.code ?? "")),
                  ctx,
                );
              return undefined;
            },
            afterTool: async (call, result) => {
              if (call.name !== "codemode" || call.parent) return;
              const unavailable = await mcp.unavailable();
              if (unavailable)
                return {
                  ...result,
                  output: [
                    ...(result.output ?? []),
                    { type: "text", text: `\n${unavailable}` },
                  ],
                };
              return undefined;
            },
          }),
        ],
      }),
    ],
  };
  const codex = rt.createCodex({ models: tools.context.models });
  const { transforms } = tools;
  const prompt = rt.createPromptExtension(
    async (input) => ({
      ...(await host.deps.promptSnapshot(
        host.deps.load(owner(target, input.conversationId)) ?? conv,
        input.env?.cwd ?? input.agent.cwd ?? cwd,
      )),
      mcp_servers: await mcp.section(),
    }),
    cid,
  );
  const byId = async (id: Conversation["id"]) =>
    target.followed.get(String(id)) ??
    (await target.harness!.conversation(id, context)) ??
    target.conversation!;
  registry.install(rt.refusalsExtension(byId));
  for (const extra of [
    tools.search,
    { extensions: [review] },
    codemode,
    rt.createRtk({ scope, buildDir: BUILD_DIR }),
    { extensions: [prompt] },
    transforms,
  ])
    for (const extension of extra.extensions) registry.install(extension);
  registry.install(
    rt.createCodexCheckpoints({
      models: target.models,
      conversation: (_ctx, id) => byId(id),
      report: (event, error) => failureLog(host, cid)(event)(error),
    }),
  );
  registry.install(rt.replyTimesExtension(byId));
  const side = rt.sideExtension(
    async (id, message) => {
      const sent = await host.deps.returnToMain?.(owner(target, id), message);
      if (!sent)
        throw new Error("the main conversation did not accept the message");
      return sent;
    },
    (id) => owner(target, id) !== cid,
  );
  registry.install(side);
  return { side, transforms, models: codex.models, readyMcp };
}
