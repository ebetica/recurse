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
[base.ts](base.ts) · [../agent_temp.ts](../agent_temp.ts) (directory lifetime) ·
[../attachment_drafts.ts](../attachment_drafts.ts) (uploads before a conversation exists)

## How it works

The store works only on directories and open handles it is given. It never works
out owners, reads transcripts, or recreates a deleted agent's directory.
`agent_temp.ts` owns the directory's lifetime; the agent's node and the
supervisor decide who may write and pass explicit quotas on each call. Deleting
an agent fences new writes first, so a late write cannot bring its directory back.

Each file gets an opaque storage ID, with its display name kept separately. A
file is published atomically, and only after its bytes and metadata validate. Listings come in
bounded pages, and deleting a file needs no proof that no message refers to it.

## Rules for changes

- One collection per agent lifetime key: no second registry, file manager or index.
- Startup moves surviving legacy scratch uploads once, including drafts, and
  records completion in `<data dir>/.agent-files-v1`. Cross-filesystem moves copy
  into staging with a completion marker before atomic publication; the old copy
  retires only afterward. Migration errors keep the instance unready. Conflicting
  old and new collections without a completion marker are preserved for repair.
- The browser never sends paths. Reads take a conversation ID and an opaque file
  ID, resolved through checked directory handles that do not follow symlinks.
- Draft uploads stay private until a new conversation adopts them; a failed
  adoption keeps the bytes and never deletes the only copy.
