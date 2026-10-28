import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig, type Config } from "../../src/config";
import { AgentTools } from "../../src/agents/tools";
import { makeSkillRegistry, SkillContext } from "../../src/skill_context";

import promptCapture from "./fixtures/extras/prompt.json";
const temporary: string[] = [];
afterAll(() =>
  Promise.all(temporary.map((p) => rm(p, { recursive: true, force: true }))),
);

async function tempRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "recurse-extras-test-")),
  );
  temporary.push(root);
  await mkdir(join(root, "data"));
  return root;
}

async function makeAgentTools(
  config: Config,
  git: [boolean, boolean] = [true, true],
): Promise<AgentTools> {
  const skills = new SkillContext(() => makeSkillRegistry(config));
  return AgentTools.create({
    config,
    skills,
    gitReady: () => git[0],
    targetIsGitRepo: () => git[1],
    loadConversation: async () => null,
    effectiveWorkdir: () => "/",
    agentTempPath: async () => "/",
    listSkills: async () => [],
  });
}

test("live CLI help matches a recorded fresh Durable request", async () => {
  const root = await tempRoot();
  const config = createConfig({
    cwd: root,
    toolsDir: join(import.meta.dir, "../../tools"),
    authenticatedProviders: () => promptCapture.authenticatedProviders,
    env: {
      HOME: join(root, "home"),
      RECURSE_HOME: join(root, "state"),
      PI_CODING_AGENT_DIR: join(root, "state", "pi-agent"),
      CHAT_DATA_DIR: join(root, "data"),
      CHAT_REPO_URL: "https://example.invalid/prompt-fixture",
    },
  });
  config.setPiModelList(promptCapture.models);
  config.setEffortLevels(promptCapture.ladder);
  expect((await makeAgentTools(config)).toolsSection()).toBe(
    promptCapture.section,
  );
});
