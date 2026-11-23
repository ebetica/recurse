// Changes-pane HTTP routes read the conversation's linked PRs and Git changes.
// Summary and candidate deadlines include working-directory resolution.

import { linkedPrList } from "../agents";
import { pyTruthy } from "../agents/runtime";
import { pyStrip } from "../auth";
import { timed, timingDetail } from "../observability";
import { prIdentity } from "../pull_request";
import { abortable, anyAbortSignal } from "../utils";
import {
  CANDIDATE_REQUEST_TIMEOUT_MS,
  cleanBaseRef,
  DIFF_REQUEST_TIMEOUT_MS,
  unavailableDiff,
} from "../workdir_git";
import { dictBody, queryStr } from "./conversation_request";
import { HttpError, jsonResponse, type Router } from "./router";

type Rec = Record<string, unknown>;

export interface ConversationChangesRoutesDeps {
  readonly store: {
    load(cid: string): Rec | null;
    /** Copies of the live descendant conversations, parents first. */
    subtree(cid: string): Rec[];
    save(conv: Rec): Promise<unknown>;
    effectiveWorkdir(conv: Rec): string;
  };
  readonly durable?: {
    owns(conv: Rec | null | undefined): boolean;
    effectiveCwd(cid: string): Promise<string | null>;
  };
  /** Starts a background branch PR lookup (agents/conversation_prs.ts). */
  readonly prs: { refresh(cid: string, reason: string): void };
  readonly git: {
    resolveDiffCwd(
      stored: string,
      persisted: string | null,
      signal?: AbortSignal,
    ): Promise<[string, string]>;
    worktreeDiff(
      cwd: string,
      base: string | null,
      source: string,
      signal?: AbortSignal,
      includeUntracked?: boolean,
    ): Promise<unknown>;
    diffFile(
      cwd: string,
      path: string,
      base: string | null,
      includeContents: boolean,
      snapshot?: string | null,
    ): Promise<unknown>;
    pullRequestDiff(
      url: string,
      path: string | null,
      queue: string,
    ): Promise<unknown>;
    diffCandidates(cwd: string, signal?: AbortSignal): Promise<unknown>;
  };
}

export function registerConversationChangesRoutes(
  router: Router,
  deps: ConversationChangesRoutesDeps,
): void {
  const { store } = deps;

  const diffScope = async (
    conv: Rec,
    signal?: AbortSignal,
  ): Promise<[string, string, string | null]> => {
    let stored: string;
    try {
      stored = store.effectiveWorkdir(conv);
    } catch {
      throw new HttpError(404, "unknown workdir");
    }
    const [cwd, source] = await timed("diff.scope", async () => {
      const persisted = deps.durable?.owns(conv)
        ? await deps.durable.effectiveCwd(String(conv.id))
        : null;
      return deps.git.resolveDiffCwd(stored, persisted, signal);
    });
    return [cwd, source, cleanBaseRef(conv.diff_base_ref)];
  };

  const loadOr404 = (cid: string): Rec => {
    const conv = store.load(cid);
    if (!pyTruthy(conv)) throw new HttpError(404);
    return conv!;
  };

  router.get("/api/conversations/{cid}/prs", async (ex) => {
    const conv = loadOr404(ex.params.cid!);
    const cid = String(conv.id);
    const prs = linkedPrList(conv, store.subtree(cid));
    // Spec: Opening Changes also refreshes the owners of the newest few PRs.
    if (queryStr(ex, "refresh") === "1")
      for (const id of new Set([
        cid,
        ...prs.slice(0, 5).map((pr) => pr.agent?.id ?? cid),
      ]))
        deps.prs.refresh(id, "changes_pane_open");
    return jsonResponse({ prs });
  });

  router.get(
    "/api/conversations/{cid}/diff",
    async (ex) => {
      const conv = loadOr404(ex.params.cid!);
      const pr = queryStr(ex, "pr");
      if (pr !== null) {
        if (!prIdentity(pr))
          throw new HttpError(422, "invalid pull request URL");
        return jsonResponse(
          await deps.git.pullRequestDiff(pr, null, ex.params.cid!),
        );
      }
      const base = queryStr(ex, "base");
      if (base !== null && cleanBaseRef(base) === null)
        throw new HttpError(422, "invalid base ref");
      // The request also waits for Durable to resolve the cwd, before Git.
      const deadline = AbortSignal.timeout(DIFF_REQUEST_TIMEOUT_MS);
      const signal = anyAbortSignal([ex.request.signal, deadline]);
      let scope: Awaited<ReturnType<typeof diffScope>> | undefined;
      try {
        scope = await abortable(diffScope(conv, signal), signal);
        const [cwd, source, stored] = scope;
        return jsonResponse(
          await abortable(
            deps.git.worktreeDiff(
              cwd,
              base ?? stored,
              source,
              signal,
              queryStr(ex, "untracked") !== "0",
            ),
            signal,
          ),
        );
      } catch {
        if (deadline.aborted) timingDetail("diff_result", "deadline");
        return jsonResponse(
          unavailableDiff("diff-failed", scope?.[0], scope?.[1]),
        );
      }
    },
    {
      query: {
        base: { type: "str" },
        pr: { type: "str" },
        untracked: { type: "str" },
      },
      longRunning: true,
    },
  );

  router.add(["PATCH"], "/api/conversations/{cid}/diff/base", async (ex) => {
    const cid = ex.params.cid!;
    const body = await dictBody(ex);
    const conv = loadOr404(cid);
    if (!("base" in body)) throw new HttpError(422, "base required");
    const raw = body.base;
    if (raw === null || (typeof raw === "string" && !pyStrip(raw)))
      delete conv.diff_base_ref;
    else {
      const ref = cleanBaseRef(raw);
      if (ref === null) throw new HttpError(422, "invalid base ref");
      conv.diff_base_ref = ref;
    }
    await store.save(conv);
    return jsonResponse({ id: cid, diff_base_ref: conv.diff_base_ref ?? null });
  });

  router.get(
    "/api/conversations/{cid}/diff/files",
    async (ex) => {
      const conv = loadOr404(ex.params.cid!);
      const path = queryStr(ex, "path");
      if (!path) throw new HttpError(422, "path required");
      const pr = queryStr(ex, "pr");
      if (pr !== null) {
        if (!prIdentity(pr))
          throw new HttpError(422, "invalid pull request URL");
        return jsonResponse(
          await deps.git.pullRequestDiff(pr, path, ex.params.cid!),
        );
      }
      const base = queryStr(ex, "base");
      if (base !== null && cleanBaseRef(base) === null)
        throw new HttpError(422, "invalid base ref");
      const [cwd, , stored] = await diffScope(conv);
      try {
        return jsonResponse(
          await deps.git.diffFile(
            cwd,
            path,
            base ?? stored,
            ex.query.contents === true,
            queryStr(ex, "snapshot"),
          ),
        );
      } catch {
        return jsonResponse({ available: false, reason: "diff-failed", path });
      }
    },
    {
      query: {
        path: { type: "str" },
        pr: { type: "str" },
        base: { type: "str" },
        contents: { type: "bool", default: false },
        snapshot: { type: "str" },
      },
      longRunning: true,
    },
  );

  router.get(
    "/api/conversations/{cid}/diff/candidates",
    async (ex) => {
      const conv = loadOr404(ex.params.cid!);
      const signal = anyAbortSignal([
        ex.request.signal,
        AbortSignal.timeout(CANDIDATE_REQUEST_TIMEOUT_MS),
      ]);
      const scope = await abortable(diffScope(conv, signal), signal).catch(
        (error: unknown) => {
          if (!signal.aborted) throw error;
          return null;
        },
      );
      if (scope) {
        try {
          return jsonResponse(
            await abortable(deps.git.diffCandidates(scope[0], signal), signal),
          );
        } catch {}
      }
      return jsonResponse({ branches: [], commits: [], tags: [] });
    },
    { longRunning: true },
  );
}
