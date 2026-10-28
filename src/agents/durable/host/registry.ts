// The extensions installed in a conversation's Harness Registry, in order.
// Install order is hook order: the side guard first, then tools, then hooks
// around requests and tool calls, the side fork last. Safety review is always
// installed; RTK rewrites only after approval; prompts snapshot per request.
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
import { modelRef } from "../model_selection";
import type { Opening } from "./open.ts";
import type { Runtime } from "./load.ts";

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
  registry.install(
    rt.defineExtension({
      name: "recurse-file-tools",
      tools: [
        rt.createReadTool({ images: await host.imageService() }),
        rt.createWriteTool(),
        rt.createEditTool(),
      ],
    }),
  );
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
  registry.install(
    rt.createSettings(
      host.deps.config ??
        rt.createConfig({
          env: { ...process.env, CHAT_DATA_DIR: host.deps.dataDir },
        }),
      (id) => host.deps.load(id, ["id", "parent", "side_of"]),
    ),
  );
  await yieldToFocus();
  const search = await rt.createFff({
    worker: host.searchService(rt.FffWorker),
    cwd,
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
  const sandbox = new rt.CodemodeSandbox({
    memoryLimitBytes: 256 * 1024 * 1024,
    onWorkerStarted: (exited) => {
      workers.add(exited);
      void exited.then(() => workers.delete(exited));
    },
  });
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
    scope,
    release: async (shellStop) => {
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
 * codemode, RTK, prompt sections, request transforms, reply times, refusals
 * and, unselected except by side forks, the side extension. */
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
          rt.wrapTool(
            rt.createCodemodeTool({ sandbox, models: false }),
            (inner) => ({
              ...inner,
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
  const transforms = rt.createModelClock({
    after: [codex.replay],
    now: host.deps.wallClock,
  });
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
  for (const extra of [
    tools.search,
    { extensions: [review] },
    codemode,
    rt.createRtk({ scope, buildDir: BUILD_DIR }),
    { extensions: [prompt] },
    transforms,
  ])
    for (const extension of extra.extensions) registry.install(extension);
  const byId = async (id: Conversation["id"]) =>
    target.followed.get(String(id)) ??
    (await target.harness!.conversation(id, context)) ??
    target.conversation!;
  registry.install(rt.replyTimesExtension(byId));
  registry.install(rt.refusalsExtension(byId));
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
