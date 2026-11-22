# Artifacts

An **Artifact** is a durable, versioned deliverable shown in the Artifacts pane:
a Markdown document or a small web app. Each Artifact is a Git repository owned
by one agent. Agents edit its files and commit; a post-commit hook publishes
that commit automatically. New repositories get the hook at creation; existing
ones get it on repository access, except listings and saved app state. The hook runs
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
listings, repository access with hook refresh) · [store/](store/index.ts)
(repository layout, bounded Git commands, and version refs) ·
[page/](page/index.ts) (isolated app builds and head insertion) · [check.ts](check.ts) (checks built
apps in a browser) · [preview.ts](preview.ts) · [theme.ts](theme.ts) ·
[key_relay.ts](key_relay.ts) · [app_state_script.ts](app_state_script.ts) (app API) ·
[../artifact_app_state.ts](../artifact_app_state.ts) (saved state) ·
[working_path.ts](working_path.ts) (portable paths) ·
[../extensions/core/environment/artifact.ts](../extensions/core/environment/artifact.ts)
(the native agent tool) · [../../web/artifacts/](../../web/artifacts/) (the pane)

## How it works

Publishing moves the Git pointer (ref) for the published version atomically and
records another ref for that version.
The viewer's **Copy link** button opens the Artifact at its current revision
in its owning conversation. The recipient must sign in; the link grants no
access. Add `&section=heading-slug` to jump to a document heading.
A document's page is its `index.md`. Agents link to sections with
`[Title](#artifact=ID&section=heading-slug)`; Markdown headings use GitHub-style
slugs, with `-1`, `-2` for duplicates. Relative document links open version-pinned
sibling files in the in-app viewer, optionally at a `#heading-slug`.
An app is built into one self-contained
page before it is published; the build runs privately, outside the workspace,
with no lifecycle scripts and no server credentials, and its process group is
killed on timeout. Built pages run in an opaque sandbox that blocks network
subresources but does not prevent the frame from navigating itself. Unclaimed non-editor keys
relay only from the focused, mounted frame into the pane/window keymap; editors,
modified browser keys, composition and page-handled events stay native.
The relay embeds [../keyboard_target.ts](../keyboard_target.ts)'s shared text-entry
and native Enter/Space activation predicates; non-text controls retain pane keys.

All Git work is bounded and asynchronous. Each visible change replaces one
small revision marker for the owner; the UI polls that marker, never the
Artifact history. Tree requests share an in-memory revision snapshot for up to
one second, including missing owners. Expiry observes native-tool and post-commit hook
changes across processes without filesystem watchers; tree ETags include the
refreshed revisions. Colours come from the app theme when the page is served.

Agents create only on explicit operator request and update requested Artifacts
instead of duplicating them.
Create and compact list rows show `$CHAT_DATA_DIR/artifact_repos/<owner>/<id>`; operator comment messages
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
contents before retirement. No lock spans Git or trash retirement. Retirement
awaits the descriptor-pinned trash Worker before removing its admission marker.

Metadata snapshots key on HEAD/current/published refs and config contents, plus
packed-refs size/mtime, so unchanged metadata survives remounts. Older version
refs do not invalidate creation dates: publish/restore only add version refs,
and external history rewrites do not redefine an established creation date.
Packed refs avoid history reads; same-size rewrites preserving mtime are outside
cache invalidation. Oversized config/refs bypass caching. App builds live at
builds/version refs.

Versioned Artifact file and page responses use private browser caching with
revalidation; their validators cover the served bytes, including the current
page theme. Unversioned responses remain no-store. Owner and version remain in
the request URL, and authorization precedes every revalidation.

Artifact HTTP response logs include bounded, request-local phase durations and
counts for repository admission, hook checks, metadata/cache waits, directory
scans, file reads and each Git command category. Nested phases overlap rather
than adding to request duration. Cache waits identify the originating timing id;
failures report an error class and safe reason, never document contents or paths.

### Saved app state

Apps can save one JSON value per Artifact, up to 256 KiB of UTF-8 JSON. Use
`await window.recurse.getState()` on load (`null` if nothing is saved) and
`await window.recurse.setState(value)` after edits. Failed loads and saves
reject; overlapping saves keep only the latest waiting value, and calls for
that value settle when it is saved. Listen for `recurse:statechange` on `window`
for replacements made outside the frame; the event's `detail` is the new value.
The app check and standalone pages use in-memory state only.

The existing native `artifact` tool reads the JSON with
`{ action: "state", id }` or replaces it with `{ action: "state", id, set_file }`.
`set_file` is the path to a JSON file, relative to the agent's current working
folder or absolute. Output is ordinary inspectable tool output. Saved app state
is not a confidential channel; don't put credentials in it. Open apps pick up
replacements on their next state check, without reloading the frame.

The viewer accepts the connection only from the mounted iframe, with the
expected message shape and the nonce in the viewer-reserved URL fragment. The
page connects before app code runs and the nonce works once, so a document the
frame navigates to cannot connect. A page that retries the spent nonce, such as
an app that reloads itself, gets an error asking to refresh the Artifact. State and save requests then travel over the document's message
port, not the frame window that a later navigation can reuse. The viewer fixes
the backend, owner and Artifact ID and keeps at most one write in flight per
frame. It checks both against the current selection before each request.
Changing the selection, including before returning through history to open
another Artifact, removes the old live frame and closes its connection before
the new content loads. The viewer checks for replacements only while an app
using the API is shown. HTTP state reads and writes use operator authorization
(also for connected backends), owner-scoped paths, and no browser caching.
Writes also go through CSRF checks and a request-body limit. The browser sandbox
and network policy are unchanged.

Saved app state is mutable and separate from the published files. A bounded
JSON file in the Artifact's own Git directory is replaced atomically; it is
never committed or published. Publishing and restoring versions keep the same
state. Artifact deletion retires it with the repository, and the state cannot
recreate a deleted repository. The size cap is per Artifact; saved app state
isn't charged against an aggregate conversation quota.

## Rules for changes

- Never run Artifact builds or checks with server credentials or inside the
  agent's workspace.
- Keep served pages sandboxed. Never trust a backend, owner, or Artifact ID
  supplied by a frame, or put saved app state into published bytes.
- Older Artifact shapes stay readable.
