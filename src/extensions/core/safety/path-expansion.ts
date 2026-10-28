import { readEnvironmentOverrides } from "./environment-state.ts";

const VARIABLE = /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g;
const PATH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ["path"],
  edit: ["path"],
  write: ["path"],
  grep: ["path"],
  find: ["path"],
  multi_grep: ["constraints"],
  artifact: ["from_file"],
};

export function expandPath(raw: string, env: NodeJS.ProcessEnv): string {
  let expanded = raw;
  if (expanded === "~" || expanded.startsWith("~/")) {
    const home = env.HOME;
    if (home === undefined) throw new Error("unknown variable $HOME in path");
    expanded = home + expanded.slice(1);
  }
  return expanded.replace(
    VARIABLE,
    (_reference, name: string | undefined, braced: string | undefined) => {
      const variable = name ?? braced!;
      const value = env[variable];
      if (value === undefined)
        throw new Error(`unknown variable $${variable} in path`);
      return value;
    },
  );
}

export async function effectiveEnv(
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const effective = { ...env };
  for (const override of (await readEnvironmentOverrides(env)).values()) {
    effective[override.name] = override.value;
  }
  return effective;
}

/** Mutate Pi's validated tool input before review and execution. */
export async function expandToolCallPaths(
  toolName: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const fields = PATH_FIELDS[toolName];
  if (!fields) return;
  const effective = await effectiveEnv(env);
  for (const field of fields) {
    if (typeof input[field] === "string")
      input[field] = expandPath(input[field], effective);
  }
}
