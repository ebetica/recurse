// Local v1 reads project cached base tree rows, live usage and shell snapshots.
// Context reads never open stores or scan history; cold/unknown usage is null.
// Compaction shares the operator lifecycle, not operator-route access.
import { dirname } from "node:path";
import { brandingFile, readBrand } from "../../branding";
import { SERVICE_MESSAGE_MAX_CHARS } from "../../auth/service";
import { pyStrip } from "../../auth/provider_store";
import { jsonDictBody } from "../login";
import type { createMessageSender } from "../deliver_message";
import type { TreeRow } from "../../agents/tree_view";
import type { TranscriptQuery } from "../../agents/durable/transcript";
import {
  projectV1Messages,
  type Row,
} from "../../agents/durable/message_projection";
import { releaseLabel, type Release } from "../../release";
import { HttpError, jsonResponse, type Handler, type Router } from "../router";
import { API_MAJOR, API_REVISION, apiSchema, type AgentStatus } from "./schema";
import { agent, agentStatus } from "./agent";

interface Shell {
  id: string;
  mode: "background" | "monitor";
  command: string;
  elapsed_seconds: number;
}
interface Deps {
  compact(cid: string): Promise<unknown>;
  changeSidebarTags: Handler;
  tree(): TreeRow[];
  shells(id: string): { items: Shell[] };
  queued(id: string): number;
  context(row: TreeRow): AgentStatus["context"];
  requireReady(): void;
  treeReady(): boolean;
  themesFile: string;
  displayName: string;
  release: Release;
  sendMessage: ReturnType<typeof createMessageSender>;
  transcript(
    cid: string,
    query: TranscriptQuery,
  ): Promise<Record<string, unknown> | null>;
}

function endpoint(handler: Handler): Handler {
  return async (ex) => {
    try {
      const response = await handler(ex);
      response.headers.set("cache-control", "no-store");
      return response;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return jsonResponse(
        {
          detail: String(error.detail),
          code:
            error.status === 404
              ? "not_found"
              : error.status === 413
                ? "too_large"
                : error.status === 503
                  ? "not_ready"
                  : "invalid_request",
        },
        error.status,
        { ...error.headers, "cache-control": "no-store" },
      );
    }
  };
}

export function registerApiV1(router: Router, deps: Deps): void {
  const rows = () => {
    deps.requireReady();
    return deps.tree().map((row) => ({
      ...agent(
        row,
        deps.shells(String(row.id)).items,
        deps.queued(String(row.id)),
      ),
      context: deps.context(row),
    }));
  };
  const subtree = (agents: AgentStatus[], root: string): AgentStatus[] => {
    if (!agents.some((a) => a.id === root))
      throw new HttpError(404, "agent not found");
    const children = new Map<string, AgentStatus[]>();
    for (const a of agents)
      if (a.parent && !a.side_of) {
        const list = children.get(a.parent) ?? [];
        list.push(a);
        children.set(a.parent, list);
      }
    const seen = new Set([root]);
    const queue = [root];
    for (let i = 0; i < queue.length; i++)
      for (const child of children.get(queue[i]!) ?? [])
        if (!seen.has(child.id)) {
          seen.add(child.id);
          queue.push(child.id);
        }
    return agents.filter((a) => seen.has(a.id));
  };
  router.get(
    "/api/v1/version",
    endpoint(async () =>
      jsonResponse({
        api: API_MAJOR,
        revision: API_REVISION,
        release: releaseLabel(deps.release),
        display_name:
          (await readBrand(brandingFile(dirname(deps.themesFile)))).name ??
          deps.displayName,
      }),
    ),
  );
  router.get(
    "/api/v1/schema",
    endpoint(async () => jsonResponse(apiSchema)),
  );
  router.post("/api/v1/agents/tags", endpoint(deps.changeSidebarTags));
  router.post(
    "/api/v1/agents/{id}/compact",
    endpoint(async (ex) => {
      deps.requireReady();
      return jsonResponse(await deps.compact(ex.params.id!));
    }),
  );
  router.get(
    "/api/v1/agents",
    endpoint(async (ex) => {
      const agents = rows();
      const root = ex.url.searchParams.get("root");
      return jsonResponse({
        agents: root === null ? agents : subtree(agents, root),
      });
    }),
  );
  router.get(
    "/api/v1/agents/{id}",
    endpoint(async (ex) => {
      const found = rows().find((a) => a.id === ex.params.id);
      if (!found) throw new HttpError(404, "agent not found");
      const shells = deps
        .shells(found.id)
        .items.map(({ id, mode, command, elapsed_seconds }) => ({
          id,
          mode,
          command,
          elapsed_seconds,
        }));
      return jsonResponse({ ...found, shells });
    }),
  );
  router.get(
    "/api/v1/agents/{id}/messages",
    endpoint(async (ex) => {
      deps.requireReady();
      const integer = (name: string, fallback?: number): number | undefined => {
        const value = ex.url.searchParams.get(name);
        if (value === null) return fallback;
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
          throw new HttpError(422, `invalid ${name}`);
        return Number(value);
      };
      const limit = integer("limit", 20)!;
      const before = integer("before");
      const after = integer("after");
      const full = ex.url.searchParams.get("full") ?? "false";
      if (
        limit < 1 ||
        limit > 50 ||
        (before !== undefined && after !== undefined) ||
        !["true", "false", "1", "0"].includes(full)
      )
        throw new HttpError(422, "invalid transcript query");
      const window = await deps.transcript(ex.params.id!, {
        limit,
        before,
        after,
      });
      if (!window) throw new HttpError(404, "agent not found");
      const messages = projectV1Messages(
        window.rows as Row[],
        full === "true" || full === "1",
      );
      return jsonResponse({ messages, prev: window.prev, next: window.next });
    }),
  );
  router.post(
    "/api/v1/agents/{id}/messages",
    endpoint(async (ex) => {
      deps.requireReady();
      const body = await jsonDictBody(ex);
      if (typeof body.text !== "string" || !pyStrip(body.text))
        throw new HttpError(422, "text must be nonempty");
      if (Array.from(body.text).length > SERVICE_MESSAGE_MAX_CHARS)
        throw new HttpError(413, "message is too large");
      if (body.interrupt !== undefined && typeof body.interrupt !== "boolean")
        throw new HttpError(422, "interrupt must be a boolean");
      if (
        body.client_message_id !== undefined &&
        typeof body.client_message_id !== "string"
      )
        throw new HttpError(422, "invalid client_message_id");
      const result = await deps.sendMessage(
        ex.params.id!,
        {
          content: body.text,
          interrupt: body.interrupt,
          client_message_id: body.client_message_id,
        },
        ex.state.auth_method === "backend-key"
          ? null
          : ex.request.headers.get("x-recurse-agent"),
        typeof ex.state.backend_agent === "string"
          ? { sender: ex.state.backend_agent, title: null }
          : null,
      );
      return jsonResponse({
        message_id: result.message_id,
        status: agentStatus(result.status),
        steer: result.steer === true,
        ...(typeof result.interrupted === "boolean"
          ? { interrupted: result.interrupted }
          : {}),
      });
    }),
  );
  router.get(
    "/api/v1/agents/{id}/idle",
    endpoint(async (ex) => {
      // Invariant: An incomplete tree can omit busy descendants, so idle
      // must wait for the tree rebuild.
      if (!deps.treeReady())
        throw new HttpError(503, "tree is not ready", { "retry-after": "2" });
      const agents = subtree(rows(), ex.params.id!);
      const busy: {
        id: string;
        reason: "running" | "stopping" | "queued" | "shell";
      }[] = [];
      for (const a of agents) {
        if (a.status === "running" || a.status === "stopping")
          busy.push({ id: a.id, reason: a.status });
        if (a.queued) busy.push({ id: a.id, reason: "queued" });
        if (a.background_shells) busy.push({ id: a.id, reason: "shell" });
      }
      return jsonResponse({ idle: busy.length === 0, busy });
    }),
  );
}
