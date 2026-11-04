# Prompt cache warming

**Source file:** [cache-warm.ts](cache-warm.ts) installs the Durable extension.
The [host registry](../../../agents/durable/host/registry.ts) supplies exact
post-hook request captures, instance settings and live conversation state.
Replay retains provider payload wrappers and shared side-session cache keys,
but drops the generation's payload callback and abort signal, bypasses
generation hooks and never replaces the captured real request.

## Behaviour

Only the latest main-model request is replayed, with one output token and no
retries. Busy includes turns, queued input, background shells and working
descendants, using the same live rows as API v1's idle check. Idle, abort,
compaction, model changes and closing cancel warming. Successful replay usage
is committed to Durable's usage ledger and a `cache_warm` usage entry, without
adding a model-visible message. The thread adds that spend without counting
another assistant reply.

Pi 1.4.0 does not export its shipped cache warmer. This extension ports only
its streaming path: cache-tier TTL, replay safety, refresh margin, economics,
late-dispatch protection and fixed one-hour horizon. There is no idle mode,
extension decision override or separate warming status UI. Pi's model registry,
streaming and cost calculation are reused directly. Models without known TTL
or sufficient savings are not warmed.

Settings > Models registers **Keep prompt cache warm while agents work**,
enabled by default. Disabling it cancels scheduled and in-flight warming.
Clocks can be injected for real Durable/faux-provider tests without TTL waits.

## Rules for changes

- Keep the replay context detached from later turns and use Models-owned auth.
- Do not pass a serialized telemetry handle or a finished task's AbortSignal.
- Cancel in-flight replays at model changes and before shutdown cleanup waits.
- Never warm safety reviews, titles, summaries, or idle conversations.
- Keep at most one refresh timer per conversation; dispose it before Harness close.
- Prefer Pi's exported implementation when it becomes available.
