# Legacy Pi import recordings

`compaction-fail.jsonl`, `compaction-success.jsonl`, and `shell.jsonl` are
suffixes from Pi 0.86.1 sessions run at Recurse `82c29e0e3`. They were recorded
through Pi's real extension runner and session manager using a scripted
in-process provider. The session header is retained, the first retained entry's
parent is cleared, and local paths are normalized to `/capture` and `/recurse`.

- The compaction recordings ran the historical instant-compaction extension over
  the same seeded conversation. The extension's test seam threw `socket closed`
  in one run and returned a fixed summary in the other. The success notice has
  no point ID; the following data-only entry has one.
- The shell recording ran a one-second background sleep through `pi-bg-shell`
  and sent a second prompt so Pi persisted both stream entries.
