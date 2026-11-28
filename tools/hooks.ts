#!/usr/bin/env bun
/**
 * list [--agent <id>] | run <file> --event <name> --input <json file>
 *
 * A hook is a Pi extension file (`export default function (pi) { pi.on(...) }`)
 * that runs when a run starts (`before_agent_start`), on model requests
 * (`context`), tool calls (`tool_call`), results (`tool_result`), answers
 * (`agent_before_settle`, `agent_settled`) and compactions
 * (`session_before_compact`); see src/extensions/extra/hooks/README.md. An
 * agent's local hooks are the .ts files in $CHAT_DATA_DIR/hooks/agents/<id>/;
 * add, edit or remove them with your file tools, for yourself or another
 * agent. They run before the operator's global hooks; a block ends the chain.
 *   list: the files that run for an agent (default: you), in order, with
 *     their events (known once a file has run) and last failure.
 *   run: run one hook file once for an event and print its result; the input
 *     file holds the event's fields, e.g. {"toolName":"bash","input":{...}}.
 *     It runs with your environment, overrides included; real runs don't.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runHook } from "../src/extensions/extra/hooks";
import { toolHelp } from "./_help.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function list(agent: string) {
  const data = process.env.CHAT_DATA_DIR ?? fail("CHAT_DATA_DIR is not set.");
  const server = JSON.parse(
    await readFile(join(data, "server.json"), "utf8").catch(() =>
      fail("No running instance found (server.json is missing)."),
    ),
  ) as { port?: number; token?: string };
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/hooks-tool/list?agent=${encodeURIComponent(agent)}`,
    {
      headers: {
        "x-loopback-token": String(server.token),
        "x-recurse-bundled-tool": "hooks",
      },
      signal: AbortSignal.timeout(20_000),
    },
  ).catch((error: Error) =>
    fail(`Cannot reach the instance: ${error.message}`),
  );
  const body = (await response.json().catch(() => ({}))) as {
    detail?: string;
    enabled?: boolean;
    files?: {
      scope: string;
      path: string;
      events?: string[];
      unsupported?: string[];
      failure?: { at: number; error: string };
    }[];
  };
  if (!response.ok) fail(body.detail ?? `HTTP ${response.status}`);
  if (!body.enabled) console.log('Hooks are off ("Run hooks" in Settings).');
  if (!body.files?.length) return console.log(`No hooks run for ${agent}.`);
  for (const file of body.files) {
    console.log(`${file.scope}  ${file.path}`);
    console.log(
      `  events: ${file.events ? file.events.join(", ") || "none" : "not loaded yet"}`,
    );
    if (file.unsupported?.length)
      console.log(`  not supported: ${file.unsupported.join(", ")}`);
    if (file.failure)
      console.log(
        `  last failure (${new Date(file.failure.at).toISOString()}): ${file.failure.error}`,
      );
  }
}

async function run(file: string, event: string, input: string) {
  const payload = JSON.parse(await readFile(input, "utf8")) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    fail("The input file must hold a JSON object.");
  const outcome = await runHook({
    file: resolve(file),
    event,
    payload: payload as Record<string, unknown>,
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    agentId: process.env.RECURSE_AGENT_ID ?? "",
    own: async () => {},
    release: async (proc) => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
      return true;
    },
  }).catch((error: Error) => fail(`Hook failed: ${error.message}`));
  console.log(JSON.stringify(outcome, null, 2));
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: "string" },
    event: { type: "string" },
    input: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, file] = positionals;
if (values.help || !command) console.log(toolHelp(import.meta.url));
else if (command === "list" && positionals.length === 1)
  await list(
    values.agent ??
      process.env.RECURSE_AGENT_ID ??
      fail("Pass --agent <id>; RECURSE_AGENT_ID is not set."),
  );
else if (command === "run" && file && positionals.length === 2)
  await run(
    file,
    values.event ?? fail("Pass --event <name>."),
    values.input ?? fail("Pass --input <json file>."),
  );
else fail(`Usage: ${toolHelp(import.meta.url).split("\n")[0]}`);
