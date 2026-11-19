// GitHub PR identity shared by linked PRs and GitHub reads; no credentials.
export function prIdentity(
  url: string,
): { repo: string; number: number; url: string } | null {
  const match =
    /^https:\/\/github\.com\/([\w.-]{1,39}\/[\w.-]{1,100})\/pull\/([1-9]\d*)$/u.exec(
      url,
    );
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  const repo = match[1]!.toLowerCase();
  const number = Number(match[2]);
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

/**
 * The PR a successful bash `command` created: a `gh pr create` command's last
 * output line that is a PR URL, as `gh pr create` prints it.
 */
export function createdPrUrls(command: string, output: string): string[] {
  if (!/(?:^|[;&|(\n])\s*gh\s+pr\s+create\b/u.test(command)) return [];
  const urls = output
    .split("\n")
    .flatMap((line) => prIdentity(line.trim()) ?? []);
  return urls.length ? [urls.at(-1)!.url] : [];
}
