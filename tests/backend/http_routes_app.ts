import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import * as artifacts from "../../src/artifacts";
import { KeyError } from "../../src/agents/runtime/agent_node";
import { removeFile } from "../../src/agents/runtime/attachments/publish";
import { collectionSnapshot } from "../../src/agents/runtime/node_files";
import { fenced } from "../../src/agents/mutation_guard";
import {
  SupervisorReads,
  type ReadsDeps,
} from "../../src/agents/supervisor/reads";
import { ServiceAuth } from "../../src/auth/service";
import { OperatorAuth } from "../../src/auth/session";
import { logger } from "../../src/observability/runtime_logging";
import { composeApp, startServer, type RunningServer } from "../../src/server";
import { registerFileRoutes, type FilesRoutesDeps } from "../../src/web/files";
import { publishLoopbackToken, requestAuth } from "../../src/web/request_auth";
import { HttpError, Router } from "../../src/web/router";
import { build, layout } from "./fixtures/agent_temp/replay";

export interface HarnessNode {
  reaping: boolean;
  fileOps: number;
  tryAdmitFileOp(): boolean;
  releaseFileOp(): void;
  releaseAttachment(aid: string): Promise<boolean>;
}

export interface RoutesApp {
  readonly running: RunningServer;
  readonly router: Router;
  readonly root: string;
  readonly state: { ready: boolean };
  readonly delivered: [string, string][];
  readonly nodes: Map<string, HarnessNode>;
  readonly artifacts: artifacts.ArtifactContext;
  readonly temp: ReturnType<typeof build>["temp"];
  readonly records: ReturnType<typeof build>["records"];
  readonly authEnv: Record<string, string | undefined>;
}

export const tmpKey = (cid: string) => `20260925-${cid}`;

export async function buildRoutesApp(
  root: string,
  conversations: readonly string[],
  options: {
    authEnv?: Record<string, string | undefined>;
  } = {},
): Promise<RoutesApp> {
  const spec = {
    name: "routes",
    conversations: conversations.map((id) => ({ id, tmp_key: tmpKey(id) })),
    ops: [],
  };
  let next = 0;
  const { temp, drafts, records } = build(root, spec, () => ++next);
  const paths = layout(root);
  await mkdir(paths.DATA_DIR, { recursive: true });
  const state = { ready: true };
  const nodes = new Map<string, HarnessNode>();
  const node = (cid: string): HarnessNode => {
    const made: HarnessNode = {
      reaping: false,
      fileOps: 0,
      tryAdmitFileOp() {
        if (this.reaping) return false;
        this.fileOps += 1;
        return true;
      },
      releaseFileOp() {
        this.fileOps -= 1;
      },
      async releaseAttachment(aid) {
        const conv = records.get(cid);
        const snap = conv ? collectionSnapshot(conv, temp.config) : null;
        if (this.reaping || snap === null) return false;
        return removeFile(snap.collection, cid, aid);
      },
    };
    nodes.set(cid, made);
    return made;
  };
  for (const cid of conversations) node(cid);
  const claims = {
    metadataSnapshot: (cid: string) => records.get(cid) ?? null,
    existing: (cid: string) =>
      nodes.has(cid) ? { reaping: nodes.get(cid)!.reaping } : null,
    topologyEpoch: () => 0,
    dataDir: () => paths.DATA_DIR,
    binding: (sessionId: string, sessionFile: string, cwd: string) => ({
      sessionId,
      sessionFile,
      cwd,
    }),
  };
  const historyNodes = new Map<string, { reaping: boolean; pi: null }>();
  claims.existing = (cid) => {
    const live = nodes.get(cid);
    if (!live) return null;
    const held = historyNodes.get(cid) ?? { reaping: false, pi: null };
    held.reaping = live.reaping;
    historyNodes.set(cid, held);
    return held;
  };
  const reads = new SupervisorReads({
    claims,
    config: temp.config,
  } as unknown as ReadsDeps);
  const artifactCtx: artifacts.ArtifactContext = {
    artifactsDir: temp.config.paths.ARTIFACTS_DIR,
    trashDir: paths.TRASH_DIR,
  };
  const delivered: [string, string][] = [];
  const requireActionReady = () => {
    if (!state.ready)
      throw new HttpError(503, "service_storage_unavailable", {
        "retry-after": "2",
      });
  };
  const filesDeps: FilesRoutesDeps = {
    themesFile: temp.config.paths.THEMES_FILE,
    requireActionReady,
    drafts,
    files: {
      async admitConversationUpload(owner, data, filename) {
        if (!owner) throw new KeyError("attachment owner not found");
        const live =
          nodes.get(owner) ?? (records.has(owner) ? node(owner) : null);
        if (live === null || !live.tryAdmitFileOp())
          throw new KeyError("attachment owner not found");
        try {
          return {
            ...(await fenced(() =>
              temp.addConversationUpload(owner, data, filename),
            )),
          };
        } finally {
          live.releaseFileOp();
        }
      },
      composeFileDownload: (cid, aid) => reads.composeFileDownload(cid, aid),
      composeFileDelete: (cid, aid) => reads.composeFileDelete(cid, aid),
    },
    nodes: { existing: (cid) => nodes.get(cid) ?? null },
    artifacts: artifactCtx,
    mutateExternalStorage: (work) => work(),
    fenced: (work) => fenced(work),
    deliverPlatformNote: async (owner, text) => {
      delivered.push([owner, text]);
    },
  };
  const router = new Router();
  registerFileRoutes(router, filesDeps);
  const sink = { write: () => {} };
  const authEnv = options.authEnv ?? {};
  const handler = composeApp({
    router,
    logger: logger("http", sink),
    summaryInterval: 0,
    auth: requestAuth({
      operator: new OperatorAuth({
        authFile: join(paths.DATA_DIR, "auth.json"),
        env: authEnv,
        displayName: "Recurse",
      }),
      service: new ServiceAuth({
        principalsFile: join(paths.DATA_DIR, "principals.json"),
        tokenFile: null,
      }),
      loopbackToken: await publishLoopbackToken(paths.DATA_DIR, 0),
      serviceOwns: async () => false,
      logger: logger("web", sink),
    }),
  });
  const running = startServer({ handler, logger: logger("web", sink) });
  return {
    running,
    router,
    root,
    state,
    delivered,
    nodes,
    artifacts: artifactCtx,
    temp,
    records,
    authEnv,
  };
}
