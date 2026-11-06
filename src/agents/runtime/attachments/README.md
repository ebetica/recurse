# Agent files

An agent's **files** are the operator's uploads and the files the agent publishes
with the native `publish` tool. Both live in one private collection at
`<data dir>/agent_files/<agent temp key leaf>/uploads`, separate from disposable
scratch, with the same quotas, listing, download and deletion. They last as
long as the agent: they survive restarts and disappear when the agent is deleted.
Missing bytes are reported as missing, never rebuilt. Artifacts are a separate,
versioned product ([src/artifacts/README.md](../../../artifacts/README.md)).

**Source files:** [store.ts](store.ts) (locks and bounded scans) ·
[publish.ts](publish.ts) (adding and removing files) · [published.ts](published.ts)
(listings and download headers) · [preview.ts](preview.ts) (downloads) ·
[base.ts](base.ts) · [crop.ts](crop.ts) (idempotent crop cancellation) · [../agent_temp.ts](../agent_temp.ts) (directory lifetime) ·
[../attachment_drafts.ts](../attachment_drafts.ts) (uploads before a conversation exists)

## How it works

The store works only on directories and open handles it is given. It never works
out owners, reads transcripts, or recreates a deleted agent's directory.
`agent_temp.ts` owns the directory's lifetime; the agent's node and the
supervisor decide who may write and pass explicit quotas on each call. Deleting
an agent fences new writes first, so a late write cannot bring its directory back.

Each file gets an opaque storage ID, with its display name kept separately. A
publication copies and hashes the open source in bounded chunks; a file is
published atomically, and only after its bytes and metadata validate. New
publications retain their absolute `source_path` in metadata and Files rows so
Markdown image references resolve beside the original document. Listings come in
bounded pages, and deleting a file needs no proof that no message refers to it.
A publication lookup is complete only when its collection and every manifest
can be read. Valid results stay visible while incomplete lookups retry.

Comment crops may supply an owner-scoped operation key and expiry; the pair
identifies the operation and its URL. Replays return
the same file only when filename, bytes and expiry match. Cancellation records a
bounded, expiring marker under the collection lock before removing the file;
late admissions cannot recreate it. Expired operations can replay or delete an
existing file but cannot create one. Existing collection maintenance prunes expired
markers. Cancellation and admission hold the same owner lifecycle lease. Normal
file deletion records the same marker for a crop before removing it. Marker and
collection directory are synced before removal; the directory is synced again
after removal. Each collection admits at most 256 unexpired crop operations,
including cancellation markers, so an admitted crop always reserves its marker.
If cancellation of an unknown operation arrives at capacity, an owner-wide
expiring barrier blocks new crop admissions through that operation's expiry;
replays and cancellations of existing files continue. The barrier can be extended
by later overflow cancellations and is pruned when expired.

The authenticated `GET /api/conversations/{cid}/attachment-crops` capability
check returns `{idempotent: true, now}` with server time in Unix milliseconds.
A client checks it before uploading to a potentially older backend. Multipart
`POST /api/attachments` accepts `crop_key` (32 lowercase hex characters) and
`crop_expires` (13-digit Unix milliseconds, no more than one hour ahead) together
with `owner` and `file`, but not a draft. Successful replays return the normal
upload response. `DELETE /api/conversations/{cid}/attachment-crops/{key}?expires=...`
returns `{ok: true}` even when no file was admitted. A conflicting or cancelled
upload and a new upload after expiry return 409; invalid inputs return 422 and
an unavailable owner returns 404. Expired uploads may still be replayed if the
matching file exists, and cancellation may still delete them.

## Rules for changes

- One collection per agent lifetime key: no second registry, file manager or index.
- Startup moves surviving legacy scratch uploads once, including drafts, and
  records completion in `<data dir>/.agent-files-v1`. Cross-filesystem moves copy
  into staging with a completion marker before atomic publication; the old copy
  retires only afterward. Migration errors keep the instance unready. Conflicting
  old and new collections without a completion marker are preserved for repair.
- Stored-file reads take a conversation ID and an opaque file ID, resolved
  through checked directory handles that do not follow symlinks. The separate
  operator-only local-image route accepts paths but returns only bounded,
  content-checked image snapshots, never arbitrary file downloads.
- Draft uploads stay private until a new conversation adopts them; a failed
  adoption keeps the bytes and never deletes the only copy.
