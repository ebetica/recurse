# Lifecycle admission and retry state

Owns shared lifecycle leases and the retry state for deferred tree operations.
The tree and supervisor use these primitives but decide which operations to run.

**Source files:** [index.ts](index.ts) exposes the lifecycle contracts;
[mutation_guard.ts](mutation_guard.ts) owns in-process admission and cross-process
leases. [retry/](retry/) owns backoff and reseeds deferred operations from
persisted intent; lease imports do not load the stores used by retry.

## Rules for changes

- Keep lock ordering, token nesting and cancellation at their existing boundaries.
  The [admission model](../../../specs/tla/LifecycleAdmission.tla) covers reservation,
  deadlines and release ordering.
- Keep retries keyed to the deferred intent, and leave coordinator policy outside
  this module.
