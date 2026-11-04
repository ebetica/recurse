#!/usr/bin/env bun
/**
 * create --title "short-name" [--effort 1-5] [--sibling | --remote <label>] [--taken-over] [--worktree <name> [--worktree-source <path>] [--commit <ref>]] "<task>"
 *     Starts in your cwd and can't see your conversation: give it the complete
 *     task. Its final message comes back to you automatically. Creation can be
 *     slow; don't repeat a pending create. --sibling: under your parent.
 *     --worktree: a managed checkout from cwd or --worktree-source (--commit
 *     defaults to HEAD). --taken-over: the operator controls it; its replies
 *     aren't reported to you. --remote: top-level on a connected backend;
 *     returns id@label and sends no report back.
 * send <id|id@label> [--interrupt] "<message>"
 *     Waits until delivered, queued, failed or not confirmed; an idle agent
 *     starts a turn. Reply to remote senders with the full id@label from their
 *     header. --interrupt stops the current turn first.
 * interrupt <id|id@label>
 *     Stops its turn and its background jobs.
 * status [<id|id@label> ...] [--subtree] [--json]
 * idle [<id|id@label>] [--wait S]
 *     Exit 0 if the subtree is idle; otherwise print busy ids and exit 1.
 * wait <id|id@label> ... [--timeout S]
 * tail <id|id@label>
 * read <id@label> [--offset N] [--limit N]
 *     A remote agent's transcript. For local agents, read their transcript.txt.
 * search <query> [target] [--tree | --all] [--deleted] [--role <role>] [--limit N]
 *     Literal, case-insensitive search of full transcripts; defaults to yours.
 *     Runs until complete or the limit; interrupt to cancel. --deleted is slow
 *     across all deleted agents; prefer a target.
 * compact <id|id@label>
 * move <id> --to <parent-id>
 * tag <id> [--add a,b] [--remove a,b]
 * rm <id|id@label> ...
 *     Deletes each agent and its subtree; one id at a time is safest.
 * revive <id-or-query | --from PATH> [--top-level | --parent <id>]
 *     Restore a deleted agent (or import an archive/session file) idle under you.
 */
// Agent-tree HTTP commands; the leading JSDoc is the canonical help source.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ensureNamedWorktree,
  requestReapSweep,
  resolveWorktreeSource,
  rootFromEnv,
} from "./worktree.ts";
import { cleanTitle } from "../src/title_text";
import { validBackendLabel } from "../src/backends/label";
import { toolHelp } from "./_help.ts";

import {
  codePointSlice,
  isObject,
  jsonLine,
  jsonParse,
  oneLine,
  pyTruthy,
  pythonStrip,
  renderWindow,
  summarizeArgs,
  textBlocks,
  type JsonObject,
  type Row,
} from "../src/agents/durable/message_projection";
type Output = { code: number; stdout: string; stderr: string };

import {
  CliFailure,
  parseArguments,
  parseFloatPython,
  parserFailure,
  systemFailure,
  type Parsed,
} from "./subagent_args";

const MODULE_HELP = toolHelp(import.meta.url);
const DATA = process.env.CHAT_DATA_DIR
  ? resolve(process.env.CHAT_DATA_DIR)
  : resolve(process.cwd(), ".recurse-data");
const SPAWN_WAIT_SECONDS = 5;
/** Pages of 50 rows tail reads back to find the newest user message. */
const MSG_TAIL_PAGES = 40;
const MSG_TAIL_FALLBACK_ENTRIES = 10;
const WAIT_POLL_SECONDS = 2;
const IDLE_POLL_SECONDS = 5;
const WAIT_TIMEOUT_MIN = 1;
const WAIT_TIMEOUT_MAX = 86_400;

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "x-loopback-token": "",
    "x-recurse-bundled-tool": "subagent",
    "Content-Type": "application/json",
  };
  const agentId = process.env.RECURSE_AGENT_ID;
  if (agentId) headers["x-recurse-agent"] = agentId;
  return headers;
}

async function api<T = JsonObject>(
  method: string,
  path: string,
  body?: JsonObject,

  answered: readonly number[] = [],
  signal?: AbortSignal | null,
  maxResponseBytes?: number,
): Promise<T> {
  let published: unknown;
  try {
    published = jsonParse(readFileSync(join(DATA, "server.json"), "utf8"));
  } catch {
    systemFailure(
      "No running instance found (server.json is missing). Start one with ./recurse <target> first.",
    );
  }
  if (!isObject(published))
    systemFailure(
      "No running instance found (server.json is missing). Start one with ./recurse <target> first.",
    );
  const port = published.port;
  const token = published.token;
  if (!port || !token)
    systemFailure(
      "No running instance found (server.json is missing). Start one with ./recurse <target> first.",
    );
  const headers = apiHeaders();
  headers["x-loopback-token"] = String(token);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal:
        signal === undefined
          ? AbortSignal.timeout(20_000)
          : (signal ?? undefined),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "timed out"
        : error instanceof Error
          ? error.message
          : String(error);
    systemFailure(`Cannot reach the instance: ${reason}`);
  }
  let text: string;
  if (maxResponseBytes !== undefined && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxResponseBytes)
          systemFailure("backend response too large; try a smaller --limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    text = new TextDecoder().decode(new Uint8Array(Buffer.concat(chunks)));
  } else text = await response.text();
  if (!response.ok && !answered.includes(response.status)) {
    systemFailure(
      `Request failed (${response.status}): ${codePointSlice(text, 300)}`,
    );
  }
  if (!text) return {} as T;
  let loaded: unknown;
  try {
    loaded = JSON.parse(text);
  } catch {
    systemFailure(`Request failed: invalid response for ${path}`);
  }
  if (!isObject(loaded) && !Array.isArray(loaded))
    systemFailure(`Request failed: invalid response for ${path}`);
  return loaded as T;
}

function convPath(cid: string): string {
  return join(DATA, "conversations", `${cid}.json`);
}

function backendFor(target: string, archives = false) {
  const match = /^([^@]+)@([A-Za-z0-9._-]{1,32})$/.exec(target);
  if (
    target.includes("@") &&
    (!match ||
      !validBackendLabel(match[2]) ||
      (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(match[1]!) &&
        !(
          archives &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[A-Za-z0-9][A-Za-z0-9_-]{0,170}$/.test(
            match[1]!,
          )
        )))
  )
    systemFailure("invalid remote target");
  const id = match ? match[1]! : target;
  const base = match ? `/api/backends/${encodeURIComponent(match[2]!)}` : "";
  return {
    id,
    remote: !!match,
    path: (path: string) => (match ? base + path.slice(4) : path),
  };
}

async function loadConv(cid: string): Promise<JsonObject> {
  const backend = backendFor(cid);
  if (backend.remote)
    return api("GET", backend.path(`/api/conversations/${backend.id}`));
  const path = convPath(cid);
  if (existsSync(path)) {
    let loaded: unknown;
    try {
      loaded = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw error;
    }
    if (!isObject(loaded))
      systemFailure(
        `Agent row file for '${cid}' is corrupt (expected an object).`,
      );
    return loaded;
  }
  try {
    return await api("GET", `/api/conversations/${cid}`);
  } catch (error) {
    if (error instanceof CliFailure) {
      throw new CliFailure(
        error.message,
        error.code,
        ``,
        `No such agent '${cid}': no row file and no live conversation.\n${error.stderr}`,
      );
    }
    throw error;
  }
}

function activeRunId(conv: JsonObject | null): string | null {
  if (!conv) return null;
  const value = conv.active_run;
  if (
    (typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))) &&
    typeof value !== "boolean" &&
    value !== ""
  )
    return String(value);
  let active: unknown = conv.active_turn;
  if (!pyTruthy(active)) active = {};
  if (!isObject(active)) active = {};
  const turn = active as JsonObject;
  const runId = turn.run_id;
  if (
    (typeof runId === "string" ||
      (typeof runId === "number" && Number.isFinite(runId))) &&
    typeof runId !== "boolean" &&
    runId !== ""
  )
    return String(runId);
  const startedAt = turn.started_at;
  if (
    (typeof startedAt === "string" ||
      (typeof startedAt === "number" && Number.isFinite(startedAt))) &&
    typeof startedAt !== "boolean" &&
    startedAt !== ""
  )
    return `legacy:${startedAt}`;
  return pyTruthy(active) || conv.status === "running"
    ? "legacy:running"
    : null;
}

async function runGit(args: string[], cwd: string): Promise<[number, string]> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    return [result.exitCode, result.stdout.toString().trim()];
  } catch {
    return [1, ""];
  }
}

async function lastCommitText(workdir: unknown): Promise<string> {
  if (typeof workdir !== "string" || !workdir) return "(unknown directory)";
  if (!existsSync(workdir)) return "(directory unavailable)";
  try {
    if (!statSync(workdir).isDirectory()) return "(directory unavailable)";
  } catch {
    return "(directory unavailable)";
  }
  try {
    const [code] = await runGit(["rev-parse", "--show-toplevel"], workdir);
    if (code !== 0) return "(not a git repository)";
  } catch {
    return "(git unavailable)";
  }
  try {
    const [code, out] = await runGit(
      ["log", "-1", "--oneline", "--no-decorate"],
      workdir,
    );
    if (code !== 0 || !out) return "(no commits yet)";
    return out;
  } catch {
    return "(git unavailable)";
  }
}

async function enterChildWorktree(
  name: string,
  cid: string,
  sourcePath?: string,
  commit?: string,
): Promise<string> {
  if (!name) parserFailure("create --worktree needs a name");
  const cwd = process.cwd();
  let source: string;
  try {
    source = resolveWorktreeSource(
      sourcePath === undefined ? cwd : resolve(sourcePath),
    );
  } catch {
    throw new CliFailure(
      sourcePath === undefined
        ? "create --worktree requires your cwd to be inside a git repository: it forks the child's worktree from this checkout.\n"
        : "create --worktree-source must be a real, non-symlink, non-bare Git checkout top level; choose the repository root, not a subdirectory.\n",
    );
  }
  const root = rootFromEnv(process.env.WORKTREE_ROOT || DATA);
  let path;
  try {
    path = await ensureNamedWorktree(root, cid, name, cwd, {
      source,
      commit,
      creating: true,
    });
  } catch (error) {
    throw new CliFailure(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  if (path === null)
    throw new CliFailure(
      `Could not create worktree '${name}'; try another name.\n`,
    );
  return path;
}

async function waitForSpawn(
  cid: string,
  timeout: number,
): Promise<JsonObject | null> {
  const deadline = performance.now() / 1000 + Math.max(0, timeout);
  while (true) {
    const backend = backendFor(cid);
    const outcome = await api(
      "GET",
      backend.path(`/api/conversations/${backend.id}/spawn-outcome`),
    );
    if (outcome.status === "accepted" || outcome.status === "rejected") {
      await api(
        "POST",
        backend.path(`/api/conversations/${backend.id}/spawn-outcome/observe`),
      );
      return outcome;
    }
    if (performance.now() / 1000 >= deadline) return null;
    await Bun.sleep(50);
  }
}

async function cmdCreate(parsed: Parsed, stdout: string): Promise<string> {
  const titleRaw = parsed.options.get("--title");
  const title = cleanTitle(titleRaw);
  if (title === null)
    parserFailure(
      "--title is required; use a short kebab-case name like 'sidebar-design'",
    );
  const remote = parsed.options.get("--remote");
  if (typeof remote === "string") {
    if (parsed.options.has("--taken-over"))
      parserFailure("create", "--remote cannot be combined with --taken-over");
    if (
      ["--sibling", "--worktree", "--worktree-source", "--commit"].some(
        (flag) => parsed.options.has(flag),
      )
    )
      parserFailure(
        "--remote cannot be combined with sibling or worktree options",
      );
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const target = `${id}@${remote}`;
    const backend = backendFor(target);
    const req: JsonObject = { id, title, prompt: parsed.positional[0]! };
    const effort = parsed.options.get("--effort");
    if (typeof effort === "string") req.effort = Number(effort);
    await api("POST", backend.path("/api/conversations/spawn"), req);
    const outcome = await waitForSpawn(target, SPAWN_WAIT_SECONDS);
    if (outcome?.status === "rejected")
      throw new CliFailure(
        `Could not create ${target}: ${String(outcome.message)}\n`,
      );
    return `${stdout}Spawn ${outcome ? "accepted" : "queued"}: remote agent ${target}. No automatic parent report is sent.\n`;
  }
  const caller = process.env.RECURSE_AGENT_ID || null;
  const sibling = parsed.options.has("--sibling");
  let parent: unknown = caller;
  if (sibling && caller !== null) {
    const callerConv = await loadConv(caller);
    parent = callerConv.parent;
    if (parent !== null && typeof parent !== "string")
      parserFailure("the calling agent has an invalid parent");
  }
  const cid = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  let workdir: string | null = null;
  const worktreeValue = parsed.options.get("--worktree");
  if (typeof worktreeValue === "string")
    workdir = await enterChildWorktree(
      worktreeValue,
      cid,
      parsed.options.get("--worktree-source") as string | undefined,
      parsed.options.get("--commit") as string | undefined,
    );
  const req: JsonObject = {
    id: cid,
    parent,
    title,
    prompt: parsed.positional[0]!,
  };
  const takenOver = parsed.options.has("--taken-over");
  if (takenOver) req.taken_over = true;
  if (workdir !== null) req.workdir = workdir;
  if (sibling) {
    req.sibling = true;
    req.creator = caller;
  }
  const effortRaw = parsed.options.get("--effort");
  const effort = typeof effortRaw === "string" ? Number(effortRaw) : undefined;
  if (effort !== undefined) req.effort = effort;
  try {
    await api("POST", "/api/conversations/spawn", req);
  } catch (error) {
    if (
      !(
        error instanceof CliFailure &&
        /timed out|TimeoutError/.test(error.message)
      )
    )
      throw error;
  }
  let timeout = Number(
    process.env.RECURSE_SPAWN_WAIT_SECONDS ?? SPAWN_WAIT_SECONDS,
  );
  if (Number.isNaN(timeout)) timeout = SPAWN_WAIT_SECONDS;
  timeout = Math.min(Math.max(timeout, 0), 15);
  const outcome = await waitForSpawn(cid, timeout);
  const picked = effort ? ` at effort level ${effort}` : "";
  const wtnote = workdir !== null ? ` in ${workdir}` : "";
  if (takenOver && outcome?.status !== "rejected")
    return `${stdout}Spawn ${outcome ? "accepted" : "queued"}: taken-over agent ${cid}${picked}${wtnote}; the operator controls it; its replies are not reported to you.\n`;
  if (outcome === null)
    return `${stdout}Spawn queued: subagent ${cid}${wtnote}. Please wait for the agent to spawn.\n`;
  if (outcome.status === "rejected") {
    const msg =
      typeof outcome.message === "string" && outcome.message
        ? outcome.message
        : "The spawn request was rejected. Retry after checking the parent.";
    throw new CliFailure(`Could not create subagent ${cid}: ${msg}\n`);
  }
  if (parent === null || parent === undefined) {
    const kind = sibling && caller ? "top-level sibling" : "top-level agent";
    return `${stdout}Spawn accepted: ${kind} ${cid}${picked}${wtnote}.\n`;
  }
  const kind = sibling ? "sibling" : "subagent";
  const destination = sibling ? `to parent ${parent}` : "back to you";
  return `${stdout}Spawn accepted: ${kind} ${cid} (parent ${parent})${picked}${wtnote}. Its final message will be delivered ${destination} when it finishes.\n`;
}

async function cmdSend(parsed: Parsed, stdout: string): Promise<string> {
  const [cid, message] = parsed.positional;
  if (cid!.includes("@")) {
    const [agent, label] = cid!.split("@");
    const unconfirmed = `Not confirmed: the connection to ${label} dropped during delivery; the message may have arrived. Check \`subagent read ${agent}@${label}\` before resending.\n`;
    let result: JsonObject;
    try {
      result = await api(
        "POST",
        "/api/relay/messages",
        {
          target: cid,
          content: message,
          interrupt: parsed.options.has("--interrupt"),
        },
        Array.from({ length: 200 }, (_, i) => 400 + i),
      );
    } catch {
      return unconfirmed;
    }
    if (typeof result.id !== "string")
      return `Failed: ${String(result.detail ?? "delivery refused").replace(/\.$/, "")}.\n`;
    const deadline = performance.now() + 100_000;
    while (performance.now() < deadline) {
      let outcome: JsonObject;
      try {
        outcome = await api(
          "GET",
          `/api/relay/messages/${result.id}?wait=25`,
          undefined,
          [],
          AbortSignal.timeout(
            Math.min(30_000, Math.max(1, deadline - performance.now())),
          ),
        );
      } catch {
        return unconfirmed;
      }
      if (outcome.state === "delivered") return `Delivered to ${cid}.\n`;
      if (outcome.state === "failed" || outcome.state === "queued")
        return `${outcome.state === "failed" ? "Failed" : "Queued"}: ${String(outcome.reason).replace(/\.$/, "")}.\n`;
      if (outcome.state === "unconfirmed") return unconfirmed;
    }
    return unconfirmed;
  }
  try {
    await loadConv(cid!);
  } catch (error) {
    if (
      error instanceof CliFailure &&
      error.stderr.includes("Request failed (404)")
    ) {
      const address = await recentRemoteSender(cid!);
      if (address) {
        const label = address.split("@")[1]!;
        throw new CliFailure(
          `No local agent ${cid}; it messaged you from ${label}, so run: bun $RECURSE_SRC/tools/subagent.ts send ${address} "<message>"\n`,
        );
      }
    }
    throw error;
  }
  const interrupt = parsed.options.has("--interrupt");
  const delivered = await api("POST", `/api/conversations/${cid}/deliver`, {
    content: message,
    interrupt,
  });
  if (interrupt) {
    const action =
      delivered.interrupted === true
        ? "Stopped the running turn; the message will run next."
        : "There was no running turn to stop; the message will start fresh.";
    return `${stdout}Message delivered to agent ${cid}. ${action} The turn's reply will be delivered to its parent when it finishes; read the agent's transcript.txt for the full history meanwhile.\n`;
  }
  return `${stdout}Message delivered to agent ${cid}; it will pick it up within a moment. The turn's reply will be delivered to its parent when it finishes; read the agent's transcript.txt for the full history meanwhile.\n`;
}

async function cmdInterrupt(parsed: Parsed, stdout: string): Promise<string> {
  const cid = parsed.positional[0]!;
  const conv = await loadConv(cid);
  const target = activeRunId(conv);
  if (conv.status !== "running" || !target) {
    return `${stdout}Agent ${cid} has no running turn to interrupt (status: ${conv.status ?? "unknown"}).\n`;
  }
  const backend = backendFor(cid);
  await api("POST", backend.path(`/api/conversations/${backend.id}/deliver`), {
    run_id: target,
    stop_id: crypto.randomUUID().replaceAll("-", ""),
  });
  return `${stdout}Interrupt accepted for agent ${cid}, run ${codePointSlice(String(target), 8)}; status: stopping. Background cleanup completion/failure will appear as a platform record in the target thread; no replacement turn starts.\n`;
}

async function loadAllConvs(): Promise<Map<string, JsonObject>> {
  const payload = await api("GET", "/api/subagent-tool/conversations");
  if (!Array.isArray(payload.conversations))
    systemFailure("The running instance returned an invalid agent index.");
  const out = new Map<string, JsonObject>();
  for (const row of payload.conversations) {
    if (!isObject(row) || typeof row.id !== "string")
      systemFailure("The running instance returned an invalid agent index.");
    out.set(row.id, row);
  }
  return out;
}

function descendantIds(
  convs: Map<string, JsonObject>,
  cid: string,
): Set<string> {
  const kids = new Map<string, string[]>();
  for (const conv of convs.values()) {
    const parent = conv.parent;
    if (!pyTruthy(parent)) continue;
    if (typeof parent !== "string" || typeof conv.id !== "string")
      systemFailure("The running instance returned an invalid agent index.");
    const rows = kids.get(parent) ?? [];
    rows.push(conv.id);
    kids.set(parent, rows);
  }
  const seen = new Set([cid]);
  const stack = [...(kids.get(cid) ?? [])];
  const out = new Set<string>();
  while (stack.length) {
    const child = stack.pop()!;
    if (seen.has(child)) continue;
    seen.add(child);
    out.add(child);
    stack.push(...(kids.get(child) ?? []));
  }
  return out;
}

async function cmdMove(parsed: Parsed, stdout: string): Promise<string> {
  const cid = parsed.positional[0]!;
  const newParent = parsed.options.get("--to") as string;
  if (newParent === cid)
    throw new CliFailure("Cannot move an agent under itself.\n");
  const convs = await loadAllConvs();
  if (!convs.has(cid)) throw new CliFailure(`No such agent '${cid}'.\n`);
  if (!convs.has(newParent))
    throw new CliFailure(`No such target agent '${newParent}'.\n`);
  if (descendantIds(convs, cid).has(newParent)) {
    throw new CliFailure(
      `Cannot move '${cid}' under its own descendant '${newParent}' (would create a cycle).\n`,
    );
  }
  if (convs.get(cid)!.parent === newParent)
    return `${stdout}Agent ${cid} is already a child of ${newParent}; nothing to do.\n`;
  await api("POST", `/api/conversations/${cid}/reparent`, {
    parent: newParent,
  });
  return `${stdout}Move requested: agent ${cid} (and its subtree) will be re-parented under ${newParent}; its worktree is unchanged.\n`;
}

async function cmdTag(parsed: Parsed, stdout: string): Promise<string> {
  const cid = parsed.positional[0]!;
  const list = (flag: string) =>
    String(parsed.options.get(flag) ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  const add = list("--add");
  const remove = list("--remove");
  if (!add.length && !remove.length)
    parserFailure("tag", "give --add or --remove with at least one tag");
  await api("POST", `/api/conversations/${cid}/tags`, { add, remove });
  const changes = [...add.map((t) => `+${t}`), ...remove.map((t) => `-${t}`)];
  return `${stdout}Tags changed on ${cid}: ${changes.join(" ")}\n`;
}

function targetLabel(conv: JsonObject): string {
  const title = conv.title;
  return typeof title === "string" && pythonStrip(title)
    ? `${String(conv.id)} (${codePointSlice(pythonStrip(title), 256)})`
    : String(conv.id);
}

async function resolveTarget(
  target: string,
  optional = false,
): Promise<JsonObject | null> {
  const convs = await loadAllConvs();
  const unique = (matches: JsonObject[], kind: string): JsonObject | null => {
    if (!matches.length) return null;
    if (matches.length > 1) {
      const names = matches.map(targetLabel).sort().join(", ");
      parserFailure(`ambiguous ${kind} '${target}': ${names}`);
    }
    return matches[0]!;
  };
  const exact = convs.get(target);
  if (exact) return exact;
  const active = unique(
    [...convs.values()].filter((conv) => conv.session_id === target),
    "active session id",
  );
  if (active) return active;
  const named = unique(
    [...convs.values()].filter(
      (conv) =>
        typeof conv.title === "string" && pythonStrip(conv.title) === target,
    ),
    "session name",
  );
  if (named) return named;
  const suffix = unique(
    [...convs.values()].filter(
      (conv) => typeof conv.id === "string" && conv.id.endsWith(target),
    ),
    "id suffix",
  );
  if (suffix) return suffix;
  if (optional) return null;
  parserFailure(`no agent or active Pi session matches '${target}'`);
}

function fmtElapsed(value: unknown): string {
  if (
    typeof value === "boolean" ||
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  )
    return "?";
  const total = Math.trunc(value);
  if (total < 60) return `${total}s`;
  let minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m${secs}s`;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  return `${hours}h${minutes}m`;
}

/** The background-shell lines of tail, from the instance's index row. */
function shellMetaLines(shells: unknown): JsonObject[] {
  const base: JsonObject = { off: 0, ts: null, role: "meta", tool: "shell" };
  if (!Array.isArray(shells))
    return [{ ...base, text: "(background shells unavailable)" }];
  const rows = shells.filter(isObject).slice(0, 20);
  if (!rows.length) return [{ ...base, text: "(none)" }];
  return rows.map((item) => ({
    ...base,
    text: `${typeof item.id === "string" ? item.id : "?"} (${typeof item.mode === "string" ? item.mode : "?"}, ${fmtElapsed(item.elapsed_seconds)}) ${typeof item.command === "string" ? oneLine(item.command, 200) : ""}`.trim(),
  }));
}

function selectExchange(rows: Row[]): Row[] {
  for (let idx = rows.length - 1; idx >= 0; idx--) {
    const entry = rows[idx]![1];
    if (
      entry.type === "message" &&
      isObject(entry.message) &&
      entry.message.role === "user"
    )
      return rows.slice(idx);
  }
  return rows.length ? rows.slice(-MSG_TAIL_FALLBACK_ENTRIES) : [];
}

type Window = { rows: Row[]; prev: number; next: number };

/** One transcript window of `cid` from the running instance. */
async function transcript(
  cid: string,
  query: Record<string, number | undefined>,
): Promise<Window> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query))
    if (value !== undefined) params.set(name, String(value));
  const backend = backendFor(cid);
  const path = backend.path(
    `/api/subagent-tool/conversations/${encodeURIComponent(backend.id)}/transcript?${params}`,
  );
  return (await api("GET", path)) as unknown as Window;
}

/** Find trusted sender headers in one bounded recent transcript page. */
async function recentRemoteSender(cid: string): Promise<string | null> {
  const caller = process.env.RECURSE_AGENT_ID;
  if (!caller) return null;
  try {
    const page = await transcript(caller, { limit: 50 });
    for (const [, entry] of page.rows.reverse()) {
      if (!isObject(entry.message) || entry.message.role !== "user") continue;
      const text = textBlocks(entry.message.content)?.join("\n") ?? "";
      for (const match of text.matchAll(
        /^\[recurse-from: ([A-Za-z0-9][A-Za-z0-9_-]{0,127})@([A-Za-z0-9._-]{1,32})\]$/gm,
      )) {
        if (match[1] === cid) return `${cid}@${match[2]}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

const userRow = ([, entry]: Row) =>
  isObject(entry.message) && entry.message.role === "user";

async function emitTail(
  conv: JsonObject,
  target = String(conv.id),
): Promise<{ stdout: string; stderr: string }> {
  const workdir = String(conv.workdir || "(unknown)");
  let stdout = jsonLine({
    off: 0,
    ts: null,
    role: "meta",
    tool: "cwd",
    text: workdir,
  });
  for (const line of shellMetaLines(conv.shells)) stdout += jsonLine(line);
  stdout += jsonLine({
    off: 0,
    ts: null,
    role: "meta",
    tool: "commit",
    text: backendFor(target).remote
      ? "(remote)"
      : await lastCommitText(workdir),
  });
  let rows: Row[] = [];
  try {
    let before: number | undefined;
    for (let page = 0; page < MSG_TAIL_PAGES; page++) {
      const got = await transcript(target, { limit: 50, before });
      rows = [...got.rows, ...rows];
      if (got.rows.some(userRow) || got.prev <= 0 || got.prev === before) break;
      before = got.prev;
    }
  } catch (error) {
    if (!(error instanceof CliFailure)) throw error;
    const reason = pythonStrip(error.stderr.split("\n", 1)[0]!);
    return { stdout, stderr: `(tail: ${reason} — showing context only)\n` };
  }
  for (const line of renderWindow(selectExchange(rows), false))
    stdout += jsonLine(line);
  return { stdout, stderr: "" };
}

async function cmdRead(parsed: Parsed): Promise<Output> {
  const backend = backendFor(parsed.positional[0]!, true);
  if (!backend.remote)
    parserFailure(
      "read",
      "use the native read tool on local transcript paths; read requires id@label",
    );
  const query = new URLSearchParams({ target: backend.id });
  for (const flag of ["--offset", "--limit"])
    if (parsed.options.has(flag))
      query.set(flag.slice(2), String(parsed.options.get(flag)));
  const path = backend.path(`/api/subagent-tool/read?${query}`);
  const result = await api(
    "GET",
    path,
    undefined,
    [],
    undefined,
    2 * 1024 * 1024,
  );
  if (typeof result.text !== "string")
    systemFailure(`Request failed: invalid response for ${path}`);
  return { code: 0, stdout: result.text, stderr: "" };
}

async function cmdTail(parsed: Parsed, stdout: string): Promise<Output> {
  const target = parsed.positional[0]!;
  const conv = backendFor(target).remote
    ? await loadConv(target)
    : (await resolveTarget(target))!;
  const result = await emitTail(
    conv,
    backendFor(target).remote ? target : String(conv.id),
  );
  return { code: 0, stdout: stdout + result.stdout, stderr: result.stderr };
}

function resolveWaitCids(
  convs: Map<string, JsonObject>,
  cids: string[],
): string[] {
  const resolved: string[] = [];
  for (const cid of cids) {
    if (convs.has(cid)) {
      resolved.push(cid);
      continue;
    }
    const matches = [...convs.keys()]
      .filter((candidate) => candidate.endsWith(cid))
      .sort();
    if (matches.length === 1) resolved.push(matches[0]!);
    else if (!matches.length) parserFailure(`no agent matches '${cid}'`);
    else parserFailure(`ambiguous id suffix '${cid}': ${matches.join(", ")}`);
  }
  return resolved;
}

async function cmdStatus(parsed: Parsed): Promise<Output> {
  const targets = parsed.positional.length ? parsed.positional : [""];
  let stdout = "";
  for (const target of targets) {
    const backend = backendFor(target);
    const path = backend.path(
      !target
        ? "/api/v1/agents"
        : parsed.options.has("--subtree")
          ? `/api/v1/agents?root=${encodeURIComponent(backend.id)}`
          : `/api/v1/agents/${encodeURIComponent(backend.id)}`,
    );
    const response = await api("GET", path);
    if (parsed.options.has("--json")) stdout += `${JSON.stringify(response)}\n`;
    else {
      const agents = Array.isArray(response.agents)
        ? response.agents
        : [response];
      for (const row of agents) {
        if (!isObject(row))
          systemFailure(`Request failed: invalid response for ${path}`);
        const status = [
          "idle",
          "running",
          "stopping",
          "interrupted",
          "error",
          "deleting",
        ].includes(String(row.status))
          ? row.status
          : "unknown";
        const context = isObject(row.context)
          ? `${row.context.tokens}/${row.context.window ?? "unknown"}`
          : "null";
        stdout += `${row.id} ${status} queued=${row.queued} shells=${row.background_shells} monitor_shells=${row.monitor_shells} context=${context} ${row.title}\n`;
      }
    }
  }
  return { code: 0, stdout, stderr: "" };
}

async function cmdIdle(parsed: Parsed): Promise<Output> {
  const target = parsed.positional[0] || process.env.RECURSE_AGENT_ID;
  if (!target)
    parserFailure("idle", "an agent id is required outside an agent");
  const backend = backendFor(target);
  const path = backend.path(
    `/api/v1/agents/${encodeURIComponent(backend.id)}/idle`,
  );
  const raw = parsed.options.get("--wait");
  const timeout = typeof raw === "string" ? parseFloatPython(raw) : 0;
  if (
    raw !== undefined &&
    !(WAIT_TIMEOUT_MIN <= timeout && timeout <= WAIT_TIMEOUT_MAX)
  )
    parserFailure("idle", "--wait must be between 1 and 86400 seconds");
  const deadline = performance.now() + timeout * 1000;
  let busy = "";
  const timedOut = (): Output => ({
    code: 1,
    stdout: busy,
    stderr: `Timed out after ${timeout}s waiting for ${target} to become idle.\n`,
  });
  while (true) {
    const remaining = deadline - performance.now();
    if (timeout && remaining <= 0) return timedOut();
    const signal = timeout
      ? AbortSignal.timeout(Math.min(20_000, Math.ceil(remaining)))
      : undefined;
    let response: JsonObject;
    try {
      response = await api("GET", path, undefined, [], signal);
    } catch (error) {
      if (signal?.aborted && performance.now() >= deadline) return timedOut();
      throw error;
    }
    if (timeout && performance.now() >= deadline) return timedOut();
    if (response.idle === true) return { code: 0, stdout: "", stderr: "" };
    if (response.idle !== false || !Array.isArray(response.busy))
      systemFailure("Request failed: invalid idle response");
    busy = response.busy.map((row) => `${row.id} ${row.reason}\n`).join("");
    if (!timeout) return { code: 1, stdout: busy, stderr: "" };
    const wakeAt = Math.min(
      deadline,
      performance.now() + IDLE_POLL_SECONDS * 1000,
    );
    do {
      await Bun.sleep(Math.max(1, Math.ceil(wakeAt - performance.now())));
    } while (performance.now() < wakeAt);
  }
}

async function cmdWait(parsed: Parsed, stdout: string): Promise<Output> {
  const timeoutRaw = parsed.options.get("--timeout");
  const timeout =
    typeof timeoutRaw === "string" ? parseFloatPython(timeoutRaw) : 300;
  if (!(WAIT_TIMEOUT_MIN <= timeout && timeout <= WAIT_TIMEOUT_MAX))
    parserFailure("wait --timeout must be between 1 and 86400 seconds");
  const locals = parsed.positional.filter((cid) => !backendFor(cid).remote);
  const localResolved = locals.length
    ? resolveWaitCids(await loadAllConvs(), locals)
    : [];
  let localIndex = 0;
  const resolved = parsed.positional.map((cid) =>
    backendFor(cid).remote ? cid : localResolved[localIndex++]!,
  );
  const snapshots = async () => {
    const index = locals.length
      ? await loadAllConvs()
      : new Map<string, JsonObject>();
    for (const cid of resolved.filter((target) => backendFor(target).remote)) {
      const backend = backendFor(cid);
      const row = await api(
        "GET",
        backend.path(`/api/conversations/${backend.id}`),
        undefined,
        [404],
      );
      if (row.id) index.set(cid, row);
    }
    return index;
  };
  const deadline = performance.now() / 1000 + Math.max(0, timeout);
  let finished: string | null = null;
  while (true) {
    const index = await snapshots();
    for (const cid of resolved) {
      if (index.get(cid)?.status !== "running") {
        finished = cid;
        break;
      }
    }
    if (finished !== null) break;
    const now = performance.now() / 1000;
    if (now >= deadline) break;
    await Bun.sleep(
      Math.min(WAIT_POLL_SECONDS, Math.max(0, deadline - now)) * 1000,
    );
  }
  if (finished === null)
    throw new CliFailure(
      `Timed out after ${timeout.toLocaleString("en-US", { useGrouping: false })}s waiting for ${resolved.join(", ")} to finish.\n`,
    );
  const live = (await snapshots()).get(finished);
  if (!live)
    return {
      code: 0,
      stdout:
        stdout +
        jsonLine({
          off: 0,
          ts: null,
          role: "meta",
          tool: "status",
          text: `agent ${finished} is gone`,
        }),
      stderr: "",
    };
  const tail = await emitTail(live, finished);
  return { code: 0, stdout: stdout + tail.stdout, stderr: tail.stderr };
}

async function cmdRm(parsed: Parsed, stdout: string): Promise<string> {
  const convs = parsed.positional.some((cid) => !backendFor(cid).remote)
    ? await loadAllConvs()
    : new Map<string, JsonObject>();
  for (const cid of parsed.positional) {
    for (const candidate of [cid, ...[...descendantIds(convs, cid)].sort()]) {
      const conv = convs.get(candidate);
      if (!conv || conv.taken_over !== true) continue;
      const title = conv.title;
      const label =
        typeof title === "string" && title
          ? `${candidate} ("${title}")`
          : candidate;
      throw new CliFailure(
        `Agent ${label} is taken over by the operator; only the operator can delete it.\n`,
      );
    }
  }
  for (const cid of parsed.positional) {
    const backend = backendFor(cid);
    try {
      await api("DELETE", backend.path(`/api/conversations/${backend.id}`));
    } catch (error) {
      if (error instanceof CliFailure && error.message.includes("(404)")) {
        if (!backend.remote)
          requestReapSweep(rootFromEnv(process.env.WORKTREE_ROOT || DATA), [
            cid,
          ]);
        stdout += `Agent ${cid} is already gone.\n`;
        continue;
      }
      if (error instanceof CliFailure) {
        throw new CliFailure(error.message, error.code, stdout, error.stderr);
      }
      throw error;
    }
    if (!backend.remote)
      requestReapSweep(rootFromEnv(process.env.WORKTREE_ROOT || DATA), [
        cid,
        ...descendantIds(convs, cid),
      ]);
    const revive =
      convs.get(cid)?.backend === "durable"
        ? ` Revive the agent via subagent revive ${cid}.`
        : "";
    stdout += `Reap requested: agent ${cid} (and its subtree) will be deleted.${revive}\n`;
  }
  return stdout;
}

async function cmdSearch(parsed: Parsed): Promise<Output> {
  const all = parsed.options.has("--all");
  const target =
    parsed.positional[1] ?? (all ? undefined : process.env.RECURSE_AGENT_ID);
  if (!all && !target)
    parserFailure("search", "give a target or --all outside an agent");
  const backend = target ? backendFor(target, true) : null;
  const query = new URLSearchParams({ q: parsed.positional[0]! });
  if (target) query.set("target", backend!.id);
  for (const flag of ["--tree", "--all", "--deleted"])
    if (parsed.options.has(flag)) query.set(flag.slice(2), "true");
  for (const flag of ["--role", "--limit"])
    if (parsed.options.has(flag))
      query.set(flag.slice(2), String(parsed.options.get(flag)));
  const path = `/api/subagent-tool/search?${query}`;
  const result = await api(
    "GET",
    backend?.path(path) ?? path,
    undefined,
    [],
    null,
  );
  if (!Array.isArray(result.hits))
    systemFailure("The running instance returned invalid search results.");
  return {
    code: 0,
    stdout: result.hits
      .map((hit) => {
        if (
          !isObject(hit) ||
          typeof hit.path !== "string" ||
          !Number.isSafeInteger(hit.line) ||
          Number(hit.line) < 1 ||
          typeof hit.agent !== "string" ||
          typeof hit.snippet !== "string" ||
          typeof hit.role !== "string" ||
          typeof hit.time !== "number"
        )
          systemFailure(
            "The running instance returned invalid search results.",
          );
        const agent = backend?.remote
          ? `${hit.agent}${target!.slice(target!.lastIndexOf("@"))}`
          : hit.agent;
        const time =
          Number.isFinite(hit.time) &&
          hit.time > 0 &&
          hit.time < 8640000000000000
            ? new Date(hit.time).toISOString()
            : "-";
        return `${oneLine(hit.path, hit.path.length)}:${hit.line}: ${oneLine(hit.snippet, hit.snippet.length)} [${oneLine(agent, agent.length)} ${time} ${oneLine(hit.role, hit.role.length)}]\n`;
      })
      .join(""),
    stderr:
      (result.truncated
        ? "Search truncated; narrow the query or scope.\n"
        : "") +
      (Number(result.not_indexed) > 0
        ? `${result.not_indexed} ${result.not_indexed === 1 ? "agent is" : "agents are"} not indexed yet; results are incomplete.\n`
        : ""),
  };
}

async function cmdRevive(parsed: Parsed, stdout: string): Promise<string> {
  const from = parsed.options.get("--from");
  const target = parsed.positional[0]!;
  const parentOption = parsed.options.get("--parent");
  const parent = parsed.options.has("--top-level")
    ? null
    : typeof parentOption === "string"
      ? parentOption
      : process.env.RECURSE_AGENT_ID || null;
  const result = await api(
    "POST",
    "/api/agent-archive/revive",
    {
      ...(from === undefined ? { target } : { from: resolve(String(from)) }),
      parent,
    },
    [404, 409, 410, 422],
  );
  const refusal = result.detail;
  if (refusal !== undefined) {
    const detail = isObject(refusal)
      ? refusal
      : { message: `Could not revive '${target}': ${String(refusal)}` };
    const rows = Array.isArray(detail.candidates) ? detail.candidates : [];
    const lines = rows
      .filter(isObject)
      .map(
        (row) =>
          `  ${String(row.archive_id)}  ${String(row.title ?? row.cid)} (${row.top_level ? "top-level" : `subagent of ${String(row.parent_title ?? row.parent)}`}, ${String(row.reason)})`,
      );
    throw new CliFailure([String(detail.message), ...lines, ""].join("\n"));
  }
  const where = result.parent ? `under ${String(result.parent)}` : "top level";
  const notes = Array.isArray(result.notes) ? result.notes.map(String) : [];
  return `${stdout}Revived: agent ${String(result.id)} (${String(result.title ?? "")}) ${where} in ${String(result.workdir)}, with its history; it starts no turn until messaged.\n${notes.map((note) => `${note}\n`).join("")}`;
}

async function execute(args: string[]): Promise<Output> {
  let parsed: Parsed;
  try {
    parsed = parseArguments(args, MODULE_HELP);
  } catch (error) {
    if (error instanceof CliFailure && error.code === 0)
      return { code: 0, stdout: error.message, stderr: "" };
    throw error;
  }
  let stdout = "";
  if (["move", "revive", "tag"].includes(parsed.command)) {
    const targets = parsed.command === "create" ? [] : parsed.positional;
    if (
      targets.some((value) => value.includes("@")) ||
      String(parsed.options.get("--to") ?? "").includes("@") ||
      String(parsed.options.get("--parent") ?? "").includes("@")
    )
      systemFailure(`${parsed.command} does not support remote targets`);
  }
  switch (parsed.command) {
    case "create":
      stdout = await cmdCreate(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "send":
      stdout = await cmdSend(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "compact": {
      const backend = backendFor(parsed.positional[0]!);
      const response = await api(
        "POST",
        backend.path(
          `/api/v1/agents/${encodeURIComponent(backend.id)}/compact`,
        ),
      );
      return { code: 0, stdout: jsonLine(response), stderr: "" };
    }
    case "interrupt":
      stdout = await cmdInterrupt(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "move":
      stdout = await cmdMove(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "rm":
      stdout = await cmdRm(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "tag":
      stdout = await cmdTag(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "revive":
      stdout = await cmdRevive(parsed, stdout);
      return { code: 0, stdout, stderr: "" };
    case "search":
      return await cmdSearch(parsed);
    case "read":
      return await cmdRead(parsed);
    case "status":
      return await cmdStatus(parsed);
    case "idle":
      return await cmdIdle(parsed);
    case "tail":
      return await cmdTail(parsed, stdout);
    case "wait":
      return await cmdWait(parsed, stdout);
    default:
      throw new Error(`unknown command ${parsed.command}`);
  }
}

async function main(): Promise<void> {
  let output: Output;
  try {
    output = await execute(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliFailure)
      output = { code: error.code, stdout: error.stdout, stderr: error.stderr };
    else
      output = {
        code: 1,
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
  }
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  process.exitCode = output.code;
}

if (import.meta.main) await main();

export { renderWindow, summarizeArgs, fmtElapsed, selectExchange };
