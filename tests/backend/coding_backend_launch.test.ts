import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import cases from "./fixtures/coding_backend_launch/cases.json";
import { CHECKOUT_ROOT } from "../../src/build_dir";
import { Config } from "../../src/config";
import {
  ISOLATED_PATH_ENV,
  preparePiAgentDir,
  resolveRoots,
} from "../../src/local_roots";
import {
  buildEnv,
  type LaunchEnvInputs,
} from "../../src/coding_backend/launch";
import { listSkills } from "../../src/coding_backend/skills";

type Case = { input: any };
const ALL = (cases as { cases: Case[] }).cases;

const ROOT = mkdtempSync(join(tmpdir(), "coding-launch-"));
mkdirSync(join(ROOT, "data"));
const ENV: Record<string, string> = Object.fromEntries(
  Object.entries(ISOLATED_PATH_ENV).map(([k, v]) => [k, join(ROOT, v)]),
);
const CONFIG = new Config({
  env: ENV,
  authenticatedProviders: () => ["anthropic", "openai-codex"],
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function makeFiles(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(ROOT, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

function launchInputs(): LaunchEnvInputs {
  return {
    config: CONFIG,
    gitEnv: () => ({ ...GIT_ENV }),
    roots: resolveRoots(ENV),
    preparePiAgentDir,
    checkoutRoot: CHECKOUT_ROOT,
  };
}

const GIT_ENV: Record<string, string> = {
  PATH: "/usr/bin",
  PI_SAFETY_OFF: "1",
  RECURSE_MODEL_POLICY: "forged",
  RECURSE_TOOL_CAPTURE_DIR: "/x",
  RECURSE_TOOL_CAPTURE_FD: "9",
  RECURSE_GLOBAL_AGENTS_FD: "9",
  RECURSE_GLOBAL_AGENTS_PATH: "/x",
  TMPDIR: "/tmp",
  TEMP: "/tmp",
  RECURSE_WORKSPACE_ROOT: "/",
  RTK_DISABLED: "1",
  PI_AUTH_JSON: "<INH-AUTHJSON>",
  OPENROUTER_API_KEY: "<INH-OR>",
  CLAUDE_CODE_OAUTH_TOKEN: "<INH-CC>",
  ANTHROPIC_AUTH_TOKEN: "<AMB-AUTH>",
  ANTHROPIC_OAUTH_TOKEN: "<AMB-OAUTH>",
  ANTHROPIC_API_KEY: "<INH-KEY>",
  RECURSE_CHANGES_TOKEN: "<INH-CHANGES>",
  RECURSE_TURN_CONTEXT_KEY: "<INH-TURNKEY>",
  RECURSE_RUN_ID: "old",
  RECURSE_PYTHON: "old",
  RECURSE_AGENT_ID: "inherited",
};

describe("tool environment", () => {
  test("prepares native directories and filters launch inputs", async () => {
    for (const { input } of ALL) {
      for (const leaf of ["build", "checkout", "work", "recurse-state-home"])
        rmSync(join(ROOT, leaf), { recursive: true, force: true });
      makeFiles(input.files);
      const o: Record<string, any> = {};
      for (const [k, v] of Object.entries(input.options))
        o[k] = typeof v === "string" ? v.replaceAll("<ROOT>", ROOT) : v;
      const inputs = launchInputs();
      const result = buildEnv(inputs, {
        cid: o.cid,
        safetyOff: o.safety_off,
        model: o.model,
        maximumContextWindow: o.maximum_context_window,
        agentTmpdir: o.agent_tmpdir,
        workspaceRoot: o.workspace_root,
        worktreesRoot: o.worktrees_root,
        turnContextKey: o.turn_context_key,
        runId: o.run_id,
        workdir: o.workdir,
      });
      if (o.maximum_context_window === 5 || o.maximum_context_window === true) {
        await expect(result).rejects.toThrow();
        continue;
      }
      const env = await result;
      expect(env.PI_CODING_AGENT_DIR).toBe(inputs.roots.piAgent);
      const agentDir = statSync(env.PI_CODING_AGENT_DIR!);
      expect(agentDir.isDirectory()).toBe(true);
      expect(agentDir.mode & 0o777).toBe(0o700);
      expect(env.RECURSE_WORKSPACE_ROOT).toBe(
        o.workspace_root === join(ROOT, "work/space")
          ? o.workspace_root
          : undefined,
      );
      expect(env.RECURSE_WORKTREES_ROOT).toBeUndefined();
      for (const key of [
        "PI_AUTH_JSON",
        "OPENROUTER_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "RECURSE_CHANGES_TOKEN",
        "RECURSE_TOOL_CAPTURE_DIR",
        "RECURSE_TOOL_CAPTURE_FD",
        "RECURSE_GLOBAL_AGENTS_FD",
        "RECURSE_GLOBAL_AGENTS_PATH",
      ])
        expect(env[key]).toBeUndefined();
      if (o.safety_off) expect(env.PI_SAFETY_OFF).toBe("1");
      else expect(env.PI_SAFETY_OFF).toBeUndefined();
      expect(env.RECURSE_MODEL_POLICY).not.toBe("forged");
      expect(env.RECURSE_TURN_CONTEXT_KEY).toBe(
        o.turn_context_key || undefined,
      );
      expect(env.RECURSE_RUN_ID).toBe(o.run_id ?? undefined);
      if (o.cid) expect(env.RECURSE_AGENT_ID).toBe(o.cid);
    }
  });
});

describe("skill discovery", () => {
  test("skill inspection uses the coding-agent resource loader", async () => {
    const skill = join(ROOT, "sdk-skill/SKILL.md");
    makeFiles({
      "sdk-skill/SKILL.md":
        "---\nname: inspection\ndescription: Inspect a fixture\n---\nFixture instructions.\n",
    });
    expect(
      await listSkills(join(ROOT, "empty-agent"), {
        cwd: ROOT,
        skillPaths: [skill],
      }),
    ).toEqual([{ name: "inspection", description: "Inspect a fixture" }]);
  });
});
