// SDK skill discovery for Durable prompts; no CLI or model process.
import { loadSkills } from "@earendil-works/pi-coding-agent";

export interface SkillInfo {
  name: string;
  description: string;
}

export interface ListSkillsOptions {
  cwd: string;
  skillPaths?: readonly string[];
}

export async function listSkills(
  agentDir: string,
  o: ListSkillsOptions,
): Promise<SkillInfo[]> {
  const seen = new Set<string>();
  return loadSkills({
    cwd: o.cwd,
    agentDir,
    skillPaths: [...(o.skillPaths ?? [])],
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
