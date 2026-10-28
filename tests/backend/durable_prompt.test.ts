import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { getSystemMessageText } from "@earendil-works/pi-ai";

import {
  renderPromptSections,
  snapshotRecursePrompt,
} from "../../src/agents/durable/prompt_sections";
import { loadPromptResources } from "../../src/agents/durable/prompt_resources";
import { RequestCaptures } from "../../src/agents/durable/request_capture";
import { Prompts, type PromptsDeps } from "../../src/agents/runtime/prompts";
import {
  captureMemorySnapshot,
  renderMemoryPrompt,
} from "../../src/agents/runtime/memory_snapshot";
import promptCapture from "./fixtures/durable_host/prompt-sections.json";
import { DurableHost } from "../../src/agents/durable/host";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { switchoverWorld, testDeps, until } from "./fixtures/durable_host/host";

const require = createRequire(import.meta.url);
const { buildSystemPrompt } = require(
  join(
    dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    ),
    "core/system-prompt.js",
  ),
);
const cwd = "/fixture";
const conv = {
  id: "agent",
  parent: "parent",
  title: "prompt test",
  updated: 1,
};
const prompts = new Prompts({
  displayName: "Recurse",
  dataDir: "/state",
  toolsDir: "/tools",
  toolsSection: () => "Recurse tools available",
  conversationEffortLine: () => "Effort 3",
  projectStatuses: () => ({ agent: "idle" }),
  now: () => {
    throw new Error("Durable renderer read a clock");
  },
} as unknown as PromptsDeps);
function snapshot() {
  return snapshotRecursePrompt(
    prompts,
    conv,
    { convs: [conv], live: {} },
    cwd,
    "memory snapshot",
    {
      contextFiles: [
        { path: "/fixture/AGENTS.md", content: "Project instructions" },
      ],
      skills: [],
    },
  );
}

test("Durable sections are byte-identical to Pi's custom-prompt path", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-prompt-"));
  let state;
  try {
    const repo = join(root, "repo"),
      agent = join(root, "agent"),
      skill = join(root, "skill");
    for (const dir of [repo, agent, skill]) await mkdir(dir);
    await writeFile(join(repo, "AGENTS.md"), "Project instructions\n");
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: prompt-test\ndescription: Check prompt parity.\n---\nSkill instructions.\n",
    );
    state = {
      ...snapshot(),
      ...(await loadPromptResources(repo, agent, [skill])),
    };
    expect(
      state.contextFiles.some((file) => file.path === join(repo, "AGENTS.md")),
    ).toBe(true);
    expect(state.skills.map((skill) => skill.name)).toEqual(["prompt-test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const rendered = renderPromptSections(state, cwd);
  const pi = buildSystemPrompt({
    customPrompt: state.foreword,
    cwd,
    contextFiles: state.contextFiles,
    skills: state.skills,
    sections: Object.fromEntries(
      Object.entries(rendered).filter(([key]) => key.startsWith("recurse_")),
    ),
  });
  const sections = Object.fromEntries(
    Object.entries(rendered).map(([key, text]) => [
      key,
      key === "preamble" ? text : `<${key}>\n${text}\n</${key}>`,
    ]),
  );
  expect(
    getSystemMessageText({
      role: "system",
      content: "",
      sections,
      timestamp: 0,
    }),
  ).toBe(pi);
});

test("owned instruction sections match a recorded fresh Durable request", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable-prompt-capture-"));
  try {
    const state = snapshot();
    state.recurse_memory = renderMemoryPrompt(
      await captureMemorySnapshot(String(conv.id), root),
      root,
    );
    const rendered = renderPromptSections(state, cwd);
    for (const [key, text] of Object.entries(promptCapture.sections))
      expect(rendered[key]).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Feature: #2838 tree memories follow current parents in captured provider requests.
test("tree memory is shared within the current tree only", async () => {
  const world = await switchoverWorld();
  const data = join(world.root, "data");
  const faux = fauxProvider({ tokensPerSecond: 20000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const host = new DurableHost({
    ...testDeps(data, world.load, () => ["root", "child", "other"]),
    models,
    promptSnapshot: async (row, cwd) =>
      snapshotRecursePrompt(
        world.instance.prompts,
        row,
        world.instance.conversations.captureDigestInputs(),
        cwd,
        await world.instance.prompts.captureMemoryPrompt(row),
        { contextFiles: [], skills: [] },
      ),
  });
  try {
    for (const [id, parent] of [
      ["root", null],
      ["child", "root"],
      ["other", null],
    ]) {
      await world.instance.conversations.save({
        id,
        parent,
        backend: "durable",
        model: "faux/faux-1",
        workdir: world.root,
      });
    }
    await world.instance.prompts.captureMemoryPrompt(world.load("root")!);
    await mkdir(join(data, "memories/trees/root"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(data, "memories/trees/root/shared.md"),
      "---\ntitle: Root memory\ndate: 2026-10-24\n---\nPrivate body\n",
    );
    const steps = [
      ["root", null, true],
      ["child", "root", true],
      ["other", null, false],
      ["child", "other", false],
      ["child", "root", true],
      ["child", null, false],
    ] as const;
    for (const [index, [cid, parent, visible]] of steps.entries()) {
      await world.instance.conversations.save({ ...world.load(cid)!, parent });
      faux.setResponses([fauxAssistantMessage("done")]);
      await host.send(cid, "Check memory", `memory-${index}`);
      await until(
        () =>
          host.runningCount() === 0 && host.metadata(cid).pending.length === 0,
      );
      const captured = await host.prompt(cid);
      expect(captured.capture_status).toBe("captured");
      const request = captured.request as {
        context: { messages: Array<{ sections?: Record<string, string> }> };
      };
      const memory = request.context.messages
        .flatMap((message) =>
          message.sections?.recurse_memory
            ? [message.sections.recurse_memory]
            : [],
        )
        .at(-1)!;
      expect(memory.includes("shared.md: Root memory")).toBe(visible);
      expect(memory).toMatch(/Global:[\s\S]*Tree:[\s\S]*Local:/);
      expect(JSON.stringify(request)).not.toContain("Private body");
    }
  } finally {
    await host.close();
    await world.close();
  }
});

test("capture refuses credential overrides without storing them or stale requests", async () => {
  const captures = new RequestCaptures(() => "agent");
  for (const override of [
    { env: { OPENAI_API_KEY: "synthetic-secret" } },
    { apiKey: "synthetic-secret" },
    { headers: { Authorization: "synthetic-secret" } },
  ]) {
    captures.record("streamSimple", {}, { messages: [] }, { sessionId: "s" });
    expect(() =>
      captures.record(
        "streamSimple",
        {},
        { messages: [] },
        { sessionId: "s", ...override },
      ),
    ).toThrow("Models-owned authentication");
    expect(await captures.latest("agent")).toBeUndefined();
  }
});
