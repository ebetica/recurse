// Run descriptor-sensitive validation in a process with explicitly chosen stdio.
import { closeSync, openSync } from "node:fs";
import {
  validateIsolatedEnvironment,
  validateLaunchEnvironment,
} from "../../../../src/local_roots";

const c = JSON.parse(process.argv[2]!) as {
  fn: string;
  env: Record<string, string>;
  repeat?: number;
};
let lockFd: number | null = null;
if (c.env.RECURSE_DATA_DIR_LOCK_FD === "$LOCK_FD") {
  lockFd = openSync(process.argv[3]!, "r");
  c.env.RECURSE_DATA_DIR_LOCK_FD = String(lockFd);
}
const warnings: string[] = [];
console.error = (...values: unknown[]) =>
  warnings.push(values.map(String).join(" "));
let output: unknown;
try {
  if (c.fn === "validate_isolated_environment") {
    validateIsolatedEnvironment(c.env);
    output = null;
  } else {
    const results: null[] = [];
    for (let index = 0; index < (c.repeat ?? 1); index += 1) {
      validateLaunchEnvironment(c.env);
      results.push(null);
    }
    output = { results, stderr: warnings };
  }
} catch (error) {
  if (error instanceof Error && error.name === "RootError") {
    output = { error: error.message };
  } else if (error instanceof Error && error.name === "RuntimeError") {
    output = { runtime_error: error.message };
  } else {
    throw error;
  }
} finally {
  if (lockFd !== null) closeSync(lockFd);
}
console.log(JSON.stringify(output));
