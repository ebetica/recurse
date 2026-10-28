// Conversation cwd/env changes commit before subsequent tools, never to server
// env. Native env calls use host validation. Recurse identity, safety scope and
// model-policy names cannot be overridden; imports drop and log them, and tool
// environments ignore stored protected values.
import { resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { parse } from "dotenv";
import { Type } from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
  validName,
  shellQuote,
  MAX_FILE,
} from "../safety/environment-state.ts";

export const EnvironmentDoc = defineDoc<{ overrides: Record<string, string> }>({
  kind: "recurse.environment",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ overrides: {} }),
});

export type EnvironmentChange = {
  set: Record<string, string>;
  unset: string[];
};

const RECURSE_OWNED = /^(?:RECURSE_|PI_)|^CHAT_DATA_DIR$/;

export const recurseOwnedName = (name: string): boolean =>
  RECURSE_OWNED.test(name);

// Drop protected overrides, including names absent from the host env.
export function unprotectedOverrides(overrides: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(overrides).filter(([name]) => !recurseOwnedName(name)),
  );
}

/** Trusted host values take precedence; ordinary overrides remain effective. */
export function scopedEnvironment(
  base: Record<string, string>,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const trusted = Object.fromEntries(
    Object.entries(base).filter(([name]) => recurseOwnedName(name)),
  );
  return { ...base, ...unprotectedOverrides(overrides), ...trusted };
}

/** `current` with `change` applied; throws the refusal to report. */
export function changedOverrides(
  current: Record<string, string>,
  change: EnvironmentChange,
): Record<string, string> {
  const overrides = { ...current };
  for (const name of change.unset) {
    if (!validName(name))
      throw new Error(`Environment variable name ${name} is invalid.`);
    delete overrides[name];
  }
  for (const [name, value] of Object.entries(change.set)) {
    if (!validName(name))
      throw new Error(`Environment variable name ${name} is invalid.`);
    if (recurseOwnedName(name))
      throw new Error(`${name} is set by Recurse and cannot be overridden.`);
    // Invariant: env -i arguments allow newlines but cannot contain NUL.
    if (value.length > 16_384 || value.includes("\0"))
      throw new Error(`The value of ${name} is invalid or too large.`);
    Object.defineProperty(overrides, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  // Spec: The Pi file-backed limit includes shell quoting overhead.
  const serialized = Object.entries(overrides)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
    .join("");
  if (Buffer.byteLength(serialized) > MAX_FILE)
    throw new Error("Environment override state is too large.");
  return overrides;
}

function textResult(
  text: string,
  details: NonNullable<ToolExecutionResult["details"]>,
): ToolExecutionResult {
  return { output: [{ type: "text", text }], details };
}

export function managedTools(
  claimDirectory?: (cwd: string, signal?: AbortSignal) => Promise<void>,
  changeEnvironment?: (
    change: EnvironmentChange,
  ) => Promise<{ names: string[]; absent: string[] } | { refused: string }>,
) {
  return defineExtension({
    name: "recurse-managed-tools",
    tools: [
      defineTool({
        name: "env",
        description:
          "Set, unset, list or load environment overrides from a dotenv file. Changes apply to subsequent tools and persist across turns/restarts. Values are never printed; unset removes overrides, not ambient defaults. RECURSE_*, PI_* and CHAT_DATA_DIR are protected (16,384 characters/value, 64 KiB total; multiline allowed). No stdin: load requires a file path.",
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("set"),
            Type.Literal("unset"),
            Type.Literal("list"),
            Type.Literal("load"),
          ]),
          name: Type.Optional(
            Type.String({ description: "Variable name for set." }),
          ),
          value: Type.Optional(
            Type.String({
              description: "Variable value for set; never printed in results.",
            }),
          ),
          names: Type.Optional(
            Type.Array(Type.String(), {
              minItems: 1,
              description: "Variable names for unset.",
            }),
          ),
          path: Type.Optional(
            Type.String({
              description:
                "Dotenv file path for load, relative to current cwd.",
            }),
          ),
        }),
        executionMode: "sequential",
        async execute(args, api) {
          if (!changeEnvironment)
            throw new Error("Environment overrides are unavailable");
          const change: EnvironmentChange = { set: {}, unset: [] };
          if (args.action === "set") {
            if (args.name === undefined || args.value === undefined)
              throw new Error("set requires name and value");
            change.set = { [args.name]: args.value };
          } else if (args.action === "unset") {
            if (!args.names?.length) throw new Error("unset requires names");
            change.unset = args.names;
          } else if (args.action === "load") {
            if (args.path === undefined || args.path === "-")
              throw new Error("load requires a file path, not stdin");
            change.set = parse(
              await readFile(resolve(api.env!.cwd, args.path), "utf8"),
            );
            if (!Object.keys(change.set).length)
              throw new Error("No variables found in file");
          }
          const result = await changeEnvironment(change);
          if ("refused" in result) throw new Error(result.refused);
          const text =
            args.action === "list"
              ? result.names.length
                ? result.names.map((name) => `${name}=***`).join("\n")
                : "No environment overrides are set."
              : args.action === "unset"
                ? change.unset
                    .map((name) =>
                      result.absent.includes(name)
                        ? `${name} had no override. An ambient default may still remain.`
                        : `Unset ${name}.`,
                    )
                    .join("\n")
                : `Set ${Object.keys(change.set).join(", ")}.`;
          return textResult(text, {});
        },
      }),
      defineTool({
        name: "chdir",
        callers: ["model"],
        description: "Change cwd for subsequent tools and turns.",
        parameters: Type.Object({
          directory: Type.String({
            description:
              "Directory path; relative paths resolve against the current effective cwd",
          }),
        }),
        executionMode: "sequential",
        async execute(args, api, context) {
          const cwd = resolve(api.env!.cwd, args.directory);
          if (!(await stat(cwd)).isDirectory())
            throw new Error("Not a directory");
          await claimDirectory?.(cwd, context.abortSignal);
          await api.commit(
            (tx) => configure(tx, api.conversationId, { cwd }),
            context,
          );
          return textResult(`Working directory is now ${cwd}.`, { cwd });
        },
      }),
    ],
  });
}
