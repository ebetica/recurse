# Pull request patches

This module splits bounded GitHub unified patches into file summaries without
retaining full-file contents. Quoted Git paths decode C escapes and UTF-8 octal
bytes.

## Source files

- [index.ts](index.ts): public named exports.
- [patch.ts](patch.ts): patch splitting and Git path decoding.

## Rules for changes

Import the module through `index.ts`; keep that entry limited to explicit named
re-exports. Preserve bounded patch handling and the recorded GitHub diff coverage
in `tests/backend/workdir_git.test.ts`.
