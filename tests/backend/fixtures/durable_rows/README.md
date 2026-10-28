# Durable rows fixtures

These JSON fixtures are read by `tests/backend/durable_rows.test.ts`. The
provenance below moved here from that test's header comment.

Durable rows (src/agents/durable/durable_rows.ts) over a transcript recorded
from a real model (`recorded.json`, made by `tests/live/durable_rows_record.ts`):
the rows equal those the Pi reader serves for a Pi session holding the same
messages, live documents show the partial answer, running tool output, and
Compacting, queued input keeps its request id, older pages follow the
entries() cursor and give the same rows as one page, revisions let a reader
fetch only what changed, and projections leave the cache like Pi's.

The `queued-agent` and `interrupted-*` fixtures were recorded on 2026-10-12
from Claude Opus 5.5: a child's final report during the parent's sleep
command, and an operator interrupt of a streaming reply. Only model-written
text becomes reply text.
