// GitHub PR identity shared by tool detection and GitHub reads; no credentials.
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
