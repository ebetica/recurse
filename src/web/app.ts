// Compose Config/instance/routes/auth without listening or starting work.
// Gate mutations/tree/views until projection readiness (503/retry).
// Runtime shutdown runs beside HTTP drain; maintenance is best-effort.
// See README.md for the separate Tailscale Serve login listener.

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { buildInstance, type Instance } from "../agents/instance";
import { activeRunId } from "../agents/conversation_store";
import { fenced, cleanupRetiredToolDetails } from "../agents/mutation_guard";
import * as artifacts from "../artifacts";
import { ArtifactRevisions } from "../artifacts/revisions";
import { MuseAuth } from "../auth/muse";
import { HTTP_TIMEOUT_MS, USER_AGENT } from "../auth/oauth";
import { ProviderSnapshot } from "../auth/provider_snapshot";
import { BackendKeys } from "../auth/backend_keys";
import { registerBackendKeyRoutes } from "./backend_keys";
import { ServiceAuth } from "../auth/service";
import { OperatorAuth } from "../auth/session";
import { CHECKOUT_ROOT } from "../build_dir";
import { piAgentDir, resolveRoots, preparePiAgentDir } from "../local_roots";
import { Config, SETTINGS_RECHECK_MS } from "../config";
import { prepareGitIdentity } from "../git_identity";
import {
  ERROR,
  INFO,
  WARNING,
  formatRecord,
  logEvent,
  logException,
  logger,
  RotatingFileSink,
  type LogSink,
  type RuntimeLogRecord,
} from "../observability/runtime_logging";
import {
  composeApp,
  startServer,
  tailscaleSocket,
  type RunningServer,
} from "../server";
import { LoopLag } from "../observability/loop_lag";
import * as startupMetrics from "../observability/startup_metrics";
import { readRelease } from "../release";
import { RecurseUpdates } from "../recurse_update";
import { retireDetached } from "../tool_details";
import { registerSideRoutes } from "./side_conversations";
import { CreateSlots, registerConversationRoutes } from "./conversations";
import {
  finishArtifactDeletion,
  registerFileRoutes,
  type FilesRoutesDeps,
} from "./files";
import { registerLoginRoutes } from "./login";
import { registerUiTiming } from "./ui_timing";
import {
  LoginThrottle,
  loopbackAuthenticated,
  publishLoopbackToken,
  requestAuth,
} from "./request_auth";
import { HttpError, Router, type Handler } from "./router";
import { registerSettingsRoutes } from "./settings";
import { registerNotificationRoutes } from "./notifications";
import { registerSettingsSyncRoutes } from "./settings_sync";
import { ConnectedBackends } from "../backends/connected";
import { registerBackendRoutes } from "./backends";
import { registerBackendProxy } from "./backend_proxy";
import { registerRelayRoutes } from "./relay";
import { listPiModels, PiModelUpdater } from "../pi_model_list";
import { displayCommand } from "../pi_bg_shell";
import {
  FrontendCache,
  fillIconSlots,
  frontendGeneration,
  registerStaticRoutes,
} from "./static";
import {
  defaultTokenHex,
  deliverStop,
  withDurableStop,
  registerTreeRoutes,
  StopDiagnosticBuckets,
  type DeliverStopDeps,
} from "./tree";

type Env = Record<string, string | undefined>;

/** Records at WARNING and above to stderr; everything to the file once set. */
export class WebLogSink implements LogSink {
  file: RotatingFileSink | null = null;
  constructor(
    private readonly stderr: (line: string) => void = (line) =>
      process.stderr.write(line),
  ) {}
  write(record: RuntimeLogRecord): void {
    this.file?.write(record);
    if (record.level >= WARNING) this.stderr(`${formatRecord(record)}\n`);
  }
  /** runtime_logging.configure_persisted_logging; idempotent. */
  async persist(dataDir: string): Promise<string> {
    const path = join(dataDir, "logs", "recurse.log");
    this.file ??= await RotatingFileSink.open(path);
    return path;
  }
}

export interface AppOptions {
  /** The process environment. */
  readonly env: Env;
  /** Where web/index.html and web/dist live (default the checkout). */
  readonly sourceRoot?: string;
  readonly sink?: WebLogSink;
}

export interface App {
  readonly instance: Instance;
  readonly router: Router;
  readonly handler: Handler;
  readonly sink: WebLogSink;
  /** Run the startup steps, listen, then launch the detached steps. */
  serve(options: {
    host?: string;
    port?: number;
    installSignals?: boolean;
  }): Promise<RunningServer>;
  /** The detached post-listen chain, for tests (settles when it finishes). */
  readonly detached: Promise<void>[];
}

type Mutate = <T>(
  work: () => Promise<T>,
  rollback?: () => Promise<void>,
) => Promise<T>;

export async function buildApp(options: AppOptions): Promise<App> {
  const sink = options.sink ?? new WebLogSink();
  let snapshot: ProviderSnapshot | null = null;
  const config = new Config({
    env: options.env,
    authenticatedProviders: () => snapshot?.authenticatedProviders() ?? [],
    storedCustomProviders: () => snapshot?.storedCustomProviders() ?? [],
    settingsRecheckMs: SETTINGS_RECHECK_MS,
  });
  const paths = config.paths;
  const instance = await buildInstance({
    config,
    sink,
  });
  const muse = new MuseAuth({
    store: instance.oauth,
    config,
    env: options.env,
    userAgent: USER_AGENT,
    timeoutMs: HTTP_TIMEOUT_MS,
  });
  snapshot = new ProviderSnapshot({
    anthropic: instance.anthropic,
    codex: instance.codex,
    muse,
    openrouter: instance.openrouter,
    customProviderNames: () => Object.keys(config.customModelProviders()),
    storedApiKey: (provider) => instance.oauth.storedApiKey(provider),
  });
  await snapshot.refresh();

  const web = logger("web", sink);
  const { lease, conversations, lifecycle, nodes, reads, delivery } = instance;
  const mutate: Mutate = (work, rollback) =>
    lease.mutateExternalStorage(work, [], rollback ? { rollback } : {});

  const requireActionReady = (): void => {
    if (lifecycle.importFinal === false || !conversations.projectionReady())
      throw new HttpError(503, "service_storage_unavailable", {
        "retry-after": "2",
      });
  };

  const sourceRoot = options.sourceRoot ?? CHECKOUT_ROOT;
  const htmlPath = join(sourceRoot, "web/index.html");
  const iconsPath = join(sourceRoot, "web", "icons.ts");
  const htmlTemplate = await fillIconSlots(
    await readFile(htmlPath, "utf8"),
    iconsPath,
  );
  const staticDir = join(sourceRoot, "web", "dist");
  let browserVersion = options.env.RECURSE_BROWSER_VERSION ?? "";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(browserVersion)) browserVersion = "";
  if (!browserVersion)
    browserVersion = await frontendGeneration(htmlTemplate, staticDir);
  const frontend = await FrontendCache.create({
    htmlPath,
    iconsPath,
    staticDir,
    fallbackShell: htmlTemplate,
    fixedVersion: browserVersion,
    live: options.env.RECURSE_FRONTEND_LIVE === "1",
  });

  const operator = new OperatorAuth({
    authFile: join(paths.DATA_DIR, "auth.json"),
    env: options.env,
    displayName: config.displayName,
    themesFile: paths.THEMES_FILE,
  });
  const loopbackToken = await publishLoopbackToken(
    paths.DATA_DIR,
    Number.parseInt(options.env.PORT ?? "8787", 10),
  );
  const loopback = (ex: Parameters<typeof loopbackAuthenticated>[0]) =>
    loopbackAuthenticated(ex, loopbackToken);

  const artifactCtx: artifacts.ArtifactContext = {
    artifactsDir: paths.ARTIFACTS_DIR,
    trashDir: paths.TRASH_DIR,
  };
  const artifactRevisions = new ArtifactRevisions(artifactCtx);
  const deliverPlatformNote = (owner: string, text: string) =>
    delivery.deliver(owner, text, {
      start: false,
      source: "platform",
      origin: "platform",
    });
  const durable = instance.durable;

  const shellView = (cid: string) => {
    const view = durable.shells(cid);
    const items = view.items.map((item) => ({
      ...item,
      command: displayCommand(item.command),
    }));
    return { ...view, items };
  };
  const stopDeps: DeliverStopDeps = withDurableStop(
    {
      loadConversation: (cid) => conversations.load(cid),
      activeRunId: (conv) => activeRunId(conv as never),
      liveStatus: (cid) => durable.liveStatus(cid),
      requestStopProcesses: async (cid, stopId, o) =>
        instance.reap.requestStopProcesses(cid, stopId, o),
      requestStop: (cid, o) => instance.tree.requestStop(cid, o),
      tokenHex: defaultTokenHex,
      nowSeconds: () => Date.now() / 1000,
      log: web,
    },
    // Invariant: A Durable conversation's stop keeps the same exact-run
    // contract.
    {
      owns: (cid) =>
        durable.owns(conversations.load(cid, { withPending: false })),
      stopStatus: (cid) => durable.stopStatus(cid),
      stop: (cid, expectedRun) => durable.stop(cid, expectedRun),
      stopProcesses: (cid) => durable.stopProcesses(cid),
    },
  );
  const filesDeps: FilesRoutesDeps = {
    themesFile: config.paths.THEMES_FILE,
    requireActionReady,
    drafts: instance.drafts,
    files: {
      admitConversationUpload: (owner, data, filename) =>
        instance.reap.admitConversationUpload(owner, data, filename),
      composeFileDownload: (cid, aid) => reads.composeFileDownload(cid, aid),
      composeFileDelete: (cid, aid) => reads.composeFileDelete(cid, aid),
    },
    nodes,
    artifacts: artifactCtx,
    mutateExternalStorage: (work) => mutate(work),
    fenced: (work) => fenced(work),
    deliverPlatformNote,
  };

  const router = new Router();
  registerUiTiming(router, web);
  const backendKeys = new BackendKeys(paths.DATA_DIR);
  const loginDeps = {
    operator,
    throttle: new LoginThrottle(),
    logger: web,
    backendKeys,
  };
  registerLoginRoutes(router, loginDeps);
  registerBackendKeyRoutes(router, loginDeps);
  const connectedBackends = await ConnectedBackends.load(
    await piAgentDir(resolveRoots(config.env), preparePiAgentDir),
    config.displayName,
    (path, reason) =>
      logEvent(web, WARNING, "connected_backends_unavailable", {
        fields: { path, reason },
      }),
    (fields) => logEvent(web, INFO, "backend_sign_in_stage", { fields }),
    (fields) => logEvent(web, INFO, "remote_connection", { fields }),
  );
  registerBackendRoutes(router, connectedBackends, {
    title: (cid) => {
      const row = conversations.metadataSnapshot(cid);
      return row ? String(row.title ?? cid) : undefined;
    },
    deliverPlatformNote,
  });
  registerSettingsSyncRoutes(router, connectedBackends);
  registerBackendProxy(
    router,
    connectedBackends,
    {
      title: (cid) => {
        const row = conversations.metadataSnapshot(cid);
        return row ? String(row.title ?? cid) : undefined;
      },
    },
    (fields) => logEvent(web, INFO, "agent_backend_request", { fields }),
  );
  registerRelayRoutes(
    router,
    connectedBackends,
    {
      title: (cid) => {
        const row = conversations.metadataSnapshot(cid);
        return row ? String(row.title ?? cid) : undefined;
      },
    },
    (name, work) => {
      void instance.tasks
        .spawn(name, work, instance.shutdownController.signal)
        .catch(() => {});
    },
    instance.delivery,
  );
  const release = await readRelease();
  registerStaticRoutes(router, {
    frontend,
    staticDir,
    themesFile: config.paths.THEMES_FILE,
    displayName: config.displayName,
    release,
    readinessSnapshot: () => lifecycle.readinessSnapshot(),
  });
  registerTreeRoutes(router, {
    ...stopDeps,
    requireActionReady,
    tree: async () => {
      const rows = instance.treeView.serve();
      const revisions = await artifactRevisions.snapshot(
        rows.map((row) => String(row.id)),
      );
      return rows.map((row) => ({
        ...row,
        artifacts_revision: revisions.get(String(row.id)) ?? null,
      }));
    },
    loopbackAuthenticated: loopback,
    projectionReady: () => conversations.projectionReady(),
    nodeCids: () => nodes.nodeCids(),
    cliIndex: async () =>
      conversations
        .cliIndex()
        .map((row) => ({ ...row, shells: shellView(String(row.id)).items })),
    transcript: async (cid, options) =>
      durable.owns(conversations.load(cid, { withPending: false }))
        ? durable.transcript(cid, options)
        : null,
    changeEnvironment: async (cid, change) =>
      durable.owns(conversations.load(cid, { withPending: false }))
        ? durable.changeEnvironment(cid, change)
        : null,
    stopDiagnostics: new StopDiagnosticBuckets(),
    revive: {
      search: (query, offset, limit) =>
        durable.archive.search(query, offset, limit),
      revive: (target, parent) => instance.revive.revive(target, parent),
      reviveFrom: (path, parent) => instance.revive.reviveFrom(path, parent),
    },
  });
  const warnModelList = (event: string, fields: Record<string, string>) =>
    logEvent(web, WARNING, event, { fields });
  const modelUpdates = new PiModelUpdater({
    nativeRequest: (request, opts) =>
      instance.oauth.nativeRequest(request, opts),
    config,
    warn: warnModelList,
    spawn: (name, work) =>
      instance.tasks.spawn(name, work, instance.shutdownController.signal),
    afterUpdate: async () => {
      config.writeAvailableModels();
    },
  });
  const send = process.send?.bind(process);
  const recurseUpdates = new RecurseUpdates({
    sourceRoot,
    cacheFile: join(paths.DATA_DIR, "update-check.json"),
    release,
    env: config.env,
    send: send ? (message) => void send(message) : null,
    spawn: (name, work) =>
      instance.tasks.spawn(name, work, instance.shutdownController.signal),
  });
  if (send) process.on("message", (message) => recurseUpdates.receive(message));
  registerSettingsRoutes(router, {
    config,
    modelUpdates,
    recurseUpdates,
    mcpChecks: instance.mcpChecks,
    anthropic: instance.anthropic,
    codex: instance.codex,
    muse,
    openrouter: instance.openrouter,
    credentials: instance.oauth,
    providers: snapshot,
    piAgentDir: () => piAgentDir(resolveRoots(config.env), preparePiAgentDir),
    mutateExternalStorage: (work) => mutate(work),
  });
  registerNotificationRoutes(router, instance.notifications, {
    workerSource: join(sourceRoot, "web", "push-worker.ts"),
    displayName: config.displayName,
    brandingFile: join(paths.CONFIG_DIR, "branding.json"),
  });
  registerSideRoutes(router, {
    requireActionReady,
    load: (cid) => conversations.load(cid, { withPending: false }),
    all: () => conversations.allConvs({ withPending: false }),
    owns: (conv) => durable.owns(conv),
    clearing: (cid) =>
      instance.durable.metadata(cid).pending_actions.includes("clear"),
    create: (parent) => instance.create.create({ parent, side: true }),
    fork: async (cid) => void (await instance.durable.open(cid)),
    reap: (cid) => instance.reap.requestReap(cid),
    deliver: async (cid, content) => {
      const id = await delivery.deliver(cid, content, {
        start: false,
        origin: "operator",
      });
      delivery.requestRun(cid);
      return id;
    },
    promote: (cid) => instance.durable.promotions.request(cid),
    log: (event, fields) => logEvent(web, INFO, event, { fields }),
  });
  registerConversationRoutes(router, {
    requireActionReady,
    serviceCreateSlots: new CreateSlots(),
    log: web,
    monotonicMs: () => performance.now(),
    store: conversations,
    mutateExternalStorage: mutate,
    delivery,
    reads,
    describeUpload: (collection, owner, aid) =>
      import("../agents/runtime/attachments/preview").then((preview) =>
        preview.describe(collection, owner, aid),
      ),
    create: {
      // Invariant: A create before readiness is 503 with Retry-After 2.
      create: (o) => {
        requireActionReady();
        return instance.create.create(o);
      },
      createOrRejoinServiceConversation: (o) =>
        instance.create.createOrRejoinServiceConversation(o),
      setPinned: (cid, pinned) => instance.create.setPinned(cid, pinned),
    },
    reap: instance.reap,
    lifecycle,
    tree: instance.tree,
    deliverStop: (cid, body) => deliverStop(stopDeps, cid, body),
    configActions: instance.configActions,
    compaction: instance.parked,
    nodes: {
      existing: (cid) => nodes.existing(cid),
      node: (cid) => {
        const node = nodes.node(cid);
        return {
          setSafety: (off) => node.setSafety(off),
          renameTitle: (title, order) => node.renameTitle(title, order),

          piStatus: () => durable.liveStatus(cid)[0],
        };
      },
    },
    liveRunId: (cid) => durable.liveStatus(cid)[1],
    durable: instance.durable,
    drafts: instance.drafts,
    config: {
      resolveEffortLevel: (level) => config.resolveEffortLevel(level),
      piBgShellEnabled: paths.PI_BG_SHELL_ENABLED,
    },
    agentTools: instance.agentTools,
    shellView: async (cid) => shellView(cid),
    spawnOutcomes: {
      read: (cid) => instance.reconciler.readSpawnOutcome(cid),
      observe: (cid) => instance.reconciler.observeSpawnOutcome(cid),
    },
    git: {
      workdirFile: (key) => instance.agentTemp.workdirFile(key),
      resolveDiffCwd: (stored, persisted, signal) =>
        instance.workdirGit.resolveDiffCwd(stored, persisted, signal),
      worktreeDiff: (cwd, base, source, signal) =>
        instance.workdirGit.worktreeDiff(cwd, base, source, signal),
      diffFile: (cwd, path, base, contents) =>
        instance.workdirGit.diffFile(cwd, path, base, contents),
      pullRequestDiff: (url, path) =>
        instance.workdirGit.pullRequestDiff(url, path),
      diffCandidates: (cwd) => instance.workdirGit.diffCandidates(cwd),
      pullRequests: (cwd, urls) => instance.workdirGit.pullRequests(cwd, urls),
      githubRepoUrl: (stored, file) =>
        instance.workdirGit.githubRepoUrl(stored, file),
    },
  });
  registerFileRoutes(router, filesDeps);

  const loopLag = new LoopLag({
    logger: logger("loop_lag", sink),
    runningCount: () => instance.durable.runningCount(),
    runningConversations: () => instance.durable.runningConversations(),

    jobs: () => instance.tasks.names().filter((name) => name !== "watcher"),
  });
  const handler = composeApp({
    router,
    loopLag,
    logger: logger("http", sink),
    compression: { enabled: paths.HTTP_RESPONSE_COMPRESSION_ENABLED },
    decompression: { enabled: paths.HTTP_REQUEST_DECOMPRESSION_ENABLED },
    auth: requestAuth({
      operator,
      backendKeys,
      service: new ServiceAuth({
        principalsFile: paths.RECURSE_SERVICE_PRINCIPALS_FILE,
        tokenFile: paths.RECURSE_SERVICE_TOKEN_FILE,
      }),
      loopbackToken,
      tailscaleLogin: paths.RECURSE_TAILSCALE_LOGIN,
      serviceOwns: async (principal, cid) =>
        conversations.serviceOwnsConversation(principal, cid),
      logger: web,
    }),
  });

  const step = async (event: string, work: () => Promise<unknown>) => {
    try {
      await startupMetrics.measure(event, async (m) => {
        m.count("calls");
        await work();
      });
    } catch (error) {
      logException(web, `${event}_failed`, error, { fields: { step: event } });
    }
  };

  const requireWorkingArea = async (): Promise<void> => {
    if (!(await fenced(() => instance.workdirGit.ready())))
      throw new Error(
        "working area not ready: run setup (`./recurse <target>`) " +
          "or redeploy the instance",
      );
    if (await fenced(() => instance.workdirGit.cloneTargetMismatch()))
      throw new Error(
        "working area belongs to a different target: run setup fresh " +
          "(`./recurse <target>`) or redeploy the instance",
      );
  };

  const recoverArtifactDeletions = async (): Promise<void> => {
    const pending = await fenced(() =>
      artifacts.recoverableDeletions(artifactCtx),
    );
    for (const receipt of pending) {
      const owner = String(receipt.owner_agent_id);
      const id = String(receipt.id);
      try {
        const result = await mutate(() =>
          artifacts.deleteArtifact(
            artifactCtx,
            owner,
            id,
            String(receipt.version),
          ),
        );
        await finishArtifactDeletion(filesDeps, result);
      } catch (error) {
        if (error instanceof artifacts.ArtifactConflict) {
          try {
            await mutate(() =>
              artifacts.cancelStaleDeletion(
                artifactCtx,
                owner,
                id,
                String(receipt.deletion_id),
              ),
            );
          } catch (inner) {
            if (!(inner instanceof artifacts.ArtifactError)) throw inner;
          }
        } else if (!(error instanceof artifacts.ArtifactError)) throw error;
      }
    }
  };

  const detached: Promise<void>[] = [];
  const serve: App["serve"] = async (o) => {
    const durableRuntime = step("load_durable_runtime", () =>
      instance.durable.loadRuntime(),
    );
    await startupMetrics.measure("total", async (total) => {
      await instance.start({
        afterStorage: async () => {
          await sink.persist(paths.DATA_DIR);
          logEvent(web, INFO, "application_started");
          await step("recover_artifact_directories", () =>
            artifacts.recoverArtifactDirectories(artifactCtx),
          );
          await step("migrate_artifact_directories", () =>
            artifacts.migrateArtifactDirectories(artifactCtx),
          );
          await step("migrate_artifact_commit_hooks", () =>
            artifacts.migrateCommitHooks(artifactCtx),
          );
        },
        beforeWatcher: async () =>
          startupMetrics.measure("require_working_area", requireWorkingArea),
      });
      total.count("steps", 3);
    });
    await durableRuntime;
    // Invariant: After storage is ready and before listening: what every open
    // shares.
    await step("warm_durable_open", () => instance.durable.warmOpen());
    // Invariant: Best-effort and never awaited: the first Durable open skips
    // its cost.
    instance.durable.warmSearch();
    let running: RunningServer;
    try {
      const socket = paths.RECURSE_TAILSCALE_LOGIN
        ? await tailscaleSocket(paths.DATA_DIR)
        : undefined;
      running = startServer({
        tailscaleSocket: socket,
        handler,
        logger: web,
        host: o.host,
        port: o.port,
        installSignals: o.installSignals,
        shutdown: async (drained) => {
          loopLag.stop();
          logEvent(web, INFO, "application_stopping");
          // Invariant: Requests served during the drain may queue agent-store
          // writes: the store is disposed only once the drain ends or hits its
          // bound.
          await instance.shutdown(drained);
          await sink.file?.close().catch(() => undefined);
        },
      });
    } catch (error) {
      // Invariant: The watcher is already running: stop it before failing (port
      // in use).
      await instance.shutdown();
      throw error;
    }
    loopLag.start();

    const signal = instance.shutdownController.signal;
    const track = (
      name: string,
      work: (signal: AbortSignal) => Promise<void>,
    ) =>
      detached.push(
        instance.tasks.spawn(name, work, signal).catch((error) => {
          if (!signal.aborted)
            logException(web, `${name}_failed`, error, { level: ERROR });
        }),
      );
    instance.tasks
      .spawn(
        "connected-backend-health",
        (signal) => connectedBackends.run(signal),
        signal,
      )
      .catch(() => {
        if (!signal.aborted)
          logEvent(web, ERROR, "connected_backend_health_failed");
      });
    track("git-identity", async () => {
      if (
        (await instance.workdirGit.targetIsGitRepo()) &&
        !(await prepareGitIdentity(paths.REPO_DIR, options.env))
      )
        web.log(
          WARNING,
          "event=git_identity_missing Set user.name and user.email, or configure a GitHub token.",
        );
    });
    track("serve-ready-chain", () =>
      step("write_available_models", async () => config.writeAvailableModels()),
    );
    // Invariant: Local read of Pi's model list; never delays serving or a turn,
    // and a failure keeps the previous list (step logs its duration and
    // failure).
    track("pi-model-list", async () => {
      await step("list_pi_models", () =>
        listPiModels({
          nativeRequest: (request, opts) =>
            instance.oauth.nativeRequest(request, opts),
          config,
          warn: warnModelList,
        }),
      );
      await step("write_available_models", async () =>
        config.writeAvailableModels(),
      );
    });
    track("post-listen-maintenance", async () => {
      await step("cleanup_retired_tool_details", () =>
        cleanupRetiredToolDetails({
          retireDetached: () =>
            retireDetached(paths.TOOL_DETAILS_DIR, paths.TRASH_DIR),
          drainTrash: (d) => instance.agentTemp.drainTrash(d),
        }),
      );
      if (signal.aborted) return;
      await step("recover_artifact_deletions", recoverArtifactDeletions);
    });
    return running;
  };

  return { instance, router, handler, sink, serve, detached };
}
