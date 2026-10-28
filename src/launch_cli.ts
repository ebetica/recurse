// Installer-time state-root/build-stamp CLI with stable output/status codes.
// Build ROOT publishes a current stamp only after RTK/frontend succeed.
// Image builds reuse that generation with src/local.ts --prebuilt.
import { resolve } from "node:path";
import { matches } from "./build_stamp";
import { buildCurrentGeneration } from "./launcher/build";
import {
  preparePiAgentDir,
  resolveRoots,
  validateLaunchEnvironment,
} from "./local_roots";

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function localRoots(args: string[]): Promise<number> {
  let shell = false;
  let validate = false;
  for (const arg of args) {
    if (arg === "--shell") shell = true;
    else if (arg === "--validate-launch-environment") validate = true;
    else {
      process.stderr.write(
        `usage: bun launch_cli.ts local-roots [--shell] [--validate-launch-environment]\n`,
      );
      return 2;
    }
  }
  try {
    if (validate) {
      validateLaunchEnvironment(process.env);
      if (!shell) return 0;
    } else {
      validateLaunchEnvironment(process.env);
    }
    const roots = resolveRoots();
    await preparePiAgentDir(roots);
    if (shell)
      process.stdout.write(`export RECURSE_HOME=${shellQuote(roots.state)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[recurse] error: ${message}\n`);
    return 2;
  }
}

function buildStamp(args: string[]): number {
  if (args.length !== 2 || args[0] !== "check") {
    process.stderr.write("usage: bun launch_cli.ts build-stamp check ROOT\n");
    return 2;
  }
  return matches(args[1]!) ? 0 : 1;
}

/** Build one checkout generation; 0 when built or already current. */
export async function build(
  args: string[],
  runBuild: (root: string) => Promise<boolean> = (root) =>
    buildCurrentGeneration(root),
): Promise<number> {
  if (args.length !== 1) {
    process.stderr.write("usage: bun launch_cli.ts build ROOT\n");
    return 2;
  }
  return (await runBuild(resolve(args[0]!))) ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "local-roots") return localRoots(args);
  if (command === "build-stamp") return buildStamp(args);
  if (command === "build") return build(args);
  process.stderr.write(
    "usage: bun launch_cli.ts (local-roots [OPTIONS] | build-stamp check ROOT | build ROOT)\n",
  );
  return 2;
}

if (import.meta.main) process.exitCode = await main();
