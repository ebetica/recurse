// Rewrite approved bash only with ensure-rtk's supported ready status.
// Missing/old/disabled RTK or failed rewriting preserves the reviewed command.
// Keep commit-hook output with any Git flags; RTK summaries discard it.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
const exec = promisify(execFile);
type Scope = { cwd: string; env: Record<string, string> };

/** Whether ./scripts/ensure-rtk.sh found a supported RTK for this checkout. The
 * launcher runs it before the server starts, so one read per process holds. */
export function rtkReady(buildDir: string): boolean {
  try {
    return readFileSync(join(buildDir, ".rtk-status"), "utf8")
      .trim()
      .startsWith("ready:");
  } catch {
    return false;
  }
}

export interface RtkOptions {
  scope(): Promise<Scope>;
  buildDir: string;
}

let enabled: boolean | undefined;

export function createRtk(options: RtkOptions) {
  return {
    extensions: [
      rtkExtension(options.scope, (enabled ??= rtkReady(options.buildDir))),
    ],
  };
}

export function rtkExtension(scope: () => Promise<Scope>, enabled: boolean) {
  return defineExtension({
    name: "recurse-rtk",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          if (!enabled) return;
          const command = call.arguments.command;
          if (
            call.name !== "bash" ||
            typeof command !== "string" ||
            !command.trim() ||
            command.startsWith("rtk ")
          )
            return;
          let rewritten: string | undefined;
          try {
            const { cwd, env } = await scope();
            if (env.RTK_DISABLED === "1") return;
            const { stdout } = await exec("rtk", ["rewrite", command], {
              cwd,
              env,
              timeout: 2000,
              maxBuffer: 1024 * 1024,
            });
            rewritten = stdout.trim();
          } catch (error) {
            // Spec: RTK advisory exit 3 still carries a valid rewrite.
            const result = error as {
              code?: number;
              stdout?: string;
              killed?: boolean;
            };
            if (!result.killed && result.code === 3)
              rewritten = result.stdout?.trim();
          }
          if (
            rewritten &&
            rewritten !== command &&
            !/\brtk\s+git\b.*\bcommit\b/s.test(rewritten)
          )
            return { arguments: { ...call.arguments, command: rewritten } };
          return undefined;
        },
      }),
    ],
  });
}
