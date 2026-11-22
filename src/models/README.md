# Models and effort levels

`Config` shares its Settings file store with `ModelCatalog` and `EffortLadder`.
The catalog follows revisions of the three files it reads. The ladder caches
against the catalog revision, the stored ladder and the signed-in provider
set. Server reads use the file store's non-blocking snapshots; standalone
reads synchronously observe edits.

## Source files

- `catalog.ts` combines Pi's list, custom providers and reasoning defaults,
  then offers models according to the current logins.
- `custom_providers.ts` reads and writes `model-providers.json`. Provider names
  retain source order on reads, including integer-like names.
- `pi_model_list.ts` validates and loads Pi's model list, and coordinates updates.
- `effort_ladder.ts` resolves, saves and reports the reachability of effort
  levels, including marks from failed turns.
- `model_id.ts` and `thinking.ts` define the shared model id and reasoning rules.

## Rules for changes

Keep file-provider models out of automatic selection; explicit choices are
allowed. Keep stored ladder ids when Pi stops listing them, and preserve
optional levels when saving from older clients. Safety reviewer routing stays
in `Config`; it must not rely on the cached Pi list.
