# Artifacts

An **Artifact** is a durable, versioned deliverable shown in the Artifacts pane:
a Markdown document or a small web app. Each Artifact is a Git repository owned
by one agent. Agents edit its files and commit; a post-commit hook publishes
that commit automatically. New repositories get the hook at creation; existing
ones get it when accessed, except listings. The hook runs
[publish_commit.ts](publish_commit.ts), which publishes the saved commit and
checks an app after publication. The commit waits for the check, and hook JSON
uses separate lines so bash's per-line trimming preserves screenshot paths.
Automatic RTK rewriting leaves Git commits uncompressed so hook publication and
check output reaches direct bash and codemode callers.
A recorded, one-time startup migration
(`.commit-hooks-publish-commit-v1`) rewrites stale CLI hooks before the next commit.
It records completion only after all hooks are refreshed; startup logs failures
and retries on the next start. Until the first commit the Artifact is a draft.
Each publication is an immutable version that can be restored. Failed app
builds report to the committing shell and leave the last working version shown.

**Source files:** [../artifacts.ts](../artifacts.ts) (create, publish, versions,
listings) · [app.ts](app.ts) (builds apps) · [check.ts](check.ts) (checks built
apps in a browser) · [preview.ts](preview.ts) · [theme.ts](theme.ts) ·
[key_relay.ts](key_relay.ts) · [working_path.ts](working_path.ts) (portable paths) ·
[../extensions/core/environment/artifact.ts](../extensions/core/environment/artifact.ts)
(the native agent tool) · [../../web/artifacts/](../../web/artifacts/) (the pane)

## How it works

Publishing moves the Git pointer (ref) for the published version atomically and
records another ref for that version.
A document's page is its `index.md`. An app is built into one self-contained
page before it is published; the build runs privately, outside the workspace,
with no lifecycle scripts and no server credentials, and its process group is
killed on timeout. Built pages run in a sandbox with no network access.

All Git work is bounded and asynchronous. Each visible change replaces one
small revision marker for the owner; the UI polls that marker, never the
Artifact history. Tree requests share an in-memory revision snapshot for up to
one second, including missing owners. Expiry observes native-tool and post-commit hook
changes across processes without filesystem watchers; tree ETags include the
refreshed revisions. Colours come from the app theme when the page is served.

The native tool offers only create, list and rename. Create and compact list
rows show `$CHAT_DATA_DIR/artifact_repos/<owner>/<id>`; operator comment messages
carry the same working path. Agents edit those files and commit. Existing file
tools and Bash expand `$CHAT_DATA_DIR`; old versions are ordinary Git history
(`git log`, `git restore --source=<sha>`, then commit to publish).

Listings never install hooks or create owner directories. Native compact rows
validate only title configuration against the persisted metadata snapshot, not
refs or history. A missing/stale title costs one Git config lookup and records
a title snapshot; another process reuses it without Git. HTTP lists retain full
metadata and validate refs/config. Empty owner roots
are pruned on reap. A recorded startup migration (`.owner-directories-v1`)
retires existing empty or files-only non-repository roots; its marker records
retired, skipped-receipt and skipped-directory counts. Deletion receipts and
uncertain trees are preserved. A short directory-inode admission lock fences
owner/repository creation against retirement; retirement runs after unlocking.
External retirement markers prevent new admission during that gap and startup
recovers only markers left by dead processes, rechecking directory identity and
contents before retirement. No lock spans Git or trash retirement.

Metadata snapshots key on HEAD/current/published refs and config contents, plus
packed-refs size/mtime, so unchanged metadata survives remounts. Older version
refs do not invalidate creation dates: publish/restore only add version refs,
and external history rewrites do not redefine an established creation date.
Packed refs avoid history reads; same-size rewrites preserving mtime are outside
cache invalidation. Oversized config/refs bypass caching. App builds live at
builds/version refs.

Artifact HTTP response logs include bounded, request-local phase durations and
counts for repository admission, hook checks, metadata/cache waits, directory
scans, file reads and each Git command category. Nested phases overlap rather
than adding to request duration. Cache waits identify the originating timing id;
failures report an error class and safe reason, never document contents or paths.

## Rules for changes

- Never run Artifact builds or checks with server credentials or inside the
  agent's workspace.
- Keep served pages sandboxed; previews may report their height but never change
  the stored bytes.
- Older Artifact shapes stay readable.
