// Core CLI help and external Pi skills for every agent.
import { join } from "node:path";
import { type Config, EFFORT_MAX_LEVEL, EFFORT_MIN_LEVEL } from "../config";
import { skillHelp, type SkillContext } from "../skill_context";
const CORE_TOOLS = ["subagent", "worktree"] as const;

type Conv = Record<string, unknown>;

export interface AgentToolsDeps {
  config: Config;
  skills: SkillContext;
  /** workdir_git.ready() and workdir_git.target_is_git_repo(). */
  gitReady(): Promise<boolean> | boolean;
  targetIsGitRepo(): Promise<boolean> | boolean;
  /** conversation_store.load / effective_workdir. */
  loadConversation(cid: string): Promise<Conv | null>;
  effectiveWorkdir(conv: Conv): string;
  /** agent_temp.agent_temp_path / agent_runtime_path. */
  agentTempPath(conv: Conv): Promise<string>;
  /** coding_backend.skills.list_skills bound to its lifecycle and env. */
  listSkills(options: {
    cwd: string;
    cid: string;
    agentTmpdir: string;
    skillPaths: readonly string[];
  }): Promise<unknown[]>;
}

export class AgentTools {
  private constructor(
    private readonly deps: AgentToolsDeps,
    private readonly help: ReadonlyMap<string, string>,
  ) {}

  /** Load the core tool docstrings once, then serve per-compose sections. */
  static async create(deps: AgentToolsDeps): Promise<AgentTools> {
    const help = new Map<string, string>();
    const toolsDir = deps.config.paths.TOOLS_DIR;
    for (const name of CORE_TOOLS) {
      let text = `Run \`${name}.ts --help\`.`;
      if (toolsDir !== null)
        text = await skillHelp(join(toolsDir, `${name}.ts`), text);
      help.set(name, text);
    }
    return new AgentTools(deps, help);
  }

  private get config(): Config {
    return this.deps.config;
  }

  /** Skills Pi makes available to this agent, plus its opaque skill context. */
  async skillsFor(cid: string): Promise<[unknown[], string] | null> {
    const conv = await this.deps.loadConversation(cid);
    if (conv === null) return null;
    const workdir = this.deps.effectiveWorkdir(conv);
    const context = await this.deps.skills.contextForWorkdir(workdir);
    if (context === null) return null;
    const tmpdir = await this.deps.agentTempPath(conv);
    const skills = await this.deps.listSkills({
      cwd: workdir,
      cid,
      agentTmpdir: tmpdir,
      skillPaths: [],
    });
    return [skills, context];
  }

  /** Display name for a model id, failing safe to the id itself. */
  modelLabel(modelId: string, labels?: Record<string, unknown>): string {
    if (labels !== undefined) {
      const label = labels[modelId];
      if (typeof label === "string" && label) return label;
    }
    let options: unknown[];
    try {
      options = this.config.chatModels();
    } catch {
      return modelId;
    }
    for (const option of options) {
      if (typeof option === "object" && option !== null) {
        const record = option as Record<string, unknown>;
        if (record.id === modelId) {
          if (typeof record.label === "string" && record.label)
            return record.label;
        }
      }
    }
    return modelId;
  }

  effortBlockLines(): string[] {
    let ladder: Record<number, Record<string, unknown>>;
    let defaultLevel: number;
    try {
      ladder = this.config.effortLevels();
      defaultLevel = this.config.defaultEffortLevel();
    } catch {
      ladder = {};
      defaultLevel = 0;
    }
    let labels: Record<string, unknown>;
    try {
      labels = {};
      for (const option of this.config.chatModels())
        if (typeof option.id === "string") labels[option.id] = option.label;
    } catch {
      labels = {};
    }
    const lines = [
      `Effort levels (model · reasoning); new conversations use ${defaultLevel}. Lower for mechanical`,
      "work, higher for design and debugging. Subagents inherit yours unless given --effort.",
    ];
    if (Object.keys(ladder).length === 0) {
      lines.push(
        "  (no levels available — configure them in Settings to enable subagents)",
      );
    } else {
      for (let level = EFFORT_MIN_LEVEL; level <= EFFORT_MAX_LEVEL; level++) {
        const entry = ladder[level];
        if (typeof entry !== "object" || entry === null) continue;
        const { model, reasoning } = entry;
        if (typeof model !== "string" || typeof reasoning !== "string")
          continue;
        lines.push(
          `  ${level} — ${this.modelLabel(model, labels)} · ${reasoning}`,
        );
      }
    }
    return lines;
  }

  /** The per-turn effort line for this conversation, or null. */
  conversationEffortLine(conv: Conv): string | null {
    const level = conv.level;
    if (
      typeof level !== "number" ||
      !Number.isInteger(level) ||
      level < EFFORT_MIN_LEVEL ||
      level > EFFORT_MAX_LEVEL
    ) {
      const model = conv.model;
      if (typeof model !== "string" || !model) return null;
      const thinking = conv.effort;
      const reasoning =
        typeof thinking === "string" && thinking
          ? `, reasoning ${thinking}`
          : "";
      return `Fixed model: ${this.modelLabel(model)}${reasoning} (no effort level).`;
    }
    let model: string;
    let reasoning: string;
    try {
      [model, reasoning] = this.config.resolveEffortLevel(level);
    } catch {
      return null;
    }
    return (
      `This conversation runs at effort level ${level} ` +
      `(${this.modelLabel(model)}, reasoning ${reasoning}).`
    );
  }

  // The generated "Recurse tools available" section ("" without a tools dir).
  async toolsSection(): Promise<string> {
    const toolsDir = this.config.paths.TOOLS_DIR;
    if (toolsDir === null) return "";
    const out = ["Run Recurse tools from `$RECURSE_SRC`, not your cwd.", ""];
    const item = (cmd: string, desc: string): void => {
      out.push(`bun ${cmd}`);
      for (const line of desc.split("\n")) out.push(line ? `  ${line}` : "");
      out.push("");
    };
    item("$RECURSE_SRC/tools/subagent.ts …", this.help.get("subagent")!);
    out.push(
      "Name agents in short kebab-case; put task details in the prompt.",
    );
    out.push("");
    out.push(
      "Settings: read the recurse-settings skill, then use recurse_settings.",
      "",
      ...this.effortBlockLines(),
    );
    out.push("");
    if ((await this.deps.gitReady()) && (await this.deps.targetIsGitRepo()))
      item("$RECURSE_SRC/tools/worktree.ts", this.help.get("worktree")!);
    out.push("");
    out.push(
      "If Git reports no author identity, ask the operator; never make one up.",
    );
    out.push("");
    out.push("Read `$RECURSE_SRC/AGENTS.md` before working on Recurse itself.");
    return out.join("\n").replace(/\s+$/u, "");
  }
}
