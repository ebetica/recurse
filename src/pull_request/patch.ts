// Bounded GitHub unified patches, split without retaining full-file contents.
// Git quotes unusual paths using C escapes and UTF-8 octal bytes.
function gitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes = raw
    .slice(1, -1)
    .replace(
      /\\([0-7]{3}|.)|([^\\]+)/g,
      (_, escape: string | undefined, literal: string | undefined) => {
        if (escape?.length === 3)
          return String.fromCharCode(parseInt(escape, 8));
        const text =
          literal ??
          (escape === "a"
            ? "\u0007"
            : escape === "v"
              ? "\u000b"
              : (JSON.parse('"\\' + escape + '"') as string));
        return Array.from(new TextEncoder().encode(text), (byte) =>
          String.fromCharCode(byte),
        ).join("");
      },
    );
  return new TextDecoder().decode(
    Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
  );
}

export function pullRequestFiles(patch: string) {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((part) => part.startsWith("diff --git "))
    .map((part) => {
      const header = part.split("\n", 1)[0]!;
      const paths =
        /^diff --git ("a\/.*") ("b\/.*")$/.exec(header) ??
        /^diff --git (a\/.*?) (b\/.*)$/.exec(header);
      let path = paths ? gitPath(paths[2]!).slice(2) : null;
      let additions = 0,
        deletions = 0,
        inHunk = false;
      for (const line of part.split("\n")) {
        if (!inHunk && line.startsWith("+++ ") && line !== "+++ /dev/null")
          path = gitPath(line.slice(4)).slice(2);
        if (line.startsWith("@@ ")) inHunk = true;
        else if (inHunk && line.startsWith("+")) additions++;
        else if (inHunk && line.startsWith("-")) deletions++;
      }
      return { path, additions, deletions, patch: part };
    })
    .filter(
      (file): file is typeof file & { path: string } => file.path !== null,
    );
}
