// Pi parses skills from its agent-dir and cwd/.pi defaults, ~/.agents/skills,
// and .agents/skills from cwd through the Git root (or filesystem root).
// Keep discovery shared by autocomplete and fresh request-boundary resources.
// Pi's first-name-wins defaults precede these extra paths and bundled settings.
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RECURSE_SETTINGS_SKILL = fileURLToPath(
  new URL("../../skills/recurse-settings/SKILL.md", import.meta.url),
);

export interface SkillInfo {
  name: string;
  description: string;
}

export interface ListSkillsOptions {
  cwd: string;
  skillPaths?: readonly string[];
  home?: string;
}

/** Supply Pi's Agent Skills search locations without replacing its parser. */
export async function skillPathsForWorkdir(
  cwd: string,
  home = homedir(),
): Promise<string[]> {
  const paths = [join(home, ".agents", "skills")];
  let dir = resolve(cwd);
  while (true) {
    paths.push(join(dir, ".agents", "skills"));
    if (await stat(join(dir, ".git")).catch(() => null)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return paths;
}

export async function listSkills(
  agentDir: string,
  o: ListSkillsOptions,
): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  return loadSkills({
    cwd: o.cwd,
    agentDir,
    skillPaths: [
      RECURSE_SETTINGS_SKILL,
      ...(await skillPathsForWorkdir(o.cwd, o.home)),
      ...(o.skillPaths ?? []),
    ],
    includeDefaults: true,
  })
    .skills.filter((skill) => {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ name, description }) => ({ name, description }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
