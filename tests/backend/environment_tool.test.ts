import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as auth from "../../src/web/request_auth";
import { Router } from "../../src/web/router";
import { registerTreeRoutes, type TreeRoutesDeps } from "../../src/web/tree";
import * as durable from "./fixtures/durable_host/host";
import { serveOpen } from "./http_open_app";

const root = await mkdtemp(join(tmpdir(), "env-tool-"));
const data = join(root, "data");
const world = durable.fauxHost(data);
const router = new Router();
const served = await serveOpen(router, data);
registerTreeRoutes(router, {
  loopbackAuthenticated: (ex) =>
    auth.loopbackAuthenticated(ex, served.loopbackToken),
  changeEnvironment: async (cid, change) =>
    cid === "c1" ? world.host.changeEnvironment(cid, change) : null,
} as Partial<TreeRoutesDeps> as TreeRoutesDeps);
await auth.publishLoopbackToken(data, served.running.port);

afterAll(async () => {
  await served.running.close();
  await world.host.close();
  await rm(root, { recursive: true, force: true });
});

test("native env set, unset, list, and file load reach the next bash call", async () => {
  await writeFile(
    join(world.work, "vars.env"),
    'FROM_FILE=one\nexport MULTI="a\\nb"\nGONE=x\n',
  );
  await writeFile(join(world.work, "protected.env"), "PI_SAFETY_OFF=1\n");
  const commands: Record<string, string | string[]>[] = [
    { action: "load", path: "vars.env" },
    { action: "set", name: "SET_VAR", value: "it's set" },
    { action: "set", name: "__proto__", value: "retained" },
    { action: "set", name: "RECURSE_WORKSPACE_ROOT", value: "/" },
    { action: "load", path: "protected.env" },
    { action: "unset", names: ["GONE", "ABSENT"] },
    { action: "list" },
  ];
  const check =
    'printf \'%s|%s|%s|%s|%s|%s\' "$FROM_FILE" "$MULTI" "$SET_VAR" "${GONE-none}" "${PI_SAFETY_OFF-none}" "$__proto__"';
  let outputs: string[] = [];
  let seen = "";
  world.faux.setResponses([
    ...commands.map((args, index) =>
      fauxAssistantMessage(
        [fauxToolCall("env", args, { id: `env-${index}` })],
        { stopReason: "toolUse" },
      ),
    ),
    (request) => {
      outputs = request.messages
        .filter((message) => message.role === "toolResult")
        .map((message: any) => message.content[0].text);
      return fauxAssistantMessage(
        [fauxToolCall("bash", { command: check }, { id: "check" })],
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      seen = (request.messages.at(-1) as any).content[0].text;
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  const opened = await world.host.open("c1");
  const safety = await import(
    new URL("../../src/extensions/core/safety/durable.ts", import.meta.url).href
  );
  await safety.setSafetyReviewOff(opened.conversation, true, context);
  await world.host.send("c1", "set variables", "r1");
  await opened.conversation.waitForIdle(context);
  expect(outputs.slice(0, 2)).toEqual([
    "Set FROM_FILE, MULTI, GONE.",
    "Set SET_VAR.",
  ]);
  expect(outputs[2]).toBe("Set __proto__.");
  expect(outputs[3]).toContain(
    "RECURSE_WORKSPACE_ROOT is set by Recurse and cannot be overridden.",
  );
  expect(outputs[4]).toContain(
    "PI_SAFETY_OFF is set by Recurse and cannot be overridden.",
  );
  expect(outputs.slice(5)).toEqual([
    "Unset GONE.\nABSENT had no override. An ambient default may still remain.",
    "FROM_FILE=***\nMULTI=***\nSET_VAR=***\n__proto__=***",
  ]);
  expect(seen).toBe("one|a\nb|it's set|none|none|retained");
}, 30_000);

test("of two concurrent loads that together exceed the limit, one is refused", async () => {
  const big = (name: string) => ({
    set: Object.fromEntries(
      Array.from({ length: 4 }, (_, i) => [`${name}_${i}`, "x".repeat(10_000)]),
    ),
    unset: [],
  });
  const results = await Promise.all(
    ["BIG_A", "BIG_B"].map((name) =>
      world.host.changeEnvironment("c1", big(name)),
    ),
  );
  const refused = results.filter((result) => "refused" in result);
  expect(refused).toEqual([
    { refused: "Environment override state is too large." },
  ]);
  const list = { set: {}, unset: [] };
  const { names } = (await world.host.changeEnvironment("c1", list)) as {
    names: string[];
  };
  expect(names.filter((name) => name.startsWith("BIG_"))).toHaveLength(4);
});

test("the route needs the loopback token and a Durable calling agent", async () => {
  const url = `http://127.0.0.1:${served.running.port}/api/agent-environment`;
  const agent = { "x-recurse-agent": "c1" };
  expect((await fetch(url, { headers: agent })).status).toBe(403);
  const token = { "x-loopback-token": served.loopbackToken };
  const other = { ...token, "x-recurse-agent": "c2" };
  expect((await fetch(url, { headers: other })).status).toBe(404);
});
