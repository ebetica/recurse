import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { KeyError, ValueError } from "../../src/agents/runtime/agent_node";
import { AttachmentError } from "../../src/agents/runtime/attachments/base";
import { ExternalKeyConflict } from "../../src/agents/conversation_store";
import {
  CompletedReplyCursorError,
  CompletedReplyCursorExpired,
  CompletedReplyStorageUnavailable,
} from "../../src/agents/view/reader";
import { ServiceAuth } from "../../src/auth/service";
import { OperatorAuth } from "../../src/auth/session";
import { logger } from "../../src/observability/runtime_logging";
import { composeApp, startServer, type RunningServer } from "../../src/server";
import {
  CreateSlots,
  registerConversationRoutes,
  type ConversationsRoutesDeps,
} from "../../src/web/conversations";
import { publishLoopbackToken, requestAuth } from "../../src/web/request_auth";
import { HttpError, jsonResponse, Router } from "../../src/web/router";
import { WorkdirGit } from "../../src/workdir_git";
import { captureFixture } from "./fixture_subprocess";
import seed from "./fixtures/http_conversations/seed.json";

type Rec = Record<string, unknown>;
const copy = <T>(value: T): T => structuredClone(value);

const GIT_ENV = {
  GIT_AUTHOR_NAME: "corpus",
  GIT_AUTHOR_EMAIL: "corpus@example.invalid",
  GIT_COMMITTER_NAME: "corpus",
  GIT_COMMITTER_EMAIL: "corpus@example.invalid",
  GIT_AUTHOR_DATE: "2026-09-25T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-09-25T00:00:00Z",
};

export async function makeRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const git = async (...args: string[]) => {
    const done = await captureFixture(["git", ...args], {
      cwd: repo,
      env: { ...process.env, ...GIT_ENV },
    });
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  };
  const write = async (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await writeFile(join(repo, name), text);
    }
  };
  await git("init", "-q", "-b", "main");
  await write(seed.git.committed);
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  await write(seed.git.changed);
  return repo;
}

export class ScriptedWorld {
  readonly convs = new Map<string, Rec>();
  bindings: [string, string][];
  readonly external = new Map<string, string>();
  counter = 0;
  raceLookups = 0;
  calls: unknown[][] = [];

  constructor(repo: string) {
    for (const raw of seed.conversations) {
      const record: Rec = copy(raw);
      if (record.workdir === "<repo>") record.workdir = repo;
      this.convs.set(String(record.id), record);
    }
    this.bindings = seed.bindings.map(([p, c]) => [p!, c!]);
    for (const [p, k, cid] of seed.external_keys)
      this.external.set(`${p}\0${k}`, cid!);
  }
  log(...call: unknown[]): void {
    this.calls.push(call);
  }
  drain(): unknown[][] {
    const calls = this.calls;
    this.calls = [];
    return calls;
  }
  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
  load(cid: unknown): Rec | null {
    const record = typeof cid === "string" ? this.convs.get(cid) : undefined;
    return record === undefined ? null : copy(record);
  }
  async save(conv: Rec) {
    this.log("save", conv.id, conv.diff_base_ref ?? null);
    this.convs.set(String(conv.id), copy(conv));
  }
  async lookupExternalKey(principal: string, key: string) {
    this.log("lookup_external_key", principal, key);
    if (key === "dangling")
      throw new ExternalKeyConflict("external_key binding is unavailable");
    if (key === "race") {
      this.raceLookups += 1;
      return this.raceLookups > 1 ? this.load("svc-winner") : null;
    }
    const cid = this.external.get(`${principal}\0${key}`);
    return cid ? this.load(cid) : null;
  }
  async ownedCount(principal: string) {
    return this.bindings.filter(([p]) => p === principal).length;
  }
  async bindService(principal: string, cid: string) {
    this.log("bind_service_conversation", principal, cid);
    this.bindings.push([principal, cid]);
  }
  async bindExternal(principal: string, key: string, cid: string) {
    this.log("bind_external_key", principal, key, cid);
    this.external.set(`${principal}\0${key}`, cid);
  }
  async rollback(conv: Rec) {
    this.log("rollback_service_conversation", conv.id);
    this.convs.delete(String(conv.id));
    this.bindings = this.bindings.filter(([, c]) => c !== conv.id);
  }
  async serviceCreate(o: {
    title: string | null;
    servicePrincipal: string;
    externalKey: string | null;
    allowedModels: readonly string[] | null;
  }) {
    this.log(
      "create_service",
      o.title,
      o.servicePrincipal,
      o.externalKey,
      o.allowedModels,
    );
    if (o.allowedModels !== null && !o.allowedModels.includes("m1"))
      throw new ValueError("model_not_allowed");
    const cid = this.next("svc");
    this.convs.set(cid, {
      id: cid,
      status: "idle",
      title: o.title,
      parent: null,
      model: "m1",
      backend: "pi",
    });
    return this.load(cid)!;
  }
  async create(o: {
    parent: string | null;
    model: string | null;
    effort: string | null;
    level: number | null;
    attachmentDraft: string | null;
    muted: boolean;
  }) {
    this.log(
      "create",
      o.parent,
      o.model,
      o.effort,
      o.level,
      o.attachmentDraft,
      o.muted,
    );
    if (o.model === "bad-model")
      throw new ValueError("unknown model 'bad-model'");
    const cid = this.next("new");
    this.convs.set(cid, {
      id: cid,
      status: "idle",
      title: null,
      parent: o.parent,
      model: o.model || "m1",
      effort: o.effort,
      level: o.level,
      muted: o.muted,
      backend: "pi",
    });
    return this.load(cid)!;
  }
  async deliver(
    cid: string,
    content: string,
    o: {
      source?: string;
      sender?: string | null;
      origin?: string | null;
      attachmentIds?: string[] | null;
      clientMessageId?: string | null;
    },
  ) {
    this.log(
      "deliver",
      cid,
      content,
      o.source ?? "user",
      o.sender ?? null,
      o.origin ?? null,
      o.attachmentIds ?? null,
      o.clientMessageId ?? null,
    );
    return cid === "conv-gone" ? null : this.next("msg");
  }
  async setSafety(cid: string, off: boolean): Promise<[Rec, boolean]> {
    this.log("set_safety", cid, off);
    if (cid === "conv-gone") throw new ValueError("a reap is in progress");
    const conv = this.convs.get(cid)!;
    conv.safety_off = off;
    return [copy(conv), cid === "conv-run"];
  }
  rename(cid: string, title: string) {
    this.log("rename_title", cid, title);
    return cid === "conv-gone"
      ? null
      : { title, superseded: false, pending: false };
  }
  async reparent(cid: string, parent: string, by: string | null) {
    this.log("request_reparent", cid, parent, by);
    if (parent === cid || !this.convs.has(parent))
      return { ok: false, error: "cannot move an agent under itself" };
    const old = this.convs.get(cid)!.parent ?? null;
    return { ok: true, from: old, to: parent, moved: true };
  }
  async viewEvents(
    cid: string,
    lastEventId: string | null,
  ): Promise<[number, Uint8Array]> {
    this.log("read_view_events", cid, lastEventId);
    const bytes = (text: string) => new TextEncoder().encode(text);
    if (lastEventId === null)
      return [
        200,
        bytes(
          'retry: 1000\nid: i1:3\nevent: snapshot\ndata: {"rows":["héllo ✓"]}\n\n',
        ),
      ];
    if (lastEventId === "i1:3")
      return [200, bytes("retry: 1000\nid: i1:3\nevent: rows\ndata: []\n\n")];
    if (lastEventId === "big") {
      const rows = Array(30)
        .fill(JSON.stringify("é".repeat(40)))
        .join(", ");
      return [
        200,
        bytes(`id: i1:4\nevent: snapshot\ndata: {"rows": [${rows}]}\n\n`),
      ];
    }
    return [503, new Uint8Array()];
  }
  async replies(cid: string, after: string | null, wait: unknown) {
    const value = Number(wait);
    const finite = Number.isFinite(value);
    const text = Number.isNaN(value) ? "nan" : value > 0 ? "inf" : "-inf";
    this.log("read_completed_replies", cid, after, finite ? value : text);
    if (after === "expired")
      throw new CompletedReplyCursorExpired("cursor generation is gone");
    if (after === "bad")
      throw new CompletedReplyCursorError("malformed cursor");
    if (after === "storage") throw new CompletedReplyStorageUnavailable("disk");
    if (after === "deleted") return null;
    if (!finite) throw new ValueError("wait must be a finite number");
    return { turns: [], next_cursor: after || "c0" };
  }
}

export interface ConversationsApp {
  readonly running: RunningServer;
  readonly router: Router;
  readonly world: ScriptedWorld;
  readonly state: { ready: boolean };
  readonly deps: ConversationsRoutesDeps;
}

export async function buildConversationsApp(
  root: string,
  options: {
    authEnv?: Record<string, string | undefined>;
    patch?: (deps: ConversationsRoutesDeps, world: ScriptedWorld) => void;
    slots?: CreateSlots;
  } = {},
): Promise<ConversationsApp> {
  const repo = await makeRepo(join(root, "corpus"));
  const data = join(root, "data");
  await mkdir(data, { recursive: true });
  for (const [name, text] of Object.entries(seed.tokens))
    await writeFile(join(data, name), text);
  const principals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(seed.principals))
    principals[key] = { ...value, token_file: join(data, value.token_file) };
  await writeFile(
    join(data, "principals.json"),
    JSON.stringify({ principals }),
  );
  const world = new ScriptedWorld(repo);
  const state = { ready: true };
  const git = new WorkdirGit({
    repoUrl: "https://example.invalid/unused.git",
    repoDir: join(root, "none"),
    dataDir: data,
    env: { ...process.env },
  });
  const levels = seed.levels as unknown as Record<string, [string, string]>;
  const node = (cid: string) => ({
    setSafety: (off: boolean) => world.setSafety(cid, off),
    renameTitle: (title: string) => world.rename(cid, title),
    piStatus: () => (cid === "conv-run" ? "running" : null),
  });
  const sink = { write: () => {} };
  const deps: ConversationsRoutesDeps = {
    requireActionReady() {
      if (!state.ready)
        throw new HttpError(503, "service_storage_unavailable", {
          "retry-after": "2",
        });
    },
    serviceCreateSlots: options.slots ?? new CreateSlots(),
    log: logger("web", sink),
    monotonicMs: () => performance.now(),
    store: {
      load: (cid) => world.load(cid),
      metadataSnapshot: (cid) => world.load(cid),
      save: (conv) => world.save(conv),
      effectiveWorkdir(conv) {
        if (typeof conv.workdir !== "string") throw new KeyError("workdir");
        return conv.workdir;
      },
      lookupExternalKey: (p, k) => world.lookupExternalKey(p, k),
      serviceOwnedConversationCount: (p) => world.ownedCount(p),
      bindServiceConversation: (p, c) => world.bindService(p, c),
      bindExternalKey: (p, k, c) => world.bindExternal(p, k, c),
      rollbackServiceConversation: (conv) => world.rollback(conv),
    },
    async mutateExternalStorage(work, rollback) {
      try {
        return await work();
      } catch (error) {
        await rollback?.();
        throw error;
      }
    },
    delivery: {
      deliver: (cid, content, o) => world.deliver(cid, content, o),
      requestRun: (cid) => world.log("request_run", cid),
      async cancelInboxMessageAsync(cid, mid) {
        world.log("cancel_inbox_message", cid, mid);
        return mid === "q1";
      },
      retryInboxMessage(cid, mid) {
        world.log("retry_inbox_message", cid, mid);
        return mid === "failed-1";
      },
    },
    reads: {
      readConversationMetadata: async (cid) => world.load(cid),
      readCompletedReplies: (cid, after, o) =>
        world.replies(cid, after, o.wait),
      async readViewWindow(cid, o) {
        world.log(
          "read_view_window",
          cid,
          o.after,
          o.before,
          o.limit,
          o.since,
          o.instance,
        );
        return { instance: "i1", revision: 3, blocks: [] };
      },
      readViewEvents: (cid, last) => world.viewEvents(cid, last),
      readThinkingText: async () => null,
      async composeFilePage(cid, cursor, limit, generation) {
        world.log("compose_file_page", cid, cursor, limit, generation);
        if (cursor === "bad") return [400, null];
        if (!world.convs.has(cid)) return [404, null];
        return [200, { items: [], limit, generation }];
      },
      async composeFilePreview(cid, storage, aid, offset) {
        world.log("compose_file_preview", cid, storage, aid, offset);
        if (storage === "bad") return [422, null];
        if (aid === "none") return [404, null];
        return [200, { text: "hello", offset }];
      },
      readTurnPrompt: async (_cid, offset) =>
        offset === 0 ? { text: "prompt", offset } : null,
      readMarkerSummary: async (_cid, _offset, generation) =>
        generation === 1 ? { summary: "carried" } : null,
      readContextUsage: async (cid) =>
        world.convs.has(cid) ? { tokens: 10 } : null,
      readBasePrompt: async (cid) =>
        world.convs.has(cid) ? { status: "pending" } : null,
      fileSnapshot: (cid) =>
        cid === "conv-a" ? { collection: "collection", owner: cid } : null,
    },
    async describeUpload(_collection, _owner, aid) {
      if (aid === "boom")
        throw new AttachmentError("attachment store is unavailable");
      return aid.startsWith("up-") ? { id: aid } : null;
    },
    create: {
      create: (o) => world.create(o),
      createOrRejoinServiceConversation: (o) => world.serviceCreate(o),
      async setPinned(cid, pinned) {
        world.log("set_pinned", cid, pinned);
        if (!world.convs.has(cid)) throw new KeyError(cid);
        world.convs.get(cid)!.pinned = pinned;
        return world.load(cid)!;
      },
    },
    reap: {
      async requestReap(cid, by) {
        world.log("request_reap", cid, by);
        if (!world.convs.has(cid)) throw new KeyError(cid);
        return { id: cid, deleting: true, requested_by: by };
      },
    },
    lifecycle: {
      launchMaintenanceJob(name, work) {
        world.log("launch_maintenance_job", name);
        void work();
      },
    },
    tree: {
      parkSpawnIntent(cid, body) {
        world.log("park_spawn_intent", cid, body);
        return { cid };
      },
      async recordSpawnIntent(item) {
        world.log("record_spawn_intent", (item as Rec).cid);
      },
      requestReparent: (cid, parent, o) => world.reparent(cid, parent, o.by),
      async requestStop(cid, o) {
        world.log("request_stop", cid, o.expectedRun);
        return true;
      },
    },
    async deliverStop(cid, body) {
      world.log("deliver_stop", cid, body);
      return jsonResponse({
        ok: true,
        stopped: cid,
        run_id: body.run_id ?? null,
      });
    },
    configActions: {
      async requestModelChange(cid, model, effort, level) {
        world.log("request_model_change", cid, model, effort, level);
        if (model === "unknown") return null;
        return { model, effort, level, pending_model: model };
      },
      async requestMute(cid, muted) {
        world.log("request_mute", cid, muted);
        return { id: cid, muted };
      },
      async toggleMute(cid) {
        world.log("toggle_mute", cid);
        return { id: cid, muted: true };
      },
    },
    compaction: {
      async requestCompact(cid) {
        world.log("request_compact", cid);
        return { id: cid, queued: "compact" };
      },
      async requestClear(cid) {
        world.log("request_clear", cid);
        return { id: cid, queued: "clear" };
      },
    },
    nodes: {
      existing: (cid) =>
        world.convs.has(cid)
          ? {
              inboxMessages: () =>
                cid === "conv-a"
                  ? [{ id: "q1", content: "queued", _delivery_id: "d1" }]
                  : [],
            }
          : null,
      node(cid) {
        if (!world.convs.has(cid)) throw new KeyError(cid);
        return node(cid);
      },
    },
    liveRunId: (cid) => (cid === "conv-run" ? "run-1" : null),
    drafts: {
      async recoverTransferredAttachmentDraft(token) {
        world.log("recover_transferred_attachment_draft", token);
        return token === "done-draft" ? world.load("conv-a") : null;
      },
    },
    config: {
      resolveEffortLevel(level) {
        const found = levels[String(level)];
        if (!found)
          throw new ValueError(`effort level ${level} is not configured`);
        return found;
      },
      piBgShellEnabled: true,
    },
    agentTools: {
      async skillsFor(cid) {
        if (cid === "conv-b") throw new Error("pi discovery failed");
        if (!world.convs.has(cid)) return null;
        return [[{ name: "review", description: "Revisar ✓" }], "ctx-1"];
      },
    },
    async shellView(cid) {
      world.log("shell_view", cid);
      const items = cid === "conv-a" ? [{ command: "sleep 5" }] : [];
      return {
        status: "ready",
        items,
        truncated: false,
        active_count: items.length,
        background_count: items.length,
      };
    },
    spawnOutcomes: {
      read: async (cid) =>
        cid === "done-spawn" ? { status: "created", id: cid } : null,
      observe: async (cid) => world.log("observe_spawn_outcome", cid),
    },
    git: {
      workdirFile(key) {
        if (key.includes("..")) throw new ValueError("unsafe");
        return join(data, "no-workdir.json");
      },
      resolveDiffCwd: (stored, persisted) =>
        git.resolveDiffCwd(stored, persisted),
      worktreeDiff: (cwd, base, source) => git.worktreeDiff(cwd, base, source),
      diffFile: (cwd, path, base, contents) =>
        git.diffFile(cwd, path, base, contents),
      pullRequestDiff: (url, path) => git.pullRequestDiff(url, path),
      diffCandidates: (cwd) => git.diffCandidates(cwd),
      pullRequests: (cwd, urls) => git.pullRequests(cwd, urls),
      githubRepoUrl: (stored, file) => git.githubRepoUrl(stored, file),
    },
  };
  options.patch?.(deps, world);
  const router = new Router();
  registerConversationRoutes(router, deps);
  const handler = composeApp({
    router,
    logger: logger("http", sink),
    summaryInterval: 0,
    auth: requestAuth({
      operator: new OperatorAuth({
        authFile: join(data, "auth.json"),
        env: options.authEnv ?? {},
        displayName: "Recurse",
      }),
      service: new ServiceAuth({
        principalsFile: join(data, "principals.json"),
        tokenFile: null,
      }),
      loopbackToken: await publishLoopbackToken(data, 0),
      serviceOwns: async (principal, cid) =>
        world.bindings.some(([p, c]) => p === principal && c === cid),
      logger: logger("web", sink),
    }),
  });
  const running = startServer({ handler, logger: logger("web", sink) });
  return { running, router, world, state, deps };
}
