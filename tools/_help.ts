import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { leadingModuleHelp } from "../src/skill_context";

// Extract leading tool JSDoc help without importing its module.
export function toolHelp(url: string | URL): string {
  const source = readFileSync(fileURLToPath(url), "utf8");
  return leadingModuleHelp(source) ?? "";
}
