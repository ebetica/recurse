// Core CLI help and external Pi skills for every agent.
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Config,
  EFFORT_MAX_LEVEL,
  EFFORT_MIN_LEVEL,
  RECURSE_REPO_URL,
} from "../config";
import { skillHelp, pythonStrip, type SkillContext } from "../skill_context";
const CORE_TOOLS = ["subagent", "worktree"] as const;

type Conv = Record<string, unknown>;

export interface AgentToolsDeps {
  config: Config;
  skills: SkillContext;
  /** workdir_git.ready() and workdir_git.target_is_git_repo(). */
  gitReady(): boolean;
  targetIsGitRepo(): boolean;
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

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? (error as { code?: string }).code
    : undefined;

// Canonical repo URL/path for identity: trimmed, no trailing `/` or `.git`,
// lower.
export function normRepoUrl(url: string): string {
  let u = pythonStrip(url).replace(/\/+$/u, "");
  if (u.endsWith(".git")) u = u.slice(0, -4);
  return u.toLowerCase();
}

// pathlib.Path.resolve(strict=False): resolve the existing prefix, keep the
// rest.
function pyResolve(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR")
        throw error;
      const parent = resolve(head, "..");
      if (parent === head) return resolve(path);
      tail.push(head.slice(parent.length).replace(/^\//u, ""));
      head = parent;
    }
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
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

  /** True when the canonical target repo is Recurse itself. */
  targetsRecurse(): boolean {
    const { repoUrl } = this.config;
    const { TOOLS_DIR, AGENTS_MD } = this.config.paths;
    if (normRepoUrl(repoUrl) === normRepoUrl(RECURSE_REPO_URL)) return true;
    const install = TOOLS_DIR === null ? null : dirname(TOOLS_DIR);
    if (install !== null) {
      try {
        if (repoUrl && pyResolve(repoUrl) === pyResolve(install)) return true;
        if (pyResolve(AGENTS_MD) === pyResolve(join(install, "AGENTS.md")))
          return true;
      } catch {
        // Invariant: OSError: fall through to the marker-file check.
      }
    }
    const target = dirname(AGENTS_MD);
    const rel = (...parts: string[]) => isFile(join(target, ...parts));
    return (
      isFile(AGENTS_MD) &&
      rel("src/local.ts") &&
      rel("src", "web", "app.ts") &&
      rel("src", "agents", "instance.ts")
    );
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
    let reachability: Record<number, Record<string, unknown>>;
    let defaultLevel: number;
    try {
      reachability = this.config.effortLevelReachability();
      defaultLevel = this.config.defaultEffortLevel();
    } catch {
      reachability = {};
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
      `Effort levels (model · reasoning); default for new conversations: ${defaultLevel}.`,
      "Use lower levels for mechanical/checking work, higher for design/debugging; " +
        "1 is fastest/cheapest, 5 most capable/costly.",
    ];
    if (Object.keys(reachability).length === 0) {
      lines.push(
        "  (no levels available — configure them in Settings to enable subagents)",
      );
    } else {
      for (let level = EFFORT_MIN_LEVEL; level <= EFFORT_MAX_LEVEL; level++) {
        const entry = reachability[level];
        if (typeof entry !== "object" || entry === null) continue;
        const { model, reasoning } = entry;
        if (typeof model !== "string" || typeof reasoning !== "string")
          continue;
        let row = `  ${level} — ${this.modelLabel(model, labels)} · ${reasoning}`;
        if (level === defaultLevel) row += " · new conversations start here";
        if (!entry.reachable) {
          const reason = entry.reason;
          const detail =
            typeof reason === "string" && reason
              ? `: ${Array.from(reason).slice(0, 200).join("")}`
              : "";
          row += ` · unreachable${detail}`;
        }
        lines.push(row);
      }
    }
    lines.push("Subagents inherit your level/model unless given --effort N.");
    lines.push(
      "View/change the ladder in Settings or discover recurse_settings with codemode searchTools; " +
        "never guess model ids.",
    );
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
  toolsSection(): string {
    const toolsDir = this.config.paths.TOOLS_DIR;
    if (toolsDir === null) return "";
    const out = ["Run Recurse tools from `$RECURSE_SRC`, not your cwd.", ""];
    const item = (cmd: string, desc: string): void => {
      out.push(`bun ${cmd}`);
      for (const line of desc.split("\n")) out.push(line ? `  ${line}` : "");
      out.push("");
    };
    item("$RECURSE_SRC/tools/subagent.ts …", this.help.get("subagent")!);
    out.push("Keep agent titles short; put task details in the prompt.");
    out.push("");
    out.push(...this.effortBlockLines());
    out.push("");
    if (this.deps.gitReady() && this.deps.targetIsGitRepo())
      item(
        "$RECURSE_SRC/tools/worktree.ts enter <name>",
        this.help.get("worktree")!,
      );
    out.push("");
    out.push(
      "If Git reports no author identity, ask the operator for the name and email to use, and never make one up.",
    );
    out.push("");
    out.push("Read `$RECURSE_SRC/AGENTS.md` before working on Recurse itself.");
    if (
      !this.targetsRecurse() &&
      isFile(join(dirname(toolsDir), "AGENTS.md"))
    ) {
      out.push("");
      out.push(
        "When editing the installed Recurse source, commit directly; no PR needed.",
      );
    }
    return out.join("\n").replace(/\s+$/u, "");
  }
}
