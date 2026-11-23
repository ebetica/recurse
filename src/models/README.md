# Models and effort levels

`Config` shares its Settings file store with `ModelCatalog` and `EffortLadder`.
The catalog follows revisions of the three files it reads. The ladder caches
against the catalog revision, the stored ladder and the signed-in provider
set. Server reads use the file store's non-blocking snapshots; standalone
reads synchronously observe edits.

## Source files

- `catalog.ts` combines Pi's list, custom providers and reasoning defaults,
  then offers models according to the current logins.
- [Custom providers](custom_providers.ts) follow the order in
  `model-providers.json`. Digit-only names are invalid because JavaScript would
  move array-index keys ahead of the other providers.
- `pi_model_list.ts` validates and loads Pi's model list, and coordinates updates.
- `effort_ladder.ts` resolves, saves and reports the reachability of effort
  levels, including marks from failed turns.
- `model_id.ts` and `thinking.ts` define the shared model id and reasoning rules.

## Rules for changes

Keep file-provider models out of automatic selection; explicit choices are
allowed. Keep stored ladder ids when Pi stops listing them: the cached list
informs Settings; [Durable](../agents/durable/model_selection/model_selection.ts)
resolves the exact saved id. Preserve optional levels when saving from older clients. [Safety reviewer routing](../safety_review/routes.ts)
must not rely on the cached Pi list.

Keep the existing `available-models.json` path so upgrades retain turn marks.
Provider choices come from the catalog and current logins, not that file.
