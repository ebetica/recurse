import { pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PASSWORD = "boundary-test-password";
const SALT = "0123456789abcdef0123456789abcdef";

export function appWorld(options: { password?: boolean } = {}): {
  root: string;
  env: Record<string, string>;
} {
  const root = mkdtempSync(join(tmpdir(), "web-app-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "target"));
  const env: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "TZ"])
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  Object.assign(env, {
    CHAT_DATA_DIR: join(root, "data"),
    HOME: join(root, "home"),
    RECURSE_HOME: join(root, "settings"),
    CHAT_REPO_URL: join(root, "target"),
    PI_BG_SHELL: "0",
    PORT: "8787",
  });
  if (options.password) {
    env.CHAT_AUTH_SALT = SALT;
    env.CHAT_AUTH_HASH = pbkdf2Sync(
      PASSWORD,
      new Uint8Array(Buffer.from(SALT, "hex")),
      600_000,
      32,
      "sha256",
    ).toString("hex");
  }
  return { root, env };
}
