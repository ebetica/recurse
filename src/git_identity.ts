// Resolve checkout commit identity without overriding user config or explicit
// author/committer environment. Remove legacy defaults before inherited config.
// Record GitHub's account locally when available; otherwise leave identity
// unset so Git refuses commits rather than inventing an author.
import { gitEnv } from "./workdir_git";

const pending = new Map<string, Promise<boolean>>();
type Env = Readonly<Record<string, string | undefined>>;

/** Record a known identity; return false when the operator must supply one. */
export function prepareGitIdentity(
  repoDir: string,
  environ: Env = process.env,
  accountUrl = "https://api.github.com/user",
): Promise<boolean> {
  const existing = pending.get(repoDir);
  if (existing) return existing;
  const task = resolveIdentity(repoDir, environ, accountUrl).finally(() => {
    pending.delete(repoDir);
  });
  pending.set(repoDir, task);
  return task;
}

async function resolveIdentity(
  repoDir: string,
  environ: Env,
  accountUrl: string,
): Promise<boolean> {
  const env = gitEnv(environ);
  async function git(...args: string[]): Promise<string> {
    const child = Bun.spawn(["git", "-C", repoDir, ...args], {
      env,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const [text, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      if (code !== 0 && code !== 1)
        throw new Error("Git identity configuration failed");
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  }
  if (
    (await git("config", "--local", "user.name")) === "recurse-agent" &&
    (await git("config", "--local", "user.email")) === "recurse-agent@local"
  ) {
    await git("config", "--local", "--unset-all", "user.name");
    await git("config", "--local", "--unset-all", "user.email");
    if (await git("config", "--local", "recurse.identityVersion"))
      await git("config", "--local", "--unset-all", "recurse.identityVersion");
  }
  if ((await git("config", "--local", "recurse.identityVersion")) === "1")
    return true;
  const missing: string[] = [];
  for (const key of ["name", "email"]) {
    if (await git("config", `user.${key}`)) continue;
    const supplied =
      environ[`GIT_AUTHOR_${key.toUpperCase()}`] ||
      environ[`GIT_COMMITTER_${key.toUpperCase()}`];
    if (supplied) await git("config", "--local", `user.${key}`, supplied);
    else missing.push(key);
  }
  let name: string | undefined;
  let email: string | undefined;
  const token = environ.GITHUB_TOKEN || environ.GH_TOKEN;
  if (missing.length && token) {
    try {
      const response = await fetch(accountUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Recurse",
        },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (response.ok) {
        const account = (await response.json()) as {
          id?: unknown;
          login?: unknown;
          name?: unknown;
        };
        if (
          Number.isSafeInteger(account.id) &&
          Number(account.id) > 0 &&
          typeof account.login === "string" &&
          /^[a-zA-Z0-9-]+$/.test(account.login)
        ) {
          name =
            typeof account.name === "string" && account.name.trim()
              ? account.name.trim()
              : account.login;
          email = `${account.id}+${account.login}@users.noreply.github.com`;
        }
      }
    } catch {
      // Invariant: Unavailable GitHub identity must not prevent local work.
    }
  }
  if (missing.length && (!name || !email)) return false;
  for (const key of missing)
    await git(
      "config",
      "--local",
      `user.${key}`,
      (key === "name" ? name : email)!,
    );
  await git("config", "--local", "recurse.identityVersion", "1");
  return true;
}
