# GitHub pull requests

`PullRequests` reads branch PRs, PR details and patches, and checkout origin
links. Links in conversation messages use the conversation’s stored working
folder, not the cwd changed by an agent. One server instance shares the lookup
caches and GitHub CLI backoff.
PR patch reads do not need a checkout. The Changes diff reads the last cached
branch PR only when the branch still matches; it does not wait on GitHub.

## Source files

- [index.ts](index.ts): public named exports.
- [identity.ts](identity.ts): canonical PR URLs and URLs printed by `gh pr create`.
- [github.ts](github.ts): bounded GitHub CLI calls, serialized per conversation,
  and shared rate-limit backoff.
- [lookups.ts](lookups.ts): PR and origin lookups and their cache policy.
- [patch.ts](patch.ts): split bounded GitHub patches into file summaries without
  retaining full-file contents. Quoted Git paths decode C escapes and UTF-8 octal
  bytes.

## Rules for changes

Import the module through `index.ts`; keep that entry limited to explicit named
re-exports. Preserve bounded patch handling and the recorded GitHub diff coverage
in `tests/backend/workdir_git.test.ts`.
