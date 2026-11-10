import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { setSafetyReviewOff } from "../../src/extensions/core/safety/durable";
import { publishedFiles } from "../../src/agents/runtime/attachments/published";
import * as artifacts from "../../src/artifacts";
import { held, until as durableUntil } from "./fixtures/durable_host/host";
import { buildInstance, type Instance } from "../../src/agents/instance";
import { cleanOnce, markerRecord, rootFromEnv } from "../../tools/worktree";

import { Config } from "../../src/config";
import { RECURSE_SETTINGS_SKILL } from "../../src/coding_backend/skills";
import type { RuntimeLogRecord } from "../../src/observability/runtime_logging";
import { Cancelled } from "../../src/utils/tasks";
import { TreeLifecycleBusy } from "../../src/agents/mutation_guard";
import { seedPiModelList } from "./pi_model_list_fixture";
import { AuthStorage } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { buildConversationsApp } from "./http_conversations_app";
import { conversationEvents } from "../../src/web/conversation_events";

const roots: string[] = [];
const live: Instance[] = [];
afterEach(async () => {
  while (live.length) await live.pop()!.shutdown();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function world(): Promise<{ root: string; env: Record<string, string> }> {
  const root = mkdtempSync(join(tmpdir(), "instance-test-"));
  roots.push(root);
  const target = join(root, "target");
  mkdirSync(target);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== "RECURSE_SELF_DEPLOY") env[k] = v;
  Object.assign(env, {
    CHAT_DATA_DIR: join(root, "data"),
    HOME: join(root, "home"),
    RECURSE_HOME: join(root, "settings"),
    CHAT_REPO_URL: target,
    PI_BG_SHELL: "0",
  });
  delete env.PI_CODING_AGENT_DIR;
  delete env.RECURSE_SAFETY_DIR;
  return { root, env };
}

const logs: string[] = [];
async function build(env: Record<string, string>): Promise<Instance> {
  const instance = await buildInstance({
    config: new Config({ env }),
    sink: {
      write: (r: RuntimeLogRecord) => void logs.push(`${r.name} ${r.message}`),
    },
  });
  live.push(instance);
  return instance;
}

async function until(check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(20);
  }
}

async function ready(instance: Instance): Promise<void> {
  await instance.start();
  await until(() => instance.lifecycle.readinessSnapshot().ready);
}

function managedCheckout(
  dataDir: string,
  name: string,
  holder: string,
): string {
  const checkout = join(dataDir, "worktrees", name);
  const markers = join(dataDir, "worktrees", ".markers");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(checkout, "owned.txt"), "worktree contents\n");
  writeFileSync(
    join(markers, `${name}.json`),
    JSON.stringify({
      version: 1,
      name,
      path: checkout,
      holders: { [holder]: Date.now() / 1000 - 1 },
    }),
  );
  return checkout;
}

// Regression: #2401 stale membership snapshots deleted a newly admitted adopter's cwd.
test("adopting a managed checkout protects it from an older cleanup snapshot", async () => {
  const { env } = await world();
  const instance = await build(env);
  await ready(instance);
  await instance.lifecycle.settleMaintenanceJobs();
  const checkout = managedCheckout(env.CHAT_DATA_DIR!, "adopted", "absent");
  const root = rootFromEnv(env.CHAT_DATA_DIR!);
  let cid = "";
  const result = await cleanOnce(root, async () => {
    const snapshot: [number, Set<string>, boolean, Set<string>] = [
      Date.now() / 1000,
      new Set(),
      true,
      new Set(),
    ];
    cid = String(
      (
        await instance.create.create({
          title: "new adopter",
          workdir: checkout,
        })
      ).id,
    );
    return snapshot;
  });
  expect(result).toBe("cleaned-0");
  expect(existsSync(checkout)).toBe(true);
  expect(markerRecord(root, "adopted")?.holders).toMatchObject({
    [cid]: expect.any(Number),
  });
});

// Regression: #2166 concurrent creates returned 500 rather than retryable refusal
test("concurrent operator creates return a retryable refusal, not 500", async () => {
  const { root, env } = await world();
  const instance = await build(env);
  await ready(instance);
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const refresh = instance.spawnWorkdir.refresh.bind(instance.spawnWorkdir);
  instance.spawnWorkdir.refresh = async () => {
    entered();
    await gate;
    return refresh();
  };
  const app = await buildConversationsApp(join(root, "http"), {
    patch: (deps) => {
      deps.create.create = instance.create.create.bind(instance.create);
    },
  });
  try {
    const create = () =>
      fetch(`http://127.0.0.1:${app.running.port}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    const first = create();
    await inside;
    const second = await create();
    release();
    expect((await first).status).toBe(200);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({
      detail: "Agent creation is busy. Try again shortly.",
    });
  } finally {
    release();
    await app.running.close();
  }
});

const depsOf = (owner: object): any => (owner as { deps: unknown }).deps;

// Feature: #2853 native Artifact operations work through codemode and file tools.
test("native Artifact actions expose editable paths through codemode", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  depsOf(instance.durable).models = models;
  depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
  await ready(instance);
  const artifactContext = {
    artifactsDir: instance.config.paths.ARTIFACTS_DIR,
    trashDir: instance.config.paths.TRASH_DIR,
  };
  const other = await artifacts.create(artifactContext, {
    owner: "another-agent",
    title: "Another report",
  });
  const conv = await instance.create.create({ title: "Native Artifact" });
  const cid = String(conv.id);
  const source = join(root, "target", "artifact-source.md");
  writeFileSync(source, "# Initial report\n");
  let result = "";
  const code = `
const created = JSON.parse(await tools.artifact({action:"create",title:"Report",from_file:${JSON.stringify(source)}}));
text(created);
const listed = JSON.parse(await tools.artifact({action:"list"}));
if (listed.id !== created.id || listed.path !== created.path) throw new Error("Own Artifact listing differs from creation");
text(listed);
const all = (await tools.artifact({action:"list",all:true})).split("\\n").map(JSON.parse);
if (!all.some(row => row.id === ${JSON.stringify(other.id)} && row.path.includes("/another-agent/"))) throw new Error("All Artifact listing omitted another agent");
text(all);
text(await tools.read({path:created.path+"/index.md"}));
text(await tools.write({path:created.path+"/index.md",content:"# Revised report\\n"}));
text(await tools.bash({command:'git -C "'+created.path+'" add --all && git -C "'+created.path+'" commit -m "Revise report"'}));
text(await tools.artifact({action:"rename",id:created.id,title:"Revised report"}));
text(await tools.env({action:"set",name:"ARTIFACT_SCRIPT",value:"present"}));
text(await tools.bash({command:'printf "%s" "$ARTIFACT_SCRIPT"'}));
text(await tools.recurse_settings({action:"themes"}));
text(await tools.publish({paths:[${JSON.stringify(source)}]}));
`;
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", { code }, { id: "artifact-script" }),
      { stopReason: "toolUse" },
    ),
    (request) => {
      result = JSON.stringify(request.messages.at(-1));
      return fauxAssistantMessage("Artifact is ready.");
    },
  ]);
  const opened = await instance.durable.open(cid);
  await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
  await instance.delivery.deliver(
    cid,
    "Create a report Artifact and revise it",
    { origin: "operator", messageId: "artifact" },
  );
  await opened.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const rows = (await artifacts.listArtifacts(artifactContext, cid)).artifacts;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.title).toBe("Revised report");
  const path = `$CHAT_DATA_DIR/artifact_repos/${cid}/${rows[0]!.id}`;
  expect(result).toContain(path);
  expect(result).toContain("Initial report");
  expect(result).toContain('command\\\": \\\"publish');
  expect(result).toContain("present");
  expect(result).toContain("Published artifact-source.md");
  const view = await instance.durable.view(cid);
  const script = (view.blocks as any[]).find((row) => row.name === "codemode");
  expect(script.files.map((file: any) => file.name)).toEqual([
    "artifact-source.md",
  ]);
  expect(
    (
      await publishedFiles(
        instance.agentTemp.uploadsDir(
          String(instance.conversations.load(cid)!.tmp_key),
        ),
        cid,
      )
    ).map((file) => file.name),
  ).toEqual(["artifact-source.md"]);
  const [, bytes] = await artifacts.fileBytes(
    artifactContext,
    cid,
    String(rows[0]!.id),
    "index.md",
  );
  expect(bytes.toString()).toBe("# Revised report\n");
  const capture = await instance.durable.prompt(cid);
  expect(JSON.stringify(capture.system_messages)).not.toContain(
    "<name>artifact</name>",
  );
});

// Feature: #2892 settings and Artifacts are discovered on demand through Pi codemode.
test("settings and Artifacts stay out of initial requests and remain discoverable and callable", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  depsOf(instance.durable).models = models;
  depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
  await ready(instance);
  const cid = String(
    (await instance.create.create({ title: "Settings discovery" })).id,
  );
  let initial = "";
  let discovered = "";
  let described = "";
  let result = "";
  faux.setResponses([
    async () => {
      initial = JSON.stringify((await instance.durable.prompt(cid)).request);
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'text(await searchTools("recurse_settings")); text(await searchTools("create Artifact"));',
        }),
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      discovered = JSON.stringify(request.messages.at(-1));
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: `text(await tools.read({path:${JSON.stringify(RECURSE_SETTINGS_SKILL)}})); text(await describeTool("recurse_settings")); text(await describeTool("artifact"));`,
        }),
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      described = JSON.stringify(request.messages.at(-1));
      return fauxAssistantMessage(
        fauxToolCall("codemode", {
          code: 'text(await tools.recurse_settings({action:"levels"})); text(await tools.recurse_settings({action:"select_theme",name:"system"})); text(await tools.artifact({action:"list"}));',
        }),
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      result = JSON.stringify(request.messages.at(-1));
      return fauxAssistantMessage("Settings are available on demand.");
    },
  ]);
  const opened = await instance.durable.open(cid);
  await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
  await instance.delivery.deliver(
    cid,
    "List effort levels and follow the device theme",
    {
      origin: "operator",
      messageId: "settings-discovery",
    },
  );
  await opened.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(initial).toContain("searchTools");
  expect(initial).toContain("<name>recurse-settings</name>");
  expect(initial).toContain(RECURSE_SETTINGS_SKILL);
  expect((await instance.agentTools.skillsFor(cid))?.[0]).toContainEqual(
    expect.objectContaining({ name: "recurse-settings" }),
  );
  expect(initial).not.toContain('"name":"recurse_settings"');
  expect(initial).not.toContain("### `recurse_settings`");
  expect(initial).not.toContain('"name":"artifact"');
  expect(initial).not.toContain("### `artifact`");
  expect(initial).not.toContain("Ghostty palette file");
  expect(discovered).toContain("recurse_settings");
  expect(discovered).toContain("artifact");
  expect(described).toContain("Ghostty palette file");
  expect(described).toContain("including the level-1 safety reviewer");
  expect(described).toContain(
    "Change Recurse settings; read the recurse-settings skill first.",
  );
  expect(described).toContain("set_level");
  expect(described).toContain("from_file");
  expect(result).toContain("No Artifacts.");
  expect(result).toContain("default_level");
  expect(result).toContain("system");
  const capture = await instance.durable.prompt(cid);
  expect(JSON.stringify(capture.request)).toContain("describeTool");
});

// Regression: #3164 Pi's Agent Skills locations were omitted from provider requests.
test("Agent Skills locations load for roots and children and refresh between requests", async () => {
  const { root, env } = await world();
  const repo = join(root, "target");
  const nested = join(repo, "src", "nested");
  mkdirSync(nested, { recursive: true });
  const git = Bun.spawn(["git", "init", repo], {
    stdout: "ignore",
    stderr: "pipe",
  });
  expect(await git.exited).toBe(0);
  const locations = [
    [join(root, ".agents", "skills"), "outside-repo"],
    [join(env.HOME!, ".agents", "skills"), "user-agents"],
    [join(repo, ".agents", "skills"), "repo-agents"],
    [join(repo, "src", ".agents", "skills"), "ancestor-agents"],
    [join(nested, ".agents", "skills"), "cwd-agents"],
    [join(nested, ".pi", "skills"), "cwd-pi"],
    [join(root, "settings", "pi-agent", "skills"), "user-pi"],
    [join(repo, ".claude", "skills"), "claude-only"],
  ];
  const put = (
    dir: string,
    name: string,
    description = `Use ${name} for its workflow.`,
  ) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nFull instructions for ${name}.\n`,
    );
  };
  for (const [dir, name] of locations) put(dir!, name!);
  put(join(env.HOME!, ".claude", "skills"), "user-claude-only");
  const description = `Use repository workflows. ${"Preserve the entire routing description. ".repeat(20)}End of description.`;
  put(join(repo, ".agents", "skills"), "repo-agents", description);
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  depsOf(instance.durable).models = models;
  depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
  await ready(instance);
  const cid = String(
    (await instance.create.create({ title: "Skill root", workdir: nested })).id,
  );
  const child = String(
    (
      await instance.create.create({
        title: "Skill child",
        parent: cid,
        workdir: nested,
      })
    ).id,
  );
  for (const [index, id] of [cid, child, cid].entries()) {
    if (index === 2) {
      put(join(repo, ".agents", "skills"), "added-later");
      put(
        join(repo, ".agents", "skills"),
        "repo-agents",
        "Updated routing description.",
      );
    }
    faux.setResponses([
      fauxAssistantMessage("Skills captured."),
      ...(id === child ? [fauxAssistantMessage("Child report received.")] : []),
    ]);
    const opened = await instance.durable.open(id);
    await instance.delivery.deliver(id, "Check available workflows", {
      origin: "operator",
      messageId: `skills-${index}`,
    });
    await opened.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await durableUntil(
      () =>
        faux.getPendingResponseCount() === 0 &&
        instance.durable.runningCount() === 0,
    );
    const captured = await instance.durable.prompt(id);
    const system = JSON.stringify(captured.system_messages);
    for (const [dir, name] of locations.slice(1, -1)) {
      expect(system).toContain(`<name>${name}</name>`);
      expect(system).toContain(join(dir!, name!, "SKILL.md"));
      expect(system).not.toContain(`Full instructions for ${name}.`);
    }
    expect(system).not.toContain("outside-repo");
    expect(system).not.toContain("claude-only");
    expect(system).toContain("<name>recurse-settings</name>");
    if (index === 2) {
      expect(system).toContain("<name>added-later</name>");
      expect(system).toContain("Updated routing description.");
    } else {
      expect(system).toContain(description);
    }
    const listed = (await instance.agentTools.skillsFor(id))![0];
    for (const [, name] of locations.slice(1, -1))
      expect(listed).toContainEqual(expect.objectContaining({ name }));
  }
});

// Regression: #2852 publications persist; #2951 unreadable lookups recover.
test("native publications remain in Files after scratch removal and restart", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  depsOf(instance.durable).models = models;
  depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
  await ready(instance);
  const conv = await instance.create.create({
    title: "Persistent publication",
  });
  const cid = String(conv.id);
  const source = join(root, "target", "report.txt");
  writeFileSync(source, "persistent publication\n");
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("publish", { paths: [source] }, { id: "__proto__" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Published the report."),
  ]);
  const opened = await instance.durable.open(cid);
  await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
  await instance.delivery.deliver(cid, "Publish the report", {
    origin: "operator",
    messageId: "publish",
  });
  await opened.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const saved = instance.conversations.load(cid)!;
  const collection = instance.agentTemp.uploadsDir(String(saved.tmp_key));
  const stored = await publishedFiles(collection, cid);
  expect(stored.map((file) => file.name)).toEqual(["report.txt"]);
  const parkedCollection = `${collection}.held`;
  renameSync(collection, parkedCollection);
  const abort = new AbortController();
  let reader:
    | { read(): Promise<{ value?: Uint8Array }>; cancel(): Promise<void> }
    | undefined;
  try {
    const response = await conversationEvents(
      null,
      (cursor) => instance.reads.readViewEvents(cid, cursor),
      () => instance.durable.subscribeView(cid, () => {}),
      abort.signal,
    );
    reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader!.read()).value)).toContain(
      '"files_pending":true',
    );
  } finally {
    renameSync(parkedCollection, collection);
  }
  const invalid = join(collection, `${"f".repeat(32)}.json`);
  writeFileSync(invalid, "{");
  try {
    const partialFrame = new TextDecoder().decode((await reader!.read()).value);
    expect(partialFrame).toContain('"files_pending":true');
    expect(partialFrame).toContain("report.txt");
  } finally {
    unlinkSync(invalid);
  }
  try {
    const recoveredFrame = new TextDecoder().decode(
      (await reader!.read()).value,
    );
    expect(recoveredFrame).toContain('"files_pending":false');
  } finally {
    abort.abort();
    await reader?.cancel();
  }
  const recovered = await instance.durable.view(cid);
  const recoveredRow = (recovered.blocks as any[]).find(
    (block) => block.name === "publish",
  );
  expect(recoveredRow.files.map((file: any) => file.name)).toEqual([
    "report.txt",
  ]);
  const scratch = await instance.agentTemp.agentTempPath(saved);
  await instance.shutdown();
  rmSync(scratch, { recursive: true, force: true });
  const resumed = await build(env);
  depsOf(resumed.durable).models = models;
  depsOf(resumed.durable).settings = () => ["faux/faux-1", "off"];
  await ready(resumed);
  const page = await resumed.durable.view(cid);
  const row = (page.blocks as any[]).find((block) => block.name === "publish");
  expect(row.files.map((file: any) => file.name)).toEqual(["report.txt"]);
});

// Regression: #2951 a failed publication is not rescanned on every view.
test("failed publication scans once and delayed views use current run state", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  depsOf(instance.durable).models = models;
  depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
  const continuation = held(fauxAssistantMessage("Finished."));
  const existing = join(root, "existing.txt");
  const nestedFirst = join(root, "nested-first.txt");
  const nestedLast = join(root, "nested-last.txt");
  const gates = ["one", "two", "finish"].map((name) => join(root, name));
  const wait = (path: string) =>
    `while [ ! -e ${JSON.stringify(path)} ]; do sleep 0.05; done`;
  for (const path of [existing, nestedFirst, nestedLast])
    writeFileSync(path, "existing publication");
  const command = `printf ready; ${wait(gates[0]!)}; printf step1; ${wait(gates[1]!)}; printf step2; ${wait(gates[2]!)}`;
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("publish", { paths: [existing] }, { id: "constructor" }),
        fauxToolCall(
          "publish",
          { paths: [join(root, "missing.txt")] },
          { id: "__proto__" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(
        "codemode",
        {
          code: `await tools.publish({paths:[${JSON.stringify(nestedFirst)}]}); await tools.bash({command:${JSON.stringify(command)}}); await tools.publish({paths:[${JSON.stringify(nestedLast)}]});`,
        },
        { id: "held-script" },
      ),
      { stopReason: "toolUse" },
    ),
    continuation.step,
  ]);
  await ready(instance);
  const cid = String(
    (await instance.create.create({ title: "Failed publication" })).id,
  );
  const opened = await instance.durable.open(cid);
  await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
  const host = instance.durable as any;
  const scan = host.publishedFiles;
  let attempts = 0;
  host.publishedFiles = async (...args: any[]) => {
    if (args[1].includes("__proto__")) attempts++;
    return scan.apply(host, args);
  };
  try {
    await instance.delivery.deliver(cid, "Publish a missing file.", {
      origin: "operator",
    });
    const liveTool = async () =>
      (
        await opened.harness.snapshot(
          LiveDoc,
          opened.conversation.id,
          BACKGROUND_CONTEXT,
        )
      )?.nestedTools?.find((slot) => slot.name === "bash");
    await durableUntil(
      async () => (await liveTool())?.output?.includes("ready") === true,
    );
    const collection = instance.agentTemp.uploadsDir(
      String(instance.conversations.load(cid)!.tmp_key),
    );
    const invalid = join(collection, `${"f".repeat(32)}.json`);
    writeFileSync(invalid, "{");
    try {
      const first = await instance.durable.view(cid);
      const good = (first.blocks as any[]).find((block) =>
        block.files?.some((file: any) => file.name === "existing.txt"),
      );
      expect(good.files.map((file: any) => file.name)).toEqual([
        "existing.txt",
      ]);
      for (const [index, marker] of ["step1", "step2"].entries()) {
        writeFileSync(gates[index]!, "go");
        await durableUntil(
          async () => (await liveTool())?.output?.includes(marker) === true,
        );
        await instance.durable.view(cid);
      }
      expect(attempts).toBe(1);
      writeFileSync(gates[2]!, "go");
      await continuation.started;
      const finished = await instance.durable.view(cid);
      expect(
        (finished.blocks as any[]).some((block) =>
          block.files?.some((file: any) => file.name === "nested-last.txt"),
        ),
      ).toBeTrue();
      expect(attempts).toBe(2);
    } finally {
      unlinkSync(invalid);
      for (const gate of gates) writeFileSync(gate, "go");
    }
    await durableUntil(
      async () => (await instance.durable.view(cid)).files_pending === false,
      20_000,
    );
    const completedAttempts = attempts;
    for (let i = 0; i < 3; i++) await instance.durable.view(cid);
    expect(attempts).toBe(completedAttempts);
    const views = host.views;
    const page = views.page;
    let sampled!: () => void;
    let unblock!: () => void;
    const sampledPage = new Promise<void>((resolve) => (sampled = resolve));
    const blockedPage = new Promise<void>((resolve) => (unblock = resolve));
    views.page = async (...args: any[]) => {
      const result = await page.apply(views, args);
      sampled();
      await blockedPage;
      return result;
    };
    try {
      const inFlight = instance.durable.view(cid);
      await sampledPage;
      expect(instance.durable.metadata(cid).status).toBe("running");
      continuation.release();
      await opened.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const settled = instance.durable.metadata(cid);
      expect(settled.status).toBe("idle");
      unblock();
      const result = await inFlight;
      expect(result.turn_status).toBe("idle");
      expect(
        (result.run_state_clock as [string, number])[1],
      ).toBeGreaterThanOrEqual(settled.run_state_clock[1]);
    } finally {
      unblock();
      views.page = page;
    }
  } finally {
    continuation.release();
    host.publishedFiles = scan;
  }
});

test("Durable delivery persists only unique operator admission times", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  depsOf(instance.durable).models = models;
  depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
  const active = held(fauxAssistantMessage("Before clear"));
  faux.setResponses([
    fauxAssistantMessage("Operator reply"),
    fauxAssistantMessage("Agent reply"),
    fauxAssistantMessage("Second operator reply"),
    active.step,
    fauxAssistantMessage("Held operator reply"),
  ]);
  await ready(instance);
  const conv = await instance.create.create({ title: "Ordering" });
  const cid = String(conv.id);
  const stale = instance.conversations.metadataSnapshot(cid)!;
  const idle = (host: typeof instance.durable, id: string) => async () =>
    (await host.view(id)).turn_status === "idle";
  const send = (origin: string, messageId: string) =>
    instance.delivery.deliver(cid, "Input", { origin, messageId });
  expect(await send("operator", "first")).toBeString();
  const first =
    instance.conversations.metadataSnapshot(cid)!.operator_message_at;
  expect(first).toBeNumber();
  expect(
    instance.treeView.serve().find((row) => row.id === cid)!
      .operator_message_at,
  ).toBe(first);
  await durableUntil(idle(instance.durable, cid));
  expect(await send("operator", "first")).toBeString();
  expect(
    instance.conversations.metadataSnapshot(cid)!.operator_message_at,
  ).toBe(first);
  expect(await send("agent", "agent")).toBeString();
  await durableUntil(idle(instance.durable, cid));
  expect(
    instance.conversations.metadataSnapshot(cid)!.operator_message_at,
  ).toBe(first);
  expect(await send("operator", "second")).toBeString();
  const latest =
    instance.conversations.metadataSnapshot(cid)!.operator_message_at;
  expect(latest).toBeGreaterThan(first as number);
  await instance.conversations.save(stale);
  expect(
    instance.conversations.metadataSnapshot(cid)!.operator_message_at,
  ).toBe(latest);
  expect(await instance.agentStore.flush(cid)).toBe(true);
  const [persisted] = await instance.agentStore.loadPersistedAgent(cid);
  expect(persisted!.operator_message_at).toBe(latest);
  await durableUntil(idle(instance.durable, cid));
  expect(faux.state.callCount).toBe(3);
  expect(await send("agent", "before-clear")).toBeString();
  await durableUntil(() => faux.state.callCount === 4);
  await instance.durable.clear(cid);
  expect(await send("operator", "held")).toBeString();
  const heldAt =
    instance.conversations.metadataSnapshot(cid)!.operator_message_at;
  expect(heldAt).toBeGreaterThan(latest as number);
  expect(await send("operator", "held")).toBeString();
  expect(
    instance.conversations.metadataSnapshot(cid)!.operator_message_at,
  ).toBe(heldAt);
  active.release();
  await durableUntil(
    () => instance.durable.metadata(cid).pending_actions.length === 0,
  );
  await durableUntil(idle(instance.durable, cid));
  expect(
    instance.conversations.metadataSnapshot(cid)!.operator_message_at,
  ).toBe(heldAt);
  expect(faux.state.callCount).toBe(5);
});

// Feature: #2867 a child's report waits for its working subagents and wakes the parent once.
test("a child's report waits while its subagents work, then wakes the parent once", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const logStart = logs.length;
  const gates = new Map<string, ReturnType<typeof held>>();
  const gate = (
    name: string,
    answer: AssistantMessage = fauxAssistantMessage(`${name} done`),
  ) => {
    const step = held(answer);
    gates.set(name, step);
    return step;
  };
  const text = (message: any): string =>
    typeof message?.content === "string"
      ? message.content
      : (message?.content ?? []).map((p: any) => p.text ?? "").join("");
  const respond: FauxResponseStep = (context, ...rest) => {
    if (context.messages.at(-1)?.role === "toolResult")
      return fauxAssistantMessage("shell left running");
    const last = text(
      [...context.messages].reverse().find((m) => m.role === "user"),
    );
    const name = /HOLD-(\w+)/.exec(last)?.[1];
    if (name) return gates.get(name)!.step(context, ...rest);
    if (last.includes("SHELL"))
      return fauxAssistantMessage(
        fauxToolCall("bash", { command: "sleep 600", background: true }),
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage("child reply");
  };
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  const models = createModels();
  models.setProvider(faux.provider);
  const start = async () => {
    const instance = await build(env);
    depsOf(instance.durable).models = models;
    depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
    await ready(instance);
    return instance;
  };
  let instance = await start();
  const family = async (name: string) => {
    const create = (title: string, parent?: string) =>
      instance.create
        .create({ title: `${name} ${title}`, parent })
        .then((conv) => String(conv.id));
    const parent = await create("parent");
    const child = await create("child", parent);
    return { parent, child, grandchild: await create("grandchild", child) };
  };
  const send = (cid: string, message: string, sender: string | null) =>
    instance.delivery.deliver(cid, message, {
      origin: sender === null ? "operator" : "agent",
      sender,
    });
  const reports = async (parent: string, child: string) =>
    ((await instance.durable.view(parent, { limit: 200 })).blocks as any[])
      .filter((block) => block.role === "user" && block.sender === child)
      .map((block) => block.text.replace(/^(\[recurse-[^\n]*\n)+/, ""));
  const heldLog = (child: string, from = 0) =>
    logs
      .slice(from)
      .some(
        (line) =>
          line.includes("event=durable_report_held") &&
          line.includes(`cid=${child}`),
      );
  const quiet = async (...cids: string[]) => {
    for (const cid of cids) {
      const conv = instance.conversations.load(cid);
      if (conv && !conv.reap_deferred)
        await (await instance.durable.open(cid)).reporter?.kick();
    }
    return instance.durable.runningCount() === 0;
  };
  const onlyReport = async (f: Awaited<ReturnType<typeof family>>) => {
    await durableUntil(
      async () => (await reports(f.parent, f.child)).length > 0,
    );
    await durableUntil(() => quiet(f.parent, f.child, f.grandchild));
    const sent = await reports(f.parent, f.child);
    expect(sent).toHaveLength(1);
    return sent[0];
  };
  const afterGrandchild =
    "(turn started by an agent message; received 1 from you; 1 earlier turn ended)\nchild reply";
  try {
    const a = await family("finish");
    const [g1, c1] = [gate("g1"), gate("c1")];
    await send(a.grandchild, "HOLD-g1", a.child);
    await g1.started;
    await send(a.child, "HOLD-c1", a.parent);
    await c1.started;
    await send(a.child, "operator steer", null);
    await send(a.child, "sibling note", "outsider");
    await send(a.child, "parent follow-up", a.parent);
    c1.release();
    await durableUntil(() => heldLog(a.child));
    expect(await reports(a.parent, a.child)).toEqual([]);
    g1.release();
    expect(await onlyReport(a)).toBe(
      "(turn started by an agent message; received 1 operator, 2 from you, 1 agent; 1 earlier turn ended)\nchild reply",
    );

    for (const end of ["error", "abort", "delete"] as const) {
      const f = await family(end);
      const g = gate(
        end,
        end === "error"
          ? fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "provider exploded",
            })
          : undefined,
      );
      await send(f.grandchild, `HOLD-${end}`, f.child);
      await g.started;
      await send(f.child, "report back", f.parent);
      await durableUntil(() => heldLog(f.child));
      expect(await reports(f.parent, f.child)).toEqual([]);
      if (end === "error") g.release();
      if (end === "abort")
        expect(await instance.durable.stop(f.grandchild)).toBe(true);
      if (end === "delete") await instance.reap.requestReap(f.grandchild, null);
      expect(await onlyReport(f)).toBe(afterGrandchild);
    }

    const s = await family("shell");
    const opened = await instance.durable.open(s.grandchild);
    await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
    await send(s.grandchild, "SHELL", s.child);
    expect(await onlyReport(s)).toBe(
      "(turn started by an agent message)\nchild reply",
    );
    expect(instance.durable.shells(s.grandchild).active_count).toBe(1);
    expect(heldLog(s.child)).toBe(false);

    const r = await family("restart");
    await send(r.grandchild, "HOLD-restart", r.child);
    await gate("restart").started;
    await send(r.child, "report back", r.parent);
    await durableUntil(() => heldLog(r.child));
    expect(await reports(r.parent, r.child)).toEqual([]);
    await instance.shutdown();
    const resumed = gate("restart");
    const from = logs.length;
    instance = await start();
    await resumed.started;
    await durableUntil(() => heldLog(r.child, from));
    expect(await reports(r.parent, r.child)).toEqual([]);
    resumed.release();
    expect(await onlyReport(r)).toBe(afterGrandchild);
  } finally {
    for (const step of gates.values()) step.release();
    await instance.shutdown();
    logs.splice(logStart);
  }
}, 120_000);

test("Durable owners are wired and start() runs startup in order", async () => {
  const { root, env } = await world();
  const instance = await build(env);

  expect(instance.lifecycle.readinessSnapshot()).toEqual({
    ready: false,
    active_agents: null,
  });
  expect(instance.processes.startupAllowsTempSweep()).toBe(false);
  await ready(instance);
  expect(logs).toContain("recurse.agents event=store_import complete=1");
  expect(logs.filter((line) => /_failed|error_type=/u.test(line))).toEqual([]);
  expect(instance.processes.startupAllowsTempSweep()).toBe(true);
  expect(instance.processes.tempSweepSafeNow()).toBe(true);
  const target = join(root, "target");
  expect(instance.spawnWorkdir.current()).toBe(target);
  const conv = await instance.create.create({ title: "one" });
  expect(conv.backend).toBe("durable");
  expect(conv.workdir ?? target).toBe(target);
  expect(instance.treeView.serve().map((row) => row.id)).toContain(conv.id);
  await instance.shutdown();
  await instance.shutdown();
});

// Regression: #3031 Deletion awaits recoverable legacy tool-detail retirement.
test("consumer seams reach their owners", async () => {
  const { root, env } = await world();
  const instance = await build(env);
  await ready(instance);
  const conv = await instance.create.create({ title: "gated" });
  const cid = String(conv.id);
  instance.lifecycle.importFinal = false;
  await expect(instance.create.create({ title: "refused" })).rejects.toThrow(
    "startup import incomplete",
  );
  expect(await instance.delivery.deliver(cid, "refused")).toBeNull();
  instance.lifecycle.importFinal = true;

  await instance.tasks
    .spawn("cancelled_probe", async () => {
      throw new Cancelled();
    })
    .catch(() => undefined);
  await instance.tasks
    .spawn("failing_probe", async () => {
      throw new Error("probe");
    })
    .catch(() => undefined);
  const detached = logs.filter((l) => l.includes("detached_task_failed"));
  expect(detached.some((l) => l.includes("failing_probe"))).toBe(true);
  expect(detached.some((l) => l.includes("cancelled_probe"))).toBe(false);

  const details = join(root, "data", "tool_artifacts");
  const ownerDir = join(
    details,
    createHash("sha256").update(cid, "utf8").digest("hex"),
  );
  mkdirSync(ownerDir, { recursive: true });
  expect(await instance.reap.reap(cid)).toContain(cid);
  expect(existsSync(ownerDir)).toBe(false);
});

async function timed<T>(fn: () => Promise<T> | T): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
}

test("warmOpen builds the shared Models and Settings' catalog, so the first open builds neither", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  await ready(instance);
  const cid = String((await instance.create.create({ title: "warm" })).id);
  const list = join(root, "data", "config", "pi-model-list.json");
  const catalog = JSON.parse(readFileSync(list, "utf8"));
  catalog.models[0].name += " (refreshed)";
  writeFileSync(list, JSON.stringify(catalog));
  const config = Config.prototype as unknown as Record<string, () => unknown>;
  const spies = [
    // test-check-allow: T3 Call-through counts real credential store construction.
    spyOn(AuthStorage, "createLazy"),
    // test-check-allow: T3 Call-through counts real Settings catalog file reads.
    spyOn(config, "readPiModelList"),
    // test-check-allow: T3 Call-through counts real catalog policy construction.
    spyOn(config, "routePolicy"),
  ];
  try {
    await instance.durable.warmOpen();
    expect(spies.map((spy) => spy.mock.calls.length > 0)).toEqual([
      true,
      true,
      true,
    ]);
    for (const spy of spies) spy.mockClear();
    await instance.config.writeAvailableModels();
    await instance.durable.open(cid);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}, 60_000);

// Regression: #2460 external create admission was unbounded and held its lease.
test("FI-1: an external lease delays no tree, view or Stop request", async () => {
  const { root, env } = await world();
  const instance = await build(env);
  await ready(instance);
  const conv = await instance.create.create({ title: "held" });
  const cid = String(conv.id);
  expect(await instance.reads.readViewWindow(cid)).toBeObject();
  const holder = Bun.spawn(
    ["flock", "-x", join(root, "data"), "sh", "-c", "printf 'held\\n'; cat"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "held",
    );
    reader.releaseLock();
    let created = false;
    const waiting = instance.create
      .create({ title: "after" })
      .then(() => (created = true));
    await until(() =>
      instance.createTasks.names().some((name) => name.startsWith("create:")),
    );
    expect(created).toBe(false);
    const [rows, treeMs] = await timed(() => instance.treeView.serve());
    expect(rows.map((row) => row.id)).toContain(cid);
    const [view, viewMs] = await timed(() =>
      instance.reads.readViewWindow(cid),
    );
    expect(view).toBeObject();
    const [stopped, stopMs] = await timed(() => instance.tree.requestStop(cid));
    expect(stopped).toBe(false);
    console.log("lease-held request durations ms", { treeMs, viewMs, stopMs });
    expect(created).toBe(false);
    await expect(waiting).rejects.toThrow(TreeLifecycleBusy);
    holder.stdin.end();
    await holder.exited;
    expect((await instance.create.create({ title: "after" })).id).toBeString();
  } finally {
    holder.kill();
    await holder.exited;
  }
});

// Regression: #3050 parallel native level edits must not overwrite another conversation's edit.
test("parallel native Settings level edits both persist", async () => {
  const { root, env } = await world();
  seedPiModelList(join(root, "data", "config"));
  const instance = await build(env);
  const faux = fauxProvider({ tokensPerSecond: 20_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  depsOf(instance.durable).models = models;
  depsOf(instance.durable).settings = () => ["faux/faux-1", "off"];
  await ready(instance);
  const edits = [1, 2].map((level) => {
    const entry = instance.config.effortLevels()[level]!;
    return {
      level,
      model: entry.model,
      reasoning: entry.reasoning === "low" ? "high" : "low",
      marker: `PARALLEL-LEVEL-${level}`,
    };
  });
  const conversations = [];
  for (const edit of edits) {
    const cid = String(
      (await instance.create.create({ title: edit.marker })).id,
    );
    const opened = await instance.durable.open(cid);
    await setSafetyReviewOff(opened.conversation, true, BACKGROUND_CONTEXT);
    conversations.push({ cid, opened, edit });
  }
  let release!: () => void;
  const together = new Promise<void>((resolve) => (release = resolve));
  let arrivals = 0;
  const respond: FauxResponseStep = async (request) => {
    const messages = JSON.stringify(request.messages);
    const edit = edits.find((entry) => messages.includes(entry.marker));
    if (!edit) throw new Error("missing parallel Settings intent");
    if (++arrivals === edits.length) release();
    await together;
    return fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: `await describeTool("recurse_settings"); text(await tools.recurse_settings(${JSON.stringify({ action: "set_level", level: edit.level, model: edit.model, reasoning: edit.reasoning })}));`,
      }),
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([
    respond,
    respond,
    fauxAssistantMessage("First level saved."),
    fauxAssistantMessage("Second level saved."),
  ]);
  try {
    await Promise.all(
      conversations.map(({ cid, edit }) =>
        instance.delivery.deliver(cid, edit.marker, {
          origin: "operator",
          messageId: edit.marker,
        }),
      ),
    );
    await Promise.all(
      conversations.map(({ opened }) =>
        opened.conversation.waitForIdle(BACKGROUND_CONTEXT),
      ),
    );
    expect(arrivals).toBe(edits.length);
    const saved = JSON.parse(
      readFileSync(instance.config.paths.EFFORT_LEVELS_FILE, "utf8"),
    );
    for (const edit of edits) {
      expect(saved.levels[String(edit.level)]).toEqual({
        model: edit.model,
        reasoning: edit.reasoning,
      });
      expect(instance.config.effortLevels()[edit.level]!.reasoning).toBe(
        edit.reasoning,
      );
    }
  } finally {
    release();
  }
});
