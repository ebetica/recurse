// Capture a fresh fake-provider request with fixed model, ladder, memory and tree.
// Require project_context (wrapper included) below 10,000 characters and the rest below 8,000.
// Load real context, skills and CLI help with the production renderers.
// Canonicalize only known checkout/runtime fixture roots after capture.
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  getSystemMessageText,
  type Context,
} from "@earendil-works/pi-ai";
import { createConfig } from "../../src/config";
import { AgentTools } from "../../src/agents/tools";
import { DurableHost } from "../../src/agents/durable/host";
import { loadPromptResources } from "../../src/agents/durable/prompt_resources";
import { snapshotRecursePrompt } from "../../src/agents/durable/prompt_sections";
import { Prompts } from "../../src/agents/runtime/prompts";
import {
  captureMemorySnapshot,
  renderMemoryPrompt,
} from "../../src/agents/runtime/memory_snapshot";
import { makeSkillRegistry, SkillContext } from "../../src/skill_context";
import { retire, sweep } from "../../src/utils/trash";
import { testDeps, until } from "../backend/fixtures/durable_host/host";
import fixture from "../backend/fixtures/extras/prompt.json";

interface PromptBudget {
  total: number;
  sections: Record<string, string>;
  codemodeDescription: string;
}

/** Capture a real Durable request with canonical fixture metadata paths. */
export async function renderPromptBudget(
  repo = resolve(import.meta.dir, "../.."),
): Promise<PromptBudget> {
  const sourceRepo = resolve(import.meta.dir, "../..");
  const root = await mkdtemp(join(tmpdir(), "recurse-prompt-budget-"));
  const trash = await mkdtemp(join(tmpdir(), "recurse-prompt-budget-trash-"));
  const data = join(root, "data");
  const canonical = (text: string) =>
    text
      .replaceAll(root, "/fixture/runtime")
      .replaceAll(repo, "/fixture/recurse")
      .replaceAll(sourceRepo, "/fixture/recurse");
  const config = createConfig({
    cwd: repo,
    toolsDir: join(repo, "tools"),
    authenticatedProviders: () => fixture.authenticatedProviders,
    env: {
      HOME: join(root, "home"),
      RECURSE_HOME: join(root, "settings"),
      CHAT_DATA_DIR: data,
      CHAT_REPO_URL: repo,
    },
  });
  let host: DurableHost | undefined;
  try {
    await config.models.setPiModelList(fixture.models);
    await config.levels.setEffortLevels(fixture.ladder);
    const tools = await AgentTools.create({
      config,
      skills: new SkillContext(() => makeSkillRegistry(config)),
      gitReady: () => true,
      targetIsGitRepo: () => true,
      loadConversation: async () => null,
      effectiveWorkdir: () => repo,
      agentTempPath: async () => root,
      listSkills: async () => [],
    });
    const prompts = new Prompts({
      displayName: "Recurse",
      dataDir: "/fixture/state",
      turnPromptDir: "/fixture/state/turn_prompts",
      toolsDir: join(repo, "tools"),
      toolsSection: () => tools.toolsSection(),
      conversationEffortLine: (conv) => tools.conversationEffortLine(conv),
      projectStatuses: () => ({}),
      effectiveWorkdir: () => repo,
      chatSettings: () => ["faux/faux-1", "off"],
      memoryPrompt: async (cid) =>
        renderMemoryPrompt(await captureMemorySnapshot(cid, data), data),
      boundSessionFile: async () => null,
      now: () => 0,
    });
    const [model, effort] = config.levels.resolveEffortLevel(3);
    const row = {
      id: "budget",
      backend: "durable",
      model,
      effort,
      level: 3,
      workdir: repo,
    };
    const faux = fauxProvider({ tokensPerSecond: 20_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    host = new DurableHost({
      ...testDeps(
        data,
        () => row,
        () => [row.id],
      ),
      config,
      models,
      promptSnapshot: async (_conv, cwd) =>
        snapshotRecursePrompt(
          prompts,
          row,
          { convs: [], live: {} },
          cwd,
          await prompts.captureMemoryPrompt(row),
          await loadPromptResources(repo, join(root, "pi-agent"), []),
        ),
    });
    faux.setResponses([fauxAssistantMessage("Prompt captured.")]);
    await host.send(row.id, "Check the prompt budget.", "prompt-budget");
    const running = host;
    await until(
      () =>
        running.runningCount() === 0 &&
        running.metadata(row.id).pending.length === 0,
    );
    const captured = (await host.prompt(row.id)).request as {
      context: Context;
    };
    const messages = captured.context.messages.filter(
      (message) => message.role === "system",
    );
    const sections: Record<string, string> = {};
    for (const message of messages)
      for (const [name, value] of Object.entries(message.sections ?? {}))
        if (value !== null) sections[name] = canonical(value);
    const codemode = messages
      .flatMap((message) => message.toolsAdded ?? [])
      .find((tool) => tool.name === "codemode");
    return {
      total: canonical(
        messages.map(getSystemMessageText).filter(Boolean).join("\n\n"),
      ).length,
      sections,
      codemodeDescription: canonical(codemode?.description ?? ""),
    };
  } finally {
    await host?.close();
    await config.close();
    retire(root, trash);
    sweep(trash, 1);
    await rmdir(trash);
  }
}

function promptBudgets(report: PromptBudget) {
  const project = report.sections.project_context?.length ?? 0;
  return [
    ["AGENTS.md (project_context)", project, 10_000],
    ["Recurse system prompt", report.total - project, 8_000],
  ] as const;
}

/** Enforce both size limits and reject Pi's obsolete native-tool pointer. */
export function checkPromptBudget(report: PromptBudget): void {
  const description = report.codemodeDescription
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (
    !description ||
    description.includes("codemode section of the system prompt")
  )
    throw new Error(
      "codemode must describe script calls without referring to a codemode system-prompt section",
    );
  for (const [part, size, limit] of promptBudgets(report))
    if (size >= limit)
      throw new Error(
        `${part}: ${size} characters (must be fewer than ${limit})`,
      );
}

if (import.meta.main) {
  const report = await renderPromptBudget();
  for (const [name, value] of Object.entries(report.sections))
    console.log(`${name}: ${value.length}`);
  for (const [part, size, limit] of promptBudgets(report))
    console.log(`${part}: ${size} / ${limit} characters`);
  checkPromptBudget(report);
}
