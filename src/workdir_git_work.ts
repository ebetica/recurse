// Typed refs select committed work, not a comparison with the working tree.
// Merged work shows its first-parent change; unmerged work stops at main or
// the nearest strict ancestor branch tip among 200 recently updated refs.
export interface SelectedWork {
  ref: string;
  headSha: string;
  stop: string | null;
  commits: number;
}

type Git = (
  args: string[],
  limit: number,
) => Promise<{ text: string | null; code: number; truncated: boolean }>;

export async function selectedWork(
  ref: string,
  headSha: string,
  main: [string, string] | null,
  git: Git,
): Promise<{ base: string; work: SelectedWork } | null> {
  const read = async (args: string[], limit = 256) => {
    const out = await git(args, limit);
    return out.code === 0 && !out.truncated ? (out.text?.trim() ?? null) : null;
  };
  const count = async (base: string) => {
    const value = await read(["rev-list", "--count", `${base}..${headSha}`]);
    return value && /^\d+$/u.test(value) ? Number(value) : null;
  };
  const onMain = main
    ? await git(["merge-base", "--is-ancestor", headSha, main[1]], 0)
    : null;
  if (onMain?.code === 0) {
    const parent = await read(["rev-parse", "--verify", `${headSha}^1`]);
    const base =
      parent ?? (await read(["hash-object", "-t", "tree", "--stdin"]));
    return base
      ? { base, work: { ref, headSha, stop: null, commits: 1 } }
      : null;
  }
  let base = main ? await read(["merge-base", headSha, main[1]]) : null;
  let stop = base && main ? main[0] : null;
  let commits = base ? await count(base) : null;
  const refs = await read(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--count=200",
      `--merged=${headSha}`,
      "--format=%(objectname)%00%(refname:short)",
      "refs/heads",
      "refs/remotes/origin",
    ],
    128 * 1024,
  );
  const seen = new Set([headSha, ...(base ? [base] : [])]);
  for (const row of (refs ?? "").split("\n")) {
    const [sha, name] = row.split("\0");
    if (!sha || !name || seen.has(sha)) continue;
    seen.add(sha);
    const distance = await count(sha);
    if (distance !== null && (commits === null || distance < commits)) {
      base = sha;
      stop = name;
      commits = distance;
    }
  }
  if (!base) {
    base = await read(["hash-object", "-t", "tree", "--stdin"]);
    const total = await read(["rev-list", "--count", headSha]);
    commits = total && /^\d+$/u.test(total) ? Number(total) : null;
  }
  return base && commits !== null
    ? { base, work: { ref, headSha, stop, commits } }
    : null;
}
