/** Read CLI help from a leading JSDoc without importing the tool. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { leadingModuleHelp } from "../src/skill_context";

export function toolHelp(url: string | URL): string {
  const source = readFileSync(fileURLToPath(url), "utf8");
  return leadingModuleHelp(source) ?? "";
}
